import type { ToolCall, ToolCallResult } from '../core/messages.js'
import { InvariantError } from '../core/messages.js'

export type LedgerStatus =
  | 'accepted'
  | 'queued'
  | 'running'
  | 'completed'
  | 'synthetic_error'

export interface ToolCallLedgerEntry {
  call: ToolCall
  status: LedgerStatus
  resultId?: string
}

/**
 * Pairing ledger: every accepted tool_use id must end with exactly one
 * terminal tool_result — including interrupts, fallbacks and crashes.
 */
export class ToolCallLedger {
  private readonly entries = new Map<string, ToolCallLedgerEntry>()

  accept(call: ToolCall): void {
    if (this.entries.has(call.id)) {
      throw new InvariantError(
        'unique_tool_call_id',
        `duplicate tool call id: ${call.id}`,
      )
    }
    this.entries.set(call.id, { call, status: 'accepted' })
  }

  markRunning(callId: string): void {
    const entry = this.mustGet(callId)
    entry.status = 'running'
  }

  complete(callId: string, resultId: string, synthetic = false): void {
    const entry = this.mustGet(callId)
    if (entry.resultId) {
      throw new InvariantError(
        'single_terminal_tool_result',
        `invalid completion for ${callId}: already has result ${entry.resultId}`,
      )
    }
    entry.status = synthetic ? 'synthetic_error' : 'completed'
    entry.resultId = resultId
  }

  isCompleted(callId: string): boolean {
    return this.entries.get(callId)?.resultId !== undefined
  }

  openCalls(): ToolCall[] {
    return [...this.entries.values()]
      .filter(e => !e.resultId)
      .map(e => e.call)
  }

  /**
   * Produce synthetic terminal results for every open call. Must be invoked
   * on interrupt, fallback discard, sibling cancellation, resume with
   * unclosed calls, and early loop exit.
   */
  synthesizeOpen(
    reason: string,
    errorCode: ToolCallResult['errorCode'] = 'TOOL_ABORTED',
  ): ToolCallResult[] {
    const synthesized: ToolCallResult[] = []
    for (const entry of this.entries.values()) {
      if (entry.resultId) continue
      const result: ToolCallResult = {
        callId: entry.call.id,
        toolName: entry.call.name,
        ok: false,
        content: { kind: 'text', text: reason },
        errorCode,
        durationMs: 0,
        synthetic: true,
      }
      entry.status = 'synthetic_error'
      entry.resultId = `synthetic:${entry.call.id}`
      synthesized.push(result)
    }
    return synthesized
  }

  private mustGet(callId: string): ToolCallLedgerEntry {
    const entry = this.entries.get(callId)
    if (!entry) {
      throw new InvariantError(
        'ledger_unknown_call',
        `unknown tool call: ${callId}`,
      )
    }
    return entry
  }
}
