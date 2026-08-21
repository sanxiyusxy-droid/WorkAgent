import type { AgentEvent } from '../core/events.js'

/** Core metric families from guide §14.2. */
export interface MetricsSnapshot {
  correctness: {
    /** accepted tool calls without a terminal result — target: always 0 */
    orphanToolCalls: number
    /** more than one terminal result for the same call — target: always 0 */
    duplicateToolResults: number
  }
  usage: {
    /** successful assembled turns */
    modelTurns: number
    /** all physical gateway requests, including failed attempts */
    modelAttempts: number
    failedModelAttempts: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    promptEstimatedTokens: number
  }
  tools: {
    completed: number
    succeeded: number
    failed: number
    successRate: number
    totalDurationMs: number
    byErrorCode: Record<string, number>
  }
  permissions: {
    allow: number
    ask: number
    deny: number
    /** deny decisions that came from hard safety rules */
    hardSafetyDenies: number
  }
  loop: {
    transitions: Record<string, number>
    terminal?: string
    verificationRuns: number
    compactions: Record<string, number>
  }
  planning: {
    replans: number
    replanByCause: Record<string, number>
    reflectionsRecorded: number
    reflectionsEvaluated: number
    effectiveReflections: number
    ineffectiveReflections: number
    stagnations: number
    strategyTransitions: number
    planHealthAssessments: number
  }
  recovery: {
    modelRetries: number
    branches: number
    idempotencyAdjudications: number
  }
  perTool: Record<string, { calls: number; failures: number }>
}

/** One compact machine line per loop turn (guide §14.3). */
export interface TurnLogEntry {
  turn: number
  toolCalls: string[]
  permissions: string[]
  transition?: string
  terminal?: string
  contextTokens?: number
}

/**
 * Pure event-stream aggregator. It never influences engine behavior —
 * observability subscribes to events, it does not participate in decisions.
 */
export class MetricsCollector {
  private readonly accepted = new Set<string>()
  private readonly completed = new Map<string, number>()
  private readonly toolNames = new Map<string, string>()

  private modelTurns = 0
  private failedModelAttempts = 0
  private inputTokens = 0
  private outputTokens = 0
  private promptEstimatedTokens = 0
  private permissions = { allow: 0, ask: 0, deny: 0, hardSafetyDenies: 0 }
  private transitions: Record<string, number> = {}
  private compactions: Record<string, number> = {}
  private terminal: string | undefined
  private verificationRuns = 0
  private perTool: Record<string, { calls: number; failures: number }> = {}
  private toolCompleted = 0
  private toolSucceeded = 0
  private toolFailed = 0
  private toolDurationMs = 0
  private toolErrors: Record<string, number> = {}
  private replans = 0
  private replanByCause: Record<string, number> = {}
  private reflectionsRecorded = 0
  private reflectionsEvaluated = 0
  private effectiveReflections = 0
  private ineffectiveReflections = 0
  private stagnations = 0
  private strategyTransitions = 0
  private planHealthAssessments = 0
  private modelRetries = 0
  private recoveryBranches = 0
  private idempotencyAdjudications = 0

  private turnIndex = 0
  private currentTurn: TurnLogEntry = { turn: 0, toolCalls: [], permissions: [] }
  readonly decisionLog: TurnLogEntry[] = []

  recordAll(events: Iterable<AgentEvent>): void {
    for (const event of events) this.record(event)
  }

  record(event: AgentEvent): void {
    switch (event.type) {
      case 'prompt.manifest':
        this.promptEstimatedTokens = event.manifest.totalEstimatedTokens
        this.currentTurn.contextTokens = event.manifest.totalEstimatedTokens
        return

      case 'assistant.message.completed': {
        this.modelTurns += 1
        const usage = event.usage
        if (usage) {
          this.inputTokens += usage.inputTokens
          this.outputTokens += usage.outputTokens
        }
        return
      }

      case 'model.attempt.failed':
        this.failedModelAttempts += 1
        if (event.failure.action === 'retry') this.modelRetries += 1
        return

      case 'tool.call.accepted': {
        this.accepted.add(event.call.id)
        this.toolNames.set(event.call.id, event.call.name)
        const entry = (this.perTool[event.call.name] ??= { calls: 0, failures: 0 })
        entry.calls += 1
        this.currentTurn.toolCalls.push(event.call.name)
        return
      }

      case 'tool.call.completed': {
        this.toolCompleted += 1
        this.toolDurationMs += event.result.durationMs
        if (event.result.ok) {
          this.toolSucceeded += 1
        } else {
          this.toolFailed += 1
          const code = event.result.errorCode ?? 'UNKNOWN'
          this.toolErrors[code] = (this.toolErrors[code] ?? 0) + 1
        }
        this.completed.set(
          event.result.callId,
          (this.completed.get(event.result.callId) ?? 0) + 1,
        )
        if (!event.result.ok) {
          const name = this.toolNames.get(event.result.callId) ?? event.result.toolName
          const entry = (this.perTool[name] ??= { calls: 0, failures: 0 })
          entry.failures += 1
        }
        return
      }

      case 'permission.decided': {
        this.permissions[event.decision.behavior] += 1
        if (
          event.decision.behavior === 'deny' &&
          event.decision.reason.type === 'hard_safety'
        ) {
          this.permissions.hardSafetyDenies += 1
        }
        this.currentTurn.permissions.push(
          `${event.decision.behavior}:${event.decision.toolName}`,
        )
        return
      }

      case 'context.compacted':
        this.compactions[event.record.kind] =
          (this.compactions[event.record.kind] ?? 0) + 1
        return

      case 'verification.completed':
        this.verificationRuns += 1
        return

      case 'replan.requested':
        this.replans += 1
        this.replanByCause[event.cause] = (this.replanByCause[event.cause] ?? 0) + 1
        return

      case 'reflection.recorded':
        this.reflectionsRecorded += 1
        return

      case 'reflection.evaluated':
        this.reflectionsEvaluated += 1
        if (event.evaluation.outcome === 'effective') {
          this.effectiveReflections += 1
        } else {
          this.ineffectiveReflections += 1
        }
        return

      case 'loop.stagnation.detected':
        this.stagnations += 1
        return

      case 'strategy.adapted':
        this.strategyTransitions += 1
        return

      case 'plan.health.assessed':
        this.planHealthAssessments += 1
        return

      case 'session.recovery.branch':
        this.recoveryBranches += 1
        return

      case 'idempotency.adjudicated':
        this.idempotencyAdjudications += 1
        return

      case 'loop.transitioned': {
        const reason = event.transition.reason
        this.transitions[reason] = (this.transitions[reason] ?? 0) + 1
        this.currentTurn.transition = reason
        this.flushTurn()
        return
      }

      case 'run.terminated':
        this.terminal = event.terminal.reason
        this.currentTurn.terminal = event.terminal.reason
        this.flushTurn()
        return

      default:
        return
    }
  }

