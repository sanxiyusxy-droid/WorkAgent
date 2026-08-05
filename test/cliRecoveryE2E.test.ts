import { describe, test, expect } from 'vitest'
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { envelopeChecksum, type JournalEnvelope } from '../src/session/SessionJournal.js'
import type { FactEvent } from '../src/core/events.js'

/**
 * CLI E2E for strict/degraded recovery (finish-list §1.5): spawns the real
 * CLI via tsx with fake credentials. The strict refusal happens BEFORE any
 * model call, so no network is needed.
 */
const require2 = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tsxCli = require2.resolve('tsx/cli')
const mainPath = join(repoRoot, 'src', 'cli', 'main.ts')
const SESSION_ID = 'ses-corrupt'

function runCli(args: string[], workspace: string) {
  const options: SpawnSyncOptionsWithStringEncoding = {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_API_KEY: 'fake-e2e-key',
      AGENT_MODEL: 'fake-e2e-model',
      // unroutable port: any accidental model call fails fast
      AGENT_BASE_URL: 'http://127.0.0.1:9',
      AGENT_MAX_TURNS: '1',
    },
  }
  return spawnSync(process.execPath, [tsxCli, mainPath, ...args], options)
}

function envelope(
  seq: number,
  event: FactEvent,
  parentEventId: string | null,
): JournalEnvelope {
  const base = {
    schemaVersion: 1 as const,
    seq,
    eventId: `evt_e2e_${seq}`,
    sessionId: SESSION_ID,
    runId: 'run_e2e',
    turnId: 'turn_e2e',
    parentEventId,
    timestamp: new Date(1_000_000 + seq * 1000).toISOString(),
    event,
  }
  return { ...base, checksum: envelopeChecksum(base) }
}

/** Syntactically valid journal whose seq-3 fact violates a reducer invariant. */
async function seedCorruptSession(workspace: string): Promise<string> {
  const dir = join(workspace, '.agent', 'sessions', SESSION_ID)
  await mkdir(dir, { recursive: true })
  const journalPath = join(dir, 'journal.jsonl')
  const message = {
    id: 'msg_e2e_1',
    parentId: null,
    sessionId: SESSION_ID,
    turnId: 'turn_e2e',
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'hello from the corrupt session' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    meta: { source: 'human' as const },
  }
  const envelopes = [
    envelope(1, { type: 'run.started', runId: 'run_e2e', configHash: 'h' }, null),
    envelope(2, { type: 'user.message.accepted', message }, 'evt_e2e_1'),
    envelope(
      3,
      { type: 'replan.adjustment.applied', cause: 'test', summary: 'corrupt' },
      'evt_e2e_2',
    ),
  ]
  await writeFile(
    journalPath,
    envelopes.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  )
  return journalPath
}

describe('CLI recovery E2E: strict by default, explicit degraded opt-in', () => {
  test('default: refuses with exit 2, full diagnosis, journal untouched', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-e2e-strict-'))
    try {
      const journalPath = await seedCorruptSession(workspace)
      const before = await readFile(journalPath, 'utf8')

      const result = runCli(
        ['-C', workspace, '--session', SESSION_ID, '-p', 'hi'],
        workspace,
      )

      expect(result.status).toBe(2)
      const stderr = result.stderr + result.stdout
      expect(stderr).toContain('replan_adjustment_without_request')
      expect(stderr).toContain('seq 3')
      expect(stderr).toContain('seq 2') // last trusted seq
      expect(stderr).toContain('--allow-degraded')

      // the corrupt journal must be byte-identical: no run.started appended,
      // nothing rewritten or deleted
      expect(await readFile(journalPath, 'utf8')).toBe(before)

      // no recovery branch or any other session was created
      const sessions = await readdir(join(workspace, '.agent', 'sessions'))
      expect(sessions).toEqual([SESSION_ID])
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }, 120_000)

  test('--allow-degraded: forks a read-only recovery branch, source journal untouched', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-e2e-degraded-'))
    try {
      const journalPath = await seedCorruptSession(workspace)
      const before = await readFile(journalPath, 'utf8')

      const result = runCli(
        ['-C', workspace, '--session', SESSION_ID, '--allow-degraded', '-p', 'hi'],
        workspace,
      )

      // recovery itself must succeed (the later model call fails against the
      // fake endpoint, which is exit 1 — but never the strict refusal code)
      expect(result.status).not.toBe(2)
      expect(result.status).not.toBeNull()
      const output = result.stdout + result.stderr
      expect(output).toContain('DEGRADED RECOVERY')
      expect(output).toContain('READ-ONLY')

      // source journal is preserved byte-for-byte
      expect(await readFile(journalPath, 'utf8')).toBe(before)

      // a NEW session carries the recovery branch provenance fact
      const sessions = await readdir(join(workspace, '.agent', 'sessions'))
      const branch = sessions.find(id => id !== SESSION_ID)
      expect(branch).toBeDefined()
      const branchJournal = await readFile(
        join(workspace, '.agent', 'sessions', branch!, 'journal.jsonl'),
        'utf8',
      )
      expect(branchJournal).toContain('session.recovery.branch')
      expect(branchJournal).toContain(SESSION_ID)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }, 120_000)
})
