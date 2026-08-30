import { describe, test, expect } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envelopeChecksum, type JournalEnvelope } from '../src/session/SessionJournal.js'
import { loadSession } from '../src/session/SessionLoader.js'
import { diagnoseSession } from '../src/session/recoveryCheck.js'
import { resumeState } from '../src/app/createRuntime.js'
import type { FactEvent } from '../src/core/events.js'
import { makeWorld } from './helpers.js'
import { createInitialState, createSnapshot } from '../src/core/state.js'
import type { PlanHealthAssessment } from '../src/core/events.js'

const SESSION_ID = 'ses-corrupt'

function envelope(
  seq: number,
  event: FactEvent,
  parentEventId: string | null,
): JournalEnvelope {
  const base = {
    schemaVersion: 1 as const,
    seq,
    eventId: `evt_test_${seq}`,
    sessionId: SESSION_ID,
    runId: 'run_test',
    turnId: 'turn_test',
    parentEventId,
    timestamp: new Date(1_000_000 + seq * 1000).toISOString(),
    event,
  }
  return { ...base, checksum: envelopeChecksum(base) }
}

function userMessage(id: string, text: string) {
  return {
    id,
    parentId: null,
    sessionId: SESSION_ID,
    turnId: 'turn_test',
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    createdAt: '2026-01-01T00:00:00.000Z',
    meta: { source: 'human' as const },
  }
}

/**
 * Journal that is syntactically perfect (valid JSON, valid checksums, no seq
 * gaps) but whose seq-3 fact violates a reducer invariant. A seq-4 fact after
 * it lets us assert whether strict replay stops and degraded replay continues.
 */
async function writeCorruptJournal(workspaceRoot: string): Promise<string> {
  const dir = join(workspaceRoot, '.agent', 'sessions', SESSION_ID)
  await mkdir(dir, { recursive: true })
  const journalPath = join(dir, 'journal.jsonl')
  const envelopes = [
    envelope(1, { type: 'run.started', runId: 'run_test', configHash: 'h' }, null),
    envelope(
      2,
      { type: 'user.message.accepted', message: userMessage('msg_1', 'first') },
      'evt_test_1',
    ),
    // valid JSON + valid checksum, but no replan is in progress
    envelope(
      3,
      { type: 'replan.adjustment.applied', cause: 'test', summary: 'corrupt' },
      'evt_test_2',
    ),
    envelope(
      4,
      { type: 'user.message.accepted', message: userMessage('msg_2', 'second') },
      'evt_test_3',
    ),
  ]
  await writeFile(
    journalPath,
    envelopes.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  )
  return journalPath
}

function humanTexts(state: { messages: { meta?: { source?: string }; content: { type: string; text?: string }[] }[] }): string[] {
  return state.messages
    .filter(m => m.meta?.source === 'human')
    .map(m => m.content.filter(b => b.type === 'text').map(b => b.text ?? '').join(''))
}

