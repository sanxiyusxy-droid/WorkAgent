import { describe, expect, test } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FactEvent } from '../src/core/events.js'
import { computeVersion } from '../src/workspace/FileVersion.js'
import { textTurn, toolCallTurn, type ScriptedTurn } from '../src/model/ScriptedModel.js'
import { MetricsCollector } from '../src/observability/metrics.js'
import { collectRun, makeWorld, stateWithUser } from './helpers.js'
import type { AgentMode } from '../src/core/events.js'

const FIXTURES_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')

interface GoldenFixture {
  description: string
  mode: AgentMode
  files: Record<string, string>
  turns: Array<
    | { calls: Array<{ id: string; name: string; input: unknown }> }
    | { text: string }
  >
  expectedTrace: string[]
  expectedModelRequests: number
  expectedFinalFiles: Record<string, string>
}

/** Substitute {{version:path}} placeholders with the real file hash. */
function resolvePlaceholders(input: unknown, files: Record<string, string>): unknown {
  if (typeof input === 'string') {
    const match = input.match(/^\{\{version:(.+)\}\}$/)
    if (match) {
      const content = files[match[1]!]
      if (content === undefined) throw new Error(`fixture references unknown file ${match[1]}`)
      return computeVersion(content)
    }
    return input
  }
  if (Array.isArray(input)) return input.map(v => resolvePlaceholders(v, files))
  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, resolvePlaceholders(v, files)]),
    )
  }
  return input
}

function fixtureTurns(fixture: GoldenFixture): ScriptedTurn[] {
  return fixture.turns.map(turn =>
    'text' in turn
      ? textTurn(turn.text)
      : toolCallTurn(
          turn.calls.map(call => ({
            ...call,
            input: resolvePlaceholders(call.input, fixture.files),
          })),
        ),
  )
}

/** Canonical compact trace of fact events for golden comparison. */
export function traceOf(facts: FactEvent[]): string[] {
  const trace: string[] = []
  for (const fact of facts) {
    switch (fact.type) {
      case 'assistant.message.completed':
      case 'tool.result.message':
      case 'evidence.recorded':
        trace.push(fact.type)
        break
      case 'tool.call.accepted':
        trace.push(`tool.call.accepted:${fact.call.id}`)
        break
      case 'tool.call.completed':
        trace.push(
          `tool.call.completed:${fact.result.callId}:` +
            (fact.result.ok ? 'ok' : fact.result.errorCode ?? 'error'),
        )
        break
      case 'permission.decided':
        trace.push(
          `permission.decided:${fact.decision.toolName}:${fact.decision.behavior}`,
        )
        break
      case 'loop.transitioned':
        trace.push(`loop.transitioned:${fact.transition.reason}`)
        break
      case 'run.terminated':
        trace.push(`run.terminated:${fact.terminal.reason}`)
        break
      case 'context.compacted':
        trace.push(`context.compacted:${fact.record.kind}`)
        break
      default:
        trace.push(fact.type)
    }
  }
  return trace
}

describe('golden transcript replay', () => {
  test('all fixtures replay with identical event traces and zero orphans', async () => {
    const names = (await readdir(FIXTURES_DIR)).filter(f => f.endsWith('.json'))
    expect(names.length).toBeGreaterThan(0)

    for (const name of names) {
      const fixture: GoldenFixture = JSON.parse(
        await readFile(join(FIXTURES_DIR, name), 'utf8'),
      )
      const world = await makeWorld({
        mode: fixture.mode,
        files: fixture.files,
        turns: fixtureTurns(fixture),
      })
      try {
        const metrics = new MetricsCollector()
        const result = await collectRun(
          world.runtime.engine,
          await stateWithUser(world, `golden run: ${fixture.description}`),
        )
        for (const event of result.events) metrics.record(event)

        // 1. exact fact-event trace
        expect(traceOf(result.facts), `${name}: trace`).toEqual(fixture.expectedTrace)

        // 2. no unexpected extra model calls
        expect(world.model.requests, `${name}: model requests`).toHaveLength(
          fixture.expectedModelRequests,
        )

        // 3. correctness invariants
        const snap = metrics.snapshot()
        expect(snap.correctness.orphanToolCalls, `${name}: orphans`).toBe(0)
        expect(snap.correctness.duplicateToolResults, `${name}: duplicates`).toBe(0)

        // 4. workspace end state
        for (const [rel, expected] of Object.entries(fixture.expectedFinalFiles)) {
          const actual = await readFile(join(world.workspaceRoot, rel), 'utf8')
          expect(actual, `${name}: file ${rel}`).toBe(expected)
        }
      } finally {
        await world.cleanup()
      }
    }
  })

  test('replaying the same fixture twice yields byte-identical traces', async () => {
    const fixture: GoldenFixture = JSON.parse(
      await readFile(join(FIXTURES_DIR, 'parallel-reads.json'), 'utf8'),
    )
    const traces: string[][] = []
    for (let i = 0; i < 2; i++) {
      const world = await makeWorld({
        mode: fixture.mode,
        files: fixture.files,
        turns: fixtureTurns(fixture),
      })
      try {
        const result = await collectRun(
          world.runtime.engine,
          await stateWithUser(world, 'determinism check'),
        )
        traces.push(traceOf(result.facts))
      } finally {
        await world.cleanup()
      }
    }
    expect(traces[0]).toEqual(traces[1])
  })
})
