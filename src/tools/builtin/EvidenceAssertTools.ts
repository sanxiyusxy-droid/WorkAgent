import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { z } from 'zod'
import { checkPathReal, checkReadPath } from '../../policy/pathPolicy.js'
import type { AcceptanceCriterion } from '../../planning/types.js'
import { MISSING_FILE_VERSION, readFileVersion } from '../../workspace/FileVersion.js'
import type { EvidenceKind, EvidenceReceipt } from '../../verification/types.js'
import { defineTool, type ToolContext, type ValidationResult } from '../Tool.js'

const execFileAsync = promisify(execFile)

const CriterionIds = z.array(z.string().min(1)).min(1).max(50)
const BoundedSnippets = z.array(z.string().min(1).max(10_000)).max(50).default([])

function criterionValidation(
  criterionIds: string[],
  kind: EvidenceKind,
  ctx: ToolContext,
): ValidationResult {
  const plan = ctx.services.plans?.lastApproved()
  if (!plan) {
    return {
      ok: false,
      error: {
        code: 'SEMANTIC_VALIDATION_ERROR',
        message: 'evidence can only be issued for an approved plan',
        retryable: false,
        hint: 'Approve a persisted plan before collecting acceptance evidence.',
      },
    }
  }
  if (new Set(criterionIds).size !== criterionIds.length) {
    return {
      ok: false,
      error: {
        code: 'SEMANTIC_VALIDATION_ERROR',
        message: 'criterionIds contains duplicates',
        retryable: true,
      },
    }
  }
  const byId = new Map(plan.acceptanceCriteria.map(criterion => [criterion.id, criterion]))
  const missing = criterionIds.filter(id => !byId.has(id))
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'SEMANTIC_VALIDATION_ERROR',
        message: `criteria are not in the approved plan: ${missing.join(', ')}`,
        retryable: true,
      },
    }
  }
  const wrongKind = criterionIds
    .map(id => byId.get(id)!)
    .filter(criterion => criterion.evidenceKind !== kind)
  if (wrongKind.length > 0) {
    return {
      ok: false,
      error: {
        code: 'SEMANTIC_VALIDATION_ERROR',
        message:
          `criterion evidence kind mismatch: ${wrongKind
            .map(criterion => `${criterion.id} requires ${criterion.evidenceKind}`)
            .join(', ')}`,
        retryable: true,
      },
    }
  }
  if (!ctx.services.evidence) {
    return {
      ok: false,
      error: {
        code: 'SEMANTIC_VALIDATION_ERROR',
        message: 'evidence store is not configured',
        retryable: false,
      },
    }
  }
  return { ok: true }
}

function criteriaFor(
  criterionIds: string[],
  ctx: ToolContext,
): AcceptanceCriterion[] {
  const plan = ctx.services.plans!.lastApproved()!
  const ids = new Set(criterionIds)
  return plan.acceptanceCriteria.filter(criterion => ids.has(criterion.id))
}

