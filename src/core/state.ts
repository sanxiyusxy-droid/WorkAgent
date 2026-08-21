import type { ConversationMessage, ToolCall, ToolCallResult } from './messages.js'
import type {
  AgentMode,
  ContinueTransition,
  FactEvent,
  LoopPhase,
  ReflectionRecord,
  ReflectionEvaluation,
  PlanHealthAssessment,
  ExecutionStrategy,
  StateSnapshot,
} from './events.js'
import { isSupervisorAction } from './events.js'
import type { PlanTask } from '../planning/types.js'
import type { VerificationReport } from '../verification/types.js'
import { InvariantError } from './messages.js'
import {
  appendBounded,
  fingerprintToolCall,
  toolOutcomeSignature,
} from './LoopIntelligence.js'
import { workspacePathKey } from '../workspace/pathKey.js'
import {
  freezeOutcomeCalibrationSelection,
  isOutcomeCalibrationSelection,
  type OutcomeCalibrationSelection,
} from '../planning/OutcomeCalibrationContract.js'

export interface RecoveryState {
  modelRetries: number
  compactFailures: number
  promptOverflowRecovered: boolean
  outputLimitRecoveries: number
  stopHookRetries: number
  verifierRepairs: number
  /** bounded replan counter (part of durable state, survives recovery) */
  replanCount: number
  /** replan detector inputs, snapshotted so replay stays deterministic */
  consecutiveFailures: number
  versionConflicts: number
  /** explicit replanning state: set by replan.requested, cleared by
   *  plan.approved (reapproval) or replan.adjustment.applied (low-impact) */
  replanning: boolean
  /** the pending replan needs human re-approval → write tools stay disabled */
  replanAwaitingApproval: boolean
  /** degraded recovery branches are permanently read-only */
  degradedRecovery: boolean
  recentToolFingerprints: string[]
  recentOutcomeSignatures: string[]
  stagnationCount: number
  lastStagnationSignature?: string
  reflectionCount: number
  lastReflectionToolCalls: number
  lastReflectionTrigger?: ReflectionRecord['trigger']
  /** consecutive ineffective v1.4 reflection outcomes; reset on progress */
  ineffectiveReflectionCount: number
  lastEvaluatedReflectionId?: string
  /** tool-call count at the latest workspace/task/plan/evidence progress event */
  lastProgressToolCalls: number
  executionStrategy: ExecutionStrategy
}

export interface RunBudget {
  maxTurns: number
  maxModelCalls: number
  maxToolCalls: number
  maxWallTimeMs: number
  used: {
    modelCalls: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    startedAt: number
  }
}

export interface AgentState {
  sessionId: string
  runId: string
  turnId: string
  iteration: number
  phase: LoopPhase

  messages: ConversationMessage[]
  pendingToolCalls: ToolCall[]
  /** callId -> result; every accepted call must end with exactly one entry */
  toolResults: Record<string, ToolCallResult>

  mode: AgentMode
  prePlanMode?: Exclude<AgentMode, 'plan'>
  activePlan?: { planId: string; version: number; approved: boolean }
  tasks: PlanTask[]
  evidenceIds: string[]
  lastVerification?: { report: VerificationReport; valid: boolean }
  /** The FAIL report and attempt survive a crash until re-verification/replan. */
  pendingVerificationRepair?: { attempt: number; report: VerificationReport }
  /** bounded, durable reflection records used by recovery and audit */
  reflections: ReflectionRecord[]
  /** latest deduplicated plan supervisor result */
  latestPlanHealth?: PlanHealthAssessment
  /** bounded outcomes prove whether reflection recommendations helped */
  reflectionEvaluations: ReflectionEvaluation[]
  /** V1.8: one replay-stable workspace-local adaptive-policy selection. */
  outcomeCalibrationSelection?: OutcomeCalibrationSelection

  workspace: {
    root: string
    touchedFiles: string[]
    /** Reset on plan approval; preserves cumulative touchedFiles for audit. */
    planScopedTouchedFiles: string[]
    createdFiles: string[]
    deletedFiles: string[]
  }

  recovery: RecoveryState
  budget: RunBudget
  lastTransition?: ContinueTransition
}

export function initialRecovery(): RecoveryState {
  return {
    modelRetries: 0,
    compactFailures: 0,
    promptOverflowRecovered: false,
    outputLimitRecoveries: 0,
    stopHookRetries: 0,
    verifierRepairs: 0,
    replanCount: 0,
    consecutiveFailures: 0,
    versionConflicts: 0,
    replanning: false,
    replanAwaitingApproval: false,
    degradedRecovery: false,
    recentToolFingerprints: [],
    recentOutcomeSignatures: [],
    stagnationCount: 0,
    reflectionCount: 0,
    lastReflectionToolCalls: 0,
    ineffectiveReflectionCount: 0,
    lastProgressToolCalls: 0,
    executionStrategy: 'normal',
  }
}

