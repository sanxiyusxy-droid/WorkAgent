import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSession } from './SessionLoader.js'

export interface SessionSummary {
  id: string
  journalPath: string
  /** messages visible after replay (includes engine-injected notices) */
  messageCount: number
  /** messages the human actually typed */
  humanMessageCount: number
  /** ISO timestamp of the last conversation event, NOT the file mtime */
  lastActivityAt: string
  /** first thing the human asked, for recognizing the session */
  firstPrompt?: string
  /** journal replay reported gaps or checksum problems */
  degraded: boolean
}

function sessionsDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.agent', 'sessions')
}

function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Summarize every session in a workspace, newest conversation first.
 *
 * Ordering deliberately uses the timestamp of the last conversation event
 * rather than the journal file mtime: starting the agent writes a `run.started`
 * fact, so an empty run would otherwise look like the newest session and
 * shadow the real conversation forever.
 */
export async function listSessions(
  workspaceRoot: string,
): Promise<SessionSummary[]> {
  let names: string[]
  try {
    names = await readdir(sessionsDir(workspaceRoot))
  } catch {
    return []
  }

  const summaries: SessionSummary[] = []
  for (const id of names) {
    const journalPath = join(sessionsDir(workspaceRoot), id, 'journal.jsonl')
    let loaded
    try {
      await stat(journalPath)
      loaded = await loadSession(journalPath)
    } catch {
      continue
    }
    if (loaded.envelopes.length === 0) continue

    const humanMessages = loaded.messages.filter(m => m.meta?.source === 'human')

    // last event that represents real conversation, ignoring run.started
    let lastActivityAt: string | undefined
    for (let i = loaded.envelopes.length - 1; i >= 0; i--) {
      const envelope = loaded.envelopes[i]!
      const type = envelope.event.type
      if (
        type === 'user.message.accepted' ||
        type === 'assistant.message.completed' ||
        type === 'tool.result.message' ||
        type === 'tool.call.completed'
      ) {
        lastActivityAt = envelope.timestamp
        break
      }
    }
    if (!lastActivityAt) {
      // no conversation at all: fall back to the first envelope so the session
      // still shows up, but always ranks below sessions with content
      lastActivityAt = loaded.envelopes[0]!.timestamp
    }

    summaries.push({
      id,
      journalPath,
      messageCount: loaded.messages.length,
      humanMessageCount: humanMessages.length,
      lastActivityAt,
      firstPrompt: humanMessages[0] ? textOf(humanMessages[0].content) : undefined,
      degraded: !loaded.ok,
    })
  }

  return summaries.sort((a, b) => {
    // sessions with real conversation always outrank empty ones
    const aHasContent = a.humanMessageCount > 0 ? 1 : 0
    const bHasContent = b.humanMessageCount > 0 ? 1 : 0
    if (aHasContent !== bHasContent) return bHasContent - aHasContent
    return b.lastActivityAt.localeCompare(a.lastActivityAt)
  })
}

/**
 * The session `--continue` should resume: the most recent one that actually
 * contains a conversation. Falls back to the newest session of any kind.
 */
export async function latestResumableSession(
  workspaceRoot: string,
): Promise<SessionSummary | undefined> {
  const sessions = await listSessions(workspaceRoot)
  return sessions.find(session => session.humanMessageCount > 0) ?? sessions[0]
}

/**
 * Delete a session directory that this run created but never used, so empty
 * runs do not pile up. Guarded: only removes a directory that contains nothing
 * but bootstrap facts (`run.started` and an optional calibration selection).
 */
export async function removeSessionIfUnused(
  workspaceRoot: string,
  sessionId: string,
): Promise<boolean> {
  const dir = join(sessionsDir(workspaceRoot), sessionId)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return false
  }
  if (entries.length !== 1 || entries[0] !== 'journal.jsonl') return false

  const loaded = await loadSession(join(dir, 'journal.jsonl'))
  if (!loaded.ok) return false // never touch a journal we could not fully read
  if (loaded.envelopes.length === 0) return false
  const onlyBootstrapFacts = loaded.envelopes.every(
    envelope =>
      envelope.event.type === 'run.started' ||
      envelope.event.type === 'outcome.calibration.selected',
  )
  if (!onlyBootstrapFacts) return false

  await rm(dir, { recursive: true, force: true })
  return true
}
