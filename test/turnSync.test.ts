import { describe, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeWorld, stateWithUser, type TestWorld } from './helpers.js'
import { driveTurn } from '../src/cli/turnRunner.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { applyFacts, reduce, type AgentState } from '../src/core/state.js'
import { isFactEvent, type AgentEvent, type FactEvent } from '../src/core/events.js'

/**
 * CLI cross-turn state truth (finish-list §1.1): the interactive loop must
 * mirror EVERY fact through the shared reducer, so plans, replan locks,
 * evidence, workspace tracking, compaction and budget survive turn
 * boundaries. These tests drive the exact same function the CLI uses
 * (driveTurn) for two consecutive runs in one session.
 */

/** Same turn-start ritual as runTurn() in main.ts. */
function beginTurn(world: TestWorld, state: AgentState, prompt: string): AgentState {
  const userMessage = world.runtime.makeUserMessage(
    prompt,
    state.messages.length > 0 ? state.messages[state.messages.length - 1]!.id : null,
  )
  state = reduce(state, { type: 'user.message.accepted', message: userMessage })
  return {
    ...state,
    iteration: 0,
    turnId: world.runtime.ids.next('turn'),
    recovery: { ...state.recovery, stopHookRetries: 0 },
    budget: {
      ...state.budget,
      used: { ...state.budget.used, startedAt: world.runtime.clock.now() },
    },
  }
}

function collectFacts(): { facts: FactEvent[]; observe: (event: AgentEvent) => void } {
  const facts: FactEvent[] = []
  return { facts, observe: event => { if (isFactEvent(event)) facts.push(event) } }
}

