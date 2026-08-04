import { describe, expect, test } from 'vitest'
import { mergeConfig } from '../src/app/config.js'
import { MetricsCollector } from '../src/observability/metrics.js'
import { buildPromptManifest, assemblePrompt } from '../src/prompt/PromptAssembler.js'
import { OpenAICompatibleProvider } from '../src/model/providers/openaiCompatible.js'
import { AnthropicProvider } from '../src/model/providers/anthropic.js'
import type { ModelGateway } from '../src/model/types.js'
import { ScriptedModel, textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { loadSession } from '../src/session/SessionLoader.js'
import { collectRun, makeWorld, stateWithUser } from './helpers.js'
import { ReadTool } from '../src/tools/builtin/ReadTool.js'
import { EditTool } from '../src/tools/builtin/EditTool.js'

describe('config merge (guide §16)', () => {
  test('priority: managed > cli > project > user > defaults', () => {
    const effective = mergeConfig({
      user: { maxTurns: 10, maxOutputTokens: 1000 },
      project: { maxTurns: 20 },
      cli: { maxTurns: 30 },
      managed: { maxTurns: 40 },
    })
    expect(effective.maxTurns).toBe(40) // managed wins
    expect(effective.maxOutputTokens).toBe(1000) // user layer survives when unopposed
    expect(effective.maxModelCalls).toBe(60) // defaults fill the rest
  })

  test('managed deny rules are immovable and ordered first', () => {
    const effective = mergeConfig({
      managed: {
        rules: [
          {
            id: 'managed_deny_push',
            effect: 'deny',
            tool: 'Shell',
            matcher: { kind: 'argv', value: ['git', 'push'] },
            scope: 'session',
            source: 'managed',
          },
        ],
      },
      user: {
        rules: [
          {
            id: 'user_allow_all',
            effect: 'allow',
            tool: 'Shell',
            scope: 'session',
            source: 'user_settings',
          },
        ],
      },
    })
    expect(effective.rules[0]).toMatchObject({ id: 'managed_deny_push', effect: 'deny' })
    expect(effective.rules).toHaveLength(2)
  })

  test('configHash is deterministic and change-sensitive', () => {
    const a = mergeConfig({ cli: { maxTurns: 5 } })
    const b = mergeConfig({ cli: { maxTurns: 5 } })
    const c = mergeConfig({ cli: { maxTurns: 6 } })
    expect(a.configHash).toBe(b.configHash)
    expect(a.configHash).not.toBe(c.configHash)
  })
})

describe('run.started + config hash in journal', () => {
  test('first journal envelope is run.started carrying the config hash', async () => {
    const world = await makeWorld({
      persist: true,
      sessionId: 'm7-run-started',
      turns: [textTurn('hello')],
    })
    try {
      await collectRun(world.runtime.engine, await stateWithUser(world, 'hi'))
      const loaded = await loadSession(world.runtime.journalPath)
      expect(loaded.ok).toBe(true)
      expect(loaded.envelopes[0]!.event).toMatchObject({ type: 'run.started' })
    } finally {
      await world.cleanup()
    }
  })
})

describe('metrics collector', () => {
  test('detects orphan tool calls and duplicate results', () => {
    const metrics = new MetricsCollector()
    metrics.record({
      type: 'tool.call.accepted',
      call: { id: 'c1', name: 'Read', input: {}, parentMessageId: 'm', receivedIndex: 0 },
    })
    metrics.record({
      type: 'tool.call.accepted',
      call: { id: 'c2', name: 'Read', input: {}, parentMessageId: 'm', receivedIndex: 1 },
    })
    const result = {
      callId: 'c1',
      toolName: 'Read',
      ok: true,
      content: { kind: 'text' as const, text: '' },
      durationMs: 1,
    }
    metrics.record({ type: 'tool.call.completed', result })
    metrics.record({ type: 'tool.call.completed', result }) // duplicate

    const snap = metrics.snapshot()
    expect(snap.correctness.orphanToolCalls).toBe(1) // c2 never completed
    expect(snap.correctness.duplicateToolResults).toBe(1)
    expect(metrics.formatSummary()).toContain('must be 0')
  })

  test('aggregates a full run: zero orphans, decision log per turn', async () => {
    const world = await makeWorld({
      files: { 'a.txt': 'x' },
      turns: [
        toolCallTurn([{ id: 'c1', name: 'Read', input: { path: 'a.txt' } }]),
        textTurn('done'),
      ],
    })
    try {
      const metrics = new MetricsCollector()
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'read it'),
      )
      for (const event of result.events) metrics.record(event)
      const snap = metrics.snapshot()

      expect(snap.correctness.orphanToolCalls).toBe(0)
      expect(snap.usage.modelTurns).toBe(2)
      expect(snap.usage.toolCalls).toBe(1)
      expect(snap.permissions.allow).toBe(1)
      expect(snap.loop.transitions).toEqual({ tool_results_ready: 1 })
      expect(snap.loop.terminal).toBe('completed')
      expect(snap.perTool.Read).toEqual({ calls: 1, failures: 0 })

      // one decision-log line per loop turn
      expect(metrics.decisionLog).toHaveLength(2)
      expect(metrics.decisionLog[0]).toMatchObject({
        turn: 0,
        toolCalls: ['Read'],
        permissions: ['allow:Read'],
        transition: 'tool_results_ready',
      })
      expect(metrics.decisionLog[1]).toMatchObject({ terminal: 'completed' })
    } finally {
      await world.cleanup()
    }
  })
})

