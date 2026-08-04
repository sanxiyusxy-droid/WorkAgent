import { describe, expect, test } from 'vitest'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import {
  acceptedCallIds,
  collectRun,
  completedCallIds,
  makeWorld,
  stateWithUser,
} from './helpers.js'

describe('agent main loop', () => {
  test('pure text answer terminates with completed', async () => {
    const world = await makeWorld({ turns: [textTurn('Hello, done.')] })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'hi'),
      )
      expect(result.terminal).toEqual({ reason: 'completed' })
      const assistant = result.facts.find(
        f => f.type === 'assistant.message.completed',
      )
      expect(assistant).toBeDefined()
      // no tool events at all
      expect(acceptedCallIds(result)).toHaveLength(0)
    } finally {
      await world.cleanup()
    }
  })

  test('one Read tool call continues with tool_results_ready then completes', async () => {
    const world = await makeWorld({
      files: { 'hello.txt': 'line one\nline two\n' },
      turns: [
        toolCallTurn([{ id: 'call_1', name: 'Read', input: { path: 'hello.txt' } }]),
        textTurn('The file has two lines.'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'read hello.txt'),
      )
      expect(result.terminal).toEqual({ reason: 'completed' })

      const transition = result.facts.find(f => f.type === 'loop.transitioned')
      expect(transition).toMatchObject({
        transition: { reason: 'tool_results_ready', callCount: 1 },
      })

      // tool call/result strictly paired
      expect(acceptedCallIds(result)).toEqual(['call_1'])
      expect(completedCallIds(result)).toEqual(['call_1'])

      // second model request must contain the tool result message
      expect(world.model.requests).toHaveLength(2)
      const secondRequest = world.model.requests[1]!
      const last = secondRequest.messages[secondRequest.messages.length - 1]!
      expect(last.content[0]).toMatchObject({ type: 'tool_result', callId: 'call_1', ok: true })
    } finally {
      await world.cleanup()
    }
  })

  test('unknown tool produces a paired error result and loop continues', async () => {
    const world = await makeWorld({
      turns: [
        toolCallTurn([{ id: 'call_x', name: 'Nonexistent', input: {} }]),
        textTurn('ok, giving up on that tool'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'do something'),
      )
      expect(result.terminal).toEqual({ reason: 'completed' })
      const completed = result.facts.find(f => f.type === 'tool.call.completed')
      expect(completed).toMatchObject({
        result: { callId: 'call_x', ok: false, errorCode: 'UNKNOWN_TOOL' },
      })
    } finally {
      await world.cleanup()
    }
  })

  test('schema validation error yields self-repairable structured result', async () => {
    const world = await makeWorld({
      turns: [
        toolCallTurn([{ id: 'call_bad', name: 'Read', input: { nope: true } }]),
        textTurn('fixed'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'read'),
      )
      const completed = result.facts.find(f => f.type === 'tool.call.completed')
      expect(completed).toMatchObject({
        result: { ok: false, errorCode: 'INPUT_VALIDATION_ERROR' },
      })
      expect(result.terminal).toEqual({ reason: 'completed' })
    } finally {
      await world.cleanup()
    }
  })

  test('model retryable errors are retried with bound, then surfaced', async () => {
    const world = await makeWorld({
      turns: [
        { kind: 'error', error: { code: 'CONNECTION', retryable: true } },
        { kind: 'error', error: { code: 'CONNECTION', retryable: true } },
        { kind: 'error', error: { code: 'CONNECTION', retryable: true } },
        { kind: 'error', error: { code: 'CONNECTION', retryable: true } },
      ],
    })
    // zero-delay sleep injected via engine deps is not exposed; rely on real
    // timers with small backoff — retry policy caps at 3 attempts.
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'hi'),
      )
      expect(result.terminal).toEqual({ reason: 'model_error', code: 'CONNECTION' })
    } finally {
      await world.cleanup()
    }
  }, 30_000)

  test('PROMPT_TOO_LONG surfaces as prompt_too_long terminal (no context manager)', async () => {
    const world = await makeWorld({
      turns: [{ kind: 'error', error: { code: 'PROMPT_TOO_LONG', retryable: true } }],
      context: { enabled: false }, // reactive compact path is tested separately
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'hi'),
      )
      expect(result.terminal).toEqual({ reason: 'prompt_too_long' })
    } finally {
      await world.cleanup()
    }
  })

  test('maxTurns terminates with named reason', async () => {
    // model keeps calling tools forever
    const turns = Array.from({ length: 10 }, (_, i) =>
      toolCallTurn([{ id: `call_${i}`, name: 'Glob', input: { pattern: '*.txt' } }]),
    )
    const world = await makeWorld({ turns, maxTurns: 3 })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'loop forever'),
      )
      expect(result.terminal).toEqual({ reason: 'max_turns', turns: 3 })
      // pairing invariant holds even at forced exit
      expect(completedCallIds(result).sort()).toEqual(acceptedCallIds(result).sort())
    } finally {
      await world.cleanup()
    }
  })

  test('every accepted call gets exactly one terminal result', async () => {
    const world = await makeWorld({
      files: { 'a.txt': 'aaa', 'b.txt': 'bbb' },
      turns: [
        toolCallTurn([
          { id: 'c1', name: 'Read', input: { path: 'a.txt' } },
          { id: 'c2', name: 'Read', input: { path: 'b.txt' } },
          { id: 'c3', name: 'Nonexistent', input: {} },
        ]),
        textTurn('done'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'read both'),
      )
      const accepted = acceptedCallIds(result)
      const completed = completedCallIds(result)
      expect(accepted).toEqual(['c1', 'c2', 'c3'])
      expect(completed).toEqual(['c1', 'c2', 'c3']) // received order preserved
      // exactly one result each
      expect(new Set(completed).size).toBe(completed.length)
    } finally {
      await world.cleanup()
    }
  })

  test('plan mode hides write tools from the model', async () => {
    const world = await makeWorld({
      mode: 'plan',
      turns: [textTurn('plan ready')],
    })
    try {
      await collectRun(world.runtime.engine, await stateWithUser(world, 'plan something'))
      const request = world.model.requests[0]!
      const toolNames = request.tools.map(t => t.name)
      expect(toolNames).not.toContain('Edit')
      expect(toolNames).not.toContain('Write')
      expect(toolNames).not.toContain('Shell')
      expect(toolNames).toContain('Read')
      expect(toolNames).toContain('ShellReadOnly')
    } finally {
      await world.cleanup()
    }
  })
})
