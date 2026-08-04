import { describe, expect, test } from 'vitest'
import { ProgressThrottle } from '../src/tools/toolProgress.js'
import { AsyncQueue, mergeTransient } from '../src/core/asyncQueue.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { collectRun, makeWorld, stateWithUser, completedCallIds } from './helpers.js'
import type { AgentEvent } from '../src/core/events.js'

function makeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('ProgressThrottle', () => {
  test('merges small chunks and emits stdout/stderr separately on flush', () => {
    const events: AgentEvent[] = []
    const clock = makeClock()
    const throttle = new ProgressThrottle(e => events.push(e), 'c1', clock.now)
    throttle.push({ stream: 'stdout', text: 'ab' })
    throttle.push({ stream: 'stderr', text: 'cd' })
    // below the merge threshold nothing is emitted yet
    expect(events).toHaveLength(0)
    throttle.flush()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'tool.progress',
      callId: 'c1',
      data: { stream: 'stdout', text: 'ab' },
    })
    expect(events[1]).toMatchObject({ data: { stream: 'stderr', text: 'cd' } })
  })

  test('rate-limits: large chunk emits, follow-ups wait for the interval', () => {
    const events: AgentEvent[] = []
    const clock = makeClock()
    const throttle = new ProgressThrottle(e => events.push(e), 'c1', clock.now)
    throttle.push({ stream: 'stdout', text: 'x'.repeat(300) })
    expect(events).toHaveLength(1) // crosses mergeChars and interval is open
    throttle.push({ stream: 'stdout', text: 'y'.repeat(300) })
    expect(events).toHaveLength(1) // within minIntervalMs: merged, not emitted
    clock.advance(60)
    throttle.push({ stream: 'stdout', text: 'z' })
    expect(events).toHaveLength(2) // interval open + buffered >= threshold
    if (events[1]!.type === 'tool.progress') {
      expect(events[1]!.data.text).toBe('y'.repeat(300) + 'z')
    }
  })

  test('per-call display budget drops excess output and reports the count', () => {
    const events: AgentEvent[] = []
    const clock = makeClock()
    const throttle = new ProgressThrottle(e => events.push(e), 'c1', clock.now, {
      minIntervalMs: 0,
      mergeChars: 1,
      maxCharsPerCall: 100,
    })
    throttle.push({ stream: 'stdout', text: 'a'.repeat(150) })
    throttle.flush()
    const stdoutChars = events
      .filter(e => e.type === 'tool.progress' && e.data.stream === 'stdout')
      .reduce((sum, e) => sum + (e.type === 'tool.progress' ? e.data.text.length : 0), 0)
    // memory stays bounded: exactly the budget was forwarded
    expect(stdoutChars).toBe(100)
    const notice = events.find(
      e => e.type === 'tool.progress' && e.data.dropped !== undefined,
    )
    expect(notice).toBeDefined()
    if (notice && notice.type === 'tool.progress') {
      expect(notice.data.dropped).toBe(50)
    }
  })
})

describe('mergeTransient', () => {
  test('side-channel events reach the merged stream without losing primary order', async () => {
    async function* primary() {
      yield 'p1'
      yield 'p2'
    }
    const queue = new AsyncQueue<string>()
    queue.push('s1')
    const out: string[] = []
    for await (const item of mergeTransient(queue, primary())) {
      out.push(item)
    }
    expect([...out].sort()).toEqual(['p1', 'p2', 's1'])
    // primary order is preserved among primary items
    expect(out.indexOf('p1')).toBeLessThan(out.indexOf('p2'))
  })

  test('side items buffered when the primary finishes are still delivered', async () => {
    async function* primary() {
      yield 'p1'
    }
    const queue = new AsyncQueue<string>()
    const merged = mergeTransient(queue, primary())
    const iterator = merged[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    // producer pushes right as the primary stream ends
    queue.push('late')
    queue.close()
    const rest: string[] = []
    let step = await iterator.next()
    while (!step.done) {
      rest.push(step.value)
      step = await iterator.next()
    }
    expect([...[first.value as string], ...rest].sort()).toEqual(['late', 'p1'])
  })
})

describe('progress E2E', () => {
  test('Shell output streams as transient progress events; fact stream is unchanged', async () => {
    const world = await makeWorld({
      mode: 'acceptEdits',
      turns: [
        toolCallTurn([
          { id: 's1', name: 'Shell', input: { command: 'echo hello-progress' } },
        ]),
        textTurn('done'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'run it'),
      )
      expect(result.terminal.reason).toBe('completed')
      const progress = result.events.filter(e => e.type === 'tool.progress')
      expect(progress.length).toBeGreaterThan(0)
      const combined = progress
        .map(e => (e.type === 'tool.progress' ? e.data.text : ''))
        .join('')
      expect(combined).toContain('hello-progress')
      // progress is transient: it must never leak into the fact stream
      expect(
        (result.facts as AgentEvent[]).some(f => f.type === 'tool.progress'),
      ).toBe(false)
      expect(completedCallIds(result)).toEqual(['s1'])
    } finally {
      await world.cleanup()
    }
  })
})
