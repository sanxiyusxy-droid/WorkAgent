import type { ConversationMessage, TokenUsage } from '../core/messages.js'
import { sanitize } from '../security/secrets.js'

/** Unified stream events. Provider adapters decode into these. */
export type ModelStreamEvent =
  | { type: 'message_start'; providerMessageId: string }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'thinking_delta'; index: number; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_input_delta'; index: number; json: string }
  | { type: 'block_end'; index: number }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'message_end'; stopReason?: string }

export interface ToolSchemaForModel {
  name: string
  description: string
  /** JSON schema object for the tool input */
  inputSchema: Record<string, unknown>
}

export interface ModelRequest {
  system: string
  messages: ConversationMessage[]
  tools: ToolSchemaForModel[]
  maxOutputTokens: number
  temperature?: number
}

/** Stable error classification. The loop never parses raw provider text. */
export type ModelError =
  | { code: 'RATE_LIMIT'; retryAfterMs?: number; retryable: true }
  | { code: 'OVERLOADED'; retryAfterMs?: number; retryable: true }
  | { code: 'AUTH'; retryable: boolean }
  | { code: 'PROMPT_TOO_LONG'; actual?: number; limit?: number; retryable: true }
  | { code: 'MAX_OUTPUT'; retryable: true }
  | { code: 'INVALID_REQUEST'; retryable: false }
  | { code: 'CONNECTION'; retryable: true }
  | { code: 'UNKNOWN'; retryable: false }

export class ModelGatewayError extends Error {
  constructor(readonly modelError: ModelError, message?: string) {
    // provider error bodies may echo credentials (auth failures, proxied
    // headers) — redact before the message can surface anywhere
    super(message !== undefined ? sanitize(message) : modelError.code)
    this.name = 'ModelGatewayError'
  }
}

export interface ModelGateway {
  readonly provider: string
  readonly modelId: string
  readonly capabilities: {
    streaming: boolean
    toolCalls: boolean
    thinking: boolean
  }

  stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent>

  classifyError(error: unknown): ModelError
}
