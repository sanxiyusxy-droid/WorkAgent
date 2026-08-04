import { z } from 'zod'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { defineTool } from '../Tool.js'
import { globToRegExp } from './GlobTool.js'

const GrepInput = z
  .object({
    pattern: z.string().min(1),
    glob: z.string().optional(),
    fixed: z.boolean().default(false),
    caseInsensitive: z.boolean().default(false),
    maxMatches: z.number().int().positive().max(1000).default(200),
    contextLines: z.number().int().nonnegative().max(5).default(0),
  })
  .strict()

export interface GrepMatch {
  file: string
  line: number
  text: string
}

export interface GrepOutput {
  pattern: string
  matches: GrepMatch[]
  truncated: boolean
  filesScanned: number
}

const IGNORED_DIRS = new Set([
  '.git', '.hg', 'node_modules', '.agent', 'dist', 'build', '.next', '.venv', '__pycache__',
])

const MAX_FILE_BYTES = 2_000_000

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function collectFiles(
  dir: string,
  root: string,
  out: string[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || out.length > 20_000) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (signal.aborted || out.length > 20_000) return
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      await collectFiles(full, root, out, signal)
    } else {
      out.push(full)
    }
  }
}

export const GrepTool = defineTool<z.infer<typeof GrepInput>, GrepOutput>({
  name: 'Grep',
  description:
    'Search file contents with a regex (or fixed string with fixed=true). ' +
    'Optional glob filter, case-insensitive flag and context lines. ' +
    'Deterministic order, capped output, reports truncation.',
  inputSchema: GrepInput,
  maxResultChars: 30_000,
  readOnly: () => true,
  concurrency: () => 'shared',
  interruptBehavior: () => 'cancel',
  resources: () => [{ resource: 'workspace:*', mode: 'read' }],
  permission: async () => ({ behavior: 'allow' }),

  validate: async input => {
    if (!input.fixed) {
      try {
        new RegExp(input.pattern)
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'INPUT_VALIDATION_ERROR',
            message: `invalid regex: ${(error as Error).message}`,
            retryable: true,
            hint: 'Escape special characters or set fixed=true for literal search.',
          },
        }
      }
    }
    return { ok: true }
  },

  execute: async (input, ctx) => {
    const files: string[] = []
    await collectFiles(ctx.workspaceRoot, ctx.workspaceRoot, files, ctx.signal)

    const globRegex = input.glob ? globToRegExp(
      input.glob.includes('/') ? input.glob : `**/${input.glob}`,
    ) : null

    const flags = input.caseInsensitive ? 'i' : ''
    const regex = input.fixed
      ? new RegExp(escapeRegExp(input.pattern), flags)
      : new RegExp(input.pattern, flags)

    const matches: GrepMatch[] = []
    let truncated = false
    let filesScanned = 0

    for (const file of files) {
      if (ctx.signal.aborted || matches.length >= input.maxMatches) {
        truncated = matches.length >= input.maxMatches
        break
      }
      const rel = relative(ctx.workspaceRoot, file).split(sep).join('/')
      if (globRegex && !globRegex.test(rel)) continue

      let content: string
      try {
        const buffer = await readFile(file)
        if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) continue
        content = buffer.toString('utf8')
      } catch {
        continue
      }
      filesScanned += 1
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= input.maxMatches) {
          truncated = true
          break
        }
        if (regex.test(lines[i]!)) {
          const from = Math.max(0, i - input.contextLines)
          const to = Math.min(lines.length - 1, i + input.contextLines)
          for (let j = from; j <= to; j++) {
            matches.push({ file: rel, line: j + 1, text: lines[j]! })
          }
        }
      }
    }

    return {
      data: { pattern: input.pattern, matches, truncated, filesScanned },
    }
  },

  serialize: output => ({
    kind: 'text',
    text:
      output.matches.length === 0
        ? `No matches for: ${output.pattern} (${output.filesScanned} files scanned)`
        : output.matches
            .map(m => `${m.file}:${m.line}: ${m.text}`)
            .join('\n') + (output.truncated ? '\n\n[result truncated]' : ''),
  }),
})
