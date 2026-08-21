import { renderModelToolResult } from '../../tools/ToolOutputStore.js'
import type {
  ModelError,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
} from '../types.js'
import { ModelGatewayError } from '../types.js'
import { parseSseStream } from './sse.js'

export interface AnthropicOptions {
  baseUrl?: string
  apiKey: string
  model: string
  anthropicVersion?: string
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

function encodeMessages(request: ModelRequest): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const message of request.messages) {
    if (message.role === 'system') continue

    const blocks: AnthropicBlock[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool_call') {
        blocks.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        })
      } else if (block.type === 'tool_result') {
        blocks.push({
          type: 'tool_result',
          tool_use_id: block.callId,
          content: renderModelToolResult({
            content: block.content,
            observation: block.observation,
          }),
          ...(block.ok ? {} : { is_error: true }),
        })
      }
      // thinking blocks are not replayed to the API
    }
    if (blocks.length === 0) continue
    out.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: blocks,
    })
  }
  return out
}

/** Anthropic Messages API provider. SDK-free: plain fetch + SSE. */
export class AnthropicProvider implements ModelGateway {
  readonly provider = 'anthropic'
  readonly modelId: string
  readonly capabilities = { streaming: true, toolCalls: true, thinking: true }

  constructor(private readonly options: AnthropicOptions) {
    this.modelId = options.model
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    let response: Response
    try {
      response = await fetch(
        `${(this.options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.options.apiKey,
            'anthropic-version': this.options.anthropicVersion ?? '2023-06-01',
          },
          body: JSON.stringify({
            model: this.options.model,
            stream: true,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: encodeMessages(request),
            ...(request.tools.length > 0
              ? {
                  tools: request.tools.map(tool => ({
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.inputSchema,
                  })),
                }
              : {}),
          }),
          signal,
        },
      )
    } catch (error) {
      throw new ModelGatewayError(
        { code: 'CONNECTION', retryable: true },
        (error as Error).message,
      )
    }

    if (!response.ok) {
      throw await this.httpError(response)
    }
    if (!response.body) {
      throw new ModelGatewayError(
        { code: 'CONNECTION', retryable: true },
        'empty response body',
      )
    }

    let stopReason: string | undefined

    for await (const chunk of parseSseStream(response.body, signal)) {
      let parsed: any
      try {
        parsed = JSON.parse(chunk.data)
      } catch {
        continue
      }

      switch (parsed.type) {
        case 'message_start':
          yield {
            type: 'message_start',
            providerMessageId: parsed.message?.id ?? 'anthropic',
          }
          if (parsed.message?.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: parsed.message.usage.input_tokens ?? 0,
                outputTokens: parsed.message.usage.output_tokens ?? 0,
              },
            }
          }
          break
        case 'content_block_start': {
          const block = parsed.content_block
          if (block?.type === 'tool_use') {
            yield {
              type: 'tool_call_start',
              index: parsed.index,
              id: block.id,
              name: block.name,
            }
          }
          break
        }
        case 'content_block_delta': {
          const delta = parsed.delta
          if (delta?.type === 'text_delta') {
            yield { type: 'text_delta', index: parsed.index, text: delta.text }
          } else if (delta?.type === 'thinking_delta') {
            yield {
              type: 'thinking_delta',
              index: parsed.index,
              text: delta.thinking,
            }
          } else if (delta?.type === 'input_json_delta') {
            yield {
              type: 'tool_call_input_delta',
              index: parsed.index,
              json: delta.partial_json,
            }
          }
          break
        }
        case 'content_block_stop':
          yield { type: 'block_end', index: parsed.index }
          break
        case 'message_delta':
          if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason
          if (parsed.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: parsed.usage.input_tokens ?? 0,
                outputTokens: parsed.usage.output_tokens ?? 0,
              },
            }
          }
          break
        case 'message_stop':
          yield { type: 'message_end', stopReason }
          break
        case 'error':
          throw new ModelGatewayError(
            this.classifyApiError(parsed.error?.type ?? '', parsed.error?.message ?? ''),
            parsed.error?.message,
          )
        default:
          break
      }
    }
  }

  classifyError(error: unknown): ModelError {
    if (error instanceof ModelGatewayError) return error.modelError
    return { code: 'UNKNOWN', retryable: false }
  }

  private classifyApiError(type: string, message: string): ModelError {
    if (type === 'overloaded_error') return { code: 'OVERLOADED', retryable: true }
    if (type === 'rate_limit_error') return { code: 'RATE_LIMIT', retryable: true }
    if (/prompt is too long/i.test(message)) {
      return { code: 'PROMPT_TOO_LONG', retryable: true }
    }
    return { code: 'UNKNOWN', retryable: false }
  }

  private async httpError(response: Response): Promise<ModelGatewayError> {
    const body = await response.text().catch(() => '')
    const retryAfterHeader = response.headers.get('retry-after')
    const retryAfterMs = retryAfterHeader
      ? Number(retryAfterHeader) * 1000
      : undefined

    if (response.status === 429) {
      return new ModelGatewayError(
        { code: 'RATE_LIMIT', retryAfterMs, retryable: true }, body,
      )
    }
    if (response.status === 401 || response.status === 403) {
      return new ModelGatewayError({ code: 'AUTH', retryable: false }, body)
    }
    if (response.status === 529 || response.status === 503) {
      return new ModelGatewayError(
        { code: 'OVERLOADED', retryAfterMs, retryable: true }, body,
      )
    }
    if (response.status >= 500) {
      return new ModelGatewayError({ code: 'CONNECTION', retryable: true }, body)
    }
    if (response.status === 400 && /prompt is too long|too many tokens/i.test(body)) {
      return new ModelGatewayError({ code: 'PROMPT_TOO_LONG', retryable: true }, body)
    }
    return new ModelGatewayError({ code: 'INVALID_REQUEST', retryable: false }, body)
  }
}
