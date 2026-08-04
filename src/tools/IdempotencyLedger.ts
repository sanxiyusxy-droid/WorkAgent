import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Execution state machine for side-effecting tool calls.
 *
 *   not_started → running → committed
 *                         → unknown (interrupted mid-execution)
 *
 * Two identities are tracked:
 * - callId: the model-protocol identity of one tool_call (changes on every
 *   retry because the model generates fresh ids)
 * - operationKey: the BUSINESS identity of the side effect — hash of
 *   (sessionId, toolName, canonical args) WITHOUT callId. It identifies
 *   semantic duplicates even when the model retries with a new callId.
 *
 * On recovery:
 * - committed (by operationKey) → skip re-execution entirely; the commitProof
 *   (file version hash etc.) lets humans verify the effect is really there
 * - running / unknown → MUST inspect external state before retrying; the
 *   runtime refuses blind re-execution
 * - not_started → safe to execute normally
 */
export type ExecutionStatus = 'not_started' | 'running' | 'committed' | 'unknown'

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
   * @deprecated kept for backwards compatibility; prefer computeOperationKey.
   * Call-level key binds one specific protocol call (includes callId).
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

  /** All records with a given status (for recovery inspection). */
  byStatus(status: ExecutionStatus): IdempotencyRecord[] {
    return [...this.records.values()].filter(r => r.status === status)
  }
}