describe('CLI cross-turn state sync (driveTurn)', () => {
  test('a human follow-up durably reopens an unresolved verifier result', async () => {
    const world = await makeWorld({ turns: [textTurn('follow-up acknowledged')] })
    try {
      const state = world.runtime.makeInitialState()
      state.phase = 'terminated'
      state.lastVerification = {
        valid: true,
        report: {
          verdict: 'PARTIAL', summary: 'offline', checks: [], failures: [],
          unverified: [{ item: 'service', reason: 'offline' }],
        },
      }
      const prepared = beginTurn(world, state, 'continue fixing')
      expect(prepared.lastTransition).toEqual({ reason: 'user_followup' })
      expect(prepared.lastVerification).toBeUndefined()
      expect(prepared.pendingVerificationRepair).toMatchObject({
        attempt: 1,
        report: { verdict: 'PARTIAL' },
      })
    } finally {
      await world.cleanup()
    }
  })

  test('a human follow-up invalidates a terminal PASS before new work', async () => {
    const world = await makeWorld({ turns: [textTurn('follow-up acknowledged')] })
    try {
      const state = world.runtime.makeInitialState()
      state.phase = 'terminated'
      state.lastVerification = {
        valid: true,
        report: {
          verdict: 'PASS', summary: 'previous request passed', checks: [],
          failures: [], unverified: [],
        },
      }
      const prepared = beginTurn(world, state, 'make another change')
      expect(prepared.lastTransition).toEqual({ reason: 'user_followup' })
      expect(prepared.lastVerification).toBeUndefined()
      expect(prepared.pendingVerificationRepair).toBeUndefined()
    } finally {
      await world.cleanup()
    }
  })

  test('a human prompt invalidates PASS after the verifier fact but before termination', async () => {
    const world = await makeWorld({ turns: [textTurn('follow-up acknowledged')] })
    try {
      const state = world.runtime.makeInitialState()
      state.phase = 'evaluating_completion'
      state.lastVerification = {
        valid: true,
        report: {
          verdict: 'PASS', summary: 'flushed before crash', checks: [],
          failures: [], unverified: [],
        },
      }
      const prepared = beginTurn(world, state, 'new request after restart')
      expect(prepared.lastTransition).toEqual({ reason: 'user_followup' })
      expect(prepared.lastVerification).toBeUndefined()
    } finally {
      await world.cleanup()
    }
  })

  test('plan, workspace and evidence facts survive into the next turn; budget accumulates', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      channels: { requestPlanApproval: async () => true },
      turns: [
        toolCallTurn([{ id: 'p1', name: 'PlanPropose', input: { goal: 'demo plan' } }]),
        toolCallTurn([
          { id: 'p2', name: 'ExitPlanMode', input: { planId: 'plan_1', version: 1 } },
        ]),
        toolCallTurn([
          { id: 'w1', name: 'Write', input: { path: 'out.txt', content: 'v1', overwrite: true } },
        ]),
        toolCallTurn([{
          id: 's1', name: 'Shell',
          input: { command: 'rg v1 out.txt', evidenceFiles: ['out.txt'] },
        }]),
        textTurn('turn 1 done'),
        // scripted response for turn 2
        textTurn('turn 2 done'),
      ],
    })
    try {
      const base = await stateWithUser(world, 'do the work')
      const { facts, observe } = collectFacts()
      const t1 = await driveTurn(world.runtime.engine, base, new AbortController().signal, observe)
      expect(t1.terminal).toEqual({ reason: 'completed' })

      // acceptance: the CLI-visible state equals folding the same fact
      // stream through the pure reducer — one source of truth
      expect(t1.state).toEqual(applyFacts(base, facts))

      const state1 = t1.state
      expect(state1.activePlan).toMatchObject({ planId: 'plan_1', version: 1, approved: true })
      expect(state1.evidenceIds.length).toBeGreaterThan(0)
      const modelCallsAfter1 = state1.budget.used.modelCalls
      const toolCallsAfter1 = state1.budget.used.toolCalls
      expect(modelCallsAfter1).toBeGreaterThan(0)
      expect(toolCallsAfter1).toBeGreaterThan(0)

      // ---- turn 2 on the same session ----
      const prepared = beginTurn(world, state1, 'anything else?')
      const t2 = await driveTurn(world.runtime.engine, prepared, new AbortController().signal)
      expect(t2.terminal).toEqual({ reason: 'completed' })
      const state2 = t2.state

      // nothing from turn 1 may be lost at the turn boundary
      expect(state2.activePlan).toMatchObject({ planId: 'plan_1', version: 1, approved: true })
      expect(state2.evidenceIds).toEqual(state1.evidenceIds)
      expect(state2.workspace.createdFiles.some(p => p.endsWith('out.txt'))).toBe(true)
      // budget accumulates instead of restarting from the old used values
      expect(state2.budget.used.modelCalls).toBeGreaterThan(modelCallsAfter1)
      expect(state2.budget.used.toolCalls).toBeGreaterThanOrEqual(toolCallsAfter1)
    } finally {
      await world.cleanup()
    }
  })

  test('compacted messages never come back in a later turn', async () => {
    const big = 'x'.repeat(16_000)
    const world = await makeWorld({
      mode: 'bypassPermissions',
      files: { 'big.txt': big },
      // tiny window forces L1 micro-compaction as soon as the big Read lands
      context: {
        window: 1_500,
        reservedOutput: 100,
        safetyBuffer: 100,
        recentTailMessages: 1,
        recentTailTokens: 300,
        compactFailureLimit: 3,
        estimationMarginPct: 0,
      },
      turns: [
        toolCallTurn([{ id: 'r1', name: 'Read', input: { path: 'big.txt' } }]),
        textTurn('read it'),
        // turn 2
        textTurn('still fine'),
      ],
    })
    try {
      let state = await stateWithUser(world, 'read big.txt')
      const { facts, observe } = collectFacts()
      const t1 = await driveTurn(world.runtime.engine, state, new AbortController().signal, observe)
      state = t1.state
      expect(t1.terminal).toEqual({ reason: 'completed' })

      const compacted = facts.filter(f => f.type === 'context.compacted')
      expect(compacted.length).toBeGreaterThan(0)

      const messageTexts = (s: AgentState): string =>
        s.messages
          .flatMap(m => m.content)
          .map(b => (b.type === 'text' ? b.text : b.type === 'tool_result' ? String(b.content.kind === 'text' ? b.content.text : '') : ''))
          .join('\n')

      // the 16k payload must be gone from live state, replaced by the stub
      expect(messageTexts(state)).not.toContain(big)
      expect(messageTexts(state)).toContain('cleared to save context')

      // ---- turn 2: compaction must not be undone by the turn boundary ----
      state = beginTurn(world, state, 'continue')
      const t2 = await driveTurn(world.runtime.engine, state, new AbortController().signal)
      state = t2.state
      expect(t2.terminal).toEqual({ reason: 'completed' })
      expect(messageTexts(state)).not.toContain(big)
      expect(messageTexts(state)).toContain('cleared to save context')
    } finally {
      await world.cleanup()
    }
  })

  test('high-impact replan lock survives the turn boundary until a new version is approved', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      channels: { requestPlanApproval: async () => true },
      turns: [
        // turn 1: three consecutive failures trigger a reapproval replan
        toolCallTurn([{ id: 'r1', name: 'Read', input: { path: 'missing-1.txt' } }]),
        toolCallTurn([{ id: 'r2', name: 'Read', input: { path: 'missing-2.txt' } }]),
        toolCallTurn([{ id: 'r3', name: 'Read', input: { path: 'missing-3.txt' } }]),
        textTurn('noted, will replan'),
        textTurn('still awaiting approval'),
        // turn 2: write must still be locked, then the revised plan unlocks it
        toolCallTurn([
          { id: 'w1', name: 'Write', input: { path: 'locked.txt', content: 'no', overwrite: true } },
        ]),
        toolCallTurn([
          { id: 'p1', name: 'PlanPropose', input: { goal: 'revised strategy' } },
        ]),
        toolCallTurn([
          { id: 'p2', name: 'ExitPlanMode', input: { planId: 'plan_1', version: 1 } },
        ]),
        toolCallTurn([
          { id: 'w2', name: 'Write', input: { path: 'out.txt', content: 'ok', overwrite: true } },
        ]),
        toolCallTurn([{
          id: 'verify-w2', name: 'Shell',
          input: { command: 'rg ok out.txt', evidenceFiles: ['out.txt'] },
        }]),
        textTurn('done'),
      ],
    })
    try {
      let state = await stateWithUser(world, 'do the work')
      const t1 = await driveTurn(world.runtime.engine, state, new AbortController().signal)
      state = t1.state
      expect(t1.terminal?.reason).toBe('completed_with_unverified_items')

      // the replan flags are part of durable cross-turn state
      expect(state.recovery.replanning).toBe(true)
      expect(state.recovery.replanAwaitingApproval).toBe(true)

      // ---- turn 2: the lock must still be in force ----
      state = beginTurn(world, state, 'try again')
      const { facts, observe } = collectFacts()
      const t2 = await driveTurn(world.runtime.engine, state, new AbortController().signal, observe)
      state = t2.state
      expect(t2.terminal).toEqual({ reason: 'completed' })

      const refused = facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'w1',
      )
      expect(refused).toMatchObject({
        result: { ok: false, errorCode: 'REPLAN_APPROVAL_PENDING' },
      })
      await expect(readFile(join(world.workspaceRoot, 'locked.txt'), 'utf8')).rejects.toThrow()

      // approval of the new plan version lifts the lock within the same turn
      expect(facts.some(f => f.type === 'plan.approved')).toBe(true)
      const w2 = facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'w2',
      )
      expect(w2).toMatchObject({ result: { ok: true } })
      await expect(readFile(join(world.workspaceRoot, 'out.txt'), 'utf8')).resolves.toBe('ok')
      expect(state.recovery.replanning).toBe(false)
      expect(state.recovery.replanAwaitingApproval).toBe(false)
    } finally {
      await world.cleanup()
    }
  })
})
