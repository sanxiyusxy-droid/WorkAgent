import type { AgentMode, FactEvent } from '../core/events.js'
import type { AgentState } from '../core/state.js'
import type { ConversationMessage } from '../core/messages.js'
import type { AgentRuntime } from '../app/createRuntime.js'
import type { EffectiveConfig } from '../app/config.js'
import { estimateTokens } from '../context/ContextManager.js'
import type { MetricsCollector } from '../observability/metrics.js'
import { indent, modeLabel, oneLine, rule, style, symbol } from './theme.js'

export const MODES: AgentMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
]

/**
 * A mode switch is invisible to the model unless we tell it: the mode lives in
 * engine state, not in the conversation. Without this notice the model keeps
 * believing it is still in plan mode and asks the user to "click a button".
 */
function modeNoticeText(from: AgentMode, to: AgentMode): string {
  if (to === 'plan') {
    return (
      `[Permission mode changed: ${from} -> plan. Write tools are removed from ` +
      'your toolset. Explore read-only, then use PlanPropose and ExitPlanMode ' +
      'to get the plan approved.]'
    )
  }
  if (from === 'plan') {
    return (
      `[Permission mode changed: plan -> ${to}. Write tools are available again. ` +
      'If a previous tool call failed because of plan mode, retry it now. Do not ' +
      'ask the user to change anything.]'
    )
  }
  return `[Permission mode changed: ${from} -> ${to}.]`
}

/** What a command handler is allowed to touch. */
export interface CommandContext {
  runtime: AgentRuntime
  state: AgentState
  effective: EffectiveConfig
  metrics: MetricsCollector
  configSource?: string
  debug: boolean
  print: (text: string) => void
  /** replace the conversation state (mode switch, clear, compaction) */
  setState: (state: AgentState) => void
  setDebug: (debug: boolean) => void
  requestExit: () => void
}

export interface SlashCommand {
  name: string
  args?: string
  summary: string
  run: (ctx: CommandContext, args: string[]) => Promise<void> | void
}

