import { describe, expect, test } from 'vitest'
import { ToolScheduler, conflicts, type ScheduledCall } from '../src/tools/ToolScheduler.js'
import { ToolRegistry } from '../src/tools/ToolRegistry.js'
import { ReadTool } from '../src/tools/builtin/ReadTool.js'
import { EditTool } from '../src/tools/builtin/EditTool.js'
import type { AgentEvent } from '../src/core/events.js'
import type { ToolCall } from '../src/core/messages.js'

function makeCall(id: string, name: string, input: unknown, index: number): ToolCall {
  return { id, name, input, parentMessageId: 'msg_p', receivedIndex: index }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function completedEvent(callId: string): AgentEvent {
  return {
    type: 'tool.call.completed',
    result: {
      callId,
      toolName: 'test',
      ok: true,
      content: { kind: 'text', text: callId },
      durationMs: 1,
    },
  }
}

describe('conflicts()', () => {
  test('read/read never conflicts', () => {
    expect(
      conflicts(
        [{ resource: 'file:/a.ts', mode: 'read' }],
        [{ resource: 'file:/a.ts', mode: 'read' }],
      ),
    ).toBe(false)
  })

  test('write on same resource conflicts', () => {
    expect(
      conflicts(
        [{ resource: 'file:/a.ts', mode: 'write' }],
        [{ resource: 'file:/a.ts', mode: 'read' }],
      ),
    ).toBe(true)
  })

  test('workspace:* write overlaps everything', () => {
    expect(
      conflicts(
        [{ resource: 'workspace:*', mode: 'write' }],
        [{ resource: 'file:/x.ts', mode: 'read' }],
      ),
    ).toBe(true)
  })
})

describe('ToolScheduler ordering', () => {
  test('results replay in received order even when completion order differs', async () => {
    const registry = new ToolRegistry()
    registry.register(ReadTool)
    const scheduler = new ToolScheduler(registry)

    const order: string[] = []
    const items: ScheduledCall[] = [
      {
        call: makeCall('slow', 'Read', { path: 'a.txt' }, 0),
        run: async () => {
          await sleep(80)
          order.push('slow')
          return [completedEvent('slow')]
        },
      },
      {
        call: makeCall('fast', 'Read', { path: 'b.txt' }, 1),
        run: async () => {
          order.push('fast')
          return [completedEvent('fast')]
        },
      },
    ]

    const emitted: string[] = []
    for await (const event of scheduler.executeBatch(items, 'C:/ws')) {
      if (event.type === 'tool.call.completed') emitted.push(event.result.callId)
    }

    // fast finished first...
    expect(order).toEqual(['fast', 'slow'])
    // ...but results are replayed in received order
    expect(emitted).toEqual(['slow', 'fast'])
  })

  test('exclusive write forms a FIFO barrier', async () => {
    const registry = new ToolRegistry()
    registry.register(ReadTool)
    registry.register(EditTool)
    const scheduler = new ToolScheduler(registry)

    const timeline: string[] = []
    const items: ScheduledCall[] = [
      {
        call: makeCall('r1', 'Read', { path: 'a.txt' }, 0),
        run: async () => {
          timeline.push('r1:start')
          await sleep(40)
          timeline.push('r1:end')
          return [completedEvent('r1')]
        },
      },
      {
        call: makeCall('w1', 'Edit', {
          path: 'a.txt',
          oldText: 'x',
          newText: 'y',
          expectedVersion: 'sha256:0',
        }, 1),
        run: async () => {
          timeline.push('w1:start')
          await sleep(10)
          timeline.push('w1:end')
          return [completedEvent('w1')]
        },
      },
      {
        call: makeCall('r2', 'Read', { path: 'b.txt' }, 2),
        run: async () => {
          timeline.push('r2:start')
          return [completedEvent('r2')]
        },
      },
    ]

    const emitted: string[] = []
    for await (const event of scheduler.executeBatch(items, 'C:/ws')) {
      if (event.type === 'tool.call.completed') emitted.push(event.result.callId)
    }

    // write w1 must not start before r1 finished (barrier), r2 must wait for w1
    expect(timeline.indexOf('w1:start')).toBeGreaterThan(timeline.indexOf('r1:end'))
    expect(timeline.indexOf('r2:start')).toBeGreaterThan(timeline.indexOf('w1:end'))
    expect(emitted).toEqual(['r1', 'w1', 'r2'])
  })
})
