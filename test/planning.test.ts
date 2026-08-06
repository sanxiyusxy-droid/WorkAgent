import { describe, expect, test } from 'vitest'
import { PlanStore, ApprovalRegistry } from '../src/planning/PlanStore.js'
import { TaskStore } from '../src/planning/TaskStore.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { fixedClock, makeWorld, collectRun, stateWithUser } from './helpers.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import type { EvidenceReceipt } from '../src/verification/types.js'
import { createHash } from 'node:crypto'
import { receiptHashBody } from '../src/verification/EvidenceStore.js'

function makePlanStore() {
  return new PlanStore({
    artifactDir: 'unused',
    clock: fixedClock(),
    ids: createSequentialIds(),
    persist: false,
  })
}

describe('PlanStore + ApprovalRegistry', () => {
  test('new version supersedes the previous draft', async () => {
    const store = makePlanStore()
    const v1 = await store.createVersion({ goal: 'goal v1' })
    const v2 = await store.createVersion({ planId: v1.planId, goal: 'goal v2' })
    expect(v2.version).toBe(2)
    expect(store.get(v1.planId, 1)!.status).toBe('superseded')
    expect(store.get(v1.planId, 2)!.status).toBe('draft')
  })

  test('approval token is one-shot and version-bound', () => {
    const clock = fixedClock()
    const approvals = new ApprovalRegistry({ clock })
    const token = approvals.issue({ sessionId: 's1', planId: 'p1', planVersion: 2 })

    // wrong version rejected — UI showed v2, model cannot consume for v3
    const wrong = approvals.consume({
      token: token.token,
      sessionId: 's1',
      planId: 'p1',
      planVersion: 3,
    })
    expect(wrong.ok).toBe(false)

    const right = approvals.consume({
      token: token.token,
      sessionId: 's1',
      planId: 'p1',
      planVersion: 2,
    })
    expect(right.ok).toBe(true)

    // second consumption fails
    const again = approvals.consume({
      token: token.token,
      sessionId: 's1',
      planId: 'p1',
      planVersion: 2,
    })
    expect(again.ok).toBe(false)
  })
})

describe('TaskStore invariants', () => {
  function makeStore() {
    return new TaskStore({ clock: fixedClock(), ids: createSequentialIds() })
  }

  test('at most one in_progress task', () => {
    const store = makeStore()
    const a = store.create({ subject: 'a' })
    const b = store.create({ subject: 'b' })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    expect(
      store.update({ id: a.value.id, expectedRevision: 1, patch: { status: 'in_progress' } }).ok,
    ).toBe(true)
    const second = store.update({
      id: b.value.id,
      expectedRevision: 1,
      patch: { status: 'in_progress' },
    })
    expect(second).toMatchObject({ ok: false, code: 'ALREADY_IN_PROGRESS' })
  })

  test('cannot start a task whose dependencies are incomplete', () => {
    const store = makeStore()
    const a = store.create({ subject: 'a' })
    if (!a.ok) throw new Error('setup')
    const b = store.create({ subject: 'b', dependsOn: [a.value.id] })
    if (!b.ok) throw new Error('setup')

    const result = store.update({
      id: b.value.id,
      expectedRevision: 1,
      patch: { status: 'in_progress' },
    })
    expect(result).toMatchObject({ ok: false, code: 'DEPENDENCIES_INCOMPLETE' })
  })

  test('revision conflict is detected', () => {
    const store = makeStore()
    const a = store.create({ subject: 'a' })
    if (!a.ok) throw new Error('setup')
    store.update({ id: a.value.id, expectedRevision: 1, patch: { subject: 'a2' } })
    const stale = store.update({
      id: a.value.id,
      expectedRevision: 1,
      patch: { subject: 'a3' },
    })
    expect(stale).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
  })

  test('blocked requires a reason; completed requires passed evidence', () => {
    const store = makeStore()
    const a = store.create({ subject: 'a', acceptanceCriteria: ['ac1'] })
    if (!a.ok) throw new Error('setup')

    expect(
      store.update({ id: a.value.id, expectedRevision: 1, patch: { status: 'blocked' } }),
    ).toMatchObject({ ok: false, code: 'BLOCKED_REASON_REQUIRED' })

    store.update({
      id: a.value.id,
      expectedRevision: 1,
      patch: { status: 'in_progress' },
    })

    const criteria = [
      { id: 'ac1', statement: 'tests pass', evidenceKind: 'test' as const, required: true },
    ]
    const withoutEvidence = store.update(
      { id: a.value.id, expectedRevision: 2, patch: { status: 'completed' } },
      { criteria, evidence: [] },
    )
    expect(withoutEvidence).toMatchObject({ ok: false, code: 'MISSING_EVIDENCE' })

    const receipt: EvidenceReceipt = {
      id: 'ev_1',
      sessionId: 's',
      runId: 'r',
      criterionIds: ['ac1'],
      kind: 'test',
      status: 'passed',
      invocation: { tool: 'Shell', normalizedInput: {} },
      observation: { exitCode: 0, outputPreview: 'ok' },
      startedAt: 't',
      completedAt: 't',
      sha256: '',
    }
    receipt.sha256 = createHash('sha256')
      .update(JSON.stringify(receiptHashBody(receipt)))
      .digest('hex')
    const withEvidence = store.update(
      { id: a.value.id, expectedRevision: 2, patch: { status: 'completed' } },
      { criteria, evidence: [receipt] },
    )
    expect(withEvidence.ok).toBe(true)
  })

  test('dependency cycles are rejected', () => {
    const store = makeStore()
    const a = store.create({ subject: 'a' })
    if (!a.ok) throw new Error('setup')
    const b = store.create({ subject: 'b', dependsOn: [a.value.id] })
    if (!b.ok) throw new Error('setup')

    const cycle = store.update({
      id: a.value.id,
      expectedRevision: 1,
      patch: { dependsOn: [b.value.id] },
    })
    expect(cycle).toMatchObject({ ok: false, code: 'DEPENDENCY_CYCLE' })
  })
})

