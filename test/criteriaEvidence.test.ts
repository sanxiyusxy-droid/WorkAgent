import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { evaluateCompletion, requiredCriteriaWithoutEvidence } from '../src/planning/completionGate.js'
import { TaskStore } from '../src/planning/TaskStore.js'
import type { AcceptanceCriterion } from '../src/planning/types.js'
import { createInitialState } from '../src/core/state.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { EvidenceStore, receiptHashBody } from '../src/verification/EvidenceStore.js'
import { findStaleReceipts } from '../src/verification/freshness.js'
import type { EvidenceReceipt } from '../src/verification/types.js'
import { fixedClock } from './helpers.js'

const MANUAL: AcceptanceCriterion = {
  id: 'ac_manual',
  statement: 'a human confirms the interaction',
  evidenceKind: 'manual',
  required: true,
}

function sign(receipt: EvidenceReceipt): EvidenceReceipt {
  return {
    ...receipt,
    sha256: createHash('sha256')
      .update(JSON.stringify(receiptHashBody(receipt)))
      .digest('hex'),
  }
}

describe('shared criterion evidence policy', () => {
  test('superseded-plan tasks do not block the current plan completion gate', () => {
    const state = createInitialState({
      sessionId: 's', runId: 'r', turnId: 't', workspaceRoot: 'workspace',
      now: 0, mode: 'default',
      budget: {
        maxModelCalls: 10, maxToolCalls: 10, maxWallTimeMs: 10_000, maxTurns: 10,
      },
    })
    state.tasks = [
      {
        id: 'old_task', planId: 'p', planVersion: 1, stepId: 'old_step',
        subject: 'retired work', description: '', activeForm: 'retired',
        status: 'blocked', blockedReason: 'superseded', dependsOn: [],
        acceptanceCriteria: [], evidenceIds: [], revision: 1,
        createdAt: 't', updatedAt: 't',
      },
      {
        id: 'new_task', planId: 'p', planVersion: 2, stepId: 'new_step',
        subject: 'current work', description: '', activeForm: 'done',
        status: 'completed', dependsOn: [], acceptanceCriteria: [], evidenceIds: [],
        revision: 1, createdAt: 't', updatedAt: 't',
      },
    ]
    const result = evaluateCompletion({
      state,
      approvedPlan: {
        planId: 'p', version: 2, status: 'approved', goal: 'new goal',
        nonGoals: [], assumptions: [], decisions: [], steps: [],
        acceptanceCriteria: [], risks: [], createdAt: 't',
      },
      evidence: [],
      riskThreshold: 5,
    })
    expect(result.action).toBe('complete')
    expect(result.missing).toEqual([])
  })

  test('a failed task in the current plan cannot pass the completion gate', () => {
    const state = createInitialState({
      sessionId: 's', runId: 'r', turnId: 't', workspaceRoot: 'workspace',
      now: 0, mode: 'default',
      budget: {
        maxModelCalls: 10, maxToolCalls: 10, maxWallTimeMs: 10_000, maxTurns: 10,
      },
    })
    state.tasks = [{
      id: 'failed_task', planId: 'p', planVersion: 1, stepId: 'step_1',
      subject: 'broken implementation', description: '', activeForm: 'repairing',
      status: 'failed', dependsOn: [], acceptanceCriteria: [], evidenceIds: [],
      revision: 2, createdAt: 't', updatedAt: 't',
    }]
    const approvedPlan = {
      planId: 'p', version: 1, status: 'approved' as const, goal: 'finish safely',
      nonGoals: [], assumptions: [], decisions: [], steps: [],
      acceptanceCriteria: [], risks: [], createdAt: 't',
    }
    const result = evaluateCompletion({
      state, approvedPlan, evidence: [], riskThreshold: 5,
    })
    expect(result.action).toBe('continue')
    expect(result.missing).toContainEqual(expect.objectContaining({
      kind: 'failed_tasks', detail: expect.stringContaining('failed_task'),
    }))
  })

  test.each([false, true])(
    'an open replan cannot complete (awaiting approval: %s)',
    replanAwaitingApproval => {
      const state = createInitialState({
        sessionId: 's', runId: 'r', turnId: 't', workspaceRoot: 'workspace',
        now: 0, mode: 'default',
        budget: {
          maxModelCalls: 10, maxToolCalls: 10, maxWallTimeMs: 10_000, maxTurns: 10,
        },
      })
      state.recovery.replanning = true
      state.recovery.replanAwaitingApproval = replanAwaitingApproval
      const result = evaluateCompletion({
        state, evidence: [], riskThreshold: 5,
      })
      expect(result.action).toBe('continue')
      expect(result.missing).toContainEqual(expect.objectContaining({
        kind: 'replan_in_progress',
      }))
    },
  )

  test('a required manual criterion cannot silently complete without evidence', () => {
    expect(requiredCriteriaWithoutEvidence([MANUAL], [])).toEqual([MANUAL])
    const result = evaluateCompletion({
      state: createInitialState({
        sessionId: 's',
        runId: 'r',
        turnId: 't',
        workspaceRoot: 'workspace',
        now: 0,
        mode: 'default',
        budget: {
          maxModelCalls: 10,
          maxToolCalls: 10,
          maxWallTimeMs: 10_000,
          maxTurns: 10,
        },
      }),
      approvedPlan: {
        planId: 'p', version: 1, status: 'approved', goal: 'g', nonGoals: [],
        assumptions: [], decisions: [], steps: [], acceptanceCriteria: [MANUAL],
        risks: [], createdAt: 't',
      },
      evidence: [],
      riskThreshold: 5,
    })
    expect(result.action).toBe('continue')
    expect(result.missing).toContainEqual(expect.objectContaining({
      kind: 'manual_verification_required',
    }))
  })

  test('TaskStore rejects wrong-kind, stale and tampered receipts', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-criteria-'))
    try {
      const ids = createSequentialIds()
      const store = new EvidenceStore({
        sessionId: 's', runId: 'r', artifactDir: join(workspaceRoot, '.agent'),
        clock: fixedClock(), ids, persist: false, workspaceRoot,
      })
      const tasks = new TaskStore({ clock: fixedClock(), ids })
      const created = tasks.create({ subject: 'verify', acceptanceCriteria: [MANUAL.id] })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect(tasks.update({
        id: created.value.id,
        expectedRevision: 1,
        patch: { status: 'in_progress' },
      }).ok).toBe(true)

      const wrongKind = await store.record({
        kind: 'command', status: 'passed', criterionIds: [MANUAL.id],
        invocation: { tool: 'Shell', normalizedInput: { command: 'npm test' } },
        observation: { exitCode: 0, outputPreview: 'ok' }, startedAt: 't',
      })
      let result = tasks.update(
        { id: created.value.id, expectedRevision: 2, patch: { status: 'completed' } },
        { criteria: [MANUAL], evidence: [wrongKind], workspaceRoot },
      )
      expect(result).toMatchObject({ ok: false, code: 'MISSING_EVIDENCE' })

      const manual = await store.record({
        kind: 'manual', status: 'passed', criterionIds: [MANUAL.id],
        invocation: { tool: 'TrustedHumanChannel', normalizedInput: {} },
        observation: { outputPreview: 'confirmed' }, startedAt: 't',
      })
      store.bumpWorkspaceRevision('changed.ts')
      const stale = await findStaleReceipts(store)
      result = tasks.update(
        { id: created.value.id, expectedRevision: 2, patch: { status: 'completed' } },
        { criteria: [MANUAL], evidence: [manual], staleEvidenceIds: stale, workspaceRoot },
      )
      expect(result).toMatchObject({ ok: false, code: 'MISSING_EVIDENCE' })

      const tampered = sign({ ...manual, workspaceRevision: store.workspaceRevision })
      tampered.observation.outputPreview = 'changed after signing'
      result = tasks.update(
        { id: created.value.id, expectedRevision: 2, patch: { status: 'completed' } },
        { criteria: [MANUAL], evidence: [tampered], workspaceRoot },
      )
      expect(result).toMatchObject({ ok: false, code: 'MISSING_EVIDENCE' })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
