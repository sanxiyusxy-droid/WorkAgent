import { colorEnabled, style, symbol, terminalWidth } from './theme.js'

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

/** Ranges that occupy two terminal columns (CJK, fullwidth forms, emoji). */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, Kangxi, punctuation
    (code >= 0x3041 && code <= 0x33ff) || // Hiragana, Katakana, CJK compat
    (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compat ideographs
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK compat forms
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) || // emoji
    (code >= 0x1f900 && code <= 0x1f9ff)
  )
}

/**
 * Terminal columns occupied by a string, ignoring ANSI escapes.
 * Table alignment depends on this: CJK characters take two columns, so
 * counting `.length` would misalign every Chinese table.
 */
export function displayWidth(text: string): number {
  const plain = text.replace(ANSI_PATTERN, '')
  let width = 0
  for (const char of plain) {
    const code = char.codePointAt(0)!
    if (code === 0x0a || code === 0x0d) continue
    // combining marks add no width
    if (code >= 0x0300 && code <= 0x036f) continue
    width += isWide(code) ? 2 : 1
  }
  return width
}

/** Pad to a target column count using display width. */
function padTo(text: string, target: number, align: Align): string {
  const gap = Math.max(0, target - displayWidth(text))
  if (align === 'right') return ' '.repeat(gap) + text
  if (align === 'center') {
    const left = Math.floor(gap / 2)
    return ' '.repeat(left) + text + ' '.repeat(gap - left)
  }
  return text + ' '.repeat(gap)
}

/** Truncate to a column budget, appending an ellipsis when cut. */
function truncateToWidth(text: string, max: number): string {
  if (displayWidth(text) <= max) return text
  let out = ''
  let width = 0
  for (const char of text.replace(ANSI_PATTERN, '')) {
    const charWidth = isWide(char.codePointAt(0)!) ? 2 : 1
    if (width + charWidth > max - 1) break
    out += char
    width += charWidth
  }
  return `${out}…`
}

/**
 * Inline markdown: bold, italic, inline code, strikethrough, links.
 * Applied per line, so it never spans block boundaries.
 */
