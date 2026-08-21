import { describe, expect, test } from 'vitest'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionJournal } from '../src/session/SessionJournal.js'
import {
  latestResumableSession,
  listSessions,
  removeSessionIfUnused,
} from '../src/session/sessionIndex.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import type { Clock } from '../src/core/runtimePrimitives.js'
import type { ConversationMessage } from '../src/core/messages.js'
import type { FactEvent } from '../src/core/events.js'
import { emptyOutcomeCalibrationProfile } from '../src/planning/OutcomeCalibration.js'
import { buildOutcomeCalibrationSelection } from '../src/planning/OutcomeCalibrationContract.js'

/** Clock whose ISO output advances, so lastActivityAt ordering is meaningful. */
function advancingClock(startIso: string): Clock {
  let ms = new Date(startIso).getTime()
  return {
    now: () => ms,
    isoNow: () => {
      ms += 1000
      return new Date(ms).toISOString()
    },
  }
}

function message(
  id: string,
  text: string,
  source: 'human' | 'engine',
  clock: Clock,
): ConversationMessage {
  return {
    id,
    parentId: null,
    sessionId: 'ses',
    turnId: 'turn',
    role: 'user',
    content: [{ type: 'text', text }],
    createdAt: clock.isoNow(),
    meta: { source },
  }
}

/** Build a session journal on disk. */
async function makeSession(
  workspaceRoot: string,
  sessionId: string,
  options: {
    startIso: string
    prompts?: string[]
    withAssistant?: boolean
    withCalibration?: boolean
  },
): Promise<void> {
  const dir = join(workspaceRoot, '.agent', 'sessions', sessionId)
  await mkdir(dir, { recursive: true })
  const clock = advancingClock(options.startIso)
  const journal = new SessionJournal({
    filePath: join(dir, 'journal.jsonl'),
    sessionId,
    runId: 'run_1',
    clock,
    ids: createSequentialIds(),
  })

  // every run starts with this fact, even when the user types nothing
  await journal.append(
    { type: 'run.started', runId: 'run_1', configHash: 'hash' },
    'boot',
    'flush',
  )
  if (options.withCalibration) {
    await journal.append(
      {
        type: 'outcome.calibration.selected',
        selection: buildOutcomeCalibrationSelection({
          origin: 'history_scan',
          scanStatus: 'no_history',
          eligibleBefore: options.startIso,
          profile: emptyOutcomeCalibrationProfile(),
        }),
      },
      'boot',
      'flush',
    )
  }

  for (const [index, prompt] of (options.prompts ?? []).entries()) {
    const fact: FactEvent = {
      type: 'user.message.accepted',
      message: message(`m_${sessionId}_${index}`, prompt, 'human', clock),
    }
    await journal.append(fact, 'turn_1', 'flush')
    if (options.withAssistant !== false) {
      await journal.append(
        {
          type: 'assistant.message.completed',
          message: {
            id: `a_${sessionId}_${index}`,
            parentId: null,
            sessionId,
            turnId: 'turn_1',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            createdAt: clock.isoNow(),
          },
        },
        'turn_1',
        'flush',
      )
    }
  }
  await journal.drain()
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-sessions-'))
}

