import { join } from 'node:path'
import { AgentEngine } from '../core/AgentEngine.js'
import { createInitialState, restoreFromSnapshot, reduce, type AgentState } from '../core/state.js'
import { InvariantError } from '../core/messages.js'
import type { AgentMode, FactEvent } from '../core/events.js'
import type { ConversationMessage } from '../core/messages.js'
import { createIdGenerator, systemClock, type Clock, type IdGenerator } from '../core/runtimePrimitives.js'
import type { ModelGateway } from '../model/types.js'
import { createRetryPolicy } from '../model/retryPolicy.js'
import { ToolRegistry } from '../tools/ToolRegistry.js'
import { ToolRuntime } from '../tools/ToolRuntime.js'
import { ToolScheduler } from '../tools/ToolScheduler.js'
import { ToolOutputStore } from '../tools/ToolOutputStore.js'
import { PolicyEngine, type AskHandler, type PermissionRule } from '../policy/PolicyEngine.js'
import { SessionJournal, type JournalEnvelope } from '../session/SessionJournal.js'
import { loadSession, type LoadedSession } from '../session/SessionLoader.js'
import { ReadTool } from '../tools/builtin/ReadTool.js'
import { GlobTool } from '../tools/builtin/GlobTool.js'
import { GrepTool } from '../tools/builtin/GrepTool.js'
import { EditTool } from '../tools/builtin/EditTool.js'
import { WriteTool } from '../tools/builtin/WriteTool.js'
import { ShellTool, ShellReadOnlyTool } from '../tools/builtin/ShellTool.js'
import { ApplyPatchTool } from '../tools/builtin/ApplyPatchTool.js'
import { AskUserTool } from '../tools/builtin/AskUserTool.js'
import {
  DiffAssertTool,
  FileAssertTool,
  ManualVerifyTool,
} from '../tools/builtin/EvidenceAssertTools.js'
import {
  EnterPlanModeTool,
  ExitPlanModeTool,
  PlanRepairTool,
  PlanProposeTool,
} from '../planning/planTools.js'
import {
  TaskCreateTool,
  TaskListTool,
  TaskUpdateTool,
} from '../planning/taskTools.js'
import { PlanStore, ApprovalRegistry } from '../planning/PlanStore.js'
import { TaskStore } from '../planning/TaskStore.js'
import { EvidenceStore } from '../verification/EvidenceStore.js'
import { VerifierRunner } from '../verification/VerifierRunner.js'
import { ContextManager, type ContextBudgetConfig } from '../context/ContextManager.js'
import type { ToolServices } from '../tools/Tool.js'
import type { PlanVersion } from '../planning/types.js'
import type { ReplanConfig } from '../planning/ReplanDetector.js'
import { CodeIntelligenceService } from '../codeintel/CodeIntelligence.js'
import {
  CallGraphTool,
  CodeDiagnosticsTool,
  CodeSymbolsTool,
  FindReferencesTool,
} from '../tools/builtin/CodeIntelTools.js'
import { CodeRetriever } from '../retrieval/CodeRetriever.js'
import {
  CodeIndexStatusTool,
  ExpandCodeContextTool,
  RefreshCodeIndexTool,
  SearchCodeIndexTool,
} from '../tools/builtin/RetrievalTools.js'
import {
  freezeOutcomeCalibrationProfile,
  loadOutcomeCalibrationScan,
  type OutcomeCalibrationProfile,
  type OutcomeCalibrationScan,
} from '../planning/OutcomeCalibration.js'
import {
  buildOutcomeCalibrationSelection,
  freezeOutcomeCalibrationSelection,
  isOutcomeCalibrationSelection,
  type OutcomeCalibrationSelection,
} from '../planning/OutcomeCalibrationContract.js'

