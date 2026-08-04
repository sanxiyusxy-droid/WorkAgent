import { describe, expect, test } from 'vitest'
import { ContextManager, estimateTokens } from '../src/context/ContextManager.js'
import { ScriptedModel, textTurn } from '../src/model/ScriptedModel.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { fixedClock, makeWorld, collectRun, stateWithUser } from './helpers.js'
import { toolCallTurn } from '../src/model/ScriptedModel.js'
import type { ScriptedTurn } from '../src/model/ScriptedModel.js'
import type { FactEvent } from '../src/core/events.js'
import type { ConversationMessage } from '../src/core/messages.js'

function msg(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  source?: 'human' | 'tool' | 'engine',
): ConversationMessage {
  return {
    id,
    parentId: null,
    sessionId: 'ses_1',
    turnId: 'turn_1',
    role,
    content: [{ type: 'text', text }],
    createdAt: 't',
    meta: source ? { source } : undefined,
  }
}

function toolResultMsg(id: string, callId: string, chars: number): ConversationMessage {
  return {
    id,
    parentId: null,
    sessionId: 'ses_1',
    turnId: 'turn_1',
    role: 'user',
    content: [
      {
        type: 'tool_result',
        callId,
        ok: true,
        content: { kind: 'text', text: 'x'.repeat(chars) },
      },
    ],
    createdAt: 't',
    meta: { source: 'tool' },
  }
}

function makeManager(turns = [textTurn('SUMMARY: everything important')], config = {}) {
  const model = new ScriptedModel(turns)
  return {
    model,
    manager: new ContextManager({
      model,
      clock: fixedClock(),
      ids: createSequentialIds(),
      config: {
        window: 2_000,
        reservedOutput: 200,
        safetyBuffer: 200,
        recentTailMessages: 2,
        compactFailureLimit: 3,
        ...config,
      },
    }),
  }
}

describe('ContextManager', () => {
  test('under budget: no compaction at all', async () => {
    const { manager, model } = makeManager()
    const result = await manager.prepare({
      messages: [msg('m1', 'user', 'short question', 'human')],
      sessionId: 'ses_1',
      turnId: 'turn_1',
    })
    expect(result.facts).toHaveLength(0)
    expect(model.requests).toHaveLength(0) // no model call
  })

  test('L1 micro compact clears old tool results before any model summary', async () => {
    const { manager, model } = makeManager()
    const messages = [
      msg('m1', 'user', 'do the thing', 'human'),
      toolResultMsg('m2', 'call_1', 12_000), // old, re-fetchable, big
      msg('m3', 'assistant', 'working on it'),
      msg('m4', 'user', 'latest message', 'human'),
    ]
    const result = await manager.prepare({
      messages,
      sessionId: 'ses_1',
      turnId: 'turn_1',
    })
    const micro = result.facts.find(
      f => f.type === 'context.compacted' && f.record.kind === 'micro',
    )
    expect(micro).toBeDefined()
    if (micro && micro.type === 'context.compacted') {
      expect(micro.record.clearedMessageIds).toEqual(['m2'])
      expect(micro.record.replacements).toHaveLength(1)
      const replacement = micro.record.replacements![0]!
      const block = replacement.content[0]!
      expect(block.type).toBe('tool_result')
      if (block.type === 'tool_result' && block.content.kind === 'text') {
        expect(block.content.text).toContain('cleared')
        expect(block.content.text).toContain('call_1')
      }
      expect(micro.record.tokensAfter).toBeLessThan(micro.record.tokensBefore)
    }
    // micro was enough — the expensive summary never ran
    expect(model.requests).toHaveLength(0)
  })

  test('L3 auto summary runs only when micro is not enough', async () => {
    const { manager, model } = makeManager()
    // large HUMAN text cannot be micro-compacted -> summary required
    const messages = [
      msg('m1', 'user', 'y'.repeat(4_000), 'human'),
      msg('m2', 'assistant', 'z'.repeat(4_000)),
      msg('m3', 'assistant', 'progress'),
      msg('m4', 'user', 'latest', 'human'),
    ]
    const result = await manager.prepare({
      messages,
      sessionId: 'ses_1',
      turnId: 'turn_1',
    })
    const auto = result.facts.find(
      f => f.type === 'context.compacted' && f.record.kind === 'auto',
    )
    expect(auto).toBeDefined()
    if (auto && auto.type === 'context.compacted') {
      // tail of 2 kept; first two cleared and replaced by the summary
      expect(auto.record.clearedMessageIds).toEqual(['m1', 'm2'])
      const summary = auto.record.replacements![0]!
      const block = summary.content[0]!
      expect(block.type === 'text' && block.text).toContain('CONTEXT SUMMARY')
    }
    // summarizer must not receive tools
    expect(model.requests[0]!.tools).toHaveLength(0)
  })

  test('circuit breaker opens after repeated summary failures', async () => {
    const { manager } = makeManager([
      { kind: 'error', error: { code: 'CONNECTION', retryable: true } },
      { kind: 'error', error: { code: 'CONNECTION', retryable: true } },
      { kind: 'error', error: { code: 'CONNECTION', retryable: true } },
      textTurn('never reached'),
    ])
    const messages = [
      msg('m1', 'user', 'y'.repeat(4_000), 'human'),
      msg('m2', 'assistant', 'z'.repeat(4_000)),
      msg('m3', 'user', 'latest', 'human'),
    ]
    for (let i = 0; i < 3; i++) {
      const result = await manager.prepare({
        messages,
        sessionId: 'ses_1',
        turnId: 'turn_1',
      })
      if (i < 2) expect(result.compactBroken).toBe(false)
      else expect(result.compactBroken).toBe(true)
    }
    // breaker open: no further model calls attempted
    const after = await manager.prepare({
      messages,
      sessionId: 'ses_1',
      turnId: 'turn_1',
    })
    expect(after.compactBroken).toBe(true)
  })

  test('L3 keeps engine-injected state verbatim, folds older user goals into the summary', async () => {
    const { manager, model } = makeManager()
    const messages: ConversationMessage[] = [
      msg('m1', 'user', 'old goal '.padEnd(4_000, 'y'), 'human'),
      // engine-injected plan/approval state: exact protected set
      {
        ...msg('m2', 'user', 'approved plan v1: build feature X'),
        meta: { source: 'engine', synthetic: true },
      },
      msg('m3', 'assistant', 'work log '.padEnd(4_000, 'z')),
      msg('m4', 'user', 'latest goal', 'human'),
    ]
    const result = await manager.prepare({
      messages,
      sessionId: 'ses_1',
      turnId: 'turn_1',
    })
    const auto = result.facts.find(
      f => f.type === 'context.compacted' && f.record.kind === 'auto',
    )
    expect(auto).toBeDefined()
    if (auto && auto.type === 'context.compacted') {
      // head = m1,m2 (tail of 2 protects m3,m4): only the OLD human message
      // is compressible; the synthetic plan-state message stays verbatim
      expect(auto.record.clearedMessageIds).toEqual(['m1'])
    }
    // the summarizer transcript carries the old goal but not protected state
    const transcript = model.requests[0]!.messages[0]!.content
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('')
    expect(transcript).toContain('old goal')
    expect(transcript).not.toContain('approved plan v1')
  })
})

