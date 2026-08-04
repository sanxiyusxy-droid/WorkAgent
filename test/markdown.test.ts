import { describe, expect, test } from 'vitest'
import {
  MarkdownStreamRenderer,
  displayWidth,
  isTableRow,
  renderInline,
  renderTable,
} from '../src/cli/markdown.js'
import { colorEnabled, symbol } from '../src/cli/theme.js'

/** Collect renderer output. */
function collect(): { write: (t: string) => void; lines: () => string[]; raw: () => string } {
  const chunks: string[] = []
  return {
    write: text => chunks.push(text),
    lines: () => chunks.join('').split('\n'),
    raw: () => chunks.join(''),
  }
}

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '')

describe('displayWidth', () => {
  test('ASCII counts one column per character', () => {
    expect(displayWidth('hello')).toBe(5)
  })

  test('CJK characters count two columns', () => {
    expect(displayWidth('景点')).toBe(4)
    expect(displayWidth('荔波小七孔')).toBe(10)
  })

  test('mixed text adds up correctly', () => {
    expect(displayWidth('abc景点')).toBe(7)
  })

  test('ANSI escapes are ignored', () => {
    expect(displayWidth('\u001b[1mhello\u001b[22m')).toBe(5)
  })
})

describe('renderInline', () => {
  test('inline code, bold and links are handled', () => {
    const out = renderInline('use `npm test` and **read** [docs](http://x)')
    expect(strip(out)).toContain('npm test')
    expect(strip(out)).toContain('read')
    expect(strip(out)).toContain('docs')
    expect(strip(out)).toContain('http://x')
    // markers themselves are consumed
    expect(strip(out)).not.toContain('**')
    expect(strip(out)).not.toContain('`')
  })

  test('underscores inside identifiers are not treated as italics', () => {
    expect(strip(renderInline('call some_function_name here'))).toBe(
      'call some_function_name here',
    )
  })
})

describe('renderTable', () => {
  const table = [
    '| 景点 | 特点 | 时长 |',
    '|------|------|------|',
    '| 荔波小七孔 | 世界自然遗产 | 4-5小时 |',
    '| 西江千户苗寨 | 吊脚楼群 | 1天 |',
  ]

  test('every rendered row has identical display width (CJK aligned)', () => {
    const lines = renderTable(table)
    expect(lines.length).toBe(table.length + 2) // 3 borders + 3 content rows
    const widths = new Set(lines.map(line => displayWidth(line)))
    expect(widths.size).toBe(1)
  })

  test('cell content survives and borders are drawn', () => {
    const raw = strip(renderTable(table).join('\n'))
    expect(raw).toContain('荔波小七孔')
    expect(raw).toContain('世界自然遗产')
    expect(raw).toContain('┌')
    expect(raw).toContain('┼')
    expect(raw).toContain('└')
  })

  test('ragged rows are padded to the widest row', () => {
    const lines = renderTable(['| a | b | c |', '|---|---|---|', '| 1 |'])
    const widths = new Set(lines.map(line => displayWidth(line)))
    expect(widths.size).toBe(1)
  })

  test('alignment markers are accepted without breaking layout', () => {
    const lines = renderTable([
      '| left | mid | right |',
      '|:-----|:---:|------:|',
      '| a | b | c |',
    ])
    const widths = new Set(lines.map(line => displayWidth(line)))
    expect(widths.size).toBe(1)
  })

  test('isTableRow only matches pipe-delimited rows', () => {
    expect(isTableRow('| a | b |')).toBe(true)
    expect(isTableRow('  | a | b |  ')).toBe(true)
    expect(isTableRow('a | b')).toBe(false)
    expect(isTableRow('plain text')).toBe(false)
  })
})