describe('recovery strictness (finish-list §1.5)', () => {
  test('malformed V5 snapshot is diagnosed instead of escaping as an exception', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-strict-'))
    try {
      const dir = join(workspaceRoot, '.agent', 'sessions', SESSION_ID)
      await mkdir(dir, { recursive: true })
      const state = createInitialState({
        sessionId: SESSION_ID, runId: 'run_test', turnId: 'turn_test',
        workspaceRoot, now: 0,
        budget: { maxTurns: 1, maxModelCalls: 1, maxToolCalls: 1, maxWallTimeMs: 1 },
      })
      state.latestPlanHealth = {
        id: 'health_bad', createdAt: 't', status: 'attention', score: 50,
        signature: 'bad',
        metrics: {
          totalTasks: 0, completedTasks: 0, openTasks: 0, blockedTasks: 0,
          failedTasks: 0, readyTasks: 0, requiredCriteria: 0,
          coveredCriteria: 0, scopeDriftFiles: 0, budgetRemainingRatio: 1,
          consecutiveFailures: 0, stagnationSignals: 0,
          ineffectiveReflections: 0,
        },
        findings: [],
        decision: {
          action: 'future_action', rationale: 'bad', successSignals: [],
        },
      } as unknown as PlanHealthAssessment
      const envelopes = [
        envelope(1, { type: 'run.started', runId: 'run_test', configHash: 'h' }, null),
        envelope(2, {
          type: 'state.snapshot', snapshot: createSnapshot(state, 1),
        }, 'evt_test_1'),
      ]
      const journalPath = join(dir, 'journal.jsonl')
      await writeFile(
        journalPath,
        envelopes.map(item => JSON.stringify(item)).join('\n') + '\n',
        'utf8',
      )
      const diagnosis = diagnoseSession(await loadSession(journalPath), workspaceRoot)
      expect(diagnosis.ok).toBe(false)
      expect(diagnosis.issues[0]).toMatchObject({
        kind: 'reducer', invariant: 'plan_health_unknown_action',
      })
      expect(diagnosis.issues[0]!.location).toContain('seq 2')
      expect(diagnosis.lastTrustedSeq).toBe(1)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('diagnoseSession reports reducer invariant violations with the exact position', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-strict-'))
    try {
      const journalPath = await writeCorruptJournal(workspaceRoot)
      const loaded = await loadSession(journalPath)
      expect(loaded.ok).toBe(true) // loader sees nothing wrong

      const diagnosis = diagnoseSession(loaded, workspaceRoot)
      expect(diagnosis.ok).toBe(false)
      expect(diagnosis.issues).toHaveLength(1)
      expect(diagnosis.issues[0]!.kind).toBe('reducer')
      expect(diagnosis.issues[0]!.invariant).toBe('replan_adjustment_without_request')
      expect(diagnosis.issues[0]!.location).toContain('seq 3')
      expect(diagnosis.lastTrustedSeq).toBe(2)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('journal checksum corruption surfaces through the SAME diagnostic model', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-strict-'))
    try {
      const dir = join(workspaceRoot, '.agent', 'sessions', SESSION_ID)
      await mkdir(dir, { recursive: true })
      const good = envelope(1, { type: 'run.started', runId: 'r', configHash: 'h' }, null)
      const badChecksum = { ...good, seq: 2, eventId: 'evt_x', checksum: 'deadbeefdeadbeef' }
      await writeFile(
        join(dir, 'journal.jsonl'),
        JSON.stringify(good) + '\n' + JSON.stringify(badChecksum) + '\n',
        'utf8',
      )
      const loaded = await loadSession(join(dir, 'journal.jsonl'))
      const diagnosis = diagnoseSession(loaded, workspaceRoot)
      expect(diagnosis.ok).toBe(false)
      expect(diagnosis.issues[0]!.kind).toBe('journal')
      expect(diagnosis.issues[0]!.invariant).toBe('checksum_mismatch')
      expect(diagnosis.lastTrustedSeq).toBe(1)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('strict replay STOPS at the corrupt fact; degraded skips it and continues', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-strict-'))
    try {
      const journalPath = await writeCorruptJournal(workspaceRoot)
      const loaded = await loadSession(journalPath)
      const world = await makeWorld({
        turns: [],
        persist: false,
        workspaceRoot,
      })
      try {
        // STRICT (default): refuses to replay past seq 3 — the seq-4 fact is
        // never applied and the failure is fully reported
        const strict = await resumeState(world.runtime, loaded)
        expect(strict.replayFailure).not.toBeNull()
        expect(strict.replayFailure!.seq).toBe(3)
        expect(strict.replayFailure!.eventId).toBe('evt_test_3')
        expect(strict.replayFailure!.invariant).toBe('replan_adjustment_without_request')
        expect(strict.replayFailure!.lastTrustedSeq).toBe(2)
        expect(strict.replayFailure!.allowDegraded).toBe(false)
        expect(humanTexts(strict.state)).toEqual(['first'])

        // DEGRADED (explicit opt-in only): skip the bad fact, keep replaying
        const degraded = await resumeState(world.runtime, loaded, { degraded: true })
        expect(degraded.replayFailure).not.toBeNull()
        expect(degraded.replayFailure!.allowDegraded).toBe(true)
        expect(humanTexts(degraded.state)).toEqual(['first', 'second'])
      } finally {
        await world.cleanup()
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('diagnosis replays absolute workspace paths against the real root', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-strict-root-'))
    try {
      const dir = join(workspaceRoot, '.agent', 'sessions', SESSION_ID)
      await mkdir(dir, { recursive: true })
      const envelopes = [
        envelope(1, { type: 'run.started', runId: 'r', configHash: 'h' }, null),
        envelope(2, {
          type: 'workspace.changed',
          path: join(workspaceRoot, 'src', 'absolute.ts'),
          change: 'modified',
        }, 'evt_test_1'),
      ]
      const journalPath = join(dir, 'journal.jsonl')
      await writeFile(
        journalPath,
        envelopes.map(item => JSON.stringify(item)).join('\n') + '\n',
        'utf8',
      )
      const loaded = await loadSession(journalPath)
      expect(diagnoseSession(loaded, workspaceRoot).ok).toBe(true)
      expect(diagnoseSession(loaded, join(workspaceRoot, 'other')).issues[0])
        .toMatchObject({ invariant: 'workspace_change_outside_root' })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('a clean journal diagnoses ok and resumes identically in both modes', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-strict-'))
    try {
      const dir = join(workspaceRoot, '.agent', 'sessions', SESSION_ID)
      await mkdir(dir, { recursive: true })
      const envelopes = [
        envelope(1, { type: 'run.started', runId: 'r', configHash: 'h' }, null),
        envelope(
          2,
          { type: 'user.message.accepted', message: userMessage('msg_1', 'hello') },
          'evt_test_1',
        ),
      ]
      const journalPath = join(dir, 'journal.jsonl')
      await writeFile(
        journalPath,
        envelopes.map(e => JSON.stringify(e)).join('\n') + '\n',
        'utf8',
      )
      const loaded = await loadSession(journalPath)
      expect(diagnoseSession(loaded, workspaceRoot).ok).toBe(true)

      const world = await makeWorld({ turns: [], persist: false, workspaceRoot })
      try {
        const strict = await resumeState(world.runtime, loaded)
        expect(strict.replayFailure).toBeNull()
        expect(humanTexts(strict.state)).toEqual(['hello'])
      } finally {
        await world.cleanup()
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
