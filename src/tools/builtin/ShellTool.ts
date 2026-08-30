import { z } from 'zod'
import { spawn } from 'node:child_process'
import { defineTool } from '../Tool.js'
import { analyzeShellCommand, sanitizedEnv } from '../../policy/shellPolicy.js'

const ShellInput = z
  .object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().max(600_000).default(120_000),
    /** acceptance criterion ids this run is intended to verify; the runtime
     * signs an evidence receipt with the real observation */
    criterionIds: z.array(z.string()).optional(),
    evidenceKind: z.enum(['command', 'test']).default('command'),
    /** workspace-relative files whose content versions the evidence should
     * be bound to; verification later rejects the receipt if these files
     * changed after signing (stale evidence) */
    evidenceFiles: z.array(z.string()).optional(),
  })
  .strict()

export interface ProcessResult {
  command: string
  cwd: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  truncated: { stdout: boolean; stderr: boolean }
}

const MAX_STREAM_CHARS = 100_000

/**
 * Bounded ring buffer for process output: memory can never grow beyond
 * `capacity` characters regardless of how much the child prints. Keeps the
 * TAIL of the stream (errors and final status live at the end).
 */
export class RingBuffer {
  private chunks: string[] = []
  private length = 0
  totalWritten = 0

  constructor(private readonly capacity: number) {}

  write(text: string): void {
    this.totalWritten += text.length
    this.chunks.push(text)
    this.length += text.length

    let overflow = this.length - this.capacity
    while (overflow > 0 && this.chunks.length > 0) {
      const oldest = this.chunks[0]!
      if (oldest.length <= overflow) {
        this.chunks.shift()
        this.length -= oldest.length
        overflow -= oldest.length
        continue
      }

      this.chunks[0] = oldest.slice(overflow)
      this.length -= overflow
      overflow = 0
    }
  }

  /** Buffered content (the retained tail). */
  toString(): string {
    return this.chunks.join('')
  }

  get overflowed(): boolean {
    return this.totalWritten > this.capacity
  }
}

