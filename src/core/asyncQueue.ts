/**
 * Minimal async FIFO. Used to merge externally produced transient events
 * (tool progress) into the engine's pull-based event stream without losing
 * ordering or blocking the producer.
 */
export class AsyncQueue<T> {
  private items: T[] = []
  private waiter: ((value: T | null) => void) | null = null
  private closed = false

  push(item: T): void {
    if (this.closed) return
    if (this.waiter) {
      const resolve = this.waiter
      this.waiter = null
      resolve(item)
    } else {
      this.items.push(item)
    }
  }

  close(): void {
    this.closed = true
    if (this.waiter) {
      const resolve = this.waiter
      this.waiter = null
      resolve(null)
    }
  }

  /** Resolves with the next item, or null once closed and drained. */
  shift(): Promise<T | null> {
    const first = this.items.shift()
    if (first !== undefined) return Promise.resolve(first)
    if (this.closed) return Promise.resolve(null)
    return new Promise(resolve => {
      this.waiter = resolve
    })
  }

  /** Non-blocking drain of whatever is buffered right now. */
  drain(): T[] {
    const out = this.items
    this.items = []
    return out
  }
}

/**
 * Interleave items from a side channel into a primary generator. Both
 * sources are fully drained; the primary generator still determines when
 * the merged stream ends (any side-channel items still buffered at that
 * point are flushed afterwards).
 */
export async function* mergeTransient<T>(
  side: AsyncQueue<T>,
  primary: AsyncGenerator<T>,
): AsyncGenerator<T> {
  let pending: Promise<IteratorResult<T>> = primary.next()
  // one outstanding shift() at a time: reusing it across race iterations
  // avoids re-registering waiters (which would orphan earlier promises)
  let sidePending: Promise<T | null> = side.shift()
  for (;;) {
    const raced = await Promise.race([
      sidePending.then(r => ({ source: 'side' as const, r })),
      pending.then(r => ({ source: 'primary' as const, r })),
    ])
    if (raced.source === 'side') {
      if (raced.r === null) {
        // side channel is closed and drained — stop racing it and consume
        // the primary stream alone (null would otherwise spin forever)
        for (;;) {
          const step = await pending
          if (step.done) return
          yield step.value
          pending = primary.next()
        }
      }
      sidePending = side.shift()
      yield raced.r
      continue
    }
    if (raced.r.done) {
      for (const item of side.drain()) yield item
      return
    }
    yield raced.r.value
    pending = primary.next()
  }
}
