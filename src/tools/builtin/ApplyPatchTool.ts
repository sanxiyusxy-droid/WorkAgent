import { z } from 'zod'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineTool } from '../Tool.js'
import { checkPath, checkPathReal } from '../../policy/pathPolicy.js'
import { computeVersion, readFileVersion } from '../../workspace/FileVersion.js'
import { matchForReplace } from '../../workspace/lineEndings.js'
import { InvariantError } from '../../core/messages.js'

const PatchEdit = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  expectedVersion: z.string().min(1),
  replaceAll: z.boolean().default(false),
})

const PatchCreate = z.object({
  path: z.string().min(1),
  content: z.string(),
})

const ApplyPatchInput = z
  .object({
    edits: z.array(PatchEdit).default([]),
    creates: z.array(PatchCreate).default([]),
  })
  .strict()

export interface ApplyPatchOutput {
  applied: Array<{ path: string; action: 'edited' | 'created'; newVersion: string }>
}

interface PlannedWrite {
  resolved: string
  displayPath: string
  action: 'edited' | 'created'
  newContent: string
  backup: string | null // null = file did not exist
}

/**
 * Multi-file patch with transactional boundary (guide §6.5):
 * - parse and validate every target BEFORE any write
 * - keep backups of old contents
 * - any hunk failure -> nothing is written
 * - failure during the write phase -> roll back from backups
 * - rollback failure is a system-level invariant violation
 */
export const ApplyPatchTool = defineTool<
  z.infer<typeof ApplyPatchInput>,
  ApplyPatchOutput
