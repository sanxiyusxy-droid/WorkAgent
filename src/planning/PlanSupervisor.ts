import { createHash } from 'node:crypto'
import type {
  PlanHealthAssessment,
  ReflectionEvaluation,
  ReflectionRecord,
  SupervisorAction,
  SupervisorDecision,
} from '../core/events.js'
import type { AgentState } from '../core/state.js'
import { requiredCriteriaWithoutUsableEvidence } from '../verification/criteriaEvidence.js'
import type { EvidenceReceipt } from '../verification/types.js'
import type { PlanTask, PlanVersion } from './types.js'
import { workspacePathKey } from '../workspace/pathKey.js'

export interface PlanSupervisionInput {
  state: AgentState
  approvedPlan?: PlanVersion
  evidence: EvidenceReceipt[]
  id: string
  createdAt: string
  staleEvidenceIds?: ReadonlySet<string>
}

/**
 * Deterministic, evidence-driven plan supervision. The supervisor reads only
 * reduced facts and signed evidence; it never attempts to infer progress from
 * assistant prose.
 */
export function assessPlanHealth(input: PlanSupervisionInput): PlanHealthAssessment {
  const { state, approvedPlan } = input
  const tasks = tasksForPlan(state.tasks, approvedPlan)
  const completedTasks = tasks.filter(task => task.status === 'completed').length
  const blockedTasks = tasks.filter(task => task.status === 'blocked').length
  const failedTasks = tasks.filter(task => task.status === 'failed').length
  const openTasks = tasks.length - completedTasks - blockedTasks - failedTasks
  const completedIds = new Set(
    tasks.filter(task => task.status === 'completed').map(task => task.id),
  )
  const readyTasks = tasks.filter(
    task =>
      (task.status === 'pending' || task.status === 'in_progress') &&
      task.dependsOn.every(dependency => completedIds.has(dependency)),
  )

  const requiredCriteria = approvedPlan?.acceptanceCriteria.filter(c => c.required) ?? []
  const uncovered = requiredCriteriaWithoutUsableEvidence(
    requiredCriteria,
    input.evidence,
    {
      staleEvidenceIds: input.staleEvidenceIds,
      expectedWorkspaceRoot: state.workspace.root,
    },
  )
  const coveredCriteria = requiredCriteria.length - uncovered.length
  const plannedFiles = new Set<string>()
  const invalidPlanFiles: string[] = []
  for (const path of approvedPlan?.steps.flatMap(step => step.files) ?? []) {
    try {
      plannedFiles.add(workspacePathKey(state.workspace.root, path))
    } catch {
      invalidPlanFiles.push(path)
    }
  }
  const scopeDriftFiles = [
    ...invalidPlanFiles.map(path => `invalid-plan-path:${path}`),
    ...(plannedFiles.size === 0
      ? []
      : state.workspace.planScopedTouchedFiles.filter(path => !plannedFiles.has(path))),
  ].sort()
  const budgetRemainingRatio = minimumBudgetRemaining(state)

  const findings: string[] = []
  let score = 100
  if (failedTasks > 0) {
    score -= Math.min(40, failedTasks * 20)
    findings.push(`${failedTasks} task(s) failed.`)
  }
  if (blockedTasks > 0) {
    score -= Math.min(40, blockedTasks * 20)
    findings.push(`${blockedTasks} task(s) are blocked.`)
  }
  if (openTasks > 0 && readyTasks.length === 0) {
    score -= 20
    findings.push('Open tasks exist, but none has satisfied dependencies.')
  }
  if (uncovered.length > 0) {
    const penalty = Math.ceil((uncovered.length / Math.max(1, requiredCriteria.length)) * 25)
    score -= penalty
    findings.push(
      `${uncovered.length}/${requiredCriteria.length} required acceptance criteria lack usable evidence.`,
    )
  }
  if (scopeDriftFiles.length > 0) {
    score -= Math.min(25, scopeDriftFiles.length * 8)
    findings.push(`Touched files outside approved scope: ${scopeDriftFiles.slice(0, 5).join(', ')}.`)
  }
  if (state.recovery.consecutiveFailures > 0) {
    score -= Math.min(24, state.recovery.consecutiveFailures * 8)
    findings.push(`${state.recovery.consecutiveFailures} consecutive failed tool batch(es).`)
  }
  if (state.recovery.stagnationCount > 0) {
    score -= Math.min(20, state.recovery.stagnationCount * 10)
    findings.push(`${state.recovery.stagnationCount} stagnation signal(s) have been recorded.`)
  }
  if (state.recovery.ineffectiveReflectionCount > 0) {
    score -= Math.min(20, state.recovery.ineffectiveReflectionCount * 10)
    findings.push(
      `${state.recovery.ineffectiveReflectionCount} consecutive reflection recommendation(s) were ineffective.`,
    )
  }
  if (budgetRemainingRatio <= 0.15) {
    score -= 20
    findings.push('The minimum remaining call/turn budget is at or below 15%.')
  } else if (budgetRemainingRatio <= 0.4) {
    score -= 10
    findings.push('The minimum remaining call/turn budget is at or below 40%.')
  }
  score = Math.max(0, Math.min(100, score))

  const status = healthStatus({
    hasPlanOrTasks: Boolean(approvedPlan || tasks.length > 0),
    score,
    failedTasks,
    blockedTasks,
    readyTasks: readyTasks.length,
    replanning: state.recovery.replanning,
    awaitingApproval: state.recovery.replanAwaitingApproval,
  })
  const decision = chooseNextAction({
    state,
    approvedPlan,
    tasks,
    readyTasks,
    uncoveredCriteria: uncovered.map(c => c.id),
    scopeDriftFiles,
  })
  const metrics = {
    totalTasks: tasks.length,
    completedTasks,
    openTasks,
    blockedTasks,
    failedTasks,
    readyTasks: readyTasks.length,
    requiredCriteria: requiredCriteria.length,
    coveredCriteria,
    scopeDriftFiles: scopeDriftFiles.length,
    budgetRemainingRatio,
    consecutiveFailures: state.recovery.consecutiveFailures,
    stagnationSignals: state.recovery.stagnationCount,
    ineffectiveReflections: state.recovery.ineffectiveReflectionCount,
  }
  const signature = createHash('sha256')
    .update(JSON.stringify({
      status,
      score,
      metrics: {
        ...metrics,
        // Raw ratios change on every call. The journal signature records only
        // policy-relevant threshold crossings, while the assessment still
        // exposes the exact ratio for diagnostics.
        budgetRemainingRatio: budgetBand(budgetRemainingRatio),
      },
      decision,
      scopeDriftFiles,
    }))
    .digest('hex')
    .slice(0, 16)

  return {
    id: input.id,
    createdAt: input.createdAt,
    plan: approvedPlan
      ? { planId: approvedPlan.planId, version: approvedPlan.version }
      : undefined,
    status,
    score,
    signature,
    metrics,
    findings,
    decision,
  }
}

