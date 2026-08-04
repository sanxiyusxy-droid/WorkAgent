import { describe, expect, test } from 'vitest'
import { Spinner } from '../src/cli/spinner.js'
import { Renderer } from '../src/cli/render.js'
import type { AgentEvent } from '../src/core/events.js'

/** Collect raw terminal writes so we can inspect control sequences. */
function harness(options: { intervalMs?: number } = {}) {
  const chunks: string[] = []
  const write = (text: string) => {
    chunks.push(text)
  }
  const spinner = new Spinner({
    write,
    isTty: true, // force spinner rendering even under vitest
    intervalMs: options.intervalMs ?? 5,
  })
  const renderer = new Renderer(spinner, { debug: false, write })
  return { chunks, spinner, renderer, raw: () => chunks.join('') }
}

const ERASE = '\r\u001b[2K'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('renderer / spinner interleaving', () => {
  test('streaming text stops the spinner timer (regression: erased line starts)', () => {
    const h = harness()
    h.renderer.handle({ type: 'status.changed', phase: 'calling_model' })
    expect(h.spinner.isRunning).toBe(true)

    h.renderer.handle({ type: 'model.delta', turnId: 't', text: 'hello' })

    // the timer must be gone, otherwise the next tick erases the partial line
    expect(h.spinner.isRunning).toBe(false)
  })

  test('no erase sequence appears after streaming begins', async () => {
    const h = harness({ intervalMs: 5 })
    h.renderer.handle({ type: 'status.changed', phase: 'calling_model' })
    await sleep(20) // let the spinner tick a few times

    const beforeStream = h.chunks.length
    // complete lines are emitted immediately; markdown buffers only a partial
    // trailing line, so both lines end with a newline here
    h.renderer.handle({ type: 'model.delta', turnId: 't', text: 'line one\n' })
    h.renderer.handle({ type: 'model.delta', turnId: 't', text: 'line two\n' })
    await sleep(40) // if the timer were alive it would erase here

    const afterStream = h.chunks.slice(beforeStream).join('')
    // exactly one erase: the one that removed the spinner itself
    expect(afterStream.split(ERASE).length - 1).toBe(1)
    expect(afterStream.startsWith(ERASE)).toBe(true)
    expect(afterStream).toContain('line one')
    expect(afterStream).toContain('line two')
    // and nothing was erased after text started flowing
    expect(afterStream.indexOf(ERASE)).toBeLessThan(afterStream.indexOf('line one'))
  })

  test('restarting the spinner flushes and terminates the streamed line first', async () => {
    const h = harness({ intervalMs: 5 })
    h.renderer.handle({ type: 'status.changed', phase: 'calling_model' })
    // no trailing newline: markdown holds this line until something flushes it
    h.renderer.handle({ type: 'model.delta', turnId: 't', text: 'partial answer' })

    const before = h.chunks.length
    h.renderer.handle({ type: 'status.changed', phase: 'executing_tools' })
    const emitted = h.chunks.slice(before).join('')

    // the buffered text is emitted and the line closed before the spinner
    // takes ownership of the line again
    expect(emitted).toContain('partial answer')
    expect(emitted.slice(0, emitted.indexOf(ERASE) === -1 ? undefined : emitted.indexOf(ERASE)))
      .toMatch(/\n$/)
    expect(h.spinner.isRunning).toBe(true)
    h.spinner.stop()
  })

  test('tool activity lines never truncate streamed text', () => {
    const h = harness()
    h.renderer.handle({ type: 'status.changed', phase: 'calling_model' })
    h.renderer.handle({ type: 'model.delta', turnId: 't', text: 'I will read a file.' })
    h.renderer.handle({
      type: 'tool.call.accepted',
      call: {
        id: 'c1',
        name: 'Read',
        input: { path: 'a.ts' },
        parentMessageId: 'm',
        receivedIndex: 0,
      },
    })

    const raw = h.raw()
    // the streamed sentence survives intact and is closed by a newline
    expect(raw).toContain('I will read a file.\n')
    expect(raw).toContain('Read')
  })

  test('a full turn ends with the cursor on a fresh line', () => {
    const h = harness()
    const events: AgentEvent[] = [
      { type: 'status.changed', phase: 'calling_model' },
      { type: 'model.delta', turnId: 't', text: 'done' },
      { type: 'run.terminated', terminal: { reason: 'completed' } },
    ]
    for (const event of events) h.renderer.handle(event)
    h.renderer.finishTurn()

    expect(h.spinner.isRunning).toBe(false)
    expect(h.raw().endsWith('\n')).toBe(true)
  })

  test('non-tty output contains no control sequences at all', () => {
    const chunks: string[] = []
    const write = (text: string) => chunks.push(text)
    const spinner = new Spinner({ write, isTty: false })
    const renderer = new Renderer(spinner, { debug: false, write })

    renderer.handle({ type: 'status.changed', phase: 'calling_model' })
    renderer.handle({ type: 'model.delta', turnId: 't', text: 'plain output' })
    renderer.finishTurn()

    expect(chunks.join('')).not.toContain('\u001b[2K')
    expect(chunks.join('')).toContain('plain output')
  })
})