export function runProcess(options: {
  command: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  /** real-time progress callback for stdout/stderr chunks */
  onProgress?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
}): Promise<ProcessResult> {
  return new Promise(resolve => {
    const startedAt = Date.now()
    const isWindows = process.platform === 'win32'
    // shell:true is required to run user-facing commands; safety comes from
    // the policy layer (analysis + permission), not from here.
    // Environment is sanitized (allowlist); detached creates an independent
    // process group on Unix so timeouts can kill the entire tree.
    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: isWindows ? 'cmd.exe' : true,
      windowsHide: true,
      env: sanitizedEnv(),
      detached: !isWindows,
    })

    const stdout = new RingBuffer(MAX_STREAM_CHARS)
    const stderr = new RingBuffer(MAX_STREAM_CHARS)
    let timedOut = false
    let settled = false

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', onAbort)
      resolve({
        command: options.command,
        cwd: options.cwd,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated: { stdout: stdout.overflowed, stderr: stderr.overflowed },
      })
    }

    const killTree = () => {
      if (child.pid === undefined) return
      if (isWindows) {
        // kill the whole process tree, not just the parent
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
        })
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, options.timeoutMs)

    const onAbort = () => killTree()
    options.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', chunk => {
      const text = String(chunk)
      stdout.write(text)
      // emit progress for real-time streaming (backpressure: stop once the
      // retention budget is exhausted — memory stays bounded either way)
      if (options.onProgress && !stdout.overflowed) {
        options.onProgress({ stream: 'stdout', text })
      }
    })
    child.stderr?.on('data', chunk => {
      const text = String(chunk)
      stderr.write(text)
      if (options.onProgress && !stderr.overflowed) {
        options.onProgress({ stream: 'stderr', text })
      }
    })
    child.on('error', error => {
      stderr.write(`\n[spawn error] ${error.message}`)
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

function buildShellTool(name: 'Shell' | 'ShellReadOnly') {
  return defineTool<z.infer<typeof ShellInput>, ProcessResult & { evidenceId?: string }>({
    name,
    description:
      name === 'Shell'
        ? 'Run a shell command in the workspace. Reports exit code, stdout, stderr. ' +
          'Commands are analyzed; dangerous or unparseable commands are denied.'
        : 'Run an audited read-only command (simple argv only, no pipes or redirects). ' +
          'Available in plan mode.',
    inputSchema: ShellInput,
    maxResultChars: 30_000,
    // invocation scope: dedupe only the crash-recovery replay of the SAME
    // call. Re-running an identical command at a later stage (e.g. npm test
    // after code changes) is legitimate and must not be blocked.
    idempotencyScope: 'invocation',
    readOnly:
      name === 'ShellReadOnly'
        ? () => true
        : input => analyzeShellCommand(input.command).classification === 'readonly',
    destructive: input =>
      analyzeShellCommand(input.command).classification === 'dangerous',
    concurrency: () => 'exclusive',
    interruptBehavior: () => 'cancel',
    resources: () => [{ resource: 'process:workspace', mode: 'write' }],
    workspaceMutation: input => {
      if (name === 'ShellReadOnly') return undefined
      const analysis = analyzeShellCommand(input.command)
      return analysis.classification === 'readonly'
        ? undefined
        : {
            scope: 'workspace',
            reason:
              `Shell command is ${analysis.classification}; its exact workspace ` +
              'write set cannot be proven before execution',
          }
    },

    permission: async input => {
      const analysis = analyzeShellCommand(input.command)
      if (analysis.classification === 'dangerous') {
        return { behavior: 'deny', code: 'shell_dangerous', message: analysis.reason }
      }
      if (analysis.classification === 'unparseable') {
        // parse failure is high risk: never auto-allow
        return name === 'ShellReadOnly'
          ? { behavior: 'deny', code: 'shell_unparseable', message: analysis.reason }
          : { behavior: 'ask', code: 'shell_unparseable', message: analysis.reason }
      }
      if (name === 'ShellReadOnly') {
        return analysis.classification === 'readonly'
          ? { behavior: 'allow' }
          : { behavior: 'deny', code: 'shell_not_readonly' }
      }
      return analysis.classification === 'readonly'
        ? { behavior: 'allow' }
        : { behavior: 'ask', code: 'shell_write' }
    },

    validate: async (input, ctx) => {
      if (input.cwd) {
        const { checkPathReal } = await import('../../policy/pathPolicy.js')
        // symlink-aware: a cwd that is a link escaping the workspace is rejected
        const check = await checkPathReal(input.cwd, ctx.workspaceRoot, { read: true })
        if (!check.ok) {
          return {
            ok: false,
            error: {
              code: 'SEMANTIC_VALIDATION_ERROR',
              message: `cwd rejected: ${check.reason}`,
              retryable: false,
            },
          }
        }
      }
      return { ok: true }
    },

    execute: async (input, ctx, progress) => {
      let cwd = ctx.workspaceRoot
      if (input.cwd) {
        // re-check immediately before spawn to narrow the TOCTOU window
        const recheck = await (await import('../../policy/pathPolicy.js')).checkPathReal(
          input.cwd,
          ctx.workspaceRoot,
          { read: true },
        )
        if (!recheck.ok) {
          throw Object.assign(
            new Error(`cwd rejected at spawn time: ${recheck.reason}`),
            { toolErrorCode: 'SEMANTIC_VALIDATION_ERROR' },
          )
        }
        cwd = recheck.resolved
      }
      const startedAt = ctx.clock.isoNow()
      const result = await runProcess({
        command: input.command,
        cwd,
        timeoutMs: input.timeoutMs,
        signal: ctx.signal,
        onProgress: chunk => progress(chunk),
      })

      // The runtime signs the evidence receipt from the real observation.
      // Verifier reports and task completion may only reference these ids.
      if (ctx.services.evidence) {
        // Bind the receipt to the current workspace version: hash every file
        // the run claims to have produced/verified so a later verification
        // round can detect the workspace moved on after signing. Files are
        // path-checked first — never bind versions of files outside the
        // workspace (symlink/junction escape attempts are skipped).
        let fileVersions: Record<string, string> | undefined
        if (input.evidenceFiles && input.evidenceFiles.length > 0) {
          const { checkPathReal } = await import('../../policy/pathPolicy.js')
          const {
            MISSING_FILE_VERSION,
            readFileVersion,
          } = await import('../../workspace/FileVersion.js')
          fileVersions = {}
          for (const rel of input.evidenceFiles) {
            const check = await checkPathReal(rel, ctx.workspaceRoot, { read: true })
            if (!check.ok) continue
            try {
              const { version } = await readFileVersion(check.resolved)
              fileVersions[check.resolved] = version
            } catch (error) {
              if (
                error instanceof Error &&
                'code' in error &&
                (error as NodeJS.ErrnoException).code === 'ENOENT'
              ) {
                fileVersions[check.resolved] = MISSING_FILE_VERSION
              }
              // Other read errors remain unbound and therefore fail closed.
            }
          }
        }
        const receipt = await ctx.services.evidence.record({
          kind: input.evidenceKind,
          status:
            result.timedOut || result.exitCode === null
              ? 'inconclusive'
              : result.exitCode === 0
                ? 'passed'
                : 'failed',
          criterionIds: input.criterionIds,
          invocation: { tool: name, normalizedInput: { command: input.command }, cwd },
          observation: {
            exitCode: result.exitCode ?? undefined,
            outputPreview: (result.stdout + result.stderr).slice(0, 1_000),
          },
          startedAt,
          fileVersions,
        })
        return {
          data: { ...result, evidenceId: receipt.id },
          facts: [{ type: 'evidence.recorded', receipt }],
        }
      }
      return { data: result }
    },

    serialize: output => ({
      kind: 'text',
      text: [
        `command: ${output.command}`,
        `exitCode: ${output.exitCode}${output.timedOut ? ' (TIMED OUT)' : ''}`,
        `durationMs: ${output.durationMs}`,
        output.evidenceId ? `evidenceId: ${output.evidenceId}` : '',
        '',
        'stdout:',
        output.stdout || '(empty)',
        output.truncated.stdout ? '[stdout truncated]' : '',
        '',
        'stderr:',
        output.stderr || '(empty)',
        output.truncated.stderr ? '[stderr truncated]' : '',
      ]
        .filter(line => line !== '')
        .join('\n'),
    }),
  })
}

export const ShellTool = buildShellTool('Shell')
export const ShellReadOnlyTool = buildShellTool('ShellReadOnly')
