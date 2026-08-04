import type {
  ModelError,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
} from './types.js'
import { ModelGatewayError } from './types.js'

export type ScriptedTurn =
  | { kind: 'message'; events: ModelStreamEvent[] }
  | { kind: 'error'; error: ModelError }

/** Helper to build a complete simple text turn. */
export function textTurn(text: string, stopReason = 'end_turn'): ScriptedTurn {
  return {
    kind: 'message',
    events: [
      { type: 'message_start', providerMessageId: 'scripted' },
      { type: 'text_delta', index: 0, text },
      { type: 'block_end', index: 0 },
      { type: 'message_end', stopReason },
    ],
  }
}

/** Helper to build a turn containing tool calls (with optional leading text). */
export function toolCallTurn(
  calls: Array<{ id: string; name: string; input: unknown }>,
  text?: string,
): ScriptedTurn {
  const events: ModelStreamEvent[] = [
    { type: 'message_start', providerMessageId: 'scripted' },
  ]
  let index = 0
  if (text) {
    events.push({ type: 'text_delta', index, text })
    events.push({ type: 'block_end', index })
    index += 1
  }
  for (const call of calls) {
    events.push({ type: 'tool_call_start', index, id: call.id, name: call.name })
    events.push({
      type: 'tool_call_input_delta',
      index,
      json: JSON.stringify(call.input),
    })
    events.push({ type: 'block_end', index })
    index += 1
  }
  events.push({ type: 'message_end', stopReason: 'tool_use' })
  return { kind: 'message', events }
}

/**
 * Deterministic fake model. Core logic must be testable without a real model.
 */
export class ScriptedModel implements ModelGateway {
  readonly provider = 'scripted'
  readonly modelId = 'scripted-model'
  readonly capabilities = { streaming: true, toolCalls: true, thinking: true }

  readonly requests: ModelRequest[] = []
  private cursor = 0

  constructor(private readonly turns: ScriptedTurn[]) {}

  get remainingTurns(): number {
    return this.turns.length - this.cursor
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    const next = this.turns[this.cursor]
    this.cursor += 1
    if (!next) {
      throw new ModelGatewayError(
        { code: 'UNKNOWN', retryable: false },
        'no scripted turn left',
      )
    }
    if (next.kind === 'error') {
      throw new ModelGatewayError(next.error)
    }
    for (const event of next.events) {
      if (signal.aborted) {
        throw new ModelGatewayError(
          { code: 'CONNECTION', retryable: true },
          'aborted',
        )
      }
      yield event
    }
  }

  classifyError(error: unknown): ModelError {
    if (error instanceof ModelGatewayError) return error.modelError
    return { code: 'UNKNOWN', retryable: false }
  }
}
