import type { AgentEvent, TerminalReason } from '../core/events.js'
import type { ToolCallResult } from '../core/messages.js'
import { indent, oneLine, style, symbol } from './theme.js'
import { MarkdownStreamRenderer } from './markdown.js'
import type { Spinner } from './spinner.js'
import { sanitize } from '../security/secrets.js'

/** Compact, tool-aware argument summary for the activity line. */
export function summarizeToolInput(name: string, input: unknown): string {
  const arg = (input ?? {}) as Record<string, unknown>
  const str = (key: string): string | undefined =>
    typeof arg[key] === 'string' ? (arg[key] as string) : undefined

  switch (name) {
    case 'Read':
      return str('path') ?? ''
    case 'Glob':
      return str('pattern') ?? ''
    case 'Grep':
      return [str('pattern'), str('glob') ? `in ${str('glob')}` : '']
        .filter(Boolean)
        .join(' ')
    case 'Edit':
      return str('path') ?? ''
    case 'Write':
      return str('path') ?? ''
    case 'ApplyPatch': {
      const edits = Array.isArray(arg.edits) ? arg.edits.length : 0
      const creates = Array.isArray(arg.creates) ? arg.creates.length : 0
      return `${edits} edit(s), ${creates} new file(s)`
    }
    case 'Shell':
    case 'ShellReadOnly':
      return oneLine(str('command') ?? '', 64)
    case 'AskUser':
      return oneLine(str('question') ?? '', 64)
    case 'TaskCreate':
      return oneLine(str('subject') ?? '', 48)
    case 'TaskUpdate':
      return `${str('id') ?? ''} ${symbol.arrow} ${str('status') ?? 'patch'}`
    case 'PlanPropose':
      return oneLine(str('goal') ?? '', 56)
    case 'ExitPlanMode':
      return `${str('planId') ?? ''} v${String(arg.version ?? '')}`
    default: {
      const json = JSON.stringify(arg)
      return json === '{}' ? '' : oneLine(json, 56)
    }
  }
}

/** One-line result summary extracted from the tool payload. */
function summarizeResult(result: ToolCallResult): string {
  if (!result.ok) return style.red(`${result.errorCode ?? 'error'}`)
  const content = result.content
  if (content.kind === 'externalized') {
    return style.dim(`${content.originalChars} chars → artifact`)
  }
  if (content.kind === 'text') {
    const firstLine = content.text.split('\n')[0] ?? ''
    return style.dim(oneLine(firstLine, 60))
  }
  return style.dim('ok')
}

export interface RendererOptions {
  debug: boolean
  write?: (text: string) => void
}

/**
 * Translates the engine event stream into readable terminal output.
 * Rendering never influences engine behavior — it only consumes events.
 *
 * Spinner discipline (see Spinner): streaming text has no trailing newline,
 * so the spinner timer must be fully stopped before writing it, and the
 * streamed line must be terminated before the spinner is started again.
 */
export class Renderer {
  private streaming = false
  private lastToolName = new Map<string, string>()
  /** partial (newline-less) tail of live tool output awaiting the next chunk */
  private progressPartial = ''
  private readonly write: (text: string) => void
  private readonly markdown: MarkdownStreamRenderer

  constructor(
    private readonly spinner: Spinner,
    private options: RendererOptions,
  ) {
    // SANITIZING SINK: every character reaching the terminal passes through
    // credential redaction, regardless of which event produced it.
    const rawWrite = options.write ?? (text => process.stdout.write(text))
    this.write = text => rawWrite(sanitize(text))
    this.markdown = new MarkdownStreamRenderer(text => this.write(text))
  }

  setDebug(debug: boolean): void {
    this.options = { ...this.options, debug }
  }

  /** Print a whole line, cooperating with spinner and streaming text. */
  private line(text: string): void {
    this.spinner.clear()
    this.endStream()
    this.write(`${text}\n`)
  }

  /**
   * Terminate an in-progress streamed line so the cursor owns a fresh line.
   * Any markdown still buffered (partial line, open table) is emitted first,
   * otherwise a tool activity line would swallow it.
   */
  private endStream(): void {
    if (!this.streaming) return
    this.markdown.flush()
    this.streaming = false
  }

  /** Start the spinner only after the streamed line has been closed. */
  private beginSpinner(label: string): void {
    this.spinner.clear()
    this.endStream()
    this.spinner.start(label)
  }

