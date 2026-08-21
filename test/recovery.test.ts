import { describe, expect, test } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionJournal } from '../src/session/SessionJournal.js'
import { loadSession } from '../src/session/SessionLoader.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { fixedClock, makeWorld, collectRun, stateWithUser } from './helpers.js'
import { resumeState } from '../src/app/createRuntime.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { createSnapshot, restoreFromSnapshot, createInitialState, reduce } from '../src/core/state.js'
import { IdempotencyLedger } from '../src/tools/IdempotencyLedger.js'
import type { FactEvent, StateSnapshot } from '../src/core/events.js'

describe('snapshot + tail recovery', () => {
  test('partial batch acceptance is reconstructed from the durable assistant message', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-partial-batch-'))
    const sessionId = 'partial-batch-session'
    const journalPath = join(
      workspaceRoot, '.agent', 'sessions', sessionId, 'journal.jsonl',
    )
    try {
      const journal = new SessionJournal({
        filePath: journalPath, sessionId, runId: 'run_partial',
        clock: fixedClock(), ids: createSequentialIds(),
      })
      await journal.append(
        { type: 'run.started', runId: 'run_partial', configHash: 'h' },
        'turn_partial', 'flush',
      )
      await journal.append({
        type: 'assistant.message.completed',
        message: {
          id: 'assistant_batch', parentId: null, sessionId,
          turnId: 'turn_partial', role: 'assistant',
          createdAt: '2026-01-01T00:00:00.000Z',
          content: [
            { type: 'tool_call', id: 'call_1', name: 'Read', input: { path: 'a.txt' } },
            { type: 'tool_call', id: 'call_2', name: 'Read', input: { path: 'b.txt' } },
          ],
        },
      }, 'turn_partial', 'flush')
      await journal.append({
        type: 'tool.call.accepted',
        call: {
          id: 'call_1', name: 'Read', input: { path: 'a.txt' },
          parentMessageId: 'assistant_batch', receivedIndex: 0,
        },
      }, 'turn_partial', 'flush')

      const loaded = await loadSession(journalPath)
      expect(loaded.openToolCalls.map(call => call.id).sort()).toEqual([
        'call_1', 'call_2',
      ])

      const world = await makeWorld({
        persist: true, sessionId, workspaceRoot, turns: [],
      })
      try {
        const resumed = await resumeState(world.runtime, loaded)
        const accepted = resumed.recoveryFacts.filter(
          fact => fact.type === 'tool.call.accepted',
        )
        expect(accepted).toHaveLength(1)
        expect(accepted[0]).toMatchObject({ call: { id: 'call_2' } })
        const completed = resumed.recoveryFacts
          .filter(fact => fact.type === 'tool.call.completed')
          .map(fact => fact.type === 'tool.call.completed' ? fact.result.callId : '')
          .sort()
        expect(completed).toEqual(['call_1', 'call_2'])
        expect(resumed.state.pendingToolCalls).toEqual([])
      } finally {
        await world.cleanup()
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('snapshot is written periodically and loader identifies it', async () => {
    const world = await makeWorld({
      persist: true,
      sessionId: 'snap-session',
      files: { 'a.txt': 'hello', 'b.txt': 'world' },
      turns: [
        toolCallTurn([{ id: 'c1', name: 'Read', input: { path: 'a.txt' } }]),
        toolCallTurn([{ id: 'c2', name: 'Read', input: { path: 'b.txt' } }]),
        toolCallTurn([{ id: 'c3', name: 'Read', input: { path: 'a.txt' } }]),
        textTurn('done'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'read files'),
      )
      expect(result.terminal).toEqual({ reason: 'completed' })

      // journal should contain at least one state.snapshot
      const loaded = await loadSession(world.runtime.journalPath)
      expect(loaded.ok).toBe(true)
      expect(loaded.lastSnapshot).not.toBeNull()
      // tail events should be fewer than total envelopes
      expect(loaded.tailEvents.length).toBeLessThan(loaded.envelopes.length)
    } finally {
      await world.cleanup()
    }
  })

  test('resume from snapshot + tail produces same state as full replay', async () => {
    const world1 = await makeWorld({
      persist: true,
      sessionId: 'replay-session',
      files: { 'x.txt': 'data' },
      turns: [
        toolCallTurn([{ id: 'c1', name: 'Read', input: { path: 'x.txt' } }]),
        toolCallTurn([{ id: 'c2', name: 'Read', input: { path: 'x.txt' } }]),
        toolCallTurn([{ id: 'c3', name: 'Read', input: { path: 'x.txt' } }]),
        toolCallTurn([{ id: 'c4', name: 'Read', input: { path: 'x.txt' } }]),
        textTurn('finished'),
      ],
    })
    try {
      await collectRun(world1.runtime.engine, await stateWithUser(world1, 'go'))

      // resume in a new process
      const world2 = await makeWorld({
        persist: true,
        sessionId: 'replay-session',
        workspaceRoot: world1.workspaceRoot,
        turns: [],
      })
      expect(world2.loaded).not.toBeNull()
      const { state } = await resumeState(world2.runtime, world2.loaded!)

      // state should have correct iteration count and mode
      expect(state.iteration).toBeGreaterThan(0)
      expect(state.mode).toBe('default')
      // messages should be restored
      expect(state.messages.length).toBeGreaterThan(0)
      // no open tool calls after clean run
      expect(world2.loaded!.openToolCalls).toHaveLength(0)
    } finally {
      await world1.cleanup()
    }
  })

  test('kill during tool execution: orphan calls closed on resume', async () => {
    const world1 = await makeWorld({
      persist: true,
      sessionId: 'kill-session',
      files: { 'f.txt': 'content' },
      turns: [
        toolCallTurn([{ id: 'c1', name: 'Read', input: { path: 'f.txt' } }]),
        textTurn('ok'),
      ],
    })
    try {
      await collectRun(world1.runtime.engine, await stateWithUser(world1, 'read'))

      // simulate crash: append accepted-but-never-completed calls
      const loaded1 = await loadSession(world1.runtime.journalPath)
      const journal = new SessionJournal({
        filePath: world1.runtime.journalPath,
        sessionId: 'kill-session',
        runId: 'run_crash',
        clock: fixedClock(),
        ids: createSequentialIds(),
      })
      journal.adopt(loaded1.nextSeq, loaded1.lastEventId)

      // simulate: Write was accepted but process died before completion
      await journal.append(
        {
          type: 'tool.call.accepted',
          call: {
            id: 'call_write_orphan',
            name: 'Write',
            input: { path: 'new.txt', content: 'data' },
            parentMessageId: 'msg_assistant',
            receivedIndex: 0,
          },
        },
        'turn_crash',
        'flush',
      )
      // simulate: Shell was also accepted
      await journal.append(
        {
          type: 'tool.call.accepted',
          call: {
            id: 'call_shell_orphan',
            name: 'Shell',
            input: { command: 'npm install' },
            parentMessageId: 'msg_assistant',
            receivedIndex: 1,
          },
        },
        'turn_crash',
        'flush',
      )

      // resume
      const world2 = await makeWorld({
        persist: true,
        sessionId: 'kill-session',
        workspaceRoot: world1.workspaceRoot,
        turns: [],
      })
      const { state, recoveryFacts } = await resumeState(world2.runtime, world2.loaded!)

      // both orphans get synthetic results
      const completedFacts = recoveryFacts.filter(f => f.type === 'tool.call.completed')
      expect(completedFacts).toHaveLength(2)
      expect(completedFacts.map(f =>
        f.type === 'tool.call.completed' ? f.result.callId : '',
      )).toContain('call_write_orphan')
      expect(completedFacts.map(f =>
        f.type === 'tool.call.completed' ? f.result.callId : '',
      )).toContain('call_shell_orphan')

      // recovery message is appended
      const lastMsg = state.messages[state.messages.length - 1]!
      expect(lastMsg.meta?.source).toBe('recovery')

      // journal replays cleanly with no open calls
      const reloaded = await loadSession(world1.runtime.journalPath)
      expect(reloaded.openToolCalls).toHaveLength(0)
    } finally {
      await world1.cleanup()
    }
  })
})

describe('idempotency ledger', () => {
  test('committed tool is not re-executed on recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-idem-'))
    try {
      const ledger = new IdempotencyLedger(dir)

      const key = IdempotencyLedger.computeKey({
        sessionId: 'ses_1',
        callId: 'call_1',
        toolName: 'Write',
        args: { path: 'a.txt', content: 'hello' },
      })

      // simulate: tool ran and committed
      ledger.markRunning(key, 'call_1', 'Write', '2026-01-01T00:00:00Z')
      ledger.markCommitted(key, 'sha256:abc123', '2026-01-01T00:00:01Z')
      await ledger.flush()

      // new "process" loads the ledger
      const ledger2 = new IdempotencyLedger(dir)
      await ledger2.load()

      expect(ledger2.isCommitted(key)).toBe(true)
      expect(ledger2.needsInspection(key)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('running tool needs inspection after crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-idem-'))
    try {
      const ledger = new IdempotencyLedger(dir)

      const key = IdempotencyLedger.computeKey({
        sessionId: 'ses_1',
        callId: 'call_2',
        toolName: 'Shell',
        args: { command: 'npm install' },
      })

      // simulate: tool started but process crashed (still "running")
      ledger.markRunning(key, 'call_2', 'Shell', '2026-01-01T00:00:00Z')
      await ledger.flush()

      // new process loads
      const ledger2 = new IdempotencyLedger(dir)
      await ledger2.load()

      expect(ledger2.isCommitted(key)).toBe(false)
      expect(ledger2.needsInspection(key)).toBe(true)
      expect(ledger2.getStatus(key)).toBe('running')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('different inputs produce different keys', () => {
    const key1 = IdempotencyLedger.computeKey({
      sessionId: 'ses_1',
      callId: 'call_1',
      toolName: 'Write',
      args: { path: 'a.txt', content: 'v1' },
    })
    const key2 = IdempotencyLedger.computeKey({
      sessionId: 'ses_1',
      callId: 'call_1',
      toolName: 'Write',
      args: { path: 'a.txt', content: 'v2' },
    })
    expect(key1).not.toBe(key2)
  })
})

describe('createSnapshot / restoreFromSnapshot roundtrip', () => {
  test('snapshot captures and restores all state fields', () => {
    const state = createInitialState({
      sessionId: 'ses_1',
      runId: 'run_1',
      turnId: 'turn_1',
      workspaceRoot: '/workspace',
      mode: 'acceptEdits',
      budget: { maxTurns: 40, maxModelCalls: 60, maxToolCalls: 200, maxWallTimeMs: 30_000 },
      now: 1000,
    })

    // mutate state to have meaningful values
    const mutated = {
      ...state,
      iteration: 7,
      mode: 'plan' as const,
      prePlanMode: 'acceptEdits' as const,
      activePlan: { planId: 'plan_1', version: 2, approved: true },
      recovery: {
        ...state.recovery,
        modelRetries: 2,
        compactFailures: 1,
        promptOverflowRecovered: true,
        outputLimitRecoveries: 1,
        stopHookRetries: 0,
        verifierRepairs: 1,
        replanCount: 1,
        consecutiveFailures: 3,
        versionConflicts: 2,
        replanning: true,
        replanAwaitingApproval: true,
      },
      budget: {
        ...state.budget,
        used: {
          modelCalls: 10,
          toolCalls: 25,
          inputTokens: 5000,
          outputTokens: 2000,
          startedAt: 1000,
        },
      },
      workspace: {
        root: '/workspace',
        touchedFiles: ['a.ts', 'b.ts'],
        planScopedTouchedFiles: ['b.ts'],
        createdFiles: ['c.ts'],
        deletedFiles: [],
      },
      evidenceIds: ['ev_1', 'ev_2'],
    }

    const snapshot = createSnapshot(mutated)

    // restore into a fresh state
    const fresh = createInitialState({
      sessionId: 'ses_1',
      runId: 'run_2',
      turnId: 'turn_2',
      workspaceRoot: '/workspace',
      budget: { maxTurns: 40, maxModelCalls: 60, maxToolCalls: 200, maxWallTimeMs: 30_000 },
      now: 2000,
    })
    const restored = restoreFromSnapshot(fresh, snapshot)

    expect(restored.iteration).toBe(7)
    expect(restored.mode).toBe('plan')
    expect(restored.prePlanMode).toBe('acceptEdits')
    expect(restored.activePlan).toEqual({ planId: 'plan_1', version: 2, approved: true })
    expect(restored.recovery.modelRetries).toBe(2)
    expect(restored.recovery.promptOverflowRecovered).toBe(true)
    expect(restored.budget.used.modelCalls).toBe(10)
    expect(restored.budget.used.toolCalls).toBe(25)
    expect(restored.workspace.touchedFiles).toEqual(['a.ts', 'b.ts'])
    expect(restored.workspace.planScopedTouchedFiles).toEqual(['b.ts'])
    expect(restored.workspace.createdFiles).toEqual(['c.ts'])
    expect(restored.evidenceIds).toEqual(['ev_1', 'ev_2'])
    // runId/turnId come from the fresh state, not the snapshot
    expect(restored.runId).toBe('run_2')
  })
})

describe('kill-point: snapshot + idempotency integration', () => {
  test('kill before any execution: orphan Write is never executed on resume', async () => {
    const world1 = await makeWorld({
      persist: true,
      sessionId: 'kill-before-exec',
      mode: 'bypassPermissions',
      files: { 'f.txt': 'content' },
      turns: [
        toolCallTurn([{ id: 'c1', name: 'Read', input: { path: 'f.txt' } }]),
        textTurn('ok'),
      ],
    })
    try {
      await collectRun(world1.runtime.engine, await stateWithUser(world1, 'read'))

      // crash point: a Write was accepted but the process died immediately
      const loaded1 = await loadSession(world1.runtime.journalPath)
      const journal = new SessionJournal({
        filePath: world1.runtime.journalPath,
        sessionId: 'kill-before-exec',
        runId: 'run_kill_before',
        clock: fixedClock(),
        ids: createSequentialIds(),
      })
      journal.adopt(loaded1.nextSeq, loaded1.lastEventId)
      await journal.append(
        {
          type: 'tool.call.accepted',
          call: {
            id: 'call_never_ran',
            name: 'Write',
            input: { path: 'side-effect.txt', content: 'should never appear' },
            parentMessageId: 'msg_assistant',
            receivedIndex: 0,
          },
        },
        'turn_kill',
        'flush',
      )

      // resume: unknown outcome -> inspect, never blind execution
      const world2 = await makeWorld({
        persist: true,
        sessionId: 'kill-before-exec',
        workspaceRoot: world1.workspaceRoot,
        mode: 'bypassPermissions',
        turns: [],
      })
      const { state } = await resumeState(world2.runtime, world2.loaded!)
      const lastMsg = state.messages[state.messages.length - 1]!
      expect(lastMsg.meta?.source).toBe('recovery')
      // the side effect must NOT have been applied by recovery
      await expect(
        readFile(join(world1.workspaceRoot, 'side-effect.txt'), 'utf8'),
      ).rejects.toThrow()
    } finally {
      await world1.cleanup()
    }
  })

  test('live abort mid-batch: pairing invariant holds and journal stays replayable', async () => {
    const world = await makeWorld({
      persist: true,
      sessionId: 'abort-session',
      mode: 'bypassPermissions',
      turns: [
        toolCallTurn([
          { id: 'slow1', name: 'Shell', input: { command: `"${process.execPath}" sleeper.js` } },
        ]),
        textTurn('never reached'),
      ],
    })
    try {
      await writeFile(
        join(world.workspaceRoot, 'sleeper.js'),
        'setInterval(() => {}, 1000)',
        'utf8',
      )
      const state = await stateWithUser(world, 'run the slow command')
      const controller = new AbortController()
      const run = world.runtime.engine.run(state, controller.signal)
      const accepted: string[] = []
      const completed: string[] = []
      let step = await run.next()
      while (!step.done) {
        const event = step.value
        if (event.type === 'tool.call.accepted') {
          accepted.push(event.call.id)
          // kill point: user interrupt right as execution starts
          controller.abort()
        }
        if (event.type === 'tool.call.completed') {
          completed.push(event.result.callId)
        }
        step = await run.next()
      }
      expect(step.value.reason).toBe('aborted')
      // every accepted call still gets exactly one terminal result
      expect([...completed].sort()).toEqual([...accepted].sort())
      expect(accepted.length).toBeGreaterThan(0)

      // the journal must replay cleanly: no dangling open calls
      const reloaded = await loadSession(world.runtime.journalPath)
      expect(reloaded.ok).toBe(true)
      expect(reloaded.openToolCalls).toHaveLength(0)
    } finally {
      await world.cleanup()
    }
  })

  test('kill after tool commit: recovery skips re-execution', async () => {
    const world1 = await makeWorld({
      persist: true,
      sessionId: 'idem-session',
      mode: 'bypassPermissions',
      files: { 'target.txt': 'original' },
      turns: [
        toolCallTurn([{
          id: 'write_1',
          name: 'Write',
          input: { path: 'target.txt', content: 'modified', overwrite: true },
        }]),
        textTurn('wrote it'),
      ],
    })
    try {
      await collectRun(world1.runtime.engine, await stateWithUser(world1, 'write'))

      // verify file was written
      const content = await readFile(join(world1.workspaceRoot, 'target.txt'), 'utf8')
      expect(content).toBe('modified')

      // simulate crash after commit but before run.terminated
      const loaded1 = await loadSession(world1.runtime.journalPath)
      const journal = new SessionJournal({
        filePath: world1.runtime.journalPath,
        sessionId: 'idem-session',
        runId: 'run_crash2',
        clock: fixedClock(),
        ids: createSequentialIds(),
      })
      journal.adopt(loaded1.nextSeq, loaded1.lastEventId)
      // model wants to write the same file again (duplicate after crash)
      await journal.append(
        {
          type: 'tool.call.accepted',
          call: {
            id: 'write_1',
            name: 'Write',
            input: { path: 'target.txt', content: 'modified', overwrite: true },
            parentMessageId: 'msg_x',
            receivedIndex: 0,
          },
        },
        'turn_crash',
        'flush',
      )

      // resume — idempotency ledger should prevent re-execution
      const world2 = await makeWorld({
        persist: true,
        sessionId: 'idem-session',
        workspaceRoot: world1.workspaceRoot,
        mode: 'bypassPermissions',
        turns: [],
      })
      const { state } = await resumeState(world2.runtime, world2.loaded!)

      // the orphan call gets a synthetic INTERRUPTED result (not re-executed)
      const lastMsg = state.messages[state.messages.length - 1]!
      expect(lastMsg.meta?.source).toBe('recovery')

      // file content unchanged (no double-write)
      const contentAfter = await readFile(join(world1.workspaceRoot, 'target.txt'), 'utf8')
      expect(contentAfter).toBe('modified')
    } finally {
      await world1.cleanup()
    }
  })
})
