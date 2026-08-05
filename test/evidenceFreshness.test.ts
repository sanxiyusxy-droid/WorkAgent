import { describe, test, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceStore, receiptHashBody } from '../src/verification/EvidenceStore.js'
import { findStaleReceipts } from '../src/verification/freshness.js'
import { validateReport } from '../src/verification/verdict.js'
import { requiredCriteriaWithoutEvidence } from '../src/planning/completionGate.js'
import { readFileVersion } from '../src/workspace/FileVersion.js'
import type { EvidenceReceipt } from '../src/verification/types.js'
import type { AcceptanceCriterion } from '../src/planning/types.js'
import type { VerificationReport } from '../src/verification/types.js'
import { loadSession } from '../src/session/SessionLoader.js'
import { resumeState } from '../src/app/createRuntime.js'
import { envelopeChecksum, type JournalEnvelope } from '../src/session/SessionJournal.js'
import type { FactEvent } from '../src/core/events.js'
import { fixedClock, makeWorld, collectRun, stateWithUser } from './helpers.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'

function makeStore(workspaceRoot: string): EvidenceStore {
  return new EvidenceStore({
    sessionId: 'ses-fresh',
    runId: 'run-fresh',
    artifactDir: join(workspaceRoot, '.agent'),
    clock: fixedClock(),
    ids: createSequentialIds(),
    persist: false,
    workspaceRoot,
  })
}

/**
 * Inject a receipt with arbitrary bindings. Signed legitimately so
 * EvidenceStore.restore trusts it — the point is to control the binding
 * fields (fileVersions / workspaceRevision) exactly.
 */
function injectReceipt(
  store: EvidenceStore,
  partial: Partial<EvidenceReceipt> & { kind: EvidenceReceipt['kind'] },
): EvidenceReceipt {
  const receipt: EvidenceReceipt = {
    id: 'ev_injected',
    sessionId: 'ses-fresh',
    runId: 'run-fresh',
    criterionIds: [],
    status: 'passed',
    invocation: { tool: 'Shell', normalizedInput: { command: 'npm test' } },
    observation: { exitCode: 0, outputPreview: 'ok' },
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    sha256: '',
    ...partial,
  }
  receipt.sha256 = createHash('sha256')
    .update(JSON.stringify(receiptHashBody(receipt)))
    .digest('hex')
  store.restore(receipt)
  return receipt
}

const AC1: AcceptanceCriterion = {
  id: 'ac1',
  statement: 'the test suite passes',
  evidenceKind: 'test',
  required: true,
}