export function createInitialState(input: {
  sessionId: string
  runId: string
  turnId: string
  workspaceRoot: string
  mode?: AgentMode
  budget: Omit<RunBudget, 'used'>
  now: number
}): AgentState {
  return {
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    iteration: 0,
    phase: 'preparing_context',
    messages: [],
    pendingToolCalls: [],
    toolResults: {},
    mode: input.mode ?? 'default',
    tasks: [],
    evidenceIds: [],
    reflections: [],
    reflectionEvaluations: [],
    workspace: {
      root: input.workspaceRoot,
      touchedFiles: [],
      planScopedTouchedFiles: [],
      createdFiles: [],
      deletedFiles: [],
    },
    recovery: initialRecovery(),
    budget: {
      ...input.budget,
      used: {
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        startedAt: input.now,
      },
    },
  }
}

function pushUnique(list: string[], value: string): string[] {
  return list.includes(value) ? list : [...list, value]
}

function withoutLastVerification(state: AgentState): AgentState {
  const next = { ...state }
  delete next.lastVerification
  return next
}

function withoutPendingVerificationRepair(state: AgentState): AgentState {
  const next = { ...state }
  delete next.pendingVerificationRepair
  return next
}

const REFLECTION_TRIGGERS = new Set<ReflectionRecord['trigger']>([
  'periodic',
  'stagnation',
  'replan',
  'verification',
  'completion',
])

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validReflectionBaseline(
  state: AgentState,
  reflection: ReflectionRecord,
): boolean {
  const progress = reflection.progress
  if (!progress || typeof progress !== 'object') return false
  const successfulToolCalls = Object.values(state.toolResults)
    .filter(result => result.ok).length
  const requiredExact =
    isNonNegativeInteger(progress.completedTasks) &&
    isNonNegativeInteger(progress.totalTasks) &&
    isNonNegativeInteger(progress.touchedFiles) &&
    isNonNegativeInteger(progress.toolCalls) &&
    progress.completedTasks ===
      state.tasks.filter(task => task.status === 'completed').length &&
    progress.totalTasks === state.tasks.length &&
    progress.touchedFiles === state.workspace.touchedFiles.length &&
    progress.toolCalls === state.budget.used.toolCalls
  if (!requiredExact) return false
  const evidenceValid = reflection.decision
    ? isNonNegativeInteger(progress.evidenceReceipts) &&
      progress.evidenceReceipts === state.evidenceIds.length
    : progress.evidenceReceipts === undefined ||
      (isNonNegativeInteger(progress.evidenceReceipts) &&
        progress.evidenceReceipts === state.evidenceIds.length)
  const successfulValid = reflection.decision
    ? isNonNegativeInteger(progress.successfulToolCalls) &&
      progress.successfulToolCalls === successfulToolCalls
    : progress.successfulToolCalls === undefined ||
      (isNonNegativeInteger(progress.successfulToolCalls) &&
        progress.successfulToolCalls === successfulToolCalls)
  return evidenceValid && successfulValid
}

function validReflectionCalibration(
  state: AgentState,
  reflection: ReflectionRecord,
): boolean {
  const calibration = reflection.calibration
  if (!calibration) return true
  if (
    !reflection.decision ||
    Object.keys(calibration).sort().join(',') !==
      'baseWindow,calibratedWindow,delta,profileHash,selectionHash'
  ) {
    return false
  }
  const selection = state.outcomeCalibrationSelection
  if (
    !selection ||
    calibration.selectionHash !== selection.hash ||
    calibration.profileHash !== selection.profile.hash ||
    !Number.isInteger(calibration.baseWindow) ||
    calibration.baseWindow < 1 ||
    calibration.baseWindow > 20 ||
    !Number.isInteger(calibration.calibratedWindow) ||
    calibration.calibratedWindow < 1 ||
    calibration.calibratedWindow > 20 ||
    (calibration.delta !== -1 && calibration.delta !== 0 && calibration.delta !== 1)
  ) {
    return false
  }
  const entry = selection.profile.entries.find(
    item =>
      item.trigger === reflection.trigger &&
      item.action === reflection.decision!.action,
  )
  if (!entry || entry.samples < selection.profile.minSamples) return false
  const expectedDelta: -1 | 0 | 1 =
    entry.smoothedEffectiveness >= 0.75
      ? 1
      : entry.smoothedEffectiveness <= 0.4
        ? -1
        : 0
  const expectedWindow = Math.max(
    1,
    Math.min(20, calibration.baseWindow + expectedDelta),
  )
  return calibration.delta === expectedDelta &&
    calibration.calibratedWindow === expectedWindow &&
    reflection.decision.evaluateAfterToolCalls === expectedWindow
}

/**
 * The only place where fact events mutate agent state.
 * Raw model responses are never modified in place; reducers always
 * return new objects.
 */
