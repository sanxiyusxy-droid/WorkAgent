import { describe, expect, test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionJournal } from '../src/session/SessionJournal.js'
import { loadSession } from '../src/session/SessionLoader.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { fixedClock, makeWorld, collectRun, stateWithUser } from './helpers.js'
import { resumeState } from '../src/app/createRuntime.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import type { FactEvent } from '../src/core/events.js'

function makeJournal(filePath: string) {
  return new SessionJournal({
    filePath,
    sessionId: 'ses_1',
    runId: 'run_1',
    clock: fixedClock(),
    ids: createSequentialIds(),
  })
}

const userFact = (id: string): FactEvent => ({
  type: 'user.message.accepted',
  message: {
    id,
    parentId: null,
    sessionId: 'ses_1',
    turnId: 'turn_1',
    role: 'user',
    content: [{ type: 'text', text: `hello ${id}` }],
    createdAt: '2026-01-01T00:00:00.000Z',
  },
})

describe('SessionJournal', () => {
  test('appends ordered envelopes with checksums; loader replays them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-journal-'))
    const filePath = join(dir, 'journal.jsonl')
    try {
      const journal = makeJournal(filePath)
      await journal.append(userFact('m1'), 'turn_1', 'flush')
      await journal.append(userFact('m2'), 'turn_1', 'buffered')
      await journal.drain()

      const loaded = await loadSession(filePath)
      expect(loaded.ok).toBe(true)
      expect(loaded.envelopes).toHaveLength(2)
      expect(loaded.envelopes.map(e => e.seq)).toEqual([1, 2])
      expect(loaded.messages.map(m => m.id)).toEqual(['m1', 'm2'])
      expect(loaded.nextSeq).toBe(3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('checksum corruption stops replay with a diagnostic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-journal-'))
    const filePath = join(dir, 'journal.jsonl')
    try {
      const journal = makeJournal(filePath)
      await journal.append(userFact('m1'), 'turn_1', 'flush')
      await journal.append(userFact('m2'), 'turn_1', 'flush')

      // corrupt line 2
      const raw = await readFile(filePath, 'utf8')
      const lines = raw.trim().split('\n')
      const tampered = lines[1]!.replace('hello m2', 'tampered!')
      await writeFile(filePath, `${lines[0]}\n${tampered}\n`, 'utf8')

      const loaded = await loadSession(filePath)
      expect(loaded.ok).toBe(false)
      expect(loaded.diagnostics.some(d => /checksum/.test(d))).toBe(true)
      // partial recovery: first line survives
      expect(loaded.messages.map(m => m.id)).toEqual(['m1'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('persistence + resume', () => {
  test('engine persists facts; resume closes orphan tool calls', async () => {
    // run 1: model calls Read then completes — with persistence on
    const world1 = await makeWorld({
      persist: true,
      sessionId: 'fixed-session',
      files: { 'a.txt': 'content' },
      turns: [
        toolCallTurn([{ id: 'call_1', name: 'Read', input: { path: 'a.txt' } }]),
        textTurn('done'),
      ],
    })
    try {
      const result = await collectRun(
        world1.runtime.engine,
        await stateWithUser(world1, 'read it'),
      )
      expect(result.terminal).toEqual({ reason: 'completed' })

      // journal exists and replays cleanly
      const loaded = await loadSession(world1.runtime.journalPath)
      expect(loaded.ok).toBe(true)
      expect(loaded.openToolCalls).toHaveLength(0)

      // simulate a crash: append an accepted-but-never-completed tool call
      const journal = new SessionJournal({
        filePath: world1.runtime.journalPath,
        sessionId: 'fixed-session',
        runId: 'run_crash',
        clock: fixedClock(),
        ids: createSequentialIds(),
      })
      journal.adopt(loaded.nextSeq, loaded.lastEventId)
      await journal.append(
        {
          type: 'tool.call.accepted',
          call: {
            id: 'call_orphan',
            name: 'Shell',
            input: { command: 'npm test' },
            parentMessageId: 'msg_x',
            receivedIndex: 0,
          },
        },
        'turn_2',
        'flush',
      )

      // resume in a new "process"
      const world2 = await makeWorld({
        persist: true,
        sessionId: 'fixed-session',
        workspaceRoot: world1.workspaceRoot,
        turns: [],
      })
      expect(world2.loaded).not.toBeNull()
      expect(world2.loaded!.openToolCalls.map(c => c.id)).toEqual(['call_orphan'])

      const { state, recoveryFacts } = await resumeState(
        world2.runtime,
        world2.loaded!,
      )
      // orphan got a synthetic terminal result
      const completedFact = recoveryFacts.find(
        f => f.type === 'tool.call.completed',
      )
      expect(completedFact).toMatchObject({
        result: {
          callId: 'call_orphan',
          synthetic: true,
          errorCode: 'INTERRUPTED_DURING_PREVIOUS_RUN',
        },
      })
      // synthetic tool_result message appended to visible history
      const lastMessage = state.messages[state.messages.length - 1]!
      expect(lastMessage.meta?.source).toBe('recovery')
      expect(lastMessage.content[0]).toMatchObject({
        type: 'tool_result',
        callId: 'call_orphan',
        ok: false,
      })

      // and the journal now replays with zero open calls
      const reloaded = await loadSession(world2.runtime.journalPath)
      expect(reloaded.openToolCalls).toHaveLength(0)
    } finally {
      await world1.cleanup()
    }
  })
})
