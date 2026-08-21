import type { PlanTask, TaskStatus, UpdateTaskInput } from './types.js'
import type { EvidenceReceipt } from '../verification/types.js'
import type { AcceptanceCriterion } from './types.js'
import type { Clock, IdGenerator } from '../core/runtimePrimitives.js'
import { requiredCriteriaWithoutUsableEvidence } from '../verification/criteriaEvidence.js'

export type TaskStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string }

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['in_progress', 'blocked', 'failed'],
  in_progress: ['completed', 'blocked', 'failed', 'pending'],
  blocked: ['pending', 'in_progress', 'failed'],
  completed: [],
  failed: ['pending'],
}

/**
 * Incremental task graph with the single-agent invariants (guide §8.7):
 * - at most one in_progress task
 * - dependencies must be completed before start
 * - blocked requires a reason and is never disguised as completed
 * - required acceptance criteria need passed evidence to complete
 * - optimistic concurrency through revision
 * - no dangling dependencies, no cycles
 */
export class TaskStore {
  private readonly tasks = new Map<string, PlanTask>()

  constructor(private readonly deps: { clock: Clock; ids: IdGenerator }) {}

  list(): PlanTask[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  get(id: string): PlanTask | undefined {
    return this.tasks.get(id)
  }

  create(input: {
    subject: string
    description?: string
    activeForm?: string
    dependsOn?: string[]
    acceptanceCriteria?: string[]
    planId?: string
    planVersion?: number
    stepId?: string
  }): TaskStoreResult<PlanTask> {
    const dependsOn = input.dependsOn ?? []
    for (const dep of dependsOn) {
      if (!this.tasks.has(dep)) {
        return { ok: false, code: 'DANGLING_DEPENDENCY', message: `unknown dependency: ${dep}` }
      }
    }
    const task: PlanTask = {
      id: this.deps.ids.next('task'),
      planId: input.planId,
      planVersion: input.planVersion,
      stepId: input.stepId,
      subject: input.subject,
      description: input.description ?? '',
      activeForm: input.activeForm ?? input.subject,
      status: 'pending',
      dependsOn,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      evidenceIds: [],
      revision: 1,
      createdAt: this.deps.clock.isoNow(),
      updatedAt: this.deps.clock.isoNow(),
    }
    this.tasks.set(task.id, task)
    return { ok: true, value: task }
  }

  update(
    input: UpdateTaskInput,
    options: {
      criteria?: AcceptanceCriterion[]
      evidence?: EvidenceReceipt[]
      staleEvidenceIds?: ReadonlySet<string>
      workspaceRoot?: string
    } = {},
  ): TaskStoreResult<PlanTask> {
    const task = this.tasks.get(input.id)
    if (!task) {
      return { ok: false, code: 'TASK_NOT_FOUND', message: `unknown task: ${input.id}` }
    }
    if (task.revision !== input.expectedRevision) {
      return {
        ok: false,
        code: 'REVISION_CONFLICT',
        message: `task ${input.id} is at revision ${task.revision}, expected ${input.expectedRevision}`,
      }
    }

    const patch = input.patch
    const nextStatus = patch.status

    if (nextStatus && nextStatus !== task.status) {
      if (!VALID_TRANSITIONS[task.status].includes(nextStatus)) {
        return {
          ok: false,
          code: 'INVALID_TRANSITION',
          message: `cannot move task from ${task.status} to ${nextStatus}`,
        }
      }
      if (nextStatus === 'in_progress') {
        const active = [...this.tasks.values()].find(
          t => t.status === 'in_progress' && t.id !== task.id,
        )
        if (active) {
          return {
            ok: false,
            code: 'ALREADY_IN_PROGRESS',
            message: `task ${active.id} is already in_progress; finish or block it first`,
          }
        }
        const deps = patch.dependsOn ?? task.dependsOn
        const unmet = deps.filter(d => this.tasks.get(d)?.status !== 'completed')
        if (unmet.length > 0) {
          return {
            ok: false,
            code: 'DEPENDENCIES_INCOMPLETE',
            message: `dependencies not completed: ${unmet.join(', ')}`,
          }
        }
      }
      if (nextStatus === 'blocked' && !patch.blockedReason && !task.blockedReason) {
        return {
          ok: false,
          code: 'BLOCKED_REASON_REQUIRED',
          message: 'blocked status requires blockedReason',
        }
      }
      if (nextStatus === 'completed') {
        const criteria = options.criteria ?? []
        const evidence = options.evidence ?? []
        const criteriaIds = patch.acceptanceCriteria ?? task.acceptanceCriteria
        const required = criteria.filter(
          c => criteriaIds.includes(c.id) && c.required,
        )
        const missing = requiredCriteriaWithoutUsableEvidence(required, evidence, {
          staleEvidenceIds: options.staleEvidenceIds,
          expectedWorkspaceRoot: options.workspaceRoot,
        })
        if (missing.length > 0) {
          return {
            ok: false,
            code: 'MISSING_EVIDENCE',
            message: `required criteria without passed evidence: ${missing
              .map(c => c.id)
              .join(', ')}`,
          }
        }
      }
    }

    if (patch.dependsOn) {
      for (const dep of patch.dependsOn) {
        if (!this.tasks.has(dep)) {
          return { ok: false, code: 'DANGLING_DEPENDENCY', message: `unknown dependency: ${dep}` }
        }
      }
      if (this.wouldCycle(task.id, patch.dependsOn)) {
        return { ok: false, code: 'DEPENDENCY_CYCLE', message: 'dependency cycle detected' }
      }
    }

    const updated: PlanTask = {
      ...task,
      ...patch,
      id: task.id,
      revision: task.revision + 1,
      updatedAt: this.deps.clock.isoNow(),
    }
    this.tasks.set(task.id, updated)
    return { ok: true, value: updated }
  }

  /** Restore a task snapshot during journal replay (no invariant re-checks). */
  restore(task: PlanTask): void {
    this.tasks.set(task.id, task)
  }

  /**
   * Carry unaffected tasks to a bounded local-repair version. The repaired
   * step is reopened and loses old evidence; every change increments the
   * optimistic revision and is returned for fact persistence.
   */
  migratePlanVersion(input: {
    planId: string
    fromVersion: number
    toVersion: number
    repairedStepId: string
  }): PlanTask[] {
    const changed: PlanTask[] = []
    for (const task of this.tasks.values()) {
      if (task.planId !== input.planId || task.planVersion !== input.fromVersion) continue
      const repaired = task.stepId === input.repairedStepId
      const next: PlanTask = {
        ...task,
        planVersion: input.toVersion,
        status: repaired && task.status !== 'pending' ? 'pending' : task.status,
        evidenceIds: repaired ? [] : task.evidenceIds,
        blockedReason: repaired ? undefined : task.blockedReason,
        revision: task.revision + 1,
        updatedAt: this.deps.clock.isoNow(),
      }
      this.tasks.set(task.id, next)
      changed.push(next)
    }
    return changed
  }

  private wouldCycle(taskId: string, newDeps: string[]): boolean {
    const visit = (id: string, seen: Set<string>): boolean => {
      if (id === taskId) return true
      if (seen.has(id)) return false
      seen.add(id)
      const deps = id === taskId ? newDeps : this.tasks.get(id)?.dependsOn ?? []
      return deps.some(d => visit(d, seen))
    }
    return newDeps.some(d => visit(d, new Set()))
  }
}
