import { z } from 'zod'
import { defineTool } from '../tools/Tool.js'
import type { AgentMode } from '../core/events.js'

const EnterPlanModeInput = z.object({}).strict()

/**
 * Switch to plan mode. The registry projection removes write tools; the
 * prompt explains the constraint, the runtime guarantees it.
 */
export const EnterPlanModeTool = defineTool<
  z.infer<typeof EnterPlanModeInput>,
  { entered: boolean; alreadyInPlan?: boolean }
>({
  name: 'EnterPlanMode',
  description:
    'Enter plan mode for complex or ambiguous work: explore the codebase read-only, ' +
    'then propose a plan with PlanPropose and request approval with ExitPlanMode. ' +
    'Do NOT use for single obvious fixes or pure read-only questions.',
  inputSchema: EnterPlanModeInput,
  maxResultChars: 2_000,
  readOnly: () => true,
  concurrency: () => 'exclusive',
  interruptBehavior: () => 'cancel',
  resources: () => [{ resource: 'state:mode', mode: 'write' }],
  permission: async () => ({ behavior: 'allow' }),

  execute: async (_input, ctx) => {
    if (ctx.mode === 'plan') {
      return { data: { entered: false, alreadyInPlan: true } }
    }
    return {
      data: { entered: true },
      facts: [
        {
          type: 'mode.changed',
          from: ctx.mode,
          to: 'plan',
          prePlanMode: ctx.mode,
        },
      ],
    }
  },

  serialize: output => ({
    kind: 'text',
    text: output.alreadyInPlan
      ? 'Already in plan mode.'
      : 'Entered plan mode. Write tools are now unavailable. Explore, then call PlanPropose.',
  }),
})

const CriterionInput = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  evidenceKind: z.enum(['command', 'test', 'file_assertion', 'diff_assertion', 'manual']),
  required: z.boolean().default(true),
})

const StepInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  files: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  expectedOutcome: z.string().default(''),
})

const PlanProposeInput = z
  .object({
    planId: z.string().optional(),
    goal: z.string().min(1),
    nonGoals: z.array(z.string()).default([]),
    assumptions: z.array(z.string()).default([]),
    decisions: z
      .array(z.object({ decision: z.string(), rationale: z.string() }))
      .default([]),
    steps: z.array(StepInput).default([]),
    acceptanceCriteria: z.array(CriterionInput).default([]),
    risks: z.array(z.string()).default([]),
  })
  .strict()

/** Persist a plan version. ExitPlanMode only accepts persisted references. */
export const PlanProposeTool = defineTool<
  z.infer<typeof PlanProposeInput>,
  { planId: string; version: number }
>({
  name: 'PlanPropose',
  description:
    'Persist a plan draft (facts, assumptions, decisions, steps, acceptance criteria). ' +
    'Returns planId and version. Call ExitPlanMode with that reference to request approval. ' +
    'Acceptance criteria must be verifiable (command/test/file_assertion).',
  inputSchema: PlanProposeInput,
  maxResultChars: 4_000,
  readOnly: () => true, // writes only to the plan artifact store, not workspace
  concurrency: () => 'exclusive',
  interruptBehavior: () => 'block',
  resources: () => [{ resource: 'state:plans', mode: 'write' }],
  permission: async () => ({ behavior: 'allow' }),

  validate: async (input, ctx) => {
    if (!ctx.services.plans) {
      return {
        ok: false,
        error: {
          code: 'INTERNAL_TOOL_ERROR',
          message: 'plan store not configured',
          retryable: false,
        },
      }
    }
    const stepIds = new Set(input.steps.map(s => s.id))
    for (const step of input.steps) {
      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep)) {
          return {
            ok: false,
            error: {
              code: 'SEMANTIC_VALIDATION_ERROR',
              message: `step ${step.id} depends on unknown step ${dep}`,
              retryable: true,
            },
          }
        }
      }
    }
    return { ok: true }
  },

  execute: async (input, ctx) => {
    const plan = await ctx.services.plans!.createVersion(input)
    return {
      data: { planId: plan.planId, version: plan.version },
      facts: [{ type: 'plan.version.created', plan }],
    }
  },

  serialize: output => ({
    kind: 'text',
    text: `Plan persisted: ${output.planId} v${output.version}. Call ExitPlanMode with this exact reference to request user approval.`,
  }),
})

