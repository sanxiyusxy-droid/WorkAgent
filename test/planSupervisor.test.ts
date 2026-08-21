import { describe, expect, test } from 'vitest'
import { mergeConfig } from '../src/app/config.js'
import type { ReflectionEvaluation } from '../src/core/events.js'
import { buildReflection } from '../src/core/LoopIntelligence.js'
import {
  createInitialState,
  createSnapshot,
  reduce,
  restoreFromSnapshot,
} from '../src/core/state.js'
import {
  assessPlanHealth,
  evaluateReflectionEffect,
  renderPlanSupervision,
} from '../src/planning/PlanSupervisor.js'
import { detectReplanTrigger } from '../src/planning/ReplanDetector.js'
import { buildToolExecutionLane } from '../src/planning/ToolExecutionLane.js'
import type { PlanTask, PlanVersion } from '../src/planning/types.js'

describe('v1.4 plan supervision and reflection feedback', () => {
  test('selects the dependency-ready task and produces a stable health signature', () => {
    const state = baseState()
    state.tasks = [
      task({ id: 'task_1', stepId: 'step_1', status: 'completed' }),
      task({ id: 'task_2', stepId: 'step_2', dependsOn: ['task_1'] }),
    ]
    const first = assessPlanHealth({
      state,
      approvedPlan: plan(),
      evidence: [],
      id: 'health_1',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const replayed = assessPlanHealth({
      state: {
        ...state,
        iteration: 1,
        budget: {
          ...state.budget,
          used: {
            ...state.budget.used,
            modelCalls: 1,
            toolCalls: 1,
          },
        },
      },
      approvedPlan: plan(),
      evidence: [],
      id: 'health_2',
      createdAt: '2026-01-02T00:00:00.000Z',
    })

    expect(first.status).toBe('healthy')
    expect(first.metrics.readyTasks).toBe(1)
    expect(first.decision).toMatchObject({
      action: 'continue_step',
      targetTaskId: 'task_2',
      targetStepId: 'step_2',
    })
    expect(replayed.signature).toBe(first.signature)
    expect(replayed.metrics.budgetRemainingRatio).not.toBe(
      first.metrics.budgetRemainingRatio,
    )
    expect(renderPlanSupervision(first)).toContain('Task task_2')
  })

  test('does not gather evidence before an approved plan has execution tasks', () => {
    const state = baseState()
    const approvedPlan: PlanVersion = {
      ...plan(),
      acceptanceCriteria: [
        { id: 'ac1', statement: 'tests pass', evidenceKind: 'test', required: true },
      ],
    }
    const assessment = assessPlanHealth({
      state,
      approvedPlan,
      evidence: [],
      id: 'health_before_execution',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    expect(assessment.metrics.totalTasks).toBe(0)
    expect(assessment.metrics.coveredCriteria).toBe(0)
    expect(assessment.decision.action).toBe('continue_step')
  })

  test('replay rejects a plan-health fact with an unknown action', () => {
    const valid = assessPlanHealth({
      state: baseState(),
      approvedPlan: plan(),
      evidence: [],
      id: 'health_corrupt',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const corrupted = {
      ...valid,
      decision: { ...valid.decision, action: 'future_action' },
    } as unknown as typeof valid
    expect(() => reduce(baseState(), {
      type: 'plan.health.assessed',
      assessment: corrupted,
    })).toThrow(/unknown supervisor action/i)
  })

  test('a single durable FAIL fact opens implementation tools after a crash cut', () => {
    let state = baseState()
    state.tasks = [task({ id: 'task_1', stepId: 'step_1', status: 'completed' })]
    state.workspace.touchedFiles = ['a.ts']
    state = reduce(state, {
      type: 'verification.completed',
      valid: true,
      repairAttempt: 1,
      report: {
        verdict: 'FAIL',
        summary: 'found a bug',
        checks: [],
        failures: [
          {
            title: 'edge case broken',
            severity: 'high',
            reproduction: ['run x'],
            evidenceIds: [],
          },
        ],
        unverified: [],
      },
    })
    state = restoreFromSnapshot(baseState(), createSnapshot(state, 1))
    const assessment = assessPlanHealth({
      state,
      approvedPlan: plan(),
      evidence: [],
      id: 'health_verifier_repair',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    expect(assessment.decision.action).toBe('continue_step')
    expect(assessment.decision.rationale).toContain('repair attempt')
    expect(assessment.decision.rationale).toContain('[high] edge case broken')
    expect(assessment.decision.rationale).toContain('repro: run x')
    expect(state.recovery.verifierRepairs).toBe(1)
    expect(state.lastVerification).toBeUndefined()
    expect(state.pendingVerificationRepair).toMatchObject({
      attempt: 1,
      report: { verdict: 'FAIL' },
    })
  })

  test('turns scope drift and approval locks into explicit recovery actions', () => {
    const state = baseState()
    state.tasks = [task({ id: 'task_1', stepId: 'step_1' })]
    state.workspace.touchedFiles = ['outside.ts']
    state.workspace.planScopedTouchedFiles = ['outside.ts']
    const drift = assessPlanHealth({
      state,
      approvedPlan: plan(),
      evidence: [],
      id: 'health_drift',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(drift.metrics.scopeDriftFiles).toBe(1)
    expect(drift.decision.action).toBe('repair_plan')

    state.recovery.replanning = true
    state.recovery.replanAwaitingApproval = true
    const locked = assessPlanHealth({
      state,
      evidence: [],
      id: 'health_locked',
      createdAt: '2026-01-01T00:00:01.000Z',
    })
    expect(locked.status).toBe('blocked')
    expect(locked.decision.action).toBe('request_reapproval')
  })

  test('a legacy approved plan with an invalid file path fails closed into repair', () => {
    const state = baseState()
    const invalidPlan = plan()
    invalidPlan.steps[0] = { ...invalidPlan.steps[0]!, files: ['../outside.ts'] }
    const assessment = assessPlanHealth({
      state,
      approvedPlan: invalidPlan,
      evidence: [],
      id: 'health_invalid_scope',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(assessment.decision.action).toBe('repair_plan')
    expect(assessment.findings.join(' ')).toContain('scope')
  })

  test('a durable low-impact replan always selects the active repair lane', () => {
    const state = baseState()
    state.tasks = [task({ id: 'task_1', stepId: 'step_1' })]
    state.recovery.replanning = true
    state.recovery.replanAwaitingApproval = false
    const assessment = assessPlanHealth({
      state,
      approvedPlan: plan(),
      evidence: [],
      id: 'health_low_replan',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(assessment.decision.action).toBe('repair_plan')
    const projected = buildToolExecutionLane({
      assessment,
      mode: 'bypassPermissions',
      writeLocked: false,
      replanning: true,
      candidateTools: ['Read', 'PlanRepair', 'PlanPropose', 'TaskUpdate', 'Write'],
    })
    expect(projected?.allowedTools).toEqual(['PlanPropose', 'PlanRepair', 'Read'])
  })

  test('plan approval resets scoped changes while canonical path aliases stay in scope', () => {
    let state = baseState()
    state.workspace.touchedFiles = ['legacy.ts']
    state.workspace.planScopedTouchedFiles = ['legacy.ts']
    state.activePlan = { planId: 'plan_1', version: 1, approved: false }
    state.lastVerification = {
      valid: true,
      report: {
        verdict: 'PASS', summary: 'old plan', checks: [], failures: [],
        unverified: [],
      },
    }
    state.recovery.verifierRepairs = 1
    state = reduce(state, {
      type: 'plan.approved', planId: 'plan_1', version: 1, tokenId: 'approval_1',
    })
    expect(state.workspace.touchedFiles).toEqual(['legacy.ts'])
    expect(state.workspace.planScopedTouchedFiles).toEqual([])
    expect(state.lastVerification).toBeUndefined()
    expect(state.recovery.verifierRepairs).toBe(0)

    state = reduce(state, {
      type: 'workspace.changed',
      path: './src/../a.ts',
      change: 'modified',
    })
    const assessment = assessPlanHealth({
      state,
      approvedPlan: plan(),
      evidence: [],
      id: 'health_alias',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(state.workspace.planScopedTouchedFiles).toEqual(['a.ts'])
    expect(assessment.metrics.scopeDriftFiles).toBe(0)
    expect(() => reduce(state, {
      type: 'workspace.changed', path: '../escape.ts', change: 'modified',
    })).toThrow(/not inside the workspace/i)
  })

  test('a durable human follow-up opens one lane without bypassing approval locks', () => {
    const state = baseState()
    state.tasks = [task({ id: 'task_1', stepId: 'step_1', status: 'completed' })]
    state.lastTransition = { reason: 'user_followup' }
    const followup = assessPlanHealth({
      state,
      approvedPlan: plan(),
      evidence: [],
      id: 'health_followup',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(followup.decision.action).toBe('continue_step')

    state.tasks = [task({ id: 'task_1', stepId: 'step_1', status: 'failed' })]
    const failed = assessPlanHealth({
      state,
      approvedPlan: plan(),
      evidence: [],
      id: 'health_followup_failed',
      createdAt: '2026-01-01T00:00:00.500Z',
    })
    expect(failed.decision.action).toBe('repair_plan')

    state.recovery.replanning = true
    state.recovery.replanAwaitingApproval = true
    const locked = assessPlanHealth({
      state,
      approvedPlan: plan(),
      evidence: [],
      id: 'health_followup_locked',
      createdAt: '2026-01-01T00:00:01.000Z',
    })
    expect(locked.decision.action).toBe('request_reapproval')
  })

  test('approving a replacement plan clears stale reflection failures', () => {
    const state = baseState()
    state.recovery.replanning = true
    state.recovery.replanAwaitingApproval = true
    state.recovery.ineffectiveReflectionCount = 1
    const proposed = reduce(state, {
      type: 'plan.version.created',
      plan: { ...plan(), version: 2, status: 'awaiting_approval' },
    })

    const approved = reduce(proposed, {
      type: 'plan.approved',
      planId: 'plan_1',
      version: 2,
      tokenId: 'approval_1',
    })

    expect(approved.recovery).toMatchObject({
      replanning: false,
      replanAwaitingApproval: false,
      ineffectiveReflectionCount: 0,
      lastProgressToolCalls: 1,
    })
  })

  test('evaluates a reflection from durable progress rather than assistant prose', () => {
    const state = baseState()
    state.tasks = [task({ id: 'task_1', stepId: 'step_1' })]
    const assessment = assessPlanHealth({
      state,
      approvedPlan: plan(),
      evidence: [],
      id: 'health_1',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const reflection = buildReflection({
      state,
      id: 'reflection_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      trigger: 'periodic',
      assessment,
      evaluationWindow: 3,
    })

    const progressed = {
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'completed' as const }],
      toolResults: {
        call_1: {
          callId: 'call_1',
          toolName: 'Edit',
          ok: true,
          content: { kind: 'text' as const, text: 'ok' },
          durationMs: 1,
        },
      },
      budget: {
        ...state.budget,
        used: { ...state.budget.used, toolCalls: 1 },
      },
      recovery: { ...state.recovery, lastProgressToolCalls: 1 },
    }
    const evaluation = evaluateReflectionEffect({
      state: progressed,
      reflection,
      id: 'evaluation_1',
      createdAt: '2026-01-01T00:00:01.000Z',
      evaluationWindow: 3,
    })
    expect(evaluation).toMatchObject({
      outcome: 'effective',
      toolCallsObserved: 1,
    })
    expect(evaluation?.progressSignals.join(' ')).toContain('task')

    const stalled = {
      ...state,
      budget: {
        ...state.budget,
        used: { ...state.budget.used, toolCalls: 3 },
      },
    }
    expect(
      evaluateReflectionEffect({
        state: stalled,
        reflection,
        id: 'evaluation_2',
        createdAt: '2026-01-01T00:00:02.000Z',
        evaluationWindow: 3,
      }),
    ).toMatchObject({
      outcome: 'ineffective',
      followUp: { action: 'repair_plan' },
    })
  })

  test('persists tasks, plan health and reflection outcomes through V4 snapshots', () => {
    let state = baseState()
    state.tasks = [task({ id: 'task_1', stepId: 'step_1' })]
    const assessment = assessPlanHealth({
      state,
      approvedPlan: plan(),
      evidence: [],
      id: 'health_1',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const reflection = buildReflection({
      state,
      id: 'reflection_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      trigger: 'periodic',
      assessment,
    })
    const evaluation: ReflectionEvaluation = {
      id: 'evaluation_1',
      reflectionId: reflection.id,
      createdAt: '2026-01-01T00:00:03.000Z',
      outcome: 'ineffective',
      toolCallsObserved: 3,
      progressSignals: [],
      followUp: {
        action: 'repair_plan',
        rationale: 'no progress',
        targetTaskId: 'task_1',
        targetStepId: 'step_1',
        successSignals: ['new evidence'],
      },
    }
    state = reduce(state, { type: 'plan.health.assessed', assessment })
    state = reduce(state, { type: 'reflection.recorded', reflection })
    state = {
      ...state,
      budget: {
        ...state.budget,
        used: { ...state.budget.used, toolCalls: 3 },
      },
    }
    state = reduce(state, { type: 'reflection.evaluated', evaluation })

    const restored = restoreFromSnapshot(baseState(), createSnapshot(state, 12))
    expect(restored.tasks).toEqual(state.tasks)
    expect(restored.latestPlanHealth).toEqual(assessment)
    expect(restored.reflectionEvaluations).toEqual([evaluation])
    expect(restored.recovery.ineffectiveReflectionCount).toBe(1)
  })

  test('escalates repeated ineffective reflections into bounded local replanning', () => {
    const state = baseState()
    const decision = detectReplanTrigger({
      state,
      approvedPlan: plan(),
      consecutiveFailures: 0,
      versionConflicts: 0,
      ineffectiveReflections: 2,
    })
    expect(decision).toMatchObject({
      required: true,
      requiresReapproval: false,
      cause: { type: 'reflection_ineffective', count: 2 },
    })
  })

  test('merges the reflection evaluation window through normal config precedence', () => {
    const effective = mergeConfig({
      user: { intelligence: { reflectionEvaluationWindow: 5 } },
      project: { intelligence: { reflectionEvaluationWindow: 4 } },
    })
    expect(effective.intelligence.reflectionEvaluationWindow).toBe(4)
    expect(mergeConfig({}).intelligence.reflectionEvaluationWindow).toBe(3)
    expect(mergeConfig({}).intelligence.outcomeCalibrationEnabled).toBe(true)
    expect(mergeConfig({}).intelligence.outcomeCalibrationMinSamples).toBe(3)
    expect(mergeConfig({}).intelligence.outcomeCalibrationMaxSessions).toBe(50)
    expect(
      mergeConfig({
        project: {
          intelligence: {
            outcomeCalibrationMinSamples: 0,
            outcomeCalibrationMaxSessions: 5_000,
          },
        },
      }).intelligence,
    ).toMatchObject({
      outcomeCalibrationMinSamples: 1,
      outcomeCalibrationMaxSessions: 500,
    })
  })
})

function baseState() {
  return createInitialState({
    sessionId: 'session',
    runId: 'run',
    turnId: 'turn',
    workspaceRoot: '/workspace',
    budget: {
      maxTurns: 40,
      maxModelCalls: 60,
      maxToolCalls: 200,
      maxWallTimeMs: 60_000,
    },
    now: 0,
  })
}

function plan(): PlanVersion {
  return {
    planId: 'plan_1',
    version: 1,
    status: 'approved',
    goal: 'implement feature',
    nonGoals: [],
    assumptions: [],
    decisions: [],
    steps: [
      {
        id: 'step_1',
        title: 'first',
        description: 'first step',
        files: ['a.ts'],
        dependsOn: [],
        expectedOutcome: 'first complete',
      },
      {
        id: 'step_2',
        title: 'second',
        description: 'second step',
        files: ['b.ts'],
        dependsOn: ['step_1'],
        expectedOutcome: 'second complete',
      },
    ],
    acceptanceCriteria: [],
    risks: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedAt: '2026-01-01T00:00:00.000Z',
  }
}

function task(input: {
  id: string
  stepId: string
  status?: PlanTask['status']
  dependsOn?: string[]
}): PlanTask {
  return {
    id: input.id,
    planId: 'plan_1',
    planVersion: 1,
    stepId: input.stepId,
    subject: input.id,
    description: input.id,
    activeForm: `working on ${input.id}`,
    status: input.status ?? 'pending',
    dependsOn: input.dependsOn ?? [],
    acceptanceCriteria: [],
    evidenceIds: [],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
