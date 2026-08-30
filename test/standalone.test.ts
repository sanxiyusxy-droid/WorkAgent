import { describe, expect, test } from 'vitest'
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helpText, parseArgs } from '../src/cli/args.js'
import {
  configCandidates,
  loadAgentConfigFile,
  loadModelConfigFile,
  modelConfigCandidates,
  saveUserConfig,
  userConfigPath,
} from '../src/app/config.js'

describe('argv parsing', () => {
  test('no arguments starts an interactive session', () => {
    const args = parseArgs([])
    expect(args.command).toBeUndefined()
    expect(args.print).toBeUndefined()
    expect(args.errors).toEqual([])
  })

  test('workspace directory flags', () => {
    expect(parseArgs(['-C', 'proj']).dir).toBe('proj')
    expect(parseArgs(['--dir', 'proj']).dir).toBe('proj')
    expect(parseArgs(['--dir=proj']).dir).toBe('proj')
  })

  test('`new <dir>` creates and enters a folder', () => {
    const args = parseArgs(['new', 'my-app'])
    expect(args.command).toBe('new')
    expect(args.dir).toBe('my-app')
    expect(parseArgs(['new']).errors[0]).toContain('requires a directory')
  })

  test('mode flag validates against the real mode list', () => {
    expect(parseArgs(['--mode', 'plan']).mode).toBe('plan')
    expect(parseArgs(['-y']).mode).toBe('acceptEdits')
    const bad = parseArgs(['--mode', 'turbo'])
    expect(bad.mode).toBeUndefined()
    expect(bad.errors[0]).toContain('unknown mode')
  })

  test('resume flags', () => {
    expect(parseArgs(['--session', 'ses_1']).session).toBe('ses_1')
    expect(parseArgs(['--continue']).continueLatest).toBe(true)
    expect(parseArgs(['-c']).continueLatest).toBe(true)
  })

  test('one-shot prompt via flag or bare positional', () => {
    expect(parseArgs(['-p', 'fix the bug']).print).toBe('fix the bug')
    expect(parseArgs(['add', 'a', 'readme']).print).toBe('add a readme')
  })

  test('unknown options are reported, never silently ignored', () => {
    const args = parseArgs(['--turbo-mode'])
    expect(args.errors).toEqual(['unknown option: --turbo-mode'])
  })

  test('missing values are reported', () => {
    expect(parseArgs(['--config']).errors[0]).toContain('requires a value')
    expect(parseArgs(['--mode', '--debug']).errors[0]).toContain('requires a value')
  })

  test('help and version short-circuit', () => {
    expect(parseArgs(['--help']).command).toBe('help')
    expect(parseArgs(['-v']).command).toBe('version')
    expect(parseArgs(['setup']).command).toBe('setup')
    const help = helpText('ca')
    expect(help).toContain('ca new <dir>')
    expect(help).toContain('RUNTIME CONFIG PRECEDENCE')
    expect(help).toContain('MODEL SOURCE PRECEDENCE')
    expect(help).toContain('user > workspace')
  })

  test('session listing is reachable as a flag and a sub-command', () => {
    expect(parseArgs(['--sessions']).command).toBe('sessions')
    expect(parseArgs(['--list-sessions']).command).toBe('sessions')
    expect(parseArgs(['sessions']).command).toBe('sessions')
    // and it is documented
    expect(helpText()).toContain('list resumable sessions')
  })
})

