import type {
  ConversationMessage,
  ToolCall,
  ToolCallResult,
} from './messages.js'
import type { PlanTask, PlanVersion } from '../planning/types.js'
import type { EvidenceReceipt, VerificationReport } from '../verification/types.js'
import type { PromptManifest } from '../prompt/PromptAssembler.js'
import type { OutcomeCalibrationSelection } from '../planning/OutcomeCalibrationContract.js'

/** Named reasons for continuing the loop. No bare `continue` allowed. */
export type ContinueTransition =
  | { reason: 'tool_results_ready'; callCount: number }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'max_output_recovery'; attempt: number }
  | { reason: 'model_fallback'; from: string; to: string }
  | { reason: 'stop_hook_blocking'; attempt: number }
  | { reason: 'verification_repair'; attempt: number }
  | { reason: 'replan_required'; cause: string }
  | { reason: 'reflection_requested'; trigger: ReflectionRecord['trigger'] }
  | { reason: 'user_followup' }

/** Named reasons for terminating the run. No bare `return` allowed. */
export type TerminalReason =
  | { reason: 'completed' }
  | { reason: 'completed_with_unverified_items'; items: string[] }
  | { reason: 'awaiting_user'; requestId: string }
  | { reason: 'permission_denied'; callId: string }
  | { reason: 'aborted'; at: LoopPhase }
  | { reason: 'max_turns'; turns: number }
  | {
      reason: 'budget_exhausted'
      kind: 'model_calls' | 'tool_calls' | 'tokens' | 'cost' | 'time'
    }
  | { reason: 'prompt_too_long' }
  | { reason: 'model_error'; code: string }
  | { reason: 'invariant_violation'; invariant: string }

export type LoopPhase =
  | 'preparing_context'
  | 'calling_model'
  | 'assembling_response'
  | 'recovering'
  | 'executing_tools'
  | 'evaluating_completion'
  | 'verifying'
  | 'persisting'
  | 'terminated'

export type AgentMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions'

export type PermissionBehavior = 'allow' | 'ask' | 'deny'

export type ExecutionStrategy = 'normal' | 'conservative' | 'critical'

export const SUPERVISOR_ACTIONS = [
  'continue_step',
  'gather_evidence',
  'run_verification',
  'resolve_blocker',
  'repair_plan',
  'request_reapproval',
  'finish',
] as const

export type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number]

export function isSupervisorAction(value: unknown): value is SupervisorAction {
  return typeof value === 'string' &&
    (SUPERVISOR_ACTIONS as readonly string[]).includes(value)
}

export interface SupervisorDecision {
  action: SupervisorAction
  rationale: string
  targetTaskId?: string
  targetStepId?: string
  successSignals: string[]
}

export interface PlanHealthAssessment {
  id: string
  createdAt: string
  plan?: { planId: string; version: number }
  status: 'not_applicable' | 'healthy' | 'attention' | 'at_risk' | 'blocked'
  score: number
  /** stable signature excludes id/time and suppresses duplicate journal facts */
  signature: string
  metrics: {
    totalTasks: number
    completedTasks: number
    openTasks: number
    blockedTasks: number
    failedTasks: number
    readyTasks: number
    requiredCriteria: number
    coveredCriteria: number
    scopeDriftFiles: number
    budgetRemainingRatio: number
    consecutiveFailures: number
    stagnationSignals: number
    ineffectiveReflections: number
  }
  findings: string[]
  decision: SupervisorDecision
}

/**
 * Durable provenance for the tool capabilities shown to one model turn.
 * It records names and a canonical hash, never schemas or tool input data.
 */
export interface ToolLaneSelection {
  version: 1
  turnId: string
  assessmentSignature: string
  action: SupervisorAction
  lane: 'open' | 'evidence' | 'verification' | 'plan_repair' | 'approval' | 'finish'
  mode: AgentMode
  writeLocked: boolean
  replanning: boolean
  allowedTools: string[]
  blockedTools: string[]
  hash: string
}

export interface StagnationRecord {
  kind: 'repeated_call' | 'repeated_failure' | 'no_progress'
  signature: string
  score: number
  detail: string
}

export interface ReflectionRecord {
  id: string
  trigger: 'periodic' | 'stagnation' | 'replan' | 'verification' | 'completion'
  createdAt: string
  summary: string
  assumptions: string[]
  progress: {
    completedTasks: number
    totalTasks: number
    touchedFiles: number
    toolCalls: number
    /** v1.4 fact-level baseline used to evaluate reflection effectiveness */
    evidenceReceipts?: number
    successfulToolCalls?: number
  }
  evidenceGaps: string[]
  recommendation: string
  /** v1.4 bounded, machine-readable next action */
  decision?: SupervisorDecision & { evaluateAfterToolCalls: number }
  /** v1.8 durable attribution for a bounded historical window adjustment. */
  calibration?: {
    selectionHash: string
    profileHash: string
    baseWindow: number
    delta: -1 | 0 | 1
    calibratedWindow: number
  }
}

export interface ReflectionEvaluation {
  id: string
  reflectionId: string
  createdAt: string
  outcome: 'effective' | 'ineffective'
  toolCallsObserved: number
  progressSignals: string[]
  followUp: SupervisorDecision
}

