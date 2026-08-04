import { randomBytes } from 'node:crypto'

export interface Clock {
  now(): number
  isoNow(): string
}

export interface IdGenerator {
  next(prefix: string): string
}

export const systemClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
}

export function createIdGenerator(): IdGenerator {
  let counter = 0
  return {
    next(prefix: string): string {
      counter += 1
      return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}${counter.toString(36)}`
    },
  }
}

/** Deterministic generator for tests and golden transcripts. */
export function createSequentialIds(): IdGenerator {
  const counters = new Map<string, number>()
  return {
    next(prefix: string): string {
      const n = (counters.get(prefix) ?? 0) + 1
      counters.set(prefix, n)
      return `${prefix}_${n}`
    },
  }
}
