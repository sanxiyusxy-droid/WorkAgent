import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentMode } from '../core/events.js'
import type { PermissionRule } from '../policy/PolicyEngine.js'
import type { ContextBudgetConfig } from '../context/ContextManager.js'

/** One overridable configuration layer. All fields optional. */
export interface ConfigLayer {
  mode?: AgentMode
  maxTurns?: number
  maxModelCalls?: number
  maxToolCalls?: number
  maxWallTimeMs?: number
  maxOutputTokens?: number
  projectInstructions?: string
  rules?: PermissionRule[]
  verification?: {
    enabled?: boolean
    riskThreshold?: number
    maxRepairAttempts?: number
  }
  context?: Partial<ContextBudgetConfig> & { enabled?: boolean }
}

export interface ConfigLayers {
  /** organization-managed policy — highest priority, deny rules immovable */
  managed?: ConfigLayer
  /** explicit CLI arguments / environment overrides */
  cli?: ConfigLayer
  /** project config file (agent.config.json in workspace) */
  project?: ConfigLayer
  /** user-level config */
  user?: ConfigLayer
}

export interface EffectiveConfig {
  mode: AgentMode
  maxTurns: number
  maxModelCalls: number
  maxToolCalls: number
  maxWallTimeMs: number
  maxOutputTokens: number
  projectInstructions?: string
  rules: PermissionRule[]
  verification: {
    enabled: boolean
    riskThreshold: number
    maxRepairAttempts: number
  }
  context: Partial<ContextBudgetConfig> & { enabled?: boolean }
  /** sha256 of the effective config — written into run.started */
  configHash: string
}

const DEFAULTS = {
  mode: 'default' as AgentMode,
  maxTurns: 40,
  maxModelCalls: 60,
  maxToolCalls: 200,
  maxWallTimeMs: 30 * 60_000,
  maxOutputTokens: 4096,
  verification: { enabled: true, riskThreshold: 5, maxRepairAttempts: 1 },
  context: {} as EffectiveConfig['context'],
}

/**
 * Merge priority (guide §16): managed > cli > project > user > defaults.
 * Managed deny rules cannot be removed or overridden by lower layers:
 * they are always present and evaluated first (the policy engine already
 * guarantees deny beats broader allow).
 */
export function mergeConfig(layers: ConfigLayers): EffectiveConfig {
  // low -> high priority for scalar merging
  const order: ConfigLayer[] = [
    layers.user ?? {},
    layers.project ?? {},
    layers.cli ?? {},
    layers.managed ?? {},
  ]

  const pick = <K extends keyof ConfigLayer>(key: K): ConfigLayer[K] | undefined => {
    let value: ConfigLayer[K] | undefined
    for (const layer of order) {
      if (layer[key] !== undefined) value = layer[key]
    }
    return value
  }

  // rules: managed deny rules first (immovable), then the rest in
  // priority order; lower layers may add but never displace managed denies.
  const managedRules = layers.managed?.rules ?? []
  const managedDenies = managedRules.filter(r => r.effect === 'deny')
  const otherRules = [
    ...managedRules.filter(r => r.effect !== 'deny'),
    ...(layers.cli?.rules ?? []),
    ...(layers.project?.rules ?? []),
    ...(layers.user?.rules ?? []),
  ]

  const verification = {
    ...DEFAULTS.verification,
    ...(layers.user?.verification ?? {}),
    ...(layers.project?.verification ?? {}),
    ...(layers.cli?.verification ?? {}),
    ...(layers.managed?.verification ?? {}),
  }

  const context = {
    ...(layers.user?.context ?? {}),
    ...(layers.project?.context ?? {}),
    ...(layers.cli?.context ?? {}),
    ...(layers.managed?.context ?? {}),
  }

  const effective: Omit<EffectiveConfig, 'configHash'> = {
    mode: pick('mode') ?? DEFAULTS.mode,
    maxTurns: pick('maxTurns') ?? DEFAULTS.maxTurns,
    maxModelCalls: pick('maxModelCalls') ?? DEFAULTS.maxModelCalls,
    maxToolCalls: pick('maxToolCalls') ?? DEFAULTS.maxToolCalls,
    maxWallTimeMs: pick('maxWallTimeMs') ?? DEFAULTS.maxWallTimeMs,
    maxOutputTokens: pick('maxOutputTokens') ?? DEFAULTS.maxOutputTokens,
    projectInstructions: pick('projectInstructions'),
    rules: [...managedDenies, ...otherRules],
    verification,
    context,
  }

  return {
    ...effective,
    configHash: createHash('sha256')
      .update(JSON.stringify(effective))
      .digest('hex')
      .slice(0, 16),
  }
}

