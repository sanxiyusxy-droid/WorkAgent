import { describe, expect, test } from 'vitest'
import { loadSession } from '../src/session/SessionLoader.js'
import { SessionJournal } from '../src/session/SessionJournal.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { fixedClock, makeWorld, collectRun, stateWithUser } from './helpers.js'
import { resumeState } from '../src/app/createRuntime.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { IdempotencyLedger } from '../src/tools/IdempotencyLedger.js'
import { WriteTool } from '../src/tools/builtin/WriteTool.js'
import { computeVersion } from '../src/workspace/FileVersion.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentState } from '../src/core/state.js'

/**
 * Normalize a recovered state for field-for-field comparison:
 * runId / turnId / wall-clock fields are allowed to differ between a fresh
 * run and a recovered run — everything else must be identical.
 */
function normalize(state: AgentState): Record<string, unknown> {
  const { runId, turnId, budget, ...rest } = state
  return {
    ...rest,
    budget: {
      maxTurns: budget.maxTurns,
      maxModelCalls: budget.maxModelCalls,
      maxToolCalls: budget.maxToolCalls,
      maxWallTimeMs: budget.maxWallTimeMs,
      used: {
        modelCalls: budget.used.modelCalls,
        toolCalls: budget.used.toolCalls,
        inputTokens: budget.used.inputTokens,
        outputTokens: budget.used.outputTokens,
      },
    },
  }
}

