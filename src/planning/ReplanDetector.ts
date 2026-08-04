import type { AgentState } from '../core/state.js'
import type { PlanVersion, PlanTask } from './types.js'
import type { EvidenceReceipt } from '../verification/types.js'

/**
 * Replan trigger detection (guide §8.5).
 *
 * The engine calls `detectReplanTrigger` after each tool batch and after
 * verification. If a trigger fires, the engine emits a `replan_required`
 * loop transition and injects a replan instruction message.
 *
 * Replan always creates a NEW plan version — never mutates an approved plan.
 */

export type ReplanCause =
  | { type: 'consecutive_failures'; count: number; threshold: number }
  | { type: 'assumption_falsified'; assumption: string; evidence: string }
  | { type: 'version_conflict_threshold'; conflicts: number; threshold: number }
  | { type: 'scope_exceeded'; plannedFiles: string[]; actualFiles: string[] }
  | { type: 'verification_failed'; failures: string[] }
  | { type: 'budget_pressure'; remaining: number; kind: string }

export interface ReplanDecision {
  required: boolean
  cause?: ReplanCause
  /** whether the new plan version needs re-approval (impact-based) */
  requiresReapproval: boolean
  message: string
}

export interface ReplanConfig {
  /** consecutive tool failures before triggering (default 3) */
  failureThreshold: number
  /** file version conflicts before triggering (default 3) */
  conflictThreshold: number
  /** ratio of unplanned files to planned files before triggering (default 2.0) */
  scopeRatio: number
  /** budget remaining ratio that triggers pressure warning (default 0.15) */
  budgetPressureRatio: number
}

const DEFAULT_CONFIG: ReplanConfig = {
  failureThreshold: 3,
  conflictThreshold: 3,
  scopeRatio: 2.0,
  budgetPressureRatio: 0.15,
}

/**
 * Analyze current state and determine if a replan is needed.
 * Returns the first trigger found (priority order) or { required: false }.
 */
export function detectReplanTrigger(input: {
  state: AgentState
  approvedPlan?: PlanVersion
  config?: Partial<ReplanConfig>
  /** consecutive failure count tracked by the engine */
  consecutiveFailures: number
  /** file version conflict count tracked by the engine */
  versionConflicts: number
  /** verification failures from the latest report */
  verificationFailures?: string[]
}): ReplanDecision {
  const config = { ...DEFAULT_CONFIG, ...input.config }
  const { state, approvedPlan } = input

  // 1. consecutive tool failures
  if (input.consecutiveFailures >= config.failureThreshold) {
    return {
      required: true,
      cause: {
        type: 'consecutive_failures',
        count: input.consecutiveFailures,
        threshold: config.failureThreshold,
      },
      requiresReapproval: true,
      message:
        `${input.consecutiveFailures} consecutive tool failures detected. ` +
        'The current approach is not working. Create a revised plan with a different strategy.',
    }
  }

  // 2. file version conflicts exceeding threshold
  if (input.versionConflicts >= config.conflictThreshold) {
    return {
      required: true,
      cause: {
        type: 'version_conflict_threshold',
        conflicts: input.versionConflicts,
        threshold: config.conflictThreshold,
      },
      requiresReapproval: false,
      message:
        `${input.versionConflicts} file version conflicts detected. ` +
        'Files are being modified concurrently or the plan ordering is wrong. ' +
        'Revise the plan to sequence edits correctly.',
    }
  }

  // 3. scope exceeded: actual touched files far exceed planned files
  if (approvedPlan && approvedPlan.steps.length > 0) {
    const plannedFiles = new Set(approvedPlan.steps.flatMap(s => s.files))
    const actualFiles = state.workspace.touchedFiles
    if (plannedFiles.size > 0) {
      const unplanned = actualFiles.filter(f => !plannedFiles.has(f))
      const ratio = unplanned.length / plannedFiles.size
      if (ratio >= config.scopeRatio) {
        return {
          required: true,
          cause: {
            type: 'scope_exceeded',
            plannedFiles: [...plannedFiles],
            actualFiles,
          },
          requiresReapproval: true,
          message:
            `Modification scope exceeded plan: ${unplanned.length} unplanned files ` +
            `(ratio ${ratio.toFixed(1)}x). Unplanned: ${unplanned.slice(0, 5).join(', ')}. ` +
            'Revise the plan to reflect actual scope.',
        }
      }
    }
  }

  // 4. verification failures
  if (input.verificationFailures && input.verificationFailures.length > 0) {
    return {
      required: true,
      cause: {
        type: 'verification_failed',
        failures: input.verificationFailures,
      },
      requiresReapproval: false,
      message:
        `Independent verification failed: ${input.verificationFailures.join('; ')}. ` +
        'Revise the plan to address the findings.',
    }
  }

  // 5. budget pressure
  const budgetRemaining = 1 - (state.budget.used.modelCalls / state.budget.maxModelCalls)
  if (budgetRemaining <= config.budgetPressureRatio && state.budget.maxModelCalls > 0) {
    return {
      required: true,
      cause: {
        type: 'budget_pressure',
        remaining: budgetRemaining,
        kind: 'model_calls',
      },
      requiresReapproval: false,
      message:
        `Budget pressure: only ${(budgetRemaining * 100).toFixed(0)}% of model calls remaining. ` +
        'Simplify the plan to fit within budget, or mark remaining work as blocked.',
    }
  }

  return { required: false, requiresReapproval: false, message: '' }
}