  info(text: string): void {
    this.line(style.gray(`${symbol.info} ${text}`))
  }

  warn(text: string): void {
    this.line(style.yellow(`${symbol.warn} ${text}`))
  }

  error(text: string): void {
    this.line(style.red(`${symbol.fail} ${text}`))
  }

  plain(text: string): void {
    this.line(text)
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'status.changed':
        if (event.phase === 'calling_model') this.beginSpinner('thinking…')
        if (event.phase === 'executing_tools') this.beginSpinner('running tools…')
        if (event.phase === 'verifying') this.beginSpinner('independent verification…')
        if (event.phase === 'preparing_context') this.spinner.setLabel('preparing context…')
        return

      case 'model.delta':
        // partial line: the spinner timer must not tick while we write it
        this.spinner.stop()
        if (!this.streaming) {
          this.write(`${style.green(symbol.agent)}\n`)
          this.streaming = true
        }
        this.markdown.push(event.text)
        return

      case 'model.thinking.delta':
        if (this.options.debug) {
          this.spinner.stop()
          this.write(style.gray(event.text))
        }
        return

      case 'prompt.manifest':
        if (this.options.debug) {
          this.line(
            style.gray(
              `  [prompt] ~${event.manifest.totalEstimatedTokens} tok · ` +
                `${event.manifest.tools.length} tools · ` +
                `${event.manifest.messages.length} msgs · mode ${event.manifest.mode}`,
            ),
          )
        }
        return

      case 'tool.call.accepted': {
        this.lastToolName.set(event.call.id, event.call.name)
        const args = summarizeToolInput(event.call.name, event.call.input)
        this.line(
          `${style.blue(symbol.agent)} ${style.bold(event.call.name)}` +
            (args ? ` ${style.gray(args)}` : ''),
        )
        return
      }

      case 'permission.decided': {
        // A denial is already reported by the tool result that follows, with
        // an error code and a hint — printing it twice is noise.
        if (this.options.debug) {
          this.line(
            style.gray(
              `  ${symbol.branch} permission ${event.decision.behavior} · ` +
                event.decision.trace
                  .map(s => `${s.stage}${s.detail ? `=${s.detail}` : ''}`)
                  .join(' > '),
            ),
          )
        }
        return
      }

      case 'tool.call.completed': {
        this.flushProgressPartial(style.dim)
        const { result } = event
        const glyph = result.ok ? style.green(symbol.ok) : style.red(symbol.fail)
        this.line(
          `  ${style.gray(symbol.branch)} ${glyph} ${summarizeResult(result)}` +
            style.gray(` (${result.durationMs}ms)`),
        )
        if (!result.ok && result.content.kind === 'json') {
          const payload = result.content.value as {
            error?: { message?: string; hint?: string }
          }
          if (payload.error?.message) {
            this.line(indent(style.red(payload.error.message), '     '))
          }
          // hints for blocked actions explain what happens next, so they are
          // always worth showing; other hints stay behind --debug
          const alwaysHint =
            result.errorCode === 'PERMISSION_DENIED' ||
            result.errorCode === 'TOOL_NOT_AVAILABLE_IN_MODE'
          if ((alwaysHint || this.options.debug) && payload.error?.hint) {
            this.line(indent(style.gray(payload.error.hint), '     '))
          }
        }
        return
      }

      case 'evidence.recorded':
        this.line(
          style.gray(
            `  ${symbol.branch} evidence ${event.receipt.id} [${event.receipt.status}]` +
              (event.receipt.criterionIds.length > 0
                ? ` → ${event.receipt.criterionIds.join(',')}`
                : ''),
          ),
        )
        return

      case 'task.changed': {
        const done = event.task.status === 'completed'
        this.line(
          `${done ? style.green(symbol.taskDone) : style.yellow(symbol.task)} ` +
            `${style.bold(event.task.id)} ${event.task.subject} ` +
            style.gray(`[${event.task.status}]`),
        )
        return
      }

      case 'plan.version.created':
        if (event.plan.status !== 'approved') {
          this.line(
            `${style.magenta(symbol.plan)} plan ${event.plan.planId} v${event.plan.version} drafted`,
          )
        }
        return

      case 'plan.approved':
        this.line(
          style.green(
            `${symbol.ok} plan ${event.planId} v${event.version} approved`,
          ),
        )
        return

      case 'mode.changed':
        this.line(
          style.gray(`${symbol.info} mode ${event.from} ${symbol.arrow} ${event.to}`),
        )
        return

      case 'context.compacted':
        this.line(
          style.gray(
            `${symbol.info} context compacted (${event.record.kind}): ` +
              `${event.record.tokensBefore} ${symbol.arrow} ${event.record.tokensAfter} tok`,
          ),
        )
        return

      case 'verification.completed': {
        const verdict = event.report.verdict
        const paint =
          verdict === 'PASS' ? style.green : verdict === 'FAIL' ? style.red : style.yellow
        this.line(`${paint(`${symbol.plan} verification: ${verdict}`)} ${style.gray(event.report.summary)}`)
        for (const failure of event.report.failures) {
          this.line(indent(style.red(`${symbol.bullet} [${failure.severity}] ${failure.title}`), '  '))
        }
        for (const item of event.report.unverified) {
          this.line(indent(style.yellow(`${symbol.bullet} unverified: ${item.item} (${item.reason})`), '  '))
        }
        return
      }

      case 'loop.transitioned':
        if (this.options.debug) {
          this.line(style.gray(`  ${symbol.arrow} continue: ${event.transition.reason}`))
        }
        return

      case 'replan.adjustment.applied':
        this.line(
          style.yellow(
            `${symbol.plan} replan adjusted (${event.cause}): ${oneLine(event.summary, 80)}`,
          ),
        )
        return

      case 'tool.progress': {
        // live tool output (shell streaming): write complete lines now,
        // buffer a trailing partial line until the next chunk arrives
        this.spinner.stop()
        this.endStream()
        const paint = event.data.stream === 'stderr' ? style.yellow : style.dim
        const text = this.progressPartial + event.data.text
        const lastNewline = text.lastIndexOf('\n')
        if (lastNewline >= 0) {
          this.write(indent(paint(text.slice(0, lastNewline)), '  '))
          this.write('\n')
          this.progressPartial = text.slice(lastNewline + 1)
        } else {
          this.progressPartial = text
        }
        // backpressure for slow terminals: never let a partial line grow
        // unbounded when the producer outpaces us without newlines
        if (this.progressPartial.length > 8_000) {
          this.progressPartial = '…' + this.progressPartial.slice(-4_000)
        }
        return
      }

      case 'run.terminated':
        this.spinner.stop()
        this.flushProgressPartial(style.dim)
        this.renderTerminal(event.terminal)
        return

      default:
        return
    }
  }

  /** Emit any newline-less tail of live tool output (interrupted runs too). */
  private flushProgressPartial(paint: (text: string) => string): void {
    if (this.progressPartial.length === 0) return
    this.spinner.clear()
    this.write(indent(paint(this.progressPartial), '  ') + '\n')
    this.progressPartial = ''
  }

  private renderTerminal(terminal: TerminalReason): void {
    switch (terminal.reason) {
      case 'completed':
        // clean finish: the assistant text is the answer, no noise needed
        this.line('')
        return
      case 'completed_with_unverified_items':
        this.line('')
        this.warn(`finished with unverified items:`)
        for (const item of terminal.items) {
          this.line(indent(style.yellow(`${symbol.bullet} ${item}`), '  '))
        }
        return
      case 'aborted':
        this.line('')
        this.warn(`interrupted at ${terminal.at}`)
        return
      case 'max_turns':
        this.line('')
        this.warn(`stopped: turn limit reached (${terminal.turns}). Use /config to raise maxTurns.`)
        return
      case 'budget_exhausted':
        this.line('')
        this.warn(`stopped: ${terminal.kind} budget exhausted`)
        return
      case 'prompt_too_long':
        this.line('')
        this.error('context too long even after compaction — try /clear')
        return
      case 'model_error':
        this.line('')
        this.error(`model error: ${terminal.code}`)
        return
      case 'permission_denied':
        this.line('')
        this.warn(`stopped: permission denied for ${terminal.callId}`)
        return
      case 'invariant_violation':
        this.line('')
        this.error(`internal invariant violated: ${terminal.invariant}`)
        return
      default:
        this.line('')
        this.warn(`stopped: ${JSON.stringify(terminal)}`)
    }
  }

  /** Ensure the cursor is on a fresh line before the next prompt. */
  finishTurn(): void {
    this.spinner.stop()
    this.endStream()
  }
}