/** Mirror of the reducer's context.compacted case, for simulation tests. */
function applyCompaction(
  messages: ConversationMessage[],
  facts: FactEvent[],
): ConversationMessage[] {
  let next = messages
  for (const fact of facts) {
    if (fact.type !== 'context.compacted') continue
    const cleared = new Set(fact.record.clearedMessageIds)
    const replacements = fact.record.replacements ?? []
    const out: ConversationMessage[] = []
    let inserted = false
    for (const m of next) {
      if (cleared.has(m.id)) {
        if (!inserted) {
          out.push(...replacements)
          inserted = true
        }
        continue
      }
      out.push(m)
    }
    if (!inserted && replacements.length > 0) out.push(...replacements)
    next = out
  }
  return next
}

describe('long session stability', () => {
  test('100-round session: budget bounded, intent preserved, no death spiral', async () => {
    const summaryTurns = Array.from({ length: 120 }, (_, i) =>
      textTurn(`SUMMARY-${i}: goals, constraints, decisions, outstanding items`),
    )
    const { manager, model } = makeManager(summaryTurns, {
      window: 4_000,
      reservedOutput: 400,
      safetyBuffer: 400,
      recentTailMessages: 4,
      recentTailTokens: 1_200,
    })
    const budget = 4_000 - 400 - 400
    let messages: ConversationMessage[] = [
      msg('m0', 'user', 'initial goal G with constraint C', 'human'),
    ]
    let compactions = 0
    for (let round = 0; round < 100; round++) {
      messages = [
        ...messages,
        msg(`u${round}`, 'user', `request-${round} `.padEnd(300, 'q'), 'human'),
        msg(`a${round}`, 'assistant', `answer-${round} `.padEnd(500, 'w')),
      ]
      const result = await manager.prepare({
        messages,
        sessionId: 'ses_1',
        turnId: 'turn_1',
      })
      // the breaker never opens: summaries keep succeeding
      expect(result.compactBroken).toBe(false)
      messages = applyCompaction(messages, result.facts)
      compactions += result.facts.filter(f => f.type === 'context.compacted').length
    }
    // bounded: after 100 rounds the conversation still fits the budget
    expect(estimateTokens(messages)).toBeLessThan(budget)
    // compaction actually happened (100 rounds >> 4k window)
    expect(compactions).toBeGreaterThan(0)
    // latest user goal survived verbatim
    expect(messages.some(m => m.id === 'u99')).toBe(true)
    // older user requests went INTO the summarizer transcript — intent is
    // preserved structurally, not dropped silently
    const transcripts = model.requests.map(r =>
      r.messages[0]!.content.map(b => (b.type === 'text' ? b.text : '')).join(''),
    )
    expect(transcripts.some(t => t.includes('request-0'))).toBe(true)
  }, 30_000)

  test('50-iteration engine session with continuous large tool results stays bounded', async () => {
    const turns: ScriptedTurn[] = []
    for (let i = 0; i < 50; i++) {
      turns.push(
        toolCallTurn([{ id: `c${i}`, name: 'Read', input: { path: 'big.txt' } }]),
      )
    }
    turns.push(textTurn('done'))
    const world = await makeWorld({
      files: { 'big.txt': 'x'.repeat(3_000) },
      turns,
      maxTurns: 60,
      context: {
        window: 8_000,
        reservedOutput: 500,
        safetyBuffer: 500,
        recentTailMessages: 4,
        recentTailTokens: 2_000,
      },
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'read the file repeatedly'),
      )
      expect(result.terminal.reason).toBe('completed')
      // 50 x ~3k-char results cannot fit an 8k window: compaction must fire
      const compactions = result.facts.filter(f => f.type === 'context.compacted')
      expect(compactions.length).toBeGreaterThan(0)
      // old re-fetchable tool results were micro-compacted
      expect(
        compactions.some(
          f => f.type === 'context.compacted' && f.record.kind === 'micro',
        ),
      ).toBe(true)
      // no death spiral: every read still executed
      expect(result.facts.filter(f => f.type === 'tool.call.completed')).toHaveLength(50)
    } finally {
      await world.cleanup()
    }
  }, 30_000)
})

