import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { evaluateCompletion, requiredCriteriaWithoutEvidence } from '../src/planning/completionGate.js'
import { TaskStore } from '../src/planning/TaskStore.js'
import type { AcceptanceCriterion } from '../src/planning/types.js'
import { createInitialState, reduce } from '../src/core/state.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { EvidenceStore, receiptHashBody } from '../src/verification/EvidenceStore.js'
import { findStaleReceipts } from '../src/verification/freshness.js'
import type { EvidenceReceipt } from '../src/verification/types.js'
import { fixedClock } from './helpers.js'
import type { AgentState } from '../src/core/state.js'

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

function stateWithWriteFrom(
  turnId: string,
  toolName: 'Write' | 'Edit' | 'ApplyPatch' = 'Write',
): AgentState {
  let state = createInitialState({
    sessionId: 's', runId: 'r', turnId, workspaceRoot: 'workspace',
    now: 0,
    budget: {
      maxModelCalls: 10, maxToolCalls: 10, maxWallTimeMs: 10_000, maxTurns: 10,
    },
  })
  state = reduce(state, {
    type: 'workspace.mutation.started',
    mutationId: 'mutation_1',
    callId: 'write_1',
    toolName,
    scope: 'paths',
    paths: ['out.txt'],
    reason: 'test mutation',
  })
  state = reduce(state, {
    type: 'workspace.changed',
    path: 'out.txt',
    change: 'modified',
    mutationId: 'mutation_1',
    callId: 'write_1',
    toolName,
  })
  state.toolResults.write_1 = {
    callId: 'write_1', toolName, ok: true,
    content: { kind: 'text', text: 'written' }, durationMs: 1,
    observation: {
      summary: 'wrote out.txt', preconditions: [], postconditions: [],
      fields: { path: 'out.txt' },
    },
  }
  return state
}

function passedEvidence(overrides: Partial<EvidenceReceipt> = {}): EvidenceReceipt {
  return sign({
    id: 'ev_current', sessionId: 's', runId: 'r', criterionIds: [],
    kind: 'test', status: 'passed',
    invocation: {
      tool: 'Shell', normalizedInput: { command: 'npm test' }, cwd: 'workspace',
    },
    observation: { exitCode: 0, outputPreview: 'passed' },
    startedAt: 't', completedAt: 't', sha256: '',
    workspaceRoot: 'workspace', workspaceRevision: 1,
    fileVersions: { [resolve('workspace', 'out.txt')]: 'sha256:current' },
    ...overrides,
  })
}

function commandEvidence(command: string): EvidenceReceipt {
  return passedEvidence({
    invocation: {
      tool: 'Shell', normalizedInput: { command }, cwd: 'workspace',
    },
  })
}