function isMissing(error: unknown): boolean {
  return error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function bindCurrentPaths(paths: string[]): Promise<Record<string, string>> {
  const bindings: Record<string, string> = {}
  for (const path of paths) {
    try {
      bindings[path] = (await readFileVersion(path)).version
    } catch (error) {
      if (!isMissing(error)) throw error
      bindings[path] = MISSING_FILE_VERSION
    }
  }
  return bindings
}

export interface AssertionEvidenceOutput {
  passed: boolean
  evidenceId: string
  summary: string
}

const FileAssertInput = z.object({
  path: z.string().min(1),
  criterionIds: CriterionIds,
  expected: z.object({
    exists: z.boolean().optional(),
    equals: z.string().max(100_000).optional(),
    contains: BoundedSnippets,
    notContains: BoundedSnippets,
  }).strict(),
}).strict()

/** Runtime-observed assertions over one workspace file. */
export const FileAssertTool = defineTool<
  z.infer<typeof FileAssertInput>,
  AssertionEvidenceOutput
>({
  name: 'FileAssert',
  description:
    'Collect file_assertion evidence for approved criteria. Checks actual file ' +
    'existence/content and signs a receipt bound to the observed file version. ' +
    'Provide at least one of expected.exists/equals/contains/notContains.',
  inputSchema: FileAssertInput,
  maxResultChars: 8_000,
  readOnly: () => true,
  concurrency: () => 'shared',
  interruptBehavior: () => 'cancel',
  resources: (input, ctx) => [
    { resource: `file:${checkReadPath(input.path, ctx.workspaceRoot).resolved}`, mode: 'read' },
  ],
  permission: async () => ({ behavior: 'allow' }),

  validate: async (input, ctx) => {
    const criteria = criterionValidation(input.criterionIds, 'file_assertion', ctx)
    if (!criteria.ok) return criteria
    const expected = input.expected
    if (
      expected.exists === undefined &&
      expected.equals === undefined &&
      expected.contains.length === 0 &&
      expected.notContains.length === 0
    ) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: 'FileAssert requires at least one expected condition',
          retryable: true,
        },
      }
    }
    const lexical = checkReadPath(input.path, ctx.workspaceRoot)
    if (!lexical.ok) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `path rejected: ${lexical.reason}`,
          retryable: false,
        },
      }
    }
    const real = await checkPathReal(input.path, ctx.workspaceRoot, { read: true })
    if (!real.ok) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: `path rejected: ${real.reason}`,
          retryable: false,
        },
      }
    }
    return { ok: true }
  },

  execute: async (input, ctx) => {
    const startedAt = ctx.clock.isoNow()
    const recheck = await checkPathReal(input.path, ctx.workspaceRoot, { read: true })
    if (!recheck.ok) {
      throw Object.assign(new Error(`path rejected at assertion time: ${recheck.reason}`), {
        toolErrorCode: 'SEMANTIC_VALIDATION_ERROR',
      })
    }

    let exists = true
    let content = ''
    let version = MISSING_FILE_VERSION
    try {
      const current = await readFileVersion(recheck.resolved)
      content = current.content
      version = current.version
    } catch (error) {
      if (!isMissing(error)) throw error
      exists = false
    }

    const checks: Array<{ label: string; passed: boolean }> = []
    if (input.expected.exists !== undefined) {
      checks.push({ label: `exists=${input.expected.exists}`, passed: exists === input.expected.exists })
    }
    if (input.expected.equals !== undefined) {
      checks.push({ label: 'content equals expected text', passed: exists && content === input.expected.equals })
    }
    for (const snippet of input.expected.contains) {
      checks.push({ label: `contains ${JSON.stringify(snippet)}`, passed: exists && content.includes(snippet) })
    }
    for (const snippet of input.expected.notContains) {
      checks.push({ label: `does not contain ${JSON.stringify(snippet)}`, passed: !exists || !content.includes(snippet) })
    }
    const passed = checks.every(check => check.passed)
    const summary = checks
      .map(check => `${check.passed ? 'PASS' : 'FAIL'} ${check.label}`)
      .join('; ')
    const receipt = await ctx.services.evidence!.record({
      kind: 'file_assertion',
      status: passed ? 'passed' : 'failed',
      criterionIds: input.criterionIds,
      invocation: {
        tool: 'FileAssert',
        normalizedInput: input,
        cwd: ctx.workspaceRoot,
      },
      observation: {
        outputPreview: `${input.path}: ${summary}; version=${version}`.slice(0, 1_000),
      },
      startedAt,
      fileVersions: { [recheck.resolved]: version },
    })
    return {
      data: { passed, evidenceId: receipt.id, summary },
      facts: [{ type: 'evidence.recorded', receipt }],
    }
  },

  serialize: output => ({
    kind: 'text',
    text: `${output.passed ? 'PASS' : 'FAIL'} FileAssert: ${output.summary}\nevidenceId: ${output.evidenceId}`,
  }),
})

const DiffAssertInput = z.object({
  paths: z.array(z.string().min(1)).min(1).max(50),
  criterionIds: CriterionIds,
  expectedAdded: BoundedSnippets,
  expectedRemoved: BoundedSnippets,
}).strict()

async function gitOutput(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1_000_000,
    windowsHide: true,
    signal,
  })
  return String(result.stdout)
}

