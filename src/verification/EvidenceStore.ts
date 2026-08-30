import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAbsolute, relative, resolve } from 'node:path'
import { CODE_BINDING_KINDS, type EvidenceKind, type EvidenceReceipt } from './types.js'
import type { Clock, IdGenerator } from '../core/runtimePrimitives.js'
import { redactDeep } from '../security/secrets.js'
import { MISSING_FILE_VERSION, readFileVersion } from '../workspace/FileVersion.js'

/**
 * Evidence receipts are issued by the runtime, never by model text.
 * The verifier (and the completion gate) may only reference receipts that
 * actually exist here. sha256 covers the full binding body — status,
 * criterionIds, taskId, workspaceRoot, fileVersions and session/run identity
 * in addition to invocation + observation — so ANY tampering with a key
 * field is detectable and reruns are possible.
 */
export class EvidenceStore {
  private readonly receipts = new Map<string, EvidenceReceipt>()
  /**
   * Workspace revision: the number of durable workspace-side-effect attempts
   * observed so far. It advances before execution, so a crash or unknown
   * outcome also invalidates older receipts.
   */
  private revision = 0
  private readonly changedPaths = new Set<string>()

  constructor(
    private readonly deps: {
      sessionId: string
      runId: string
      artifactDir: string
      clock: Clock
      ids: IdGenerator
      persist?: boolean
      workspaceRoot?: string
    },
  ) {}

  get workspaceRevision(): number {
    return this.revision
  }

  get workspaceRoot(): string | undefined {
    return this.deps.workspaceRoot
  }

  /** A workspace mutation may start: every unbound receipt ages. */
  bumpWorkspaceRevision(path?: string | readonly string[]): number {
    const paths = Array.isArray(path) ? path : path ? [path] : []
    for (const candidate of paths) {
      const resolved = this.resolveWorkspacePath(candidate)
      if (resolved) this.changedPaths.add(resolved)
    }
    return ++this.revision
  }

  /** Restore the counter from journal replay (mutation starts + legacy changes). */
  setWorkspaceRevision(revision: number, paths: string[] = []): void {
    this.revision = revision
    this.changedPaths.clear()
    for (const path of paths) {
      const resolved = this.resolveWorkspacePath(path)
      if (resolved) this.changedPaths.add(resolved)
    }
  }

  async record(input: {
    kind: EvidenceKind
    status: EvidenceReceipt['status']
    criterionIds?: string[]
    taskId?: string
    invocation: EvidenceReceipt['invocation']
    observation: EvidenceReceipt['observation']
    startedAt: string
    fileVersions?: Record<string, string>
    /** defaults to the store's current workspace revision */
    workspaceRevision?: number
  }): Promise<EvidenceReceipt> {
    // SANITIZING SINK: evidence captures command output verbatim, which may
    // contain credentials printed by failing processes — redact before the
    // receipt is hashed or persisted.
    input = redactDeep(input)
    const autoFileVersions =
      input.fileVersions === undefined && CODE_BINDING_KINDS.has(input.kind)
        ? await this.captureChangedFileVersions()
        : undefined
    const completedAt = this.deps.clock.isoNow()
    const receipt: EvidenceReceipt = {
      id: this.deps.ids.next('ev'),
      sessionId: this.deps.sessionId,
      runId: this.deps.runId,
      taskId: input.taskId,
      criterionIds: input.criterionIds ?? [],
      kind: input.kind,
      status: input.status,
      invocation: input.invocation,
      observation: input.observation,
      startedAt: input.startedAt,
      completedAt,
      sha256: '', // filled below — the hash covers the binding fields too
      workspaceRoot: this.deps.workspaceRoot,
      fileVersions:
        input.fileVersions ??
        (autoFileVersions && Object.keys(autoFileVersions).length > 0
          ? autoFileVersions
          : undefined),
      workspaceRevision: input.workspaceRevision ?? this.revision,
    }
    receipt.sha256 = createHash('sha256')
      .update(JSON.stringify(receiptHashBody(receipt)))
      .digest('hex')
    this.receipts.set(receipt.id, receipt)

    if (this.deps.persist !== false) {
      const dir = join(this.deps.artifactDir, 'evidence')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, `${receipt.id}.json`),
        JSON.stringify(receipt, null, 2),
        'utf8',
      )
    }
    return receipt
  }

  exists(id: string): boolean {
    return this.receipts.has(id)
  }

  get(id: string): EvidenceReceipt | undefined {
    return this.receipts.get(id)
  }

  list(): EvidenceReceipt[] {
    return [...this.receipts.values()]
  }

  /**
   * Restore during journal replay. Re-validates SHA-256 integrity;
   * tampered receipts are marked inconclusive rather than trusted.
   */
  restore(receipt: EvidenceReceipt): void {
    if (!verifySha256(receipt)) {
      // tampered: downgrade status so it cannot support a PASS verdict
      this.receipts.set(receipt.id, { ...receipt, status: 'inconclusive' })
    } else {
      this.receipts.set(receipt.id, receipt)
    }
  }

  private resolveWorkspacePath(path: string): string | undefined {
    const root = this.deps.workspaceRoot
    if (!root) return undefined
    const candidate = resolve(root, path)
    const rel = relative(resolve(root), candidate)
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
      return undefined
    }
    return candidate
  }

  private async captureChangedFileVersions(): Promise<Record<string, string>> {
    const versions: Record<string, string> = {}
    for (const path of this.changedPaths) {
      try {
        versions[path] = (await readFileVersion(path)).version
      } catch (error) {
        if (isMissing(error)) {
          versions[path] = MISSING_FILE_VERSION
        }
        // Other read errors remain fail-closed: do not claim a binding that
        // the runtime could not actually observe.
      }
    }
    return versions
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Canonical hash body of a receipt. Covers every binding field: changing
 * status, criterionIds, taskId, workspaceRoot, fileVersions, workspaceRevision
 * or session/run identity invalidates the signature.
 */
export function receiptHashBody(receipt: EvidenceReceipt): Record<string, unknown> {
  return {
    sessionId: receipt.sessionId,
    runId: receipt.runId,
    taskId: receipt.taskId ?? null,
    kind: receipt.kind,
    status: receipt.status,
    criterionIds: receipt.criterionIds,
    invocation: receipt.invocation,
    observation: receipt.observation,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    workspaceRoot: receipt.workspaceRoot ?? null,
    fileVersions: receipt.fileVersions ?? null,
    workspaceRevision: receipt.workspaceRevision ?? null,
  }
}

/** Re-compute the SHA-256 over the canonical body and compare. */
export function verifySha256(receipt: EvidenceReceipt): boolean {
  const expected = createHash('sha256')
    .update(JSON.stringify(receiptHashBody(receipt)))
    .digest('hex')
  return expected === receipt.sha256
}
