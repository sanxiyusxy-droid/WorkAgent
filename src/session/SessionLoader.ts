import { readFile } from 'node:fs/promises'
import {
  isFactEvent,
  type AgentEvent,
  type FactEvent,
  type StateSnapshot,
} from '../core/events.js'
import type { ConversationMessage, ToolCall, ToolCallResult } from '../core/messages.js'
import type { PlanTask, PlanVersion } from '../planning/types.js'
import type { EvidenceReceipt } from '../verification/types.js'
import { envelopeChecksum, type JournalEnvelope } from './SessionJournal.js'

export interface LoadedSession {
  ok: boolean
  diagnostics: string[]
  envelopes: JournalEnvelope[]
  nextSeq: number
  lastEventId: string | null
  /** replayed view */
  messages: ConversationMessage[]
  /** accepted tool calls that never received a terminal result */
  openToolCalls: ToolCall[]
  completedResults: ToolCallResult[]
  /** completed calls whose provider-facing tool_result message was not durable */
  unmessagedResults: ToolCallResult[]
  /** latest snapshot of each task/evidence/plan seen in the journal */
  tasks: PlanTask[]
  evidence: EvidenceReceipt[]
  plans: PlanVersion[]
  /** last state.snapshot found in the journal (for fast recovery) */
  lastSnapshot: StateSnapshot | null
  /** index into envelopes[] where the tail after the last snapshot begins */
  tailStartIndex: number
  /** all fact events after the last snapshot (for reducer replay) */
  tailEvents: FactEvent[]
}

/**
 * Load and verify a JSONL journal:
 * - seq gaps, duplicate seq and checksum mismatches produce diagnostics
 *   (partial recovery, never silent skipping)
 * - rebuilds the message list and detects unclosed tool calls so the caller
 *   can synthesize INTERRUPTED_DURING_PREVIOUS_RUN results.
 */
