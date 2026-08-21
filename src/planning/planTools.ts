import { z } from 'zod'
import { defineTool } from '../tools/Tool.js'
import type { AgentMode } from '../core/events.js'
import { workspacePathKey } from '../workspace/pathKey.js'

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
      for (const file of step.files) {
        try {
          workspacePathKey(ctx.workspaceRoot, file)
        } catch {
          return {
            ok: false,
            error: {
              code: 'SEMANTIC_VALIDATION_ERROR',
              message: `step ${step.id} contains a path outside the workspace or not identifying a file: ${file}`,
              retryable: true,
              hint: 'Use a workspace-relative file path; do not use the workspace root or .. escapes.',
            },
          }
        }
      }
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

const PlanRepairInput = z.object({
  planId: z.string().min(1),
  version: z.number().int().positive(),
  stepId: z.string().min(1),
  reason: z.string().min(1),
  replacement: z.object({
    title: z.string().min(1).optional(),
    description: z.string().min(1),
    files: z.array(z.string()).optional(),
    expectedOutcome: z.string().min(1).optional(),
  }).strict(),
}).strict()

/**
 * Low-impact replan primitive: replaces one step, preserves all other steps
 * and criteria, and refuses file-scope expansion. The derived version keeps
 * approval because its authorization is narrower than the approved plan.
 */
export const PlanRepairTool = defineTool({
  name: 'PlanRepair',
  description:
    'During a low-impact replan, replace exactly one failed approved-plan step. ' +
    'Files must stay inside the already approved plan scope; dependencies and ' +
    'acceptance criteria are preserved. Returns a new approved plan version.',
  inputSchema: PlanRepairInput,
  maxResultChars: 8_000,
  // Internal plan/task artifacts only; no workspace or external side effect.
  // This matches PlanPropose/TaskUpdate permission semantics.
  readOnly: () => true,
  concurrency: () => 'exclusive',
  interruptBehavior: () => 'block',
  resources: () => [
    { resource: 'state:plans', mode: 'write' },
    { resource: 'state:tasks', mode: 'write' },
  ],
  permission: async () => ({ behavior: 'allow' }),

  validate: async (input, ctx) => {
    if (!ctx.services.canLocalPlanRepair?.()) {
      return {
        ok: false,
        error: {
          code: 'PRECONDITION_FAILED',
          message: 'no low-impact replan is awaiting a local step repair',
          retryable: false,
          hint: 'PlanRepair is only enabled by an engine replan trigger.',
        },
      }
    }
    const plan = ctx.services.plans?.get(input.planId, input.version)
    if (!plan || plan.status !== 'approved' || ctx.services.plans?.lastApproved() !== plan) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `plan ${input.planId}@${input.version} is not the active approved plan`,
          retryable: true,
        },
      }
    }
    if (!plan.steps.some(step => step.id === input.stepId)) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `step ${input.stepId} is not in the approved plan`,
          retryable: true,
        },
      }
    }
    let allowed: Set<string>
    try {
      allowed = new Set(
        plan.steps
          .flatMap(step => step.files)
          .map(file => workspacePathKey(ctx.workspaceRoot, file)),
      )
    } catch {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: 'the approved plan contains an invalid workspace file path',
          retryable: false,
          hint: 'Persist a replacement plan with validated workspace-relative paths.',
        },
      }
    }
    const replacementFiles = input.replacement.files ?? []
    const expanded: string[] = []
    for (const file of replacementFiles) {
      try {
        if (!allowed.has(workspacePathKey(ctx.workspaceRoot, file))) expanded.push(file)
      } catch {
        return {
          ok: false,
          error: {
            code: 'SEMANTIC_VALIDATION_ERROR',
            message: `local repair contains a path outside the workspace or not identifying a file: ${file}`,
            retryable: true,
          },
        }
      }
    }
    if (expanded.length > 0) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `local repair would expand approved file scope: ${expanded.join(', ')}`,
          retryable: true,
          hint: 'Use PlanPropose and request approval for scope expansion.',
        },
      }
    }
    return { ok: true }
  },

  preconditions: async (input, ctx) => {
    const active = ctx.services.plans?.lastApproved()
    return [{
      id: 'approved-version-unchanged',
      passed: active?.planId === input.planId && active.version === input.version,
      detail: active ? `${active.planId}@${active.version}` : 'none',
    }]
  },

  execute: async (input, ctx) => {
    const repaired = await ctx.services.plans!.createLocalRepair(input)
    const migrated = ctx.services.tasks?.migratePlanVersion({
      planId: input.planId,
      fromVersion: input.version,
      toVersion: repaired.plan.version,
      repairedStepId: input.stepId,
    }) ?? []
    return {
      data: {
        planId: repaired.plan.planId,
        fromVersion: repaired.previous.version,
        version: repaired.plan.version,
        stepId: input.stepId,
        migratedTasks: migrated.length,
      },
      facts: [
        {
          type: 'plan.status.changed',
          planId: repaired.previous.planId,
          version: repaired.previous.version,
          status: 'superseded',
        },
        { type: 'plan.version.created', plan: repaired.plan },
        ...migrated.map(task => ({ type: 'task.changed' as const, task })),
        {
          type: 'replan.adjustment.applied',
          cause: 'local_step_repair',
          summary: `replaced step ${input.stepId} in ${input.planId}@${input.version}`,
        },
      ],
      commitProof: `${repaired.plan.planId}@${repaired.plan.version}:${input.stepId}`,
    }
  },

  postconditions: async (input, output, ctx) => {
    const plan = ctx.services.plans?.get(output.planId, output.version)
    return [
      {
        id: 'new-version-approved',
        passed: plan?.status === 'approved',
        detail: plan?.status ?? 'missing',
      },
      {
        id: 'single-step-repair-recorded',
        passed:
          plan?.localRepair?.stepId === input.stepId &&
          plan.localRepair.fromVersion === input.version,
      },
    ]
  },

  observe: async (_input, output) => ({
    summary:
      `Locally repaired step ${output.stepId}; plan advanced from v${output.fromVersion} ` +
      `to approved v${output.version}`,
    fields: { ...output, scopeExpanded: false },
  }),

  inspectOutcome: async (input, ctx) => {
    const candidate = ctx.services.plans?.get(input.planId, input.version + 1)
    const applied =
      candidate?.localRepair?.fromVersion === input.version &&
      candidate.localRepair.stepId === input.stepId
    return {
      applied,
      detail: applied
        ? `local repair exists as ${candidate!.planId}@${candidate!.version}`
        : 'no matching derived plan version found',
    }
  },
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
