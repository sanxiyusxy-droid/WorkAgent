import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { resumeState } from '../src/app/createRuntime.js'
import { loadSession } from '../src/session/SessionLoader.js'
import {
  IdempotencyLedger,
  IdempotencyLedgerError,
} from '../src/tools/IdempotencyLedger.js'
import { makeWorld } from './helpers.js'

describe('fail-closed idempotency ledger', () => {
  test('a missing ledger is the only empty-ledger case', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-ledger-'))
    try {
      const ledger = new IdempotencyLedger(dir)
      await expect(ledger.load()).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.each([
    ['invalid JSON', '{not-json'],
    ['invalid schema', JSON.stringify({ version: 1, records: [{ key: 'x' }] })],
  ])('%s refuses recovery', async (_name, content) => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-ledger-'))
    try {
      await writeFile(join(dir, 'idempotency.json'), content, 'utf8')
      const ledger = new IdempotencyLedger(dir)
      await expect(ledger.load()).rejects.toMatchObject({
        name: 'IdempotencyLedgerError',
        code: 'IDEMPOTENCY_LEDGER_CORRUPT',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('operation keys are stable across object property order', () => {
    const a = IdempotencyLedger.computeOperationKey({
      sessionId: 's', toolName: 'Write', args: { path: 'a', options: { z: 1, a: 2 } },
    })
    const b = IdempotencyLedger.computeOperationKey({
      sessionId: 's', toolName: 'Write', args: { options: { a: 2, z: 1 }, path: 'a' },
    })
    expect(a).toBe(b)
  })

  test('atomic persistence survives replacement and reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-ledger-'))
    try {
      const key = IdempotencyLedger.computeOperationKey({
        sessionId: 's', toolName: 'Write', args: { path: 'a' },
      })
      const ledger = new IdempotencyLedger(dir)
      ledger.markRunning(key, 'c1', 'Write', '2026-01-01T00:00:00Z')
      await ledger.flush()
      ledger.markCommitted(key, 'sha256:ok', '2026-01-01T00:00:01Z')
      await ledger.flush()

      const document = JSON.parse(await readFile(join(dir, 'idempotency.json'), 'utf8'))
      expect(document).toMatchObject({ version: 1 })
      expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])

      const loaded = new IdempotencyLedger(dir)
      await loaded.load()
      expect(loaded.getRecord(key)).toMatchObject({
        status: 'committed', proof: 'sha256:ok',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('resumeState propagates a structured ledger failure before replay', async () => {
    const world = await makeWorld({ turns: [], persist: true })
    try {
      await world.runtime.journal!.append(
        { type: 'run.started', runId: world.runtime.runId, configHash: 'h' },
        'turn_1',
        'flush',
      )
      await writeFile(join(world.runtime.artifactDir, 'idempotency.json'), '[] trailing', 'utf8')
      const loaded = await loadSession(world.runtime.journalPath)
      await expect(resumeState(world.runtime, loaded)).rejects.toBeInstanceOf(
        IdempotencyLedgerError,
      )
    } finally {
      await world.cleanup()
    }
  })
})