export function reduce(state: AgentState, event: FactEvent): AgentState {
  switch (event.type) {
    case 'run.started':
      return { ...state, runId: event.runId }

    case 'outcome.calibration.selected': {
      if (state.outcomeCalibrationSelection) {
        throw new InvariantError(
          'outcome_calibration_duplicate_selection',
          'a session may contain only one outcome calibration selection',
        )
      }
      if (!isOutcomeCalibrationSelection(event.selection)) {
        throw new InvariantError(
          'outcome_calibration_invalid_selection',
          'outcome calibration selection failed canonical profile/provenance validation',
        )
      }
      return {
        ...state,
        outcomeCalibrationSelection:
          freezeOutcomeCalibrationSelection(event.selection),
      }
    }

    case 'user.message.accepted': {
      const next: AgentState = {
        ...state,
        messages: [...state.messages, event.message],
      }
      if (
        event.message.meta?.source === 'human' &&
        (state.phase === 'terminated' || state.lastVerification)
      ) {
        next.lastTransition = { reason: 'user_followup' }
      }
      if (event.message.meta?.source === 'human' && state.lastVerification) {
        if (state.lastVerification) {
          if (state.lastVerification.report.verdict !== 'PASS') {
            const attempt = Math.max(1, state.recovery.verifierRepairs + 1)
            next.pendingVerificationRepair = {
              attempt,
              report: state.lastVerification.report,
            }
            next.recovery = {
              ...state.recovery,
              verifierRepairs: attempt,
            }
          }
          // A terminal verdict belongs to the completed request that produced
          // it. Any new human goal invalidates PASS as well as non-PASS so
          // subsequent work cannot reuse an old verifier result.
          delete next.lastVerification
        }
      }
      return next
    }
    case 'tool.result.message':
      return { ...state, messages: [...state.messages, event.message] }

    case 'assistant.message.completed': {
      // the reducer owns model budget accounting: a full journal replay
      // must reproduce budget.used exactly, field for field
      return {
        ...state,
        messages: [...state.messages, event.message],
        budget: {
          ...state.budget,
          used: {
            ...state.budget.used,
            modelCalls: state.budget.used.modelCalls + 1,
            inputTokens:
              state.budget.used.inputTokens + (event.usage?.inputTokens ?? 0),
            outputTokens:
              state.budget.used.outputTokens + (event.usage?.outputTokens ?? 0),
          },
        },
      }
    }

    case 'model.attempt.failed':
      return {
        ...state,
        recovery: {
          ...state.recovery,
          modelRetries:
            state.recovery.modelRetries +
            (event.failure.action === 'retry' ? 1 : 0),
        },
        budget: {
          ...state.budget,
          used: {
            ...state.budget.used,
            modelCalls: state.budget.used.modelCalls + 1,
          },
        },
      }

    case 'tool.call.accepted': {
      const recovery = {
        ...state.recovery,
        recentToolFingerprints: appendBounded(
          state.recovery.recentToolFingerprints,
          fingerprintToolCall(event.call),
        ),
      }
      if (state.pendingToolCalls.some(c => c.id === event.call.id)) {
        throw new InvariantError(
          'unique_tool_call_id',
          `duplicate tool call id: ${event.call.id}`,
        )
      }
      // a model may re-issue a callId whose previous lifecycle already
      // terminated (crash + retry). Re-acceptance restarts the lifecycle:
      // the stale result is cleared so the call is pending again.
      if (state.toolResults[event.call.id] !== undefined) {
        const toolResults = { ...state.toolResults }
        delete toolResults[event.call.id]
        return {
          ...state,
          pendingToolCalls: [...state.pendingToolCalls, event.call],
          toolResults,
          recovery,
        }
      }
      return {
        ...state,
        pendingToolCalls: [...state.pendingToolCalls, event.call],
        recovery,
      }
    }

    case 'tool.call.completed': {
      const existing = state.toolResults[event.result.callId]
      if (existing) {
        throw new InvariantError(
          'single_terminal_tool_result',
          `duplicate tool result for ${event.result.callId}`,
        )
      }
      return {
        ...state,
        pendingToolCalls: state.pendingToolCalls.filter(
          c => c.id !== event.result.callId,
        ),
        toolResults: {
          ...state.toolResults,
          [event.result.callId]: event.result,
        },
        recovery: {
          ...state.recovery,
          recentOutcomeSignatures: appendBounded(
            state.recovery.recentOutcomeSignatures,
            toolOutcomeSignature(event.result),
          ),
        },
        budget: {
          ...state.budget,
          used: {
            ...state.budget.used,
            toolCalls: state.budget.used.toolCalls + 1,
          },
        },
      }
    }

    case 'permission.decided':
      return state

    case 'plan.version.created':
      return {
        ...state,
        activePlan: {
          planId: event.plan.planId,
          version: event.plan.version,
          approved: event.plan.status === 'approved',
        },
        recovery: {
          ...state.recovery,
          // PlanPropose/PlanRepair/ExitPlanMode are fact-level progress too.
          // Recording the post-call count lets reflection evaluation observe
          // them before tool.call.completed is reduced later in the batch.
          lastProgressToolCalls: state.budget.used.toolCalls + 1,
        },
      }

    case 'plan.approved': {
      if (
        !state.activePlan ||
        state.activePlan.planId !== event.planId ||
        state.activePlan.version !== event.version
      ) {
        // approving a plan version that is not the active one is a protocol
        // violation (UI showed v2, model approved v3)
        throw new InvariantError(
          'plan_approval_version_binding',
          `approved ${event.planId}@${event.version} but active is ` +
            `${state.activePlan?.planId}@${state.activePlan?.version}`,
        )
      }
      return withoutPendingVerificationRepair(withoutLastVerification({
        ...state,
        activePlan: { ...state.activePlan, approved: true },
        workspace: { ...state.workspace, planScopedTouchedFiles: [] },
        // approving the new plan version ends the replanning state and
        // releases the runtime write gate
        recovery: {
          ...state.recovery,
          replanning: false,
          replanAwaitingApproval: false,
          ineffectiveReflectionCount: 0,
          verifierRepairs: 0,
        },
      }))
    }

    case 'replan.requested':
      // the reducer owns replan bookkeeping so full replay reproduces it
      return withoutPendingVerificationRepair(withoutLastVerification({
          ...state,
          recovery: {
            ...state.recovery,
            replanning: true,
            replanAwaitingApproval: event.requiresReapproval,
            replanCount: state.recovery.replanCount + 1,
            verifierRepairs: 0,
            consecutiveFailures: 0,
            versionConflicts: 0,
          },
        }))

    case 'replan.adjustment.applied': {
      // low-impact replans close deterministically: the state machine must
      // prove when replanning started, what changed, and when it ended
      if (!state.recovery.replanning) {
        throw new InvariantError(
          'replan_adjustment_without_request',
          'replan.adjustment.applied but no replan is in progress',
        )
      }
      if (state.recovery.replanAwaitingApproval) {
        throw new InvariantError(
          'replan_adjustment_on_reapproval',
          'a reapproval replan can only end via plan.approved, ' +
            'not replan.adjustment.applied',
        )
      }
      return {
        ...state,
        recovery: { ...state.recovery, replanning: false },
      }
    }

    case 'loop.stagnation.detected':
      return {
        ...state,
        recovery: {
          ...state.recovery,
          stagnationCount: state.recovery.stagnationCount + 1,
          lastStagnationSignature: event.record.signature,
        },
      }

    case 'reflection.recorded': {
      const reflection = event.reflection
      if (state.reflections.some(item => item.id === reflection.id)) {
        throw new InvariantError(
          'reflection_duplicate_id',
          `duplicate reflection id: ${reflection.id}`,
        )
      }
      if (
        !isNonEmptyString(reflection.id) ||
        !REFLECTION_TRIGGERS.has(reflection.trigger) ||
        !isStringArray(reflection.assumptions) ||
        !isStringArray(reflection.evidenceGaps) ||
        !validReflectionBaseline(state, reflection) ||
        (reflection.decision &&
          (!isSupervisorAction(reflection.decision.action) ||
            typeof reflection.decision.rationale !== 'string' ||
            !isStringArray(reflection.decision.successSignals) ||
            !Number.isInteger(reflection.decision.evaluateAfterToolCalls) ||
            reflection.decision.evaluateAfterToolCalls < 1 ||
            reflection.decision.evaluateAfterToolCalls > 20)) ||
        !validReflectionCalibration(state, reflection)
      ) {
        throw new InvariantError(
          'reflection_invalid_decision',
          `reflection ${reflection.id} has an invalid baseline, decision or calibration attribution`,
        )
      }
      return {
        ...state,
        reflections: [...state.reflections, reflection].slice(-20),
        recovery: {
          ...state.recovery,
          reflectionCount: state.recovery.reflectionCount + 1,
          lastReflectionToolCalls: state.budget.used.toolCalls,
          lastReflectionTrigger: event.reflection.trigger,
        },
      }
    }

    case 'reflection.evaluated': {
      const reflection = state.reflections.find(
        item => item.id === event.evaluation.reflectionId,
      )
      if (!reflection?.decision) {
        throw new InvariantError(
          'reflection_evaluation_without_record',
          `reflection evaluation ${event.evaluation.id} has no decision-bearing record`,
        )
      }
      if (
        state.reflectionEvaluations.some(
          item =>
            item.id === event.evaluation.id ||
            item.reflectionId === event.evaluation.reflectionId,
        )
      ) {
        throw new InvariantError(
          'reflection_duplicate_evaluation',
          `reflection ${event.evaluation.reflectionId} was already evaluated`,
        )
      }
      if (
        !isNonEmptyString(event.evaluation.id) ||
        !isNonEmptyString(event.evaluation.reflectionId) ||
        (event.evaluation.outcome !== 'effective' &&
          event.evaluation.outcome !== 'ineffective') ||
        !isSupervisorAction(event.evaluation.followUp.action) ||
        typeof event.evaluation.followUp.rationale !== 'string' ||
        !isStringArray(event.evaluation.followUp.successSignals) ||
        !isStringArray(event.evaluation.progressSignals) ||
        !Number.isInteger(event.evaluation.toolCallsObserved) ||
        event.evaluation.toolCallsObserved < 1 ||
        event.evaluation.toolCallsObserved !==
          state.budget.used.toolCalls - reflection.progress.toolCalls ||
        (event.evaluation.outcome === 'effective' &&
          event.evaluation.progressSignals.length === 0) ||
        (event.evaluation.outcome === 'ineffective' &&
          (event.evaluation.progressSignals.length > 0 ||
            event.evaluation.toolCallsObserved <
              reflection.decision.evaluateAfterToolCalls))
      ) {
        throw new InvariantError(
          'reflection_invalid_evaluation',
          `reflection evaluation ${event.evaluation.id} is inconsistent with its recorded window/outcome`,
        )
      }
      const completedNow = state.tasks.filter(task => task.status === 'completed').length
      const successfulNow = Object.values(state.toolResults).filter(result => result.ok).length
      const factLevelProgress =
        completedNow > reflection.progress.completedTasks ||
        state.evidenceIds.length > (reflection.progress.evidenceReceipts ?? 0) ||
        (state.recovery.lastProgressToolCalls > reflection.progress.toolCalls &&
          successfulNow > (reflection.progress.successfulToolCalls ?? 0))
      if (
        (event.evaluation.outcome === 'effective' && !factLevelProgress) ||
        (event.evaluation.outcome === 'ineffective' && factLevelProgress)
      ) {
        throw new InvariantError(
          'reflection_progress_mismatch',
          `reflection evaluation ${event.evaluation.id} disagrees with durable fact-level progress`,
        )
      }
      return {
        ...state,
        reflectionEvaluations: [...state.reflectionEvaluations, event.evaluation].slice(-20),
        recovery: {
          ...state.recovery,
          lastEvaluatedReflectionId: event.evaluation.reflectionId,
          ineffectiveReflectionCount:
            event.evaluation.outcome === 'effective'
              ? 0
              : state.recovery.ineffectiveReflectionCount + 1,
        },
      }
    }

    case 'plan.health.assessed':
      if (!isSupervisorAction(event.assessment.decision?.action)) {
        throw new InvariantError(
          'plan_health_unknown_action',
          `unknown supervisor action: ${String(event.assessment.decision?.action)}`,
        )
      }
      return { ...state, latestPlanHealth: event.assessment }

    case 'tool.lane.selected':
      // Audit-only. The authoritative next projection is derived from the
      // latest durable plan-health fact; the fact proves what this turn saw.
      return state

    case 'strategy.adapted':
      return {
        ...state,
        recovery: {
          ...state.recovery,
          executionStrategy: event.to,
        },
      }

    case 'plan.status.changed': {
      // superseding the active plan version un-approves it: the write gate
      // stays closed until a new version is proposed and approved
      if (
        state.activePlan &&
        state.activePlan.planId === event.planId &&
        state.activePlan.version === event.version
      ) {
        return {
          ...state,
          activePlan: { ...state.activePlan, approved: false },
        }
      }
      return state
    }

    case 'task.changed': {
      const index = state.tasks.findIndex(t => t.id === event.task.id)
      const tasks =
        index === -1
          ? [...state.tasks, event.task]
          : state.tasks.map(t => (t.id === event.task.id ? event.task : t))
      return {
        ...state,
        tasks,
        recovery: {
          ...state.recovery,
          lastProgressToolCalls: state.budget.used.toolCalls + 1,
        },
      }
    }

    case 'evidence.recorded':
      return {
        ...state,
        evidenceIds: [...state.evidenceIds, event.receipt.id],
        recovery: {
          ...state.recovery,
          lastProgressToolCalls: state.budget.used.toolCalls + 1,
        },
      }

    case 'idempotency.adjudicated':
      // audit-only: the authoritative resolution lives in the persisted
      // idempotency ledger; the fact keeps the journal self-explaining
      return state

    case 'verification.completed':
      if (event.report.verdict === 'PASS' && !event.valid) {
        throw new InvariantError(
          'verification_invalid_pass',
          'An invalid verifier report cannot be persisted as PASS.',
        )
      }
      if (event.repairAttempt !== undefined) {
        if (
          event.report.verdict !== 'FAIL' ||
          !Number.isInteger(event.repairAttempt) ||
          event.repairAttempt < 1
        ) {
          throw new InvariantError(
            'verification_repair_invalid',
            'A verification repair attempt must be a positive integer attached to a FAIL verdict.',
          )
        }
        return withoutLastVerification({
          ...state,
          pendingVerificationRepair: {
            attempt: event.repairAttempt,
            report: event.report,
          },
          recovery: {
            ...state.recovery,
            verifierRepairs: Math.max(
              state.recovery.verifierRepairs,
              event.repairAttempt,
            ),
          },
        })
      }
      return withoutPendingVerificationRepair({
        ...state,
        lastVerification: { report: event.report, valid: event.valid },
        recovery: {
          ...state.recovery,
          verifierRepairs:
            event.report.verdict === 'PASS' ? 0 : state.recovery.verifierRepairs,
        },
      })

    case 'mode.changed': {
      // Exiting plan mode always restores the recorded prePlanMode —
      // never a hardcoded default. Replay is deterministic because this
      // logic lives in the reducer.
      const target =
        event.from === 'plan' && event.to !== 'plan' && state.prePlanMode
          ? state.prePlanMode
          : event.to
      const next: AgentState = { ...state, mode: target }
      if (event.to === 'plan' && event.from !== 'plan') {
        next.prePlanMode = event.from as Exclude<AgentMode, 'plan'>
      }
      if (event.from === 'plan' && event.to !== 'plan') {
        delete next.prePlanMode
      }
      return next
    }

    case 'context.compacted': {
      const cleared = new Set(event.record.clearedMessageIds)
      const replacements = event.record.replacements ?? []
      const messages: ConversationMessage[] = []
      let inserted = false
      for (const message of state.messages) {
        if (cleared.has(message.id)) {
          if (!inserted) {
            messages.push(...replacements)
            inserted = true
          }
          continue
        }
        messages.push(message)
      }
      if (!inserted && replacements.length > 0) messages.push(...replacements)
      return { ...state, messages }
    }

    case 'loop.transitioned': {
      if (event.transition.reason !== 'tool_results_ready') {
        return {
          ...state,
          iteration: state.iteration + 1,
          lastTransition: event.transition,
        }
      }
      // Batch-level failure counters are reduced from the same terminal
      // results during live execution and replay. This avoids engine-local
      // bookkeeping that would disappear without a recent snapshot.
      const results = Object.values(state.toolResults).slice(
        -event.transition.callCount,
      )
      const allFailed = results.length > 0 && results.every(result => !result.ok)
      const conflicts = results.filter(
        result => result.errorCode === 'FILE_VERSION_CONFLICT',
      ).length
      return {
        ...state,
        iteration: state.iteration + 1,
        lastTransition: event.transition,
        recovery: {
          ...state.recovery,
          consecutiveFailures: allFailed
            ? state.recovery.consecutiveFailures + 1
            : 0,
          versionConflicts: state.recovery.versionConflicts + conflicts,
        },
      }
    }

    case 'run.terminated':
      return { ...state, phase: 'terminated' }

    case 'state.snapshot':
      // snapshots are recovery checkpoints; they don't change live state
      return state

    case 'workspace.changed': {
      // maintain touched/created/deleted sets from write-tool facts
      const { change } = event
      let path: string
      try {
        path = workspacePathKey(state.workspace.root, event.path)
      } catch {
        throw new InvariantError(
          'workspace_change_outside_root',
          `workspace.changed path is not inside the workspace: ${event.path}`,
        )
      }
      const touched = pushUnique(state.workspace.touchedFiles, path)
      const scopedTouched = pushUnique(state.workspace.planScopedTouchedFiles, path)
      if (change === 'created') {
        return withoutLastVerification({
          ...state,
          workspace: {
            ...state.workspace,
            touchedFiles: touched,
            planScopedTouchedFiles: scopedTouched,
            createdFiles: pushUnique(state.workspace.createdFiles, path),
            deletedFiles: state.workspace.deletedFiles.filter(p => p !== path),
          },
          recovery: {
            ...state.recovery,
            lastProgressToolCalls: state.budget.used.toolCalls + 1,
          },
        })
      }
      if (change === 'deleted') {
        return withoutLastVerification({
          ...state,
          workspace: {
            ...state.workspace,
            touchedFiles: touched,
            planScopedTouchedFiles: scopedTouched,
            deletedFiles: pushUnique(state.workspace.deletedFiles, path),
          },
          recovery: {
            ...state.recovery,
            lastProgressToolCalls: state.budget.used.toolCalls + 1,
          },
        })
      }
      return withoutLastVerification({
        ...state,
        workspace: {
          ...state.workspace,
          touchedFiles: touched,
          planScopedTouchedFiles: scopedTouched,
        },
        recovery: {
          ...state.recovery,
          lastProgressToolCalls: state.budget.used.toolCalls + 1,
        },
      })
    }

    case 'session.recovery.branch':
      return {
        ...state,
        mode: 'plan',
        recovery: { ...state.recovery, degradedRecovery: true },
      }

    default: {
      const unknown = event as { type?: unknown }
      throw new InvariantError(
        'unknown_fact_event',
        `unknown fact event type: ${String(unknown.type)}`,
      )
    }
  }
}