/** Runtime-observed assertion over the real Git diff from HEAD. */
export const DiffAssertTool = defineTool<
  z.infer<typeof DiffAssertInput>,
  AssertionEvidenceOutput
>({
  name: 'DiffAssert',
  description:
    'Collect diff_assertion evidence for approved criteria from the actual Git ' +
    'working-tree diff against HEAD, including untracked files. Optionally ' +
    'require added/removed line snippets. Fails honestly outside a Git repository.',
  inputSchema: DiffAssertInput,
  maxResultChars: 8_000,
  readOnly: () => true,
  concurrency: () => 'shared',
  interruptBehavior: () => 'cancel',
  resources: () => [{ resource: 'workspace:*', mode: 'read' }],
  permission: async () => ({ behavior: 'allow' }),

  validate: async (input, ctx) => {
    const criteria = criterionValidation(input.criterionIds, 'diff_assertion', ctx)
    if (!criteria.ok) return criteria
    if (new Set(input.paths).size !== input.paths.length) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: 'paths contains duplicates',
          retryable: true,
        },
      }
    }
    for (const path of input.paths) {
      const check = await checkPathReal(path, ctx.workspaceRoot, { read: true })
      if (!check.ok) {
        return {
          ok: false,
          error: {
            code: 'SEMANTIC_VALIDATION_ERROR',
            message: `path rejected (${check.reason}): ${path}`,
            retryable: false,
          },
        }
      }
    }
    return { ok: true }
  },

  execute: async (input, ctx) => {
    const startedAt = ctx.clock.isoNow()
    const resolvedPaths: string[] = []
    const relativePaths: string[] = []
    for (const path of input.paths) {
      const check = await checkPathReal(path, ctx.workspaceRoot, { read: true })
      if (!check.ok) {
        throw Object.assign(new Error(`path rejected at assertion time: ${check.reason}`), {
          toolErrorCode: 'SEMANTIC_VALIDATION_ERROR',
        })
      }
      resolvedPaths.push(check.resolved)
      relativePaths.push(relative(ctx.workspaceRoot, check.resolved).replace(/\\/g, '/'))
    }

    const pathspecs = relativePaths.map(path => `:(literal)${path}`)
    let diff = ''
    let gitFailure: string | undefined
    try {
      diff = await gitOutput(
        ctx.workspaceRoot,
        ['diff', '--no-ext-diff', '--no-color', '--unified=0', 'HEAD', '--', ...pathspecs],
        ctx.signal,
      )
      const untrackedRaw = await gitOutput(
        ctx.workspaceRoot,
        ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs],
        ctx.signal,
      )
      for (const untracked of untrackedRaw.split('\0').filter(Boolean)) {
        const index = relativePaths.indexOf(untracked.replace(/\\/g, '/'))
        if (index < 0) continue
        const content = await readFile(resolvedPaths[index]!, 'utf8')
        diff += `\ndiff --git a/${untracked} b/${untracked}\nnew file mode 100644\n`
        diff += content.split(/\r?\n/).map(line => `+${line}`).join('\n')
      }
    } catch (error) {
      gitFailure = (error as Error).message
    }

    const addedLines = diff
      .split(/\r?\n/)
      .filter(line => line.startsWith('+') && !line.startsWith('+++'))
      .map(line => line.slice(1))
    const removedLines = diff
      .split(/\r?\n/)
      .filter(line => line.startsWith('-') && !line.startsWith('---'))
      .map(line => line.slice(1))
    const checks: Array<{ label: string; passed: boolean }> = [
      { label: 'working tree has a diff from HEAD', passed: diff.trim().length > 0 },
      ...input.expectedAdded.map(snippet => ({
        label: `added lines contain ${JSON.stringify(snippet)}`,
        passed: addedLines.some(line => line.includes(snippet)),
      })),
      ...input.expectedRemoved.map(snippet => ({
        label: `removed lines contain ${JSON.stringify(snippet)}`,
        passed: removedLines.some(line => line.includes(snippet)),
      })),
    ]
    const passed = !gitFailure && checks.every(check => check.passed)
    const summary = gitFailure
      ? `INCONCLUSIVE Git diff unavailable: ${gitFailure}`
      : checks.map(check => `${check.passed ? 'PASS' : 'FAIL'} ${check.label}`).join('; ')
    const receipt = await ctx.services.evidence!.record({
      kind: 'diff_assertion',
      status: gitFailure ? 'inconclusive' : passed ? 'passed' : 'failed',
      criterionIds: input.criterionIds,
      invocation: {
        tool: 'DiffAssert',
        normalizedInput: { ...input, base: 'HEAD' },
        cwd: ctx.workspaceRoot,
      },
      observation: {
        outputPreview:
          `${summary}; addedLines=${addedLines.length}; removedLines=${removedLines.length}`.slice(0, 1_000),
      },
      startedAt,
      fileVersions: await bindCurrentPaths(resolvedPaths),
    })
    return {
      data: { passed, evidenceId: receipt.id, summary },
      facts: [{ type: 'evidence.recorded', receipt }],
    }
  },

  serialize: output => ({
    kind: 'text',
    text: `${output.passed ? 'PASS' : 'FAIL'} DiffAssert: ${output.summary}\nevidenceId: ${output.evidenceId}`,
  }),
})

