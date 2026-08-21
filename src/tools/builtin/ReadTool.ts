import { z } from 'zod'
import { stat } from 'node:fs/promises'
import { defineTool } from '../Tool.js'
import { checkPathReal, checkReadPath } from '../../policy/pathPolicy.js'
import { readFileVersion } from '../../workspace/FileVersion.js'

const ReadInput = z
  .object({
    path: z.string().min(1),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(2000).default(400),
  })
  .strict()

export interface ReadOutput {
  path: string
  fileVersion: string
  totalLines: number
  offset: number
  returnedLines: number
  truncated: boolean
  content: string
}

export const ReadTool = defineTool<z.infer<typeof ReadInput>, ReadOutput>({
  name: 'Read',
  description:
    'Read a text file from the workspace with line numbers. Supports offset/limit paging. ' +
    'Returns fileVersion which is required by Edit as a precondition.',
  inputSchema: ReadInput,
  maxResultChars: 200_000, // Read pages by itself; never externalized
  readOnly: () => true,
  concurrency: () => 'shared',
  interruptBehavior: () => 'cancel',
  resources: (input, ctx) => [
    { resource: `file:${checkReadPath(input.path, ctx.workspaceRoot).resolved}`, mode: 'read' },
  ],
  permission: async () => ({ behavior: 'allow' }),

  validate: async (input, ctx) => {
    const check = checkReadPath(input.path, ctx.workspaceRoot)
    if (!check.ok) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `path rejected: ${check.reason}`,
          retryable: false,
          hint: 'Use a path inside the workspace root.',
        },
      }
    }
    // symlink/junction escape check (lexical pass already succeeded)
    const realCheck = await checkPathReal(input.path, ctx.workspaceRoot, { read: true })
    if (!realCheck.ok) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `path rejected: ${realCheck.reason} (symlink or junction escapes the workspace)`,
          retryable: false,
          hint: 'Only paths that resolve inside the workspace are readable.',
        },
      }
    }
    try {
      const info = await stat(check.resolved)
      if (info.isDirectory()) {
        return {
          ok: false,
          error: {
            code: 'SEMANTIC_VALIDATION_ERROR',
            message: `${input.path} is a directory, not a file`,
            retryable: true,
            hint: 'Use Glob to list directory contents.',
          },
        }
      }
    } catch {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `file not found: ${input.path}`,
          retryable: true,
          hint: 'Use Glob to locate the file first.',
        },
      }
    }
    return { ok: true }
  },

  execute: async (input, ctx) => {
    // re-check immediately before I/O to narrow the TOCTOU window
    const recheck = await checkPathReal(input.path, ctx.workspaceRoot, { read: true })
    if (!recheck.ok) {
      throw Object.assign(
        new Error(`path rejected at open time: ${recheck.reason}`),
        { toolErrorCode: 'SEMANTIC_VALIDATION_ERROR' },
      )
    }
    const resolved = recheck.resolved
    const { content, version } = await readFileVersion(resolved)
    const lines = content.split('\n')
    const slice = lines.slice(input.offset, input.offset + input.limit)
    const numbered = slice
      .map((line, i) => `${String(input.offset + i + 1).padStart(6)}\u2192${line}`)
      .join('\n')
    return {
      data: {
        path: input.path,
        fileVersion: version,
        totalLines: lines.length,
        offset: input.offset,
        returnedLines: slice.length,
        truncated: input.offset + slice.length < lines.length,
        content: numbered,
      },
    }
  },

  postconditions: async (_input, output, ctx) => {
    const check = await checkPathReal(output.path, ctx.workspaceRoot, { read: true })
    if (!check.ok) {
      return [{ id: 'file-version-observed', passed: false, detail: check.reason }]
    }
    try {
      const current = await readFileVersion(check.resolved)
      return [{
        id: 'file-version-observed',
        passed: current.version === output.fileVersion,
        detail: current.version,
      }]
    } catch {
      return [{ id: 'file-version-observed', passed: false, detail: 'file disappeared' }]
    }
  },

  observe: async (_input, output) => ({
    summary: `Read ${output.returnedLines} of ${output.totalLines} lines from ${output.path}`,
    fields: {
      path: output.path,
      fileVersion: output.fileVersion,
      returnedLines: output.returnedLines,
      totalLines: output.totalLines,
      truncated: output.truncated,
    },
  }),

  serialize: output => ({
    kind: 'text',
    text:
      `file: ${output.path}\nfileVersion: ${output.fileVersion}\n` +
      `lines ${output.offset + 1}-${output.offset + output.returnedLines} of ${output.totalLines}` +
      (output.truncated ? ' (truncated, use offset to continue)' : '') +
      `\n\n${output.content}`,
  }),
})
