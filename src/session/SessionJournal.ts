import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FactEvent } from '../core/events.js'
import type { Clock, IdGenerator } from '../core/runtimePrimitives.js'
import { redactDeep } from '../security/secrets.js'

export interface JournalEnvelope<T extends FactEvent = FactEvent> {
  schemaVersion: 1
  seq: number
  eventId: string
  sessionId: string
  runId: string
  turnId: string
  parentEventId: string | null
  timestamp: string
  event: T
  checksum: string
}

export function envelopeChecksum(
  envelope: Omit<JournalEnvelope, 'checksum'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ seq: envelope.seq, event: envelope.event }))
    .digest('hex')
    .slice(0, 16)
}

interface PendingWrite {
  line: string
  resolve: () => void
  reject: (error: unknown) => void
}

/**
 * Ordered JSONL journal, one file per session. seq is strictly increasing.
 * Fact events only — progress never enters the journal.
 * Durability: 'flush' waits for the write to land; 'buffered' enqueues.
 */
export class SessionJournal {
  private queue: PendingWrite[] = []
  private draining: Promise<void> | null = null
  private nextSeq = 1
  private lastEventId: string | null = null

  constructor(
    private readonly deps: {
      filePath: string
      sessionId: string
      runId: string
      clock: Clock
      ids: IdGenerator
    },
  ) {}

  /** Adopt seq after loading an existing journal. */
  adopt(nextSeq: number, lastEventId: string | null): void {
    this.nextSeq = nextSeq
    this.lastEventId = lastEventId
  }

  get currentSeq(): number {
    return this.nextSeq - 1
  }

  async append(
    event: FactEvent,
    turnId: string,
    durability: 'buffered' | 'flush' = 'buffered',
  ): Promise<JournalEnvelope> {
    // SANITIZING SINK: nothing that looks like a credential ever reaches the
    // journal. All fact persistence funnels through this single method.
    event = redactDeep(event)
    const withoutChecksum: Omit<JournalEnvelope, 'checksum'> = {
      schemaVersion: 1,
      seq: this.nextSeq++,
      eventId: this.deps.ids.next('evt'),
      sessionId: this.deps.sessionId,
      runId: this.deps.runId,
      turnId,
      parentEventId: this.lastEventId,
      timestamp: this.deps.clock.isoNow(),
      event,
    }
    const envelope: JournalEnvelope = {
      ...withoutChecksum,
      checksum: envelopeChecksum(withoutChecksum),
    }
    this.lastEventId = envelope.eventId

    const promise = this.enqueue(JSON.stringify(envelope) + '\n')
    if (durability === 'flush') await promise
    return envelope
  }

  /** Wait until every queued write has landed. */
  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.draining) {
      await (this.draining ?? Promise.resolve())
      if (this.queue.length > 0) this.startDrain()
    }
  }

  private enqueue(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ line, resolve, reject })
      this.startDrain()
    })
  }

  private startDrain(): void {
    if (this.draining) return
    this.draining = this.flushLoop().finally(() => {
      this.draining = null
      if (this.queue.length > 0) this.startDrain()
    })
  }

  private async flushLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue
      this.queue = []
      const payload = batch.map(w => w.line).join('')
      try {
        await mkdir(dirname(this.deps.filePath), { recursive: true })
        await appendFile(this.deps.filePath, payload, 'utf8')
        for (const write of batch) write.resolve()
      } catch (error) {
        for (const write of batch) write.reject(error)
      }
    }
  }
}
