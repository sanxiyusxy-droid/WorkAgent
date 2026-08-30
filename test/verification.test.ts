import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { collectRun, makeWorld, stateWithUser, fixedClock } from './helpers.js'
import { EvidenceStore, receiptHashBody } from '../src/verification/EvidenceStore.js'
import { validateReport } from '../src/verification/verdict.js'
import { findStaleReceipts } from '../src/verification/VerifierRunner.js'
import { readFileVersion, computeVersion } from '../src/workspace/FileVersion.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { createInitialState, reduce } from '../src/core/state.js'
import type { VerificationReport, EvidenceReceipt } from '../src/verification/types.js'

function makeReceipt(id: string, overrides?: Partial<EvidenceReceipt>): EvidenceReceipt {
  const invocation = overrides?.invocation ?? { tool: 'Shell', normalizedInput: { command: 'npm test' } }
  const observation = overrides?.observation ?? { exitCode: 0, outputPreview: '' }
  const startedAt = overrides?.startedAt ?? 't'
  const completedAt = overrides?.completedAt ?? 't'
  const base: EvidenceReceipt = {
    id,
    sessionId: 's',
    runId: 'r',
    criterionIds: [],
    kind: 'command',
    status: 'passed',
    invocation,
    observation,
    startedAt,
    completedAt,
    sha256: '',
    ...overrides,
  }
  // sign with the same canonical body the store uses
  return { ...base, sha256: createHash('sha256').update(JSON.stringify(receiptHashBody(base))).digest('hex') }
}

function makeEvidenceStore(ids: string[] = []) {
  const store = new EvidenceStore({
    sessionId: 's',
    runId: 'r',
    artifactDir: 'unused',
    clock: fixedClock(),
    ids: createSequentialIds(),
    persist: false,
  })
  for (const id of ids) {
    store.restore(makeReceipt(id))
  }
  return store
}

