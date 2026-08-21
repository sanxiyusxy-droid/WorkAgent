import type { ModelError } from './types.js'

export interface RetryDecision {
  action: 'retry' | 'surface'
  delayMs?: number
}

export interface RetryPolicyOptions {
  /** Maximum retries after the initial physical request (legacy name). */
  maxAttempts: number
  baseDelayMs: number
  capDelayMs: number
  random?: () => number
}

const DEFAULTS: RetryPolicyOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  capDelayMs: 15_000,
}

/**
 * Bounded exponential backoff with jitter. Honors server Retry-After.
 * No unbounded retry anywhere.
 */
export function createRetryPolicy(options: Partial<RetryPolicyOptions> = {}) {
  const opts = { ...DEFAULTS, ...options }
  const random = opts.random ?? Math.random

  return {
    decide(input: { error: ModelError; attempt: number }): RetryDecision {
      const { error, attempt } = input

      if (!error.retryable) return { action: 'surface' }
      if (attempt >= opts.maxAttempts) return { action: 'surface' }

      // PROMPT_TOO_LONG / MAX_OUTPUT are handled by dedicated recovery paths,
      // not by blind retry.
      if (error.code === 'PROMPT_TOO_LONG' || error.code === 'MAX_OUTPUT') {
        return { action: 'surface' }
      }

      if (
        (error.code === 'RATE_LIMIT' || error.code === 'OVERLOADED') &&
        error.retryAfterMs !== undefined
      ) {
        // Provider hints are advisory. A malformed or very large Retry-After
        // must not turn a bounded retry policy into an unbounded sleep.
        return {
          action: 'retry',
          delayMs: Math.max(0, Math.min(opts.capDelayMs, error.retryAfterMs)),
        }
      }

      const exp = Math.min(opts.capDelayMs, opts.baseDelayMs * 2 ** attempt)
      const jitter = 0.8 + random() * 0.4
      return { action: 'retry', delayMs: Math.round(exp * jitter) }
    },
  }
}

export type RetryPolicy = ReturnType<typeof createRetryPolicy>
