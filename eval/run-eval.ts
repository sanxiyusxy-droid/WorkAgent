/**
 * Live-model evaluation harness (finish-list §7).
 *
 * Runs every fixture task in eval/tasks/ against the real CLI in one-shot
 * mode and records the metrics the project reports: task success, terminal
 * reason, model turns, tool calls, workspace changes, replans, tokens, and
 * latency percentiles across repeated runs.
 *
 * A REAL model configuration is required (AGENT_API_KEY / AGENT_MODEL, or
 * agent.config.json / `code-agent setup`). Fixture tasks are deliberately
 * tiny so a full pass stays cheap; grow eval/tasks/ to 20-50 real-world
 * repositories for release-grade numbers.
 *
 * Usage:
 *   npx tsx eval/run-eval.ts                 run every task once
 *   npx tsx eval/run-eval.ts --runs 3        repeat each task (P50/P95)
 *   npx tsx eval/run-eval.ts --task t02      single task
 *   npx tsx eval/run-eval.ts --mode acceptEdits
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { loadSession } from '../src/session/SessionLoader.js'

interface TaskSpec {
  id: string
  title: string
  prompt: string
  /**
   * CLI mode for this task (default: bypassPermissions). Tasks run in a
   * disposable temp workspace with a hard timeout, so the harness lets the
   * agent self-verify via shell; a task may opt into a stricter mode.
   */
  mode?: string
  /** per-run hard timeout in seconds (default: 300) */
  timeoutSec?: number
  /** shell commands that must ALL exit 0 for the task to count as success */
  verify: { name: string; command: string }[]
}

interface RunRecord {
  task: string
  run: number
  success: boolean
  agentCompleted: boolean
  verifyFailed: string[]
  terminalReason: string
  modelTurns: number
  toolCalls: number
  failedToolCalls: number
  workspaceChanges: number
  replans: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  error?: string
}

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tasksDir = join(agentRoot, 'eval', 'tasks')

function parseFlags(argv: string[]): {
  runs: number
  task?: string
  mode?: string
} {
  const out = { runs: 1, task: undefined as string | undefined, mode: undefined as string | undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') out.runs = Math.max(1, Number(argv[++i]) || 1)
    if (argv[i] === '--task') out.task = argv[++i]
    if (argv[i] === '--mode') out.mode = argv[++i]
  }
  return out
}

async function discoverTasks(): Promise<TaskSpec[]> {
  const ids = (await readdir(tasksDir)).sort()
  const specs: TaskSpec[] = []
  for (const id of ids) {
    const specPath = join(tasksDir, id, 'task.json')
    try {
      await stat(specPath)
    } catch {
      continue
    }
    const spec = JSON.parse(await readFile(specPath, 'utf8')) as TaskSpec
    specs.push({ ...spec, id })
  }
  return specs
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise(resolvePromise => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true })
    let output = ''
    let timedOut = false
    child.stdout?.on('data', d => (output += String(d)))
    child.stderr?.on('data', d => (output += String(d)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code, output, timedOut })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolvePromise({ exitCode: null, output, timedOut })
    })
  })
}

/** Collect metrics straight from the session journal (source of truth). */
async function journalMetrics(workspace: string): Promise<Partial<RunRecord>> {
  const sessionsRoot = join(workspace, '.agent', 'sessions')
  let ids: string[] = []
  try {
    ids = await readdir(sessionsRoot)
  } catch {
    return {}
  }
  const metrics: Partial<RunRecord> = {
    modelTurns: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    workspaceChanges: 0,
    replans: 0,
    inputTokens: 0,
    outputTokens: 0,
    terminalReason: 'no_journal',
  }
  for (const id of ids) {
    let loaded
    try {
      loaded = await loadSession(join(sessionsRoot, id, 'journal.jsonl'))
    } catch {
      continue
    }
    for (const env of loaded.envelopes) {
      const event = env.event
      switch (event.type) {
        case 'assistant.message.completed':
          metrics.modelTurns! += 1
          metrics.inputTokens! += event.usage?.inputTokens ?? 0
          metrics.outputTokens! += event.usage?.outputTokens ?? 0
          break
        case 'tool.call.completed':
          metrics.toolCalls! += 1
          if (!event.result.ok) metrics.failedToolCalls! += 1
          break
        case 'workspace.changed':
          metrics.workspaceChanges! += 1
          break
        case 'replan.requested':
          metrics.replans! += 1
          break
        case 'run.terminated':
          metrics.terminalReason = event.terminal.reason
          break
      }
    }
  }
  return metrics
}

