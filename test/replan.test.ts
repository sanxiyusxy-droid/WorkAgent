import { describe, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeWorld, collectRun, stateWithUser } from './helpers.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'

/**
 * Replan protocol E2E (guide §8.5). Covers the five trigger classes:
 * consecutive_failures, version_conflict_threshold, scope_exceeded,
 * budget_pressure — and verification_failed (in verification.test.ts).
 * Acceptance: a reapproval replan disables write tools from BOTH the
 * model-facing schema and the runtime until a new plan version is approved.
 */

function findReplan(facts: Awaited<ReturnType<typeof collectRun>>['facts']) {
  return facts.find(f => f.type === 'replan.requested')
}

describe('replan protocol E2E', () => {
  test('consecutive failures: reapproval replan locks writes until a new plan is approved', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      channels: { requestPlanApproval: async () => true },
      turns: [
        toolCallTurn([{ id: 'r1', name: 'Read', input: { path: 'missing-1.txt' } }]),
        toolCallTurn([{ id: 'r2', name: 'Read', input: { path: 'missing-2.txt' } }]),
        toolCallTurn([{ id: 'r3', name: 'Read', input: { path: 'missing-3.txt' } }]),
        // after the replan the model still tries a write — must be refused
        toolCallTurn([
          { id: 'w1', name: 'Write', input: { path: 'locked.txt', content: 'no', overwrite: true } },
        ]),
        // revised plan, approved through the normal channel
        toolCallTurn([
          {
            id: 'p1',
            name: 'PlanPropose',
            input: { goal: 'revised strategy after repeated failures' },
          },
        ]),
        toolCallTurn([
          { id: 'p2', name: 'ExitPlanMode', input: { planId: 'plan_1', version: 1 } },
        ]),
        // approval lifts the lock
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
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'do the work'),
      )

      const replan = findReplan(result.facts)
      expect(replan).toBeDefined()
      if (replan!.type === 'replan.requested') {
        expect(replan!.cause).toBe('consecutive_failures')
        expect(replan!.requiresReapproval).toBe(true)
      }

      // runtime side: the write was refused while approval was pending
      const refused = result.facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'w1',
      )
      expect(refused).toMatchObject({
        result: { ok: false, errorCode: 'REPLAN_APPROVAL_PENDING' },
      })
      await expect(
        readFile(join(world.workspaceRoot, 'locked.txt'), 'utf8'),
      ).rejects.toThrow()

      // schema side: the request that produced w1 had no write tools
      const lockedRequest = world.model.requests[3]!
      const lockedNames = lockedRequest.tools.map((t: { name: string }) => t.name)
      expect(lockedNames).not.toContain('Write')
      expect(lockedNames).not.toContain('Edit')
      expect(lockedNames).not.toContain('Shell')
      expect(lockedNames).toContain('PlanPropose')
      expect(lockedNames).toContain('ExitPlanMode')

      // approval restores write access and the run completes
      expect(result.facts.some(f => f.type === 'plan.approved')).toBe(true)
      const afterApproval = world.model.requests[6]!
      expect(afterApproval.tools.map((t: { name: string }) => t.name)).toContain('Write')
      const w2 = result.facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'w2',
      )
      expect(w2).toMatchObject({ result: { ok: true } })
      await expect(
        readFile(join(world.workspaceRoot, 'out.txt'), 'utf8'),
      ).resolves.toBe('ok')

      expect(result.terminal.reason).toBe('completed')
    } finally {
      await world.cleanup()
    }
  })

  test('version conflict threshold: replan without re-approval keeps writes enabled', async () => {
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
        textTurn('reordering edits per the revised plan'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'edit a.txt'),
      )

      const replan = findReplan(result.facts)
      expect(replan).toBeDefined()
      if (replan!.type === 'replan.requested') {
        expect(replan!.cause).toBe('version_conflict_threshold')
        expect(replan!.requiresReapproval).toBe(false)
      }

      // no re-approval needed: writes stay available, no plan superseded
      expect(result.facts.some(f => f.type === 'plan.status.changed')).toBe(false)
      const edits = result.facts.filter(
        f => f.type === 'tool.call.completed' && f.result.toolName === 'Edit',
      )
      for (const edit of edits) {
        if (edit.type === 'tool.call.completed') {
          expect(edit.result.errorCode).toBe('FILE_VERSION_CONFLICT')
        }
      }

      const transitions = result.facts
        .filter(f => f.type === 'loop.transitioned')
        .map(f => (f.type === 'loop.transitioned' ? f.transition.reason : ''))
      expect(transitions).toContain('replan_required')
    } finally {
      await world.cleanup()
    }
  })

  test('scope exceeded: approved plan is superseded and writes lock', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      channels: { requestPlanApproval: async () => true },
      turns: [
        toolCallTurn([
          {
            id: 'p1',
            name: 'PlanPropose',
            input: {
              goal: 'scoped work',
              steps: [{ id: 's1', title: 'edit planned file', files: ['planned.txt'] }],
            },
          },
        ]),
        toolCallTurn([
          { id: 'p2', name: 'ExitPlanMode', input: { planId: 'plan_1', version: 1 } },
        ]),
        // two unplanned files against one planned file -> ratio 2.0
        toolCallTurn([
          { id: 'u1', name: 'Write', input: { path: 'unplanned-1.txt', content: 'x' } },
          { id: 'u2', name: 'Write', input: { path: 'unplanned-2.txt', content: 'y' } },
        ]),
        // the replan needs re-approval -> this write must be refused
        toolCallTurn([
          { id: 'u3', name: 'Write', input: { path: 'unplanned-3.txt', content: 'z' } },
        ]),
        textTurn('will propose a revised plan'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'do scoped work'),
      )

      expect(result.facts.some(f => f.type === 'plan.approved')).toBe(true)

      const replan = findReplan(result.facts)
      expect(replan).toBeDefined()
      if (replan!.type === 'replan.requested') {
        expect(replan!.cause).toBe('scope_exceeded')
        expect(replan!.requiresReapproval).toBe(true)
      }

      // the approved version is superseded in store and journal
      const superseded = result.facts.find(f => f.type === 'plan.status.changed')
      expect(superseded).toMatchObject({
        planId: 'plan_1',
        version: 1,
        status: 'superseded',
      })
      expect(world.runtime.plans.get('plan_1', 1)!.status).toBe('superseded')
      expect(world.runtime.plans.lastApproved()).toBeUndefined()

      // writes before the lock landed; the next one is refused
      await expect(
        readFile(join(world.workspaceRoot, 'unplanned-1.txt'), 'utf8'),
      ).resolves.toBe('x')
      const refused = result.facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'u3',
      )
      expect(refused).toMatchObject({
        result: { ok: false, errorCode: 'REPLAN_APPROVAL_PENDING' },
      })
      await expect(
        readFile(join(world.workspaceRoot, 'unplanned-3.txt'), 'utf8'),
      ).rejects.toThrow()
    } finally {
      await world.cleanup()
    }
  })

  test('budget pressure: low-impact replan before exhaustion', async () => {
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
      const tight = {
        ...state,
        budget: { ...state.budget, maxModelCalls: 3 },
      }
      const result = await collectRun(world.runtime.engine, tight)

      const replan = findReplan(result.facts)
      expect(replan).toBeDefined()
      if (replan!.type === 'replan.requested') {
        expect(replan!.cause).toBe('budget_pressure')
        expect(replan!.requiresReapproval).toBe(false)
      }
      expect(result.terminal.reason).toBe('budget_exhausted')
    } finally {
      await world.cleanup()
    }
  })
})
