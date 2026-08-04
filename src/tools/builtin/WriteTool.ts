import { z } from 'zod'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineTool } from '../Tool.js'
import { checkPath, checkPathReal } from '../../policy/pathPolicy.js'
import { computeVersion } from '../../workspace/FileVersion.js'

const WriteInput = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    overwrite: z.boolean().default(false),
  })
  .strict()

export interface WriteOutput {
  path: string
  created: boolean
  bytes: number
  newVersion: string
}

/** Create a new file, or overwrite only when explicitly requested. Atomic write. */
export const WriteTool = defineTool<z.infer<typeof WriteInput>, WriteOutput>({
  name: 'Write',
  description:
    'Create a new file with the given content. Overwriting an existing file ' +
    'requires overwrite=true explicitly. Parent directories are created.',
  inputSchema: WriteInput,
  maxResultChars: 10_000,
  readOnly: () => false,
  destructive: input => input.overwrite,
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
          hint: 'Write only inside the workspace, not to sensitive paths.',
        },
      }
    }
    // symlink/junction escape check: every existing ancestor must resolve
    // inside the workspace (nearest-existing-ancestor walk)
    const realCheck = await checkPathReal(input.path, ctx.workspaceRoot)
    if (!realCheck.ok) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `path rejected: ${realCheck.reason} (symlink or junction escapes the workspace)`,
          retryable: false,
          hint: 'Only paths that resolve inside the workspace are writable.',
        },
      }
    }
    if (!input.overwrite) {
      try {
        await access(check.resolved)
        return {
          ok: false,
          error: {
            code: 'SEMANTIC_VALIDATION_ERROR',
            message: `file already exists: ${input.path}`,
            retryable: true,
            hint: 'Set overwrite=true to replace it, or use Edit for partial changes.',
          },
        }
      } catch {
        // does not exist — fine
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
    let existed = true
    try {
      await access(resolved)
    } catch {
      existed = false
    }

    await mkdir(dirname(resolved), { recursive: true })
    const tempPath = join(
      dirname(resolved),
      `.agent-write-${ctx.callId.replace(/[^a-zA-Z0-9_-]/g, '_')}.tmp`,
    )
    await writeFile(tempPath, input.content, 'utf8')
    await rename(tempPath, resolved)

    return {
      data: {
        path: input.path,
        created: !existed,
        bytes: Buffer.byteLength(input.content, 'utf8'),
        newVersion: computeVersion(input.content),
      },
      facts: [
        {
          type: 'workspace.changed',
          path: input.path,
          change: existed ? 'modified' : 'created',
        },
      ],
      commitProof: computeVersion(input.content),
    }
  },

  serialize: output => ({
    kind: 'text',
    text:
      `${output.created ? 'Created' : 'Overwrote'} ${output.path} ` +
      `(${output.bytes} bytes)\nnewVersion: ${output.newVersion}`,
  }),
})