describe('reactive compact E2E', () => {
  test('PROMPT_TOO_LONG recovers exactly once via reactive compact', async () => {
    const world = await makeWorld({
      turns: [
        { kind: 'error', error: { code: 'PROMPT_TOO_LONG', retryable: true } },
        textTurn('SUMMARY of prior context'), // consumed by the reactive summarizer
        textTurn('recovered and answered'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'hello'),
      )
      const transitions = result.facts
        .filter(f => f.type === 'loop.transitioned')
        .map(f => (f.type === 'loop.transitioned' ? f.transition.reason : ''))
      expect(transitions).toContain('reactive_compact_retry')
      expect(result.terminal).toEqual({ reason: 'completed' })
    } finally {
      await world.cleanup()
    }
  })

  test('second PROMPT_TOO_LONG terminates — no compact death spiral', async () => {
    const world = await makeWorld({
      turns: [
        { kind: 'error', error: { code: 'PROMPT_TOO_LONG', retryable: true } },
        // nothing compactable in a one-message conversation, so the reactive
        // path retries directly — a second overflow must terminate
        { kind: 'error', error: { code: 'PROMPT_TOO_LONG', retryable: true } },
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'hello'),
      )
      expect(result.terminal).toEqual({ reason: 'prompt_too_long' })
      // exactly one reactive attempt
      const reactive = result.facts.filter(
        f =>
          f.type === 'loop.transitioned' &&
          f.transition.reason === 'reactive_compact_retry',
      )
      expect(reactive).toHaveLength(1)
    } finally {
      await world.cleanup()
    }
  })
})

describe('ApplyPatch transactional boundary (E2E)', () => {
  test('any hunk failure means no file is written', async () => {
    const original = 'alpha\n'
    const world = await makeWorld({
      mode: 'acceptEdits',
      files: { 'a.txt': original, 'b.txt': 'beta\n' },
      turns: [
        toolCallTurn([
          {
            id: 'p1',
            name: 'ApplyPatch',
            input: {
              edits: [
                {
                  path: 'a.txt',
                  oldText: 'alpha',
                  newText: 'ALPHA',
                  // deliberately stale version -> whole patch must fail
                  expectedVersion: 'sha256:stale',
                },
              ],
              creates: [{ path: 'new.txt', content: 'should not exist' }],
            },
          },
        ]),
        textTurn('patch failed as expected'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'patch it'),
      )
      const completed = result.facts.find(f => f.type === 'tool.call.completed')
      expect(completed).toMatchObject({
        result: { ok: false, errorCode: 'FILE_VERSION_CONFLICT' },
      })
      const { readFile, access } = await import('node:fs/promises')
      const { join } = await import('node:path')
      expect(await readFile(join(world.workspaceRoot, 'a.txt'), 'utf8')).toBe(original)
      await expect(access(join(world.workspaceRoot, 'new.txt'))).rejects.toThrow()
    } finally {
      await world.cleanup()
    }
  })
})

describe('estimateTokens', () => {
  test('is monotonic in content size', () => {
    const small = estimateTokens([msg('a', 'user', 'short')])
    const large = estimateTokens([msg('a', 'user', 'x'.repeat(10_000))])
    expect(large).toBeGreaterThan(small)
  })
})