function calibrationSelectionFromLoaded(
  loaded: LoadedSession,
): OutcomeCalibrationSelection | undefined {
  let selected: OutcomeCalibrationSelection | undefined
  let selectedSeq: number | undefined
  for (const envelope of loaded.envelopes) {
    if (envelope.event.type !== 'outcome.calibration.selected') continue
    if (selected) {
      throw new InvariantError(
        'outcome_calibration_duplicate_selection',
        `duplicate outcome calibration selection at seq ${envelope.seq}`,
      )
    }
    if (!isOutcomeCalibrationSelection(envelope.event.selection)) {
      throw new InvariantError(
        'outcome_calibration_invalid_selection',
        `invalid outcome calibration selection at seq ${envelope.seq}`,
      )
    }
    selected = freezeOutcomeCalibrationSelection(envelope.event.selection)
    selectedSeq = envelope.seq
  }
  if (loaded.lastSnapshot?.version === 4) {
    const snapshotSelection = loaded.lastSnapshot.outcomeCalibrationSelection
    const snapshotEnvelope = [...loaded.envelopes]
      .reverse()
      .find(envelope => envelope.event.type === 'state.snapshot')
    const snapshotLastSeq = loaded.lastSnapshot.lastSeq ??
      (snapshotEnvelope ? snapshotEnvelope.seq - 1 : 0)
    const expectedHash =
      selectedSeq !== undefined && selectedSeq <= snapshotLastSeq
        ? selected?.hash
        : undefined
    if (
      (snapshotSelection && !isOutcomeCalibrationSelection(snapshotSelection)) ||
      snapshotSelection?.hash !== expectedHash
    ) {
      throw new InvariantError(
        'outcome_calibration_snapshot_mismatch',
        'V4 snapshot calibration selection does not match the journal selection fact',
      )
    }
  }
  return selected
}

export interface RuntimeConfig {
  workspaceRoot: string
  sessionId?: string
  mode?: AgentMode
  maxTurns?: number
  maxModelCalls?: number
  maxToolCalls?: number
  maxWallTimeMs?: number
  maxOutputTokens?: number
  projectInstructions?: string
  rules?: PermissionRule[]
  persist?: boolean
  /** M5: independent verification of high-risk completions */
  verification?: {
    enabled: boolean
    riskThreshold?: number
    maxRepairAttempts?: number
  }
  /** M6: layered context management */
  context?: Partial<ContextBudgetConfig> & { enabled?: boolean }
  /** v1.1 stagnation detection, staged reflection and adaptive budgeting */
  intelligence?: {
    enabled?: boolean
    reflectionInterval?: number
    reflectionEvaluationWindow?: number
    completionReflection?: boolean
    outcomeCalibrationEnabled?: boolean
    outcomeCalibrationMinSamples?: number
    outcomeCalibrationMaxSessions?: number
  }
  /** replan thresholds; useful for tuning local-repair sensitivity */
  replan?: Partial<ReplanConfig>
  /** v1.2 versioned hybrid repository retrieval */
  retrieval?: {
    enabled?: boolean
    refreshOnSearch?: boolean
    maxFiles?: number
    maxFileBytes?: number
    maxChunks?: number
    maxPerFile?: number
    diversityLambda?: number
  }
  /** hash of the effective merged config, recorded in run.started */
  configHash?: string
  /**
   * Degraded recovery branch (finish-list §1.5): load history from this
   * session's journal but write all new facts to the NEW session's own
   * journal, so the corrupt source journal stays untouched.
   */
  recoveryForkFrom?: string
}

export interface RuntimeChannels {
  /** interactive question channel for AskUser */
  askUser?: (input: { question: string; options?: string[] }) => Promise<string>
  /** human approval UI for ExitPlanMode */
  requestPlanApproval?: (plan: PlanVersion) => Promise<boolean>
}

export interface AgentRuntime {
  engine: AgentEngine
  registry: ToolRegistry
  policy: PolicyEngine
  toolRuntime: ToolRuntime
  journal: SessionJournal | null
  clock: Clock
  ids: IdGenerator
  sessionId: string
  runId: string
  artifactDir: string
  journalPath: string
  plans: PlanStore
  tasks: TaskStore
  evidence: EvidenceStore
  approvals: ApprovalRegistry
  contextManager?: ContextManager
  codeRetriever?: CodeRetriever
  model: { provider: string; modelId: string }
  /** Durable selection retained for replay/audit even when config disables its use. */
  outcomeCalibrationSelection?: OutcomeCalibrationSelection
  /** runtime gate for replans that require re-approval */
  setReplanApprovalPending(pending: boolean): void
  makeInitialState(
    now?: number,
    options?: { includeCalibrationSelection?: boolean },
  ): AgentState
  makeUserMessage(text: string, parentId: string | null): ConversationMessage
}