export function evaluateReflectionEffect(input: {
  state: AgentState
  reflection: ReflectionRecord
  id: string
  createdAt: string
  evaluationWindow: number
}): ReflectionEvaluation | null {
  const { state, reflection } = input
  if (!reflection.decision) return null
  if (state.reflectionEvaluations.some(item => item.reflectionId === reflection.id)) {
    return null
  }
  if (
    reflection.progress.evidenceReceipts === undefined ||
    reflection.progress.successfulToolCalls === undefined
  ) {
    // Pre-v1.4 records have no complete baseline and must not be guessed.
    return null
  }

  const toolCallsObserved = Math.max(
    0,
    state.budget.used.toolCalls - reflection.progress.toolCalls,
  )
  if (toolCallsObserved === 0) return null

  const completedNow = state.tasks.filter(task => task.status === 'completed').length
  const successfulNow = Object.values(state.toolResults).filter(result => result.ok).length
  const progressSignals: string[] = []
  if (completedNow > reflection.progress.completedTasks) {
    progressSignals.push(
      `${completedNow - reflection.progress.completedTasks} additional task(s) completed`,
    )
  }
  if (state.evidenceIds.length > reflection.progress.evidenceReceipts) {
    progressSignals.push(
      `${state.evidenceIds.length - reflection.progress.evidenceReceipts} new evidence receipt(s) recorded`,
    )
  }
  if (
    state.recovery.lastProgressToolCalls > reflection.progress.toolCalls &&
    successfulNow > reflection.progress.successfulToolCalls
  ) {
    progressSignals.push('a successful tool call produced workspace, task, or evidence progress')
  }

  const window = Math.max(1, input.evaluationWindow)
  if (progressSignals.length === 0 && toolCallsObserved < window) return null
  const outcome = progressSignals.length > 0 ? 'effective' : 'ineffective'
  const followUp: SupervisorDecision = outcome === 'effective'
    ? {
        action: reflection.decision.action,
        rationale: 'The previous recommendation produced measurable fact-level progress.',
        targetTaskId: reflection.decision.targetTaskId,
        targetStepId: reflection.decision.targetStepId,
        successSignals: reflection.decision.successSignals,
      }
    : {
        action: fallbackAfterIneffective(reflection.decision.action),
        rationale:
          `No task, evidence, or workspace progress was observed after ${toolCallsObserved} tool calls.`,
        targetTaskId: reflection.decision.targetTaskId,
        targetStepId: reflection.decision.targetStepId,
        successSignals: [
          'change the working hypothesis',
          'obtain one discriminating observation before another write',
        ],
      }

  return {
    id: input.id,
    reflectionId: reflection.id,
    createdAt: input.createdAt,
    outcome,
    toolCallsObserved,
    progressSignals,
    followUp,
  }
}

