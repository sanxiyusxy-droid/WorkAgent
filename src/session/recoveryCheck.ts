import { createInitialState, reduce, restoreFromSnapshot } from '../core/state.js'
import { InvariantError } from '../core/messages.js'
import type { FactEvent } from '../core/events.js'
import type { LoadedSession } from './SessionLoader.js'
import { isOutcomeCalibrationSelection } from '../planning/OutcomeCalibrationContract.js'

/**
 * Unified recovery diagnostic. Journal loader problems (syntax, schema,
 * seq gaps, checksums) and reducer invariant violations both surface through
 * the same structure, so the CLI presents one consistent recovery report
 * instead of two unrelated error shapes.
 */
export interface RecoveryIssue {
  /** 'journal' = the loader rejected a line; 'reducer' = replay violated an invariant */
  kind: 'journal' | 'reducer'
  /** invariant name, e.g. 'checksum_mismatch' or 'replan_adjustment_without_request' */
  invariant: string
  /** where the problem sits: 'line 12' or 'seq 12 / evt_xxx' */
  location: string
  message: string
}

export interface RecoveryDiagnosis {
  ok: boolean
  issues: RecoveryIssue[]
  /** seq of the last envelope that survived every check */
  lastTrustedSeq: number
}

function journalInvariant(text: string): string {
  if (text.includes('unparseable JSON')) return 'unparseable_json'
  if (text.includes('checksum mismatch')) return 'checksum_mismatch'
  if (text.includes('schemaVersion')) return 'unknown_schema_version'
  if (text.includes('unknown fact event')) return 'unknown_fact_event'
  if (text.includes('invalid envelope timestamp')) return 'invalid_timestamp'
  if (text.includes('seq')) return 'seq_gap_or_duplicate'
  return 'journal_error'
}

/**
 * Diagnose a loaded journal WITHOUT touching any runtime state: loader
 * diagnostics plus a dry replay of the surviving envelopes through the real
 * reducer. A journal that parses cleanly can still contain facts that violate
 * state-machine invariants, and both failure classes stop at the FIRST bad
 * position (strict semantics — degraded skipping is the caller's decision).
 */