/**
 * Composition root. All external dependencies are injected here once;
 * no core module reads env vars or singletons.
 */
export async function createRuntime(input: {
  model: ModelGateway
  /**
   * Optional dedicated model for the verification subagent. Using a
   * different provider/model than the implementer reduces same-source
   * confirmation bias; falls back to the main model when absent.
   */
  verifierModel?: ModelGateway
  config: RuntimeConfig
  askHandler?: AskHandler
  channels?: RuntimeChannels
  clock?: Clock
  ids?: IdGenerator
  /** Tests/evaluators may inject a frozen profile instead of scanning disk. */
  outcomeCalibrationProfile?: OutcomeCalibrationProfile
}): Promise<{ runtime: AgentRuntime; loaded: LoadedSession | null }> {
  const clock = input.clock ?? systemClock
  const ids = input.ids ?? createIdGenerator()
  const config = input.config

  const sessionId = config.sessionId ?? ids.next('ses')
  const runId = ids.next('run')
  const sessionDir = join(config.workspaceRoot, '.agent', 'sessions', sessionId)
  const journalPath = join(sessionDir, 'journal.jsonl')

  // resume if requested and a journal exists. A degraded recovery branch
  // reads the SOURCE session's journal while writing to its own directory.
  let loaded: LoadedSession | null = null
  const loadFromPath = config.recoveryForkFrom
    ? join(config.workspaceRoot, '.agent', 'sessions', config.recoveryForkFrom, 'journal.jsonl')
    : journalPath
  if ((config.sessionId || config.recoveryForkFrom) && config.persist !== false) {
    loaded = await loadSession(loadFromPath)
  }
  const calibrationCutoff = loaded?.envelopes[0]?.timestamp ?? clock.isoNow()

  const journal =
    config.persist === false
      ? null
      : new SessionJournal({ filePath: journalPath, sessionId, runId, clock, ids })
  if (journal && loaded && !config.recoveryForkFrom) {
    journal.adopt(loaded.nextSeq, loaded.lastEventId)
  }
  const calibrationEnabled =
    config.intelligence?.enabled !== false &&
    config.intelligence?.outcomeCalibrationEnabled !== false
  const persistedCalibrationSelection =
    loaded && !config.recoveryForkFrom
      ? calibrationSelectionFromLoaded(loaded)
      : undefined
  let outcomeCalibrationSelection = persistedCalibrationSelection
  let outcomeCalibration: OutcomeCalibrationProfile | undefined
  if (persistedCalibrationSelection) {
    // Runtime config may suppress a pinned profile, but injected or newly
    // scanned history can never replace it during this session's lifetime.
    outcomeCalibration = calibrationEnabled
      ? persistedCalibrationSelection.profile
      : undefined
  } else if (calibrationEnabled) {
    let scan: OutcomeCalibrationScan | undefined
    if (input.outcomeCalibrationProfile) {
      outcomeCalibration = freezeOutcomeCalibrationProfile(
        input.outcomeCalibrationProfile,
      )
    } else if (config.persist !== false) {
      scan = await loadOutcomeCalibrationScan({
        workspaceRoot: config.workspaceRoot,
        currentSessionId: sessionId,
        config: {
          minSamples: config.intelligence?.outcomeCalibrationMinSamples,
          maxSessions: config.intelligence?.outcomeCalibrationMaxSessions,
          eligibleBefore: calibrationCutoff,
        },
      })
      outcomeCalibration = scan.profile
    }
    if (journal && outcomeCalibration) {
      outcomeCalibrationSelection = buildOutcomeCalibrationSelection({
        origin: input.outcomeCalibrationProfile
          ? 'test_injected'
          : loaded && loaded.envelopes.length > 0
            ? 'legacy_backfill'
            : 'history_scan',
        scanStatus: input.outcomeCalibrationProfile
          ? 'complete'
          : scan?.scanStatus ?? 'history_unavailable',
        eligibleBefore: calibrationCutoff,
        sources: scan?.sources,
        profile: outcomeCalibration,
      })
    }
  }

  // Every run start is a fact bound to the effective config hash. Calibration
  // is frozen before this append so the current boot cannot become history.
  if (journal) {
    await journal.append(
      { type: 'run.started', runId, configHash: config.configHash ?? 'unhashed' },
      'boot',
      'flush',
    )
    if (!persistedCalibrationSelection && outcomeCalibrationSelection) {
      await journal.append(
        {
          type: 'outcome.calibration.selected',
          selection: outcomeCalibrationSelection,
        },
        'boot',
        'flush',
      )
    }
  }

  const registry = new ToolRegistry()
  registry.register(ReadTool)
  registry.register(GlobTool)
  registry.register(GrepTool)
  registry.register(EditTool)
  registry.register(WriteTool)
  registry.register(ShellTool)
  registry.register(ShellReadOnlyTool)
  registry.register(ApplyPatchTool)
  registry.register(AskUserTool)
  registry.register(FileAssertTool)
  registry.register(DiffAssertTool)
  registry.register(ManualVerifyTool)
  registry.register(CodeSymbolsTool)
  registry.register(FindReferencesTool)
  registry.register(CallGraphTool)
  registry.register(CodeDiagnosticsTool)
  if (config.retrieval?.enabled !== false) {
    registry.register(SearchCodeIndexTool)
    registry.register(ExpandCodeContextTool)
    registry.register(RefreshCodeIndexTool)
    registry.register(CodeIndexStatusTool)
  }

  registry.register(EnterPlanModeTool)
  registry.register(PlanProposeTool)
  registry.register(PlanRepairTool)
  registry.register(ExitPlanModeTool)
  registry.register(TaskCreateTool)
  registry.register(TaskUpdateTool)
  registry.register(TaskListTool)

  const policy = new PolicyEngine({
    clock,
    ids,
    rules: config.rules,
    askHandler: input.askHandler,
  })

  // planning / evidence stores (M4/M5)
  const plans = new PlanStore({
    artifactDir: sessionDir,
    clock,
    ids,
    persist: config.persist !== false,
  })
  const approvals = new ApprovalRegistry({ clock })
  const tasks = new TaskStore({ clock, ids })
  const evidence = new EvidenceStore({
    sessionId,
    runId,
    artifactDir: sessionDir,
    clock,
    ids,
    persist: config.persist !== false,
    workspaceRoot: config.workspaceRoot,
  })
  const codeIntelligence = new CodeIntelligenceService(config.workspaceRoot)
  const codeRetriever = config.retrieval?.enabled === false
    ? undefined
    : new CodeRetriever(config.workspaceRoot, {
        persistence: config.persist !== false,
        refreshOnSearch: config.retrieval?.refreshOnSearch,
        maxFiles: config.retrieval?.maxFiles,
        maxFileBytes: config.retrieval?.maxFileBytes,
        maxChunks: config.retrieval?.maxChunks,
        defaultMaxPerFile: config.retrieval?.maxPerFile,
        diversityLambda: config.retrieval?.diversityLambda,
        now: () => clock.now(),
      })

  // Durable engine state drives these runtime capability gates each loop.
  let replanApprovalPending = false
  let localPlanRepairPending = false

  const services: ToolServices = {
    plans,
    approvals,
    tasks,
    evidence,
    codeIntelligence,
    codeRetriever,
    canLocalPlanRepair: () => localPlanRepairPending,
    askUser: input.channels?.askUser,
    requestPlanApproval: input.channels?.requestPlanApproval,
  }

  const outputStore = new ToolOutputStore(sessionDir)
  // replan re-approval gate: while a risky replan awaits human approval,
  // write tools are refused here AND removed from the model-facing schema
  const toolRuntime = new ToolRuntime({
    registry,
    policy,
    outputStore,
    clock,
    ids,
    services,
    artifactDir: sessionDir,
    writeLock: () => replanApprovalPending,
  })
  const scheduler = new ToolScheduler(registry)

  // M6 context manager
  const contextManager =
    config.context?.enabled === false
      ? undefined
      : new ContextManager({
          model: input.model,
          clock,
          ids,
          config: config.context,
        })

  // M5 verifier (may run on an independent model to avoid same-source bias)
  const verifier =
    config.verification?.enabled === false
      ? undefined
      : new VerifierRunner({
          model: input.verifierModel ?? input.model,
          evidence,
          clock,
          ids,
          workspaceRoot: config.workspaceRoot,
          artifactDir: sessionDir,
        })

  const engine = new AgentEngine({
    model: input.model,
    registry,
    toolRuntime,
    scheduler,
    retryPolicy: createRetryPolicy(),
    journal,
    clock,
    ids,
    outcomeCalibration: journal ? undefined : outcomeCalibration,
    outcomeCalibrationEnabled: calibrationEnabled,
    context: contextManager,
    gate: {
      plans,
      tasks,
      evidence,
      riskThreshold: config.verification?.riskThreshold ?? 5,
    },
    verifier,
    onWriteGateChange: pending => {
      replanApprovalPending = pending
    },
    onLocalPlanRepairChange: pending => {
      localPlanRepairPending = pending
    },
    config: {
      maxOutputTokens: config.maxOutputTokens ?? 4096,
      artifactDir: sessionDir,
      projectInstructions: config.projectInstructions,
      maxRepairAttempts: config.verification?.maxRepairAttempts ?? 1,
      intelligence: {
        enabled: config.intelligence?.enabled ?? true,
        reflectionInterval: config.intelligence?.reflectionInterval ?? 8,
        reflectionEvaluationWindow:
          config.intelligence?.reflectionEvaluationWindow ?? 3,
        // Opt-in because it deliberately consumes one extra model turn.
        // Periodic/stagnation/replan/verification reflection remains enabled.
        completionReflection: config.intelligence?.completionReflection ?? false,
      },
      replan: config.replan,
      // composition root is the only place allowed to read process state
      environment: {
        provider: input.model.provider,
        modelId: input.model.modelId,
        platform: process.platform,
        shell:
          process.platform === 'win32'
            ? 'cmd.exe'
            : process.env.SHELL ?? '/bin/sh',
        workspaceRoot: config.workspaceRoot,
        today: new Date(clock.now()).toISOString().slice(0, 10),
      },
    },
  })

  const runtime: AgentRuntime = {
    engine,
    registry,
    policy,
    toolRuntime,
    journal,
    clock,
    ids,
    sessionId,
    runId,
    artifactDir: sessionDir,
    journalPath,
    plans,
    tasks,
    evidence,
    approvals,
    contextManager,
    codeRetriever,
    model: { provider: input.model.provider, modelId: input.model.modelId },
    outcomeCalibrationSelection,
    setReplanApprovalPending(pending: boolean) {
      replanApprovalPending = pending
    },
    makeInitialState(
      now = clock.now(),
      options?: { includeCalibrationSelection?: boolean },
    ): AgentState {
      let state = createInitialState({
        sessionId,
        runId,
        turnId: ids.next('turn'),
        workspaceRoot: config.workspaceRoot,
        mode: config.mode,
        budget: {
          maxTurns: config.maxTurns ?? 40,
          maxModelCalls: config.maxModelCalls ?? 60,
          maxToolCalls: config.maxToolCalls ?? 200,
          maxWallTimeMs: config.maxWallTimeMs ?? 30 * 60_000,
        },
        now,
      })
      if (
        outcomeCalibrationSelection &&
        options?.includeCalibrationSelection !== false
      ) {
        state = reduce(state, {
          type: 'outcome.calibration.selected',
          selection: outcomeCalibrationSelection,
        })
      }
      return state
    },
    makeUserMessage(text: string, parentId: string | null): ConversationMessage {
      return {
        id: ids.next('msg'),
        parentId,
        sessionId,
        turnId: ids.next('turn'),
        role: 'user',
        content: [{ type: 'text', text }],
        createdAt: clock.isoNow(),
        meta: { source: 'human' },
      }
    },
  }

  return { runtime, loaded }
}