async function runOnce(
  spec: TaskSpec,
  run: number,
  forcedMode?: string,
): Promise<RunRecord> {
  const workspace = await mkdtemp(join(tmpdir(), `agent-eval-${spec.id}-`))
  const startedAt = Date.now()
  const record: RunRecord = {
    task: spec.id,
    run,
    success: false,
    agentCompleted: false,
    verifyFailed: [],
    terminalReason: 'spawn_failed',
    modelTurns: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    workspaceChanges: 0,
    replans: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
  }
  try {
    await cp(join(tasksDir, spec.id, 'repo'), workspace, { recursive: true })

    const timeoutSec = spec.timeoutSec ?? 300
    const cli = await runCommand(
      `npx tsx src/cli/main.ts --dir ${JSON.stringify(workspace)} ` +
        `--mode ${forcedMode ?? spec.mode ?? 'bypassPermissions'} -p ${JSON.stringify(spec.prompt)}`,
      agentRoot,
      timeoutSec * 1000,
    )
    record.durationMs = Date.now() - startedAt
    if (cli.timedOut) {
      record.error = `CLI timed out after ${timeoutSec}s`
    } else if (cli.exitCode !== 0) {
      record.error =
        `CLI exited with ${cli.exitCode ?? 'no exit code'}: ` +
        cli.output.slice(-400)
    }

    Object.assign(record, await journalMetrics(workspace))
    record.agentCompleted = record.terminalReason === 'completed'

    const verifyTimeoutMs = 60_000
    for (const check of spec.verify) {
      const result = await runCommand(check.command, workspace, verifyTimeoutMs)
      if (result.exitCode !== 0) {
        record.verifyFailed.push(
          `${check.name} (exit ${result.exitCode}): ${result.output.slice(-400)}`,
        )
      }
    }
    // A fixture is successful only when the process, Agent protocol and
    // external verifier all agree. Passing checks on an unchanged workspace
    // can no longer hide a timeout, crash or non-completion terminal.
    record.success =
      cli.exitCode === 0 &&
      !cli.timedOut &&
      record.agentCompleted &&
      record.verifyFailed.length === 0
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
  return record
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const position = Math.min(
    sorted.length - 1,
    Math.max(0, (p / 100) * (sorted.length - 1)),
  )
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]!
  const weight = position - lower
  return Math.round(sorted[lower]! * (1 - weight) + sorted[upper]! * weight)
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  const specs = (await discoverTasks()).filter(
    s => !flags.task || s.id === flags.task,
  )
  if (specs.length === 0) {
    console.error(`no tasks found under ${tasksDir}`)
    process.exit(1)
  }

  const records: RunRecord[] = []
  for (const spec of specs) {
    for (let run = 1; run <= flags.runs; run++) {
      process.stdout.write(`[run] ${spec.id} (${spec.title}) ${run}/${flags.runs} ... `)
      const record = await runOnce(spec, run, flags.mode)
      records.push(record)
      console.log(
        record.success
          ? `PASS (${record.durationMs}ms, ${record.modelTurns} turns, ${record.toolCalls} tools)`
          : `FAIL [${record.terminalReason}] ${record.error ?? record.verifyFailed[0] ?? ''}`,
      )
    }
  }

  const succeeded = records.filter(r => r.success)
  const durations = succeeded.map(r => r.durationMs)
  const summary = {
    at: new Date().toISOString(),
    tasks: specs.length,
    runs: records.length,
    taskSuccessRate: succeeded.length / records.length,
    agentCompletionRate:
      records.filter(r => r.agentCompleted).length / records.length,
    avgModelTurns:
      records.reduce((sum, r) => sum + r.modelTurns, 0) / records.length,
    avgToolCalls:
      records.reduce((sum, r) => sum + r.toolCalls, 0) / records.length,
    totalTokens: records.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0),
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    records,
  }

  const resultsDir = join(agentRoot, 'eval', 'results')
  const outPath = join(
    resultsDir,
    `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  await mkdir(resultsDir, { recursive: true })
  await writeFile(outPath, JSON.stringify(summary, null, 2), 'utf8')

  console.log('\n=== evaluation summary ===')
  console.log(`task success:      ${(summary.taskSuccessRate * 100).toFixed(1)}% (${succeeded.length}/${records.length})`)
  console.log(`agent completion:  ${(summary.agentCompletionRate * 100).toFixed(1)}%`)
  console.log(`avg model turns:   ${summary.avgModelTurns.toFixed(1)}`)
  console.log(`avg tool calls:    ${summary.avgToolCalls.toFixed(1)}`)
  console.log(`total tokens:      ${summary.totalTokens}`)
  console.log(`P50 latency:       ${summary.p50DurationMs}ms`)
  console.log(`P95 latency:       ${summary.p95DurationMs}ms`)
  if (outPath) console.log(`\nfull report: ${outPath}`)
  process.exit(succeeded.length === records.length ? 0 : 2)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
