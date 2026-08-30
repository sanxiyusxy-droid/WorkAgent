import { createInitialState, createSnapshot, reduce, restoreFromSnapshot } from '../src/core/state.js'
import { describe, expect, test } from 'vitest'
import {
  buildReflection,
  deriveExecutionStrategy,
  detectStagnation,
} from '../src/core/LoopIntelligence.js'
import type { FactEvent } from '../src/core/events.js'
import { collectRun, makeWorld, stateWithUser } from './helpers.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'

describe('v1.1 loop intelligence', () => {
  test('detects repetition, adapts budget and survives snapshot recovery', () => {
    let state = createInitialState({
      sessionId: 'ses',
      runId: 'run',
      turnId: 'turn',
      workspaceRoot: '/workspace',
      budget: {
        maxTurns: 100,
        maxModelCalls: 100,
        maxToolCalls: 100,
        maxWallTimeMs: 10_000,
      },
      now: 0,
    })
    for (let i = 0; i < 3; i++) {
      state = reduce(state, {
        type: 'tool.call.accepted',
        call: {
          id: `c${i}`,
          name: 'Read',
          input: { path: 'a.ts' },
          parentMessageId: 'm',
          receivedIndex: 0,
        },
      })
      state = reduce(state, {
        type: 'tool.call.completed',
        result: {
          callId: `c${i}`,
          toolName: 'Read',
          ok: true,
          content: { kind: 'text', text: 'ok' },
          durationMs: 1,
        },
      })
    }
    const stagnation = detectStagnation(state)
    expect(stagnation).toMatchObject({ kind: 'repeated_call', score: 1 })
    state = reduce(state, { type: 'loop.stagnation.detected', record: stagnation! })

    state = {
      ...state,
      iteration: 90,
      budget: {
        ...state.budget,
        used: { ...state.budget.used, modelCalls: 90, toolCalls: 90 },
      },
    }
    expect(deriveExecutionStrategy(state)).toMatchObject({ strategy: 'critical' })

    const reflection = buildReflection({
      state,
      id: 'reflection_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      trigger: 'stagnation',
    })
    state = reduce(state, { type: 'reflection.recorded', reflection })
    const snapshot = createSnapshot(state)
    const fresh = createInitialState({
      sessionId: 'ses',
      runId: 'run2',
      turnId: 'turn2',
      workspaceRoot: '/workspace',
      budget: {
        maxTurns: 100,
        maxModelCalls: 100,
        maxToolCalls: 100,
        maxWallTimeMs: 10_000,
      },
      now: 10,
    })
    const restored = restoreFromSnapshot(fresh, snapshot)
    expect(restored.recovery.stagnationCount).toBe(1)
    expect(restored.recovery.recentToolFingerprints).toHaveLength(3)
    expect(restored.reflections).toEqual([reflection])
  })

  test('low-impact replan creates a new approved version by replacing one step', async () => {
    const world = await makeWorld({
      files: { 'a.ts': 'const value = 1\n' },
      mode: 'acceptEdits',
      replan: { failureThreshold: 99, conflictThreshold: 3 },
      turns: [
        toolCallTurn([{ id: 'e1', name: 'Edit', input: {
          path: 'a.ts', oldText: 'const value = 1', newText: 'const value = 2',
          expectedVersion: 'stale-1',
        } }]),
        toolCallTurn([{ id: 'e2', name: 'Edit', input: {
          path: 'a.ts', oldText: 'const value = 1', newText: 'const value = 2',
          expectedVersion: 'stale-2',
        } }]),
        toolCallTurn([{ id: 'e3', name: 'Edit', input: {
          path: 'a.ts', oldText: 'const value = 1', newText: 'const value = 2',
          expectedVersion: 'stale-3',
        } }]),
        toolCallTurn([{ id: 'repair', name: 'PlanRepair', input: {
          planId: 'plan_local',
          version: 1,
          stepId: 'edit-step',
          reason: 'file versions are changing',
          replacement: {
            description: 'Re-read a.ts immediately before editing and use its current version.',
            files: ['a.ts'],
            expectedOutcome: 'The edit uses a fresh optimistic-concurrency token.',
          },
        } }]),
        toolCallTurn([
          { id: 'restart-task', name: 'TaskUpdate', input: {
            id: 'task_repaired', expectedRevision: 2, status: 'in_progress',
          } },
          { id: 'complete-task', name: 'TaskUpdate', input: {
            id: 'task_repaired', expectedRevision: 3, status: 'completed',
          } },
        ]),
        toolCallTurn([{
          id: 'verify-attempted-path', name: 'ShellReadOnly',
          input: {
            command: 'rg value a.ts',
            evidenceFiles: ['a.ts'],
          },
        }]),
        textTurn('done'),
      ],
    })
    try {
      const plan = await world.runtime.plans.createVersion({
        planId: 'plan_local',
        goal: 'update the value',
        steps: [{
          id: 'edit-step',
          title: 'Edit value',
          description: 'Edit a.ts.',
          files: ['a.ts'],
          dependsOn: [],
          expectedOutcome: 'value is updated',
        }, {
          id: 'verify-step',
          title: 'Verify value',
          description: 'Inspect b.ts without changing it.',
          files: ['b.ts'],
          dependsOn: ['edit-step'],
          expectedOutcome: 'verification is recorded',
        }],
      })
      world.runtime.plans.markAwaitingApproval(plan.planId, plan.version)
      world.runtime.plans.markApproved(plan.planId, plan.version, 'token')
      world.runtime.tasks.restore({
        id: 'task_repaired',
        planId: plan.planId,
        planVersion: plan.version,
        stepId: 'edit-step',
        subject: 'edit value',
        description: 'edit a.ts',
        activeForm: 'editing value',
        status: 'failed',
        dependsOn: [],
        acceptanceCriteria: [],
        evidenceIds: ['old-evidence'],
        revision: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
      let initial = await stateWithUser(world, 'update the value')
      initial = {
        ...initial,
        activePlan: { planId: plan.planId, version: plan.version, approved: true },
      }

      const run = await collectRun(world.runtime.engine, initial)
      expect(run.terminal).toEqual({ reason: 'completed' })
      expect(run.facts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'replan.requested',
          cause: 'version_conflict_threshold',
          requiresReapproval: false,
        }),
        expect.objectContaining({
          type: 'replan.adjustment.applied',
          cause: 'local_step_repair',
        }),
      ]))
      const repaired = world.runtime.plans.get('plan_local', 2)
      expect(world.runtime.plans.get('plan_local', 1)?.status).toBe('superseded')
      expect(repaired).toMatchObject({
        status: 'approved',
        localRepair: {
          fromVersion: 1,
          stepId: 'edit-step',
          authorization: 'bounded_local_repair',
        },
      })
      expect(repaired?.steps[0]?.description).toContain('Re-read a.ts')
      expect(repaired?.steps[1]).toEqual(plan.steps[1])
      expect(run.facts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'task.changed',
          task: expect.objectContaining({
            id: 'task_repaired',
            planVersion: 2,
            status: 'pending',
            evidenceIds: [],
          }),
        }),
      ]))
      expect(world.runtime.tasks.get('task_repaired')).toMatchObject({
        planVersion: 2,
        stepId: 'edit-step',
        status: 'completed',
        evidenceIds: [],
      })
      await expect(world.runtime.plans.createLocalRepair({
        planId: 'plan_local',
        version: 2,
        stepId: 'edit-step',
        reason: 'expand',
        replacement: { description: 'expand scope', files: ['outside.ts'] },
      })).rejects.toThrow(/cannot add files outside approved scope/)

      const finalState = run.facts.reduce(
        (state, fact) => reduce(state, fact as FactEvent),
        initial,
      )
      expect(finalState.recovery.replanning).toBe(false)
      expect(finalState.activePlan).toEqual({
        planId: 'plan_local',
        version: 2,
        approved: true,
      })
    } finally {
      await world.cleanup()
    }
  })
})