export function applyFacts(state: AgentState, facts: FactEvent[]): AgentState {
  let next = state
  for (const fact of facts) next = reduce(next, fact)
  return next
}

/**
 * Create a serializable V4 snapshot of the current state: every field needed
 * to continue the run, including full message bodies and tool results.
 * Recovery from a V4 snapshot + tail replay must be field-for-field
 * equivalent to a full journal replay.
 */
export function createSnapshot(state: AgentState, lastSeq?: number): StateSnapshot {
  return {
    version: 4,
    lastSeq,
    iteration: state.iteration,
    mode: state.mode,
    prePlanMode: state.prePlanMode,
    activePlan: state.activePlan,
    recovery: { ...state.recovery },
    budgetUsed: {
      modelCalls: state.budget.used.modelCalls,
      toolCalls: state.budget.used.toolCalls,
      inputTokens: state.budget.used.inputTokens,
      outputTokens: state.budget.used.outputTokens,
    },
    workspace: {
      touchedFiles: [...state.workspace.touchedFiles],
      planScopedTouchedFiles: [...state.workspace.planScopedTouchedFiles],
      createdFiles: [...state.workspace.createdFiles],
      deletedFiles: [...state.workspace.deletedFiles],
    },
    messageIds: state.messages.map(m => m.id),
    evidenceIds: [...state.evidenceIds],
    taskIds: state.tasks.map(t => t.id),
    messages: state.messages.map(m => ({ ...m, content: [...m.content] })),
    pendingToolCalls: state.pendingToolCalls.map(c => ({ ...c })),
    toolResults: { ...state.toolResults },
    lastTransition: state.lastTransition,
    lastVerification: state.lastVerification
      ? { report: state.lastVerification.report, valid: state.lastVerification.valid }
      : undefined,
    pendingVerificationRepair: state.pendingVerificationRepair
      ? {
          attempt: state.pendingVerificationRepair.attempt,
          report: state.pendingVerificationRepair.report,
        }
      : undefined,
    outcomeCalibrationSelection: state.outcomeCalibrationSelection
      ? freezeOutcomeCalibrationSelection(state.outcomeCalibrationSelection)
      : undefined,
    reflections: state.reflections.map(reflection => ({
      ...reflection,
      assumptions: [...reflection.assumptions],
      evidenceGaps: [...reflection.evidenceGaps],
      progress: { ...reflection.progress },
      calibration: reflection.calibration
        ? { ...reflection.calibration }
        : undefined,
      decision: reflection.decision
        ? {
            ...reflection.decision,
            successSignals: [...reflection.decision.successSignals],
          }
        : undefined,
    })),
    latestPlanHealth: state.latestPlanHealth
      ? clonePlanHealth(state.latestPlanHealth)
      : undefined,
    reflectionEvaluations: state.reflectionEvaluations.map(evaluation => ({
      ...evaluation,
      progressSignals: [...evaluation.progressSignals],
      followUp: {
        ...evaluation.followUp,
        successSignals: [...evaluation.followUp.successSignals],
      },
    })),
    tasks: state.tasks.map(task => ({
      ...task,
      dependsOn: [...task.dependsOn],
      acceptanceCriteria: [...task.acceptanceCriteria],
      evidenceIds: [...task.evidenceIds],
    })),
  }
}

