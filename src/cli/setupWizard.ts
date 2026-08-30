import type { Interface as ReadlineInterface } from 'node:readline/promises'
import { saveUserConfig, type ModelFileConfig } from '../app/config.js'
import { rule, style, symbol } from './theme.js'
import { maskKey } from '../security/secrets.js'

interface Preset {
  label: string
  provider: 'openai' | 'anthropic'
  baseUrl?: string
  model: string
  keyHint: string
}

export type SecretQuestion = (prompt: string) => Promise<string>

/** Known OpenAI-compatible endpoints, plus Anthropic native. */
const PRESETS: Preset[] = [
  {
    label: 'DeepSeek',
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyHint: 'platform.deepseek.com',
  },
  {
    label: 'Qwen / 通义千问 (DashScope)',
    provider: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyHint: 'dashscope.console.aliyun.com',
  },
  {
    label: 'Kimi / Moonshot',
    provider: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-32k',
    keyHint: 'platform.moonshot.cn',
  },
  {
    label: 'GLM / 智谱',
    provider: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    keyHint: 'open.bigmodel.cn',
  },
  {
    label: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    keyHint: 'platform.openai.com',
  },
  {
    label: 'Anthropic Claude (native API)',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    keyHint: 'console.anthropic.com',
  },
  {
    label: 'Custom OpenAI-compatible endpoint',
    provider: 'openai',
    model: '',
    keyHint: 'your gateway',
  },
]

/**
 * Interactive first-run configuration. Writes credentials to the user-level
 * config so the agent works from any directory afterwards.
 */
export async function runSetupWizard(
  rl: ReadlineInterface,
  existing?: ModelFileConfig,
  askSecret?: SecretQuestion,
): Promise<{ model: ModelFileConfig; savedTo: string }> {
  if (!askSecret) {
    throw new Error('setup requires a non-echoing API-key prompt')
  }
  console.log(rule('setup'))
  console.log(
    style.gray(
      'Pick a model provider. The API key is stored in your user config,\n' +
        'not in the project folder.\n',
    ),
  )

  PRESETS.forEach((preset, index) => {
    console.log(
      `  ${style.cyan(String(index + 1))}) ${style.bold(preset.label)} ` +
        style.gray(preset.baseUrl ?? 'native API'),
    )
  })
  console.log('')

  let choice: Preset | undefined
  while (!choice) {
    const answer = (await rl.question(`  provider [1-${PRESETS.length}]: `)).trim()
    const index = Number(answer)
    if (Number.isInteger(index) && index >= 1 && index <= PRESETS.length) {
      choice = PRESETS[index - 1]
    } else {
      console.log(style.yellow(`  ${symbol.warn} enter a number between 1 and ${PRESETS.length}`))
    }
  }

  let baseUrl = choice.baseUrl
  if (choice.provider === 'openai') {
    const answer = (
      await rl.question(
        `  base URL${baseUrl ? ` [${baseUrl}]` : ''}: `,
      )
    ).trim()
    baseUrl = answer || baseUrl
    while (!baseUrl) {
      baseUrl = (await rl.question('  base URL (required): ')).trim()
    }
  }

  let model = choice.model
  {
    const answer = (
      await rl.question(`  model id${model ? ` [${model}]` : ''}: `)
    ).trim()
    model = answer || model
    while (!model) {
      model = (await rl.question('  model id (required): ')).trim()
    }
  }

  const previousKey = existing?.apiKey && existing.apiKey !== 'FILL_ME' ? existing.apiKey : undefined
  console.log(style.gray(`  get a key from ${choice.keyHint}`))
  if (previousKey) {
    console.log(style.gray(`  press Enter to keep the existing key (${maskKey(previousKey)})`))
  }
  let apiKey = (await askSecret('  API key: ')).trim()
  if (!apiKey && previousKey) apiKey = previousKey
  while (!apiKey) {
    apiKey = (await askSecret('  API key (required): ')).trim()
  }

  const model_: ModelFileConfig = {
    provider: choice.provider,
    ...(baseUrl ? { baseUrl } : {}),
    apiKey,
    model,
  }
  const savedTo = await saveUserConfig({ model: model_ })

  console.log('')
  console.log(style.green(`${symbol.ok} saved to ${savedTo}`))
  console.log(
    style.gray(
      `  provider ${model_.provider} · model ${model_.model} · key ${maskKey(apiKey)}`,
    ),
  )
  console.log(style.gray('  run `code-agent setup` again to change it.\n'))

  return { model: model_, savedTo }
}
