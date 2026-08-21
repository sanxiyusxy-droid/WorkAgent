/**
 * Conservative shell command analysis (Phase A from the guide).
 * This is intentionally NOT a full shell AST. Anything we cannot parse
 * with confidence is classified as 'unparseable' and treated as high risk.
 * A regex allowlist is never a security boundary — so the allowlist here
 * only accepts simple argv commands with no shell metacharacters.
 *
 * Phase B additions:
 * - dangerous argument detection: commands that look read-only but carry
 *   destructive flags (git branch -D, find -delete, chmod in argv, etc.)
 * - environment variable sanitization for child processes
 */

export interface ShellAnalysis {
  classification: 'readonly' | 'write' | 'dangerous' | 'unparseable'
  argv: string[]
  reason?: string
}

/** Shell metacharacters that make single-argv parsing unreliable. */
const METACHARACTERS = /[|&;<>$`\\\n()*?~#{}!]/

/** Audited read-only commands (first argv token). */
const READONLY_COMMANDS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'pwd', 'whoami',
  'echo', 'date', 'grep', 'rg', 'which', 'where', 'file', 'stat', 'du', 'df',
  'node', // only with --version / -v (checked below)
  'npm', // only with read-only subcommands (checked below)
  'git', // only with read-only subcommands (checked below)
])

const GIT_READONLY_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'ls-files', 'blame', 'rev-parse',
])

/**
 * git subcommands that are structurally read-only but become destructive
 * with certain flags. We classify these as 'write' unless all args are safe.
 */
const GIT_CONDITIONAL_SUBCOMMANDS: Record<string, { safeFlags: Set<string>; dangerousFlags: Set<string> }> = {
  branch: {
    safeFlags: new Set(['-a', '-r', '-v', '--list', '--all', '--remotes', '--verbose', '--contains', '--merged', '--no-merged']),
    dangerousFlags: new Set(['-D', '-d', '--delete', '--force']),
  },
  stash: {
    safeFlags: new Set(['list', 'show']),
    dangerousFlags: new Set(['drop', 'clear', 'pop', 'apply']),
  },
  tag: {
    safeFlags: new Set(['-l', '--list', '-n', '-v', '--verify']),
    dangerousFlags: new Set(['-d', '--delete']),
  },
}

const NPM_READONLY_SUBCOMMANDS = new Set(['ls', 'view', 'outdated', 'ping'])

/** First tokens that are always dangerous regardless of arguments. */
const DANGEROUS_COMMANDS = new Set([
  'rm', 'rmdir', 'del', 'erase', 'format', 'mkfs', 'dd', 'shutdown', 'reboot',
  'chown', 'chmod', 'icacls', 'takeown', 'reg', 'sc', 'schtasks',
  'curl', 'wget', 'invoke-webrequest', 'iwr',
  'eval', 'exec', 'source',
  'rd', 'move', 'ren', 'rename', // Windows destructive
])

/**
 * Arguments that turn an otherwise innocent command into a destructive one.
 * Keyed by the first argv token (command name).
 */
const DANGEROUS_ARGUMENTS: Record<string, Set<string>> = {
  find: new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir']),
  git: new Set(['--force', '-f', '--hard', '--force-with-lease']),
  npm: new Set(['--force', '-f']),
}

/**
 * Environment variables child processes may inherit. Everything else is
 * dropped — allowlist, not blocklist. The list contains only variables that
 * are required for basic shell/tool operation and carry no credentials and
 * no runtime injection vectors (NODE_OPTIONS, LD_PRELOAD, BASH_ENV, ...).
 *
 * Additional variables can be permitted via AGENT_ENV_ALLOW (comma-separated
 * names) in the AGENT process environment — useful for CI matrices.
 */
const ALLOWED_ENV_VARS = new Set([
  // path resolution
  'PATH', 'PATHEXT', 'PWD',
  // platform basics (Windows)
  'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEPATH', 'HOMEDRIVE',
  'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'WINDIR',
  // platform basics (Unix)
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'HOSTNAME',
  // safe runtime hints
  'CI', 'TZ', 'EDITOR', 'SHLVL',
])

/**
 * Build a sanitized environment for child processes from an allowlist.
 * Credentials and injection vectors cannot survive because anything not
 * explicitly listed is dropped.
 */
export function sanitizedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  // operator extension: AGENT_ENV_ALLOW=name1,name2
  const extraAllow = (base.AGENT_ENV_ALLOW ?? '')
    .split(',')
    .map(name => name.trim().toUpperCase())
    .filter(Boolean)
  const allowed = new Set([...ALLOWED_ENV_VARS, ...extraAllow])
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (!allowed.has(key.toUpperCase())) continue
    clean[key] = value
  }
  return clean
}

export function analyzeShellCommand(command: string): ShellAnalysis {
  const trimmed = command.trim()
  if (trimmed.length === 0) {
    return { classification: 'unparseable', argv: [], reason: 'empty command' }
  }
  if (METACHARACTERS.test(trimmed)) {
    return {
      classification: 'unparseable',
      argv: [],
      reason: 'contains shell metacharacters (pipes, redirects, substitution...)',
    }
  }

  const argv = tokenize(trimmed)
  if (!argv || argv.length === 0) {
    return { classification: 'unparseable', argv: [], reason: 'tokenize failed' }
  }

  const head = argv[0]!.toLowerCase()

  if (DANGEROUS_COMMANDS.has(head)) {
    return { classification: 'dangerous', argv, reason: `dangerous command: ${head}` }
  }

  if (head === 'git') {
    const sub = argv[1]?.toLowerCase()
    const args = argv.slice(2)
    const outputBearing = args.some(arg =>
      arg === '--output' ||
      arg.startsWith('--output=') ||
      arg === '--ext-diff' ||
      arg === '--textconv',
    )
    if (outputBearing) {
      return {
        classification: 'write',
        argv,
        reason: `git ${sub ?? ''} may write output or execute a diff helper`,
      }
    }
    if (sub === 'remote') {
      const readonlyRemote =
        args.length === 0 ||
        (args.length === 1 && args[0] === '-v') ||
        (args[0] === 'show' && args.slice(1).every(arg => !arg.startsWith('-')))
      return readonlyRemote
        ? { classification: 'readonly', argv }
        : { classification: 'write', argv, reason: 'git remote mutation' }
    }
    if (sub && GIT_READONLY_SUBCOMMANDS.has(sub)) {
      return { classification: 'readonly', argv }
    }
    // Conditional subcommands are read-only only for an explicit small argv
    // grammar. Positional names such as `git branch new` / `git tag v1` write.
    if (sub && GIT_CONDITIONAL_SUBCOMMANDS[sub]) {
      const { safeFlags, dangerousFlags } = GIT_CONDITIONAL_SUBCOMMANDS[sub]
      const hasDangerous = args.some(arg => dangerousFlags.has(arg))
      if (hasDangerous) {
        return {
          classification: 'write',
          argv,
          reason: `git ${sub} with destructive flag`,
        }
      }
      const readonlyConditional = sub === 'stash'
        ? args.length > 0 && (args[0] === 'list' || args[0] === 'show')
        : args.length === 0 || args.every(arg => safeFlags.has(arg))
      return readonlyConditional
        ? { classification: 'readonly', argv }
        : { classification: 'write', argv, reason: `git ${sub} may mutate refs or state` }
    }
    return { classification: 'write', argv, reason: `git ${sub ?? ''} may write` }
  }

  if (head === 'npm' || head === 'npm.cmd') {
    const sub = argv[1]?.toLowerCase()
    if (sub && NPM_READONLY_SUBCOMMANDS.has(sub)) {
      return { classification: 'readonly', argv }
    }
    return { classification: 'write', argv, reason: `npm ${sub ?? ''} may write` }
  }

  if (head === 'node') {
    const arg = argv[1]?.toLowerCase()
    if (arg === '--version' || arg === '-v') {
      return { classification: 'readonly', argv }
    }
    return { classification: 'write', argv, reason: 'node executes arbitrary code' }
  }

  // check dangerous arguments on otherwise read-only commands
  if (head === 'find') {
    const dangerousArg = argv.slice(1).find(arg =>
      DANGEROUS_ARGUMENTS['find']!.has(arg) ||
      arg === '-fprint' ||
      arg === '-fprint0' ||
      arg === '-fprintf' ||
      arg === '-fls',
    )
    if (dangerousArg) {
      return {
        classification: 'dangerous',
        argv,
        reason: `find with destructive argument: ${dangerousArg}`,
      }
    }
    return { classification: 'readonly', argv }
  }

  if (head === 'rg') {
    const unsafe = argv.slice(1).find(arg =>
      arg === '--pre' || arg.startsWith('--pre='),
    )
    if (unsafe) {
      return {
        classification: 'dangerous',
        argv,
        reason: `rg may execute a preprocessor: ${unsafe}`,
      }
    }
  }

  if (head === 'date') {
    const args = argv.slice(1)
    const readonlyDate = args.length === 0 || args.every(arg =>
      arg === '/T' ||
      arg === '-u' ||
      arg === '--utc' ||
      arg === '--universal' ||
      arg === '-R' ||
      arg === '--rfc-email' ||
      arg.startsWith('+') ||
      arg.startsWith('--iso-8601=') ||
      arg.startsWith('--rfc-3339=') ||
      arg.startsWith('--date=') ||
      arg.startsWith('--reference='),
    )
    if (!readonlyDate) {
      return {
        classification: 'dangerous',
        argv,
        reason: 'date arguments are outside the audited read-only grammar',
      }
    }
  }

  if (head === 'file') {
    const compileFlag = argv.slice(1).find(arg =>
      arg === '--compile' ||
      (/^-[^-]+$/.test(arg) && arg.slice(1).includes('C')),
    )
    if (compileFlag) {
      return {
        classification: 'dangerous',
        argv,
        reason: `file may compile and write a magic database: ${compileFlag}`,
      }
    }
  }

  if (READONLY_COMMANDS.has(head)) {
    return { classification: 'readonly', argv }
  }

  return { classification: 'write', argv }
}

/** Simple quote-aware tokenizer. Returns null when quoting is unbalanced. */
function tokenize(input: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ' ' || char === '\t') {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (quote) return null
  if (current.length > 0) tokens.push(current)
  return tokens
}
