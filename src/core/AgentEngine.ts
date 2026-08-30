import type {
  AgentEvent,
  FactEvent,
  TerminalReason,
  ContinueTransition,
  LoopPhase,
  ModelAttemptFailure,
} from './events.js'
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
import { findStaleReceipts } from '../verification/freshness.js'
import {
  detectReplanTrigger,
  checkPlanConstraints,
  type ReplanConfig,
  type ReplanDecision,
} from '../planning/ReplanDetector.js'
import {
  adaptiveMaxOutputTokens,
  buildReflection,
  deriveExecutionStrategy,
  detectStagnation,
  renderReflection,
  shouldReflect,
  strategyInstructions,
} from './LoopIntelligence.js'
import type { ReflectionRecord } from './events.js'
import {
  assessPlanHealth,
  evaluateReflectionEffect,
  renderPlanSupervision,
} from '../planning/PlanSupervisor.js'
import {
  calibrateReflectionDecision,
  renderOutcomeCalibrationProfile,
  type OutcomeCalibrationProfile,
} from '../planning/OutcomeCalibration.js'
import {
  buildToolExecutionLane,
  renderToolExecutionLane,
  type ToolExecutionLane,
} from '../planning/ToolExecutionLane.js'

export interface EngineDeps {
  model: ModelGateway
  registry: ToolRegistry
  toolRuntime: ToolRuntime
  scheduler: ToolScheduler
  retryPolicy: RetryPolicy
  journal: SessionJournal | null
  clock: Clock
  ids: IdGenerator
  /** Non-persistent fallback profile; durable sessions read their pin from state. */
  outcomeCalibration?: OutcomeCalibrationProfile
  /** Current config may suppress a durable selection without deleting it. */
  outcomeCalibrationEnabled?: boolean
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
  /** enables PlanRepair only for an active low-impact replan */
  onLocalPlanRepairChange?: (pending: boolean) => void
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
    /** v1.1 loop intelligence; composition root enables it by default */
    intelligence?: {
      enabled?: boolean
      reflectionInterval?: number
      reflectionEvaluationWindow?: number
      completionReflection?: boolean
    }
  }
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

