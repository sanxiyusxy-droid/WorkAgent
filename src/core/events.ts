import type {
  ConversationMessage,
  ToolCall,
  ToolCallResult,
} from './messages.js'
import type { PlanTask, PlanVersion } from '../planning/types.js'
import type { EvidenceReceipt, VerificationReport } from '../verification/types.js'
import type { PromptManifest } from '../prompt/PromptAssembler.js'

/** Named reasons for continuing the loop. No bare `continue` allowed. */
export type ContinueTransition =
  | { reason: 'tool_results_ready'; callCount: number }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'max_output_recovery'; attempt: number }
  | { reason: 'model_fallback'; from: string; to: string }
  | { reason: 'stop_hook_blocking'; attempt: number }
  | { reason: 'verification_repair'; attempt: number }
  | { reason: 'replan_required'; cause: string }
  | { reason: 'user_followup' }

/** Named reasons for terminating the run. No bare `return` allowed. */
export type TerminalReason =
  | { reason: 'completed' }
  | { reason: 'completed_with_unverified_items'; items: string[] }
  | { reason: 'awaiting_user'; requestId: string }
  | { reason: 'permission_denied'; callId: string }
  | { reason: 'aborted'; at: LoopPhase }
  | { reason: 'max_turns'; turns: number }
  | { reason: 'budget_exhausted'; kind: 'tokens' | 'cost' | 'time' }
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
  | { type: 'user.message.accepted'; message: ConversationMessage }
  | {
      type: 'assistant.message.completed'
      message: ConversationMessage
      /** model usage of this call — reducer counts budget so full replay is exact */
      usage?: { inputTokens: number; outputTokens: number }
    }
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
  | { type: 'verification.completed'; report: VerificationReport; valid: boolean }
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
   * Audit-only: carries no state transition.
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
 * version 2 (StateSnapshotV2) carries the complete state — full message
 * bodies, tool results, verification result and engine counters — so
 * recovery from a snapshot is field-for-field equivalent to a full replay.
 * Version 1 snapshots (message ids only) are still loadable but recovery
 * falls back to full replay when they are the only checkpoint.
 */
export interface StateSnapshot {
  /** snapshot schema version: 1 = ids only, 2 = full entities */
  version?: 1 | 2
  /** journal seq this snapshot was written after (V2) */
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
  }
  budgetUsed: {
    modelCalls: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
  }
  workspace: {
    touchedFiles: string[]
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
  /** V2: latest independent verification outcome */
  lastVerification?: { report: VerificationReport; valid: boolean }
}

export type AgentEvent = TransientEvent | FactEvent

const FACT_TYPES = new Set<string>([
  'run.started',
  'user.message.accepted',
  'assistant.message.completed',
  'tool.call.accepted',
  'tool.call.completed',
  'tool.result.message',
  'permission.decided',
  'mode.changed',
  'plan.version.created',
  'plan.approved',
  'replan.requested',
  'replan.adjustment.applied',
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
