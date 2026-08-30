import type { ModelFileConfig } from './config.js'

export type ModelProvider = 'openai' | 'anthropic'

export interface ResolvedModelConfig {
  provider: ModelProvider
  apiKey: string
  model: string
  baseUrl?: string
  /** The credential bundle that owns provider/model/baseUrl. */
  source: 'environment' | 'file' | 'main-model'
}

type Environment = Readonly<Record<string, string | undefined>>

export class ModelConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelConfigurationError'
  }
}

const MAIN_ENV_KEYS = [
  'AGENT_API_KEY',
  'AGENT_MODEL',
  'AGENT_PROVIDER',
  'AGENT_BASE_URL',
] as const

const VERIFIER_ENV_KEYS = [
  'AGENT_VERIFIER_API_KEY',
  'AGENT_VERIFIER_MODEL',
  'AGENT_VERIFIER_PROVIDER',
  'AGENT_VERIFIER_BASE_URL',
] as const

function value(env: Environment, key: string): string | undefined {
  const raw = env[key]?.trim()
  return raw ? raw : undefined
}

function hasAny(env: Environment, keys: readonly string[]): boolean {
  return keys.some(key => value(env, key) !== undefined)
}

function provider(raw: string | undefined, label: string): ModelProvider {
  if (raw === undefined) return 'openai'
  if (raw === 'openai' || raw === 'anthropic') return raw
  throw new ModelConfigurationError(
    `${label} must be "openai" or "anthropic" (received an unsupported value)`,
  )
}

function endpoint(raw: string | undefined, label: string): string | undefined {
  if (!raw) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ModelConfigurationError(`${label} must be an absolute http(s) URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ModelConfigurationError(`${label} must use http or https`)
  }
  return raw
}

function requireBundleValue(
  raw: string | undefined,
  key: string,
  bundle: string,
): string {
  if (!raw || raw === 'FILL_ME') {
    throw new ModelConfigurationError(
      `${bundle} is atomic: set ${key} together with its credential and route fields`,
    )
  }
  return raw
}

function fileValue(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new ModelConfigurationError(`${label} must be a string`)
  }
  const trimmed = raw.trim()
  return trimmed || undefined
}

function hasFileModelField(file: ModelFileConfig): boolean {
  return ['provider', 'apiKey', 'model', 'baseUrl'].some(key =>
    Object.prototype.hasOwnProperty.call(file, key),
  )
}

/**
 * Resolve the main model without ever combining a credential from one trust
 * source with provider/model/baseUrl from another. Once any AGENT_* connection
 * variable is present, the complete environment bundle owns the connection
 * and file model fields are ignored.
 */
export function resolveMainModelConfig(
  file: ModelFileConfig,
  env: Environment = process.env,
  fileSource?: string,
): ResolvedModelConfig | null {
  if (hasAny(env, MAIN_ENV_KEYS)) {
    const apiKey = requireBundleValue(
      value(env, 'AGENT_API_KEY'),
      'AGENT_API_KEY',
      'environment model configuration',
    )
    const model = requireBundleValue(
      value(env, 'AGENT_MODEL'),
      'AGENT_MODEL',
      'environment model configuration',
    )
    return {
      provider: provider(value(env, 'AGENT_PROVIDER'), 'AGENT_PROVIDER'),
      apiKey,
      model,
      baseUrl: endpoint(value(env, 'AGENT_BASE_URL'), 'AGENT_BASE_URL'),
      source: 'environment',
    }
  }

  if (!hasFileModelField(file)) return null
  const apiKey = fileValue(file.apiKey, 'model.apiKey')
  const model = fileValue(file.model, 'model.model')
  if (!apiKey || apiKey === 'FILL_ME' || !model) {
    const source = fileSource ? ` in ${fileSource}` : ''
    throw new ModelConfigurationError(
      `file model configuration${source} is atomic: set both model.apiKey and model.model in the same file, or remove the incomplete model section and run \`code-agent setup\``,
    )
  }

  return {
    provider: provider(file.provider, 'model.provider'),
    apiKey,
    model,
    baseUrl: endpoint(fileValue(file.baseUrl, 'model.baseUrl'), 'model.baseUrl'),
    source: 'file',
  }
}

/**
 * Resolve the optional verifier. A model-only override may safely reuse the
 * exact main credential + route. Changing provider/baseUrl requires a complete
 * verifier-owned credential bundle, preventing the main key from being sent to
 * a different endpoint.
 */
export function resolveVerifierModelConfig(
  main: ResolvedModelConfig,
  env: Environment = process.env,
): ResolvedModelConfig | null {
  if (!hasAny(env, VERIFIER_ENV_KEYS)) return null

  const apiKey = value(env, 'AGENT_VERIFIER_API_KEY')
  const model = value(env, 'AGENT_VERIFIER_MODEL')
  const providerOverride = value(env, 'AGENT_VERIFIER_PROVIDER')
  const baseUrlOverride = value(env, 'AGENT_VERIFIER_BASE_URL')

  if (!apiKey) {
    if (providerOverride || baseUrlOverride) {
      throw new ModelConfigurationError(
        'changing verifier provider/base URL requires AGENT_VERIFIER_API_KEY; the main credential will not be forwarded to another route',
      )
    }
    if (!model) {
      throw new ModelConfigurationError(
        'verifier configuration requires AGENT_VERIFIER_MODEL',
      )
    }
    return { ...main, model, source: 'main-model' }
  }

  return {
    provider: provider(providerOverride, 'AGENT_VERIFIER_PROVIDER'),
    apiKey: requireBundleValue(
      apiKey,
      'AGENT_VERIFIER_API_KEY',
      'verifier environment configuration',
    ),
    model: requireBundleValue(
      model,
      'AGENT_VERIFIER_MODEL',
      'verifier environment configuration',
    ),
    baseUrl: endpoint(baseUrlOverride, 'AGENT_VERIFIER_BASE_URL'),
    source: 'environment',
  }
}