export async function loadSession(filePath: string): Promise<LoadedSession> {
  const diagnostics: string[] = []
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    // Only a genuinely absent journal means "start fresh". Permission and
    // I/O errors must surface; treating them as an empty session could append
    // a new history beside data that merely became unreadable.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return {
      ok: true,
      diagnostics: ['journal not found; starting fresh'],
      envelopes: [],
      nextSeq: 1,
      lastEventId: null,
      messages: [],
      openToolCalls: [],
      completedResults: [],
      unmessagedResults: [],
      tasks: [],
      evidence: [],
      plans: [],
      lastSnapshot: null,
      tailStartIndex: 0,
      tailEvents: [],
    }
  }

  const envelopes: JournalEnvelope[] = []
  const lines = raw.split('\n').filter(line => line.trim().length > 0)
  let expectedSeq = 1

  for (const [lineNo, line] of lines.entries()) {
    let envelope: JournalEnvelope
    try {
      envelope = JSON.parse(line) as JournalEnvelope
    } catch {
      diagnostics.push(`line ${lineNo + 1}: unparseable JSON — stopping replay here`)
      break
    }
    if (envelope.schemaVersion !== 1) {
      diagnostics.push(`line ${lineNo + 1}: unknown schemaVersion ${envelope.schemaVersion}`)
      break
    }
    if (envelope.seq !== expectedSeq) {
      diagnostics.push(
        `line ${lineNo + 1}: seq ${envelope.seq}, expected ${expectedSeq} (gap or duplicate)`,
      )
      break
    }
    const parsedTimestamp = Date.parse(envelope.timestamp)
    if (
      typeof envelope.timestamp !== 'string' ||
      !Number.isFinite(parsedTimestamp) ||
      new Date(parsedTimestamp).toISOString() !== envelope.timestamp
    ) {
      diagnostics.push(
        `line ${lineNo + 1}: invalid envelope timestamp - stopping replay here`,
      )
      break
    }
    const { checksum, ...rest } = envelope
    if (envelopeChecksum(rest) !== checksum) {
      diagnostics.push(`line ${lineNo + 1}: checksum mismatch — stopping replay here`)
      break
    }
    const event = (envelope as { event?: unknown }).event
    if (
      !event ||
      typeof event !== 'object' ||
      !isFactEvent(event as AgentEvent)
    ) {
      diagnostics.push(
        `line ${lineNo + 1}: unknown fact event type - stopping replay here`,
      )
      break
    }
    envelopes.push(envelope)
    expectedSeq += 1
  }

  // replay facts
  const messages: ConversationMessage[] = []
  const accepted = new Map<string, ToolCall>()
  const completedResults: ToolCallResult[] = []
  const messagedResultIds = new Set<string>()
  const taskMap = new Map<string, PlanTask>()
  const evidenceMap = new Map<string, EvidenceReceipt>()
  const planMap = new Map<string, PlanVersion>()

  // track the last state.snapshot for fast recovery
  let lastSnapshot: StateSnapshot | null = null
  let snapshotEnvelopeIndex = -1

  for (let idx = 0; idx < envelopes.length; idx++) {
    const envelope = envelopes[idx]!
    const event = envelope.event as FactEvent
    switch (event.type) {
      case 'user.message.accepted':
      case 'assistant.message.completed':
        messages.push(event.message)
        break
      case 'tool.result.message':
        messages.push(event.message)
        for (const block of event.message.content) {
          if (block.type === 'tool_result') messagedResultIds.add(block.callId)
        }
        break
      case 'tool.call.accepted':
        accepted.set(event.call.id, event.call)
        break
      case 'tool.call.completed':
        accepted.delete(event.result.callId)
        completedResults.push(event.result)
        break
      case 'context.compacted': {
        const cleared = new Set(event.record.clearedMessageIds)
        const replacements = event.record.replacements ?? []
        let inserted = false
        for (let i = 0; i < messages.length; i++) {
          if (cleared.has(messages[i]!.id)) {
            if (!inserted) {
              messages.splice(i, 1, ...replacements)
              i += replacements.length - 1
              inserted = true
            } else {
              messages.splice(i, 1)
              i -= 1
            }
          }
        }
        break
      }
      case 'task.changed':
        taskMap.set(event.task.id, event.task)
        break
      case 'evidence.recorded':
        evidenceMap.set(event.receipt.id, event.receipt)
        break
      case 'plan.version.created':
        planMap.set(`${event.plan.planId}@${event.plan.version}`, event.plan)
        break
      case 'plan.status.changed': {
        // superseding facts finalize the restored plan's status so
        // PlanStore.restore never revives a superseded approved plan
        const plan = planMap.get(`${event.planId}@${event.version}`)
        if (plan) plan.status = event.status
        break
      }
      case 'state.snapshot':
        lastSnapshot = event.snapshot
        snapshotEnvelopeIndex = idx
        break
      default:
        break
    }
  }

  // Crash reconciliation: assistant.message.completed is the durable source
  // of the whole requested batch. If the process stopped after persisting
  // only a prefix of tool.call.accepted facts, synthesize the missing
  // lifecycle entries as open calls so resume emits paired INTERRUPTED
  // results for every tool_call block. No missing call is executed.
  const terminalCallIds = new Set(completedResults.map(result => result.callId))
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    let receivedIndex = 0
    for (const block of message.content) {
      if (block.type !== 'tool_call') continue
      if (!terminalCallIds.has(block.id) && !accepted.has(block.id)) {
        accepted.set(block.id, {
          id: block.id,
          name: block.name,
          input: block.input,
          parentMessageId: message.id,
          receivedIndex,
        })
      }
      receivedIndex += 1
    }
  }

  // compute tail: events after the last snapshot for reducer replay
  const tailStartIndex = snapshotEnvelopeIndex >= 0 ? snapshotEnvelopeIndex + 1 : 0
  const tailEvents: FactEvent[] = []
  for (let i = tailStartIndex; i < envelopes.length; i++) {
    tailEvents.push(envelopes[i]!.event as FactEvent)
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
    envelopes,
    nextSeq: expectedSeq,
    lastEventId: envelopes.length > 0 ? envelopes[envelopes.length - 1]!.eventId : null,
    messages,
    openToolCalls: [...accepted.values()],
    completedResults,
    unmessagedResults: completedResults.filter(
      result => !messagedResultIds.has(result.callId),
    ),
    tasks: [...taskMap.values()],
    evidence: [...evidenceMap.values()],
    plans: [...planMap.values()],
    lastSnapshot,
    tailStartIndex,
    tailEvents,
  }
}
