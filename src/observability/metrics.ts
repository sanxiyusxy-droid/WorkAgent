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
    modelTurns: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    promptEstimatedTokens: number
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
  private inputTokens = 0
  private outputTokens = 0
  private promptEstimatedTokens = 0
  private permissions = { allow: 0, ask: 0, deny: 0, hardSafetyDenies: 0 }
  private transitions: Record<string, number> = {}
  private compactions: Record<string, number> = {}
  private terminal: string | undefined
  private verificationRuns = 0
  private perTool: Record<string, { calls: number; failures: number }> = {}

  private turnIndex = 0
  private currentTurn: TurnLogEntry = { turn: 0, toolCalls: [], permissions: [] }
  readonly decisionLog: TurnLogEntry[] = []

  record(event: AgentEvent): void {
    switch (event.type) {
      case 'prompt.manifest':
        this.promptEstimatedTokens = event.manifest.totalEstimatedTokens
        this.currentTurn.contextTokens = event.manifest.totalEstimatedTokens
        return

      case 'assistant.message.completed': {
        this.modelTurns += 1
        const usage = event.message.meta?.usage
        if (usage) {
          this.inputTokens += usage.inputTokens
          this.outputTokens += usage.outputTokens
        }
        return
      }

      case 'tool.call.accepted': {
        this.accepted.add(event.call.id)
        this.toolNames.set(event.call.id, event.call.name)
        const entry = (this.perTool[event.call.name] ??= { calls: 0, failures: 0 })
        entry.calls += 1
        this.currentTurn.toolCalls.push(event.call.name)
        return
      }

      case 'tool.call.completed': {
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
        toolCalls,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        promptEstimatedTokens: this.promptEstimatedTokens,
      },
      permissions: { ...this.permissions },
      loop: {
        transitions: { ...this.transitions },
        terminal: this.terminal,
        verificationRuns: this.verificationRuns,
        compactions: { ...this.compactions },
      },
      perTool: Object.fromEntries(
        Object.entries(this.perTool).map(([k, v]) => [k, { ...v }]),
      ),
    }
  }

  formatSummary(): string {
    const snap = this.snapshot()
    return [
      `model turns: ${snap.usage.modelTurns}, tool calls: ${snap.usage.toolCalls}`,
      `tokens in/out: ${snap.usage.inputTokens}/${snap.usage.outputTokens}`,
      `permissions allow/ask/deny: ${snap.permissions.allow}/${snap.permissions.ask}/${snap.permissions.deny}` +
        (snap.permissions.hardSafetyDenies > 0
          ? ` (hard safety: ${snap.permissions.hardSafetyDenies})`
          : ''),
      `transitions: ${JSON.stringify(snap.loop.transitions)}`,
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
