import { Writable, type WritableOptions } from 'node:stream'
import type { Interface as ReadlineInterface } from 'node:readline/promises'

/**
 * Readline-compatible output that can temporarily suppress terminal echo.
 * The destination still receives the prompt and trailing newline explicitly,
 * but never the secret or cursor redraws produced while the answer is typed.
 */
export class ConcealableTerminalOutput extends Writable {
  private concealed = false
  private activeWrites = 0
  private readonly idleWaiters: Array<() => void> = []

  constructor(
    private readonly destination: NodeJS.WritableStream,
    options?: WritableOptions,
  ) {
    super(options)
  }

  get isTTY(): boolean {
    return Boolean((this.destination as NodeJS.WriteStream).isTTY)
  }

  get columns(): number | undefined {
    return (this.destination as NodeJS.WriteStream).columns
  }

  get rows(): number | undefined {
    return (this.destination as NodeJS.WriteStream).rows
  }

  writeVisible(text: string): void {
    this.destination.write(text)
  }

  async whileConcealed<T>(operation: () => Promise<T>): Promise<T> {
    // Keep ordinary readline output ahead of the secret prompt visible, and
    // drain every echo chunk before revealing output again. Checking only the
    // conceal flag in _write is insufficient because Writable may queue chunks.
    await this.waitUntilIdle()
    this.concealed = true
    try {
      return await operation()
    } finally {
      try {
        await this.waitUntilIdle()
      } finally {
        this.concealed = false
      }
    }
  }

  private waitUntilIdle(): Promise<void> {
    if (this.activeWrites === 0 && this.writableLength === 0) {
      return Promise.resolve()
    }
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  private settleIdleWaiters(): void {
    if (this.activeWrites !== 0 || this.writableLength !== 0) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  override _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.activeWrites += 1
    const done = (error?: Error | null): void => {
      this.activeWrites -= 1
      callback(error)
      queueMicrotask(() => this.settleIdleWaiters())
    }
    if (this.concealed) {
      done()
      return
    }
    if (typeof chunk === 'string') {
      this.destination.write(chunk, encoding, done)
    } else {
      this.destination.write(chunk.toString(), done)
    }
  }
}

/** Ask through readline while suppressing its terminal echo. */
export async function questionSecret(
  rl: ReadlineInterface,
  output: ConcealableTerminalOutput,
  prompt: string,
): Promise<string> {
  // Node's terminal readline stores every accepted line in `history`. The
  // automatic first-run setup reuses this interface for the later REPL, so a
  // secret left there could be recalled with the Up arrow after echo resumes.
  // Restore the exact pre-question history in finally, including on EOF/error.
  const mutableHistory = (rl as ReadlineInterface & { history?: string[] }).history
  const historyBefore = Array.isArray(mutableHistory)
    ? [...mutableHistory]
    : undefined
  output.writeVisible(prompt)
  try {
    return await output.whileConcealed(() => rl.question(''))
  } finally {
    if (Array.isArray(mutableHistory) && historyBefore) {
      mutableHistory.splice(0, mutableHistory.length, ...historyBefore)
    }
    output.writeVisible('\n')
  }
}
