import type { Interface as ReadlineInterface } from 'node:readline/promises'
import type { PermissionReason } from '../core/events.js'
import type { PlanVersion } from '../planning/types.js'
import type { PolicyEngine } from '../policy/PolicyEngine.js'
import type { ToolDefinition } from '../tools/Tool.js'
import { analyzeShellCommand } from '../policy/shellPolicy.js'
import { indent, rule, style, symbol } from './theme.js'
import { summarizeToolInput } from './render.js'
import type { Spinner } from './spinner.js'

/** Human-readable explanation of a tool-policy code. */
const TOOL_POLICY_REASONS: Record<string, string> = {
  tool_ask: 'this tool changes files and needs your approval',
  tool_deny: 'the tool refused this input',
  shell_write: 'this command can modify the system',
  shell_unparseable: 'the command could not be parsed safely',
  shell_dangerous: 'the command is classified as dangerous',
  shell_not_readonly: 'only read-only commands are allowed here',
}

function describeReason(reason: PermissionReason): string {
  switch (reason.type) {
    case 'hard_safety':
      return `blocked by a hard safety rule (${reason.rule})`
    case 'user_rule':
      return `matched rule ${reason.ruleId} from ${reason.source}`
    case 'tool_policy':
      return (
        TOOL_POLICY_REASONS[reason.code] ?? `tool policy check: ${reason.code}`
      )
    case 'mode':
      return `current mode is ${reason.mode}`
    case 'interactive_required':
      return 'this action always requires a human'
    case 'default':
      return 'no rule matched, so approval is required by default'
  }
}

/**
 * A durable "always allow" proposal derived from parsed semantics, never from
 * a raw string prefix (guide §7.4). Returns null when no narrow rule is safe.
 */
function proposeSessionRule(
  tool: ToolDefinition<any, any>,
  input: unknown,
): { label: string; apply: (policy: PolicyEngine) => void } | null {
  const arg = (input ?? {}) as Record<string, unknown>

  if (tool.name === 'Shell' && typeof arg.command === 'string') {
    const analysis = analyzeShellCommand(arg.command)
    if (analysis.classification === 'unparseable' || analysis.argv.length === 0) {
      return null // cannot describe it safely, so cannot persist it
    }
    // interpreters can run anything: never persist a broad rule for them
    const head = analysis.argv[0]!.toLowerCase()
    if (['node', 'python', 'python3', 'sh', 'bash', 'powershell', 'cmd'].includes(head)) {
      return null
    }
    const prefix = analysis.argv.slice(0, 2)
    return {
      label: `Shell commands starting with "${prefix.join(' ')}"`,
      apply: policy =>
        policy.addSessionRule({
          effect: 'allow',
          tool: 'Shell',
          matcher: { kind: 'argv', value: prefix },
        }),
    }
  }

  return {
    label: `all ${tool.name} calls in this session`,
    apply: policy => policy.addSessionRule({ effect: 'allow', tool: tool.name }),
  }
}

export interface PromptDeps {
  rl: ReadlineInterface
  spinner: Spinner
  policy: PolicyEngine
  /** injectable for tests; defaults to stdout */
  write?: (text: string) => void
}

function writerOf(deps: PromptDeps): (text: string) => void {
  return deps.write ?? (text => process.stdout.write(text))
}

/**
 * Everything below waits for keyboard input on a line the spinner would
 * otherwise erase every tick, so the spinner timer must be STOPPED (not just
 * cleared) before any question is asked.
 */
function prepareForInput(deps: PromptDeps): void {
  deps.spinner.stop()
}

