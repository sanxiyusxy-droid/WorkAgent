import type { AgentMode } from '../core/events.js'

export const MODE_NAMES: AgentMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
]

export interface CliArgs {
  /** sub-command; undefined means "start a session" */
  command?: 'setup' | 'new' | 'help' | 'version' | 'sessions'
  /** workspace directory (created when missing) */
  dir?: string
  configPath?: string
  mode?: AgentMode
  session?: string
  /** resume the most recent session in the workspace */
  continueLatest: boolean
  /**
   * opt in to degraded recovery: skip corrupt journal facts and continue in
   * a read-only recovery branch. Without this flag, recovery is strict and
   * a corrupt journal refuses to resume (exit code 2).
   */
  allowDegraded: boolean
  debug?: boolean
  /** one-shot prompt: run it, print the answer, exit */
  print?: string
  errors: string[]
}

const FLAGS_WITH_VALUE = new Set([
  '-C',
  '--dir',
  '--cwd',
  '--config',
  '--mode',
  '--session',
  '--print',
  '-p',
])

/**
 * Dependency-free argv parser. Unknown flags are reported instead of ignored
 * so typos never silently change behavior.
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { continueLatest: false, allowDegraded: false, errors: [] }
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!

    if (!token.startsWith('-')) {
      positionals.push(token)
      continue
    }

    // support --flag=value
    const eq = token.indexOf('=')
    let flag = token
    let inlineValue: string | undefined
    if (eq !== -1) {
      flag = token.slice(0, eq)
      inlineValue = token.slice(eq + 1)
    }

    const readValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[i + 1]
      if (next === undefined || (next.startsWith('-') && next.length > 1)) {
        args.errors.push(`${flag} requires a value`)
        return undefined
      }
      i += 1
      return next
    }

    switch (flag) {
      case '-h':
      case '--help':
        args.command = 'help'
        break
      case '-v':
      case '--version':
        args.command = 'version'
        break
      case '-C':
      case '--dir':
      case '--cwd': {
        const value = readValue()
        if (value) args.dir = value
        break
      }
      case '--config': {
        const value = readValue()
        if (value) args.configPath = value
        break
      }
      case '--mode': {
        const value = readValue()
        if (value) {
          if (MODE_NAMES.includes(value as AgentMode)) {
            args.mode = value as AgentMode
          } else {
            args.errors.push(
              `unknown mode "${value}" (expected: ${MODE_NAMES.join(', ')})`,
            )
          }
        }
        break
      }
      case '--session': {
        const value = readValue()
        if (value) args.session = value
        break
      }
      case '-c':
      case '--continue':
        args.continueLatest = true
        break
      case '--allow-degraded':
        args.allowDegraded = true
        break
      case '--debug':
        args.debug = true
        break
      case '--no-debug':
        args.debug = false
        break
      case '--sessions':
      case '--list-sessions':
        args.command = 'sessions'
        break
      case '-p':
      case '--print': {
        const value = readValue()
        if (value) args.print = value
        break
      }
      case '--yes':
      case '-y':
        args.mode = 'acceptEdits'
        break
      default:
        args.errors.push(`unknown option: ${flag}`)
    }
    if (FLAGS_WITH_VALUE.has(flag) && inlineValue === '') {
      args.errors.push(`${flag} requires a value`)
    }
  }

  // sub-commands come from positionals
  const head = positionals[0]
  if (head === 'setup') {
    args.command = 'setup'
  } else if (head === 'sessions') {
    args.command = 'sessions'
  } else if (head === 'new') {
    args.command = 'new'
    const target = positionals[1]
    if (!target) {
      args.errors.push('`new` requires a directory name')
    } else {
      args.dir = target
    }
  } else if (head === 'help') {
    args.command = 'help'
  } else if (head !== undefined && args.command === undefined) {
    // bare positional is treated as a one-shot prompt for convenience
    args.print = positionals.join(' ')
  }

  return args
}

export function helpText(binaryName = 'code-agent'): string {
  return `${binaryName} — a resumable coding agent

USAGE
  ${binaryName}                        start an interactive session in the current folder
  ${binaryName} new <dir>              create <dir> and start a session there
  ${binaryName} setup                  configure provider, API key and model
  ${binaryName} sessions               list resumable sessions in this folder
  ${binaryName} "<prompt>"             run one prompt, print the answer, exit
  ${binaryName} --help | --version

OPTIONS
  -C, --dir <path>       workspace directory (created if missing)
      --config <path>    use a specific config file
      --mode <mode>      ${MODE_NAMES.join(' | ')}
  -y, --yes              shortcut for --mode acceptEdits
      --session <id>     resume a specific session
  -c, --continue         resume the most recent session that has a conversation
      --allow-degraded   resume a corrupt journal anyway: fork a read-only
                         recovery branch (default: strict, refuses with exit 2)
      --sessions         list resumable sessions and exit
  -p, --print <prompt>   non-interactive single turn
      --debug            show prompt manifests, permission traces, transitions

CONFIG PRECEDENCE
  environment variables > --config > <workspace>/agent.config.json
  > ~/.code-agent/config.json > installation directory

IN-SESSION COMMANDS
  /help /mode /model /tasks /plan /evidence /metrics /session /compact
  /clear /config /debug /exit          (Tab completes, Ctrl+C interrupts)
`
}