export interface ModelAttemptFailure {
  code: string
  /** one-based physical gateway attempt number */
  attempt: number
  action: 'retry' | 'surface'
  delayMs: number
}

export type RuleSource =
  | 'managed'
  | 'user_settings'
  | 'project_settings'
  | 'session'
  | 'cli'

export type PermissionReason =
  | { type: 'hard_safety'; rule: string }
  | { type: 'user_rule'; ruleId: string; source: RuleSource }
  | { type: 'tool_policy'; code: string }
  | { type: 'mode'; mode: AgentMode }
  | { type: 'interactive_required' }
  | { type: 'default' }

export interface DecisionTraceStep {
  stage: string
  detail?: string
}

export interface PermissionDecision {
  id: string
  callId: string
  toolName: string
  behavior: PermissionBehavior
  reason: PermissionReason
  updatedInput?: unknown
  decidedAt: string
  trace: DecisionTraceStep[]
}

export interface CompactRecord {
  kind: 'micro' | 'auto' | 'reactive'
  clearedMessageIds: string[]
  /** replacement messages inserted at the position of the cleared range */
  replacements?: ConversationMessage[]
  summaryMessageId?: string
  tokensBefore: number
  tokensAfter: number
}

/** Payload of a transient tool progress event (live shell streaming). */
export interface ToolProgressData {
  stream: 'stdout' | 'stderr'
  text: string
  /** chars already dropped by rate limiting / per-call budget, if any */
  dropped?: number
}

/** Transient events: UI only, never persisted, never part of recovery. */
export type TransientEvent =
  | { type: 'model.delta'; turnId: string; text: string }
  | { type: 'model.thinking.delta'; turnId: string; text: string }
  | { type: 'tool.progress'; callId: string; data: ToolProgressData }
  | { type: 'status.changed'; phase: LoopPhase }
  | { type: 'prompt.manifest'; manifest: PromptManifest }

/** Fact events: must be persisted to the session journal. */
export type FactEvent =
  | { type: 'run.started'; runId: string; configHash: string }
  | { type: 'outcome.calibration.selected'; selection: OutcomeCalibrationSelection }
  | { type: 'user.message.accepted'; message: ConversationMessage }
  | {
      type: 'assistant.message.completed'
      message: ConversationMessage
      /** model usage of this call — reducer counts budget so full replay is exact */
      usage?: { inputTokens: number; outputTokens: number }
    }
  | { type: 'model.attempt.failed'; failure: ModelAttemptFailure }
  | { type: 'tool.call.accepted'; call: ToolCall }
  | { type: 'tool.call.completed'; result: ToolCallResult }
  | { type: 'tool.result.message'; message: ConversationMessage }
  | { type: 'permission.decided'; decision: PermissionDecision }
  | { type: 'mode.changed'; from: AgentMode; to: AgentMode; prePlanMode?: AgentMode }
  | { type: 'plan.version.created'; plan: PlanVersion }
  | { type: 'plan.approved'; planId: string; version: number; tokenId: string }
  /** replan protocol: the engine forced a replan; state enters `replanning` */
  | { type: 'replan.requested'; cause: string; requiresReapproval: boolean }
  /**
   * low-impact replan closure: the adjustment was applied and persisted
   * (no new plan version, no re-approval). Ends the `replanning` state.
   */
  | { type: 'replan.adjustment.applied'; cause: string; summary: string }
  | { type: 'loop.stagnation.detected'; record: StagnationRecord }
  | { type: 'reflection.recorded'; reflection: ReflectionRecord }
  | { type: 'reflection.evaluated'; evaluation: ReflectionEvaluation }
  | { type: 'plan.health.assessed'; assessment: PlanHealthAssessment }
  | { type: 'tool.lane.selected'; selection: ToolLaneSelection }
  | {
      type: 'strategy.adapted'
      from: ExecutionStrategy
      to: ExecutionStrategy
      reason: string
    }
  /** a persisted plan version left its previous status (reapproval replans supersede approved plans) */
  | { type: 'plan.status.changed'; planId: string; version: number; status: 'superseded' }
  | { type: 'task.changed'; task: PlanTask }
  | { type: 'evidence.recorded'; receipt: EvidenceReceipt }
  /**
   * idempotency adjudication audit (finish-list §1.4): the runtime resolved
   * a committed/uncertain side-effect record by inspecting external state.
   * Audit-only: carries no state transition.
   */
  | {
      type: 'idempotency.adjudicated'
      toolName: string
      callId: string
      from: string
      to: string
      detail: string
    }
  | {
      type: 'verification.completed'
      report: VerificationReport
      valid: boolean
      /**
       * When present, this same durable fact atomically opens the bounded
       * repair attempt. Recovery must not depend on a later transition fact.
       */
      repairAttempt?: number
    }
  | { type: 'context.compacted'; record: CompactRecord }
  | { type: 'loop.transitioned'; transition: ContinueTransition }
  | { type: 'run.terminated'; terminal: TerminalReason }
  /** periodic full state snapshot for fast recovery */
  | { type: 'state.snapshot'; snapshot: StateSnapshot }
  /** write tools changed the workspace (drives scope tracking / replan) */
  | {
      type: 'workspace.changed'
      path: string
      change: 'created' | 'modified' | 'deleted'
    }
  /**
   * degraded recovery provenance (finish-list §1.5): this session is a
   * recovery branch forked from a corrupt journal, which stays untouched.
   * Replaying this fact permanently restores the branch's read-only gate.
   */
  | {
      type: 'session.recovery.branch'
      fromSessionId: string
      /** first seq that could not be trusted in the source journal */
      failureSeq: number
      issues: string[]
    }

