import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** Persistent state of one side-effecting operation. */
export type ExecutionStatus =
  | 'not_started'
  | 'running'
  | 'committed'
  | 'unknown'
  | 'resolved_applied'
  | 'resolved_not_applied'
  | 'abandoned'

export type AdjudicatedStatus =
  | 'resolved_applied'
  | 'resolved_not_applied'
  | 'abandoned'

export interface IdempotencyRecord {
  key: string
  callId: string
  toolName: string
  status: ExecutionStatus
  updatedAt: string
  proof?: string
  detail?: string
}

export type IdempotencyLedgerErrorCode =
  | 'IDEMPOTENCY_LEDGER_CORRUPT'
  | 'IDEMPOTENCY_LEDGER_IO'

/** Structured recovery error: callers can refuse resume without string parsing. */
export class IdempotencyLedgerError extends Error {
  constructor(
    readonly code: IdempotencyLedgerErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'IdempotencyLedgerError'
  }
}

const RecordSchema = z.object({
  key: z.string().min(1),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum([
    'not_started',
    'running',
    'committed',
    'unknown',
    'resolved_applied',
    'resolved_not_applied',
    'abandoned',
  ]),
  updatedAt: z.string().min(1),
  proof: z.string().optional(),
  detail: z.string().optional(),
}).strict()

const RecordsSchema = z.array(RecordSchema).superRefine((records, ctx) => {
  const seen = new Set<string>()
  for (const [index, record] of records.entries()) {
    if (seen.has(record.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'key'],
        message: `duplicate idempotency key: ${record.key}`,
      })
    }
    seen.add(record.key)
  }
})

const LedgerDocumentSchema = z.object({
  version: z.literal(1),
  records: RecordsSchema,
}).strict()

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalize(item))
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .filter(key => source[key] !== undefined)
        .map(key => [key, canonicalize(source[key])]),
    )
  }
  return value
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/**
 * Durable side-effect ledger. Missing means a fresh session; corrupt or
 * unreadable means recovery must stop because replay could duplicate effects.
 */
export class IdempotencyLedger {
  private records = new Map<string, IdempotencyRecord>()
  private readonly filePath: string
  private dirty = false

  constructor(private readonly artifactDir: string) {
    this.filePath = join(artifactDir, 'idempotency.json')
  }

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return
      throw new IdempotencyLedgerError(
        'IDEMPOTENCY_LEDGER_IO',
        `cannot read idempotency ledger ${this.filePath}: ${(error as Error).message}`,
        { cause: error },
      )
    }

    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (error) {
      throw new IdempotencyLedgerError(
        'IDEMPOTENCY_LEDGER_CORRUPT',
        `idempotency ledger is not valid JSON: ${(error as Error).message}`,
        { cause: error },
      )
    }

    // Legacy arrays from pre-versioned rc.2 sessions remain readable.
    const parsed = Array.isArray(json)
      ? RecordsSchema.safeParse(json)
      : LedgerDocumentSchema.safeParse(json)
    if (!parsed.success) {
      throw new IdempotencyLedgerError(
        'IDEMPOTENCY_LEDGER_CORRUPT',
        `idempotency ledger schema validation failed: ${parsed.error.issues
          .slice(0, 3)
          .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      )
    }

    const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.records
    this.records.clear()
    for (const entry of entries) this.records.set(entry.key, entry)
    this.dirty = false
  }

  /** Write + fsync a same-directory temp file, then atomically replace. */
  async flush(): Promise<void> {
    if (!this.dirty) return
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    try {
      await mkdir(this.artifactDir, { recursive: true })
      const handle = await open(tempPath, 'wx')
      try {
        await handle.writeFile(
          JSON.stringify({ version: 1, records: [...this.records.values()] }, null, 2),
          'utf8',
        )
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tempPath, this.filePath)
      this.dirty = false
    } catch (error) {
      await unlink(tempPath).catch(() => {})
      throw new IdempotencyLedgerError(
        'IDEMPOTENCY_LEDGER_IO',
        `cannot persist idempotency ledger ${this.filePath}: ${(error as Error).message}`,
        { cause: error },
      )
    }
  }

  /** Business identity, stable across call-id regeneration and object key order. */
  static computeOperationKey(input: {
    sessionId: string
    toolName: string
    args: unknown
  }): string {
    const canonical = stableJson([input.sessionId, input.toolName, input.args])
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  }

  /** Invocation identity used by tools whose legitimate repeats must execute. */
  static computeKey(input: {
    sessionId: string
    callId: string
    toolName: string
    args: unknown
  }): string {
    const canonical = stableJson([
      input.sessionId,
      input.callId,
      input.toolName,
      input.args,
    ])
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  }

  getStatus(key: string): ExecutionStatus | undefined {
    return this.records.get(key)?.status
  }

  getRecord(key: string): IdempotencyRecord | undefined {
    return this.records.get(key)
  }

  isCommitted(key: string): boolean {
    return this.records.get(key)?.status === 'committed'
  }

  isApplied(key: string): boolean {
    const status = this.records.get(key)?.status
    return status === 'committed' || status === 'resolved_applied'
  }

  needsInspection(key: string): boolean {
    const status = this.records.get(key)?.status
    return status === 'running' || status === 'unknown'
  }

  markRunning(key: string, callId: string, toolName: string, now: string): void {
    this.records.set(key, { key, callId, toolName, status: 'running', updatedAt: now })
    this.dirty = true
  }

  markCommitted(key: string, proof?: string, now?: string): void {
    const record = this.records.get(key)
    if (!record) return
    record.status = 'committed'
    record.proof = proof
    record.updatedAt = now ?? record.updatedAt
    this.dirty = true
  }

  markUnknown(key: string, now: string): void {
    const record = this.records.get(key)
    if (record?.status !== 'running') return
    record.status = 'unknown'
    record.updatedAt = now
    this.dirty = true
  }

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

  byStatus(status: ExecutionStatus): IdempotencyRecord[] {
    return [...this.records.values()].filter(record => record.status === status)
  }
}