export function renderInline(text: string): string {
  if (!colorEnabled) {
    // strip emphasis markers so plain output stays readable
    return text
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  }
  return (
    text
      // inline code first: its content must not be re-parsed for emphasis
      .replace(/`([^`]+)`/g, (_, code: string) => style.cyan(code))
      .replace(/\*\*([^*]+)\*\*/g, (_, inner: string) => style.bold(inner))
      .replace(/__([^_]+)__/g, (_, inner: string) => style.bold(inner))
      .replace(/~~([^~]+)~~/g, (_, inner: string) => style.gray(inner))
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, (_, lead: string, inner: string) =>
        `${lead}${style.italic(inner)}`,
      )
      .replace(/(^|[\s(])_([^_\s][^_]*)_/g, (_, lead: string, inner: string) =>
        `${lead}${style.italic(inner)}`,
      )
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_, label: string, url: string) => `${style.underline(label)} ${style.gray(url)}`,
      )
  )
}

type Align = 'left' | 'right' | 'center'

export function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.includes('|', 1)
}

function isTableSeparator(line: string): boolean {
  const cells = splitRow(line)
  return cells.length > 0 && cells.every(cell => /^:?-{1,}:?$/.test(cell.trim()))
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(cell => cell.trim())
}

/**
 * Render a markdown table as an aligned box. Column widths use display width,
 * so CJK content lines up correctly.
 */
export function renderTable(lines: string[]): string[] {
  const rows: string[][] = []
  let aligns: Align[] = []

  for (const line of lines) {
    if (isTableSeparator(line)) {
      aligns = splitRow(line).map(cell => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'right'
        return 'left'
      })
      continue
    }
    rows.push(splitRow(line))
  }
  if (rows.length === 0) return []

  const columns = Math.max(...rows.map(row => row.length))
  const normalized = rows.map(row => {
    const filled = [...row]
    while (filled.length < columns) filled.push('')
    return filled
  })

  // rendered cell content (inline markdown applied before measuring)
  const rendered = normalized.map(row => row.map(cell => renderInline(cell)))

  let widths = Array.from({ length: columns }, (_, index) =>
    Math.max(...rendered.map(row => displayWidth(row[index] ?? ''))),
  )

  // keep the table inside the terminal: shrink the widest columns first
  const budget = Math.min(terminalWidth(), 120) - (columns * 3 + 1)
  let total = widths.reduce((sum, width) => sum + width, 0)
  while (total > budget && budget > columns) {
    const widest = widths.indexOf(Math.max(...widths))
    widths[widest] = Math.max(3, widths[widest]! - 1)
    const next = widths.reduce((sum, width) => sum + width, 0)
    if (next === total) break // cannot shrink further
    total = next
  }

  const line = (left: string, mid: string, right: string): string =>
    style.gray(left + widths.map(width => '─'.repeat(width + 2)).join(mid) + right)

  const body = (cells: string[]): string => {
    const painted = cells.map((cell, index) =>
      padTo(truncateToWidth(cell, widths[index]!), widths[index]!, aligns[index] ?? 'left'),
    )
    return `${style.gray('│')} ${painted.join(` ${style.gray('│')} `)} ${style.gray('│')}`
  }

  const out: string[] = [line('┌', '┬', '┐')]
  const [header, ...rest] = rendered
  if (header) {
    out.push(body(header.map(cell => (colorEnabled ? style.bold(cell) : cell))))
    out.push(line('├', '┼', '┤'))
  }
  for (const row of rest) out.push(body(row))
  out.push(line('└', '┴', '┘'))
  return out
}

/** Heading, list, quote and rule rendering for one standalone line. */
function renderBlockLine(line: string): string {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line)
  if (heading) {
    const level = heading[1]!.length
    const text = renderInline(heading[2]!)
    if (level <= 2) {
      const width = Math.min(displayWidth(text), Math.min(terminalWidth(), 100))
      return `\n${style.bold(style.cyan(text))}\n${style.gray('─'.repeat(width))}`
    }
    return `\n${style.bold(style.cyan(text))}`
  }

  if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
    return style.gray('─'.repeat(Math.min(terminalWidth(), 60)))
  }

  const quote = /^>\s?(.*)$/.exec(line)
  if (quote) {
    return `${style.gray('│')} ${style.gray(renderInline(quote[1]!))}`
  }

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
  if (bullet) {
    return `${bullet[1]}${style.cyan(symbol.bullet)} ${renderInline(bullet[2]!)}`
  }

  const ordered = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line)
  if (ordered) {
    return `${ordered[1]}${style.cyan(`${ordered[2]}.`)} ${renderInline(ordered[4]!)}`
  }

  return renderInline(line)
}

/**
 * Streaming markdown renderer.
 *
 * Model output arrives in arbitrary chunks, but markdown is line- and
 * block-oriented. Complete lines are rendered immediately; a trailing partial
 * line is held until its newline arrives (or `flush()` is called). Fenced code
 * blocks and tables are buffered until the block ends because they cannot be
 * rendered line by line.
 */
export class MarkdownStreamRenderer {
  private pending = ''
  private table: string[] = []
  private code: string[] | null = null
  private codeLang = ''
  private latex = false

  constructor(private readonly write: (text: string) => void) {}

  /** True when nothing is buffered and nothing has been emitted this block. */
  get isIdle(): boolean {
    return this.pending === '' && this.table.length === 0 && this.code === null
  }

  push(chunk: string): void {
    this.pending += chunk
    let newline = this.pending.indexOf('\n')
    while (newline !== -1) {
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      this.handleLine(line)
      newline = this.pending.indexOf('\n')
    }
  }

  /** Emit everything buffered, including an unterminated last line. */
  flush(): void {
    this.closeTable()
    if (this.code) {
      // unterminated fence: emit what we have so nothing is lost
      this.emitCode()
    }
    if (this.pending.length > 0) {
      this.write(`${renderBlockLine(this.pending)}\n`)
      this.pending = ''
    }
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.replace(/\r$/, '')

    // fenced code block start/end
    const fence = /^\s*```(.*)$/.exec(line)
    if (fence) {
      if (this.code) {
        this.emitCode()
      } else {
        this.closeTable()
        this.code = []
        this.codeLang = fence[1]!.trim()
      }
      return
    }
    if (this.code) {
      this.code.push(line)
      return
    }

    // LaTeX display blocks: shown verbatim, dimmed, never parsed as markdown
    if (/^\s*\\\[/.test(line)) {
      this.closeTable()
      this.latex = true
      this.write(`${style.gray(`  ${line.replace(/^\s*\\\[\s*/, '')}`)}\n`)
      return
    }
    if (this.latex) {
      if (/\\\]/.test(line)) {
        this.latex = false
        const content = line.replace(/\s*\\\]\s*$/, '')
        if (content.trim()) this.write(`${style.gray(`  ${content}`)}\n`)
      } else {
        this.write(`${style.gray(`  ${line}`)}\n`)
      }
      return
    }

    // tables are buffered until the block ends
    if (isTableRow(line)) {
      this.table.push(line)
      return
    }
    this.closeTable()

    this.write(`${renderBlockLine(line)}\n`)
  }

  private closeTable(): void {
    if (this.table.length === 0) return
    const lines = renderTable(this.table)
    this.table = []
    for (const line of lines) this.write(`${line}\n`)
  }

  private emitCode(): void {
    const lines = this.code ?? []
    this.code = null
    const bar = style.gray('│')
    if (this.codeLang) {
      this.write(`${style.gray(`\`\`\`${this.codeLang}`)}\n`)
    }
    for (const line of lines) {
      this.write(`${bar} ${colorEnabled ? style.dim(line) : line}\n`)
    }
    this.codeLang = ''
  }
}