>({
  name: 'ApplyPatch',
  description:
    'Apply a multi-file patch atomically: exact-text edits (with expectedVersion ' +
    'preconditions from Read) plus new file creations. Either every file is ' +
    'written or none is.',
  inputSchema: ApplyPatchInput,
  maxResultChars: 20_000,
  readOnly: () => false,
  concurrency: () => 'exclusive',
  interruptBehavior: () => 'block',
  resources: () => [{ resource: 'workspace:*', mode: 'write' }],
  permission: async () => ({ behavior: 'ask' }),

  validate: async (input, ctx) => {
    if (input.edits.length === 0 && input.creates.length === 0) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: 'patch is empty',
          retryable: true,
        },
      }
    }
    const seen = new Set<string>()
    for (const target of [...input.edits, ...input.creates]) {
      const check = checkPath(target.path, ctx.workspaceRoot)
      if (!check.ok) {
        return {
          ok: false,
          error: {
            code: 'SEMANTIC_VALIDATION_ERROR',
            message: `path rejected (${check.reason}): ${target.path}`,
            retryable: false,
          },
        }
      }
      // symlink/junction escape check for every patch target
      const realCheck = await checkPathReal(target.path, ctx.workspaceRoot)
      if (!realCheck.ok) {
        return {
          ok: false,
          error: {
            code: 'SEMANTIC_VALIDATION_ERROR',
            message: `path rejected (${realCheck.reason}): ${target.path} escapes the workspace via symlink/junction`,
            retryable: false,
          },
        }
      }
      if (seen.has(check.resolved)) {
        return {
          ok: false,
          error: {
            code: 'SEMANTIC_VALIDATION_ERROR',
            message: `duplicate target in patch: ${target.path}`,
            retryable: true,
          },
        }
      }
      seen.add(check.resolved)
    }
    return { ok: true }
  },

  execute: async (input, ctx) => {
    // ---- phase 1: validate everything, plan writes, no side effects ----
    const planned: PlannedWrite[] = []

    for (const edit of input.edits) {
      // re-check immediately before I/O to narrow the TOCTOU window
      const recheck = await checkPathReal(edit.path, ctx.workspaceRoot)
      if (!recheck.ok) {
        throw Object.assign(
          new Error(`path rejected at open time (${recheck.reason}): ${edit.path}`),
          { toolErrorCode: 'SEMANTIC_VALIDATION_ERROR' },
        )
      }
      const resolved = recheck.resolved
      let current: string
      try {
        current = (await readFile(resolved)).toString('utf8')
      } catch {
        throw Object.assign(new Error(`file not found: ${edit.path}`), {
          toolErrorCode: 'SEMANTIC_VALIDATION_ERROR',
        })
      }
      const version = computeVersion(current)
      if (version !== edit.expectedVersion) {
        throw Object.assign(
          new Error(
            `version conflict on ${edit.path}: expected ${edit.expectedVersion}, actual ${version}`,
          ),
          { toolErrorCode: 'FILE_VERSION_CONFLICT' },
        )
      }
      // line-ending tolerant match: models emit LF, files on Windows are CRLF
      const match = matchForReplace(current, edit.oldText, edit.newText)
      if (match.occurrences === 0) {
        throw Object.assign(
          new Error(`oldText not found in ${edit.path}`),
          { toolErrorCode: 'SEMANTIC_VALIDATION_ERROR' },
        )
      }
      if (!edit.replaceAll && match.occurrences > 1) {
        throw Object.assign(
          new Error(`oldText ambiguous in ${edit.path} (${match.occurrences} matches)`),
          { toolErrorCode: 'SEMANTIC_VALIDATION_ERROR' },
        )
      }
      planned.push({
        resolved,
        displayPath: edit.path,
        action: 'edited',
        newContent: edit.replaceAll
          ? current.split(match.oldText).join(match.newText)
          : current.replace(match.oldText, match.newText),
        backup: current,
      })
    }

    for (const create of input.creates) {
      const recheck = await checkPathReal(create.path, ctx.workspaceRoot)
      if (!recheck.ok) {
        throw Object.assign(
          new Error(`path rejected at open time (${recheck.reason}): ${create.path}`),
          { toolErrorCode: 'SEMANTIC_VALIDATION_ERROR' },
        )
      }
      const resolved = recheck.resolved
      let exists = false
      try {
        await readFile(resolved)
        exists = true
      } catch {
        // ok — does not exist
      }
      if (exists) {
        throw Object.assign(
          new Error(`file already exists: ${create.path} (use edits to modify)`),
          { toolErrorCode: 'SEMANTIC_VALIDATION_ERROR' },
        )
      }
      planned.push({
        resolved,
        displayPath: create.path,
        action: 'created',
        newContent: create.content,
        backup: null,
      })
    }

    // ---- phase 2: write all files; roll back from backups on failure ----
    const written: PlannedWrite[] = []
    try {
      for (const write of planned) {
        const { mkdir } = await import('node:fs/promises')
        await mkdir(dirname(write.resolved), { recursive: true })
        const temp = join(
          dirname(write.resolved),
          `.agent-patch-${ctx.callId.replace(/[^a-zA-Z0-9_-]/g, '_')}.tmp`,
        )
        await writeFile(temp, write.newContent, 'utf8')
        await rename(temp, write.resolved)
        written.push(write)
      }
    } catch (error) {
      // rollback everything already written
      try {
        const { rm } = await import('node:fs/promises')
        for (const write of written.reverse()) {
          if (write.backup === null) {
            await rm(write.resolved, { force: true })
          } else {
            await writeFile(write.resolved, write.backup, 'utf8')
          }
        }
      } catch (rollbackError) {
        // rollback failure is system-level: the loop must terminate
        throw new InvariantError(
          'applypatch_rollback_failed',
          `rollback failed after partial patch: ${(rollbackError as Error).message}`,
        )
      }
      throw Object.assign(
        new Error(`patch write failed, rolled back: ${(error as Error).message}`),
        { toolErrorCode: 'INTERNAL_TOOL_ERROR' },
      )
    }

    return {
      data: {
        applied: planned.map(write => ({
          path: write.displayPath,
          action: write.action,
          newVersion: computeVersion(write.newContent),
        })),
      },
      facts: planned.map(write => ({
        type: 'workspace.changed' as const,
        path: write.displayPath,
        change: write.action === 'created' ? ('created' as const) : ('modified' as const),
      })),
      // combined fingerprint of every applied file version
      commitProof: planned
        .map(write => `${write.displayPath}@${computeVersion(write.newContent)}`)
        .join(';'),
    }
  },

  serialize: output => ({
    kind: 'text',
    text:
      `Patch applied to ${output.applied.length} file(s):\n` +
      output.applied
        .map(f => `  ${f.action}: ${f.path} -> ${f.newVersion}`)
        .join('\n'),
  }),

  // Adjudication probe: the commit proof is `path@version;...` for every
  // patched file — ALL files must still match for the patch to count as
  // applied; any divergence re-opens the operation for re-execution.
  inspectOutcome: async (_input, ctx, record) => {
    if (!record.proof) return { applied: false, detail: 'no commit proof recorded' }
    for (const entry of record.proof.split(';')) {
      const separator = entry.lastIndexOf('@')
      if (separator < 0) return { applied: false, detail: `malformed proof entry: ${entry}` }
      const path = entry.slice(0, separator)
      const expected = entry.slice(separator + 1)
      const check = await checkPathReal(path, ctx.workspaceRoot)
      if (!check.ok) return { applied: false, detail: `path rejected: ${check.reason}` }
      try {
        const { version } = await readFileVersion(check.resolved)
        if (version !== expected) {
          return { applied: false, detail: `${path} differs from commit proof` }
        }
      } catch {
        return { applied: false, detail: `${path} no longer exists` }
      }
    }
    return { applied: true, detail: 'all patched files match their commit proofs' }
  },
})