  snapshot(): MetricsSnapshot {
    let orphans = 0
    for (const id of this.accepted) {
      if (!this.completed.has(id)) orphans += 1
    }
    let duplicates = 0
    for (const count of this.completed.values()) {
      if (count > 1) duplicates += count - 1
    }
    let toolCalls = 0
    for (const entry of Object.values(this.perTool)) toolCalls += entry.calls

    return {
      correctness: { orphanToolCalls: orphans, duplicateToolResults: duplicates },
      usage: {
        modelTurns: this.modelTurns,
        modelAttempts: this.modelTurns + this.failedModelAttempts,
        failedModelAttempts: this.failedModelAttempts,
        toolCalls,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        promptEstimatedTokens: this.promptEstimatedTokens,
      },
      tools: {
        completed: this.toolCompleted,
        succeeded: this.toolSucceeded,
        failed: this.toolFailed,
        successRate:
          this.toolCompleted === 0 ? 1 : this.toolSucceeded / this.toolCompleted,
        totalDurationMs: this.toolDurationMs,
        byErrorCode: { ...this.toolErrors },
      },
      permissions: { ...this.permissions },
      loop: {
        transitions: { ...this.transitions },
        terminal: this.terminal,
        verificationRuns: this.verificationRuns,
        compactions: { ...this.compactions },
      },
      planning: {
        replans: this.replans,
        replanByCause: { ...this.replanByCause },
        reflectionsRecorded: this.reflectionsRecorded,
        reflectionsEvaluated: this.reflectionsEvaluated,
        effectiveReflections: this.effectiveReflections,
        ineffectiveReflections: this.ineffectiveReflections,
        stagnations: this.stagnations,
        strategyTransitions: this.strategyTransitions,
        planHealthAssessments: this.planHealthAssessments,
      },
      recovery: {
        modelRetries: this.modelRetries,
        branches: this.recoveryBranches,
        idempotencyAdjudications: this.idempotencyAdjudications,
      },
      perTool: Object.fromEntries(
        Object.entries(this.perTool).map(([k, v]) => [k, { ...v }]),
      ),
    }
  }

  formatSummary(): string {
    const snap = this.snapshot()
    return [
      `model turns/attempts: ${snap.usage.modelTurns}/${snap.usage.modelAttempts}, tool calls: ${snap.usage.toolCalls}`,
      `tokens in/out: ${snap.usage.inputTokens}/${snap.usage.outputTokens}`,
      `permissions allow/ask/deny: ${snap.permissions.allow}/${snap.permissions.ask}/${snap.permissions.deny}` +
        (snap.permissions.hardSafetyDenies > 0
          ? ` (hard safety: ${snap.permissions.hardSafetyDenies})`
          : ''),
      `transitions: ${JSON.stringify(snap.loop.transitions)}`,
      `tool success: ${snap.tools.succeeded}/${snap.tools.completed}; model retries: ${snap.recovery.modelRetries}`,
      `replans/reflections evaluated: ${snap.planning.replans}/${snap.planning.reflectionsEvaluated}`,
      `orphan tool calls: ${snap.correctness.orphanToolCalls} (must be 0)`,
      `terminal: ${snap.loop.terminal ?? '(running)'}`,
    ].join('\n')
  }

  private flushTurn(): void {
    this.decisionLog.push(this.currentTurn)
    this.turnIndex += 1
    this.currentTurn = { turn: this.turnIndex, toolCalls: [], permissions: [] }
  }
}