describe('MarkdownStreamRenderer', () => {
  test('headings get a visual break and keep their text', () => {
    const out = collect()
    const md = new MarkdownStreamRenderer(out.write)
    md.push('## 矩阵秩的性质\n')
    md.flush()
    expect(strip(out.raw())).toContain('矩阵秩的性质')
    expect(strip(out.raw())).not.toContain('##')
  })

  test('lists are rendered with the theme bullet and numbers preserved', () => {
    const out = collect()
    const md = new MarkdownStreamRenderer(out.write)
    md.push('- first\n- second\n1. one\n2. two\n')
    md.flush()
    const lines = strip(out.raw()).split('\n').filter(Boolean)
    // unordered items use the theme bullet (ASCII "-" when symbols are off)
    expect(lines[0]).toBe(`${symbol.bullet} first`)
    expect(lines[1]).toBe(`${symbol.bullet} second`)
    // ordered items keep their numbering, normalized to "N."
    expect(lines[2]).toBe('1. one')
    expect(lines[3]).toBe('2. two')
  })

  test('nested list indentation is preserved', () => {
    const out = collect()
    const md = new MarkdownStreamRenderer(out.write)
    md.push('- top\n  - nested\n')
    md.flush()
    const lines = strip(out.raw()).split('\n')
    expect(lines[1]).toBe(`  ${symbol.bullet} nested`)
  })

  test('fenced code blocks are buffered and emitted with a side bar', () => {
    const out = collect()
    const md = new MarkdownStreamRenderer(out.write)
    md.push('```ts\nconst a = 1\nconst b = 2\n```\n')
    md.flush()
    const raw = strip(out.raw())
    expect(raw).toContain('const a = 1')
    expect(raw).toContain('const b = 2')
    expect(raw).toContain('│')
  })

  test('an unterminated code fence still emits its content on flush', () => {
    const out = collect()
    const md = new MarkdownStreamRenderer(out.write)
    md.push('```\nhalf written\n')
    md.flush()
    expect(strip(out.raw())).toContain('half written')
  })

  test('tables are buffered until the block ends, then aligned', () => {
    const out = collect()
    const md = new MarkdownStreamRenderer(out.write)
    md.push('| a | 景点 |\n|---|---|\n| 1 | 荔波 |\n')
    // still buffered: nothing table-like emitted yet
    expect(out.raw()).not.toContain('┌')
    md.push('after the table\n')
    const lines = strip(out.raw()).split('\n').filter(line => line.includes('│'))
    const widths = new Set(lines.map(line => displayWidth(line)))
    expect(widths.size).toBe(1)
    expect(strip(out.raw())).toContain('after the table')
    md.flush()
  })

  test('chunked streaming produces the same output as one-shot input', () => {
    const document =
      '# Title\n\nsome **bold** text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n' +
      '```js\nconsole.log(1)\n```\n\n- item one\n- item two\n'

    const whole = collect()
    const one = new MarkdownStreamRenderer(whole.write)
    one.push(document)
    one.flush()

    const pieces = collect()
    const many = new MarkdownStreamRenderer(pieces.write)
    for (let i = 0; i < document.length; i += 7) {
      many.push(document.slice(i, i + 7))
    }
    many.flush()

    expect(pieces.raw()).toBe(whole.raw())
  })

  test('a trailing partial line is emitted on flush', () => {
    const out = collect()
    const md = new MarkdownStreamRenderer(out.write)
    md.push('no newline yet')
    expect(out.raw()).toBe('')
    md.flush()
    expect(strip(out.raw())).toBe('no newline yet\n')
  })

  test('LaTeX display blocks are shown verbatim, not parsed as markdown', () => {
    const out = collect()
    const md = new MarkdownStreamRenderer(out.write)
    md.push('\\[\nr(A) = r(A^T)\n\\]\n')
    md.flush()
    const raw = strip(out.raw())
    expect(raw).toContain('r(A) = r(A^T)')
    expect(raw).not.toContain('\\[')
  })

  test('output carries no ANSI escapes when color is disabled', () => {
    // vitest runs without a TTY, so colorEnabled is false here
    expect(colorEnabled).toBe(false)
    const out = collect()
    const md = new MarkdownStreamRenderer(out.write)
    md.push('# Title\n**bold** and `code`\n| a | b |\n|---|---|\n| 1 | 2 |\n')
    md.flush()
    expect(out.raw()).not.toContain('\u001b[')
    // alignment still applies so piped output stays readable
    const rows = out.raw().split('\n').filter(line => line.includes('│'))
    expect(new Set(rows.map(line => displayWidth(line))).size).toBe(1)
  })
})