const ManualVerifyInput = z.object({
  criterionIds: CriterionIds,
}).strict()

/** Human-only confirmation: model text can never create a passed receipt. */
export const ManualVerifyTool = defineTool<
  z.infer<typeof ManualVerifyInput>,
  AssertionEvidenceOutput
>({
  name: 'ManualVerify',
  description:
    'Ask the human to verify approved manual criteria. A passed manual receipt ' +
    'is signed only when the interactive user explicitly selects Confirm; ' +
    'headless runs cannot fabricate confirmation.',
  inputSchema: ManualVerifyInput,
  maxResultChars: 8_000,
  readOnly: () => true,
  concurrency: () => 'exclusive',
  interruptBehavior: () => 'cancel',
  resources: () => [{ resource: 'state:user_interaction', mode: 'write' }],
  permission: async () => ({ behavior: 'allow' }),

  validate: async (input, ctx) => {
    const criteria = criterionValidation(input.criterionIds, 'manual', ctx)
    if (!criteria.ok) return criteria
    if (!ctx.services.askUser) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: 'manual verification requires an interactive user channel',
          retryable: false,
          hint: 'Run interactively or leave the criterion explicitly unverified.',
        },
      }
    }
    return { ok: true }
  },

  execute: async (input, ctx) => {
    const startedAt = ctx.clock.isoNow()
    const criteria = criteriaFor(input.criterionIds, ctx)
    const answer = await ctx.services.askUser!({
      question:
        'Verify these approved acceptance criteria against the current workspace:\n' +
        criteria.map(criterion => `- ${criterion.id}: ${criterion.statement}`).join('\n') +
        '\nSelect Confirm only if you personally verified every item.',
      options: ['Confirm', 'Reject'],
    })
    const status: EvidenceReceipt['status'] =
      answer === 'Confirm' ? 'passed' : answer === 'Reject' ? 'failed' : 'inconclusive'
    const summary =
      status === 'passed'
        ? 'human explicitly confirmed all listed criteria'
        : status === 'failed'
          ? 'human rejected at least one listed criterion'
          : 'human did not provide an explicit confirmation'
    const receipt = await ctx.services.evidence!.record({
      kind: 'manual',
      status,
      criterionIds: input.criterionIds,
      invocation: {
        tool: 'ManualVerify',
        normalizedInput: { criterionIds: input.criterionIds },
        cwd: ctx.workspaceRoot,
      },
      observation: { outputPreview: summary },
      startedAt,
    })
    return {
      data: { passed: status === 'passed', evidenceId: receipt.id, summary },
      facts: [{ type: 'evidence.recorded', receipt }],
    }
  },

  serialize: output => ({
    kind: 'text',
    text: `${output.passed ? 'PASS' : 'NOT CONFIRMED'} ManualVerify: ${output.summary}\nevidenceId: ${output.evidenceId}`,
  }),
})