describe('prompt manifest', () => {
  test('emitted once per model call with stable tool schema hashes', async () => {
    const world = await makeWorld({
      files: { 'a.txt': 'x' },
      turns: [
        toolCallTurn([{ id: 'c1', name: 'Read', input: { path: 'a.txt' } }]),
        textTurn('done'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'read'),
      )
      const manifests = result.events.filter(e => e.type === 'prompt.manifest')
      expect(manifests).toHaveLength(2) // one per model call

      // schema hashes stable across turns (prompt-cache friendly)
      const [first, second] = manifests
      if (first?.type === 'prompt.manifest' && second?.type === 'prompt.manifest') {
        expect(first.manifest.tools).toEqual(second.manifest.tools)
        expect(second.manifest.totalEstimatedTokens).toBeGreaterThan(
          first.manifest.totalEstimatedTokens,
        )
      }
      // manifests are transient: never in facts
      expect(result.facts.some(f => (f as { type: string }).type === 'prompt.manifest')).toBe(false)
    } finally {
      await world.cleanup()
    }
  })

  test('manifest reflects mode projection', () => {
    const full = assemblePrompt({
      mode: 'default',
      messages: [],
      tools: [ReadTool, EditTool],
      maxOutputTokens: 100,
    })
    const manifest = buildPromptManifest({
      model: 'm',
      mode: 'default',
      request: full,
    })
    expect(manifest.tools.map(t => t.name)).toEqual(['Read', 'Edit'])
    expect(manifest.tools.every(t => t.schemaHash.length === 12)).toBe(true)
  })
})

describe('permission decisions are explainable', () => {
  test('every decision carries a full stage trace', async () => {
    const world = await makeWorld({
      // no ask handler: Write must be denied, and the trace must show why
      turns: [
        toolCallTurn([
          { id: 'c1', name: 'Write', input: { path: 'x.txt', content: 'hi' } },
        ]),
        textTurn('acknowledged the denial'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write something'),
      )
      const decision = result.facts.find(f => f.type === 'permission.decided')
      expect(decision).toBeDefined()
      if (decision?.type === 'permission.decided') {
        const stages = decision.decision.trace.map(s => s.stage)
        // the full priority chain was consulted, in order
        expect(stages).toEqual([
          'hard_safety',
          'deny_rules',
          'ask_rules',
          'tool_policy',
          'mode',
          'allow_rules',
          'ask',
        ])
        expect(decision.decision.behavior).toBe('deny')
      }
    } finally {
      await world.cleanup()
    }
  })
})

describe('provider isolation (ADR: engine depends only on ModelGateway)', () => {
  test('all providers are interchangeable behind the same interface', () => {
    const providers: ModelGateway[] = [
      new ScriptedModel([]),
      new OpenAICompatibleProvider({ baseUrl: 'http://x', apiKey: 'k', model: 'm1' }),
      new AnthropicProvider({ apiKey: 'k', model: 'm2' }),
    ]
    for (const provider of providers) {
      expect(typeof provider.stream).toBe('function')
      expect(typeof provider.classifyError).toBe('function')
      expect(provider.capabilities.toolCalls).toBe(true)
      // classifyError never throws on garbage
      expect(provider.classifyError(new Error('boom'))).toMatchObject({
        code: expect.any(String),
      })
    }
    // distinct providers, same contract — switching never touches the engine
    expect(new Set(providers.map(p => p.provider)).size).toBe(3)
  })
})
