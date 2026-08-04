import type { AgentEvent } from '../core/events.js'

export interface ProgressChunk {
  stream: 'stdout' | 'stderr'
  text: string
}

export interface ProgressLimits {
  /** minimum interval between two emitted events (1000/x events per second) */
  minIntervalMs: number
  /** chunks below this size are merged instead of emitted immediately */
  mergeChars: number
  /** per-call display budget: output beyond it is dropped, never buffered */
  maxCharsPerCall: number
}

export const DEFAULT_PROGRESS_LIMITS: ProgressLimits = {
  // 20 events per second is plenty for a terminal and keeps slow terminals
  // from becoming the bottleneck (backpressure by dropping, never blocking)
  minIntervalMs: 50,
  mergeChars: 256,
  maxCharsPerCall: 20_000,
}

/**
 * Rate-limited, merging forwarder for tool progress.
 * - merges small chunks so event count stays bounded (minIntervalMs)
 * - keeps stdout/stderr as separate events (distinct rendering)
 * - enforces a per-call display budget: excess output is DROPPED with a
 *   counter, never buffered — memory cannot grow with chatty commands
 * - flush() emits the remainder at completion/abort, so interrupted runs
 *   still show their last output
 */
export class ProgressThrottle {
  private pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  private lastEmitAt = Number.NEGATIVE_INFINITY
  private emittedChars = 0
  private dropped = 0

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly callId: string,
    private readonly now: () => number,
    private readonly limits: ProgressLimits = DEFAULT_PROGRESS_LIMITS,
  ) {}

  push(chunk: ProgressChunk): void {
    let text = chunk.text
    // per-call budget: never accept more than the display cap
    const room =
      this.limits.maxCharsPerCall - this.emittedChars - this.pending[chunk.stream].length
    if (room <= 0) {
      this.dropped += text.length
      return
    }
    if (text.length > room) {
      this.dropped += text.length - room
      text = text.slice(0, room)
    }
    this.pending[chunk.stream] += text
    this.maybeEmit(false)
  }

  /** Emit whatever is buffered (tool finished or was interrupted). */
  flush(): void {
    this.maybeEmit(true)
    if (this.dropped > 0) {
      const dropped = this.dropped
      this.dropped = 0
      this.emit({
        type: 'tool.progress',
        callId: this.callId,
        data: {
          stream: 'stderr',
          text: `\n[progress: ${dropped} chars of output dropped by display budget]\n`,
          dropped,
        },
      })
    }
  }

  private maybeEmit(force: boolean): void {
    const buffered = this.pending.stdout.length + this.pending.stderr.length
    if (buffered === 0) return
    const intervalOk = this.now() - this.lastEmitAt >= this.limits.minIntervalMs
    if (!force && (!intervalOk || buffered < this.limits.mergeChars)) return
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = this.pending[stream]
      if (text.length === 0) continue
      this.pending[stream] = ''
      this.emittedChars += text.length
      this.emit({ type: 'tool.progress', callId: this.callId, data: { stream, text } })
    }
    this.lastEmitAt = this.now()
  }
}
