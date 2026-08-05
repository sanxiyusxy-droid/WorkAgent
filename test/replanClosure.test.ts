import { describe, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeWorld, collectRun, stateWithUser } from './helpers.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { createInitialState, reduce, type AgentState } from '../src/core/state.js'
import type { FactEvent } from '../src/core/events.js'
import { InvariantError } from '../src/core/messages.js'

/**
 * Low-impact replan closure (finish-list §1.3, option B).
 *
 * A `requiresReapproval=false` replan must not leave `replanning=true`
 * waiting for a model reply. The engine persists a durable
 * `replan.adjustment.applied` fact (WHAT changed, WHY) and the reducer
 * exits replanning. The state machine proves start (replan.requested),
 * change (adjustment fact) and end (replanning=false) from the fact
 * stream alone.
 */

function replay(base: AgentState, facts: FactEvent[]): AgentState {
  return facts.reduce((state, fact) => reduce(state, fact), base)
}

function findAdjustment(facts: FactEvent[]) {
  return facts.find(f => f.type === 'replan.adjustment.applied')
}

describe('low-impact replan closure', () => {
  test('version conflicts: adjustment fact persists, replanning ends, writes keep working', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      files: { 'a.txt': 'alpha\n' },
      turns: [
        toolCallTurn([
          { id: 'r1', name: 'Read', input: { path: 'a.txt' } },
          { id: 'e1', name: 'Edit', input: { path: 'a.txt', oldText: 'alpha', newText: 'beta-1', expectedVersion: 'stale-version' } },
        ]),
        toolCallTurn([
          { id: 'r2', name: 'Read', input: { path: 'a.txt' } },
          { id: 'e2', name: 'Edit', input: { path: 'a.txt', oldText: 'alpha', newText: 'beta-2', expectedVersion: 'stale-version' } },
        ]),
        toolCallTurn([
          { id: 'r3', name: 'Read', input: { path: 'a.txt' } },
          { id: 'e3', name: 'Edit', input: { path: 'a.txt', oldText: 'alpha', newText: 'beta-3', expectedVersion: 'stale-version' } },
        ]),
        // after the adjustment the run follows the revised sequencing:
        // no lock, a plain write succeeds
        toolCallTurn([
          { id: 'w1', name: 'Write', input: { path: 'sequenced.txt', content: 'ok', overwrite: true } },
        ]),
        textTurn('edits resequenced'),
      ],
    })
    try {
      const initial = await stateWithUser(world, 'edit a.txt')
      const result = await collectRun(world.runtime.engine, initial)

      const requested = result.facts.find(f => f.type === 'replan.requested')
      expect(requested).toBeDefined()
      if (requested!.type === 'replan.requested') {
        expect(requested!.cause).toBe('version_conflict_threshold')
        expect(requested!.requiresReapproval).toBe(false)
      }

      // the closure fact exists, follows the request, and carries WHY
      const adjustment = findAdjustment(result.facts)
      expect(adjustment).toBeDefined()
      if (adjustment!.type === 'replan.adjustment.applied') {
        expect(adjustment!.cause).toBe('version_conflict_threshold')
        expect(adjustment!.summary.length).toBeGreaterThan(0)
      }
      const requestedIndex = result.facts.indexOf(requested!)
      expect(result.facts.indexOf(adjustment!)).toBeGreaterThan(requestedIndex)

      // replaying the fact stream ends with replanning closed
      const finalState = replay(initial, result.facts)
      expect(finalState.recovery.replanning).toBe(false)
      expect(finalState.recovery.replanAwaitingApproval).toBe(false)
      expect(finalState.recovery.replanCount).toBe(1)

      // execution followed the adjustment: writes were never locked
      const w1 = result.facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'w1',
      )
      expect(w1).toMatchObject({ result: { ok: true } })
      await expect(
        readFile(join(world.workspaceRoot, 'sequenced.txt'), 'utf8'),
      ).resolves.toBe('ok')
    } finally {
      await world.cleanup()
    }
  })

  test('budget pressure: adjustment fact closes the replan before exhaustion', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      files: { 'a.txt': 'x' },
      turns: [
        toolCallTurn([{ id: 'r1', name: 'Read', input: { path: 'a.txt' } }]),
        toolCallTurn([{ id: 'r2', name: 'Read', input: { path: 'a.txt' } }]),
        toolCallTurn([{ id: 'r3', name: 'Read', input: { path: 'a.txt' } }]),
        textTurn('acknowledged'),
      ],
    })
    try {
      const state = await stateWithUser(world, 'work within budget')
      const tight = { ...state, budget: { ...state.budget, maxModelCalls: 3 } }
      const result = await collectRun(world.runtime.engine, tight)

      const adjustment = findAdjustment(result.facts)
      expect(adjustment).toBeDefined()
      if (adjustment!.type === 'replan.adjustment.applied') {
        expect(adjustment!.cause).toBe('budget_pressure')
        expect(adjustment!.summary).toContain('Budget pressure')
      }

      const finalState = replay(tight, result.facts)
      expect(finalState.recovery.replanning).toBe(false)
      expect(result.terminal.reason).toBe('budget_exhausted')
    } finally {
      await world.cleanup()
    }
  })

  test('reducer invariants: adjustment is only valid inside an open low-impact replan', () => {
    const base = createInitialState({
      sessionId: 'ses_t',
      runId: 'run_t',
      turnId: 'turn_t',
      workspaceRoot: '/tmp',
      budget: { maxTurns: 10, maxModelCalls: 10, maxToolCalls: 10, maxWallTimeMs: 60_000 },
      now: 0,
    })
    const adjustment: FactEvent = {
      type: 'replan.adjustment.applied',
      cause: 'budget_pressure',
      summary: 'simplify',
    }

    // no open replan -> invariant violation
    expect(() => reduce(base, adjustment)).toThrow(InvariantError)

    // a reapproval replan can only end via plan.approved
    const awaiting = reduce(base, {
      type: 'replan.requested',
      cause: 'consecutive_failures',
      requiresReapproval: true,
    })
    expect(() => reduce(awaiting, adjustment)).toThrow(InvariantError)

    // a low-impact replan closes deterministically
    const open = reduce(base, {
      type: 'replan.requested',
      cause: 'budget_pressure',
      requiresReapproval: false,
    })
    expect(open.recovery.replanning).toBe(true)
    const closed = reduce(open, adjustment)
    expect(closed.recovery.replanning).toBe(false)
    expect(closed.recovery.replanAwaitingApproval).toBe(false)
  })
})
