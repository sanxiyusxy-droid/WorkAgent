import type { AgentEvent, FactEvent, TerminalReason, ContinueTransition, LoopPhase } from './events.js'
import { isFactEvent } from './events.js'
import type { AgentState } from './state.js'
import { reduce, createSnapshot } from './state.js'
import type { ContentBlock, ConversationMessage, ToolCall, ToolCallResult } from './messages.js'
import { InvariantError } from './messages.js'
import type { ModelGateway, ModelError } from '../model/types.js'
import { StreamAssembler, type AssembledTurn } from '../model/StreamAssembler.js'
import type { RetryPolicy } from '../model/retryPolicy.js'
import type { ToolRegistry } from '../tools/ToolRegistry.js'
import type { ToolRuntime } from '../tools/ToolRuntime.js'
import { ToolScheduler, type ScheduledCall } from '../tools/ToolScheduler.js'
import { ToolCallLedger } from '../tools/ToolCallLedger.js'
import { AsyncQueue, mergeTransient } from './asyncQueue.js'
import { assemblePrompt, buildPromptManifest, type EnvironmentInfo } from '../prompt/PromptAssembler.js'
import type { SessionJournal } from '../session/SessionJournal.js'
import type { Clock, IdGenerator } from './runtimePrimitives.js'
import type { ContextManager } from '../context/ContextManager.js'
import type { PlanStore } from '../planning/PlanStore.js'
import type { TaskStore } from '../planning/TaskStore.js'
import type { EvidenceStore } from '../verification/EvidenceStore.js'
import type { VerifierRunner } from '../verification/VerifierRunner.js'
import { evaluateCompletion } from '../planning/completionGate.js'
import {
  detectReplanTrigger,
  checkPlanConstraints,
  type ReplanConfig,
  type ReplanDecision,
} from '../planning/ReplanDetector.js'

export interface EngineDeps {
  model: ModelGateway
  registry: ToolRegistry
  toolRuntime: ToolRuntime
  scheduler: ToolScheduler
  retryPolicy: RetryPolicy
  journal: SessionJournal | null
  clock: Clock
  ids: IdGenerator
  /** M6 layered context manager; optional for lean setups */
  context?: ContextManager
  /** M5 completion gate dependencies; gate is skipped when absent */
  gate?: {
    plans?: PlanStore
    tasks?: TaskStore
    evidence?: EvidenceStore
    riskThreshold: number
  }
  /** M5 read-only verification agent */
  verifier?: VerifierRunner
  /** runtime write gate for replans awaiting re-approval; the schema
   * projection closes too (registry.availableFor writeLocked) */
  onWriteGateChange?: (pending: boolean) => void
  config: {
    maxOutputTokens: number
    artifactDir: string
    projectInstructions?: string
    /** identity + platform facts injected into the system prompt */
    environment?: EnvironmentInfo
    /** bounded auto-repair after verifier FAIL (default 1) */
    maxRepairAttempts?: number
    /** replan trigger configuration */
    replan?: Partial<ReplanConfig>
  }
  sleep?: (ms: number) => Promise<void>
}

type ModelTurnOutcome =
  | { kind: 'assembled'; turn: AssembledTurn }
  | { kind: 'fatal'; terminal: TerminalReason }

const defaultSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * The agent main loop. Orchestration only — model turn collection, tool
 * batches and persistence are delegated. Every continue produces a named
 * loop.transitioned fact; every exit produces run.terminated.
 */
export class AgentEngine {
  constructor(private readonly d: EngineDeps) {}