describe('validateReport', () => {
  const passReport = (overrides: Partial<VerificationReport>): VerificationReport => ({
    verdict: 'PASS',
    summary: 'ok',
    checks: [
      {
        name: 'build',
        criterionIds: [],
        evidenceIds: ['ev_a'],
        result: 'PASS',
        expected: 'exit 0',
        actual: 'exit 0',
      },
    ],
    adversarialProbeEvidenceId: 'ev_a',
    failures: [],
    unverified: [],
    ...overrides,
  })

  test('PASS with unknown evidence id is rejected', () => {
    const store = makeEvidenceStore([])
    expect(validateReport(passReport({}), store)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unknown evidence'),
    })
  })

  test('PASS without adversarial probe is rejected', () => {
    const store = makeEvidenceStore(['ev_a'])
    expect(
      validateReport(passReport({ adversarialProbeEvidenceId: undefined }), store),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('adversarial') })
  })

  test('PASS with a failed check is rejected', () => {
    const store = makeEvidenceStore(['ev_a'])
    const report = passReport({})
    report.checks[0]!.result = 'FAIL'
    expect(validateReport(report, store)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('failed or skipped'),
    })
  })

  test.each([
    {
      field: 'failures',
      overrides: {
        failures: [{
          title: 'real failure', severity: 'high' as const,
          reproduction: ['run the failing case'], evidenceIds: [],
        }],
      },
    },
    {
      field: 'unverified',
      overrides: {
        unverified: [{ item: 'external service', reason: 'offline' }],
      },
    },
  ])('PASS containing $field is rejected', ({ overrides }) => {
    const store = makeEvidenceStore(['ev_a'])
    expect(validateReport(passReport(overrides), store)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('cannot contain'),
    })
  })

  test('valid PASS is accepted', () => {
    const store = makeEvidenceStore(['ev_a'])
    expect(validateReport(passReport({}), store)).toEqual({ ok: true })
  })

  test('PASS rejected when evidence status is failed', () => {
    const store = new EvidenceStore({
      sessionId: 's', runId: 'r', artifactDir: 'unused',
      clock: fixedClock(), ids: createSequentialIds(), persist: false,
    })
    store.restore(makeReceipt('ev_a', { status: 'failed' }))
    expect(validateReport(passReport({}), store)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("status \"failed\""),
    })
  })

  test('PASS rejected when evidence has non-zero exitCode', () => {
    const store = new EvidenceStore({
      sessionId: 's', runId: 'r', artifactDir: 'unused',
      clock: fixedClock(), ids: createSequentialIds(), persist: false,
    })
    store.restore(makeReceipt('ev_a', {
      observation: { exitCode: 1, outputPreview: 'error' },
    }))
    expect(validateReport(passReport({}), store)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('exitCode=1'),
    })
  })

  test('PASS rejected when adversarial probe is trivial (echo)', () => {
    const store = new EvidenceStore({
      sessionId: 's', runId: 'r', artifactDir: 'unused',
      clock: fixedClock(), ids: createSequentialIds(), persist: false,
    })
    store.restore(makeReceipt('ev_a', {
      invocation: { tool: 'Shell', normalizedInput: { command: 'echo ok' } },
    }))
    expect(validateReport(passReport({}), store)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('trivial'),
    })
  })

  test('PASS rejected when required criteria not covered', () => {
    const store = new EvidenceStore({
      sessionId: 's', runId: 'r', artifactDir: 'unused',
      clock: fixedClock(), ids: createSequentialIds(), persist: false,
    })
    // receipt properly bound to ac1 so only the coverage check (ac2 missing)
    // can fire here
    store.restore(makeReceipt('ev_a', { criterionIds: ['ac1'] }))
    const criteria = [
      { id: 'ac1', statement: 'tests pass', evidenceKind: 'command' as const, required: true },
      { id: 'ac2', statement: 'lint clean', evidenceKind: 'command' as const, required: true },
    ]
    // report checks only cover ac1
    const report = passReport({})
    report.checks[0]!.criterionIds = ['ac1']
    expect(validateReport(report, store, criteria)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('ac2'),
    })
  })

  test('SHA-256 tamper detection downgrades evidence to inconclusive', () => {
    const store = new EvidenceStore({
      sessionId: 's', runId: 'r', artifactDir: 'unused',
      clock: fixedClock(), ids: createSequentialIds(), persist: false,
    })
    const receipt = makeReceipt('ev_tampered')
    // tamper with the observation after signing
    const tampered = { ...receipt, observation: { exitCode: 0, outputPreview: 'hacked' } }
    store.restore(tampered)
    // status should be downgraded to inconclusive
    expect(store.get('ev_tampered')!.status).toBe('inconclusive')
  })

  test('PARTIAL without environmental limits is rejected', () => {
    const store = makeEvidenceStore([])
    expect(
      validateReport(
        { verdict: 'PARTIAL', summary: '', checks: [], failures: [], unverified: [] },
        store,
      ),
    ).toMatchObject({ ok: false })
  })

  test('PASS rejected when a check claims a criterion its evidence never measured', () => {
    const store = makeEvidenceStore(['ev_a']) // receipt signed with criterionIds: []
    const report = passReport({})
    report.checks[0]!.criterionIds = ['ac1']
    expect(validateReport(report, store)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('signed for that criterion'),
    })
  })

  test('PASS accepted when the check criterion is backed by the receipt', () => {
    const store = new EvidenceStore({
      sessionId: 's', runId: 'r', artifactDir: 'unused',
      clock: fixedClock(), ids: createSequentialIds(), persist: false,
    })
    store.restore(makeReceipt('ev_a', { criterionIds: ['ac1'] }))
    const report = passReport({})
    report.checks[0]!.criterionIds = ['ac1']
    expect(validateReport(report, store)).toEqual({ ok: true })
  })

  test('PASS rejected when backing evidence kind does not match the criterion', () => {
    const store = new EvidenceStore({
      sessionId: 's', runId: 'r', artifactDir: 'unused',
      clock: fixedClock(), ids: createSequentialIds(), persist: false,
    })
    // criterion demands a test run, but the backing receipt is a plain command
    store.restore(makeReceipt('ev_a', { kind: 'command', criterionIds: ['ac1'] }))
    const criteria = [
      { id: 'ac1', statement: 'tests pass', evidenceKind: 'test' as const, required: true },
    ]
    const report = passReport({})
    report.checks[0]!.criterionIds = ['ac1']
    expect(validateReport(report, store, criteria)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('requires evidence of kind "test"'),
    })
  })

  test('stale evidence is rejected', () => {
    const store = makeEvidenceStore(['ev_a'])
    expect(
      validateReport(passReport({}), store, undefined, new Set(['ev_a'])),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('stale evidence'),
    })
  })

  test('SHA-256 tamper detection covers criterionIds and status', () => {
    const freshStore = () =>
      new EvidenceStore({
        sessionId: 's', runId: 'r', artifactDir: 'unused',
        clock: fixedClock(), ids: createSequentialIds(), persist: false,
      })
    const receipt = makeReceipt('ev_x', { criterionIds: ['ac1'], status: 'failed' })
    // re-target the receipt at a different criterion after signing
    const s1 = freshStore()
    s1.restore({ ...receipt, criterionIds: ['ac2'] })
    expect(s1.get('ev_x')!.status).toBe('inconclusive')
    // upgrade a failed run to passed after signing
    const s2 = freshStore()
    s2.restore({ ...receipt, status: 'passed' })
    expect(s2.get('ev_x')!.status).toBe('inconclusive')
  })
})

