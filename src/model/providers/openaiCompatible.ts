import type { ConversationMessage } from '../../core/messages.js'
import { renderText } from '../../tools/ToolOutputStore.js'
import type {
  ModelError,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
} from '../types.js'
import { ModelGatewayError } from '../types.js'
import { parseSseStream } from './sse.js'

export interface OpenAICompatibleOptions {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

function encodeMessages(request: ModelRequest): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: 'system', content: request.system }]

  for (const message of request.messages) {
    if (message.role === 'user') {
      const toolResults = message.content.filter(b => b.type === 'tool_result')
      if (toolResults.length > 0) {
        for (const block of toolResults) {
          if (block.type !== 'tool_result') continue
          out.push({
            role: 'tool',
            tool_call_id: block.callId,
            content: renderText(block.content),
          })
        }
        continue
      }
      const text = message.content
        .filter(b => b.type === 'text')
        .map(b => (b.type === 'text' ? b.text : ''))
        .join('\n')
      out.push({ role: 'user', content: text })
      continue
    }

    if (message.role === 'assistant') {
      const text = message.content
        .filter(b => b.type === 'text')
        .map(b => (b.type === 'text' ? b.text : ''))
        .join('\n')
      const toolCalls = message.content
        .filter(b => b.type === 'tool_call')
        .map(b =>
          b.type === 'tool_call'
            ? {
                id: b.id,
                type: 'function' as const,
                function: { name: b.name, arguments: JSON.stringify(b.input) },
              }
            : null,
        )
        .filter((v): v is NonNullable<typeof v> => v !== null)
      out.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }

    // system messages inside history are folded into user turns
    const text = message.content
      .filter(b => b.type === 'text')
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('\n')
    out.push({ role: 'user', content: text })
  }
  return out
}

/**
 * OpenAI Chat Completions compatible provider (works with DeepSeek, Qwen,
 * Kimi, GLM and most gateways). SDK-free: plain fetch + SSE.
 */
export class OpenAICompatibleProvider implements ModelGateway {
  readonly provider = 'openai-compatible'
  readonly modelId: string
  readonly capabilities = { streaming: true, toolCalls: true, thinking: false }

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.modelId = options.model
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    let response: Response
    try {
      response = await fetch(
        `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({
            model: this.options.model,
            stream: true,
            max_tokens: request.maxOutputTokens,
            temperature: request.temperature ?? this.options.temperature,
            messages: encodeMessages(request),
            ...(request.tools.length > 0
              ? {
                  tools: request.tools.map(tool => ({
                    type: 'function',
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema,
                    },
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

    yield { type: 'message_start', providerMessageId: 'openai' }

    // OpenAI tool_calls carry their own index; text lives at block 0.
    const toolBlockBase = 1
    const startedToolBlocks = new Set<number>()
    let sawText = false
    let stopReason: string | undefined

    for await (const chunk of parseSseStream(response.body, signal)) {
      if (chunk.data === '[DONE]') break
      let parsed: any
      try {
        parsed = JSON.parse(chunk.data)
      } catch {
        continue
      }
      const choice = parsed.choices?.[0]
      if (!choice) {
        if (parsed.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: parsed.usage.prompt_tokens ?? 0,
              outputTokens: parsed.usage.completion_tokens ?? 0,
            },
          }
        }
        continue
      }
      const delta = choice.delta ?? {}

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        sawText = true
        yield { type: 'text_delta', index: 0, text: delta.content }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          const blockIndex = toolBlockBase + (toolCall.index ?? 0)
          if (!startedToolBlocks.has(blockIndex)) {
            startedToolBlocks.add(blockIndex)
            yield {
              type: 'tool_call_start',
              index: blockIndex,
              id: toolCall.id ?? `call_${blockIndex}`,
              name: toolCall.function?.name ?? 'unknown',
            }
          }
          const args = toolCall.function?.arguments
          if (typeof args === 'string' && args.length > 0) {
            yield { type: 'tool_call_input_delta', index: blockIndex, json: args }
          }
        }
      }
      if (choice.finish_reason) {
        stopReason = choice.finish_reason
      }
      if (parsed.usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
          },
        }
      }
    }

    if (sawText) yield { type: 'block_end', index: 0 }
    for (const blockIndex of startedToolBlocks) {
      yield { type: 'block_end', index: blockIndex }
    }
    yield { type: 'message_end', stopReason }
  }

  classifyError(error: unknown): ModelError {
    if (error instanceof ModelGatewayError) return error.modelError
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
    if (response.status === 503 || response.status === 529) {
      return new ModelGatewayError(
        { code: 'OVERLOADED', retryAfterMs, retryable: true }, body,
      )
    }
    if (response.status >= 500) {
      return new ModelGatewayError({ code: 'CONNECTION', retryable: true }, body)
    }
    if (
      response.status === 400 &&
      /context.length|maximum.*tokens|too long/i.test(body)
    ) {
      return new ModelGatewayError(
        { code: 'PROMPT_TOO_LONG', retryable: true }, body,
      )
    }
    return new ModelGatewayError(
      { code: 'INVALID_REQUEST', retryable: false }, body,
    )
  }
}