/**
 * Plan execution constraints (guide §8.6).
 * Validates that the current execution is consistent with the approved plan.
 */

export interface PlanConstraintViolation {
  kind: 'unplanned_file' | 'task_without_step' | 'uncovered_criterion' | 'plan_stale'
  detail: string
  severity: 'warning' | 'error'
}

/**
 * Check plan execution constraints. Returns violations (empty = compliant).
 * Called by the engine after each tool batch for soft enforcement.
 */
export function checkPlanConstraints(input: {
  state: AgentState
  approvedPlan?: PlanVersion
  tasks: PlanTask[]
}): PlanConstraintViolation[] {
  const { state, approvedPlan, tasks } = input
  if (!approvedPlan) return []

  const violations: PlanConstraintViolation[] = []

  // 1. modified files should belong to approved plan steps
  const plannedFiles = new Set(approvedPlan.steps.flatMap(s => s.files))
  if (plannedFiles.size > 0) {
    for (const file of state.workspace.touchedFiles) {
      if (!plannedFiles.has(file)) {
        violations.push({
          kind: 'unplanned_file',
          detail: `file "${file}" is not in any plan step`,
          severity: 'warning',
        })
      }
    }
  }

  // 2. tasks should correspond to plan steps
  const stepIds = new Set(approvedPlan.steps.map(s => s.id))
  for (const task of tasks) {
    if (task.planId === approvedPlan.planId && task.planVersion === approvedPlan.version) {
      // task claims to belong to this plan — verify it maps to a step
      // (soft check: tasks without explicit step binding are warnings)
      continue
    }
    if (task.planId && task.planId !== approvedPlan.planId) {
      violations.push({
        kind: 'task_without_step',
        detail: `task ${task.id} references plan ${task.planId} but active plan is ${approvedPlan.planId}`,
        severity: 'error',
      })
    }
  }

  // 3. required acceptance criteria must be referenced by at least one task
  const requiredCriteria = approvedPlan.acceptanceCriteria.filter(
    c => c.required && c.evidenceKind !== 'manual',
  )
  const coveredByTasks = new Set(tasks.flatMap(t => t.acceptanceCriteria))
  for (const criterion of requiredCriteria) {
    if (!coveredByTasks.has(criterion.id)) {
      violations.push({
        kind: 'uncovered_criterion',
        detail: `required criterion "${criterion.id}" (${criterion.statement}) is not referenced by any task`,
        severity: 'warning',
      })
    }
  }

  return violations
}