describe('completion gate E2E', () => {
  test('unplanned workspace writes get one repair turn, then terminate unverified', async () => {
    const world = await makeWorld({
      mode: 'acceptEdits',
      verification: { enabled: true, riskThreshold: 1 },
      turns: [
        toolCallTurn([{
          id: 'write_unplanned', name: 'Write',
          input: { path: 'out.txt', content: 'unverified' },
        }]),
        textTurn('done'),
        textTurn('no validation is available'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write out.txt'),
      )
      const injected = result.facts.filter(
        fact =>
          fact.type === 'user.message.accepted' &&
          fact.message.meta?.source === 'engine',
      )
      expect(injected).toHaveLength(1)
      if (injected[0]?.type === 'user.message.accepted') {
        expect(injected[0].message.content).toEqual([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('durable workspace verification obligation'),
          }),
        ])
      }
      expect(result.terminal).toMatchObject({
        reason: 'completed_with_unverified_items',
        items: [expect.stringContaining('durable workspace verification obligation')],
      })
      expect(result.facts).not.toContainEqual(expect.objectContaining({
        type: 'verification.completed',
      }))
    } finally {
      await world.cleanup()
    }
  })

  test('fresh runtime evidence after an unplanned write permits completion', async () => {
    const world = await makeWorld({
      mode: 'acceptEdits',
      askHandler: async () => 'allow',
      files: {
        'verify.test.js':
          "const test=require('node:test');const assert=require('node:assert/strict');" +
          "const fs=require('node:fs');test('output',()=>assert.equal(fs.readFileSync('out.txt','utf8'),'verified'));",
      },
      turns: [
        toolCallTurn([{
          id: 'write_then_check', name: 'Write',
          input: { path: 'out.txt', content: 'verified' },
        }]),
        toolCallTurn([{
          id: 'check_after_write', name: 'Shell',
          input: {
            command: 'node --test verify.test.js', evidenceKind: 'test',
            evidenceFiles: ['out.txt'],
          },
        }]),
        textTurn('validated and complete'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write and validate out.txt'),
      )
      expect(result.facts).toContainEqual(expect.objectContaining({
        type: 'evidence.recorded',
        receipt: expect.objectContaining({
          status: 'passed', kind: 'test', workspaceRevision: 2,
        }),
      }))
      expect(result.terminal).toEqual({ reason: 'completed' })
    } finally {
      await world.cleanup()
    }
  })

  test('an unrelated version command cannot verify an unplanned write', async () => {
    const world = await makeWorld({
      mode: 'acceptEdits',
      verification: { enabled: true, riskThreshold: 1 },
      turns: [
        toolCallTurn([{
          id: 'write_before_version', name: 'Write',
          input: { path: 'out.txt', content: 'unverified' },
        }]),
        toolCallTurn([{
          id: 'version_only', name: 'Shell',
          input: { command: 'node --version', evidenceKind: 'test' },
        }]),
        textTurn('done'),
        textTurn('still done'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write out.txt'),
      )
      expect(result.terminal).toMatchObject({
        reason: 'completed_with_unverified_items',
        items: [expect.stringContaining('durable workspace verification obligation')],
      })
      expect(result.facts).not.toContainEqual(expect.objectContaining({
        type: 'verification.completed',
      }))
    } finally {
      await world.cleanup()
    }
  })

  test('a pending reflection cannot turn completion reflection into a no-op loop', async () => {
    const world = await makeWorld({
      turns: [textTurn('answer complete')],
      intelligence: { completionReflection: true },
    })
    try {
      const state = await stateWithUser(world, 'answer this question')
      state.reflections = [{
        id: 'reflection_pending', trigger: 'periodic', createdAt: 't',
        summary: 'waiting for a bounded evaluation window', assumptions: [],
        progress: {
          completedTasks: 0, totalTasks: 0, touchedFiles: 0, toolCalls: 0,
          evidenceReceipts: 0, successfulToolCalls: 0,
        },
        evidenceGaps: [], recommendation: 'continue',
        decision: {
          action: 'continue_step', rationale: 'observe more work',
          successSignals: ['progress'], evaluateAfterToolCalls: 3,
        },
      }]
      const result = await collectRun(world.runtime.engine, state)
      expect(result.terminal).toEqual({ reason: 'completed' })
      expect(world.model.requests).toHaveLength(1)
      expect(result.facts).not.toContainEqual(expect.objectContaining({
        type: 'loop.transitioned',
        transition: expect.objectContaining({ reason: 'reflection_requested' }),
      }))
    } finally {
      await world.cleanup()
    }
  })

  test('completion reflection is detected when the bounded history is already full', async () => {
    const world = await makeWorld({
      turns: [textTurn('first answer'), textTurn('answer after reflection')],
      intelligence: { completionReflection: true },
    })
    try {
      const state = await stateWithUser(world, 'answer with one final reflection')
      state.reflections = Array.from({ length: 20 }, (_, index) => ({
        id: `old_reflection_${index}`, trigger: 'periodic' as const, createdAt: 't',
        summary: 'historical display-only reflection', assumptions: [],
        progress: {
          completedTasks: 0, totalTasks: 0, touchedFiles: 0, toolCalls: 0,
          evidenceReceipts: 0, successfulToolCalls: 0,
        },
        evidenceGaps: [], recommendation: 'continue',
      }))
      const result = await collectRun(world.runtime.engine, state)
      const completionReflection = result.facts.find(
        fact =>
          fact.type === 'reflection.recorded' &&
          fact.reflection.trigger === 'completion',
      )
      expect(completionReflection).toBeDefined()
      expect(result.facts).toContainEqual(expect.objectContaining({
        type: 'loop.transitioned',
        transition: { reason: 'reflection_requested', trigger: 'completion' },
      }))
      expect(world.model.requests).toHaveLength(2)
      expect(result.terminal).toEqual({ reason: 'completed' })
    } finally {
      await world.cleanup()
    }
  })

  test('open task blocks completion once, then honest termination', async () => {
    const world = await makeWorld({
      turns: [
        toolCallTurn([
          { id: 'c1', name: 'TaskCreate', input: { subject: 'implement thing' } },
        ]),
        toolCallTurn([
          {
            id: 'c2',
            name: 'TaskUpdate',
            input: { id: 'task_1', expectedRevision: 1, status: 'in_progress' },
          },
        ]),
        textTurn('All done!'), // lies: task still in_progress
        textTurn('Actually the task is still open, here is the honest state.'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'do the thing'),
      )
      // gate injected exactly one engine message
      const injected = result.facts.filter(
        f =>
          f.type === 'user.message.accepted' &&
          f.message.meta?.source === 'engine',
      )
      expect(injected).toHaveLength(1)
      const transitions = result.facts
        .filter(f => f.type === 'loop.transitioned')
        .map(f => (f.type === 'loop.transitioned' ? f.transition.reason : ''))
      expect(transitions).toContain('stop_hook_blocking')

      // second attempt does not loop forever: honest terminal
      expect(result.terminal.reason).toBe('completed_with_unverified_items')
      if (result.terminal.reason === 'completed_with_unverified_items') {
        expect(result.terminal.items.join(' ')).toContain('task_1')
      }
    } finally {
      await world.cleanup()
    }
  })

  test('TaskUpdate cannot complete a task without required evidence (E2E)', async () => {
    const world = await makeWorld({
      mode: 'default',
      turns: [
        toolCallTurn([{ id: 'c0', name: 'EnterPlanMode', input: {} }]),
        toolCallTurn([
          {
            id: 'c1',
            name: 'PlanPropose',
            input: {
              goal: 'g',
              acceptanceCriteria: [
                { id: 'ac1', statement: 'tests pass', evidenceKind: 'test', required: true },
              ],
            },
          },
        ]),
        toolCallTurn([
          { id: 'c2', name: 'ExitPlanMode', input: { planId: 'plan_1', version: 1 } },
        ]),
        toolCallTurn([
          {
            id: 'c3',
            name: 'TaskCreate',
            input: { subject: 't', acceptanceCriteria: ['ac1'] },
          },
        ]),
        toolCallTurn([
          {
            id: 'c4',
            name: 'TaskUpdate',
            input: { id: 'task_1', expectedRevision: 1, status: 'in_progress' },
          },
        ]),
        toolCallTurn([
          {
            id: 'c5',
            name: 'TaskUpdate',
            input: { id: 'task_1', expectedRevision: 2, status: 'completed' },
          },
        ]),
        toolCallTurn([
          {
            id: 'c6',
            name: 'TaskUpdate',
            input: {
              id: 'task_1',
              expectedRevision: 2,
              status: 'failed',
              blockedReason: 'cannot produce evidence in this test',
            },
          },
        ]),
        textTurn('reporting honestly: task failed'),
        textTurn('final'),
      ],
      channels: { requestPlanApproval: async () => true },
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'do it'),
      )
      // the completed attempt was rejected by the store
      const c5 = result.facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'c5',
      )
      expect(c5).toBeDefined()
      const task = world.runtime.tasks.get('task_1')
      expect(task?.status).toBe('failed') // c6 succeeded; completed was refused
    } finally {
      await world.cleanup()
    }
  })
})

describe('verification E2E', () => {
  const failReportJson = JSON.stringify({
    verdict: 'FAIL',
    summary: 'found a bug',
    checks: [
      {
        name: 'probe',
        criterionIds: [],
        evidenceIds: [],
        result: 'FAIL',
        expected: 'works',
        actual: 'broken',
      },
    ],
    failures: [
      { title: 'edge case broken', severity: 'high', reproduction: ['run x'], evidenceIds: [] },
    ],
    unverified: [],
  })

  test('reducer rejects an invalid PASS fact instead of failing open', () => {
    const state = createInitialState({
      sessionId: 's', runId: 'r', turnId: 't', workspaceRoot: 'workspace',
      now: 0,
      budget: { maxTurns: 1, maxModelCalls: 1, maxToolCalls: 1, maxWallTimeMs: 1 },
    })
    expect(() => reduce(state, {
      type: 'verification.completed',
      valid: false,
      report: {
        verdict: 'PASS', summary: 'invalid', checks: [], failures: [],
        unverified: [],
      },
    })).toThrow(/invalid verifier report cannot be persisted as PASS/i)
  })

  test('verifier FAIL repairs once, then escalates to the replan protocol', async () => {
    const world = await makeWorld({
      mode: 'acceptEdits',
      askHandler: async () => 'allow',
      files: {
        'verify.test.js':
          "const test=require('node:test');const assert=require('node:assert/strict');" +
          "const fs=require('node:fs');test('output',()=>assert.match(fs.readFileSync('out.txt','utf8'),/^v[12]$/));",
      },
      verification: { enabled: true, riskThreshold: 1, maxRepairAttempts: 1 },
      turns: [
        // main agent: one write -> risk >= 1
        toolCallTurn([
          { id: 'w1', name: 'Write', input: { path: 'out.txt', content: 'v1' } },
        ]),
        toolCallTurn([{
          id: 'e1', name: 'Shell',
          input: {
            command: 'node --test verify.test.js', evidenceKind: 'test',
            evidenceFiles: ['out.txt'],
          },
        }]),
        textTurn('done'), // -> gate complete -> verifier round 1
        textTurn(failReportJson), // verifier report: FAIL
        textTurn('fixed the finding'), // main agent repair answer -> verifier round 2
        textTurn(failReportJson), // verifier still FAIL -> repairs exhausted -> replan
        textTurn('revised approach after replan'), // -> verifier round 3
        textTurn(
          JSON.stringify({
            verdict: 'PASS',
            summary: 'looks fine',
            checks: [
              {
                name: 'check',
                criterionIds: [],
                evidenceIds: ['ev_fabricated'],
                result: 'PASS',
                expected: 'x',
                actual: 'x',
              },
            ],
            adversarialProbeEvidenceId: 'ev_fabricated',
            failures: [],
            unverified: [],
          }),
        ), // fabricated evidence -> degraded to PARTIAL -> honest terminal
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write the file'),
      )

      const verifications = result.facts.filter(
        f => f.type === 'verification.completed',
      )
      expect(verifications).toHaveLength(3)

      const transitions = result.facts
        .filter(f => f.type === 'loop.transitioned')
        .map(f => (f.type === 'loop.transitioned' ? f.transition.reason : ''))
      expect(transitions.filter(t => t === 'verification_repair')).toHaveLength(1)
      expect(transitions.filter(t => t === 'replan_required')).toHaveLength(1)

      // exhausted repairs escalate into a bounded replan (verifier FAIL is
      // one of the five protocol triggers)
      const replan = result.facts.find(f => f.type === 'replan.requested')
      expect(replan).toBeDefined()
      if (replan!.type === 'replan.requested') {
        expect(replan!.cause).toBe('verification_failed')
        expect(replan!.requiresReapproval).toBe(false)
      }

      // low-impact replan: the durable adjustment fact closes replanning
      // without waiting for a model reply
      const adjustment = result.facts.find(f => f.type === 'replan.adjustment.applied')
      expect(adjustment).toBeDefined()
      if (adjustment!.type === 'replan.adjustment.applied') {
        expect(adjustment!.cause).toBe('verification_failed')
      }

      expect(result.terminal.reason).toBe('completed_with_unverified_items')
    } finally {
      await world.cleanup()
    }
  })

  test('approved-plan verifier repair reopens writes and preserves the FAIL across replay state', async () => {
    const partialReport = JSON.stringify({
      verdict: 'PARTIAL',
      summary: 'environment-limited follow-up',
      checks: [],
      failures: [],
      unverified: [
        { item: 'external integration', reason: 'not available in this harness' },
      ],
    })
    const world = await makeWorld({
      mode: 'acceptEdits',
      askHandler: async () => 'allow',
      files: {
        'verify.test.js':
          "const test=require('node:test');const assert=require('node:assert/strict');" +
          "const fs=require('node:fs');test('output',()=>assert.match(fs.readFileSync('out.txt','utf8'),/^v[12]$/));",
      },
      verification: { enabled: true, riskThreshold: 1, maxRepairAttempts: 1 },
      channels: { requestPlanApproval: async () => true },
      turns: [
        toolCallTurn([{ id: 'enter_plan', name: 'EnterPlanMode', input: {} }]),
        toolCallTurn([{
          id: 'propose_plan',
          name: 'PlanPropose',
          input: {
            goal: 'write and verify out.txt',
            steps: [{
              id: 'step_1',
              title: 'write output',
              description: 'create the approved output',
              files: ['out.txt'],
              dependsOn: [],
              expectedOutcome: 'out.txt is verified',
            }],
          },
        }]),
        toolCallTurn([{
          id: 'approve_plan',
          name: 'ExitPlanMode',
          input: { planId: 'plan_1', version: 1 },
        }]),
        toolCallTurn([{
          id: 'create_task',
          name: 'TaskCreate',
          input: { subject: 'write output', stepId: 'step_1' },
        }]),
        toolCallTurn([{
          id: 'start_task',
          name: 'TaskUpdate',
          input: { id: 'task_1', expectedRevision: 1, status: 'in_progress' },
        }]),
        toolCallTurn([{
          id: 'initial_write',
          name: 'Write',
          input: { path: 'out.txt', content: 'v1' },
        }]),
        toolCallTurn([{
          id: 'initial_evidence', name: 'Shell',
          input: {
            command: 'node --test verify.test.js', evidenceKind: 'test',
            evidenceFiles: ['out.txt'],
          },
        }]),
        toolCallTurn([{
          id: 'complete_task',
          name: 'TaskUpdate',
          input: { id: 'task_1', expectedRevision: 2, status: 'completed' },
        }]),
        textTurn('ready for independent verification'),
        textTurn(failReportJson),
        toolCallTurn([{
          id: 'repair_write',
          name: 'Write',
          input: { path: 'out.txt', content: 'v2', overwrite: true },
        }]),
        toolCallTurn([{
          id: 'repair_evidence', name: 'Shell',
          input: {
            command: 'node --test verify.test.js', evidenceKind: 'test',
            evidenceFiles: ['out.txt'],
          },
        }]),
        textTurn('repair complete; verify again'),
        textTurn(partialReport),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write and verify out.txt'),
      )
      expect(result.facts.some(fact => fact.type === 'plan.approved')).toBe(true)
      expect(world.runtime.tasks.get('task_1')?.status).toBe('completed')

      const failIndex = result.facts.findIndex(
        fact =>
          fact.type === 'verification.completed' &&
          fact.report.verdict === 'FAIL',
      )
      expect(failIndex).toBeGreaterThanOrEqual(0)
      const failFact = result.facts[failIndex]
      expect(failFact).toMatchObject({
        type: 'verification.completed',
        repairAttempt: 1,
      })
      const repairLane = result.facts.slice(failIndex + 1).find(
        fact => fact.type === 'tool.lane.selected',
      )
      expect(repairLane).toMatchObject({
        selection: { action: 'continue_step', lane: 'open' },
      })

      const verifierRequestIndex = world.model.requests.findIndex(request =>
        request.system.includes('adversarial verification agent'),
      )
      expect(verifierRequestIndex).toBeGreaterThanOrEqual(0)
      const repairRequest = world.model.requests
        .slice(verifierRequestIndex + 1)
        .find(request => !request.system.includes('adversarial verification agent'))
      expect(repairRequest?.system).toContain('edge case broken')
      expect(repairRequest?.tools.map(tool => tool.name)).toEqual(
        expect.arrayContaining(['Write', 'Edit', 'ApplyPatch']),
      )
      expect(result.facts.find(
        fact =>
          fact.type === 'tool.call.completed' &&
          fact.result.callId === 'repair_write',
      )).toMatchObject({ result: { ok: true } })
      await expect(readFile(join(world.workspaceRoot, 'out.txt'), 'utf8')).resolves.toBe('v2')
      expect(result.terminal.reason).toBe('completed_with_unverified_items')
    } finally {
      await world.cleanup()
    }
  })

  test('a replayed non-PASS verification can never fall through to completed', async () => {
    const world = await makeWorld({
      verification: { enabled: true, riskThreshold: 1, maxRepairAttempts: 0 },
      turns: [textTurn('resume after the verifier result')],
    })
    try {
      let state = await stateWithUser(world, 'resume')
      state = reduce(state, {
        type: 'verification.completed',
        valid: true,
        report: {
          verdict: 'PARTIAL',
          summary: 'environment limited',
          checks: [],
          failures: [],
          unverified: [{ item: 'external service', reason: 'offline' }],
        },
      })
      const result = await collectRun(world.runtime.engine, state)
      expect(result.terminal).toEqual({
        reason: 'completed_with_unverified_items',
        items: ['external service: offline'],
      })
    } finally {
      await world.cleanup()
    }
  })

  test('invalid verifier report degrades to PARTIAL, never PASS', async () => {
    const bogusPass = JSON.stringify({
      verdict: 'PASS',
      summary: 'looks fine',
      checks: [
        {
          name: 'check',
          criterionIds: [],
          evidenceIds: ['ev_fabricated'],
          result: 'PASS',
          expected: 'x',
          actual: 'x',
        },
      ],
      adversarialProbeEvidenceId: 'ev_fabricated',
      failures: [],
      unverified: [],
    })
    const world = await makeWorld({
      mode: 'acceptEdits',
      askHandler: async () => 'allow',
      files: {
        'verify.test.js':
          "const test=require('node:test');const assert=require('node:assert/strict');" +
          "const fs=require('node:fs');test('output',()=>assert.match(fs.readFileSync('out.txt','utf8'),/^v1$/));",
      },
      verification: { enabled: true, riskThreshold: 1, maxRepairAttempts: 0 },
      turns: [
        toolCallTurn([
          { id: 'w1', name: 'Write', input: { path: 'out.txt', content: 'v1' } },
        ]),
        toolCallTurn([{
          id: 'e1', name: 'Shell',
          input: {
            command: 'node --test verify.test.js', evidenceKind: 'test',
            evidenceFiles: ['out.txt'],
          },
        }]),
        textTurn('done'),
        textTurn(bogusPass), // fabricated evidence -> rejected
        textTurn(bogusPass), // second strike -> PARTIAL fallback
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write the file'),
      )
      const verification = result.facts.find(
        f => f.type === 'verification.completed',
      )
      expect(verification).toMatchObject({
        valid: false,
        report: { verdict: 'PARTIAL' },
      })
      // fabricated PASS never becomes a clean completion
      expect(result.terminal.reason).toBe('completed_with_unverified_items')
    } finally {
      await world.cleanup()
    }
  })
})

describe('evidence freshness (fileVersions binding)', () => {
  test('findStaleReceipts flags changed and deleted files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-stale-'))
    try {
      const file = join(dir, 'a.txt')
      await writeFile(file, 'v1', 'utf8')
      const store = new EvidenceStore({
        sessionId: 's', runId: 'r', artifactDir: 'unused',
        clock: fixedClock(), ids: createSequentialIds(), persist: false,
      })
      const { version } = await readFileVersion(file)
      const receipt = await store.record({
        kind: 'command',
        status: 'passed',
        invocation: { tool: 'Shell', normalizedInput: { command: 'npm test' } },
        observation: { exitCode: 0, outputPreview: '' },
        startedAt: 't',
        fileVersions: { [file]: version },
      })
      // matching workspace version: fresh
      expect(await findStaleReceipts(store)).not.toContain(receipt.id)
      // content changed after signing: stale
      await writeFile(file, 'v2', 'utf8')
      expect(await findStaleReceipts(store)).toContain(receipt.id)
      // deleted files are stale too — the observation no longer holds
      await rm(file)
      expect(await findStaleReceipts(store)).toContain(receipt.id)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('Shell binds evidenceFiles versions into the signed receipt', async () => {
    const world = await makeWorld({
      mode: 'acceptEdits',
      files: { 'target.txt': 'hello' },
      turns: [
        toolCallTurn([
          {
            id: 's1',
            name: 'Shell',
            input: { command: 'echo verify', evidenceFiles: ['target.txt'] },
          },
        ]),
        textTurn('done'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'run it'),
      )
      expect(result.terminal.reason).toBe('completed')
      const receipts = world.runtime.evidence.list()
      expect(receipts).toHaveLength(1)
      const versions = receipts[0]!.fileVersions ?? {}
      const keys = Object.keys(versions)
      expect(keys).toHaveLength(1)
      // key is the resolved absolute path inside the workspace
      expect(keys[0]!.endsWith('target.txt')).toBe(true)
      expect(versions[keys[0]!]).toBe(computeVersion(Buffer.from('hello')))
    } finally {
      await world.cleanup()
    }
  })

  test('Shell skips evidenceFiles that escape the workspace', async () => {
    const world = await makeWorld({
      mode: 'acceptEdits',
      files: { 'target.txt': 'hello' },
      turns: [
        toolCallTurn([
          {
            id: 's1',
            name: 'Shell',
            input: {
              command: 'echo verify',
              evidenceFiles: ['target.txt', '../../../outside.txt'],
            },
          },
        ]),
        textTurn('done'),
      ],
    })
    try {
      await collectRun(world.runtime.engine, await stateWithUser(world, 'run it'))
      const versions = world.runtime.evidence.list()[0]!.fileVersions ?? {}
      const keys = Object.keys(versions)
      // only the in-workspace file is bound; the escape attempt is skipped
      expect(keys).toHaveLength(1)
      expect(keys[0]!.endsWith('target.txt')).toBe(true)
    } finally {
      await world.cleanup()
    }
  })
})