type ModelTurnOutcome =
  | { kind: 'assembled'; turn: AssembledTurn; failures: ModelAttemptFailure[] }
  | { kind: 'fatal'; terminal: TerminalReason; failures: ModelAttemptFailure[] }

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

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
          state.recovery.degradedRecovery ||
            (state.recovery.replanning && state.recovery.replanAwaitingApproval),
        )
        this.d.onLocalPlanRepairChange?.(
          !state.recovery.degradedRecovery &&
            state.recovery.replanning &&
            !state.recovery.replanAwaitingApproval,
        )

        if (this.intelligenceEnabled()) {
          state = yield* this.supervisePlan(state)
          const adaptation = deriveExecutionStrategy(state)
          if (adaptation) {
            const strategyFact: FactEvent = {
              type: 'strategy.adapted',
              from: state.recovery.executionStrategy,
              to: adaptation.strategy,
              reason: adaptation.reason,
            }
            yield strategyFact
            state = yield* this.persistAndReduce(state, strategyFact, 'flush')
          }
        }

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
          state.recovery.degradedRecovery ||
          (state.recovery.replanning && state.recovery.replanAwaitingApproval)
        const strategyInstruction = strategyInstructions(
          state.recovery.executionStrategy,
        )
        const latestReflection = state.reflections[state.reflections.length - 1]
        const reflectionInstruction = latestReflection
          ? renderReflection(latestReflection)
          : undefined
        const latestEvaluation = state.reflectionEvaluations[
          state.reflectionEvaluations.length - 1
        ]
        const supervisionInstruction = state.latestPlanHealth
          ? renderPlanSupervision(
              state.latestPlanHealth,
              latestEvaluation?.reflectionId === latestReflection?.id
                ? latestEvaluation
                : undefined,
            )
          : undefined
        const calibrationProfile = this.calibrationProfile(state)
        const calibrationInstruction =
          state.latestPlanHealth && calibrationProfile
            ? renderOutcomeCalibrationProfile(
                calibrationProfile,
                state.outcomeCalibrationSelection?.hash,
              )
            : undefined
        const baseTools = this.d.registry.availableFor(state.mode, { writeLocked })
        const executionLane = this.intelligenceEnabled()
          ? buildToolExecutionLane({
              assessment: state.latestPlanHealth,
              mode: state.mode,
              writeLocked,
              candidateTools: baseTools.map(tool => tool.name),
              replanning: state.recovery.replanning,
            })
          : undefined
        const laneInstruction = renderToolExecutionLane(executionLane)
        if (executionLane) {
          const laneFact: FactEvent = {
            type: 'tool.lane.selected',
            selection: {
              version: executionLane.version,
              turnId: state.turnId,
              assessmentSignature: executionLane.assessmentSignature,
              action: executionLane.action,
              lane: executionLane.lane,
              mode: executionLane.mode,
              writeLocked: executionLane.writeLocked,
              replanning: executionLane.replanning,
              allowedTools: [...executionLane.allowedTools],
              blockedTools: [...executionLane.blockedTools],
              hash: executionLane.hash,
            },
          }
          yield laneFact
          state = yield* this.persistAndReduce(state, laneFact, 'flush')
        }
        const request = assemblePrompt({
          mode: state.mode,
          messages: state.messages,
          tools: this.d.registry.availableFor(state.mode, {
            writeLocked,
            lane: executionLane,
          }),
          maxOutputTokens: adaptiveMaxOutputTokens(
            this.d.config.maxOutputTokens,
            state.recovery.executionStrategy,
          ),
          projectInstructions: [
            this.d.config.projectInstructions,
            strategyInstruction,
            reflectionInstruction,
            supervisionInstruction,
            calibrationInstruction,
            laneInstruction,
          ].filter((value): value is string => Boolean(value)).join('\n\n') || undefined,
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
        for (const failure of outcome.failures) {
          const failureFact: FactEvent = {
            type: 'model.attempt.failed',
            failure,
          }
          yield failureFact
          // collectModelTurn flushes each failure before retrying so a crash
          // during backoff cannot erase a consumed physical model call.
          state = reduce(state, failureFact)
        }
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

          const execution = this.executeToolBatch(
            state,
            turn.message,
            calls,
            signal,
            executionLane,
            writeLocked,
          )
          let result = await execution.next()
          while (!result.done) {
            const event = result.value
            yield event
            if (isFactEvent(event)) {
              if (
                event.type === 'workspace.mutation.started' &&
                event.durableBeforeExecution
              ) {
                state = reduce(state, event)
              } else {
                state = yield* this.persistAndReduce(
                  state,
                  event,
                  factDurability(event),
                )
              }
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
          if (this.intelligenceEnabled()) {
            state = yield* this.supervisePlan(state)
            const stagnation = detectStagnation(state)
            if (stagnation) {
              const stagnationFact: FactEvent = {
                type: 'loop.stagnation.detected',
                record: stagnation,
              }
              yield stagnationFact
              state = yield* this.persistAndReduce(state, stagnationFact, 'flush')
              state = yield* this.recordReflection(
                state,
                'stagnation',
                stagnation.detail,
                false,
              )
            } else if (
              shouldReflect(state, 'periodic', this.reflectionInterval())
            ) {
              // Periodic reflection is an audit/policy checkpoint. It is not
              // injected into context every time; stagnation reflections are,
              // which avoids long-run prompt growth and summarizer churn.
              state = yield* this.recordReflection(state, 'periodic', undefined, false)
            }
          }
          if (state.recovery.replanCount < 2 && this.d.gate?.plans) {
            const replan = detectReplanTrigger({
              state,
              approvedPlan: this.d.gate.plans.lastApproved(),
              config: this.d.config.replan,
              consecutiveFailures: state.recovery.consecutiveFailures,
              versionConflicts: state.recovery.versionConflicts,
              ineffectiveReflections: state.recovery.ineffectiveReflectionCount,
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

        // One bounded completion reflection gives the model a final chance
        // to notice stale evidence or an unsupported completion claim.
        if (
          this.intelligenceEnabled() &&
          this.d.config.intelligence?.completionReflection !== false &&
          shouldReflect(state, 'completion', this.reflectionInterval())
        ) {
          const previousReflectionId = state.reflections[state.reflections.length - 1]?.id
          state = yield* this.recordReflection(state, 'completion', undefined, false)
          // recordReflection is single-flight. If an older decision-bearing
          // reflection is still waiting for its evaluation window, the call
          // intentionally no-ops; do not manufacture a transition/continue
          // in that case or completion can spin until max_turns with no new
          // model-visible information.
          if (
            state.reflections[state.reflections.length - 1]?.id !==
            previousReflectionId
          ) {
            const transitionFact: FactEvent = {
              type: 'loop.transitioned',
              transition: { reason: 'reflection_requested', trigger: 'completion' },
            }
            yield transitionFact
            state = yield* this.persistAndReduce(state, transitionFact, 'buffered')
            continue
          }
        }

        if (this.d.gate) {
          // freshness snapshot for the gate: receipts signed for an older
          // workspace revision cannot complete this run (finish-list §1.6)
          const staleEvidenceIds = this.d.gate.evidence
            ? await findStaleReceipts(this.d.gate.evidence)
            : undefined
          const gate = evaluateCompletion({
            state,
            approvedPlan: this.d.gate.plans?.lastApproved(),
            evidence: this.d.gate.evidence?.list() ?? [],
            riskThreshold: this.d.gate.riskThreshold,
            staleEvidenceIds,
            workspaceRoot: this.d.gate.evidence?.workspaceRoot,
            workspaceRevision: this.d.gate.evidence?.workspaceRevision,
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

          // Recovery reconciliation: a non-PASS verdict may have been
          // flushed just before the process stopped. Never let the presence
          // of that durable verdict skip verification and fall through to a
          // successful completion on resume.
          if (
            state.lastVerification &&
            (!state.lastVerification.valid ||
              state.lastVerification.report.verdict !== 'PASS')
          ) {
            const persistedReport = state.lastVerification.report
            if (state.recovery.replanCount < 2 && this.d.gate?.plans) {
              const replan = detectReplanTrigger({
                state,
                approvedPlan: this.d.gate.plans.lastApproved(),
                config: this.d.config.replan,
                consecutiveFailures: state.recovery.consecutiveFailures,
                versionConflicts: state.recovery.versionConflicts,
                verificationFailures: persistedReport.failures.map(f => f.title),
              })
              if (replan.required) {
                state = yield* this.applyReplan(state, replan)
                continue
              }
            }
            return yield* this.terminate(state, {
              reason: 'completed_with_unverified_items',
              items: [
                ...persistedReport.failures.map(f => f.title),
                ...persistedReport.unverified.map(u => `${u.item}: ${u.reason}`),
              ],
            })
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
            const maxRepairs = this.d.config.maxRepairAttempts ?? 1
            const repairAttempt =
              outcome.report.verdict === 'FAIL' &&
              state.recovery.verifierRepairs < maxRepairs
                ? state.recovery.verifierRepairs + 1
                : undefined
            const verificationFact: FactEvent = {
              type: 'verification.completed',
              report: outcome.report,
              valid: outcome.valid,
              ...(repairAttempt !== undefined ? { repairAttempt } : {}),
            }
            yield verificationFact
            state = yield* this.persistAndReduce(state, verificationFact, 'flush')

            if (repairAttempt !== undefined) {
              if (this.intelligenceEnabled()) {
                state = yield* this.recordReflection(
                  state,
                  'verification',
                  `Verifier reported ${outcome.report.failures.length} failures.`,
                  false,
                )
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
              const transitionFact: FactEvent = {
                type: 'loop.transitioned',
                transition: {
                  reason: 'verification_repair',
                  attempt: repairAttempt,
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

  private intelligenceEnabled(): boolean {
    return this.d.config.intelligence?.enabled === true
  }

  private reflectionInterval(): number {
    return Math.max(1, this.d.config.intelligence?.reflectionInterval ?? 8)
  }

  private reflectionEvaluationWindow(): number {
    return Math.max(
      1,
      Math.min(20, this.d.config.intelligence?.reflectionEvaluationWindow ?? 3),
    )
  }

  private async *supervisePlan(
    state: AgentState,
  ): AsyncGenerator<AgentEvent, AgentState> {
    const evaluatedReflectionIds = new Set(
      state.reflectionEvaluations.map(item => item.reflectionId),
    )
    const pendingReflection = state.reflections.find(
      reflection =>
        reflection.decision !== undefined &&
        reflection.progress.evidenceReceipts !== undefined &&
        reflection.progress.successfulToolCalls !== undefined &&
        !evaluatedReflectionIds.has(reflection.id),
    )
    if (pendingReflection) {
      const evaluation = evaluateReflectionEffect({
        state,
        reflection: pendingReflection,
        id: 'pending',
        createdAt: this.d.clock.isoNow(),
        evaluationWindow:
          pendingReflection.decision?.evaluateAfterToolCalls ??
          this.reflectionEvaluationWindow(),
      })
      if (evaluation) {
        const durableEvaluation = {
          ...evaluation,
          id: this.d.ids.next('reflection_evaluation'),
        }
        const evaluationFact: FactEvent = {
          type: 'reflection.evaluated',
          evaluation: durableEvaluation,
        }
        yield evaluationFact
        state = yield* this.persistAndReduce(state, evaluationFact, 'flush')
      }
    }

    const evidence = this.d.gate?.evidence?.list() ?? []
    const staleEvidenceIds =
      this.d.gate?.evidence && evidence.length > 0
        ? await findStaleReceipts(this.d.gate.evidence)
        : undefined
    const assessment = assessPlanHealth({
      state,
      approvedPlan: this.d.gate?.plans?.lastApproved(),
      evidence,
      id: 'pending',
      createdAt: this.d.clock.isoNow(),
      staleEvidenceIds,
    })
    if (assessment.signature !== state.latestPlanHealth?.signature) {
      const durableAssessment = {
        ...assessment,
        id: this.d.ids.next('plan_health'),
      }
      const healthFact: FactEvent = {
        type: 'plan.health.assessed',
        assessment: durableAssessment,
      }
      yield healthFact
      state = yield* this.persistAndReduce(state, healthFact, 'flush')
    }
    return state
  }

  private async *recordReflection(
    state: AgentState,
    trigger: ReflectionRecord['trigger'],
    detail: string | undefined,
    inject: boolean,
  ): AsyncGenerator<AgentEvent, AgentState> {
    const evaluatedReflectionIds = new Set(
      state.reflectionEvaluations.map(item => item.reflectionId),
    )
    const pendingReflection = state.reflections.some(
      reflection =>
        reflection.decision !== undefined &&
        reflection.progress.evidenceReceipts !== undefined &&
        reflection.progress.successfulToolCalls !== undefined &&
        !evaluatedReflectionIds.has(reflection.id),
    )
    // Single-flight: never overwrite an unevaluated baseline with a newer
    // reflection. Otherwise long windows would bias history toward early
    // successes while no-progress outcomes silently disappear.
    if (pendingReflection) return state
    const calibrationProfile = this.calibrationProfile(state)
    const reflection = calibrateReflectionDecision(buildReflection({
      state,
      id: this.d.ids.next('reflection'),
      createdAt: this.d.clock.isoNow(),
      trigger,
      detail,
      assessment: state.latestPlanHealth,
      evaluationWindow: this.reflectionEvaluationWindow(),
    }), calibrationProfile, state.outcomeCalibrationSelection?.hash)
    const reflectionFact: FactEvent = {
      type: 'reflection.recorded',
      reflection,
    }
    yield reflectionFact
    state = yield* this.persistAndReduce(state, reflectionFact, 'flush')
    if (inject) {
      const messageFact: FactEvent = {
        type: 'user.message.accepted',
        message: this.makeEngineMessage(state, renderReflection(reflection)),
      }
      yield messageFact
      state = yield* this.persistAndReduce(state, messageFact, 'flush')
    }
    return state
  }

  private calibrationProfile(
    state: AgentState,
  ): OutcomeCalibrationProfile | undefined {
    if (this.d.outcomeCalibrationEnabled === false) return undefined
    return state.outcomeCalibrationSelection?.profile ?? this.d.outcomeCalibration
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
      return { reason: 'budget_exhausted', kind: 'model_calls' }
    }
    if (state.budget.used.toolCalls >= state.budget.maxToolCalls) {
      return { reason: 'budget_exhausted', kind: 'tool_calls' }
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
    const failures: ModelAttemptFailure[] = []
    const remainingCalls = Math.max(
      0,
      state.budget.maxModelCalls - state.budget.used.modelCalls,
    )

    while (true) {
      if (attempt >= remainingCalls) {
        return {
          kind: 'fatal',
          terminal: { reason: 'budget_exhausted', kind: 'model_calls' },
          failures,
        }
      }
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
        return { kind: 'assembled', turn: assembler.finish(), failures }
      } catch (error) {
        if (signal.aborted) {
          return {
            kind: 'fatal',
            terminal: { reason: 'aborted', at: 'calling_model' },
            failures,
          }
        }
        const classified: ModelError = this.d.model.classifyError(error)
        if (classified.code === 'PROMPT_TOO_LONG') {
          const failure: ModelAttemptFailure = {
            code: classified.code,
            attempt: attempt + 1,
            action: 'surface',
            delayMs: 0,
          }
          await this.persistModelAttemptFailure(state, failure)
          failures.push(failure)
          return {
            kind: 'fatal',
            terminal: { reason: 'prompt_too_long' },
            failures,
          }
        }
        const decision = this.d.retryPolicy.decide({ error: classified, attempt })
        if (decision.action === 'surface') {
          const failure: ModelAttemptFailure = {
            code: classified.code,
            attempt: attempt + 1,
            action: 'surface',
            delayMs: 0,
          }
          await this.persistModelAttemptFailure(state, failure)
          failures.push(failure)
          return {
            kind: 'fatal',
            terminal: { reason: 'model_error', code: classified.code },
            failures,
          }
        }
        const failure: ModelAttemptFailure = {
          code: classified.code,
          attempt: attempt + 1,
          action: 'retry',
          delayMs: decision.delayMs ?? 0,
        }
        await this.persistModelAttemptFailure(state, failure)
        failures.push(failure)
        attempt += 1
        if (attempt >= remainingCalls) {
          return {
            kind: 'fatal',
            terminal: { reason: 'budget_exhausted', kind: 'model_calls' },
            failures,
          }
        }
        try {
          await sleep(decision.delayMs ?? 0, signal)
        } catch (sleepError) {
          if (signal.aborted) {
            return {
              kind: 'fatal',
              terminal: { reason: 'aborted', at: 'calling_model' },
              failures,
            }
          }
          throw sleepError
        }
      }
    }
  }

  private async persistModelAttemptFailure(
    state: AgentState,
    failure: ModelAttemptFailure,
  ): Promise<void> {
    await this.d.journal?.append(
      { type: 'model.attempt.failed', failure },
      state.turnId,
      'flush',
    )
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
    lane?: Readonly<ToolExecutionLane>,
    writeLocked?: boolean,
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
          turnId: state.turnId,
          workspaceRoot: state.workspace.root,
          artifactDir: this.d.config.artifactDir,
          signal,
          lane,
          writeLocked,
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
        observation: result.observation,
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
    if (this.intelligenceEnabled()) {
      state = yield* this.recordReflection(
        state,
        'replan',
        replan.message,
        false,
      )
    }
    const requestedFact: FactEvent = {
      type: 'replan.requested',
      cause: replan.cause?.type ?? 'unknown',
      requiresReapproval: replan.requiresReapproval,
    }
    yield requestedFact
    state = yield* this.persistAndReduce(state, requestedFact, 'flush')

    const approvedForLocalRepair = !replan.requiresReapproval
      ? this.d.gate?.plans?.lastApproved()
      : undefined
    const canRepairLocally = Boolean(approvedForLocalRepair?.steps.length)

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
      : canRepairLocally
        ? replan.message +
          `\nUse PlanRepair on ${approvedForLocalRepair!.planId}@${approvedForLocalRepair!.version} ` +
          'to replace only the affected step. Preserve dependencies and acceptance criteria; ' +
          'a file-scope expansion requires a full PlanPropose + approval flow.'
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

    if (!replan.requiresReapproval && !canRepairLocally) {
      // low-impact replans close here: a durable adjustment fact records
      // WHAT changed and WHY, and the reducer exits `replanning`. The loop
      // never relies on the model replying "I adjusted" to end the state.
      const adjustmentFact: FactEvent = {
        type: 'replan.adjustment.applied',
        cause: replan.cause?.type ?? 'unknown',
        summary: replan.message,
      }
      yield adjustmentFact
      state = yield* this.persistAndReduce(state, adjustmentFact, 'flush')
    }

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
    case 'model.attempt.failed':
    case 'permission.decided':
    case 'tool.call.accepted':
    case 'tool.call.completed':
    case 'reflection.recorded':
    case 'reflection.evaluated':
    case 'plan.health.assessed':
    case 'tool.lane.selected':
    case 'loop.stagnation.detected':
    case 'strategy.adapted':
    case 'workspace.mutation.started':
    case 'run.terminated':
      return 'flush'
    default:
      return 'buffered'
  }
}
