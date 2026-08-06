import { configCandidates, loadAgentConfigFile } from '../src/app/config.js'
import { AnthropicProvider } from '../src/model/providers/anthropic.js'
import type { ModelRequest, ModelStreamEvent } from '../src/model/types.js'

const file = await loadAgentConfigFile(configCandidates({
  workspaceRoot: process.cwd(),
  packageRoot: process.cwd(),
}))
const providerName = process.env.AGENT_PROVIDER ?? file.model.provider
const apiKey = process.env.AGENT_API_KEY ?? file.model.apiKey
const model = process.env.AGENT_MODEL ?? file.model.model
const baseUrl = process.env.AGENT_BASE_URL ?? file.model.baseUrl

if (providerName !== 'anthropic' || !apiKey || apiKey === 'FILL_ME' || !model) {
  console.error(
    'Anthropic smoke test skipped: configure provider=anthropic, apiKey and model ' +
    'in ~/.code-agent/config.json or AGENT_PROVIDER/AGENT_API_KEY/AGENT_MODEL.',
  )
  process.exitCode = 2
} else {
  const gateway = new AnthropicProvider({ apiKey, model, baseUrl })
  const request: ModelRequest = {
    system: 'This is a provider connectivity test. Follow the user instruction exactly.',
    messages: [{
      id: 'smoke_user',
      parentId: null,
      sessionId: 'smoke',
      turnId: 'smoke',
      role: 'user',
      content: [{ type: 'text', text: 'Reply with exactly OK.' }],
      createdAt: new Date().toISOString(),
      meta: { source: 'human' },
    }],
    tools: [],
    maxOutputTokens: 16,
    temperature: 0,
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  const events: ModelStreamEvent[] = []
  try {
    for await (const event of gateway.stream(request, controller.signal)) {
      events.push(event)
    }
    const types = new Set(events.map(event => event.type))
    if (!types.has('message_start') || !types.has('text_delta') || !types.has('message_end')) {
      throw new Error(`incomplete Anthropic stream: ${[...types].join(', ')}`)
    }
    console.log(
      `Anthropic smoke passed: model=${model}; events=${events.length}; ` +
      `usage=${types.has('usage') ? 'reported' : 'not reported'}`,
    )
  } finally {
    clearTimeout(timeout)
  }
}
