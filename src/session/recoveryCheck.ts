import { createInitialState, reduce, restoreFromSnapshot } from '../core/state.js'
import { InvariantError } from '../core/messages.js'
import type { FactEvent } from '../core/events.js'
import type { LoadedSession } from './SessionLoader.js'

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
export function diagnoseSession(loaded: LoadedSession): RecoveryDiagnosis {
  const issues: RecoveryIssue[] = loaded.diagnostics
    .filter(d => !d.startsWith('journal not found'))
    .map(d => ({
      kind: 'journal' as const,
      invariant: journalInvariant(d),
      location: d.split(':')[0] ?? 'journal',
      message: d,
    }))

  // dry replay with a throwaway state — identical path selection to
  // resumeState (V2 snapshot tail vs full replay)
  let state = createInitialState({
    sessionId: 'diagnosis',
    runId: 'diagnosis',
    turnId: 'diagnosis',
    workspaceRoot: 'diagnosis',
    budget: { maxTurns: 1, maxModelCalls: 1, maxToolCalls: 1, maxWallTimeMs: 1 },
    now: 0,
  })
  const snapshot = loaded.lastSnapshot
  let tail = loaded.envelopes
  let lastTrustedSeq = 0
  if (snapshot?.version === 2) {
    state = restoreFromSnapshot(state, snapshot)
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