/** Load `agent.config.json` from the workspace root, if present. */
export async function loadProjectConfigLayer(
  workspaceRoot: string,
): Promise<ConfigLayer> {
  const file = await loadAgentConfigFile([join(workspaceRoot, 'agent.config.json')])
  return file.layer
}

/** Model credentials section of the agent config file. */
export interface ModelFileConfig {
  provider?: 'openai' | 'anthropic'
  baseUrl?: string
  apiKey?: string
  model?: string
}

/** Full agent.config.json shape: runtime layer + model credentials + CLI prefs. */
export interface AgentFileConfig {
  layer: ConfigLayer
  model: ModelFileConfig
  debug?: boolean
  sessionId?: string
  /** which file was actually loaded (diagnostics) */
  source?: string
}

/**
 * Load the first existing config file from the candidate paths.
 * The file may contain:
 *   { "model": {...credentials}, "mode": ..., "maxTurns": ..., "debug": true, ... }
 * Unknown keys are ignored; a broken file falls back to empty config.
 */
export async function loadAgentConfigFile(
  candidates: string[],
): Promise<AgentFileConfig> {
  for (const path of candidates) {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const { model, debug, sessionId, ...rest } = parsed
      return {
        layer: rest as ConfigLayer,
        model: (model ?? {}) as ModelFileConfig,
        debug: typeof debug === 'boolean' ? debug : undefined,
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
        source: path,
      }
    } catch (error) {
      // a malformed config must be visible, not silently ignored
      throw new Error(
        `failed to parse config file ${path}: ${(error as Error).message}`,
      )
    }
  }
  return { layer: {}, model: {} }
}

/** Directory holding the user-level config, overridable for tests. */
export function userConfigDir(): string {
  return process.env.CODE_AGENT_HOME ?? join(homedir(), '.code-agent')
}

export function userConfigPath(): string {
  return join(userConfigDir(), 'config.json')
}

/**
 * Config file lookup order (first match wins), highest priority first:
 *   1. explicit --config path
 *   2. project-local agent.config.json in the workspace
 *   3. user-level config written by the setup wizard
 *   4. the installation directory (dev checkout convenience)
 */
export function configCandidates(input: {
  workspaceRoot: string
  explicit?: string
  packageRoot?: string
}): string[] {
  return [
    input.explicit,
    process.env.AGENT_CONFIG,
    join(input.workspaceRoot, 'agent.config.json'),
    userConfigPath(),
    input.packageRoot ? join(input.packageRoot, 'agent.config.json') : undefined,
  ].filter((path): path is string => Boolean(path))
}

/**
 * Persist credentials + preferences to the user-level config so the agent
 * works from any directory without environment variables.
 */
export async function saveUserConfig(data: {
  model: ModelFileConfig
  mode?: AgentMode
  debug?: boolean
}): Promise<string> {
  const path = userConfigPath()
  await mkdir(dirname(path), { recursive: true })

  // preserve unrelated keys if the file already exists
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    // no previous config
  }

  const merged = {
    ...existing,
    model: { ...((existing.model as object) ?? {}), ...data.model },
    ...(data.mode ? { mode: data.mode } : {}),
    ...(data.debug !== undefined ? { debug: data.debug } : {}),
  }
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  // the file holds an API key: restrict permissions where the OS supports it
  try {
    await chmod(path, 0o600)
  } catch {
    // best effort (Windows ACLs differ)
  }
  return path
}