describe('shared criterion evidence policy', () => {
  test.each(['Write', 'Edit', 'ApplyPatch'] as const)(
    'an unplanned %s cannot complete without fresh post-write evidence',
    toolName => {
      const state = stateWithWriteFrom('turn_current', toolName)
      const result = evaluateCompletion({
        state, evidence: [], riskThreshold: 5,
        workspaceRoot: 'workspace', workspaceRevision: 1,
      })
      expect(result.action).toBe('continue')
      expect(result.missing).toContainEqual(expect.objectContaining({
        kind: 'unverified_workspace_changes',
        detail: expect.stringContaining(`${toolName}:write_1`),
      }))
    },
  )

  test('fresh passed evidence from the current run closes the implicit write contract', () => {
    const state = stateWithWriteFrom('turn_current')
    const result = evaluateCompletion({
      state, evidence: [passedEvidence()], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 1,
    })
    expect(result.action).toBe('complete')
    expect(result.missing).toEqual([])
  })

  test.each([
    ['older workspace revision', passedEvidence({ workspaceRevision: 0 })],
    ['different run', passedEvidence({ runId: 'old_run' })],
    ['failed receipt', passedEvidence({ status: 'failed' })],
  ])('unplanned write rejects %s evidence', (_label, receipt) => {
    const state = stateWithWriteFrom('turn_current')
    const result = evaluateCompletion({
      state, evidence: [receipt], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 1,
    })
    expect(result.missing).toContainEqual(expect.objectContaining({
      kind: 'unverified_workspace_changes',
    }))
  })

  test.each([
    'npm test || true',
    'npm test; node -v',
    'npm test & node -v',
    'npm test | echo ok',
    'npm test > result.txt',
    'npm test\nnode -v',
    'npm test $(node -v)',
    'npm test `node -v`',
    'npm test -- --if-present',
    'npx jest --passWithNoTests',
    'npx jest --passWithNoTests=true',
  ])('compound or empty-success command is not completion evidence: %s', command => {
    const state = stateWithWriteFrom('turn_current')
    const result = evaluateCompletion({
      state, evidence: [commandEvidence(command)], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 1,
    })
    expect(result.action).toBe('continue')
  })

  test('grep evidence must name the full changed path, not a matching basename', () => {
    let state = createInitialState({
      sessionId: 's', runId: 'r', turnId: 't', workspaceRoot: 'workspace', now: 0,
      budget: {
        maxModelCalls: 10, maxToolCalls: 10, maxWallTimeMs: 10_000, maxTurns: 10,
      },
    })
    state = reduce(state, {
      type: 'workspace.mutation.started', mutationId: 'nested', callId: 'write',
      toolName: 'Write', scope: 'paths', paths: ['src/a.ts'], reason: 'test',
    })
    const receipt = sign({
      ...commandEvidence('rg expected other/a.ts'),
      fileVersions: { [resolve('workspace', 'src/a.ts')]: 'sha256:current' },
    })
    expect(evaluateCompletion({
      state, evidence: [receipt], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 1,
    }).action).toBe('continue')
  })

  test('grep path token cannot be spoofed by a .bak suffix', () => {
    let state = createInitialState({
      sessionId: 's', runId: 'r', turnId: 't', workspaceRoot: 'workspace', now: 0,
      budget: {
        maxModelCalls: 10, maxToolCalls: 10, maxWallTimeMs: 10_000, maxTurns: 10,
      },
    })
    state = reduce(state, {
      type: 'workspace.mutation.started', mutationId: 'nested', callId: 'write',
      toolName: 'Write', scope: 'paths', paths: ['src/a.ts'], reason: 'test',
    })
    const receipt = sign({
      ...commandEvidence('rg expected src/a.ts.bak'),
      fileVersions: { [resolve('workspace', 'src/a.ts')]: 'sha256:current' },
    })
    expect(evaluateCompletion({
      state, evidence: [receipt], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 1,
    }).action).toBe('continue')
  })

  test('multiple current receipts may jointly cover a multi-file mutation', () => {
    let state = createInitialState({
      sessionId: 's', runId: 'r', turnId: 't', workspaceRoot: 'workspace', now: 0,
      budget: {
        maxModelCalls: 10, maxToolCalls: 10, maxWallTimeMs: 10_000, maxTurns: 10,
      },
    })
    state = reduce(state, {
      type: 'workspace.mutation.started', mutationId: 'patch', callId: 'patch_1',
      toolName: 'ApplyPatch', scope: 'paths', paths: ['src/a.ts', 'src/b.ts'],
      reason: 'test patch',
    })
    const first = sign({
      ...commandEvidence('npm test'), id: 'ev_a',
      fileVersions: { [resolve('workspace', 'src/a.ts')]: 'sha256:a' },
    })
    const second = sign({
      ...commandEvidence('npm test'), id: 'ev_b',
      fileVersions: { [resolve('workspace', 'src/b.ts')]: 'sha256:b' },
    })
    expect(evaluateCompletion({
      state, evidence: [first, second], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 1,
    }).action).toBe('complete')
  })

  test('grep command and evidenceFiles cannot cross-cover different paths', () => {
    let state = createInitialState({
      sessionId: 's', runId: 'r', turnId: 't', workspaceRoot: 'workspace', now: 0,
      budget: {
        maxModelCalls: 10, maxToolCalls: 10, maxWallTimeMs: 10_000, maxTurns: 10,
      },
    })
    state = reduce(state, {
      type: 'workspace.mutation.started', mutationId: 'patch', callId: 'patch_1',
      toolName: 'ApplyPatch', scope: 'paths', paths: ['src/a.ts', 'src/b.ts'],
      reason: 'test patch',
    })
    const coversA = sign({
      ...commandEvidence('rg expected src/a.ts'), id: 'ev_a',
      fileVersions: { [resolve('workspace', 'src/a.ts')]: 'sha256:a' },
    })
    const mismatchedB = sign({
      ...commandEvidence('rg expected src/a.ts'), id: 'ev_b',
      fileVersions: { [resolve('workspace', 'src/b.ts')]: 'sha256:b' },
    })
    expect(evaluateCompletion({
      state, evidence: [coversA, mismatchedB], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 1,
    }).action).toBe('continue')
  })

  test('evidence-store and reducer workspace revisions must agree', () => {
    const state = stateWithWriteFrom('turn_current')
    const receipt = passedEvidence({ workspaceRevision: 2 })
    expect(evaluateCompletion({
      state, evidence: [receipt], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 2,
    }).action).toBe('continue')
  })

  test('workspace-wide validation must also bind every known changed path', () => {
    let state = stateWithWriteFrom('turn_current')
    state = reduce(state, {
      type: 'workspace.mutation.started', mutationId: 'shell', callId: 'test_1',
      toolName: 'Shell', scope: 'workspace', paths: [], reason: 'test runner',
    })
    const unboundGlobal = passedEvidence({
      workspaceRevision: 2,
      fileVersions: undefined,
    })
    expect(evaluateCompletion({
      state, evidence: [unboundGlobal], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 2,
    }).action).toBe('continue')

    const boundGlobal = sign({
      ...unboundGlobal,
      fileVersions: { [resolve('workspace', 'out.txt')]: 'sha256:current' },
    })
    expect(evaluateCompletion({
      state, evidence: [boundGlobal], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 2,
    }).action).toBe('complete')
  })

  test('an interrupted previous-turn write remains blocked across a recovery turn', () => {
    const state = stateWithWriteFrom('turn_previous')
    state.turnId = 'turn_current'
    const result = evaluateCompletion({
      state, evidence: [], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 1,
    })
    expect(result.action).toBe('continue')
    expect(result.missing).toContainEqual(expect.objectContaining({
      kind: 'unverified_workspace_changes',
    }))
  })

  test('a clean terminal closes the obligation before a new read-only task', () => {
    let state = stateWithWriteFrom('turn_previous')
    state = reduce(state, {
      type: 'run.terminated',
      terminal: { reason: 'completed_with_unverified_items', items: ['not verified'] },
    })
    state.turnId = 'turn_current'
    const result = evaluateCompletion({
      state, evidence: [], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 1,
    })
    expect(result.action).toBe('complete')
    expect(state.workspace.pendingVerification).toBeUndefined()
  })

  test('context compaction cannot erase a pending mutation obligation', () => {
    let state = stateWithWriteFrom('turn_current')
    state.messages = [{
      id: 'write_message', parentId: null, sessionId: 's', turnId: 'turn_current',
      role: 'assistant', createdAt: 't',
      content: [{ type: 'tool_call', id: 'write_1', name: 'Write', input: {} }],
    }]
    state = reduce(state, {
      type: 'context.compacted',
      record: {
        kind: 'auto', clearedMessageIds: ['write_message'], replacements: [],
        tokensBefore: 100, tokensAfter: 10,
      },
    })
    expect(state.messages).toEqual([])
    expect(evaluateCompletion({
      state, evidence: [], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 1,
    }).action).toBe('continue')
  })

  test('a current-turn read result does not create an implicit write contract', () => {
    const state = createInitialState({
      sessionId: 's', runId: 'r', turnId: 'turn_current',
      workspaceRoot: 'workspace', now: 0,
      budget: {
        maxModelCalls: 10, maxToolCalls: 10, maxWallTimeMs: 10_000,
        maxTurns: 10,
      },
    })
    state.toolResults = {
      read_1: {
        callId: 'read_1', toolName: 'Read', ok: true,
        content: { kind: 'text', text: 'done' }, durationMs: 1,
      },
    }
    const result = evaluateCompletion({
      state, evidence: [], riskThreshold: 5,
      workspaceRoot: 'workspace', workspaceRevision: 1,
    })
    expect(result.action).toBe('complete')
  })

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
