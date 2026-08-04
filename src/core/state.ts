import type { ConversationMessage, ToolCall, ToolCallResult } from './messages.js'
import type {
  AgentMode,
  ContinueTransition,
  FactEvent,
  LoopPhase,
  StateSnapshot,
} from './events.js'
import type { PlanTask } from '../planning/types.js'
import type { VerificationReport } from '../verification/types.js'
import { InvariantError } from './messages.js'

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
  /** explicit replanning state: set by replan.requested, cleared by plan.approved */
  replanning: boolean
  /** the pending replan needs human re-approval → write tools stay disabled */
  replanAwaitingApproval: boolean
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

  workspace: {
    root: string
    touchedFiles: string[]
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
    workspace: {
      root: input.workspaceRoot,
      touchedFiles: [],
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

/**
 * The only place where fact events mutate agent state.
 * Raw model responses are never modified in place; reducers always
 * return new objects.
 */
export function reduce(state: AgentState, event: FactEvent): AgentState {
  switch (event.type) {
    case 'run.started':
      return { ...state, runId: event.runId }

    case 'user.message.accepted':
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

    case 'tool.call.accepted': {
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
        }
      }
      return {
        ...state,
        pendingToolCalls: [...state.pendingToolCalls, event.call],
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
      return {
        ...state,
        activePlan: { ...state.activePlan, approved: true },
        // approving the new plan version ends the replanning state and
        // releases the runtime write gate
        recovery: {
          ...state.recovery,
          replanning: false,
          replanAwaitingApproval: false,
        },
      }
    }

    case 'replan.requested':
      // the reducer owns replan bookkeeping so full replay reproduces it
      return {
        ...state,
        recovery: {
          ...state.recovery,
          replanning: true,
          replanAwaitingApproval: event.requiresReapproval,
          replanCount: state.recovery.replanCount + 1,
          consecutiveFailures: 0,
          versionConflicts: 0,
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
      return { ...state, tasks }
    }

    case 'evidence.recorded':
      return { ...state, evidenceIds: [...state.evidenceIds, event.receipt.id] }

    case 'verification.completed':
      return {
        ...state,
        lastVerification: { report: event.report, valid: event.valid },
      }

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

    case 'loop.transitioned':
      return {
        ...state,
        iteration: state.iteration + 1,
        lastTransition: event.transition,
      }

    case 'run.terminated':
      return { ...state, phase: 'terminated' }

    case 'state.snapshot':
      // snapshots are recovery checkpoints; they don't change live state
      return state

    case 'workspace.changed': {
      // maintain touched/created/deleted sets from write-tool facts
      const { path, change } = event
      const touched = pushUnique(state.workspace.touchedFiles, path)
      if (change === 'created') {
        return {
          ...state,
          workspace: {
            ...state.workspace,
            touchedFiles: touched,
            createdFiles: pushUnique(state.workspace.createdFiles, path),
            deletedFiles: state.workspace.deletedFiles.filter(p => p !== path),
          },
        }
      }
      if (change === 'deleted') {
        return {
          ...state,
          workspace: {
            ...state.workspace,
            touchedFiles: touched,
            deletedFiles: pushUnique(state.workspace.deletedFiles, path),
          },
        }
      }
      return {
        ...state,
        workspace: { ...state.workspace, touchedFiles: touched },
      }
    }
  }
}

export function applyFacts(state: AgentState, facts: FactEvent[]): AgentState {
  let next = state
  for (const fact of facts) next = reduce(next, fact)
  return next
}

/**
 * Create a serializable V2 snapshot of the current state: every field needed
 * to continue the run, including full message bodies and tool results.
 * Recovery from a V2 snapshot + tail replay must be field-for-field
 * equivalent to a full journal replay.
 */
export function createSnapshot(state: AgentState, lastSeq?: number): StateSnapshot {
  return {
    version: 2,
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
      createdFiles: [...state.workspace.createdFiles],
      deletedFiles: [...state.workspace.deletedFiles],
    },
    messageIds: state.messages.map(m => m.id),
    evidenceIds: [...state.evidenceIds],
    taskIds: state.tasks.map(t => t.id),
    messages: state.messages.map(m => ({ ...m, content: [...m.content] })),
    pendingToolCalls: state.pendingToolCalls.map(c => ({ ...c })),
    toolResults: { ...state.toolResults },
    lastVerification: state.lastVerification
      ? { report: state.lastVerification.report, valid: state.lastVerification.valid }
      : undefined,
  }
}

/**
 * Restore state from a snapshot. V2 snapshots restore everything, including
 * messages and tool results; V1 snapshots restore scalars only and rely on
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
      createdFiles: [...snapshot.workspace.createdFiles],
      deletedFiles: [...snapshot.workspace.deletedFiles],
    },
    evidenceIds: [...snapshot.evidenceIds],
  }
  // only restore optional fields when present — keep key shape identical to
  // a full replay (which never creates undefined-valued keys)
  if (snapshot.prePlanMode) restored.prePlanMode = snapshot.prePlanMode
  if (snapshot.activePlan) restored.activePlan = snapshot.activePlan
  if (snapshot.version === 2) {
    restored.messages = [...(snapshot.messages ?? [])]
    restored.pendingToolCalls = [...(snapshot.pendingToolCalls ?? [])]
    restored.toolResults = { ...(snapshot.toolResults ?? {}) }
    if (snapshot.lastVerification) {
      restored.lastVerification = snapshot.lastVerification
    }
  }
  return restored
}