const ExitPlanModeInput = z
  .object({
    planId: z.string().min(1),
    version: z.number().int().positive(),
  })
  .strict()

/**
 * Approval flow (guide §8.6):
 * 1. plan must be persisted; the tool accepts only a reference
 * 2. the fixed version is shown to the user
 * 3. approval issues a one-shot token bound to (session, plan, version)
 * 4. the token is consumed to mark approval; mode restores prePlanMode
 */
export const ExitPlanModeTool = defineTool<
  z.infer<typeof ExitPlanModeInput>,
  { approved: boolean; reason?: string; restoredMode?: AgentMode }
>({
  name: 'ExitPlanMode',
  description:
    'Request user approval for a persisted plan version and exit plan mode. ' +
    'Requires the exact planId/version returned by PlanPropose. ' +
    'The user sees that fixed version; switching versions at approval time is impossible.',
  inputSchema: ExitPlanModeInput,
  maxResultChars: 2_000,
  readOnly: () => true,
  concurrency: () => 'exclusive',
  interruptBehavior: () => 'block',
  resources: () => [{ resource: 'state:mode', mode: 'write' }],
  // human approval is the permission; the tool itself may run
  permission: async () => ({ behavior: 'allow' }),

  validate: async (input, ctx) => {
    const plan = ctx.services.plans?.get(input.planId, input.version)
    if (!plan) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `no persisted plan ${input.planId} v${input.version}; call PlanPropose first`,
          retryable: true,
        },
      }
    }
    if (plan.status === 'superseded' || plan.status === 'approved') {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `plan ${input.planId} v${input.version} is ${plan.status}`,
          retryable: true,
          hint: 'Propose a new version if the old one was superseded.',
        },
      }
    }
    return { ok: true }
  },

  execute: async (input, ctx) => {
    const { plans, approvals, requestPlanApproval } = ctx.services
    const plan = plans!.get(input.planId, input.version)!

    if (plan.status === 'draft') {
      plans!.markAwaitingApproval(input.planId, input.version)
    }

    if (!requestPlanApproval || !approvals) {
      return {
        data: { approved: false, reason: 'no approval channel configured' },
      }
    }

    const userApproved = await requestPlanApproval(plan)
    if (!userApproved) {
      return {
        data: { approved: false, reason: 'user rejected the plan' },
      }
    }

    // one-shot token bound to session+plan+version, consumed immediately
    const token = approvals.issue({
      sessionId: ctx.sessionId,
      planId: input.planId,
      planVersion: input.version,
    })
    const consumed = approvals.consume({
      token: token.token,
      sessionId: ctx.sessionId,
      planId: input.planId,
      planVersion: input.version,
    })
    if (!consumed.ok) {
      return { data: { approved: false, reason: consumed.reason } }
    }

    const approvedPlan = plans!.markApproved(input.planId, input.version, token.token)
    const restoredMode: AgentMode = ctx.mode === 'plan' ? 'default' : ctx.mode

    return {
      data: { approved: true, restoredMode },
      facts: [
        { type: 'plan.version.created', plan: approvedPlan },
        {
          type: 'plan.approved',
          planId: input.planId,
          version: input.version,
          tokenId: token.token,
        },
        ...(ctx.mode === 'plan'
          ? ([
              {
                type: 'mode.changed' as const,
                from: 'plan' as const,
                to: restoredMode,
              },
            ])
          : []),
      ],
    }
  },

  serialize: output => ({
    kind: 'text',
    text: output.approved
      ? `Plan approved. Plan mode exited (mode: ${output.restoredMode}). Follow the approved steps and acceptance criteria.`
      : `Plan NOT approved: ${output.reason}. Revise the plan or ask the user for direction.`,
  }),
})