export function renderPlanSupervision(
  assessment: PlanHealthAssessment,
  evaluation?: ReflectionEvaluation,
): string {
  const findings = assessment.findings.length > 0
    ? assessment.findings.slice(0, 4).join(' ')
    : 'No material plan-health finding.'
  const evaluationLine = evaluation
    ? `Previous reflection outcome: ${evaluation.outcome}; ${evaluation.followUp.rationale}`
    : undefined
  return [
    `[PLAN SUPERVISOR: ${assessment.status.toUpperCase()} ${assessment.score}/100]`,
    `Findings: ${findings}`,
    `Next action: ${assessment.decision.action}. ${assessment.decision.rationale}`,
    `Success signals: ${assessment.decision.successSignals.join('; ') || 'a durable fact-level progress signal'}.`,
    evaluationLine,
    'Treat this as a bounded runtime policy hint. Do not claim completion from prose; satisfy tasks and evidence gates.',
  ].filter((line): line is string => Boolean(line)).join('\n')
}

/** Select only tasks owned by the current approved plan version. */
export function tasksForPlan(tasks: PlanTask[], approvedPlan?: PlanVersion): PlanTask[] {
  if (!approvedPlan) return tasks
  const matched = tasks.filter(
    task =>
      task.planId === approvedPlan.planId &&
      task.planVersion === approvedPlan.version,
  )
  return matched.length > 0 ? matched : tasks.filter(task => !task.planId)
}

function healthStatus(input: {
  hasPlanOrTasks: boolean
  score: number
  failedTasks: number
  blockedTasks: number
  readyTasks: number
  replanning: boolean
  awaitingApproval: boolean
}): PlanHealthAssessment['status'] {
  if (!input.hasPlanOrTasks) return 'not_applicable'
  if (
    input.awaitingApproval ||
    input.failedTasks > 0 ||
    (input.blockedTasks > 0 && input.readyTasks === 0)
  ) {
    return 'blocked'
  }
  if (input.replanning || input.score < 50) return 'at_risk'
  if (input.score < 80) return 'attention'
  return 'healthy'
}

