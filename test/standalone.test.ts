import { describe, expect, test } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helpText, parseArgs } from '../src/cli/args.js'
import {
  configCandidates,
  loadAgentConfigFile,
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
    expect(helpText('ca')).toContain('ca new <dir>')
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

  test('missing files fall through to an empty config', async () => {
    const loaded = await loadAgentConfigFile(['/definitely/not/here.json'])
    expect(loaded.model).toEqual({})
    expect(loaded.source).toBeUndefined()
  })

  test('malformed config surfaces an error instead of failing silently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-cfg-'))
    try {
      const broken = join(dir, 'broken.json')
      await writeFile(broken, '{ not json', 'utf8')
      await expect(loadAgentConfigFile([broken])).rejects.toThrow(/failed to parse/)
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
        model: { apiKey: 'k', model: 'm', baseUrl: 'https://x/v1' },
        mode: 'acceptEdits',
      })
      expect(savedTo).toBe(userConfigPath())

      const loaded = await loadAgentConfigFile([savedTo])
      expect(loaded.model).toEqual({
        provider: 'openai',
        apiKey: 'k',
        model: 'm',
        baseUrl: 'https://x/v1',
      })
      expect(loaded.layer.maxTurns).toBe(12)
      expect(loaded.layer.mode).toBe('acceptEdits')
    } finally {
      if (previous === undefined) delete process.env.CODE_AGENT_HOME
      else process.env.CODE_AGENT_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })
})