/**
 * A serializable snapshot of the full agent state at a point in time.
 * Recovery replays only the journal tail after the last snapshot.
 *
 * Version 2 introduced the complete state — full message
 * bodies, tool results, verification result and engine counters — so
 * recovery from a compatible snapshot is field-for-field equivalent to a full replay.
 * Version 3 adds policy-relevant plan scope, transition and pending verifier
 * repair fields. Version 4 adds the durable outcome-calibration selection.
 * Only V4 is used for snapshot-tail fast recovery; older
 * snapshots deliberately fall back to full replay.
 * Version 1 snapshots (message ids only) are still loadable but recovery
 * falls back to full replay when they are the only checkpoint.
 */
export interface StateSnapshot {
  /** snapshot schema version: V4 pins adaptive-policy provenance */
  version?: 1 | 2 | 3 | 4
  /** journal seq this snapshot was written after (V2+) */
  lastSeq?: number
  iteration: number
  mode: AgentMode
  prePlanMode?: Exclude<AgentMode, 'plan'>
  activePlan?: { planId: string; version: number; approved: boolean }
  recovery: {
    modelRetries: number
    compactFailures: number
    promptOverflowRecovered: boolean
    outputLimitRecoveries: number
    stopHookRetries: number
    verifierRepairs: number
    replanCount?: number
    consecutiveFailures?: number
    versionConflicts?: number
    replanning?: boolean
    replanAwaitingApproval?: boolean
    degradedRecovery?: boolean
    recentToolFingerprints?: string[]
    recentOutcomeSignatures?: string[]
    stagnationCount?: number
    lastStagnationSignature?: string
    reflectionCount?: number
    lastReflectionToolCalls?: number
    lastReflectionTrigger?: ReflectionRecord['trigger']
    ineffectiveReflectionCount?: number
    lastEvaluatedReflectionId?: string
    lastProgressToolCalls?: number
    executionStrategy?: ExecutionStrategy
  }
  budgetUsed: {
    modelCalls: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
  }
  workspace: {
    touchedFiles: string[]
    /** files changed since the current plan version was approved */
    planScopedTouchedFiles?: string[]
    createdFiles: string[]
    deletedFiles: string[]
  }
  /** V1: message ids in order (messages themselves are in the journal) */
  messageIds: string[]
  evidenceIds: string[]
  taskIds: string[]
  /** V2: full message bodies */
  messages?: ConversationMessage[]
  /** V2: tool calls accepted but not yet completed */
  pendingToolCalls?: ToolCall[]
  /** V2: every terminal tool result */
  toolResults?: Record<string, ToolCallResult>
  /** V3: latest named loop transition when it influences policy */
  lastTransition?: ContinueTransition
  /** V2+: latest independent verification outcome */
  lastVerification?: { report: VerificationReport; valid: boolean }
  /** V3: a durable verifier failure whose bounded repair is still open */
  pendingVerificationRepair?: { attempt: number; report: VerificationReport }
  /** V4: the one durable workspace-local outcome-calibration selection */
  outcomeCalibrationSelection?: OutcomeCalibrationSelection
  /** V2: bounded structured self-reflections */
  reflections?: ReflectionRecord[]
  /** v1.4: latest plan-health snapshot and bounded reflection outcomes */
  latestPlanHealth?: PlanHealthAssessment
  reflectionEvaluations?: ReflectionEvaluation[]
  /** v1.4 also closes the V2 task-restoration gap */
  tasks?: PlanTask[]
}

export type AgentEvent = TransientEvent | FactEvent

const FACT_TYPES = new Set<string>([
  'run.started',
  'outcome.calibration.selected',
  'user.message.accepted',
  'assistant.message.completed',
  'model.attempt.failed',
  'tool.call.accepted',
  'tool.call.completed',
  'tool.result.message',
  'permission.decided',
  'mode.changed',
  'plan.version.created',
  'plan.approved',
  'replan.requested',
  'replan.adjustment.applied',
  'loop.stagnation.detected',
  'reflection.recorded',
  'reflection.evaluated',
  'plan.health.assessed',
  'tool.lane.selected',
  'strategy.adapted',
  'plan.status.changed',
  'task.changed',
  'evidence.recorded',
  'idempotency.adjudicated',
  'verification.completed',
  'context.compacted',
  'loop.transitioned',
  'run.terminated',
  'state.snapshot',
  'workspace.changed',
  'session.recovery.branch',
])

export function isFactEvent(event: AgentEvent): event is FactEvent {
  return FACT_TYPES.has(event.type)
}