  async *run(
    initial: AgentState,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, TerminalReason> {
    let state = initial
    // constraint hints are soft and emitted at most once per engine instance
    let constraintHintEmitted = false

    try {
      while (true) {
        // ---- preflight: cancellation, turns, budget ----
        const preflight = this.checkPreflight(state, signal)
        if (preflight) {
          return yield* this.terminate(state, preflight)
        }

        // sync the runtime write gate from durable state every iteration —
        // this also restores the lock automatically after recovery
        this.d.onWriteGateChange?.(
          state.recovery.replanning && state.recovery.replanAwaitingApproval,
        )

        state = { ...state, phase: 'preparing_context' }
        yield { type: 'status.changed', phase: state.phase }

        // ---- layered context management (L1 micro / L3 auto, circuit-broken) ----
        if (this.d.context) {
          const prepared = await this.d.context.prepare({
            messages: state.messages,
            sessionId: state.sessionId,
            turnId: state.turnId,
          })
          for (const fact of prepared.facts) {
            yield fact
            state = yield* this.persistAndReduce(state, fact, 'buffered')
          }
        }

        const writeLocked =
          state.recovery.replanning && state.recovery.replanAwaitingApproval
        const request = assemblePrompt({
          mode: state.mode,
          messages: state.messages,
          tools: this.d.registry.availableFor(state.mode, { writeLocked }),
          maxOutputTokens: this.d.config.maxOutputTokens,
          projectInstructions: this.d.config.projectInstructions,
          environment: this.d.config.environment,
        })

        // transient debugging record of what will be sent (never journaled)
        yield {
          type: 'prompt.manifest',
          manifest: buildPromptManifest({
            model: this.d.model.modelId,
            mode: state.mode,
            request,
          }),
        }

        // ---- model call with bounded retry ----
        state = { ...state, phase: 'calling_model' }
        yield { type: 'status.changed', phase: state.phase }

        const outcome = yield* this.collectModelTurn(state, request, signal)
        if (outcome.kind === 'fatal') {
          // ---- reactive compact: exactly one recovery for PROMPT_TOO_LONG ----
          if (
            outcome.terminal.reason === 'prompt_too_long' &&
            this.d.context &&
            !state.recovery.promptOverflowRecovered
          ) {
            const compacted = await this.d.context.reactiveCompact({
              messages: state.messages,
              sessionId: state.sessionId,
              turnId: state.turnId,
            })
            for (const fact of compacted.facts) {
              yield fact
              state = yield* this.persistAndReduce(state, fact, 'buffered')
            }
            state = {
              ...state,
              recovery: { ...state.recovery, promptOverflowRecovered: true },
            }
            const transitionFact: FactEvent = {
              type: 'loop.transitioned',
              transition: { reason: 'reactive_compact_retry' },
            }
            yield transitionFact
            state = yield* this.persistAndReduce(state, transitionFact, 'buffered')
            continue
          }
          return yield* this.terminate(state, outcome.terminal)
        }

        const { turn } = outcome
        // budget accounting happens in the reducer (assistant.message.completed
        // carries usage) so full journal replay stays field-for-field exact
        const assistantFact: FactEvent = {
          type: 'assistant.message.completed',
          message: turn.message,
          usage: turn.usage
            ? {
                inputTokens: turn.usage.inputTokens,
                outputTokens: turn.usage.outputTokens,
              }
            : undefined,
        }
        yield assistantFact
        state = yield* this.persistAndReduce(state, assistantFact, 'buffered')

        // ---- do not trust stop_reason; count actual tool_call blocks ----
        const calls = turn.message.content.filter(
          (b): b is Extract<ContentBlock, { type: 'tool_call' }> =>
            b.type === 'tool_call',
        )

        if (calls.length > 0) {
          state = { ...state, phase: 'executing_tools' }
          yield { type: 'status.changed', phase: state.phase }

          const execution = this.executeToolBatch(state, turn.message, calls, signal)
          let result = await execution.next()
          while (!result.done) {
            const event = result.value
            yield event
            if (isFactEvent(event)) {
              state = yield* this.persistAndReduce(state, event, factDurability(event))
            }
            result = await execution.next()
          }

          const transition: ContinueTransition = {
            reason: 'tool_results_ready',
            callCount: calls.length,
          }
          const transitionFact: FactEvent = { type: 'loop.transitioned', transition }
          yield transitionFact
          state = yield* this.persistAndReduce(state, transitionFact, 'buffered')

          // periodic snapshot for fast recovery (every 3 iterations)
          if (state.iteration % 3 === 0 && this.d.journal) {
            const snapshotFact: FactEvent = {
              type: 'state.snapshot',
              snapshot: createSnapshot(state, this.d.journal.currentSeq),
            }
            yield snapshotFact
            state = yield* this.persistAndReduce(state, snapshotFact, 'flush')
          }

          // ---- replan detection (bounded: max 2 replans per run) ----
          state = this.trackToolOutcomes(state, calls)
          if (state.recovery.replanCount < 2 && this.d.gate?.plans) {
            const replan = detectReplanTrigger({
              state,
              approvedPlan: this.d.gate.plans.lastApproved(),
              config: this.d.config.replan,
              consecutiveFailures: state.recovery.consecutiveFailures,
              versionConflicts: state.recovery.versionConflicts,
            })
            if (replan.required) {
              state = yield* this.applyReplan(state, replan)
              continue
            }
          }

          // ---- plan constraints after each tool batch (soft enforcement) ----
          if (this.d.gate?.plans && !constraintHintEmitted) {
            const approvedPlan = this.d.gate.plans.lastApproved()
            if (approvedPlan) {
              const violations = checkPlanConstraints({
                state,
                approvedPlan,
                tasks: state.tasks,
              })
              if (violations.length > 0) {
                constraintHintEmitted = true
                const text =
                  'Plan constraint violations detected:\n' +
                  violations
                    .map(v => `- [${v.severity}] ${v.detail}`)
                    .join('\n') +
                  '\nStay within the approved plan scope, or trigger a replan.'
                const injected = this.makeEngineMessage(state, text)
                const messageFact: FactEvent = {
                  type: 'user.message.accepted',
                  message: injected,
                }
                yield messageFact
                state = yield* this.persistAndReduce(state, messageFact, 'flush')
              }
            }
          }

          continue
        }

        // ---- no tool calls: completion gate ----
        state = { ...state, phase: 'evaluating_completion' }
        yield { type: 'status.changed', phase: state.phase }

        if (this.d.gate) {
          const gate = evaluateCompletion({
            state,
            approvedPlan: this.d.gate.plans?.lastApproved(),
            evidence: this.d.gate.evidence?.list() ?? [],
            riskThreshold: this.d.gate.riskThreshold,
          })

          if (gate.action === 'continue') {
            // completion gate is a stop hook: one bounded retry, no spirals
            if (state.recovery.stopHookRetries >= 1) {
              return yield* this.terminate(state, {
                reason: 'completed_with_unverified_items',
                items: gate.missing.map(m => m.detail),
              })
            }
            state = {
              ...state,
              recovery: {
                ...state.recovery,
                stopHookRetries: state.recovery.stopHookRetries + 1,
              },
            }
            const injected = this.makeEngineMessage(state, gate.message!)
            const messageFact: FactEvent = {
              type: 'user.message.accepted',
              message: injected,
            }
            yield messageFact
            state = yield* this.persistAndReduce(state, messageFact, 'flush')
            const transitionFact: FactEvent = {
              type: 'loop.transitioned',
              transition: {
                reason: 'stop_hook_blocking',
                attempt: state.recovery.stopHookRetries,
              },
            }
            yield transitionFact
            state = yield* this.persistAndReduce(state, transitionFact, 'buffered')
            continue
          }

          // ---- L2 independent verification on high-risk completion ----
          if (
            gate.requiresVerification &&
            this.d.verifier &&
            !state.lastVerification
          ) {
            state = { ...state, phase: 'verifying' }
            yield { type: 'status.changed', phase: state.phase }

            const outcome = await this.d.verifier.run({
              goal: this.firstHumanText(state),
              approvedPlan: this.d.gate.plans?.lastApproved(),
              touchedSummary: this.describeWrites(state),
              signal,
            })
            const verificationFact: FactEvent = {
              type: 'verification.completed',
              report: outcome.report,
              valid: outcome.valid,
            }
            yield verificationFact
            state = yield* this.persistAndReduce(state, verificationFact, 'flush')

            const maxRepairs = this.d.config.maxRepairAttempts ?? 1
            if (
              outcome.report.verdict === 'FAIL' &&
              state.recovery.verifierRepairs < maxRepairs
            ) {
              state = {
                ...state,
                recovery: {
                  ...state.recovery,
                  verifierRepairs: state.recovery.verifierRepairs + 1,
                },
              }
              const repairText =
                'Independent verification FAILED. Fix these findings, then re-verify:\n' +
                outcome.report.failures
                  .map(
                    f =>
                      `- [${f.severity}] ${f.title}` +
                      (f.reproduction.length > 0
                        ? `\n  repro: ${f.reproduction.join('; ')}`
                        : ''),
                  )
                  .join('\n')
              const injected = this.makeEngineMessage(state, repairText)
              const messageFact: FactEvent = {
                type: 'user.message.accepted',
                message: injected,
              }
              yield messageFact
              state = yield* this.persistAndReduce(state, messageFact, 'flush')
              // clear lastVerification so re-verification runs after the repair
              state = { ...state, lastVerification: undefined }
              const transitionFact: FactEvent = {
                type: 'loop.transitioned',
                transition: {
                  reason: 'verification_repair',
                  attempt: state.recovery.verifierRepairs,
                },
              }
              yield transitionFact
              state = yield* this.persistAndReduce(state, transitionFact, 'buffered')
              continue
            }

            if (outcome.report.verdict !== 'PASS') {
              // verification failures feed the replan detector before the
              // run gives up — a bounded replan gets one more repair cycle
              if (state.recovery.replanCount < 2 && this.d.gate?.plans) {
                const replan = detectReplanTrigger({
                  state,
                  approvedPlan: this.d.gate.plans.lastApproved(),
                  config: this.d.config.replan,
                  consecutiveFailures: state.recovery.consecutiveFailures,
                  versionConflicts: state.recovery.versionConflicts,
                  verificationFailures: outcome.report.failures.map(f => f.title),
                })
                if (replan.required) {
                  state = yield* this.applyReplan(state, replan)
                  state = {
                    ...state,
                    lastVerification: undefined,
                    recovery: { ...state.recovery, verifierRepairs: 0 },
                  }
                  continue
                }
              }
              return yield* this.terminate(state, {
                reason: 'completed_with_unverified_items',
                items: [
                  ...outcome.report.failures.map(f => f.title),
                  ...outcome.report.unverified.map(u => `${u.item}: ${u.reason}`),
                ],
              })
            }
          }
        }

        return yield* this.terminate(state, { reason: 'completed' })
      }
    } catch (error) {
      if (error instanceof InvariantError) {
        return yield* this.terminate(state, {
          reason: 'invariant_violation',
          invariant: error.invariant,
        })
      }
      throw error
    }
  }

  // ---- helpers ----

  private makeEngineMessage(state: AgentState, text: string): ConversationMessage {
    return {
      id: this.d.ids.next('msg'),
      parentId:
        state.messages.length > 0
          ? state.messages[state.messages.length - 1]!.id
          : null,
      sessionId: state.sessionId,
      turnId: state.turnId,
      role: 'user',
      content: [{ type: 'text', text }],
      createdAt: this.d.clock.isoNow(),
      meta: { source: 'engine', synthetic: true },
    }
  }

  private firstHumanText(state: AgentState): string {
    for (const message of state.messages) {
      if (message.meta?.source === 'human' || (message.role === 'user' && !message.meta)) {
        const text = message.content
          .filter(b => b.type === 'text')
          .map(b => (b.type === 'text' ? b.text : ''))
          .join('\n')
        if (text.trim().length > 0) return text
      }
    }
    return '(no explicit user goal recorded)'
  }

  private describeWrites(state: AgentState): string {
    const writes = Object.values(state.toolResults).filter(
      r =>
        r.ok &&
        (r.toolName === 'Edit' ||
          r.toolName === 'Write' ||
          r.toolName === 'ApplyPatch' ||
          r.toolName === 'Shell'),
    )
    if (writes.length === 0) return 'No write tools were executed.'
    return writes
      .map(r => `${r.toolName} (call ${r.callId}): ok`)
      .join('\n')
  }

  private checkPreflight(
    state: AgentState,
    signal: AbortSignal,
  ): TerminalReason | null {
    if (signal.aborted) return { reason: 'aborted', at: state.phase }
    if (state.iteration >= state.budget.maxTurns) {
      return { reason: 'max_turns', turns: state.iteration }
    }
    if (state.budget.used.modelCalls >= state.budget.maxModelCalls) {
      return { reason: 'budget_exhausted', kind: 'tokens' }
    }
    if (state.budget.used.toolCalls >= state.budget.maxToolCalls) {
      return { reason: 'budget_exhausted', kind: 'tokens' }
    }
    if (
      this.d.clock.now() - state.budget.used.startedAt >=
      state.budget.maxWallTimeMs
    ) {
      return { reason: 'budget_exhausted', kind: 'time' }
    }
    return null
  }

  /** Streams one model turn, applying the bounded retry policy. */
  private async *collectModelTurn(
    state: AgentState,
    request: ReturnType<typeof assemblePrompt>,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, ModelTurnOutcome> {
    const sleep = this.d.sleep ?? defaultSleep
    let attempt = 0

    while (true) {
      // A fresh assembler per attempt — never reuse a polluted one.
      const assembler = new StreamAssembler({
        ids: this.d.ids,
        clock: this.d.clock,
        sessionId: state.sessionId,
        turnId: state.turnId,
        parentId:
          state.messages.length > 0
            ? state.messages[state.messages.length - 1]!.id
            : null,
        model: this.d.model.modelId,
      })

      try {
        for await (const event of this.d.model.stream(request, signal)) {
          assembler.push(event)
          if (event.type === 'text_delta') {
            yield { type: 'model.delta', turnId: state.turnId, text: event.text }
          } else if (event.type === 'thinking_delta') {
            yield {
              type: 'model.thinking.delta',
              turnId: state.turnId,
              text: event.text,
            }
          }
        }
        return { kind: 'assembled', turn: assembler.finish() }
      } catch (error) {
        if (signal.aborted) {
          return { kind: 'fatal', terminal: { reason: 'aborted', at: 'calling_model' } }
        }
        const classified: ModelError = this.d.model.classifyError(error)
        if (classified.code === 'PROMPT_TOO_LONG') {
          return { kind: 'fatal', terminal: { reason: 'prompt_too_long' } }
        }
        const decision = this.d.retryPolicy.decide({ error: classified, attempt })
        if (decision.action === 'surface') {
          return {
            kind: 'fatal',
            terminal: { reason: 'model_error', code: classified.code },
          }
        }
        attempt += 1
        await sleep(decision.delayMs ?? 0)
      }
    }
  }

  /**
   * Executes one batch of tool calls:
   * accept each call (ledger + fact), schedule with FIFO barriers,
   * synthesize results for any call left open (abort), then build the
   * tool-result message in received order.
   */
  private async *executeToolBatch(
    state: AgentState,
    parentMessage: ConversationMessage,
    blocks: Array<Extract<ContentBlock, { type: 'tool_call' }>>,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const ledger = new ToolCallLedger()
    const calls: ToolCall[] = blocks.map((block, index) => ({
      id: block.id,
      name: block.name,
      input: block.input,
      parentMessageId: parentMessage.id,
      receivedIndex: index,
    }))

    for (const call of calls) {
      ledger.accept(call)
      yield { type: 'tool.call.accepted', call }
    }

    const collected = new Map<string, ToolCallResult>()

    // transient side channel: live tool progress bypasses the scheduler
    // buffer (which exists to keep FACT replay order deterministic) and is
    // merged into this generator as it happens
    const transient = new AsyncQueue<AgentEvent>()

    const scheduled: ScheduledCall[] = calls.map(call => ({
      call,
      run: async () => {
        if (signal.aborted) return []
        ledger.markRunning(call.id)
        const events: AgentEvent[] = []
        const generator = this.d.toolRuntime.executeOne({
          call,
          mode: state.mode,
          sessionId: state.sessionId,
          workspaceRoot: state.workspace.root,
          artifactDir: this.d.config.artifactDir,
          signal,
          onTransient: event => transient.push(event),
        })
        for await (const event of generator) {
          events.push(event)
          if (event.type === 'tool.call.completed') {
            ledger.complete(event.result.callId, event.result.callId)
            collected.set(event.result.callId, event.result)
          }
        }
        return events
      },
    }))

    const batch = this.d.scheduler.executeBatch(scheduled, state.workspace.root)
    for await (const event of mergeTransient(transient, batch)) {
      yield event
    }
    transient.close()

    // any call still open (abort mid-batch) gets a synthetic terminal result
    const synthesized = ledger.synthesizeOpen(
      'Tool call was interrupted before completion.',
    )
    for (const result of synthesized) {
      collected.set(result.callId, result)
      yield { type: 'tool.call.completed', result }
    }

    // build the tool_result message in received order
    const resultBlocks: ContentBlock[] = calls.map(call => {
      const result = collected.get(call.id)
      if (!result) {
        throw new InvariantError(
          'single_terminal_tool_result',
          `no terminal result for ${call.id}`,
        )
      }
      return {
        type: 'tool_result',
        callId: call.id,
        ok: result.ok,
        content: result.content,
        errorCode: result.errorCode,
      }
    })

    const message: ConversationMessage = {
      id: this.d.ids.next('msg'),
      parentId: parentMessage.id,
      sessionId: state.sessionId,
      turnId: state.turnId,
      role: 'user',
      content: resultBlocks,
      createdAt: this.d.clock.isoNow(),
      meta: { source: 'tool' },
    }
    yield { type: 'tool.result.message', message }
  }

  private async *persistAndReduce(
    state: AgentState,
    fact: FactEvent,
    durability: 'buffered' | 'flush',
  ): AsyncGenerator<AgentEvent, AgentState> {
    if (this.d.journal) {
      await this.d.journal.append(fact, state.turnId, durability)
    }
    return reduce(state, fact)
  }

  /** Track consecutive failures and version conflicts for replan detection.
   * Counters live in state.recovery so snapshots preserve them. */
  private trackToolOutcomes(state: AgentState, calls: Array<{ id: string }>): AgentState {
    const batchResults = calls
      .map(c => state.toolResults[c.id])
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
    const allFailed = batchResults.length > 0 && batchResults.every(r => !r.ok)
    let conflicts = state.recovery.versionConflicts
    for (const r of batchResults) {
      if (r.errorCode === 'FILE_VERSION_CONFLICT') {
        conflicts++
      }
    }
    return {
      ...state,
      recovery: {
        ...state.recovery,
        consecutiveFailures: allFailed
          ? state.recovery.consecutiveFailures + 1
          : 0,
        versionConflicts: conflicts,
      },
    }
  }

  /**
   * Replan protocol (guide §8.5). The durable `replan.requested` fact owns
   * the state transition (reducer sets replanning, bumps replanCount,
   * resets detector counters), so full replay reproduces it exactly.
   * Reapproval replans additionally:
   * - supersede the approved plan version (store + plan.status.changed fact)
   * - retire unfinished tasks bound to that version (task.changed facts)
   * - close the runtime write gate immediately; the schema projection
   *   follows on the next prompt assembly
   */
  private async *applyReplan(
    state: AgentState,
    replan: ReplanDecision,
  ): AsyncGenerator<AgentEvent, AgentState> {
    const requestedFact: FactEvent = {
      type: 'replan.requested',
      cause: replan.cause?.type ?? 'unknown',
      requiresReapproval: replan.requiresReapproval,
    }
    yield requestedFact
    state = yield* this.persistAndReduce(state, requestedFact, 'flush')

    if (replan.requiresReapproval) {
      const approved = this.d.gate?.plans?.lastApproved()
      if (approved) {
        await this.d.gate!.plans!.markSuperseded(approved.planId, approved.version)
        const supersededFact: FactEvent = {
          type: 'plan.status.changed',
          planId: approved.planId,
          version: approved.version,
          status: 'superseded',
        }
        yield supersededFact
        state = yield* this.persistAndReduce(state, supersededFact, 'flush')

        // unfinished tasks of the superseded version are blocked, never
        // silently carried into the new plan
        if (this.d.gate?.tasks) {
          for (const task of this.d.gate.tasks.list()) {
            if (
              task.planId === approved.planId &&
              task.planVersion === approved.version &&
              (task.status === 'pending' || task.status === 'in_progress')
            ) {
              const updated = this.d.gate.tasks.update({
                id: task.id,
                expectedRevision: task.revision,
                patch: {
                  status: 'blocked',
                  blockedReason:
                    `plan ${approved.planId}@${approved.version} superseded by replan`,
                },
              })
              if (updated.ok) {
                const taskFact: FactEvent = {
                  type: 'task.changed',
                  task: updated.value,
                }
                yield taskFact
                state = yield* this.persistAndReduce(state, taskFact, 'buffered')
              }
            }
          }
        }
      }
      // close the runtime write gate now (schema follows next iteration)
      this.d.onWriteGateChange?.(true)
    }

    const instruction = replan.requiresReapproval
      ? replan.message +
        '\nWrite tools are DISABLED until a revised plan version is approved. ' +
        'Explore read-only, persist the revision with PlanPropose, then call ExitPlanMode.'
      : replan.message
    const injected = this.makeEngineMessage(state, instruction)
    const messageFact: FactEvent = {
      type: 'user.message.accepted',
      message: injected,
    }
    yield messageFact
    state = yield* this.persistAndReduce(state, messageFact, 'flush')

    const transitionFact: FactEvent = {
      type: 'loop.transitioned',
      transition: {
        reason: 'replan_required',
        cause: replan.cause?.type ?? 'unknown',
      },
    }
    yield transitionFact
    state = yield* this.persistAndReduce(state, transitionFact, 'buffered')
    return state
  }

  private async *terminate(
    state: AgentState,
    terminal: TerminalReason,
  ): AsyncGenerator<AgentEvent, TerminalReason> {
    const fact: FactEvent = { type: 'run.terminated', terminal }
    yield fact
    if (this.d.journal) {
      await this.d.journal.append(fact, state.turnId, 'flush')
      await this.d.journal.drain()
    }
    yield { type: 'status.changed', phase: 'terminated' }
    return terminal
  }
}

/** Durability policy per fact type (guide §11.2). */
function factDurability(event: FactEvent): 'buffered' | 'flush' {
  switch (event.type) {
    case 'user.message.accepted':
    case 'permission.decided':
    case 'tool.call.accepted':
    case 'tool.call.completed':
    case 'run.terminated':
      return 'flush'
    default:
      return 'buffered'
  }
}
