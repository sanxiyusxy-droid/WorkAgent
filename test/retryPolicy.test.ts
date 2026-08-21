import { describe, expect, test } from 'vitest'
import { createRetryPolicy } from '../src/model/retryPolicy.js'

describe('bounded model retry policy', () => {
  test('caps provider Retry-After hints and rejects negative delays', () => {
    const policy = createRetryPolicy({ capDelayMs: 2_000, maxAttempts: 3 })

    expect(
      policy.decide({
        error: { code: 'RATE_LIMIT', retryAfterMs: 60_000, retryable: true },
        attempt: 0,
      }),
    ).toEqual({ action: 'retry', delayMs: 2_000 })
    expect(
      policy.decide({
        error: { code: 'OVERLOADED', retryAfterMs: -100, retryable: true },
        attempt: 0,
      }),
    ).toEqual({ action: 'retry', delayMs: 0 })
  })

  test('surfaces after the configured number of retries', () => {
    const policy = createRetryPolicy({ maxAttempts: 2, random: () => 0.5 })
    const error = { code: 'CONNECTION' as const, retryable: true as const }

    expect(policy.decide({ error, attempt: 0 }).action).toBe('retry')
    expect(policy.decide({ error, attempt: 1 }).action).toBe('retry')
    expect(policy.decide({ error, attempt: 2 })).toEqual({ action: 'surface' })
  })
})
