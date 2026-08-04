import { z } from 'zod'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { defineTool } from '../Tool.js'

const GlobInput = z
  .object({
    pattern: z.string().min(1),
    maxResults: z.number().int().positive().max(2000).default(500),
  })
  .strict()

export interface GlobOutput {
  pattern: string
  matches: string[]
  truncated: boolean
}

const IGNORED_DIRS = new Set([
  '.git', '.hg', 'node_modules', '.agent', 'dist', 'build', '.next', '.venv', '__pycache__',
])

/** Convert a glob pattern into a RegExp (supports **, *, ?). */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  let source = ''
  let i = 0
  while (i < normalized.length) {
    const char = normalized[i]!
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` matches zero or more path segments
        if (normalized[i + 2] === '/') {
          source += '(?:[^/]+/)*'
          i += 3
        } else {
          source += '.*'
          i += 2
        }
      } else {
        source += '[^/]*'
        i += 1
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      i += 1
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i += 1
  }
  return new RegExp(`^${source}$`)
}

async function walk(
  dir: string,
  root: string,
  out: string[],
  limit: number,
  signal: AbortSignal,
): Promise<void> {
  if (out.length > limit || signal.aborted) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  // deterministic ordering
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (out.length > limit || signal.aborted) return
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      await walk(full, root, out, limit, signal)
    } else {
      out.push(relative(root, full).split(sep).join('/'))
    }
  }
}

export const GlobTool = defineTool<z.infer<typeof GlobInput>, GlobOutput>({
  name: 'Glob',
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts"). Returns workspace-relative ' +
    'paths, sorted, capped by maxResults. Ignores .git/node_modules and similar.',
  inputSchema: GlobInput,
  maxResultChars: 30_000,
  readOnly: () => true,
  concurrency: () => 'shared',
  interruptBehavior: () => 'cancel',
  resources: () => [{ resource: 'workspace:*', mode: 'read' }],
  permission: async () => ({ behavior: 'allow' }),

  execute: async (input, ctx) => {
    const all: string[] = []
    await walk(ctx.workspaceRoot, ctx.workspaceRoot, all, 50_000, ctx.signal)
    const pattern = input.pattern.includes('/')
      ? input.pattern
      : `**/${input.pattern}`
    const regex = globToRegExp(pattern)
    const matches = all.filter(p => regex.test(p)).sort()
    return {
      data: {
        pattern: input.pattern,
        matches: matches.slice(0, input.maxResults),
        truncated: matches.length > input.maxResults,
      },
    }
  },

  serialize: output => ({
    kind: 'text',
    text:
      output.matches.length === 0
        ? `No files matched pattern: ${output.pattern}`
        : output.matches.join('\n') +
          (output.truncated ? '\n\n[result truncated]' : ''),
  }),
})
