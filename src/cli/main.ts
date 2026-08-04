#!/usr/bin/env node
/**
 * code-agent — standalone entry point.
 *
 * Works from any directory: `code-agent` in a folder starts a session with
 * that folder as the workspace. Credentials live in ~/.code-agent/config.json
 * (written by `code-agent setup`), so no environment variables are needed.
 */
import { createInterface } from 'node:readline/promises'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import process from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime, resumeState, type AgentRuntime } from '../app/createRuntime.js'
import {
  configCandidates,
  loadAgentConfigFile,
  mergeConfig,
  type AgentFileConfig,
  type EffectiveConfig,
  type ModelFileConfig,
} from '../app/config.js'
import type { AgentMode, FactEvent } from '../core/events.js'
import { isFactEvent } from '../core/events.js'
import { reduce, type AgentState } from '../core/state.js'
import type { ModelGateway } from '../model/types.js'
import { OpenAICompatibleProvider } from '../model/providers/openaiCompatible.js'
import { AnthropicProvider } from '../model/providers/anthropic.js'
import { MetricsCollector } from '../observability/metrics.js'
import {
  latestResumableSession,
  listSessions,
  removeSessionIfUnused,
  type SessionSummary,
} from '../session/sessionIndex.js'
import { Spinner } from './spinner.js'
import { Renderer } from './render.js'
import { askPermission, askPlanApproval, askUserQuestion } from './prompts.js'
import { commandMenuLines, commandNames, findCommand, parseCommand, type CommandContext } from './commands.js'
import { modeLabel, oneLine, rule, style, symbol } from './theme.js'
import { helpText, parseArgs, type CliArgs } from './args.js'
import { runSetupWizard } from './setupWizard.js'

