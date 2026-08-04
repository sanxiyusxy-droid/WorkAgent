import { describe, expect, test } from 'vitest'
import {
  assemblePrompt,
  renderEnvironmentSection,
  type EnvironmentInfo,
} from '../src/prompt/PromptAssembler.js'
import { parseCommand, findCommand, commandNames, MODES, type CommandContext } from '../src/cli/commands.js'
import { mergeConfig } from '../src/app/config.js'
import { MetricsCollector } from '../src/observability/metrics.js'
import { summarizeToolInput } from '../src/cli/render.js'
import { ReadTool } from '../src/tools/builtin/ReadTool.js'
import { textTurn } from '../src/model/ScriptedModel.js'
import { collectRun, makeWorld, stateWithUser } from './helpers.js'

const WIN_ENV: EnvironmentInfo = {
  provider: 'openai-compatible',
  modelId: 'deepseek-chat',
  platform: 'win32',
  shell: 'cmd.exe',
  workspaceRoot: 'C:/ws',
  today: '2026-07-31',
}

describe('environment / identity section', () => {
  test('states the real provider and model id and forbids impersonation', () => {
    const text = renderEnvironmentSection(WIN_ENV)
    expect(text).toContain('deepseek-chat')
    expect(text).toContain('openai-compatible')
    expect(text).toContain('Never claim to be a different model')
  })

  test('gives platform-correct shell hints', () => {
    const win = renderEnvironmentSection(WIN_ENV)
    expect(win).toContain('`dir` (not `ls`)')
    expect(win).toContain('`pwd`, `ls`, `grep` are NOT available')

    const posix = renderEnvironmentSection({ ...WIN_ENV, platform: 'linux', shell: '/bin/bash' })
    expect(posix).toContain('POSIX shell')
    expect(posix).not.toContain('`dir` (not `ls`)')
  })

  test('is injected into the system prompt right after the core rules', () => {
    const request = assemblePrompt({
      mode: 'default',
      messages: [],
      tools: [ReadTool],
      maxOutputTokens: 100,
      environment: WIN_ENV,
    })
    expect(request.system).toContain('You are a coding agent')
    expect(request.system.indexOf('Environment:')).toBeGreaterThan(
      request.system.indexOf('You are a coding agent'),
    )
    expect(request.system).toContain('Workspace root: C:/ws')
  })

  test('runtime supplies identity automatically (real model id reaches the prompt)', async () => {
    const world = await makeWorld({ turns: [textTurn('hi')] })
    try {
      await collectRun(world.runtime.engine, await stateWithUser(world, 'who are you?'))
      const system = world.model.requests[0]!.system
      expect(system).toContain(world.runtime.model.modelId)
      expect(system).toContain(world.runtime.model.provider)
      expect(system).toContain('Operating system:')
    } finally {
      await world.cleanup()
    }
  })
})

describe('slash command parsing', () => {
  test('distinguishes commands from normal prompts', () => {
    expect(parseCommand('hello world')).toBeNull()
    expect(parseCommand('/help')).toEqual({ name: 'help', args: [] })
    expect(parseCommand('/mode plan')).toEqual({ name: 'mode', args: ['plan'] })
    expect(parseCommand('  /x')).toBeNull() // must start with a slash
  })

  test('supports aliases and case-insensitive names', () => {
    expect(parseCommand('/QUIT')).toEqual({ name: 'exit', args: [] })
    expect(parseCommand('/q')).toEqual({ name: 'exit', args: [] })
    expect(parseCommand('/?')).toEqual({ name: 'help', args: [] })
  })

  test('every advertised command resolves to a handler', () => {
    for (const name of commandNames()) {
      expect(findCommand(name.slice(1)), name).toBeDefined()
    }
    expect(findCommand('nonexistent')).toBeUndefined()
  })

  test('all permission modes are switchable from the CLI', () => {
    expect(MODES).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'dontAsk',
      'bypassPermissions',
    ])
  })
})

describe('tool activity summaries', () => {
  test.each([
    ['Read', { path: 'src/a.ts' }, 'src/a.ts'],
    ['Grep', { pattern: 'foo', glob: '*.ts' }, 'foo in *.ts'],
    ['Shell', { command: 'npm test' }, 'npm test'],
    ['TaskUpdate', { id: 'task_1', status: 'completed' }, 'task_1'],
    ['ApplyPatch', { edits: [1, 2], creates: [3] }, '2 edit(s), 1 new file(s)'],
  ])('%s renders a compact summary', (name, input, expected) => {
    expect(summarizeToolInput(name, input)).toContain(expected)
  })

  test('long commands are truncated to one line', () => {
    const summary = summarizeToolInput('Shell', { command: 'x'.repeat(500) })
    expect(summary.length).toBeLessThanOrEqual(64)
    expect(summary).not.toContain('\n')
  })
})

