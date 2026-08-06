import { afterEach, describe, expect, test, vi } from 'vitest'
import { AnthropicProvider } from '../src/model/providers/anthropic.js'
import { OpenAICompatibleProvider } from '../src/model/providers/openaiCompatible.js'
import { parseSseStream } from '../src/model/providers/sse.js'
import type { ModelGateway, ModelRequest, ModelStreamEvent } from '../src/model/types.js'

const encoder = new TextEncoder()

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function sseResponse(events: unknown[], init?: ResponseInit): Response {
  const text = events
    .map(event => typeof event === 'string' ? event : JSON.stringify(event))
    .map(data => `data: ${data}\n\n`)
    .join('')
  return new Response(streamOf(text), { status: 200, ...init })
}

const request: ModelRequest = {
  system: 'system policy',
  messages: [
    {
      id: 'u1', sessionId: 's', parentId: null, role: 'user', turnId: 't1', createdAt: 't',
      content: [{ type: 'text', text: 'hello' }],
    },
    {
      id: 'a1', sessionId: 's', parentId: 'u1', role: 'assistant', turnId: 't1', createdAt: 't',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_call', id: 'call_old', name: 'Read', input: { path: 'a.ts' } },
      ],
    },
    {
      id: 'u2', sessionId: 's', parentId: 'a1', role: 'user', turnId: 't1', createdAt: 't',
      content: [{
        type: 'tool_result', callId: 'call_old', ok: true,
        content: { kind: 'text', text: 'file contents' },
      }],
    },
  ],
  tools: [{ name: 'Read', description: 'read a file', inputSchema: { type: 'object' } }],
  maxOutputTokens: 512,
  temperature: 0.1,
}

async function collect(
  gateway: ModelGateway,
  signal: AbortSignal = new AbortController().signal,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of gateway.stream(request, signal)) events.push(event)
  return events
}

afterEach(() => vi.unstubAllGlobals())

describe('SSE parser', () => {
  test('handles chunk boundaries, CRLF, event names and malformed fields', async () => {
    const body = streamOf(
      'event: content_block_delta\r\nda',
      'ta: {"x":1}\r\n\r\n: keep-alive\n\ndata: tail\n\n',
    )
    const events = []
    for await (const event of parseSseStream(body, new AbortController().signal)) {
      events.push(event)
    }
    expect(events).toEqual([
      { event: 'content_block_delta', data: '{"x":1}' },
      { event: undefined, data: 'tail' },
    ])
  })

  test('honours an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const events = []
    for await (const event of parseSseStream(streamOf('data: ignored\n\n'), controller.signal)) {
      events.push(event)
    }
    expect(events).toEqual([])
  })
})

describe('OpenAI-compatible provider', () => {
  test('decodes text, fragmented tool calls, usage and stop reason', async () => {
    const response = sseResponse([
      { choices: [{ delta: { content: 'hello ' } }] },
      { choices: [{ delta: { content: 'world', tool_calls: [{
        index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"path"' },
      }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.ts"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 7 } },
      { usage: { prompt_tokens: 12, completion_tokens: 7 } },
      'not-json',
      '[DONE]',
    ])
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => response)
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.test/v1/', apiKey: 'secret', model: 'model-x',
    })

    const events = await collect(provider)
    expect(events).toContainEqual({ type: 'message_start', providerMessageId: 'openai' })
    expect(events).toContainEqual({ type: 'text_delta', index: 0, text: 'hello ' })
    expect(events).toContainEqual({ type: 'tool_call_start', index: 1, id: 'call_1', name: 'Read' })
    expect(events.filter(event => event.type === 'tool_call_input_delta')).toHaveLength(2)
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 7 } })
    expect(events.at(-1)).toEqual({ type: 'message_end', stopReason: 'tool_calls' })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://example.test/v1/chat/completions')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer secret' })
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: expect.any(Array) }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_old' }),
    ]))
    expect(body.tools[0].function.name).toBe('Read')
  })

  test('connection and empty-body failures are classified', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const provider = new OpenAICompatibleProvider({ baseUrl: 'https://x', apiKey: 'k', model: 'm' })
    await expect(collect(provider)).rejects.toSatisfy(error =>
      provider.classifyError(error).code === 'CONNECTION',
    )

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    await expect(collect(provider)).rejects.toSatisfy(error =>
      provider.classifyError(error).code === 'CONNECTION',
    )
    expect(provider.classifyError(new Error('other'))).toEqual({ code: 'UNKNOWN', retryable: false })
  })
})

describe('Anthropic provider', () => {
  test('decodes text, thinking, tool JSON, usage and message end', async () => {
    const response = sseResponse([
      { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 9, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'reason' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool_1', name: 'Read' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 9, output_tokens: 6 } },
      { type: 'unknown_event' },
      'bad-json',
      { type: 'message_stop' },
    ])
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => response)
    vi.stubGlobal('fetch', fetchMock)
    const provider = new AnthropicProvider({ apiKey: 'secret', model: 'claude-test' })
    const events = await collect(provider)

    expect(events).toContainEqual({ type: 'message_start', providerMessageId: 'msg_1' })
    expect(events).toContainEqual({ type: 'text_delta', index: 0, text: 'hello' })
    expect(events).toContainEqual({ type: 'thinking_delta', index: 1, text: 'reason' })
    expect(events).toContainEqual({ type: 'tool_call_start', index: 2, id: 'tool_1', name: 'Read' })
    expect(events).toContainEqual({ type: 'tool_call_input_delta', index: 2, json: '{"path":"a.ts"}' })
    expect(events.at(-1)).toEqual({ type: 'message_end', stopReason: 'tool_use' })

    const [, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).headers).toMatchObject({
      'x-api-key': 'secret', 'anthropic-version': '2023-06-01',
    })
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.system).toBe('system policy')
    expect(body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant' }),
      expect.objectContaining({ role: 'user' }),
    ]))
  })

  test('stream error events use stable classifications', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([{
      type: 'error', error: { type: 'overloaded_error', message: 'busy' },
    }])))
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'm' })
    await expect(collect(provider)).rejects.toSatisfy(error =>
      provider.classifyError(error).code === 'OVERLOADED',
    )

    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([{
      type: 'error', error: { type: 'rate_limit_error', message: 'slow down' },
    }])))
    await expect(collect(provider)).rejects.toSatisfy(error =>
      provider.classifyError(error).code === 'RATE_LIMIT',
    )
  })
})

describe.each([
  ['OpenAI', () => new OpenAICompatibleProvider({ baseUrl: 'https://x', apiKey: 'k', model: 'm' })],
  ['Anthropic', () => new AnthropicProvider({ apiKey: 'k', model: 'm' })],
])('%s HTTP classification', (_name, createProvider) => {
  test.each([
    [401, 'AUTH', undefined],
    [429, 'RATE_LIMIT', 2000],
    [503, 'OVERLOADED', 2000],
    [500, 'CONNECTION', undefined],
  ])('HTTP %i -> %s', async (status, code, retryAfterMs) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider error', {
      status,
      headers: { 'retry-after': '2' },
    })))
    const provider = createProvider()
    let caught: unknown
    try {
      await collect(provider)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    expect(provider.classifyError(caught)).toMatchObject({
      code,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
  })
})