/**
 * Diagnostic report for a reducer failure during recovery replay.
 * Replay never silently breaks: the caller receives the exact failing
 * position, the invariant name, the last trusted seq and whether a
 * degraded continuation was applied.
 */
export interface ReplayFailure {
  seq: number
  eventId: string
  invariant: string
  message: string
  /** last envelope seq that reduced cleanly */
  lastTrustedSeq: number
  /** true = the bad event was skipped and replay continued */
  allowDegraded: boolean
}

/**
 * Replay a run of journal envelopes through the reducer. Events that are
 * recovery no-ops (run.started, state.snapshot) are skipped. On invariant
 * violation the behavior depends on the mode:
 * - strict (default): replay STOPS at the failing event; the recovered state
 *   is exactly the state at lastTrustedSeq and the failure is reported.
 * - degraded: only the offending event is skipped and replay continues, so
 *   recovery stays available — but the failure is always reported.
 */
function replayEnvelopes(
  state: AgentState,
  envelopes: JournalEnvelope[],
  degraded: boolean,
): { state: AgentState; failure: ReplayFailure | null } {
  let failure: ReplayFailure | null = null
  let lastTrustedSeq = 0
  for (const envelope of envelopes) {
    const event = envelope.event as FactEvent
    if (event.type === 'run.started') continue // new runId wins
    if (event.type === 'state.snapshot') continue // checkpoint, no-op
    try {
      state = reduce(state, event)
      lastTrustedSeq = envelope.seq
    } catch (error) {
      failure = {
        seq: envelope.seq,
        eventId: envelope.eventId,
        invariant:
          error instanceof InvariantError ? error.invariant : 'reducer_error',
        message: (error as Error).message,
        lastTrustedSeq,
        allowDegraded: degraded,
      }
      if (!degraded) break // strict: refuse to replay past a corrupt fact
      // degraded continuation: skip only the offending event
    }
  }
  return { state, failure }
}