describe('StateSnapshotV2 recovery equivalence', () => {
  test('snapshot+tail recovery is field-for-field equal to full replay', async () => {
    const world1 = await makeWorld({
      persist: true,
      sessionId: 'eq-session',
      mode: 'bypassPermissions',
      files: { 'a.txt': 'alpha' },
      turns: [
        toolCallTurn([{ id: 'c1', name: 'Read', input: { path: 'a.txt' } }]),
        toolCallTurn([{
          id: 'c2',
          name: 'Write',
          input: { path: 'b.txt', content: 'beta', overwrite: true },
        }]),
        toolCallTurn([{ id: 'c3', name: 'Read', input: { path: 'b.txt' } }]),
        toolCallTurn([{ id: 'c4', name: 'Read', input: { path: 'a.txt' } }]),
        textTurn('done'),
      ],
    })
    try {
      const run = await collectRun(
        world1.runtime.engine,
        await stateWithUser(world1, 'read and write files'),
      )
      expect(run.terminal).toEqual({ reason: 'completed' })

      const loaded = await loadSession(world1.runtime.journalPath)
      expect(loaded.ok).toBe(true)
      // the run is long enough to have produced a V2 snapshot
      expect(loaded.lastSnapshot?.version).toBe(2)
      expect(loaded.tailEvents.length).toBeGreaterThan(0)
      expect(loaded.tailEvents.length).toBeLessThan(loaded.envelopes.length)

      // Path A: V2 snapshot + tail replay
      const worldA = await makeWorld({
        persist: true,
        sessionId: 'eq-session',
        workspaceRoot: world1.workspaceRoot,
        mode: 'bypassPermissions',
        turns: [],
      })
      const { state: stateA, replayFailure: failA } = await resumeState(
        worldA.runtime,
        loaded,
      )
      expect(failA).toBeNull()

      // Path B: full replay of every FactEvent (no snapshot)
      const worldB = await makeWorld({
        persist: true,
        sessionId: 'eq-session',
        workspaceRoot: world1.workspaceRoot,
        mode: 'bypassPermissions',
        turns: [],
      })
      const { state: stateB, replayFailure: failB } = await resumeState(
        worldB.runtime,
        { ...loaded, lastSnapshot: null },
      )
      expect(failB).toBeNull()

      // field-for-field equivalence (minus runId/turnId/clock fields)
      expect(normalize(stateA)).toEqual(normalize(stateB))

      // spot-check the restored entities
      expect(stateA.messages.map(m => m.id)).toEqual(stateB.messages.map(m => m.id))
      expect(Object.keys(stateA.toolResults).sort()).toEqual(['c1', 'c2', 'c3', 'c4'])
      expect(stateA.workspace.createdFiles).toContain('b.txt')
      expect(stateA.workspace.touchedFiles).toContain('b.txt')
      expect(stateA.budget.used.modelCalls).toBe(5)
      expect(stateA.budget.used.toolCalls).toBe(4)
    } finally {
      await world1.cleanup()
    }
  })

  test('tail replay failure is reported, never silent', async () => {
    const world1 = await makeWorld({
      persist: true,
      sessionId: 'tail-fail',
      files: { 'f.txt': 'x' },
      turns: [
        toolCallTurn([{ id: 'c1', name: 'Read', input: { path: 'f.txt' } }]),
        textTurn('ok'),
      ],
    })
    try {
      await collectRun(world1.runtime.engine, await stateWithUser(world1, 'read'))

      // corrupt the tail: a duplicate terminal result for c1
      const loaded1 = await loadSession(world1.runtime.journalPath)
      const journal = new SessionJournal({
        filePath: world1.runtime.journalPath,
        sessionId: 'tail-fail',
        runId: 'run_corrupt',
        clock: fixedClock(),
        ids: createSequentialIds(),
      })
      journal.adopt(loaded1.nextSeq, loaded1.lastEventId)
      await journal.append(
        {
          type: 'tool.call.completed',
          result: {
            callId: 'c1',
            toolName: 'Read',
            ok: true,
            content: { kind: 'text', text: 'duplicate' },
            durationMs: 1,
          },
        },
        'turn_x',
        'flush',
      )

      const world2 = await makeWorld({
        persist: true,
        sessionId: 'tail-fail',
        workspaceRoot: world1.workspaceRoot,
        turns: [],
      })

      // STRICT (default): the failure is fully described and replay refuses
      // to continue past the corrupt fact (allowDegraded=false)
      const strict = await resumeState(world2.runtime, world2.loaded!)
      expect(strict.replayFailure).not.toBeNull()
      expect(strict.replayFailure!.invariant).toBe('single_terminal_tool_result')
      expect(strict.replayFailure!.seq).toBe(loaded1.nextSeq)
      expect(strict.replayFailure!.eventId).toBeTruthy()
      expect(strict.replayFailure!.allowDegraded).toBe(false)
      expect(strict.replayFailure!.lastTrustedSeq).toBeLessThan(strict.replayFailure!.seq)

      // DEGRADED (explicit opt-in): skip the bad fact and keep a usable state
      const { state, replayFailure } = await resumeState(world2.runtime, world2.loaded!, {
        degraded: true,
      })
      expect(replayFailure).not.toBeNull()
      expect(replayFailure!.allowDegraded).toBe(true)
      expect(state.messages.length).toBeGreaterThan(0)
      expect(state.toolResults['c1']).toBeDefined()
    } finally {
      await world1.cleanup()
    }
  })
})