describe('plan mode capability projection', () => {
  test('a write tool called in plan mode is refused with actionable guidance', async () => {
    const world = await makeWorld({
      mode: 'plan',
      turns: [
        // the model may still remember Write from earlier history and try it
        toolCallTurn([
          { id: 'w1', name: 'Write', input: { path: 'plan.txt', content: 'x' } },
        ]),
        textTurn('understood, I will use PlanPropose instead'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write the plan to a file'),
      )
      const completed = result.facts.find(f => f.type === 'tool.call.completed')
      expect(completed).toMatchObject({
        result: { ok: false, errorCode: 'TOOL_NOT_AVAILABLE_IN_MODE' },
      })

      // the refusal must explain the way forward, not just say "denied"
      if (completed?.type === 'tool.call.completed') {
        const payload = completed.result.content
        expect(payload.kind).toBe('json')
        const text = JSON.stringify(payload)
        expect(text).toContain('PlanPropose')
        expect(text).toContain('ExitPlanMode')
      }

      // no permission decision was needed: the runtime refused earlier
      expect(result.facts.some(f => f.type === 'permission.decided')).toBe(false)
    } finally {
      await world.cleanup()
    }
  })

  test('the plan mode prompt mandates the PlanPropose + ExitPlanMode workflow', async () => {
    const world = await makeWorld({ mode: 'plan', turns: [textTurn('exploring')] })
    try {
      await collectRun(world.runtime.engine, await stateWithUser(world, 'plan something'))
      const system = world.model.requests[0]!.system
      expect(system).toContain('PLAN MODE is active')
      expect(system).toContain('PlanPropose')
      expect(system).toContain('ExitPlanMode')
      // explicitly forbids the behavior seen in the field
      expect(system).toContain('click a button')
    } finally {
      await world.cleanup()
    }
  })
})

describe('plan mode E2E flow', () => {
  test('enter plan -> propose -> approve -> mode restored', async () => {
    const approvalsSeen: string[] = []
    const world = await makeWorld({
      mode: 'default',
      turns: [
        toolCallTurn([{ id: 'c1', name: 'EnterPlanMode', input: {} }]),
        toolCallTurn([
          {
            id: 'c2',
            name: 'PlanPropose',
            input: {
              goal: 'implement feature X',
              acceptanceCriteria: [
                { id: 'ac1', statement: 'tests pass', evidenceKind: 'test', required: true },
              ],
            },
          },
        ]),
        toolCallTurn([
          { id: 'c3', name: 'ExitPlanMode', input: { planId: 'plan_1', version: 1 } },
        ]),
        textTurn('plan approved, starting work... done for now'),
      ],
      channels: {
        requestPlanApproval: async plan => {
          approvalsSeen.push(`${plan.planId}@v${plan.version}`)
          return true
        },
      },
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'build feature X'),
      )

      // plan approval flowed through the one-shot token path
      expect(approvalsSeen).toEqual(['plan_1@v1'])
      expect(result.facts.some(f => f.type === 'plan.approved')).toBe(true)

      // mode entered plan then restored to the pre-plan mode
      const modeChanges = result.facts.filter(f => f.type === 'mode.changed')
      expect(modeChanges).toHaveLength(2)
      expect(modeChanges[0]).toMatchObject({ from: 'default', to: 'plan' })

      // while in plan mode, write tools were hidden from the model
      const planRequest = world.model.requests[1]!
      const names = planRequest.tools.map(t => t.name)
      expect(names).not.toContain('Edit')
      expect(names).not.toContain('Shell')
      expect(names).toContain('PlanPropose')
      expect(names).toContain('ExitPlanMode')

      // after exit, the model again sees write tools
      const afterRequest = world.model.requests[3]!
      expect(afterRequest.tools.map(t => t.name)).toContain('Edit')

      expect(world.runtime.plans.lastApproved()).toMatchObject({
        planId: 'plan_1',
        version: 1,
        status: 'approved',
      })
    } finally {
      await world.cleanup()
    }
  })

  test('rejected plan keeps plan mode and reports rejection', async () => {
    const world = await makeWorld({
      mode: 'default',
      turns: [
        toolCallTurn([{ id: 'c1', name: 'EnterPlanMode', input: {} }]),
        toolCallTurn([
          { id: 'c2', name: 'PlanPropose', input: { goal: 'change stuff' } },
        ]),
        toolCallTurn([
          { id: 'c3', name: 'ExitPlanMode', input: { planId: 'plan_1', version: 1 } },
        ]),
        textTurn('plan was rejected; asking for direction'),
      ],
      channels: { requestPlanApproval: async () => false },
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'change stuff'),
      )
      expect(result.facts.some(f => f.type === 'plan.approved')).toBe(false)
      // only one mode change (into plan); never restored
      const modeChanges = result.facts.filter(f => f.type === 'mode.changed')
      expect(modeChanges).toHaveLength(1)
    } finally {
      await world.cleanup()
    }
  })
})