export interface ResumeOptions {
  /**
   * true = skip corrupt facts and continue (explicit user choice only);
   * false/omitted = strict: stop at the first failure, refuse to continue.
   */
  degraded?: boolean
}

/**
 * Resume helper. Two deterministic recovery paths:
 * - V4 snapshot present: restore full entities, policy state and calibration provenance, then replay envelopes after
 *   snapshot.lastSeq through the reducer.
 * - No V4 snapshot (including legacy V1/V2/V3): FULL replay — every FactEvent goes through the reducer
 *   (never just the loader's message list).
 * Orphan tool calls are closed with synthetic INTERRUPTED_DURING_PREVIOUS_RUN
 * results. Returns recovered state, recovery facts and any replay failure.
 */
export async function resumeState(
  runtime: AgentRuntime,
  loaded: LoadedSession,
  options?: ResumeOptions,
): Promise<{
  state: AgentState
  recoveryFacts: FactEvent[]
  replayFailure: ReplayFailure | null
}> {
  let state = runtime.makeInitialState(undefined, {
    includeCalibrationSelection: false,
  })
  const degraded = options?.degraded === true

  // load idempotency ledger so re-execution can be skipped
  await runtime.toolRuntime.idempotency.load()

  let replayFailure: ReplayFailure | null = null
  const snapshot = loaded.lastSnapshot

  if (snapshot?.version === 4) {
    // Phase 1a: V4 restores full entities, policy state and the pinned
    // calibration selection; the tail replays through the reducer.
    // replays through the reducer.
    state = restoreFromSnapshot(state, snapshot)
    const tail =
      typeof snapshot.lastSeq === 'number'
        ? loaded.envelopes.filter(e => e.seq > snapshot.lastSeq!)
        : loaded.envelopes.slice(loaded.tailStartIndex)
    const replayed = replayEnvelopes(state, tail, degraded)
    state = replayed.state
    replayFailure = replayed.failure
  } else {
    // Phase 1b: no V4 checkpoint -> full deterministic replay of every fact
    const replayed = replayEnvelopes(state, loaded.envelopes, degraded)
    state = replayed.state
    replayFailure = replayed.failure
  }

  // A legacy journal may have received its first selection during this boot,
  // after `loaded` was captured. Apply that already-durable fact to the
  // recovered state; existing v1.8 journals must match the pinned hash.
  if (runtime.outcomeCalibrationSelection) {
    if (!state.outcomeCalibrationSelection) {
      state = reduce(state, {
        type: 'outcome.calibration.selected',
        selection: runtime.outcomeCalibrationSelection,
      })
    } else if (
      state.outcomeCalibrationSelection.hash !==
      runtime.outcomeCalibrationSelection.hash
    ) {
      throw new InvariantError(
        'outcome_calibration_runtime_mismatch',
        'runtime and recovered outcome calibration selections disagree',
      )
    }
  }

  // restore the context circuit breaker from recovered state
  runtime.contextManager?.restoreFailures(state.recovery.compactFailures)

  // Phase 2: restore stores from journal snapshots (tasks, evidence, plans)
  for (const task of loaded.tasks) {
    runtime.tasks.restore(task)
    if (!state.tasks.some(t => t.id === task.id)) {
      state = { ...state, tasks: [...state.tasks, task] }
    }
  }
  for (const receipt of loaded.evidence) {
    runtime.evidence.restore(receipt)
    if (!state.evidenceIds.includes(receipt.id)) {
      state = { ...state, evidenceIds: [...state.evidenceIds, receipt.id] }
    }
  }
  // restore plan store
  for (const plan of loaded.plans) {
    runtime.plans.restore(plan)
  }

  // restore the workspace revision counter from the journal so freshness
  // judgments after recovery match the pre-crash view (finish-list §1.6)
  let workspaceRevision = 0
  const changedPaths: string[] = []
  for (const envelope of loaded.envelopes) {
    const event = envelope.event as FactEvent
    if (event.type === 'workspace.changed') {
      workspaceRevision += 1
      changedPaths.push(event.path)
    }
  }
  runtime.evidence.setWorkspaceRevision(workspaceRevision, changedPaths)

  // Phase 3: close accepted orphans and repair the smaller crash window where
  // tool.call.completed was durable but its provider-facing result message
  // was not. One recovery message covers both sets without duplicating a
  // terminal tool result fact.
  const recoveryFacts: FactEvent[] = []
  const recoveryBlocks: Array<
    Extract<ConversationMessage['content'][number], { type: 'tool_result' }>
  > = []

  if (loaded.openToolCalls.length > 0) {
    for (const call of loaded.openToolCalls) {
      // The loader may have reconstructed this call from a durable assistant
      // tool_call block when the crash happened before its individual
      // acceptance fact. Restore the missing lifecycle edge before closing
      // it; recovery never executes the call.
      if (
        !state.pendingToolCalls.some(pending => pending.id === call.id) &&
        state.toolResults[call.id] === undefined
      ) {
        recoveryFacts.push({ type: 'tool.call.accepted', call })
      }
      const fact: FactEvent = {
        type: 'tool.call.completed',
        result: {
          callId: call.id,
          toolName: call.name,
          ok: false,
          content: { kind: 'text', text: 'INTERRUPTED_DURING_PREVIOUS_RUN' },
          errorCode: 'INTERRUPTED_DURING_PREVIOUS_RUN',
          durationMs: 0,
          synthetic: true,
        },
      }
      recoveryFacts.push(fact)
      recoveryBlocks.push({
        type: 'tool_result',
        callId: call.id,
        ok: false,
        content: {
          kind: 'text',
          text: 'INTERRUPTED_DURING_PREVIOUS_RUN: this tool call did not complete. ' +
            'If it may have had side effects, inspect current state before retrying.',
        },
        errorCode: 'INTERRUPTED_DURING_PREVIOUS_RUN',
      })
    }
  }

  for (const result of loaded.unmessagedResults) {
    recoveryBlocks.push({
      type: 'tool_result',
      callId: result.callId,
      ok: result.ok,
      content: result.content,
      errorCode: result.errorCode,
      observation: result.observation,
    })
  }

  if (recoveryBlocks.length > 0) {
    const message: ConversationMessage = {
      id: runtime.ids.next('msg'),
      parentId:
        state.messages.length > 0
          ? state.messages[state.messages.length - 1]!.id
          : null,
      sessionId: runtime.sessionId,
      turnId: state.turnId,
      role: 'user',
      content: recoveryBlocks,
      createdAt: runtime.clock.isoNow(),
      meta: { source: 'recovery', synthetic: true },
    }
    const messageFact: FactEvent = { type: 'tool.result.message', message }
    recoveryFacts.push(messageFact)
  }

  // Apply recovery facts through the reducer so pendingToolCalls,
  // toolResults and messages stay consistent on both recovery paths.
  for (const fact of recoveryFacts) {
    state = reduce(state, fact)
  }

  if (runtime.journal) {
    for (const fact of recoveryFacts) {
      await runtime.journal.append(fact, state.turnId, 'flush')
    }
  }

  return { state, recoveryFacts, replayFailure }
}