export const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    summary: 'list all commands',
    run: ctx => {
      for (const line of commandMenuLines()) ctx.print(line)
    },
  },
  {
    name: 'mode',
    args: '[name]',
    summary: `switch permission mode (${MODES.join(' | ')})`,
    run: (ctx, args) => {
      const target = args[0]
      if (!target) {
        ctx.print(`current mode: ${modeLabel(ctx.state.mode)}`)
        ctx.print(style.gray(`available: ${MODES.join(', ')}`))
        ctx.print(
          style.gray(
            '  default            read auto-allowed, writes ask\n' +
              '  acceptEdits        workspace edits auto-allowed\n' +
              '  plan               read-only; write tools hidden from the model\n' +
              '  dontAsk            anything needing approval is denied\n' +
              '  bypassPermissions  skip asks (hard safety rules still apply)',
          ),
        )
        return
      }
      if (!MODES.includes(target as AgentMode)) {
        ctx.print(style.red(`unknown mode: ${target}`))
        return
      }
      const next = target as AgentMode
      if (next === ctx.state.mode) {
        ctx.print(style.gray(`already in ${next}`))
        return
      }
      const previous = ctx.state.mode
      // mode changes are facts: journaled and replayable
      const fact: FactEvent = {
        type: 'mode.changed',
        from: previous,
        to: next,
        ...(next === 'plan' ? { prePlanMode: previous } : {}),
      }
      void ctx.runtime.journal?.append(fact, ctx.state.turnId, 'flush')
      const patched: AgentState = { ...ctx.state, mode: next }
      if (next === 'plan' && previous !== 'plan') {
        patched.prePlanMode = previous as Exclude<AgentMode, 'plan'>
      }
      if (previous === 'plan' && next !== 'plan') {
        delete patched.prePlanMode
      }

      // tell the model, otherwise it cannot know the mode changed
      const notice: ConversationMessage = {
        id: ctx.runtime.ids.next('msg'),
        parentId:
          patched.messages.length > 0
            ? patched.messages[patched.messages.length - 1]!.id
            : null,
        sessionId: ctx.runtime.sessionId,
        turnId: patched.turnId,
        role: 'user',
        content: [{ type: 'text', text: modeNoticeText(previous, next) }],
        createdAt: ctx.runtime.clock.isoNow(),
        meta: { source: 'engine', synthetic: true },
      }
      const noticeFact: FactEvent = {
        type: 'user.message.accepted',
        message: notice,
      }
      void ctx.runtime.journal?.append(noticeFact, patched.turnId, 'buffered')
      patched.messages = [...patched.messages, notice]

      ctx.setState(patched)
      ctx.print(`mode ${symbol.arrow} ${modeLabel(next)}`)
      if (next === 'plan') {
        ctx.print(style.gray('write tools are now hidden from the model'))
      }
      if (previous === 'plan') {
        ctx.print(style.gray('write tools are available again; the model has been told'))
      }
      if (next === 'bypassPermissions') {
        ctx.print(
          style.yellow(
            `${symbol.warn} asks are skipped; workspace escapes and sensitive paths are still blocked`,
          ),
        )
      }
    },
  },
  {
    name: 'tools',
    summary: 'list the tools the model can actually call right now',
    run: ctx => {
      const tools = ctx.runtime.registry.availableFor(ctx.state.mode)
      ctx.print(rule(`tools visible in ${ctx.state.mode} mode (${tools.length})`))
      for (const tool of tools) {
        ctx.print(
          `  ${style.bold(tool.name.padEnd(16))}${style.gray(oneLine(tool.description, 70))}`,
        )
      }
      const hidden = ctx.runtime.registry
        .names()
        .filter(name => !tools.some(tool => tool.name === name))
      if (hidden.length > 0) {
        ctx.print(style.gray(`  hidden in this mode: ${hidden.join(', ')}`))
      }
    },
  },
  {
    name: 'model',
    summary: 'show the active provider and model',
    run: ctx => {
      ctx.print(`provider: ${style.bold(ctx.runtime.model.provider)}`)
      ctx.print(`model:    ${style.bold(ctx.runtime.model.modelId)}`)
      if (ctx.configSource) ctx.print(style.gray(`config:   ${ctx.configSource}`))
    },
  },
  {
    name: 'tasks',
    summary: 'show the task graph',
    run: ctx => {
      const tasks = ctx.runtime.tasks.list()
      if (tasks.length === 0) {
        ctx.print(style.gray('no tasks'))
        return
      }
      for (const task of tasks) {
        const glyph =
          task.status === 'completed'
            ? style.green(symbol.taskDone)
            : task.status === 'blocked' || task.status === 'failed'
              ? style.red(symbol.task)
              : style.yellow(symbol.task)
        ctx.print(
          `${glyph} ${style.bold(task.id)} ${task.subject} ${style.gray(`[${task.status}] rev=${task.revision}`)}`,
        )
        if (task.dependsOn.length > 0) {
          ctx.print(indent(style.gray(`depends on: ${task.dependsOn.join(', ')}`), '    '))
        }
        if (task.evidenceIds.length > 0) {
          ctx.print(indent(style.gray(`evidence: ${task.evidenceIds.join(', ')}`), '    '))
        }
        if (task.blockedReason) {
          ctx.print(indent(style.red(`blocked: ${task.blockedReason}`), '    '))
        }
      }
    },
  },
  {
    name: 'plan',
    summary: 'show the approved plan',
    run: ctx => {
      const plan = ctx.runtime.plans.lastApproved()
      if (!plan) {
        ctx.print(style.gray('no approved plan (use /mode plan to start planning)'))
        return
      }
      ctx.print(rule(`PLAN ${plan.planId} v${plan.version} (${plan.status})`))
      ctx.print(`${style.bold('Goal')} ${plan.goal}`)
      for (const [index, step] of plan.steps.entries()) {
        ctx.print(`  ${index + 1}. ${step.title}`)
      }
      for (const criterion of plan.acceptanceCriteria) {
        ctx.print(
          indent(
            `${criterion.required ? style.yellow('required') : style.gray('optional')} ` +
              `${criterion.id} (${criterion.evidenceKind}) ${criterion.statement}`,
          ),
        )
      }
    },
  },
  {
    name: 'evidence',
    summary: 'list runtime-signed evidence receipts',
    run: ctx => {
      const receipts = ctx.runtime.evidence.list()
      if (receipts.length === 0) {
        ctx.print(style.gray('no evidence recorded yet'))
        return
      }
      for (const receipt of receipts) {
        const paint =
          receipt.status === 'passed'
            ? style.green
            : receipt.status === 'failed'
              ? style.red
              : style.yellow
        ctx.print(
          `${paint(receipt.status.padEnd(12))} ${style.bold(receipt.id)} ` +
            style.gray(
              `${receipt.kind} exit=${receipt.observation.exitCode ?? '-'} ` +
                (receipt.criterionIds.length > 0
                  ? `→ ${receipt.criterionIds.join(',')}`
                  : ''),
            ),
        )
      }
    },
  },
  {
    name: 'metrics',
    summary: 'session metrics (tokens, permissions, invariants)',
    run: ctx => {
      ctx.print(rule('metrics'))
      ctx.print(ctx.metrics.formatSummary())
    },
  },
  {
    name: 'session',
    summary: 'workspace, session id, journal path and context size',
    run: ctx => {
      ctx.print(`workspace: ${style.bold(ctx.state.workspace.root)}`)
      ctx.print(`session:   ${style.bold(ctx.runtime.sessionId)}`)
      ctx.print(`run:       ${ctx.runtime.runId}`)
      ctx.print(`journal:   ${ctx.runtime.journalPath}`)
      ctx.print(`messages:  ${ctx.state.messages.length}`)
      ctx.print(`context:   ~${estimateTokens(ctx.state.messages)} tokens`)
      ctx.print(
        style.gray(
          'the workspace is fixed for a session (path policy binds to it).\n' +
            'to work in another folder: exit, then run the agent there or use -C <dir>.',
        ),
      )
      ctx.print(
        style.gray(`resume this session later:  code-agent --session ${ctx.runtime.sessionId}`),
      )
    },
  },
  {
    name: 'sessions',
    summary: 'list resumable sessions in this workspace',
    run: async ctx => {
      const { listSessions } = await import('../session/sessionIndex.js')
      const sessions = await listSessions(ctx.state.workspace.root)
      if (sessions.length === 0) {
        ctx.print(style.gray('no sessions yet'))
        return
      }
      ctx.print(rule('sessions'))
      for (const session of sessions) {
        const current = session.id === ctx.runtime.sessionId
        const when = session.lastActivityAt.replace('T', ' ').slice(0, 19)
        ctx.print(
          `${current ? style.green(symbol.arrow) : ' '} ${style.bold(session.id)} ` +
            style.gray(
              `${when} · ${session.humanMessageCount} prompt(s)` +
                (current ? ' · current' : ''),
            ),
        )
        if (session.firstPrompt) {
          ctx.print(indent(style.gray(oneLine(session.firstPrompt, 70)), '    '))
        }
      }
      ctx.print(style.gray('resume another with:  agent --session <id>'))
    },
  },
  {
    name: 'compact',
    summary: 'force context compaction now',
    run: async ctx => {
      const manager = ctx.runtime.contextManager
      if (!manager) {
        ctx.print(style.gray('context management is disabled'))
        return
      }
      const before = estimateTokens(ctx.state.messages)
      const result = await manager.reactiveCompact({
        messages: ctx.state.messages,
        sessionId: ctx.runtime.sessionId,
        turnId: ctx.state.turnId,
      })
      if (result.facts.length === 0) {
        ctx.print(style.gray('nothing to compact'))
        return
      }
      let next = ctx.state
      const { reduce } = await import('../core/state.js')
      for (const fact of result.facts) {
        void ctx.runtime.journal?.append(fact, ctx.state.turnId, 'buffered')
        next = reduce(next, fact)
      }
      ctx.setState(next)
      ctx.print(
        `compacted: ~${before} ${symbol.arrow} ~${estimateTokens(next.messages)} tokens`,
      )
    },
  },
  {
    name: 'clear',
    summary: 'start a fresh conversation (journal is kept)',
    run: ctx => {
      ctx.setState({
        ...ctx.runtime.makeInitialState(),
        mode: ctx.state.mode,
        prePlanMode: ctx.state.prePlanMode,
      })
      ctx.print(style.gray('conversation cleared; history remains in the journal'))
    },
  },
  {
    name: 'config',
    summary: 'show the effective merged configuration',
    run: ctx => {
      const { rules, ...rest } = ctx.effective
      ctx.print(rule('effective config'))
      ctx.print(JSON.stringify(rest, null, 2))
      ctx.print(`permission rules: ${rules.length}`)
      if (ctx.configSource) ctx.print(style.gray(`source: ${ctx.configSource}`))
    },
  },
  {
    name: 'debug',
    args: '[on|off]',
    summary: 'toggle prompt/permission/transition tracing',
    run: (ctx, args) => {
      const target = args[0]
      const next = target ? target === 'on' || target === '1' : !ctx.debug
      ctx.setDebug(next)
      ctx.print(style.gray(`debug ${next ? 'on' : 'off'}`))
    },
  },
  {
    name: 'exit',
    summary: 'quit',
    run: ctx => ctx.requestExit(),
  },
]

