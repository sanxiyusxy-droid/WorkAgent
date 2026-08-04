import { style, symbol } from './theme.js'

export interface SpinnerDeps {
  write: (text: string) => void
  isTty: boolean
  intervalMs?: number
}

/**
 * Single-line spinner.
 *
 * Critical contract: the spinner owns its line and erases it on every tick
 * (`\r` + erase-line). Therefore anything that prints text WITHOUT a trailing
 * newline (streaming model output) must `stop()` the spinner first, otherwise
 * the next tick wipes the partial line. Callers that print whole lines may use
 * the cheaper `clear()`.
 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null
  private frame = 0
  private label = ''
  private visible = false
  private readonly deps: Required<SpinnerDeps>

  constructor(deps?: Partial<SpinnerDeps>) {
    this.deps = {
      write: deps?.write ?? (text => process.stdout.write(text)),
      isTty: deps?.isTty ?? process.stdout.isTTY === true,
      intervalMs: deps?.intervalMs ?? 90,
    }
  }

  get isRunning(): boolean {
    return this.timer !== null
  }

  start(label: string): void {
    this.label = label
    if (!this.deps.isTty) return
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.deps.intervalMs)
    this.timer.unref?.()
    this.tick()
  }

  setLabel(label: string): void {
    this.label = label
  }

  /** Erase the spinner line if it is currently drawn. Keeps the timer alive. */
  clear(): void {
    if (!this.visible) return
    this.deps.write('\r\u001b[2K')
    this.visible = false
  }

  /** Stop ticking and erase. Required before partial-line output. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.clear()
  }

  private tick(): void {
    const frames = symbol.spinnerFrames
    const glyph = frames[this.frame % frames.length]!
    this.frame += 1
    this.deps.write(`\r\u001b[2K${style.cyan(glyph)} ${style.dim(this.label)}`)
    this.visible = true
  }
}
