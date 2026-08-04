/**
 * Terminal styling. Zero dependencies, honors NO_COLOR and non-TTY output.
 */
const enabled =
  process.stdout.isTTY === true &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb'

function wrap(open: string, close: string) {
  return (text: string): string => (enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text)
}

export const style = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  italic: wrap('3', '23'),
  underline: wrap('4', '24'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  gray: wrap('90', '39'),
  bgYellow: wrap('43', '49'),
  bgRed: wrap('41', '49'),
  bgBlue: wrap('44', '49'),
}

export const colorEnabled = enabled

/** Unicode symbols with ASCII fallback for legacy Windows consoles. */
const fancy = enabled && process.env.AGENT_ASCII !== '1'

export const symbol = {
  user: fancy ? '❯' : '>',
  agent: fancy ? '⏺' : '*',
  branch: fancy ? '⎿' : '  \\',
  ok: fancy ? '✔' : 'ok',
  fail: fancy ? '✘' : 'x',
  warn: fancy ? '⚠' : '!',
  info: fancy ? 'ℹ' : 'i',
  plan: fancy ? '◆' : '#',
  task: fancy ? '☐' : '[ ]',
  taskDone: fancy ? '☑' : '[x]',
  arrow: fancy ? '→' : '->',
  bullet: fancy ? '•' : '-',
  spinnerFrames: fancy
    ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    : ['-', '\\', '|', '/'],
}

export const MODE_COLORS: Record<string, (text: string) => string> = {
  default: style.cyan,
  acceptEdits: style.green,
  plan: style.magenta,
  dontAsk: style.yellow,
  bypassPermissions: style.red,
}

export function modeLabel(mode: string): string {
  const paint = MODE_COLORS[mode] ?? style.cyan
  return paint(mode)
}

export function terminalWidth(): number {
  return process.stdout.columns && process.stdout.columns > 20
    ? process.stdout.columns
    : 80
}

/** Single-line box header, e.g. ── PLAN plan_1 v1 ─────────── */
export function rule(label?: string): string {
  const width = Math.min(terminalWidth(), 100)
  if (!label) return style.gray('─'.repeat(width))
  const text = ` ${label} `
  const left = 2
  const right = Math.max(0, width - left - text.length)
  return style.gray('─'.repeat(left)) + style.bold(text) + style.gray('─'.repeat(right))
}

/** Indent every line of a block of text. */
export function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map(line => prefix + line)
    .join('\n')
}

/** Truncate to a single line of at most `max` chars. */
export function oneLine(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