export function diagnoseSession(
  loaded: LoadedSession,
  workspaceRoot: string,
): RecoveryDiagnosis {
  const issues: RecoveryIssue[] = loaded.diagnostics
    .filter(d => !d.startsWith('journal not found'))
    .map(d => ({
      kind: 'journal' as const,
      invariant: journalInvariant(d),
      location: d.split(':')[0] ?? 'journal',
      message: d,
    }))

  // A snapshot can hide earlier facts from tail replay. Validate the unique
  // calibration selection across the complete trusted envelope prefix before
  // choosing a snapshot path, so duplicates/tampering never become invisible.
  let calibrationSelection:
    Extract<FactEvent, { type: 'outcome.calibration.selected' }>['selection'] |
    undefined
  let calibrationSelectionSeq: number | undefined
  for (let index = 0; index < loaded.envelopes.length; index++) {
    const envelope = loaded.envelopes[index]!
    if (envelope.event.type !== 'outcome.calibration.selected') continue
    const invariant = calibrationSelection
      ? 'outcome_calibration_duplicate_selection'
      : !isOutcomeCalibrationSelection(envelope.event.selection)
        ? 'outcome_calibration_invalid_selection'
        : undefined
    if (invariant) {
      issues.push({
        kind: 'reducer',
        invariant,
        location: `seq ${envelope.seq} / ${envelope.eventId}`,
        message: invariant === 'outcome_calibration_duplicate_selection'
          ? 'a session contains more than one outcome calibration selection'
          : 'outcome calibration selection failed canonical validation',
      })
      const lastTrustedSeq = index > 0
        ? loaded.envelopes[index - 1]!.seq
        : 0
      return { ok: false, issues, lastTrustedSeq }
    }
    calibrationSelection = envelope.event.selection
    calibrationSelectionSeq = envelope.seq
  }

  // dry replay with a throwaway state — identical path selection to
  // resumeState (V4 snapshot tail vs legacy/full replay)
  let state = createInitialState({
    sessionId: 'diagnosis',
    runId: 'diagnosis',
    turnId: 'diagnosis',
    workspaceRoot,
    budget: { maxTurns: 1, maxModelCalls: 1, maxToolCalls: 1, maxWallTimeMs: 1 },
    now: 0,
  })
  const snapshot = loaded.lastSnapshot
  let tail = loaded.envelopes
  let lastTrustedSeq = 0
  if (snapshot?.version === 4) {
    let snapshotIndex = -1
    for (let index = loaded.envelopes.length - 1; index >= 0; index--) {
      if (loaded.envelopes[index]!.event.type === 'state.snapshot') {
        snapshotIndex = index
        break
      }
    }
    try {
      state = restoreFromSnapshot(state, snapshot)
    } catch (error) {
      const envelope = snapshotIndex >= 0 ? loaded.envelopes[snapshotIndex] : undefined
      issues.push({
        kind: 'reducer',
        invariant:
          error instanceof InvariantError ? error.invariant : 'snapshot_restore_error',
        location: envelope
          ? `seq ${envelope.seq} / ${envelope.eventId}`
          : 'state.snapshot',
        message: error instanceof Error ? error.message : String(error),
      })
      lastTrustedSeq = snapshotIndex > 0
        ? loaded.envelopes[snapshotIndex - 1]!.seq
        : 0
      return { ok: false, issues, lastTrustedSeq }
    }
    const snapshotLastSeq = snapshot.lastSeq ??
      (snapshotIndex >= 0 ? loaded.envelopes[snapshotIndex]!.seq - 1 : 0)
    const expectedSnapshotSelectionHash =
      calibrationSelectionSeq !== undefined &&
      calibrationSelectionSeq <= snapshotLastSeq
        ? calibrationSelection?.hash
        : undefined
    if (
      state.outcomeCalibrationSelection?.hash !== expectedSnapshotSelectionHash
    ) {
      const envelope = snapshotIndex >= 0 ? loaded.envelopes[snapshotIndex] : undefined
      issues.push({
        kind: 'reducer',
        invariant: 'outcome_calibration_snapshot_mismatch',
        location: envelope
          ? `seq ${envelope.seq} / ${envelope.eventId}`
          : 'state.snapshot',
        message:
          'V4 snapshot calibration selection does not match the unique journal selection fact',
      })
      lastTrustedSeq = snapshotIndex > 0
        ? loaded.envelopes[snapshotIndex - 1]!.seq
        : 0
      return { ok: false, issues, lastTrustedSeq }
    }
    if (typeof snapshot.lastSeq === 'number') {
      tail = loaded.envelopes.filter(e => e.seq > snapshot.lastSeq!)
      lastTrustedSeq = snapshot.lastSeq
    } else {
      tail = loaded.envelopes.slice(loaded.tailStartIndex)
      lastTrustedSeq =
        loaded.tailStartIndex > 0
          ? loaded.envelopes[loaded.tailStartIndex - 1]!.seq
          : 0
    }
  }

  for (const envelope of tail) {
    const event = envelope.event as FactEvent
    // recovery no-ops mirror replayEnvelopes in createRuntime
    if (event.type === 'run.started' || event.type === 'state.snapshot') {
      lastTrustedSeq = envelope.seq
      continue
    }
    try {
      state = reduce(state, event)
      lastTrustedSeq = envelope.seq
    } catch (error) {
      issues.push({
        kind: 'reducer',
        invariant:
          error instanceof InvariantError ? error.invariant : 'reducer_error',
        location: `seq ${envelope.seq} / ${envelope.eventId}`,
        message: (error as Error).message,
      })
      break // strict: the first failure ends the diagnosis
    }
  }

  return { ok: issues.length === 0, issues, lastTrustedSeq }
}