describe('command handlers execute against a real runtime', () => {
  async function harness() {
    const world = await makeWorld({ turns: [textTurn('ok')] })
    let state = await stateWithUser(world, 'hello')
    let debug = false
    let exited = false
    const output: string[] = []
    const ctx = (): CommandContext => ({
      runtime: world.runtime,
      state,
      effective: mergeConfig({}),
      metrics: new MetricsCollector(),
      configSource: 'test',
      debug,
      print: text => output.push(text),
      setState: next => {
        state = next
      },
      setDebug: next => {
        debug = next
      },
      requestExit: () => {
        exited = true
      },
    })
    const run = async (line: string) => {
      const parsed = parseCommand(line)
      if (!parsed) throw new Error(`not a command: ${line}`)
      const handler = findCommand(parsed.name)
      if (!handler) throw new Error(`no handler: ${parsed.name}`)
      await handler.run(ctx(), parsed.args)
    }
    return {
      world,
      run,
      output,
      getState: () => state,
      getDebug: () => debug,
      wasExit: () => exited,
    }
  }

  test('/help lists every command', async () => {
    const h = await harness()
    try {
      await h.run('/help')
      const text = h.output.join('\n')
      for (const name of commandNames()) {
        expect(text).toContain(name)
      }
    } finally {
      await h.world.cleanup()
    }
  })

  test('/mode switches state and records prePlanMode', async () => {
    const h = await harness()
    try {
      await h.run('/mode plan')
      expect(h.getState().mode).toBe('plan')
      expect(h.getState().prePlanMode).toBe('default')

      await h.run('/mode default')
      expect(h.getState().mode).toBe('default')
      expect(h.getState().prePlanMode).toBeUndefined()

      await h.run('/mode nonsense')
      expect(h.output.join('\n')).toContain('unknown mode')
      expect(h.getState().mode).toBe('default')
    } finally {
      await h.world.cleanup()
    }
  })

  test('/mode tells the model about the change (regression: silent switch)', async () => {
    const h = await harness()
    /** text of the last message, for asserting the injected notice */
    const lastText = (): string => {
      const message = h.getState().messages.at(-1)!
      return message.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('')
    }
    try {
      const before = h.getState().messages.length

      await h.run('/mode plan')
      expect(h.getState().messages.length).toBe(before + 1)
      expect(h.getState().messages.at(-1)!.meta?.source).toBe('engine')
      expect(lastText()).toContain('-> plan')
      expect(lastText()).toContain('PlanPropose')

      await h.run('/mode default')
      // without this the model keeps believing it is still in plan mode
      expect(lastText()).toContain('plan -> default')
      expect(lastText()).toContain('retry it now')
    } finally {
      await h.world.cleanup()
    }
  })

  test('/tools reports what the model can actually call in each mode', async () => {
    const h = await harness()
    try {
      await h.run('/tools')
      const inDefault = h.output.join('\n')
      expect(inDefault).toContain('Write')
      expect(inDefault).toContain('Edit')
      expect(inDefault).toContain('Shell')

      h.output.length = 0
      await h.run('/mode plan')
      h.output.length = 0
      await h.run('/tools')
      const inPlan = h.output.join('\n')
      expect(inPlan).toContain('Read')
      expect(inPlan).toContain('PlanPropose')
      expect(inPlan).toContain('hidden in this mode')
      // the write tools are listed as hidden, not as available
      const availableSection = inPlan.split('hidden in this mode')[0]!
      expect(availableSection).not.toContain('ApplyPatch')
    } finally {
      await h.world.cleanup()
    }
  })

  test('/session /tasks /metrics /config /model do not throw and report state', async () => {
    const h = await harness()
    try {
      for (const command of ['/session', '/tasks', '/metrics', '/config', '/model', '/plan', '/evidence']) {
        await h.run(command)
      }
      const text = h.output.join('\n')
      expect(text).toContain(h.world.runtime.sessionId)
      expect(text).toContain('no tasks')
      expect(text).toContain(h.world.runtime.model.modelId)
    } finally {
      await h.world.cleanup()
    }
  })

  test('/debug toggles and /exit requests shutdown', async () => {
    const h = await harness()
    try {
      await h.run('/debug on')
      expect(h.getDebug()).toBe(true)
      await h.run('/debug off')
      expect(h.getDebug()).toBe(false)
      await h.run('/exit')
      expect(h.wasExit()).toBe(true)
    } finally {
      await h.world.cleanup()
    }
  })

  test('/clear resets the conversation but keeps the mode', async () => {
    const h = await harness()
    try {
      await h.run('/mode acceptEdits')
      expect(h.getState().messages.length).toBeGreaterThan(0)
      await h.run('/clear')
      expect(h.getState().messages).toHaveLength(0)
      expect(h.getState().mode).toBe('acceptEdits')
    } finally {
      await h.world.cleanup()
    }
  })
})
