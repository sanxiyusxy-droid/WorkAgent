import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildOutcomeCalibrationProfile,
  calibrateReflectionDecision,
  emptyOutcomeCalibrationProfile,
  isOutcomeCalibrationProfile,
  loadOutcomeCalibrationScan,
  loadOutcomeCalibrationProfile,
  matchOutcomeCalibration,
} from '../src/planning/OutcomeCalibration.js'
import {
  buildOutcomeCalibrationSelection,
  isOutcomeCalibrationSelection,
} from '../src/planning/OutcomeCalibrationContract.js'
import { SessionJournal } from '../src/session/SessionJournal.js'
import { loadSession } from '../src/session/SessionLoader.js'
import { diagnoseSession } from '../src/session/recoveryCheck.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { collectRun, fixedClock } from './helpers.js'
import type { FactEvent, ReflectionEvaluation, ReflectionRecord } from '../src/core/events.js'
import { createRuntime, resumeState } from '../src/app/createRuntime.js'
import { ScriptedModel, textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { createInitialState, createSnapshot, reduce, restoreFromSnapshot } from '../src/core/state.js'

function sample(input: {
  sessionId: string
  reflectionId: string
  outcome: ReflectionEvaluation['outcome']
  toolCallsObserved: number
  trigger?: ReflectionRecord['trigger']
  action?: NonNullable<ReflectionRecord['decision']>['action']
}) {
  return {
    sessionId: input.sessionId,
    reflectionId: input.reflectionId,
    outcome: input.outcome,
    toolCallsObserved: input.toolCallsObserved,
    trigger: input.trigger ?? 'stagnation',
    action: input.action ?? 'repair_plan',
  }
}

function reflection(
  id: string,
  baselineToolCalls = 0,
  evaluationWindow = 3,
  successfulToolCalls = 0,
  touchedFiles = 0,
): ReflectionRecord {
  return {
    id,
    trigger: 'stagnation',
    createdAt: '2026-01-01T00:00:00.000Z',
    summary: 'stalled',
    assumptions: [],
    progress: {
      completedTasks: 0,
      totalTasks: 0,
      touchedFiles,
      toolCalls: baselineToolCalls,
      evidenceReceipts: 0,
      successfulToolCalls,
    },
    evidenceGaps: [],
    recommendation: 'repair',
    decision: {
      action: 'repair_plan',
      rationale: 'repair the smallest affected step',
      successSignals: ['progress'],
      evaluateAfterToolCalls: evaluationWindow,
    },
  }
}

function evaluation(
  reflectionId: string,
  outcome: ReflectionEvaluation['outcome'],
  toolCallsObserved: number,
): ReflectionEvaluation {
  return {
    id: `eval_${reflectionId}`,
    reflectionId,
    createdAt: '2026-01-01T00:00:00.000Z',
    outcome,
    toolCallsObserved,
    progressSignals: outcome === 'effective' ? ['progress'] : [],
    followUp: {
      action: 'repair_plan',
      rationale: 'follow up',
      successSignals: ['progress'],
    },
  }
}

async function seedSession(input: {
  workspaceRoot: string
  sessionId: string
  outcomes: Array<{ outcome: ReflectionEvaluation['outcome']; window: number }>
  terminated?: boolean
  degraded?: boolean
  invalidReducer?: boolean
  unpaired?: boolean
  clockStart?: number
}): Promise<string> {
  const journalPath = join(
    input.workspaceRoot,
    '.agent',
    'sessions',
    input.sessionId,
    'journal.jsonl',
  )
  await mkdir(join(journalPath, '..'), { recursive: true })
  const journal = new SessionJournal({
    filePath: journalPath,
    sessionId: input.sessionId,
    runId: `run_${input.sessionId}`,
    clock: fixedClock(input.clockStart),
    ids: createSequentialIds(),
  })
  await journal.append(
    { type: 'run.started', runId: `run_${input.sessionId}`, configHash: 'test' },
    'boot',
    'flush',
  )
  if (input.degraded) {
    await journal.append(
      {
        type: 'session.recovery.branch',
        fromSessionId: 'source',
        failureSeq: 1,
        issues: ['test'],
      },
      'turn',
      'flush',
    )
  }
  let toolCalls = 0
  let successfulToolCalls = 0
  let touchedFiles = 0
  for (const [index, item] of input.outcomes.entries()) {
    const id = `reflection_${index + 1}`
    await journal.append(
      {
        type: 'reflection.recorded',
        reflection: reflection(
          id,
          toolCalls,
          item.window,
          successfulToolCalls,
          touchedFiles,
        ),
      },
      'turn',
      'flush',
    )
    for (let observed = 0; observed < item.window; observed++) {
      const callId = `call_${index + 1}_${observed + 1}`
      await journal.append(
        {
          type: 'tool.call.accepted',
          call: {
            id: callId,
            name: 'Read',
            input: { path: 'progress.txt' },
            parentMessageId: 'msg_seed',
            receivedIndex: observed,
          },
        },
        'turn',
        'flush',
      )
      if (item.outcome === 'effective' && observed === 0) {
        await journal.append(
          {
            type: 'workspace.changed',
            path: `progress-${index + 1}.txt`,
            change: 'modified',
          },
          'turn',
          'flush',
        )
        touchedFiles += 1
      }
      await journal.append(
        {
          type: 'tool.call.completed',
          result: {
            callId,
            toolName: 'Read',
            ok: true,
            content: { kind: 'text', text: 'seed observation' },
            durationMs: 1,
          },
        },
        'turn',
        'flush',
      )
      toolCalls += 1
      successfulToolCalls += 1
    }
    await journal.append(
      {
        type: 'reflection.evaluated',
        evaluation: evaluation(id, item.outcome, item.window),
      },
      'turn',
      'flush',
    )
  }
  if (input.invalidReducer) {
    await journal.append(
      {
        type: 'replan.adjustment.applied',
        cause: 'invalid history fixture',
        summary: 'no matching replan.requested fact',
      },
      'turn',
      'flush',
    )
  }
  if (input.unpaired) {
    await journal.append(
      {
        type: 'reflection.recorded',
        reflection: reflection(
          'unpaired',
          toolCalls,
          3,
          successfulToolCalls,
          touchedFiles,
        ),
      },
      'turn',
      'flush',
    )
  }
  if (input.terminated !== false) {
    await journal.append(
      { type: 'run.terminated', terminal: { reason: 'completed' } },
      'turn',
      'flush',
    )
  }
  await journal.drain()
  return journalPath
}

async function seedOverlappingReflectionSession(
  workspaceRoot: string,
  sessionId: string,
): Promise<string> {
  const journalPath = join(
    workspaceRoot,
    '.agent',
    'sessions',
    sessionId,
    'journal.jsonl',
  )
  await mkdir(join(journalPath, '..'), { recursive: true })
  const journal = new SessionJournal({
    filePath: journalPath,
    sessionId,
    runId: `run_${sessionId}`,
    clock: fixedClock(),
    ids: createSequentialIds(),
  })
  const appendTool = async (callId: string) => {
    await journal.append({
      type: 'tool.call.accepted',
      call: {
        id: callId,
        name: 'Read',
        input: { path: 'input.txt' },
        parentMessageId: 'msg_overlap',
        receivedIndex: 0,
      },
    }, 'turn', 'flush')
    await journal.append({
      type: 'tool.call.completed',
      result: {
        callId,
        toolName: 'Read',
        ok: true,
        content: { kind: 'text', text: 'observation' },
        durationMs: 1,
      },
    }, 'turn', 'flush')
  }
  await journal.append(
    { type: 'run.started', runId: `run_${sessionId}`, configHash: 'test' },
    'boot',
    'flush',
  )
  await journal.append({
    type: 'reflection.recorded',
    reflection: reflection('overlap_a', 0, 2, 0, 0),
  }, 'turn', 'flush')
  await appendTool('overlap_call_a')
  await journal.append({
    type: 'reflection.recorded',
    reflection: reflection('overlap_b', 1, 1, 1, 0),
  }, 'turn', 'flush')
  await appendTool('overlap_call_b')
  await journal.append({
    type: 'reflection.evaluated',
    evaluation: evaluation('overlap_b', 'ineffective', 1),
  }, 'turn', 'flush')
  await journal.drain()
  return journalPath
}

async function seedHistoryGroup(
  workspaceRoot: string,
  prefix: string,
  outcome: ReflectionEvaluation['outcome'],
): Promise<void> {
  for (let index = 1; index <= 3; index++) {
    await seedSession({
      workspaceRoot,
      sessionId: `${prefix}-${index}`,
      outcomes: [{ outcome, window: outcome === 'effective' ? 1 : 3 }],
    })
  }
}

function calibrationState() {
  return createInitialState({
    sessionId: 'calibration-state',
    runId: 'run',
    turnId: 'turn',
    workspaceRoot: 'diagnosis',
    budget: {
      maxTurns: 20,
      maxModelCalls: 20,
      maxToolCalls: 20,
      maxWallTimeMs: 10_000,
    },
    now: 0,
  })
}

describe('v1.6 local outcome calibration', () => {
  test('is deterministic, smoothed and gated by minimum comparable samples', () => {
    const samples = [
      sample({ sessionId: 'b', reflectionId: '2', outcome: 'effective', toolCallsObserved: 5 }),
      sample({ sessionId: 'a', reflectionId: '1', outcome: 'ineffective', toolCallsObserved: 2 }),
      sample({ sessionId: 'c', reflectionId: '3', outcome: 'effective', toolCallsObserved: 4 }),
    ]
    const profile = buildOutcomeCalibrationProfile(samples, { minSamples: 3 })
    const reordered = buildOutcomeCalibrationProfile([...samples].reverse(), { minSamples: 3 })

    expect(profile).toEqual(reordered)
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.entries)).toBe(true)
    expect(Object.isFrozen(profile.entries[0])).toBe(true)
    expect(isOutcomeCalibrationProfile(profile)).toBe(true)
    expect(isOutcomeCalibrationProfile({ ...profile, pairedOutcomes: 99 })).toBe(false)
    expect(isOutcomeCalibrationProfile({ ...profile, minSamples: 101 })).toBe(false)
    expect(profile.entries).toEqual([
      expect.objectContaining({
        trigger: 'stagnation',
        action: 'repair_plan',
        samples: 3,
        effective: 2,
        ineffective: 1,
        smoothedEffectiveness: 0.6,
      }),
    ])
    expect(matchOutcomeCalibration({
      profile,
      trigger: 'stagnation',
      action: 'repair_plan',
      defaultWindow: 3,
    })).toMatchObject({ evaluationWindow: 3 })
    const calibrated = calibrateReflectionDecision(reflection('target'), profile)
    expect(calibrated.decision).toMatchObject({
      action: 'repair_plan',
      evaluateAfterToolCalls: 3,
    })
    expect(calibrated.recommendation).toContain('Local history: 2/3')

    const allEffective = buildOutcomeCalibrationProfile([
      sample({ sessionId: 'a', reflectionId: '1', outcome: 'effective', toolCallsObserved: 1 }),
      sample({ sessionId: 'b', reflectionId: '2', outcome: 'effective', toolCallsObserved: 2 }),
      sample({ sessionId: 'c', reflectionId: '3', outcome: 'effective', toolCallsObserved: 3 }),
    ])
    expect(matchOutcomeCalibration({
      profile: allEffective,
      trigger: 'stagnation',
      action: 'repair_plan',
      defaultWindow: 3,
    })).toMatchObject({ evaluationWindow: 4 })

    const allIneffective = buildOutcomeCalibrationProfile([
      sample({ sessionId: 'a', reflectionId: '1', outcome: 'ineffective', toolCallsObserved: 1 }),
      sample({ sessionId: 'b', reflectionId: '2', outcome: 'ineffective', toolCallsObserved: 2 }),
      sample({ sessionId: 'c', reflectionId: '3', outcome: 'ineffective', toolCallsObserved: 3 }),
    ])
    expect(matchOutcomeCalibration({
      profile: allIneffective,
      trigger: 'stagnation',
      action: 'repair_plan',
      defaultWindow: 3,
    })).toMatchObject({ evaluationWindow: 2 })

    const gated = buildOutcomeCalibrationProfile(samples.slice(0, 2), { minSamples: 3 })
    expect(matchOutcomeCalibration({
      profile: gated,
      trigger: 'stagnation',
      action: 'repair_plan',
      defaultWindow: 3,
    })).toBeUndefined()
  })

  test('returns a stable empty profile when disabled', () => {
    expect(emptyOutcomeCalibrationProfile({ enabled: false })).toMatchObject({
      schemaVersion: 1,
      pairedOutcomes: 0,
      sourceSessions: 0,
      entries: [],
    })
  })

  test('loads only valid non-degraded history and excludes current session', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-calibration-'))
    try {
      await seedSession({
        workspaceRoot,
        sessionId: 'valid',
        outcomes: [
          { outcome: 'effective', window: 4 },
          { outcome: 'effective', window: 5 },
          { outcome: 'ineffective', window: 3 },
        ],
        unpaired: true,
      })
      await seedSession({
        workspaceRoot,
        sessionId: 'unterminated',
        outcomes: [{ outcome: 'effective', window: 1 }],
        terminated: false,
      })
      await seedSession({
        workspaceRoot,
        sessionId: 'degraded',
        outcomes: [{ outcome: 'effective', window: 1 }],
        degraded: true,
      })
      await seedSession({
        workspaceRoot,
        sessionId: 'reducer-invalid',
        outcomes: [{ outcome: 'effective', window: 1 }],
        invalidReducer: true,
      })
      await seedSession({
        workspaceRoot,
        sessionId: 'current',
        outcomes: [{ outcome: 'effective', window: 1 }],
      })

      const profile = await loadOutcomeCalibrationProfile({
        workspaceRoot,
        currentSessionId: 'current',
        config: { minSamples: 3 },
      })
      expect(profile.sourceSessions).toBe(2)
      expect(profile.pairedOutcomes).toBe(4)
      expect(profile.entries[0]).toMatchObject({
        samples: 4,
        effective: 3,
        ineffective: 1,
      })
      const beforeHistory = await loadOutcomeCalibrationProfile({
        workspaceRoot,
        currentSessionId: 'current',
        config: {
          minSamples: 1,
          eligibleBefore: '1970-01-01T00:00:00.000Z',
        },
      })
      expect(beforeHistory.pairedOutcomes).toBe(0)

      await seedSession({
        workspaceRoot,
        sessionId: 'a-before-cutoff',
        outcomes: [{ outcome: 'effective', window: 1 }],
        clockStart: 500_000,
      })
      await seedSession({
        workspaceRoot,
        sessionId: 'z-after-cutoff',
        outcomes: [{ outcome: 'ineffective', window: 1 }],
        clockStart: 2_000_000,
      })
      const stableResumeProfile = await loadOutcomeCalibrationProfile({
        workspaceRoot,
        currentSessionId: 'current',
        config: {
          minSamples: 1,
          maxSessions: 1,
          eligibleBefore: '1970-01-01T00:10:00.000Z',
        },
      })
      expect(stableResumeProfile.sourceSessions).toBe(1)
      expect(stableResumeProfile.pairedOutcomes).toBe(1)
      expect(stableResumeProfile.entries[0]).toMatchObject({
        effective: 1,
        ineffective: 0,
      })

      const oversizedDir = join(workspaceRoot, '.agent', 'sessions', 'oversized')
      await mkdir(oversizedDir, { recursive: true })
      await writeFile(
        join(oversizedDir, 'journal.jsonl'),
        Buffer.alloc(16 * 1024 * 1024 + 1),
      )
      if (process.platform !== 'win32') {
        await symlink(
          join(workspaceRoot, '.agent', 'sessions', 'valid'),
          join(workspaceRoot, '.agent', 'sessions', 'linked'),
          'dir',
        )
      }
      const boundedProfile = await loadOutcomeCalibrationProfile({
        workspaceRoot,
        currentSessionId: 'current',
        config: { minSamples: 3 },
      })
      expect(boundedProfile.pairedOutcomes).toBeGreaterThanOrEqual(4)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('calibrates a runtime reflection window without changing its Supervisor action', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-calibrated-engine-'))
    try {
      const profile = buildOutcomeCalibrationProfile([
        sample({ sessionId: 'a', reflectionId: '1', outcome: 'effective', toolCallsObserved: 1, trigger: 'periodic', action: 'continue_step' }),
        sample({ sessionId: 'b', reflectionId: '2', outcome: 'effective', toolCallsObserved: 1, trigger: 'periodic', action: 'continue_step' }),
        sample({ sessionId: 'c', reflectionId: '3', outcome: 'effective', toolCallsObserved: 1, trigger: 'periodic', action: 'continue_step' }),
      ])
      const model = new ScriptedModel([
        toolCallTurn([
          {
            id: 'task_create',
            name: 'TaskCreate',
            input: {
              subject: 'calibrated task',
              description: 'exercise reflection calibration',
              activeForm: 'calibrating',
            },
          },
        ]),
        textTurn('done'),
        textTurn('confirmed'),
      ])
      const { runtime } = await createRuntime({
        model,
        outcomeCalibrationProfile: profile,
        config: {
          workspaceRoot,
          persist: false,
          mode: 'bypassPermissions',
          context: { enabled: false },
          verification: { enabled: false },
          retrieval: { enabled: false },
          intelligence: { enabled: true, reflectionInterval: 1 },
        },
        clock: fixedClock(),
        ids: createSequentialIds(),
      })
      const initial = runtime.makeInitialState()
      const message = runtime.makeUserMessage('create one task', null)
      const result = await collectRun(runtime.engine, {
        ...initial,
        messages: [message],
      })
      const recorded = result.facts.find(
        (fact): fact is Extract<
          (typeof result.facts)[number],
          { type: 'reflection.recorded' }
        > => fact.type === 'reflection.recorded',
      )
      expect(recorded?.reflection.trigger).toBe('periodic')
      expect(recorded?.reflection.decision?.action).toBe('continue_step')
      expect(recorded?.reflection.decision?.evaluateAfterToolCalls).toBe(4)
      expect(recorded?.reflection.recommendation).toContain('Local history: 3/3')
      expect(model.requests[1]?.system).toContain('OUTCOME CALIBRATION')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('rejects legacy overlapping pending reflections as calibration history', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-calibration-overlap-'))
    try {
      const journalPath = await seedOverlappingReflectionSession(
        workspaceRoot,
        'overlap-history',
      )
      const loaded = await loadSession(journalPath)
      // The legacy fact stream remains generally replayable, but it is not a
      // valid single-flight policy-training source.
      expect(diagnoseSession(loaded, workspaceRoot).ok).toBe(true)
      const scan = await loadOutcomeCalibrationScan({
        workspaceRoot,
        currentSessionId: 'current',
        config: { minSamples: 1 },
      })
      expect(scan.scanStatus).toBe('no_history')
      expect(scan.profile.pairedOutcomes).toBe(0)
      expect(scan.sources).toEqual([])
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('rejects a sample-bearing source whose V4 selection mismatches its journal', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-calibration-snapshot-'))
    try {
      const sessionId = 'snapshot-mismatch-history'
      const journalPath = join(
        workspaceRoot,
        '.agent',
        'sessions',
        sessionId,
        'journal.jsonl',
      )
      await mkdir(join(journalPath, '..'), { recursive: true })
      const journal = new SessionJournal({
        filePath: journalPath,
        sessionId,
        runId: `run_${sessionId}`,
        clock: fixedClock(),
        ids: createSequentialIds(),
      })
      const profile = emptyOutcomeCalibrationProfile({ minSamples: 1 })
      const journalSelection = buildOutcomeCalibrationSelection({
        origin: 'history_scan',
        scanStatus: 'no_history',
        eligibleBefore: '2026-01-01T00:00:00.000Z',
        profile,
      })
      const snapshotSelection = buildOutcomeCalibrationSelection({
        origin: 'history_scan',
        scanStatus: 'no_history',
        eligibleBefore: '2026-01-02T00:00:00.000Z',
        profile,
      })
      let snapshotState = createInitialState({
        sessionId,
        runId: `run_${sessionId}`,
        turnId: 'turn',
        workspaceRoot,
        budget: {
          maxTurns: 10,
          maxModelCalls: 10,
          maxToolCalls: 10,
          maxWallTimeMs: 10_000,
        },
        now: 0,
      })
      snapshotState = reduce(snapshotState, {
        type: 'outcome.calibration.selected',
        selection: snapshotSelection,
      })
      await journal.append(
        { type: 'run.started', runId: `run_${sessionId}`, configHash: 'test' },
        'boot',
        'flush',
      )
      await journal.append({
        type: 'outcome.calibration.selected',
        selection: journalSelection,
      }, 'boot', 'flush')
      await journal.append({
        type: 'state.snapshot',
        snapshot: createSnapshot(snapshotState, 2),
      }, 'turn', 'flush')
      await journal.append({
        type: 'reflection.recorded',
        reflection: reflection('snapshot_tail', 0, 1, 0, 0),
      }, 'turn', 'flush')
      await journal.append({
        type: 'tool.call.accepted',
        call: {
          id: 'snapshot_tail_call',
          name: 'Read',
          input: { path: 'input.txt' },
          parentMessageId: 'msg_snapshot',
          receivedIndex: 0,
        },
      }, 'turn', 'flush')
      await journal.append({
        type: 'workspace.changed',
        path: join(workspaceRoot, 'snapshot-progress.txt'),
        change: 'modified',
      }, 'turn', 'flush')
      await journal.append({
        type: 'tool.call.completed',
        result: {
          callId: 'snapshot_tail_call',
          toolName: 'Read',
          ok: true,
          content: { kind: 'text', text: 'observation' },
          durationMs: 1,
        },
      }, 'turn', 'flush')
      await journal.append({
        type: 'reflection.evaluated',
        evaluation: evaluation('snapshot_tail', 'effective', 1),
      }, 'turn', 'flush')
      await journal.drain()

      const diagnosis = diagnoseSession(await loadSession(journalPath), workspaceRoot)
      expect(diagnosis.ok).toBe(false)
      expect(diagnosis.issues[0]?.invariant)
        .toBe('outcome_calibration_snapshot_mismatch')
      const scan = await loadOutcomeCalibrationScan({
        workspaceRoot,
        currentSessionId: 'current',
        config: { minSamples: 1 },
      })
      expect(scan.profile.pairedOutcomes).toBe(0)
      expect(scan.sources).toEqual([])
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('pins full history provenance and reuses it after the source history changes', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-calibration-pin-'))
    try {
      await seedHistoryGroup(workspaceRoot, 'positive', 'effective')
      const first = await createRuntime({
        model: new ScriptedModel([]),
        config: {
          workspaceRoot,
          sessionId: 'current',
          persist: true,
          intelligence: { outcomeCalibrationMinSamples: 3 },
        },
        clock: fixedClock(),
      })
      const selectionA = first.runtime.outcomeCalibrationSelection!
      expect(selectionA.origin).toBe('history_scan')
      expect(selectionA.scanStatus).toBe('complete')
      expect(selectionA.sources).toHaveLength(3)
      expect(selectionA.hash).toMatch(/^[a-f0-9]{64}$/)
      expect(Object.isFrozen(selectionA)).toBe(true)
      expect(Object.isFrozen(selectionA.sources[0])).toBe(true)
      expect(matchOutcomeCalibration({
        profile: selectionA.profile,
        trigger: 'stagnation',
        action: 'repair_plan',
        defaultWindow: 3,
      })?.evaluationWindow).toBe(4)

      for (let index = 1; index <= 3; index++) {
        await rm(
          join(workspaceRoot, '.agent', 'sessions', `positive-${index}`),
          { recursive: true, force: true },
        )
      }
      await seedHistoryGroup(workspaceRoot, 'negative', 'ineffective')
      const fresh = await loadOutcomeCalibrationScan({
        workspaceRoot,
        currentSessionId: 'current',
        config: { minSamples: 3 },
      })
      expect(fresh.profile.hash).not.toBe(selectionA.profile.hash)
      expect(matchOutcomeCalibration({
        profile: fresh.profile,
        trigger: 'stagnation',
        action: 'repair_plan',
        defaultWindow: 3,
      })?.evaluationWindow).toBe(2)

      const resumedRuntime = await createRuntime({
        model: new ScriptedModel([]),
        outcomeCalibrationProfile: fresh.profile,
        config: {
          workspaceRoot,
          sessionId: 'current',
          persist: true,
          intelligence: { outcomeCalibrationMinSamples: 3 },
        },
        clock: fixedClock(2_000_000),
      })
      expect(resumedRuntime.runtime.outcomeCalibrationSelection).toEqual(selectionA)
      const resumed = await resumeState(
        resumedRuntime.runtime,
        resumedRuntime.loaded!,
      )
      expect(resumed.state.outcomeCalibrationSelection).toEqual(selectionA)

      const snapshot = createSnapshot(resumed.state, 10)
      expect(snapshot.version).toBe(5)
      expect(snapshot.outcomeCalibrationSelection).toEqual(selectionA)
      const restored = restoreFromSnapshot(calibrationState(), snapshot)
      expect(restored.outcomeCalibrationSelection).toEqual(selectionA)

      const finalJournal = await loadSession(first.runtime.journalPath)
      expect(
        finalJournal.envelopes.filter(
          envelope => envelope.event.type === 'outcome.calibration.selected',
        ),
      ).toHaveLength(1)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('pins an explicit empty profile and does not learn later history on resume', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-calibration-empty-pin-'))
    try {
      const first = await createRuntime({
        model: new ScriptedModel([]),
        config: {
          workspaceRoot,
          sessionId: 'empty-current',
          persist: true,
          intelligence: { outcomeCalibrationMinSamples: 3 },
        },
        clock: fixedClock(),
      })
      const emptySelection = first.runtime.outcomeCalibrationSelection!
      expect(emptySelection.scanStatus).toBe('no_history')
      expect(emptySelection.profile).toMatchObject({
        sourceSessions: 0,
        pairedOutcomes: 0,
        entries: [],
      })

      await seedHistoryGroup(workspaceRoot, 'later', 'effective')
      const fresh = await loadOutcomeCalibrationScan({
        workspaceRoot,
        currentSessionId: 'empty-current',
        config: { minSamples: 3 },
      })
      expect(fresh.profile.pairedOutcomes).toBe(3)

      const resumed = await createRuntime({
        model: new ScriptedModel([]),
        config: {
          workspaceRoot,
          sessionId: 'empty-current',
          persist: true,
          intelligence: { outcomeCalibrationMinSamples: 3 },
        },
        clock: fixedClock(2_000_000),
      })
      expect(resumed.runtime.outcomeCalibrationSelection).toEqual(emptySelection)
      const loaded = await loadSession(resumed.runtime.journalPath)
      expect(
        loaded.envelopes.filter(
          envelope => envelope.event.type === 'outcome.calibration.selected',
        ),
      ).toHaveLength(1)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('explicit disable suppresses a durable selection without replacing it', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-calibration-disabled-'))
    try {
      const positive = buildOutcomeCalibrationProfile([
        sample({ sessionId: 'a', reflectionId: '1', outcome: 'effective', toolCallsObserved: 1, trigger: 'periodic', action: 'continue_step' }),
        sample({ sessionId: 'b', reflectionId: '2', outcome: 'effective', toolCallsObserved: 1, trigger: 'periodic', action: 'continue_step' }),
        sample({ sessionId: 'c', reflectionId: '3', outcome: 'effective', toolCallsObserved: 1, trigger: 'periodic', action: 'continue_step' }),
      ])
      const first = await createRuntime({
        model: new ScriptedModel([]),
        outcomeCalibrationProfile: positive,
        config: { workspaceRoot, sessionId: 'disabled-current', persist: true },
        clock: fixedClock(),
      })
      const pinned = first.runtime.outcomeCalibrationSelection!

      const disabledModel = new ScriptedModel([
        toolCallTurn([{
          id: 'disabled_task',
          name: 'TaskCreate',
          input: {
            subject: 'disabled calibration',
            description: 'prove config precedence',
            activeForm: 'testing',
          },
        }]),
        textTurn('done'),
        textTurn('confirmed'),
      ])
      const disabled = await createRuntime({
        model: disabledModel,
        outcomeCalibrationProfile: emptyOutcomeCalibrationProfile(),
        config: {
          workspaceRoot,
          sessionId: 'disabled-current',
          persist: true,
          mode: 'bypassPermissions',
          context: { enabled: false },
          verification: { enabled: false },
          retrieval: { enabled: false },
          intelligence: {
            enabled: true,
            reflectionInterval: 1,
            outcomeCalibrationEnabled: false,
          },
        },
      })
      expect(disabled.runtime.outcomeCalibrationSelection).toEqual(pinned)
      const run = await collectRun(disabled.runtime.engine, {
        ...disabled.runtime.makeInitialState(),
        messages: [disabled.runtime.makeUserMessage('create one task', null)],
      })
      const recorded = run.facts.find(
        (fact): fact is Extract<FactEvent, { type: 'reflection.recorded' }> =>
          fact.type === 'reflection.recorded',
      )
      expect(recorded?.reflection.decision?.evaluateAfterToolCalls).toBe(3)
      expect(recorded?.reflection.calibration).toBeUndefined()
      expect(disabledModel.requests.every(
        request => !request.system.includes('OUTCOME CALIBRATION'),
      )).toBe(true)

      const reenabled = await createRuntime({
        model: new ScriptedModel([]),
        outcomeCalibrationProfile: emptyOutcomeCalibrationProfile(),
        config: {
          workspaceRoot,
          sessionId: 'disabled-current',
          persist: true,
          intelligence: { outcomeCalibrationEnabled: true },
        },
      })
      expect(reenabled.runtime.outcomeCalibrationSelection).toEqual(pinned)
      expect(matchOutcomeCalibration({
        profile: reenabled.runtime.outcomeCalibrationSelection!.profile,
        trigger: 'periodic',
        action: 'continue_step',
        defaultWindow: 3,
      })?.evaluationWindow).toBe(4)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('keeps one pending reflection in flight until its no-progress window is evaluated', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-calibration-single-flight-'))
    try {
      await writeFile(join(workspaceRoot, 'input.txt'), 'seed')
      const model = new ScriptedModel([
        toolCallTurn([{
          id: 'task',
          name: 'TaskCreate',
          input: {
            subject: 'single flight',
            description: 'wait for the full observation window',
            activeForm: 'observing',
          },
        }]),
        toolCallTurn([{ id: 'read_1', name: 'Read', input: { path: 'input.txt' } }]),
        toolCallTurn([{ id: 'read_2', name: 'Read', input: { path: 'input.txt' } }]),
        toolCallTurn([{ id: 'read_3', name: 'Read', input: { path: 'input.txt' } }]),
        textTurn('done'),
        textTurn('confirmed'),
      ])
      const { runtime } = await createRuntime({
        model,
        config: {
          workspaceRoot,
          persist: false,
          mode: 'bypassPermissions',
          context: { enabled: false },
          verification: { enabled: false },
          retrieval: { enabled: false },
          intelligence: {
            enabled: true,
            reflectionInterval: 1,
            reflectionEvaluationWindow: 3,
          },
        },
      })
      const result = await collectRun(runtime.engine, {
        ...runtime.makeInitialState(),
        messages: [runtime.makeUserMessage('observe without progress', null)],
      })
      const firstReflection = result.facts.find(
        (fact): fact is Extract<FactEvent, { type: 'reflection.recorded' }> =>
          fact.type === 'reflection.recorded',
      )!
      const evaluation = result.facts.find(
        (fact): fact is Extract<FactEvent, { type: 'reflection.evaluated' }> =>
          fact.type === 'reflection.evaluated' &&
          fact.evaluation.reflectionId === firstReflection.reflection.id,
      )
      expect(evaluation?.evaluation).toMatchObject({
        outcome: 'ineffective',
        toolCallsObserved: 3,
      })
      const evaluationIndex = result.facts.indexOf(evaluation!)
      expect(
        result.facts
          .slice(0, evaluationIndex)
          .filter(fact => fact.type === 'reflection.recorded'),
      ).toHaveLength(1)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('treats the bounded window as an explicit downstream repair-timing input', async () => {
    const negative = buildOutcomeCalibrationProfile([
      sample({ sessionId: 'a', reflectionId: '1', outcome: 'ineffective', toolCallsObserved: 3, trigger: 'periodic', action: 'continue_step' }),
      sample({ sessionId: 'b', reflectionId: '2', outcome: 'ineffective', toolCallsObserved: 3, trigger: 'periodic', action: 'continue_step' }),
      sample({ sessionId: 'c', reflectionId: '3', outcome: 'ineffective', toolCallsObserved: 3, trigger: 'periodic', action: 'continue_step' }),
    ])
    const runCase = async (profile?: typeof negative) => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-calibration-policy-'))
      await writeFile(join(workspaceRoot, 'input.txt'), 'seed')
      const model = new ScriptedModel([
        toolCallTurn([{
          id: 'create_task',
          name: 'TaskCreate',
          input: {
            subject: 'policy timing',
            description: 'keep supervision applicable',
            activeForm: 'observing',
          },
        }]),
        toolCallTurn([{ id: 'read_1', name: 'Read', input: { path: 'input.txt' } }]),
        toolCallTurn([{ id: 'read_2', name: 'Read', input: { path: 'input.txt' } }]),
        textTurn('pause for supervision'),
        toolCallTurn([{
          id: 'complete_task',
          name: 'TaskUpdate',
          input: { id: 'task_1', status: 'completed' },
        }]),
        textTurn('done'),
      ])
      const { runtime } = await createRuntime({
        model,
        outcomeCalibrationProfile: profile,
        config: {
          workspaceRoot,
          persist: false,
          mode: 'bypassPermissions',
          context: { enabled: false },
          verification: { enabled: false },
          retrieval: { enabled: false },
          intelligence: {
            enabled: true,
            reflectionInterval: 1,
            reflectionEvaluationWindow: 3,
          },
        },
        ids: createSequentialIds(),
      })
      const result = await collectRun(runtime.engine, {
        ...runtime.makeInitialState(),
        messages: [runtime.makeUserMessage('read without progress', null)],
      })
      return { workspaceRoot, model, result }
    }

    const baseline = await runCase()
    const calibrated = await runCase(negative)
    try {
      expect(
        baseline.result.facts.some(
          fact =>
            fact.type === 'reflection.evaluated' &&
            fact.evaluation.outcome === 'ineffective' &&
            fact.evaluation.toolCallsObserved === 2,
        ),
      ).toBe(false)
      expect(
        calibrated.result.facts.find(
          (fact): fact is Extract<FactEvent, { type: 'reflection.evaluated' }> =>
            fact.type === 'reflection.evaluated',
        )?.evaluation,
      ).toMatchObject({ outcome: 'ineffective', toolCallsObserved: 2 })
      expect(baseline.model.requests[3]!.tools.some(tool => tool.name === 'Write'))
        .toBe(true)
      expect(calibrated.model.requests[3]!.tools.some(tool => tool.name === 'Write'))
        .toBe(false)
      expect(calibrated.model.requests[3]!.system).toContain('repair_plan')
    } finally {
      await rm(baseline.workspaceRoot, { recursive: true, force: true })
      await rm(calibrated.workspaceRoot, { recursive: true, force: true })
    }
  })

  test('rejects malformed selection and impossible reflection evaluation facts', () => {
    const profile = buildOutcomeCalibrationProfile([
      sample({ sessionId: 'a', reflectionId: '1', outcome: 'effective', toolCallsObserved: 1 }),
    ], { minSamples: 1 })
    const selection = buildOutcomeCalibrationSelection({
      origin: 'test_injected',
      scanStatus: 'complete',
      eligibleBefore: '2026-01-01T00:00:00.000Z',
      profile,
    })
    expect(isOutcomeCalibrationSelection(selection)).toBe(true)
    expect(isOutcomeCalibrationSelection({
      ...selection,
      policy: { ...selection.policy, minSamples: 2 },
    })).toBe(false)
    expect(isOutcomeCalibrationSelection({ ...selection, secret: 'leak' })).toBe(false)
    expect(isOutcomeCalibrationSelection({
      ...selection,
      policy: { ...selection.policy, extra: true },
    })).toBe(false)
    expect(isOutcomeCalibrationSelection({
      ...selection,
      profile: { ...selection.profile, extra: true },
    })).toBe(false)
    expect(isOutcomeCalibrationProfile({
      ...profile,
      entries: profile.entries.map((entry, index) =>
        index === 0 ? { ...entry, extra: true } : entry),
    })).toBe(false)

    expect(() => reduce(calibrationState(), {
      type: 'reflection.recorded',
      reflection: {
        ...reflection('bad-baseline'),
        progress: {
          ...reflection('bad-baseline').progress,
          completedTasks: -1,
        },
      },
    })).toThrow(/invalid baseline/)
    expect(() => reduce(calibrationState(), {
      type: 'reflection.recorded',
      reflection: { ...reflection('empty-id'), id: '' },
    })).toThrow(/invalid baseline, decision or calibration/)
    expect(() => reduce(calibrationState(), {
      type: 'reflection.recorded',
      reflection: {
        ...reflection('forged-attribution'),
        calibration: {
          selectionHash: 'forged',
          profileHash: 'forged',
          baseWindow: 20,
          delta: 1,
          calibratedWindow: 1,
        },
      },
    })).toThrow(/calibration attribution/)

    let state = calibrationState()
    const recorded = reflection('strict', 0, 3, 0, 0)
    state = reduce(state, { type: 'reflection.recorded', reflection: recorded })
    const accepted: FactEvent = {
      type: 'tool.call.accepted',
      call: {
        id: 'strict_call',
        name: 'Read',
        input: { path: 'input.txt' },
        parentMessageId: 'msg',
        receivedIndex: 0,
      },
    }
    const completed: FactEvent = {
      type: 'tool.call.completed',
      result: {
        callId: 'strict_call',
        toolName: 'Read',
        ok: true,
        content: { kind: 'text', text: 'read' },
        durationMs: 1,
      },
    }
    state = reduce(reduce(state, accepted), completed)
    expect(() => reduce(state, {
      type: 'reflection.evaluated',
      evaluation: evaluation('strict', 'ineffective', 1),
    })).toThrow(/inconsistent with its recorded window\/outcome/)
    expect(() => reduce(state, {
      type: 'reflection.evaluated',
      evaluation: evaluation('strict', 'effective', 1),
    })).toThrow(/durable fact-level progress/)
    expect(() => reduce(state, {
      type: 'reflection.evaluated',
      evaluation: {
        ...evaluation('strict', 'ineffective', 1),
        outcome: 'mystery',
      },
    } as unknown as FactEvent)).toThrow(/inconsistent with its recorded window\/outcome/)
    expect(() => reduce(state, { type: 'unknown.v1.8' } as unknown as FactEvent))
      .toThrow(/unknown fact event type/)
  })

  test('strict recovery rejects duplicate, tampered and unknown calibration facts', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-calibration-strict-'))
    try {
      const profile = emptyOutcomeCalibrationProfile({ minSamples: 3 })
      const selection = buildOutcomeCalibrationSelection({
        origin: 'history_scan',
        scanStatus: 'no_history',
        eligibleBefore: '2026-01-01T00:00:00.000Z',
        profile,
      })
      const makeJournal = async (sessionId: string) => {
        const path = join(
          workspaceRoot,
          '.agent',
          'sessions',
          sessionId,
          'journal.jsonl',
        )
        const journal = new SessionJournal({
          filePath: path,
          sessionId,
          runId: `run_${sessionId}`,
          clock: fixedClock(),
          ids: createSequentialIds(),
        })
        await journal.append(
          { type: 'run.started', runId: `run_${sessionId}`, configHash: 'test' },
          'boot',
          'flush',
        )
        return { journal, path }
      }

      const lateSelection = await makeJournal('late-selection')
      await lateSelection.journal.append(
        {
          type: 'state.snapshot',
          snapshot: createSnapshot(calibrationState(), 1),
        },
        'turn',
        'flush',
      )
      await lateSelection.journal.append(
        { type: 'outcome.calibration.selected', selection },
        'boot',
        'flush',
      )
      expect(diagnoseSession(await loadSession(lateSelection.path), workspaceRoot).ok).toBe(true)

      const duplicate = await makeJournal('duplicate')
      await duplicate.journal.append(
        { type: 'outcome.calibration.selected', selection },
        'boot',
        'flush',
      )
      await duplicate.journal.append(
        { type: 'outcome.calibration.selected', selection },
        'boot',
        'flush',
      )
      const duplicateDiagnosis = diagnoseSession(
        await loadSession(duplicate.path),
        workspaceRoot,
      )
      expect(duplicateDiagnosis.ok).toBe(false)
      expect(duplicateDiagnosis.issues[0]?.invariant)
        .toBe('outcome_calibration_duplicate_selection')

      const tampered = await makeJournal('tampered')
      await tampered.journal.append(
        {
          type: 'outcome.calibration.selected',
          selection: { ...selection, hash: '0'.repeat(64) },
        } as FactEvent,
        'boot',
        'flush',
      )
      const tamperedDiagnosis = diagnoseSession(
        await loadSession(tampered.path),
        workspaceRoot,
      )
      expect(tamperedDiagnosis.ok).toBe(false)
      expect(tamperedDiagnosis.issues[0]?.invariant)
        .toBe('outcome_calibration_invalid_selection')

      const forgedSnapshot = await makeJournal('forged-snapshot-attribution')
      await forgedSnapshot.journal.append(
        { type: 'outcome.calibration.selected', selection },
        'boot',
        'flush',
      )
      let forgedState = reduce(calibrationState(), {
        type: 'outcome.calibration.selected',
        selection,
      })
      forgedState = {
        ...forgedState,
        reflections: [{
          ...reflection('snapshot-forged'),
          calibration: {
            selectionHash: selection.hash,
            profileHash: selection.profile.hash,
            baseWindow: 3,
            delta: 1,
            calibratedWindow: 4,
          },
        }],
      }
      await forgedSnapshot.journal.append(
        { type: 'state.snapshot', snapshot: createSnapshot(forgedState, 2) },
        'turn',
        'flush',
      )
      const forgedSnapshotDiagnosis = diagnoseSession(
        await loadSession(forgedSnapshot.path),
        workspaceRoot,
      )
      expect(forgedSnapshotDiagnosis.ok).toBe(false)
      expect(forgedSnapshotDiagnosis.issues[0]?.invariant)
        .toBe('reflection_invalid_calibration_snapshot')

      const unknown = await makeJournal('unknown')
      await unknown.journal.append(
        { type: 'outcome.calibration.future' } as unknown as FactEvent,
        'boot',
        'flush',
      )
      const unknownLoaded = await loadSession(unknown.path)
      expect(unknownLoaded.ok).toBe(false)
      expect(diagnoseSession(unknownLoaded, workspaceRoot).issues[0]?.invariant)
        .toBe('unknown_fact_event')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
