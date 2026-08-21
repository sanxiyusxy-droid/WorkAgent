import { z } from 'zod'
import { defineTool } from '../tools/Tool.js'
import type { PlanTask } from './types.js'
import { findStaleReceipts } from '../verification/freshness.js'

const TaskCreateInput = z
  .object({
    subject: z.string().min(1),
    description: z.string().default(''),
    activeForm: z.string().optional(),
    dependsOn: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(z.string()).default([]),
    stepId: z.string().min(1).optional(),
  })
  .strict()

export const TaskCreateTool = defineTool<
  z.infer<typeof TaskCreateInput>,
  { ok: boolean; task?: PlanTask; code?: string; message?: string }
>({
  name: 'TaskCreate',
  description:
    'Create a task in the task graph. dependsOn must reference existing task ids. ' +
    'acceptanceCriteria are criterion ids from the approved plan; required criteria ' +
    'need passed evidence before the task can be completed.',
  inputSchema: TaskCreateInput,
  maxResultChars: 4_000,
  readOnly: () => true, // internal state only
  concurrency: () => 'exclusive',
  interruptBehavior: () => 'block',
  resources: () => [{ resource: 'state:tasks', mode: 'write' }],
  permission: async () => ({ behavior: 'allow' }),

  validate: async (input, ctx) => {
    if (!input.stepId) return { ok: true }
    const plan = ctx.services.plans?.lastApproved()
    if (!plan?.steps.some(step => step.id === input.stepId)) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `stepId ${input.stepId} is not in the approved plan`,
          retryable: true,
          hint: 'Use a step id from the current approved plan.',
        },
      }
    }
    return { ok: true }
  },

  execute: async (input, ctx) => {
    const tasks = ctx.services.tasks
    if (!tasks) {
      return { data: { ok: false, code: 'INTERNAL', message: 'task store not configured' } }
    }
    const plan = ctx.services.plans?.lastApproved()
    const result = tasks.create({
      ...input,
      planId: plan?.planId,
      planVersion: plan?.version,
      stepId: input.stepId,
    })
    if (!result.ok) {
      return { data: { ok: false, code: result.code, message: result.message } }
    }
    return {
      data: { ok: true, task: result.value },
      facts: [{ type: 'task.changed', task: result.value }],
    }
  },

  serialize: output => ({
    kind: 'text',
    text: output.ok
      ? `Task created: ${output.task!.id} "${output.task!.subject}" (revision ${output.task!.revision})`
      : `TaskCreate failed [${output.code}]: ${output.message}`,
  }),
})

const TaskUpdateInput = z
  .object({
    id: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    status: z
      .enum(['pending', 'in_progress', 'blocked', 'completed', 'failed'])
      .optional(),
    subject: z.string().optional(),
    description: z.string().optional(),
    activeForm: z.string().optional(),
    dependsOn: z.array(z.string()).optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
    evidenceIds: z.array(z.string()).optional(),
    blockedReason: z.string().optional(),
  })
  .strict()

export const TaskUpdateTool = defineTool<
  z.infer<typeof TaskUpdateInput>,
  { ok: boolean; task?: PlanTask; code?: string; message?: string }
>({
  name: 'TaskUpdate',
  description:
    'Incrementally update one task with optimistic concurrency (expectedRevision). ' +
    'Rules enforced: at most one in_progress task; dependencies must be completed ' +
    'before starting; blocked requires blockedReason; completing a task requires ' +
    'passed evidence for its required acceptance criteria. Evidence ids must be real.',
  inputSchema: TaskUpdateInput,
  maxResultChars: 4_000,
  readOnly: () => true,
  concurrency: () => 'exclusive',
  interruptBehavior: () => 'block',
  resources: () => [{ resource: 'state:tasks', mode: 'write' }],
  permission: async () => ({ behavior: 'allow' }),

  validate: async (input, ctx) => {
    // referenced evidence must exist — the model cannot fabricate receipts
    if (input.evidenceIds) {
      const store = ctx.services.evidence
      const missing = input.evidenceIds.filter(id => !store?.exists(id))
      if (missing.length > 0) {
        return {
          ok: false,
          error: {
            code: 'SEMANTIC_VALIDATION_ERROR',
            message: `unknown evidence ids: ${missing.join(', ')}`,
            retryable: true,
            hint: 'Evidence receipts are issued by the runtime when commands run.',
          },
        }
      }
    }
    return { ok: true }
  },

  execute: async (input, ctx) => {
    const tasks = ctx.services.tasks
    if (!tasks) {
      return { data: { ok: false, code: 'INTERNAL', message: 'task store not configured' } }
    }
    const { id, expectedRevision, ...patch } = input
    const criteria = ctx.services.plans?.lastApproved()?.acceptanceCriteria ?? []
    const evidenceStore = ctx.services.evidence
    const evidence = evidenceStore?.list() ?? []
    const staleEvidenceIds = evidenceStore
      ? await findStaleReceipts(evidenceStore)
      : undefined
    const result = tasks.update(
      { id, expectedRevision, patch },
      {
        criteria,
        evidence,
        staleEvidenceIds,
        workspaceRoot: evidenceStore?.workspaceRoot,
      },
    )
    if (!result.ok) {
      return { data: { ok: false, code: result.code, message: result.message } }
    }
    return {
      data: { ok: true, task: result.value },
      facts: [{ type: 'task.changed', task: result.value }],
    }
  },

  serialize: output => ({
    kind: 'text',
    text: output.ok
      ? `Task ${output.task!.id} -> ${output.task!.status} (revision ${output.task!.revision})`
      : `TaskUpdate failed [${output.code}]: ${output.message}`,
  }),
})

const TaskListInput = z.object({}).strict()

export const TaskListTool = defineTool<
  z.infer<typeof TaskListInput>,
  { tasks: PlanTask[] }
>({
  name: 'TaskList',
  description: 'List all tasks with status, revision, dependencies and evidence.',
  inputSchema: TaskListInput,
  maxResultChars: 20_000,
  readOnly: () => true,
  concurrency: () => 'shared',
  interruptBehavior: () => 'cancel',
  resources: () => [{ resource: 'state:tasks', mode: 'read' }],
  permission: async () => ({ behavior: 'allow' }),

  execute: async (_input, ctx) => ({
    data: { tasks: ctx.services.tasks?.list() ?? [] },
  }),

  serialize: output => ({
    kind: 'text',
    text:
      output.tasks.length === 0
        ? 'No tasks.'
        : output.tasks
            .map(
              t =>
                `${t.id} [${t.status}] rev=${t.revision} "${t.subject}"` +
                (t.stepId ? ` step=${t.stepId}` : '') +
                (t.dependsOn.length > 0 ? ` deps=${t.dependsOn.join(',')}` : '') +
                (t.evidenceIds.length > 0 ? ` evidence=${t.evidenceIds.join(',')}` : '') +
                (t.blockedReason ? ` blocked: ${t.blockedReason}` : ''),
            )
            .join('\n'),
  }),
})