/** Walk up from this file until a package.json is found. */
async function findPackageRoot(): Promise<string | undefined> {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    try {
      await stat(join(dir, 'package.json'))
      return dir
    } catch {
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

async function readVersion(packageRoot?: string): Promise<string> {
  if (!packageRoot) return 'dev'
  try {
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'dev'
  } catch {
    return 'dev'
  }
}

/** Source commit the bundle was built from (injected at build time). */
function buildSuffix(): string {
  return typeof __AGENT_BUILD_COMMIT__ === 'string' &&
    __AGENT_BUILD_COMMIT__.length > 0
    ? ` (${__AGENT_BUILD_COMMIT__})`
    : ''
}

function buildModel(file: ModelFileConfig): ModelGateway | null {
  const provider = process.env.AGENT_PROVIDER ?? file.provider ?? 'openai'
  const apiKey = process.env.AGENT_API_KEY ?? file.apiKey
  const model = process.env.AGENT_MODEL ?? file.model
  const baseUrl = process.env.AGENT_BASE_URL ?? file.baseUrl

  if (!apiKey || !model || apiKey === 'FILL_ME') return null

  return provider === 'anthropic'
    ? new AnthropicProvider({ apiKey, model, baseUrl })
    : new OpenAICompatibleProvider({
        baseUrl: baseUrl ?? 'https://api.openai.com/v1',
        apiKey,
        model,
      })
}

/**
 * Optional independent model for the verification subagent — reduces
 * same-source confirmation bias when the verifier runs on a different
 * provider/model than the implementer. Configure via AGENT_VERIFIER_PROVIDER
 * / AGENT_VERIFIER_MODEL (credentials are inherited from the main model).
 * Returns null when no override is configured.
 */
function buildVerifierModel(file: ModelFileConfig): ModelGateway | null {
  const rawProvider = process.env.AGENT_VERIFIER_PROVIDER
  const vProvider: 'openai' | 'anthropic' | undefined =
    rawProvider === 'openai' || rawProvider === 'anthropic' ? rawProvider : undefined
  const vModel = process.env.AGENT_VERIFIER_MODEL
  if (!vProvider && !vModel) return null
  return buildModel({
    ...file,
    provider: vProvider ?? file.provider,
    model: vModel ?? file.model,
  })
}

/** Is this an empty folder we should treat as a greenfield project? */
async function inspectWorkspace(root: string): Promise<{
  empty: boolean
  entries: string[]
}> {
  try {
    const entries = (await readdir(root)).filter(
      name => name !== '.agent' && name !== '.git',
    )
    return { empty: entries.length === 0, entries }
  } catch {
    return { empty: true, entries: [] }
  }
}

/** Human-friendly session table for `agent sessions`. */
function printSessions(sessions: SessionSummary[], workspaceRoot: string): void {
  console.log(rule('sessions'))
  console.log(`  ${style.gray('workspace')} ${workspaceRoot}`)
  if (sessions.length === 0) {
    console.log(style.gray('  no sessions yet'))
    return
  }
  for (const [index, session] of sessions.entries()) {
    const when = session.lastActivityAt.replace('T', ' ').slice(0, 19)
    const marker = index === 0 && session.humanMessageCount > 0 ? style.green('*') : ' '
    console.log(
      `${marker} ${style.bold(session.id)}  ${style.gray(when)}  ` +
        `${session.humanMessageCount} prompt(s), ${session.messageCount} message(s)` +
        (session.degraded ? style.yellow('  [partially recoverable]') : ''),
    )
    if (session.firstPrompt) {
      console.log(`    ${style.gray(oneLine(session.firstPrompt, 76))}`)
    } else {
      console.log(`    ${style.gray('(no conversation)')}`)
    }
  }
  console.log(
    style.gray(
      `\n  ${style.green('*')} = what --continue resumes · pick another with --session <id>`,
    ),
  )
}

function banner(input: {
  version: string
  sessionId: string
  workspaceRoot: string
  provider: string
  modelId: string
  mode: AgentMode
  configSource?: string
  configHash: string
  resumed?: string
  greenfield: boolean
}): void {
  console.log(rule(`code agent v${input.version}`))
  console.log(
    `  ${style.gray('model    ')} ${style.bold(input.modelId)} ${style.gray(`(${input.provider})`)}`,
  )
  console.log(`  ${style.gray('workspace')} ${input.workspaceRoot}`)
  console.log(`  ${style.gray('mode     ')} ${modeLabel(input.mode)}`)
  console.log(
    `  ${style.gray('session  ')} ${input.sessionId} ${style.gray(`· config ${input.configHash}`)}`,
  )
  if (input.configSource) console.log(`  ${style.gray('config   ')} ${input.configSource}`)
  if (input.resumed) console.log(`  ${style.gray('resumed  ')} ${input.resumed}`)
  console.log(rule())
  if (input.greenfield) {
    console.log(
      `  ${style.green(symbol.info)} empty folder — greenfield project. ` +
        `Describe what to build; ${style.cyan('/mode acceptEdits')} avoids a prompt per file.`,
    )
  }
  console.log(
    style.gray(
      `  ${style.cyan('/help')} for commands · ${style.cyan('/mode plan')} to plan first · Ctrl+C interrupts\n`,
    ),
  )
}

async function main(): Promise<void> {
  const args: CliArgs = parseArgs(process.argv.slice(2))
  const packageRoot = await findPackageRoot()
  const version = (await readVersion(packageRoot)) + buildSuffix()

  if (args.errors.length > 0) {
    for (const error of args.errors) console.error(`${symbol.fail} ${error}`)
    console.error(`\n${helpText()}`)
    process.exit(1)
  }
  if (args.command === 'help') {
    console.log(helpText())
    return
  }
  if (args.command === 'version') {
    console.log(version)
    return
  }

  // ---- workspace resolution: created when missing ----
  const workspaceRoot = resolve(args.dir ?? process.cwd())
  await mkdir(workspaceRoot, { recursive: true })
  const workspace = await inspectWorkspace(workspaceRoot)

  // listing sessions needs no model and no credentials
  if (args.command === 'sessions') {
    printSessions(await listSessions(workspaceRoot), workspaceRoot)
    return
  }

  // ---- config ----
  let fileConfig: AgentFileConfig = await loadAgentConfigFile(
    configCandidates({ workspaceRoot, explicit: args.configPath, packageRoot }),
  )

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 200,
    completer: (line: string): [string[], string] => {
      if (!line.startsWith('/')) return [[], line]
      const hits = commandNames().filter(name => name.startsWith(line))
      return [hits.length > 0 ? hits : commandNames(), line]
    },
  })

  // ---- setup wizard: explicit, or automatically when credentials are missing ----
  let model = buildModel(fileConfig.model)
  if (args.command === 'setup' || !model) {
    if (!model && args.command !== 'setup') {
      console.log(
        `${style.yellow(symbol.warn)} no model configured yet — let's set it up once.\n`,
      )
    }
    if (!process.stdin.isTTY) {
      console.error(
        `${symbol.fail} no model configured and no interactive terminal.\n` +
          'Run `code-agent setup`, or set AGENT_API_KEY and AGENT_MODEL.',
      )
      rl.close()
      process.exit(1)
    }
    const result = await runSetupWizard(rl, fileConfig.model)
    fileConfig = { ...fileConfig, model: result.model, source: result.savedTo }
    model = buildModel(result.model)
    if (args.command === 'setup') {
      rl.close()
      return
    }
  }
  if (!model) {
    console.error(`${symbol.fail} model configuration is still incomplete`)
    rl.close()
    process.exit(1)
  }

  const effective: EffectiveConfig = mergeConfig({
    project: fileConfig.layer,
    cli: {
      mode: args.mode ?? (process.env.AGENT_MODE as AgentMode | undefined),
      maxTurns: process.env.AGENT_MAX_TURNS
        ? Number(process.env.AGENT_MAX_TURNS)
        : undefined,
    },
  })

  let debug =
    args.debug ?? (process.env.AGENT_DEBUG === '1' || fileConfig.debug === true)
  const spinner = new Spinner()
  const renderer = new Renderer(spinner, { debug })
  const metrics = new MetricsCollector()

  // --continue resumes the newest session that actually has a conversation;
  // an empty run must never shadow real history
  const continued = args.continueLatest
    ? await latestResumableSession(workspaceRoot)
    : undefined
  const sessionId =
    args.session ??
    process.env.AGENT_SESSION ??
    continued?.id ??
    fileConfig.sessionId

  const policyRef: {
    current: import('../policy/PolicyEngine.js').PolicyEngine | null
  } = { current: null }

  const { runtime, loaded } = await createRuntime({
    model,
    verifierModel: buildVerifierModel(fileConfig.model) ?? undefined,
    config: {
      workspaceRoot,
      mode: effective.mode,
      sessionId,
      maxTurns: effective.maxTurns,
      maxModelCalls: effective.maxModelCalls,
      maxToolCalls: effective.maxToolCalls,
      maxWallTimeMs: effective.maxWallTimeMs,
      maxOutputTokens: effective.maxOutputTokens,
      projectInstructions: effective.projectInstructions,
      rules: effective.rules,
      verification: effective.verification,
      context: effective.context,
      configHash: effective.configHash,
    },
    askHandler: async (request, reason) =>
      askPermission(
        { rl, spinner, policy: policyRef.current! },
        { tool: request.tool, input: request.input },
        reason,
      ),
    channels: {
      askUser: async input =>
        askUserQuestion({ rl, spinner, policy: policyRef.current! }, input),
      requestPlanApproval: async plan =>
        askPlanApproval({ rl, spinner, policy: policyRef.current! }, plan),
    },
  })
  policyRef.current = runtime.policy

  // ---- resume ----
  let state: AgentState = runtime.makeInitialState()
  let resumedNote: string | undefined
  if (loaded && loaded.envelopes.length > 0) {
    const resumed = await resumeState(runtime, loaded)
    state = resumed.state
    resumedNote =
      `${loaded.messages.length} messages` +
      (loaded.openToolCalls.length > 0
        ? `, ${loaded.openToolCalls.length} interrupted tool call(s) closed`
        : '')
  }

  const oneShot = args.print !== undefined

  if (!oneShot) {
    banner({
      version,
      sessionId: runtime.sessionId,
      workspaceRoot,
      provider: runtime.model.provider,
      modelId: runtime.model.modelId,
      mode: state.mode,
      configSource: fileConfig.source,
      configHash: effective.configHash,
      resumed: resumedNote,
      greenfield: workspace.empty,
    })
    if (loaded) {
      for (const diagnostic of loaded.diagnostics) {
        if (!diagnostic.startsWith('journal not found')) {
          renderer.warn(`journal: ${diagnostic}`)
        }
      }
    }
    // never let a silent "resumed 0 messages" look like a working resume
    if (args.continueLatest && (state.messages.length === 0)) {
      renderer.warn(
        'nothing to continue: the most recent session has no conversation yet.',
      )
      renderer.plain(
        style.gray(
          `  run ${style.cyan('agent sessions')} to list earlier conversations, ` +
            `then ${style.cyan('agent --session <id>')} to resume one`,
        ),
      )
    }
  }

  // ---- one turn of the agent loop ----
  const runTurn = async (prompt: string): Promise<void> => {
    const userMessage = runtime.makeUserMessage(
      prompt,
      state.messages.length > 0 ? state.messages[state.messages.length - 1]!.id : null,
    )
    const userFact: FactEvent = { type: 'user.message.accepted', message: userMessage }
    await runtime.journal?.append(userFact, state.turnId, 'flush')
    state = {
      ...state,
      messages: [...state.messages, userMessage],
      iteration: 0,
      turnId: runtime.ids.next('turn'),
      recovery: { ...state.recovery, stopHookRetries: 0, verifierRepairs: 0 },
      budget: {
        ...state.budget,
        used: { ...state.budget.used, startedAt: runtime.clock.now() },
      },
    }

    const controller = new AbortController()
    let interrupted = false
    const onSigint = () => {
      if (interrupted) return
      interrupted = true
      spinner.clear()
      renderer.warn('interrupting… (finishing atomic writes)')
      controller.abort()
    }
    process.on('SIGINT', onSigint)

    try {
      const run = runtime.engine.run(state, controller.signal)
      let step = await run.next()
      while (!step.done) {
        const event = step.value
        metrics.record(event)
        renderer.handle(event)
        if (isFactEvent(event)) {
          if (
            event.type === 'assistant.message.completed' ||
            event.type === 'tool.result.message' ||
            event.type === 'user.message.accepted'
          ) {
            state = { ...state, messages: [...state.messages, event.message] }
          } else if (event.type === 'mode.changed') {
            state = reduce(state, event)
          } else if (event.type === 'task.changed') {
            state = {
              ...state,
              tasks: [
                ...state.tasks.filter(task => task.id !== event.task.id),
                event.task,
              ],
            }
          } else if (event.type === 'tool.call.completed') {
            state = {
              ...state,
              toolResults: {
                ...state.toolResults,
                [event.result.callId]: event.result,
              },
            }
          }
        }
        step = await run.next()
      }
      renderer.finishTurn()

      if (debug) {
        for (const entry of metrics.decisionLog.slice(-3)) {
          renderer.plain(style.gray(`  [turn] ${JSON.stringify(entry)}`))
        }
      }
    } catch (error) {
      renderer.finishTurn()
      renderer.error(`run failed: ${(error as Error).message}`)
    } finally {
      process.off('SIGINT', onSigint)
    }
  }

  // ---- non-interactive single turn ----
  if (oneShot) {
    await runTurn(args.print!)
    spinner.stop()
    rl.close()
    return
  }

  // ---- interactive REPL ----
  let exitRequested = false
  // set while a turn or an interactive prompt owns the terminal, so the
  // slash-menu hook never fires in the middle of a permission question
  let busy = false

  /**
   * Show the command menu the moment "/" starts a fresh line, then redraw the
   * prompt with whatever has been typed. Wrapped defensively: a terminal that
   * misbehaves must not break input.
   */
  const installSlashMenuHook = (): void => {
    if (!process.stdin.isTTY) return
    try {
      process.stdin.on('keypress', (_char: string, key: { sequence?: string }) => {
        if (busy || key?.sequence !== '/') return
        const line = (rl as unknown as { line?: string }).line ?? ''
        if (line.length !== 0) return // only at the start of a line
        setImmediate(() => {
          try {
            process.stdout.write('\n')
            for (const menuLine of commandMenuLines()) {
              process.stdout.write(`${menuLine}\n`)
            }
            rl.prompt(true)
          } catch {
            // rendering is best effort
          }
        })
      })
    } catch {
      // keypress events unavailable: Tab completion and "/" + Enter still work
    }
  }
  installSlashMenuHook()

  const commandContext = (): CommandContext => ({
    runtime,
    state,
    effective,
    metrics,
    configSource: fileConfig.source,
    debug,
    print: text => renderer.plain(text),
    setState: next => {
      state = next
    },
    setDebug: next => {
      debug = next
      renderer.setDebug(next)
    },
    requestExit: () => {
      exitRequested = true
    },
  })

  while (!exitRequested) {
    let line: string
    try {
      line = await rl.question(`${modeLabel(state.mode)} ${style.bold(symbol.user)} `)
    } catch {
      break // Ctrl+D
    }
    const text = line.trim()
    if (text.length === 0) continue

    // bare slash: show the menu (fallback when keypress hooks are unavailable)
    if (text === '/') {
      for (const menuLine of commandMenuLines()) renderer.plain(menuLine)
      continue
    }

    const command = parseCommand(text)
    if (command) {
      const handler = findCommand(command.name)
      if (!handler) {
        renderer.warn(`unknown command /${command.name} — try /help`)
        continue
      }
      busy = true
      try {
        await handler.run(commandContext(), command.args)
      } catch (error) {
        renderer.error(`/${command.name} failed: ${(error as Error).message}`)
      } finally {
        busy = false
      }
      continue
    }

    busy = true
    try {
      await runTurn(text)
    } finally {
      busy = false
    }
  }

  spinner.stop()
  const usage = metrics.snapshot().usage
  if (usage.modelTurns > 0) {
    console.log(rule('session summary'))
    console.log(metrics.formatSummary())
  }

  // a run that never talked to the model leaves an empty journal behind and
  // would otherwise shadow real history for --continue
  if (usage.modelTurns === 0 && !sessionId) {
    const removed = await removeSessionIfUnused(workspaceRoot, runtime.sessionId)
    if (removed) {
      console.log(style.gray('\nno conversation; empty session discarded'))
      rl.close()
      return
    }
  }

  console.log(
    style.gray(
      `\nsession ${runtime.sessionId} saved · resume with ${style.cyan('agent --continue')}`,
    ),
  )
  rl.close()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