/** Interactive permission gate: allow once / allow for session / deny. */
export async function askPermission(
  deps: PromptDeps,
  request: { tool: ToolDefinition<any, any>; input: unknown },
  reason: PermissionReason,
): Promise<'allow' | 'deny'> {
  prepareForInput(deps)
  const write = writerOf(deps)
  const proposal = proposeSessionRule(request.tool, request.input)
  const args = summarizeToolInput(request.tool.name, request.input)

  write('\n')
  write(`${style.yellow(`${symbol.warn} permission required`)}\n`)
  write(indent(`${style.bold(request.tool.name)} ${style.gray(args)}`, '  ') + '\n')
  write(indent(style.gray(describeReason(reason)), '  ') + '\n')
  write(
    indent(
      `${style.green('[y]')} allow once   ` +
        (proposal ? `${style.cyan('[a]')} always: ${proposal.label}   ` : '') +
        `${style.red('[n]')} deny (default)`,
      '  ',
    ) + '\n',
  )

  const answer = (await deps.rl.question('  > ')).trim().toLowerCase()
  if (answer === 'y' || answer === 'yes') return 'allow'
  if ((answer === 'a' || answer === 'always') && proposal) {
    proposal.apply(deps.policy)
    write(style.gray(`  ${symbol.info} session rule added\n`))
    return 'allow'
  }
  return 'deny'
}

/** Plan approval panel: the user sees the exact persisted version. */
export async function askPlanApproval(
  deps: PromptDeps,
  plan: PlanVersion,
): Promise<boolean> {
  prepareForInput(deps)
  const write = writerOf(deps)

  write('\n')
  write(rule(`PLAN ${plan.planId} v${plan.version}`) + '\n')
  write(`${style.bold('Goal')}  ${plan.goal}\n`)

  if (plan.nonGoals.length > 0) {
    write(`${style.bold('Non-goals')}\n`)
    for (const item of plan.nonGoals) {
      write(indent(style.gray(`${symbol.bullet} ${item}`)) + '\n')
    }
  }
  if (plan.assumptions.length > 0) {
    write(`${style.bold('Assumptions')}\n`)
    for (const item of plan.assumptions) {
      write(indent(`${symbol.bullet} ${item}`) + '\n')
    }
  }
  if (plan.decisions.length > 0) {
    write(`${style.bold('Decisions')}\n`)
    for (const item of plan.decisions) {
      write(
        indent(`${symbol.bullet} ${item.decision} ${style.gray(`— ${item.rationale}`)}`) + '\n',
      )
    }
  }
  if (plan.steps.length > 0) {
    write(`${style.bold('Steps')}\n`)
    for (const [index, step] of plan.steps.entries()) {
      write(indent(`${index + 1}. ${style.bold(step.title)}`) + '\n')
      if (step.description) {
        write(indent(style.gray(step.description), '     ') + '\n')
      }
      if (step.files.length > 0) {
        write(indent(style.gray(`files: ${step.files.join(', ')}`), '     ') + '\n')
      }
    }
  }
  if (plan.acceptanceCriteria.length > 0) {
    write(`${style.bold('Acceptance criteria')}\n`)
    for (const criterion of plan.acceptanceCriteria) {
      write(
        indent(
          `${criterion.required ? style.yellow('required') : style.gray('optional')} ` +
            `${style.bold(criterion.id)} (${criterion.evidenceKind}) ${criterion.statement}`,
        ) + '\n',
      )
    }
  }
  if (plan.risks.length > 0) {
    write(`${style.bold('Risks')}\n`)
    for (const risk of plan.risks) {
      write(indent(style.yellow(`${symbol.bullet} ${risk}`)) + '\n')
    }
  }
  write(rule() + '\n')
  write(
    `${style.green('[y]')} confirm and execute   ${style.red('[n]')} reject (default)\n`,
  )

  const answer = (await deps.rl.question('  > ')).trim().toLowerCase()
  return answer === 'y' || answer === 'yes'
}

/** AskUser channel. */
export async function askUserQuestion(
  deps: PromptDeps,
  input: { question: string; options?: string[] },
): Promise<string> {
  prepareForInput(deps)
  const write = writerOf(deps)

  write('\n')
  write(`${style.cyan(`${symbol.info} the agent asks`)}\n`)
  write(indent(style.bold(input.question)) + '\n')
  if (input.options && input.options.length > 0) {
    for (const [index, option] of input.options.entries()) {
      write(indent(style.gray(`${index + 1}) ${option}`)) + '\n')
    }
  }
  const answer = await deps.rl.question('  > ')
  // numeric shortcut for option lists
  if (input.options && /^\d+$/.test(answer.trim())) {
    const picked = input.options[Number(answer.trim()) - 1]
    if (picked) return picked
  }
  return answer.trim()
}