const BY_NAME = new Map(COMMANDS.map(command => [command.name, command]))
const ALIASES: Record<string, string> = { quit: 'exit', q: 'exit', h: 'help', '?': 'help' }

export interface ParsedCommand {
  name: string
  args: string[]
}

/** Parse a leading-slash command line. Returns null for normal prompts. */
export function parseCommand(line: string): ParsedCommand | null {
  if (!line.startsWith('/')) return null
  const parts = line.slice(1).trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  const raw = parts[0]!.toLowerCase()
  return { name: ALIASES[raw] ?? raw, args: parts.slice(1) }
}

export function findCommand(name: string): SlashCommand | undefined {
  return BY_NAME.get(name)
}

/** Names for completion, including the slash. */
export function commandNames(): string[] {
  return COMMANDS.map(command => `/${command.name}`)
}

/**
 * Compact two-column menu shown the moment the user types "/" — discovery
 * should not require running /help first.
 */
export function commandMenuLines(): string[] {
  const entries = COMMANDS.map(command => ({
    invocation: `/${command.name}${command.args ? ` ${command.args}` : ''}`,
    summary: command.summary,
  }))
  const width = Math.max(...entries.map(entry => entry.invocation.length))
  const lines = [rule('commands')]
  for (const entry of entries) {
    lines.push(
      `  ${style.cyan(entry.invocation.padEnd(width + 2))}${style.gray(oneLine(entry.summary, 60))}`,
    )
  }
  lines.push(style.gray('  Tab completes · Ctrl+C interrupts · Ctrl+D exits'))
  return lines
}