describe('evidence freshness as a completion gate (finish-list §1.6)', () => {
  test('an UNBOUND code-test receipt can never support PASS', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-fresh-'))
    try {
      const store = makeStore(workspaceRoot)
      // no fileVersions, no workspaceRevision — what a model that "forgets"
      // every binding would have produced before §1.6
      injectReceipt(store, {
        id: 'ev_unbound',
        kind: 'test',
        criterionIds: ['ac1'],
        fileVersions: undefined,
        workspaceRevision: undefined,
      })

      const stale = await findStaleReceipts(store)
      expect(stale.has('ev_unbound')).toBe(true)

      // completion gate: the criterion stays uncovered
      const uncovered = requiredCriteriaWithoutEvidence([AC1], store.list(), stale)
      expect(uncovered.map(c => c.id)).toEqual(['ac1'])

      // verifier validation: a PASS leaning on the unbound receipt is refused
      const report: VerificationReport = {
        verdict: 'PASS',
        summary: 'all good',
        checks: [
          {
            name: 'suite',
            criterionIds: ['ac1'],
            evidenceIds: ['ev_unbound'],
            result: 'PASS',
            expected: 'exit 0',
            actual: 'exit 0',
          },
        ],
        adversarialProbeEvidenceId: 'ev_unbound',
        failures: [],
        unverified: [],
      }
      const validation = validateReport(report, store, [AC1], stale)
      expect(validation.ok).toBe(false)
      expect(validation.ok || validation.reason).toContain('stale')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('manual receipts are exempt from freshness binding', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-fresh-'))
    try {
      const store = makeStore(workspaceRoot)
      injectReceipt(store, {
        id: 'ev_manual',
        kind: 'manual',
        workspaceRevision: undefined,
      })
      const stale = await findStaleReceipts(store)
      expect(stale.has('ev_manual')).toBe(false)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('fine-grained binding: related file change ages, unrelated does not', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-fresh-'))
    try {
      const related = join(workspaceRoot, 'related.txt')
      const unrelated = join(workspaceRoot, 'unrelated.txt')
      await writeFile(related, 'v1', 'utf8')
      await writeFile(unrelated, 'u1', 'utf8')
      const { version } = await readFileVersion(related)

      const store = makeStore(workspaceRoot)
      const receipt = injectReceipt(store, {
        id: 'ev_bound',
        kind: 'test',
        fileVersions: { [related]: version },
      })

      expect((await findStaleReceipts(store)).has(receipt.id)).toBe(false)

      // UNRELATED change: fine-grained strategy keeps the receipt fresh
      await writeFile(unrelated, 'u2', 'utf8')
      expect((await findStaleReceipts(store)).has(receipt.id)).toBe(false)

      // RELATED change: the receipt is stale
      await writeFile(related, 'v2', 'utf8')
      expect((await findStaleReceipts(store)).has(receipt.id)).toBe(true)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('workspace-revision strategy: any write ages unbound receipts; re-signing refreshes', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-fresh-'))
    try {
      const store = makeStore(workspaceRoot)
      const before = await store.record({
        kind: 'test',
        status: 'passed',
        criterionIds: ['ac1'],
        invocation: { tool: 'Shell', normalizedInput: { command: 'npm test' } },
        observation: { exitCode: 0, outputPreview: 'ok' },
        startedAt: '2026-01-01T00:00:00.000Z',
      })
      // automatically bound to the current revision even without evidenceFiles
      expect(before.workspaceRevision).toBe(0)
      expect((await findStaleReceipts(store)).has(before.id)).toBe(false)

      // a write tool changed the workspace
      store.bumpWorkspaceRevision()
      expect((await findStaleReceipts(store)).has(before.id)).toBe(true)

      // re-running the check signs a fresh receipt for the new revision
      const after = await store.record({
        kind: 'test',
        status: 'passed',
        criterionIds: ['ac1'],
        invocation: { tool: 'Shell', normalizedInput: { command: 'npm test' } },
        observation: { exitCode: 0, outputPreview: 'ok' },
        startedAt: '2026-01-01T00:02:00.000Z',
      })
      expect(after.workspaceRevision).toBe(1)
      const stale = await findStaleReceipts(store)
      expect(stale.has(before.id)).toBe(true)
      expect(stale.has(after.id)).toBe(false)

      // and now the criterion IS covered (by the fresh receipt)
      const uncovered = requiredCriteriaWithoutEvidence([AC1], store.list(), stale)
      expect(uncovered).toEqual([])
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('runtime chain: Write bumps the revision, Shell evidence signs it', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      turns: [
        toolCallTurn([
          { id: 'w1', name: 'Write', input: { path: 'app.js', content: 'console.log(1)' } },
        ]),
        toolCallTurn([
          {
            id: 's1',
            name: 'Shell',
            input: { command: 'node -v', evidenceKind: 'test', criterionIds: ['ac1'] },
          },
        ]),
        textTurn('done'),
      ],
    })
    try {
      await collectRun(world.runtime.engine, await stateWithUser(world, 'go'))
      expect(world.runtime.evidence.workspaceRevision).toBe(1)
      const receipts = world.runtime.evidence.list()
      expect(receipts).toHaveLength(1)
      expect(receipts[0]!.workspaceRevision).toBe(1)
      expect(receipts[0]!.fileVersions).toBeUndefined()
      // signed for the current revision: fresh
      expect((await findStaleReceipts(world.runtime.evidence)).size).toBe(0)
    } finally {
      await world.cleanup()
    }
  })

  test('recovery restores the workspace revision counter from the journal', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-fresh-'))
    const sessionId = 'ses-revision'
    try {
      const dir = join(workspaceRoot, '.agent', 'sessions', sessionId)
      await mkdir(dir, { recursive: true })
      const envelope = (
        seq: number,
        event: FactEvent,
        parentEventId: string | null,
      ): JournalEnvelope => {
        const base = {
          schemaVersion: 1 as const,
          seq,
          eventId: `evt_rev_${seq}`,
          sessionId,
          runId: 'run_rev',
          turnId: 'turn_rev',
          parentEventId,
          timestamp: new Date(1_000_000 + seq * 1000).toISOString(),
          event,
        }
        return { ...base, checksum: envelopeChecksum(base) }
      }
      const envelopes = [
        envelope(1, { type: 'run.started', runId: 'run_rev', configHash: 'h' }, null),
        envelope(2, { type: 'workspace.changed', path: 'a.txt', change: 'created' }, 'evt_rev_1'),
        envelope(3, { type: 'workspace.changed', path: 'a.txt', change: 'modified' }, 'evt_rev_2'),
      ]
      await writeFile(
        join(dir, 'journal.jsonl'),
        envelopes.map(e => JSON.stringify(e)).join('\n') + '\n',
        'utf8',
      )

      const loaded = await loadSession(join(dir, 'journal.jsonl'))
      expect(loaded.ok).toBe(true)
      const world = await makeWorld({
        turns: [],
        persist: true,
        sessionId,
        workspaceRoot,
      })
      try {
        await resumeState(world.runtime, loaded)
        expect(world.runtime.evidence.workspaceRevision).toBe(2)
      } finally {
        await world.cleanup()
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
