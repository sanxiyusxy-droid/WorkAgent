import { describe, expect, test } from 'vitest'
import { StreamAssembler } from '../src/model/StreamAssembler.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { fixedClock } from './helpers.js'
import { InvariantError } from '../src/core/messages.js'

function makeAssembler() {
  return new StreamAssembler({
    ids: createSequentialIds(),
    clock: fixedClock(),
    sessionId: 'ses_1',
    turnId: 'turn_1',
    parentId: null,
    model: 'test-model',
  })
}

describe('StreamAssembler', () => {
  test('assembles text + tool call with incremental JSON', () => {
    const assembler = makeAssembler()
    assembler.push({ type: 'message_start', providerMessageId: 'p1' })
    assembler.push({ type: 'text_delta', index: 0, text: 'Let me ' })
    assembler.push({ type: 'text_delta', index: 0, text: 'read that.' })
    assembler.push({ type: 'block_end', index: 0 })
    assembler.push({ type: 'tool_call_start', index: 1, id: 'c1', name: 'Read' })
    assembler.push({ type: 'tool_call_input_delta', index: 1, json: '{"pa' })
    assembler.push({ type: 'tool_call_input_delta', index: 1, json: 'th":"a.txt"}' })
    assembler.push({ type: 'block_end', index: 1 })
    assembler.push({ type: 'message_end', stopReason: 'tool_use' })

    const turn = assembler.finish()
    expect(turn.toolCallCount).toBe(1)
    expect(turn.stopReason).toBe('tool_use')
    expect(turn.message.content).toEqual([
      { type: 'text', text: 'Let me read that.' },
      { type: 'tool_call', id: 'c1', name: 'Read', input: { path: 'a.txt' } },
    ])
  })

  test('malformed tool JSON is preserved for downstream schema error', () => {
    const assembler = makeAssembler()
    assembler.push({ type: 'tool_call_start', index: 0, id: 'c1', name: 'Read' })
    assembler.push({ type: 'tool_call_input_delta', index: 0, json: '{"path": bro' })
    assembler.push({ type: 'block_end', index: 0 })
    assembler.push({ type: 'message_end' })

    const turn = assembler.finish()
    expect(turn.message.content[0]).toMatchObject({
      type: 'tool_call',
      input: { __malformedJson: '{"path": bro' },
    })
  })

  test('duplicate tool call ids violate invariant', () => {
    const assembler = makeAssembler()
    assembler.push({ type: 'tool_call_start', index: 0, id: 'dup', name: 'Read' })
    expect(() =>
      assembler.push({ type: 'tool_call_start', index: 1, id: 'dup', name: 'Grep' }),
    ).toThrow(InvariantError)
  })

  test('stopReason is diagnostic only; toolCallCount drives the loop', () => {
    const assembler = makeAssembler()
    assembler.push({ type: 'text_delta', index: 0, text: 'done' })
    assembler.push({ type: 'block_end', index: 0 })
    // provider lies: says tool_use but sent no tool calls
    assembler.push({ type: 'message_end', stopReason: 'tool_use' })
    const turn = assembler.finish()
    expect(turn.toolCallCount).toBe(0)
  })
})
