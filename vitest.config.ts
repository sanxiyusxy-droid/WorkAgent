import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'lcov'],
      // Regression floors: correctness-critical modules carry stricter
      // thresholds than the aggregate so refactors cannot silently erode
      // the tested surface of recovery, idempotency or verification.
      thresholds: {
        statements: 70,
        branches: 75,
        functions: 80,
        lines: 70,
        'src/core/**': { statements: 88, lines: 88, branches: 78 },
        // top-level runtime plumbing only (runtime/scheduler/ledger/registry);
        // builtin tool implementations follow the aggregate floor
        'src/tools/*.ts': { statements: 88, lines: 88 },
        'src/session/**': { statements: 85, lines: 85 },
        'src/verification/**': { statements: 90, lines: 90 },
        'src/context/**': { statements: 93, lines: 93 },
      },
    },
  },
})