/**
 * Restore state from a snapshot. V2+ snapshots restore full entities; V3 adds
 * current policy state and V4 pins adaptive-policy provenance. V1 snapshots restore scalars only and rely on
 * the caller to backfill messages from the journal (or full replay).
 */
export function restoreFromSnapshot(
  state: AgentState,
  snapshot: StateSnapshot,
): AgentState {
  const restored: AgentState = {
    ...state,
    iteration: snapshot.iteration,
    mode: snapshot.mode,
    recovery: {
      ...initialRecovery(),
      ...snapshot.recovery,
      replanCount: snapshot.recovery.replanCount ?? 0,
      consecutiveFailures: snapshot.recovery.consecutiveFailures ?? 0,
      versionConflicts: snapshot.recovery.versionConflicts ?? 0,
      replanning: snapshot.recovery.replanning ?? false,
      replanAwaitingApproval: snapshot.recovery.replanAwaitingApproval ?? false,
      degradedRecovery: snapshot.recovery.degradedRecovery ?? false,
      recentToolFingerprints: snapshot.recovery.recentToolFingerprints ?? [],
      recentOutcomeSignatures: snapshot.recovery.recentOutcomeSignatures ?? [],
      stagnationCount: snapshot.recovery.stagnationCount ?? 0,
      reflectionCount: snapshot.recovery.reflectionCount ?? 0,
      ineffectiveReflectionCount:
        snapshot.recovery.ineffectiveReflectionCount ?? 0,
      lastReflectionToolCalls: snapshot.recovery.lastReflectionToolCalls ?? 0,
      lastProgressToolCalls: snapshot.recovery.lastProgressToolCalls ?? 0,
      executionStrategy: snapshot.recovery.executionStrategy ?? 'normal',
    },
    budget: {
      ...state.budget,
      used: {
        ...state.budget.used,
        modelCalls: snapshot.budgetUsed.modelCalls,
        toolCalls: snapshot.budgetUsed.toolCalls,
        inputTokens: snapshot.budgetUsed.inputTokens,
        outputTokens: snapshot.budgetUsed.outputTokens,
      },
    },
    workspace: {
      root: state.workspace.root,
      touchedFiles: [...snapshot.workspace.touchedFiles],
      // Older V2 snapshots predate plan-scoped tracking. Treat their current
      // contents as the approval baseline rather than falsely locking writes.
      planScopedTouchedFiles: [
        ...(snapshot.workspace.planScopedTouchedFiles ?? []),
      ],
      createdFiles: [...snapshot.workspace.createdFiles],
      deletedFiles: [...snapshot.workspace.deletedFiles],
    },
    evidenceIds: [...snapshot.evidenceIds],
  }
  // only restore optional fields when present — keep key shape identical to
  // a full replay (which never creates undefined-valued keys)
  if (snapshot.prePlanMode) restored.prePlanMode = snapshot.prePlanMode
  if (snapshot.activePlan) restored.activePlan = snapshot.activePlan
  if (snapshot.lastTransition) restored.lastTransition = snapshot.lastTransition
  if (
    snapshot.version === 2 ||
    snapshot.version === 3 ||
    snapshot.version === 4
  ) {
    restored.messages = [...(snapshot.messages ?? [])]
    restored.pendingToolCalls = [...(snapshot.pendingToolCalls ?? [])]
    restored.toolResults = { ...(snapshot.toolResults ?? {}) }
    restored.reflections = [...(snapshot.reflections ?? [])]
    restored.reflectionEvaluations = [...(snapshot.reflectionEvaluations ?? [])]
    restored.tasks = [...(snapshot.tasks ?? [])]
    if (snapshot.latestPlanHealth) {
      if (!isSupervisorAction(snapshot.latestPlanHealth.decision?.action)) {
        throw new InvariantError(
          'plan_health_unknown_action',
          `unknown supervisor action in snapshot: ${String(snapshot.latestPlanHealth.decision?.action)}`,
        )
      }
      restored.latestPlanHealth = snapshot.latestPlanHealth
    }
    if (snapshot.lastVerification && snapshot.pendingVerificationRepair) {
      throw new InvariantError(
        'verification_snapshot_conflict',
        'snapshot cannot contain both a terminal verification and a pending repair',
      )
    }
    if (
      snapshot.lastVerification?.report.verdict === 'PASS' &&
      !snapshot.lastVerification.valid
    ) {
      throw new InvariantError(
        'verification_invalid_pass',
        'snapshot contains an invalid PASS verifier report',
      )
    }
    if (snapshot.pendingVerificationRepair) {
      const pending = snapshot.pendingVerificationRepair
      if (
        pending.report.verdict === 'PASS' ||
        !Number.isInteger(pending.attempt) ||
        pending.attempt < 1
      ) {
        throw new InvariantError(
          'verification_repair_invalid',
          'snapshot contains an invalid pending verifier repair',
        )
      }
    }
    if (snapshot.lastVerification) {
      restored.lastVerification = snapshot.lastVerification
    }
    if (snapshot.pendingVerificationRepair) {
      restored.pendingVerificationRepair = snapshot.pendingVerificationRepair
    }
    if (snapshot.version === 4 && snapshot.outcomeCalibrationSelection) {
      if (!isOutcomeCalibrationSelection(snapshot.outcomeCalibrationSelection)) {
        throw new InvariantError(
          'outcome_calibration_invalid_snapshot',
          'snapshot contains an invalid outcome calibration selection',
        )
      }
      restored.outcomeCalibrationSelection =
        freezeOutcomeCalibrationSelection(snapshot.outcomeCalibrationSelection)
    }
    for (const reflection of restored.reflections) {
      if (!validReflectionCalibration(restored, reflection)) {
        throw new InvariantError(
          'reflection_invalid_calibration_snapshot',
          `snapshot reflection ${reflection.id} has invalid calibration attribution`,
        )
      }
    }
  }
  return restored
}

function clonePlanHealth(assessment: PlanHealthAssessment): PlanHealthAssessment {
  return {
    ...assessment,
    plan: assessment.plan ? { ...assessment.plan } : undefined,
    metrics: { ...assessment.metrics },
    findings: [...assessment.findings],
    decision: {
      ...assessment.decision,
      successSignals: [...assessment.decision.successSignals],
    },
  }
}
