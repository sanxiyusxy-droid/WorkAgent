import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Execution state machine for side-effecting tool calls.
 *
 *   not_started → running → committed
 *                         → unknown (interrupted mid-execution)
 *   committed/unknown → resolved_applied   (inspectOutcome proved the effect)
 *   committed/unknown → resolved_not_applied (proof gone → re-execute)
 *   running/unknown   → abandoned          (operation given up, re-executable)
 *
 * Two identities are tracked:
 * - callId: the model-protocol identity of one tool_call (changes on every
 *   retry because the model generates fresh ids)
 * - operationKey: the BUSINESS identity of the side effect — hash of
 *   (sessionId, toolName, canonical args) WITHOUT callId. It identifies
 *   semantic duplicates even when the model retries with a new callId.
 *   Tools with idempotencyScope='invocation' (e.g. Shell) use the call-level
 *   key instead so a fresh repeat of the same command stays legitimate.
 *
 * On recovery:
 * - committed / resolved_applied → deduplicate; the runtime RE-VERIFIES the
 *   commit proof via inspectOutcome when the tool supports it (a file edited
 *   back externally no longer counts as applied and gets re-executed)
 * - running / unknown → inspectOutcome adjudicates into resolved_applied /
 *   resolved_not_applied; without a probe, blind re-execution is refused
 * - resolved_not_applied / abandoned / not_started → safe to execute
 */
export type ExecutionStatus =
  | 'not_started'
  | 'running'
  | 'committed'
  | 'unknown'
  | 'resolved_applied'
  | 'resolved_not_applied'
  | 'abandoned'

/** Statuses an adjudication may move a record into. */
export type AdjudicatedStatus = 'resolved_applied' | 'resolved_not_applied' | 'abandoned'

export interface IdempotencyRecord {
  /** unique key: hash of (sessionId, toolName, canonical input) — the
   * business/operation identity, stable across callId regeneration */
  key: string
  callId: string
  toolName: string
  status: ExecutionStatus
  /** ISO timestamp of last status change */
  updatedAt: string
  /** externally checkable proof of the applied effect (file SHA, version) */
  proof?: string
  /** human-readable outcome of the last adjudication (audit trail) */
  detail?: string
}

/**
 * Persistent ledger that tracks side-effecting tool executions.
 * Stored as a JSON file in the session artifact directory.
 * Checked during recovery to prevent duplicate side effects.
 */
export class IdempotencyLedger {
  private records = new Map<string, IdempotencyRecord>()
  private readonly filePath: string
  private dirty = false

  constructor(private readonly artifactDir: string) {
    this.filePath = join(artifactDir, 'idempotency.json')
  }

  /** Load existing records from disk (called once during recovery). */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const entries: IdempotencyRecord[] = JSON.parse(raw)
      for (const entry of entries) {
        this.records.set(entry.key, entry)
      }
    } catch {
      // no ledger yet — fresh session
    }
  }

  /** Persist current state to disk. */
  async flush(): Promise<void> {
    if (!this.dirty) return
    await mkdir(this.artifactDir, { recursive: true })
    const entries = [...this.records.values()]
    await writeFile(this.filePath, JSON.stringify(entries, null, 2), 'utf8')
    this.dirty = false
  }

  /**
   * Compute the OPERATION key: the semantic identity of a side effect.
   * Deliberately excludes callId so a model retry with a fresh call id is
   * still recognized as the same operation.
   */
  static computeOperationKey(input: {
    sessionId: string
    toolName: string
    args: unknown
  }): string {
    const canonical = JSON.stringify([
      input.sessionId,
      input.toolName,
      input.args,
    ])
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  }

  /**
   * Compute the CALL-level key: the protocol identity of one tool_call
   * (includes callId). Used by tools with idempotencyScope='invocation'
   * (e.g. Shell) so only the crash-recovery replay of the SAME call
   * dedupes, while a fresh repeat of the same command stays legitimate.
   */
  static computeKey(input: {
    sessionId: string
    callId: string
    toolName: string
    args: unknown
  }): string {
    const canonical = JSON.stringify([
      input.sessionId,
      input.callId,
      input.toolName,
      input.args,
    ])
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  }

  /** Get the current status of a key (undefined = never seen). */
  getStatus(key: string): ExecutionStatus | undefined {
    return this.records.get(key)?.status
  }

  /** Get the full record for a key. */
  getRecord(key: string): IdempotencyRecord | undefined {
    return this.records.get(key)
  }

  /** Check if a call was already committed (safe to skip). */
  isCommitted(key: string): boolean {
    return this.records.get(key)?.status === 'committed'
  }

  /** Effect confirmed applied: committed, or adjudicated resolved_applied. */
  isApplied(key: string): boolean {
    const status = this.records.get(key)?.status
    return status === 'committed' || status === 'resolved_applied'
  }

  /** Check if a call needs external state inspection before retry. */
  needsInspection(key: string): boolean {
    const status = this.records.get(key)?.status
    return status === 'running' || status === 'unknown'
  }

  /** Mark a tool call as running (side effect may begin). */
  markRunning(key: string, callId: string, toolName: string, now: string): void {
    this.records.set(key, {
      key,
      callId,
      toolName,
      status: 'running',
      updatedAt: now,
    })
    this.dirty = true
  }

  /** Mark a tool call as committed (side effect confirmed applied). */
  markCommitted(key: string, proof?: string, now?: string): void {
    const record = this.records.get(key)
    if (record) {
      record.status = 'committed'
      record.proof = proof
      record.updatedAt = now ?? record.updatedAt
      this.dirty = true
    }
  }

  /** Mark a tool call as unknown (interrupted, outcome uncertain). */
  markUnknown(key: string, now: string): void {
    const record = this.records.get(key)
    if (record && record.status === 'running') {
      record.status = 'unknown'
      record.updatedAt = now
      this.dirty = true
    }
  }

  /**
   * Adjudicate an uncertain or stale record into a terminal resolution.
   * Returns the previous status so callers can emit an audit fact.
   * - resolved_applied: the effect was verified present → deduplicate
   * - resolved_not_applied: proof no longer holds → re-execution is safe
   * - abandoned: the operation was given up → re-execution is safe
   */
  adjudicate(
    key: string,
    to: AdjudicatedStatus,
    detail: string,
    now: string,
  ): ExecutionStatus | undefined {
    const record = this.records.get(key)
    if (!record) return undefined
    const from = record.status
    record.status = to
    record.detail = detail
    record.updatedAt = now
    this.dirty = true
    return from
  }

  /** All records with a given status (for recovery inspection). */
  byStatus(status: ExecutionStatus): IdempotencyRecord[] {
    return [...this.records.values()].filter(r => r.status === status)
  }
}
