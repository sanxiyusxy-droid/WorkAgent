import type {
  ContentBlock,
  ConversationMessage,
  TokenUsage,
} from '../core/messages.js'
import { InvariantError } from '../core/messages.js'
import type { ModelStreamEvent } from './types.js'
import type { Clock, IdGenerator } from '../core/runtimePrimitives.js'

export interface AssembledTurn {
  message: ConversationMessage
  usage?: TokenUsage
  stopReason?: string
  /** count of tool_call blocks actually received — the only continue signal */
  toolCallCount: number
}

interface OpenBlock {
  kind: 'text' | 'thinking' | 'tool_call'
  text: string
  toolId?: string
  toolName?: string
  inputJson: string
  closed: boolean
}

/**
 * Assembles provider stream events into one immutable ConversationMessage.
 * - buffers incremental tool input JSON, parses it at block_end
 * - rejects duplicate tool call ids
 * - detects unclosed blocks at end of stream
 * - never trusts stopReason for control flow (recorded for diagnostics only)
 */
export class StreamAssembler {
  private readonly blocks = new Map<number, OpenBlock>()
  private readonly order: number[] = []
  private readonly seenToolIds = new Set<string>()
  private usage?: TokenUsage
  private stopReason?: string
  private ended = false

  constructor(
    private readonly deps: {
      ids: IdGenerator
      clock: Clock
      sessionId: string
      turnId: string
      parentId: string | null
      model: string
    },
  ) {}

  push(event: ModelStreamEvent): void {
    if (this.ended) {
      throw new InvariantError('stream_after_end', 'event after message_end')
    }
    switch (event.type) {
      case 'message_start':
        return
      case 'text_delta':
        this.open(event.index, 'text').text += event.text
        return
      case 'thinking_delta':
        this.open(event.index, 'thinking').text += event.text
        return
      case 'tool_call_start': {
        if (this.seenToolIds.has(event.id)) {
          throw new InvariantError(
            'unique_tool_call_id',
            `duplicate tool call id in stream: ${event.id}`,
          )
        }
        this.seenToolIds.add(event.id)
        const block = this.open(event.index, 'tool_call')
        block.toolId = event.id
        block.toolName = event.name
        return
      }
      case 'tool_call_input_delta':
        this.open(event.index, 'tool_call').inputJson += event.json
        return
      case 'block_end': {
        const block = this.blocks.get(event.index)
        if (block) block.closed = true
        return
      }
      case 'usage':
        this.usage = event.usage
        return
      case 'message_end':
        this.stopReason = event.stopReason
        this.ended = true
        return
    }
  }

  finish(): AssembledTurn {
    const content: ContentBlock[] = []
    let toolCallCount = 0

    for (const index of this.order) {
      const block = this.blocks.get(index)!
      if (!block.closed && !this.ended) {
        throw new InvariantError('unclosed_block', `block ${index} not closed`)
      }
      if (block.kind === 'text') {
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        continue
      }
      if (block.kind === 'thinking') {
        if (block.text.length > 0)
          content.push({ type: 'thinking', text: block.text })
        continue
      }
      // tool_call
      let input: unknown = {}
      const raw = block.inputJson.trim()
      if (raw.length > 0) {
        try {
          input = JSON.parse(raw)
        } catch {
          // Keep the raw string; schema validation downstream will produce
          // a structured, self-repairable tool error.
          input = { __malformedJson: raw }
        }
      }
      content.push({
        type: 'tool_call',
        id: block.toolId!,
        name: block.toolName!,
        input,
      })
      toolCallCount += 1
    }

    const message: ConversationMessage = {
      id: this.deps.ids.next('msg'),
      parentId: this.deps.parentId,
      sessionId: this.deps.sessionId,
      turnId: this.deps.turnId,
      role: 'assistant',
      content,
      createdAt: this.deps.clock.isoNow(),
      meta: { model: this.deps.model, usage: this.usage },
    }

    return {
      message,
      usage: this.usage,
      stopReason: this.stopReason,
      toolCallCount,
    }
  }

  private open(index: number, kind: OpenBlock['kind']): OpenBlock {
    let block = this.blocks.get(index)
    if (!block) {
      block = { kind, text: '', inputJson: '', closed: false }
      this.blocks.set(index, block)
      this.order.push(index)
    }
    return block
  }
}