describe('operation-level idempotency', () => {
  test('same operation with a NEW callId is deduplicated as a SUCCESS', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      turns: [
        toolCallTurn([{
          id: 'w1',
          name: 'Write',
          input: { path: 'out.txt', content: 'value', overwrite: true },
        }]),
        // model retries the identical operation under a fresh call id
        toolCallTurn([{
          id: 'w2',
          name: 'Write',
          input: { path: 'out.txt', content: 'value', overwrite: true },
        }]),
        textTurn('done'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write twice'),
      )
      const completions = result.facts.filter(f => f.type === 'tool.call.completed')
      const second = completions.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'w2',
      )
      expect(second).toBeDefined()
      if (second!.type === 'tool.call.completed') {
        // finish-list §1.4: proof re-verification succeeds → the repeat
        // surfaces as a successful deduplicated result, not a tool failure
        expect(second!.result.ok).toBe(true)
        expect(second!.result.errorCode).toBeUndefined()
        expect(JSON.stringify(second!.result.content)).toContain('deduplicated')
        expect(JSON.stringify(second!.result.content)).toContain(
          computeVersion('value'),
        )
      }
      // the file was written exactly once with the expected content
      const content = await readFile(join(world.workspaceRoot, 'out.txt'), 'utf8')
      expect(content).toBe('value')
    } finally {
      await world.cleanup()
    }
  })

  test('unknown outcome: inspectOutcome adjudicates and execution continues safely', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      persist: true,
      sessionId: 'unknown-session',
      turns: [
        toolCallTurn([{
          id: 'w9',
          name: 'Write',
          input: { path: 'u.txt', content: 'maybe', overwrite: true },
        }]),
        textTurn('done'),
      ],
    })
    try {
      // simulate: a previous run started this exact operation and died
      const parsed = WriteTool.inputSchema.parse({
        path: 'u.txt',
        content: 'maybe',
        overwrite: true,
      })
      const opKey = IdempotencyLedger.computeOperationKey({
        sessionId: world.runtime.sessionId,
        toolName: 'Write',
        args: parsed,
      })
      world.runtime.toolRuntime.idempotency.markRunning(
        opKey,
        'old_call',
        'Write',
        '2026-01-01T00:00:00Z',
      )
      await world.runtime.toolRuntime.idempotency.flush()

      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write it'),
      )
      const completion = result.facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'w9',
      )
      expect(completion).toBeDefined()
      if (completion!.type === 'tool.call.completed') {
        // the file never landed on disk, so the probe resolves
        // not-applied and the runtime re-executes safely
        expect(completion!.result.ok).toBe(true)
      }
      // audit fact records the adjudication running → resolved_not_applied
      const adjudication = result.facts.find(f => f.type === 'idempotency.adjudicated')
      expect(adjudication).toMatchObject({
        toolName: 'Write',
        from: 'running',
        to: 'resolved_not_applied',
      })
      expect(
        world.runtime.toolRuntime.idempotency.getStatus(opKey),
      ).toBe('committed')
      const content = await readFile(join(world.workspaceRoot, 'u.txt'), 'utf8')
      expect(content).toBe('maybe')
    } finally {
      await world.cleanup()
    }
  })

  test('write lock refuses side effects while a replan awaits approval', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      turns: [
        toolCallTurn([{
          id: 'wl1',
          name: 'Write',
          input: { path: 'locked.txt', content: 'no', overwrite: true },
        }]),
        textTurn('done'),
      ],
    })
    try {
      // the write gate derives from durable state: replanning + awaiting
      // approval. The engine syncs it every iteration, so it also survives
      // recovery (no manual flag fiddling).
      const base = await stateWithUser(world, 'write')
      const locked: typeof base = {
        ...base,
        recovery: {
          ...base.recovery,
          replanning: true,
          replanAwaitingApproval: true,
        },
      }
      const result = await collectRun(world.runtime.engine, locked)
      const completion = result.facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'wl1',
      )
      expect(completion).toBeDefined()
      if (completion!.type === 'tool.call.completed') {
        expect(completion!.result.errorCode).toBe('REPLAN_APPROVAL_PENDING')
      }
      await expect(
        readFile(join(world.workspaceRoot, 'locked.txt'), 'utf8'),
      ).rejects.toThrow()

      // a fresh run without the replanning state starts unlocked
      const world2turns = await makeWorld({
        mode: 'bypassPermissions',
        workspaceRoot: world.workspaceRoot,
        turns: [
          toolCallTurn([{
            id: 'wl2',
            name: 'Write',
            input: { path: 'locked.txt', content: 'yes', overwrite: true },
          }]),
          textTurn('done'),
        ],
      })
      const result2 = await collectRun(
        world2turns.runtime.engine,
        await stateWithUser(world2turns, 'write again'),
      )
      const ok = result2.facts.find(
        f =>
          f.type === 'tool.call.completed' &&
          f.result.callId === 'wl2' &&
          f.result.ok,
      )
      expect(ok).toBeDefined()
    } finally {
      await world.cleanup()
    }
  })
})