describe('config resolution', () => {
  test('candidate order puts explicit path first and install dir last', () => {
    const candidates = configCandidates({
      workspaceRoot: '/ws',
      explicit: '/custom/cfg.json',
      packageRoot: '/install',
    })
    expect(candidates[0]).toBe('/custom/cfg.json')
    expect(candidates.at(-1)).toBe(join('/install', 'agent.config.json'))
    // the workspace config outranks the user-level config
    const workspaceIndex = candidates.indexOf(join('/ws', 'agent.config.json'))
    const userIndex = candidates.indexOf(userConfigPath())
    expect(workspaceIndex).toBeLessThan(userIndex)
  })

  test('first existing candidate wins and reports its source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-cfg-'))
    try {
      const low = join(dir, 'low.json')
      const high = join(dir, 'high.json')
      await writeFile(low, JSON.stringify({ model: { model: 'low-model' } }), 'utf8')
      await writeFile(high, JSON.stringify({ model: { model: 'high-model' } }), 'utf8')

      const loaded = await loadAgentConfigFile([high, low])
      expect(loaded.model.model).toBe('high-model')
      expect(loaded.source).toBe(high)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('model candidates put user credentials ahead of workspace config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-model-home-'))
    const previousHome = process.env.CODE_AGENT_HOME
    const previousExplicit = process.env.AGENT_CONFIG
    process.env.CODE_AGENT_HOME = home
    delete process.env.AGENT_CONFIG
    try {
      const candidates = modelConfigCandidates({
        workspaceRoot: join(home, 'workspace'),
        explicit: join(home, 'explicit.json'),
        packageRoot: join(home, 'install'),
      })
      expect(candidates[0]).toBe(join(home, 'explicit.json'))
      expect(candidates.indexOf(userConfigPath())).toBeLessThan(
        candidates.indexOf(join(home, 'workspace', 'agent.config.json')),
      )
      expect(candidates.at(-1)).toBe(join(home, 'install', 'agent.config.json'))
    } finally {
      if (previousHome === undefined) delete process.env.CODE_AGENT_HOME
      else process.env.CODE_AGENT_HOME = previousHome
      if (previousExplicit === undefined) delete process.env.AGENT_CONFIG
      else process.env.AGENT_CONFIG = previousExplicit
      await rm(home, { recursive: true, force: true })
    }
  })

  test('model selection honors explicit, user, then project ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-model-order-'))
    const home = join(root, 'home')
    const workspace = join(root, 'workspace')
    const explicit = join(root, 'explicit.json')
    const previousHome = process.env.CODE_AGENT_HOME
    const previousEnvironmentConfig = process.env.AGENT_CONFIG
    process.env.CODE_AGENT_HOME = home
    delete process.env.AGENT_CONFIG
    try {
      await mkdir(home, { recursive: true })
      await mkdir(workspace, { recursive: true })
      await writeFile(explicit, JSON.stringify({ mode: 'plan' }), 'utf8')
      await writeFile(
        userConfigPath(),
        JSON.stringify({ model: { apiKey: 'user-key', model: 'user-model' } }),
        'utf8',
      )
      await writeFile(
        join(workspace, 'agent.config.json'),
        JSON.stringify({ model: { apiKey: 'project-key', model: 'project-model' } }),
        'utf8',
      )
      const candidates = modelConfigCandidates({ workspaceRoot: workspace, explicit })

      // Runtime-only explicit files are skipped for model ownership.
      expect(await loadModelConfigFile(candidates)).toMatchObject({
        source: userConfigPath(),
        model: { apiKey: 'user-key', model: 'user-model' },
      })

      // Any recognized explicit model field owns the whole (partial) bundle;
      // no key/model is borrowed from the lower user file.
      await writeFile(
        explicit,
        JSON.stringify({ model: { baseUrl: 'https://explicit.example/v1' } }),
        'utf8',
      )
      expect(await loadModelConfigFile(candidates)).toEqual({
        source: explicit,
        model: { baseUrl: 'https://explicit.example/v1' },
      })

      // With explicit and user files runtime-only, the project owns the model.
      await writeFile(explicit, JSON.stringify({ mode: 'plan' }), 'utf8')
      await writeFile(userConfigPath(), JSON.stringify({ debug: true }), 'utf8')
      expect(await loadModelConfigFile(candidates)).toMatchObject({
        source: join(workspace, 'agent.config.json'),
        model: { apiKey: 'project-key', model: 'project-model' },
      })
    } finally {
      if (previousHome === undefined) delete process.env.CODE_AGENT_HOME
      else process.env.CODE_AGENT_HOME = previousHome
      if (previousEnvironmentConfig === undefined) delete process.env.AGENT_CONFIG
      else process.env.AGENT_CONFIG = previousEnvironmentConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  test('runtime-only project config cannot shadow a lower model bundle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-model-select-'))
    try {
      const runtimeOnly = join(dir, 'project.json')
      const userModel = join(dir, 'user.json')
      await writeFile(
        runtimeOnly,
        JSON.stringify({ mode: 'plan', retrieval: { enabled: false } }),
        'utf8',
      )
      await writeFile(
        userModel,
        JSON.stringify({
          model: {
            provider: 'openai',
            apiKey: 'user-key',
            model: 'user-model',
            baseUrl: 'https://user.example/v1',
          },
        }),
        'utf8',
      )

      const runtime = await loadAgentConfigFile([runtimeOnly, userModel])
      const selectedModel = await loadModelConfigFile([runtimeOnly, userModel])
      expect(runtime.source).toBe(runtimeOnly)
      expect(runtime.layer.mode).toBe('plan')
      expect(selectedModel.source).toBe(userModel)
      expect(selectedModel.model.apiKey).toBe('user-key')
      expect(selectedModel.model.baseUrl).toBe('https://user.example/v1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('first partial model bundle owns the source without cross-file merging', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-model-atomic-'))
    try {
      const high = join(dir, 'high.json')
      const low = join(dir, 'low.json')
      await writeFile(
        high,
        JSON.stringify({ model: { baseUrl: 'https://high.example/v1' } }),
        'utf8',
      )
      await writeFile(
        low,
        JSON.stringify({ model: { apiKey: 'low-key', model: 'low-model' } }),
        'utf8',
      )

      const selected = await loadModelConfigFile([high, low])
      expect(selected).toEqual({
        source: high,
        model: { baseUrl: 'https://high.example/v1' },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('missing files fall through to an empty config', async () => {
    const loaded = await loadAgentConfigFile(['/definitely/not/here.json'])
    expect(loaded.model).toEqual({})
    expect(loaded.source).toBeUndefined()
  })

  test('an unreadable high-priority candidate never falls through', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-cfg-read-error-'))
    try {
      const lower = join(dir, 'lower.json')
      await writeFile(
        lower,
        JSON.stringify({ model: { apiKey: 'lower-key', model: 'lower-model' } }),
        'utf8',
      )
      await expect(loadModelConfigFile([dir, lower])).rejects.toThrow(
        /failed to read config file.*(?:EISDIR|EPERM|EACCES)/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.each([null, 'model-id', [], 42])(
    'a malformed high-priority model section fails closed: %j',
    async malformedModel => {
      const dir = await mkdtemp(join(tmpdir(), 'agent-cfg-model-shape-'))
      try {
        const high = join(dir, 'high.json')
        const low = join(dir, 'low.json')
        await writeFile(high, JSON.stringify({ model: malformedModel }), 'utf8')
        await writeFile(
          low,
          JSON.stringify({ model: { apiKey: 'low-key', model: 'low-model' } }),
          'utf8',
        )
        await expect(loadModelConfigFile([high, low])).rejects.toThrow(
          /model must be a JSON object/,
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  test('malformed config surfaces an error instead of failing silently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-cfg-'))
    try {
      const broken = join(dir, 'broken.json')
      const secretMarker = 'parser-context-must-not-leak'
      await writeFile(
        broken,
        `{ "model": { "apiKey": "${secretMarker}" }, broken }`,
        'utf8',
      )
      const rejection = loadAgentConfigFile([broken])
      await expect(rejection).rejects.toThrow(/failed to parse.*invalid JSON/)
      await expect(rejection).rejects.not.toThrow(secretMarker)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('user config is written to CODE_AGENT_HOME and merges with existing keys', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-home-'))
    const previous = process.env.CODE_AGENT_HOME
    process.env.CODE_AGENT_HOME = home
    try {
      // pre-existing unrelated preference must survive
      await mkdir(home, { recursive: true })
      await writeFile(
        userConfigPath(),
        JSON.stringify({ maxTurns: 12, model: { provider: 'openai' } }),
        'utf8',
      )

      const savedTo = await saveUserConfig({
        model: {
          provider: 'openai',
          apiKey: 'k',
          model: 'm',
          baseUrl: 'https://x/v1',
        },
        mode: 'acceptEdits',
      })
      expect(savedTo).toBe(userConfigPath())
      if (process.platform !== 'win32') {
        expect((await stat(savedTo)).mode & 0o777).toBe(0o600)
      }

      const loaded = await loadAgentConfigFile([savedTo])
      expect(loaded.model).toEqual({
        provider: 'openai',
        apiKey: 'k',
        model: 'm',
        baseUrl: 'https://x/v1',
      })
      expect(loaded.layer.maxTurns).toBe(12)
      expect(loaded.layer.mode).toBe('acceptEdits')

      // A provider switch replaces the complete route bundle; the old custom
      // base URL must not survive into native Anthropic configuration.
      await saveUserConfig({
        model: { provider: 'anthropic', apiKey: 'new-k', model: 'claude-test' },
      })
      const replaced = await loadAgentConfigFile([savedTo])
      expect(replaced.model).toEqual({
        provider: 'anthropic',
        apiKey: 'new-k',
        model: 'claude-test',
      })
      expect(replaced.layer.maxTurns).toBe(12)
      expect(replaced.layer.mode).toBe('acceptEdits')
    } finally {
      if (previous === undefined) delete process.env.CODE_AGENT_HOME
      else process.env.CODE_AGENT_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })
})