function chooseNextAction(input: {
  state: AgentState
  approvedPlan?: PlanVersion
  tasks: PlanTask[]
  readyTasks: PlanTask[]
  uncoveredCriteria: string[]
  scopeDriftFiles: string[]
}): SupervisorDecision {
  const { state } = input
  if (state.recovery.replanning && state.recovery.replanAwaitingApproval) {
    return decision(
      'request_reapproval',
      'The active plan was superseded and write execution is locked until a revised version is approved.',
      ['persist a revised plan version', 'obtain an approval token before any write'],
    )
  }
  if (state.recovery.replanning) {
    return decision(
      'repair_plan',
      'A durable low-impact replan is active; persist the bounded plan adjustment before resuming implementation.',
      ['apply or persist the smallest plan repair', 'close the durable replanning state before workspace writes'],
    )
  }
  if (state.pendingVerificationRepair) {
    const report = state.pendingVerificationRepair.report
    const failures = report.failures
      .slice(0, 3)
      .map(failure => {
        const title = failure.title.slice(0, 160)
        const reproduction = failure.reproduction[0]?.slice(0, 200)
        return `[${failure.severity}] ${title}` +
          (reproduction ? ` (repro: ${reproduction})` : '')
      })
      .join('; ')
    const omitted = Math.max(0, report.failures.length - 3)
    return decision(
      'continue_step',
      `Independent verification repair attempt ${state.pendingVerificationRepair.attempt} is open` +
        `${failures ? `: ${failures}` : '.'}` +
        `${omitted > 0 ? `; ${omitted} additional durable failure(s) omitted from this bounded prompt.` : ''}`,
      ['apply the smallest verified repair', 'return control for a fresh independent verification'],
    )
  }
  const failed = input.tasks.find(task => task.status === 'failed')
  if (failed || input.scopeDriftFiles.length > 0 || state.recovery.ineffectiveReflectionCount > 0) {
    return decision(
      'repair_plan',
      failed
        ? `Task ${failed.id} failed; revise the smallest affected step.`
        : input.scopeDriftFiles.length > 0
          ? 'Observed workspace scope differs from the approved plan.'
          : 'The previous reflection did not produce measurable progress.',
      ['preserve unaffected steps', 'produce progress without expanding approved scope'],
      failed,
    )
  }
  const blocked = input.tasks.find(task => task.status === 'blocked')
  if (blocked) {
    return decision(
      'resolve_blocker',
      `Task ${blocked.id} is blocked: ${blocked.blockedReason ?? 'no durable reason recorded'}.`,
      ['record a discriminating observation', 'unblock, fail, or honestly terminate the task'],
      blocked,
    )
  }
  const ready = input.readyTasks[0]
  if (ready) {
    return decision(
      'continue_step',
      `Task ${ready.id} is dependency-ready and should remain the execution focus.`,
      ['complete the task or record an explicit blocker', 'avoid unrelated file scope'],
      ready,
    )
  }
  if (state.lastTransition?.reason === 'user_followup') {
    return decision(
      'continue_step',
      'A new human follow-up opened one execution turn; establish its task or plan before claiming completion.',
      ['record the follow-up scope as a task or plan', 'preserve every existing safety and approval lock'],
    )
  }
  const executionCompleted =
    input.tasks.length > 0 && input.tasks.every(task => task.status === 'completed')
  if (executionCompleted && input.uncoveredCriteria.length > 0) {
    return decision(
      'gather_evidence',
      `Required criteria still lack usable evidence: ${input.uncoveredCriteria.slice(0, 5).join(', ')}.`,
      ['record kind-matched passed evidence', 'keep evidence bound to the current workspace revision'],
    )
  }
  if (
    input.approvedPlan &&
    executionCompleted &&
    state.workspace.touchedFiles.length > 0 &&
    !state.lastVerification
  ) {
    return decision(
      'run_verification',
      'All plan tasks and required evidence are complete, but changed code has no independent verification verdict.',
      ['produce a fresh verification verdict', 'resolve every reproduced failure before completion'],
    )
  }
  if (
    input.approvedPlan &&
    executionCompleted
  ) {
    return decision(
      'finish',
      'Tasks, required evidence and verification state permit the completion gate to decide.',
      ['completion gate returns complete', 'final report matches persisted facts'],
    )
  }
  return decision(
    'continue_step',
    'No approved executable task is available; clarify or persist a bounded plan before broad changes.',
    ['an approved plan or an explicit next task is recorded'],
  )
}

function decision(
  action: SupervisorAction,
  rationale: string,
  successSignals: string[],
  task?: PlanTask,
): SupervisorDecision {
  return {
    action,
    rationale,
    targetTaskId: task?.id,
    targetStepId: task?.stepId,
    successSignals,
  }
}

function fallbackAfterIneffective(action: SupervisorAction): SupervisorAction {
  if (action === 'gather_evidence') return 'resolve_blocker'
  if (action === 'request_reapproval') return 'request_reapproval'
  return 'repair_plan'
}

function minimumBudgetRemaining(state: AgentState): number {
  const remaining = [
    ratio(state.budget.used.modelCalls, state.budget.maxModelCalls),
    ratio(state.budget.used.toolCalls, state.budget.maxToolCalls),
    ratio(state.iteration, state.budget.maxTurns),
  ]
  return Math.min(...remaining)
}

function ratio(used: number, max: number): number {
  if (max <= 0) return 0
  return Math.max(0, Math.min(1, (max - used) / max))
}

function budgetBand(value: number): 'critical' | 'conservative' | 'normal' {
  if (value <= 0.15) return 'critical'
  if (value <= 0.4) return 'conservative'
  return 'normal'
}
