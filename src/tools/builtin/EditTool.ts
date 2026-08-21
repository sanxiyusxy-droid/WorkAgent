import { z } from 'zod'
import { rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineTool } from '../Tool.js'
import { checkPath, checkPathReal } from '../../policy/pathPolicy.js'
import { computeVersion, readFileVersion } from '../../workspace/FileVersion.js'
import { matchForReplace } from '../../workspace/lineEndings.js'

const EditInput = z
  .object({
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    expectedVersion: z.string().min(1),
    replaceAll: z.boolean().default(false),
  })
  .strict()

export interface EditOutput {
  path: string
  oldVersion: string
  newVersion: string
  replacements: number
}

/**
 * Optimistic-concurrency Edit:
 * 1. re-read current file and compute version
 * 2. mismatch -> FILE_VERSION_CONFLICT (never trust "I read it earlier")
 * 3. replaceAll=false requires exactly one occurrence
 * 4. write temp file in same dir, then atomic rename
 */
export const EditTool = defineTool<z.infer<typeof EditInput>, EditOutput>({
  name: 'Edit',
  description:
    'Replace exact text in a file. Requires expectedVersion from a previous Read. ' +
    'Fails with FILE_VERSION_CONFLICT if the file changed since that Read. ' +
    'oldText must match exactly once unless replaceAll=true.',
  inputSchema: EditInput,
  maxResultChars: 20_000,
  readOnly: () => false,
  concurrency: () => 'exclusive',
  interruptBehavior: () => 'block',
  resources: (input, ctx) => [
    { resource: `file:${checkPath(input.path, ctx.workspaceRoot).resolved}`, mode: 'write' },
  ],
  permission: async () => ({ behavior: 'ask' }),

  validate: async (input, ctx) => {
    const check = checkPath(input.path, ctx.workspaceRoot)
    if (!check.ok) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `path rejected: ${check.reason}`,
          retryable: false,
          hint: 'Edit only files inside the workspace, not sensitive paths.',
        },
      }
    }
    // symlink/junction escape check: a link inside the workspace that points
    // outside must never be editable
    const realCheck = await checkPathReal(input.path, ctx.workspaceRoot)
    if (!realCheck.ok) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `path rejected: ${realCheck.reason} (symlink or junction escapes the workspace)`,
          retryable: false,
          hint: 'Only paths that resolve inside the workspace are editable.',
        },
      }
    }
    if (input.oldText === input.newText) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: 'oldText and newText are identical',
          retryable: true,
        },
      }
    }
    return { ok: true }
  },

  execute: async (input, ctx) => {
    // re-check immediately before I/O to narrow the TOCTOU window
    const recheck = await checkPathReal(input.path, ctx.workspaceRoot)
    if (!recheck.ok) {
      throw Object.assign(
        new Error(`path rejected at open time: ${recheck.reason}`),
        { toolErrorCode: 'SEMANTIC_VALIDATION_ERROR' },
      )
    }
    const resolved = recheck.resolved

    let current: { content: string; version: string }
    try {
      current = await readFileVersion(resolved)
    } catch {
      throw Object.assign(new Error(`file not found: ${input.path}`), {
        toolErrorCode: 'SEMANTIC_VALIDATION_ERROR',
      })
    }

    if (current.version !== input.expectedVersion) {
      throw Object.assign(
        new Error(
          `file version conflict: expected ${input.expectedVersion}, ` +
            `actual ${current.version}. Re-read the file before editing.`,
        ),
        { toolErrorCode: 'FILE_VERSION_CONFLICT' },
      )
    }

    // line-ending tolerant match: models emit LF, files on Windows are CRLF
    const match = matchForReplace(current.content, input.oldText, input.newText)
    if (match.occurrences === 0) {
      throw Object.assign(
        new Error('oldText not found in file. Re-read and copy the exact text.'),
        { toolErrorCode: 'SEMANTIC_VALIDATION_ERROR' },
      )
    }
    if (!input.replaceAll && match.occurrences > 1) {
      throw Object.assign(
        new Error(
          `oldText matches ${match.occurrences} times; provide more context or set replaceAll=true.`,
        ),
        { toolErrorCode: 'SEMANTIC_VALIDATION_ERROR' },
      )
    }

    const updated = input.replaceAll
      ? current.content.split(match.oldText).join(match.newText)
      : current.content.replace(match.oldText, match.newText)

    // atomic write: temp file in same directory, flush, rename
    const tempPath = join(
      dirname(resolved),
      `.agent-edit-${ctx.callId.replace(/[^a-zA-Z0-9_-]/g, '_')}.tmp`,
    )
    await writeFile(tempPath, updated, 'utf8')
    await rename(tempPath, resolved)

    return {
      data: {
        path: input.path,
        oldVersion: current.version,
        newVersion: computeVersion(updated),
        replacements: input.replaceAll ? match.occurrences : 1,
      },
      facts: [{ type: 'workspace.changed', path: input.path, change: 'modified' }],
      commitProof: computeVersion(updated),
    }
  },

  postconditions: async (_input, output, ctx) => {
    const check = await checkPathReal(output.path, ctx.workspaceRoot)
    if (!check.ok) {
      return [{ id: 'new-version-committed', passed: false, detail: check.reason }]
    }
    try {
      const current = await readFileVersion(check.resolved)
      return [{
        id: 'new-version-committed',
        passed: current.version === output.newVersion,
        detail: current.version,
      }]
    } catch {
      return [{ id: 'new-version-committed', passed: false, detail: 'file disappeared' }]
    }
  },

  observe: async (_input, output) => ({
    summary: `Edited ${output.path} with ${output.replacements} replacement(s)`,
    fields: {
      path: output.path,
      oldVersion: output.oldVersion,
      newVersion: output.newVersion,
      replacements: output.replacements,
    },
  }),

  serialize: output => ({
    kind: 'text',
    text:
      `Edited ${output.path} (${output.replacements} replacement${output.replacements > 1 ? 's' : ''})\n` +
      `oldVersion: ${output.oldVersion}\nnewVersion: ${output.newVersion}`,
  }),

  // Adjudication probe: the commit proof is the content hash of the file
  // AFTER the edit — identical live content means the edit is still applied.
  inspectOutcome: async (input, ctx, record) => {
    if (!record.proof) return { applied: false, detail: 'no commit proof recorded' }
    const check = await checkPathReal(input.path, ctx.workspaceRoot)
    if (!check.ok) return { applied: false, detail: `path rejected: ${check.reason}` }
    try {
      const { version } = await readFileVersion(check.resolved)
      return version === record.proof
        ? { applied: true, detail: `file content matches commit proof ${record.proof}` }
        : { applied: false, detail: 'file content differs from commit proof' }
    } catch {
      return { applied: false, detail: 'target file no longer exists' }
    }
  },
})