describe('session index', () => {
  test('an empty session never shadows a real conversation (regression)', async () => {
    const root = await workspace()
    try {
      // the real conversation happened earlier...
      await makeSession(root, 'ses_real', {
        startIso: '2026-08-02T14:45:00.000Z',
        prompts: ['创建一个 txt 文件', '再帮我规划一次旅行'],
      })
      // ...then the user ran `agent` and typed nothing, creating a NEWER journal
      await makeSession(root, 'ses_empty', {
        startIso: '2026-08-02T18:45:00.000Z',
      })

      const resumable = await latestResumableSession(root)
      // picking by file mtime would return ses_empty and lose the history
      expect(resumable?.id).toBe('ses_real')
      expect(resumable?.humanMessageCount).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('among sessions with content, the most recently active wins', async () => {
    const root = await workspace()
    try {
      await makeSession(root, 'ses_old', {
        startIso: '2026-08-01T10:00:00.000Z',
        prompts: ['old work'],
      })
      await makeSession(root, 'ses_new', {
        startIso: '2026-08-03T10:00:00.000Z',
        prompts: ['new work'],
      })
      const resumable = await latestResumableSession(root)
      expect(resumable?.id).toBe('ses_new')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('summaries expose prompt counts and the first prompt for recognition', async () => {
    const root = await workspace()
    try {
      await makeSession(root, 'ses_a', {
        startIso: '2026-08-02T09:00:00.000Z',
        prompts: ['写一个 FastAPI 待办服务', 'add tests'],
      })
      const [summary] = await listSessions(root)
      expect(summary).toBeDefined()
      expect(summary!.id).toBe('ses_a')
      expect(summary!.humanMessageCount).toBe(2)
      expect(summary!.messageCount).toBe(4) // 2 human + 2 assistant
      expect(summary!.firstPrompt).toBe('写一个 FastAPI 待办服务')
      expect(summary!.degraded).toBe(false)
      // activity time comes from conversation events, not run.started
      expect(summary!.lastActivityAt > '2026-08-02T09:00:00.000Z').toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('engine-injected notices do not count as human prompts', async () => {
    const root = await workspace()
    try {
      const dir = join(root, '.agent', 'sessions', 'ses_notice')
      await mkdir(dir, { recursive: true })
      const clock = advancingClock('2026-08-02T09:00:00.000Z')
      const journal = new SessionJournal({
        filePath: join(dir, 'journal.jsonl'),
        sessionId: 'ses_notice',
        runId: 'run_1',
        clock,
        ids: createSequentialIds(),
      })
      await journal.append(
        { type: 'run.started', runId: 'run_1', configHash: 'h' },
        'boot',
        'flush',
      )
      await journal.append(
        {
          type: 'user.message.accepted',
          message: message('m1', '[Permission mode changed]', 'engine', clock),
        },
        'turn_1',
        'flush',
      )
      await journal.drain()

      const [summary] = await listSessions(root)
      expect(summary!.messageCount).toBe(1)
      expect(summary!.humanMessageCount).toBe(0)
      // a session with only notices is not what --continue should resume
      expect((await latestResumableSession(root))?.humanMessageCount).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('no sessions directory yields an empty list, not an error', async () => {
    const root = await workspace()
    try {
      expect(await listSessions(root)).toEqual([])
      expect(await latestResumableSession(root)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('empty session cleanup', () => {
  test('a journal containing only run.started is discarded', async () => {
    const root = await workspace()
    try {
      await makeSession(root, 'ses_empty', { startIso: '2026-08-02T18:00:00.000Z' })
      expect(await removeSessionIfUnused(root, 'ses_empty')).toBe(true)
      const remaining = await readdir(join(root, '.agent', 'sessions'))
      expect(remaining).not.toContain('ses_empty')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('bootstrap calibration selection does not keep an otherwise unused session', async () => {
    const root = await workspace()
    try {
      await makeSession(root, 'ses_calibration_only', {
        startIso: '2026-08-02T18:00:00.000Z',
        withCalibration: true,
      })
      expect(await removeSessionIfUnused(root, 'ses_calibration_only')).toBe(true)
      const remaining = await readdir(join(root, '.agent', 'sessions'))
      expect(remaining).not.toContain('ses_calibration_only')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a session with a conversation is never removed', async () => {
    const root = await workspace()
    try {
      await makeSession(root, 'ses_real', {
        startIso: '2026-08-02T18:00:00.000Z',
        prompts: ['do something'],
      })
      expect(await removeSessionIfUnused(root, 'ses_real')).toBe(false)
      const remaining = await readdir(join(root, '.agent', 'sessions'))
      expect(remaining).toContain('ses_real')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a session directory holding artifacts is never removed', async () => {
    const root = await workspace()
    try {
      await makeSession(root, 'ses_art', { startIso: '2026-08-02T18:00:00.000Z' })
      // an evidence receipt or plan next to the journal means real work happened
      await mkdir(join(root, '.agent', 'sessions', 'ses_art', 'evidence'), {
        recursive: true,
      })
      expect(await removeSessionIfUnused(root, 'ses_art')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a corrupted journal is left untouched', async () => {
    const root = await workspace()
    try {
      const dir = join(root, '.agent', 'sessions', 'ses_broken')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'journal.jsonl'), '{ not json\n', 'utf8')
      expect(await removeSessionIfUnused(root, 'ses_broken')).toBe(false)
      const remaining = await readdir(join(root, '.agent', 'sessions'))
      expect(remaining).toContain('ses_broken')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a missing session id is a no-op', async () => {
    const root = await workspace()
    try {
      expect(await removeSessionIfUnused(root, 'ses_nope')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
