import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ReflectionEvaluation, ReflectionRecord, SupervisorAction } from '../core/events.js'
import { loadSession } from '../session/SessionLoader.js'
import { diagnoseSession } from '../session/recoveryCheck.js'
import {
  compareCalibrationEntry,
  compareText,
  finalizeOutcomeCalibrationProfile,
  freezeOutcomeCalibrationProfile,
  isOutcomeCalibrationProfile,
  isOutcomeCalibrationAction,
  isOutcomeCalibrationTrigger,
  roundCalibrationRate,
  type OutcomeCalibrationConfig,
  type OutcomeCalibrationEntry,
  type OutcomeCalibrationProfile,
  type OutcomeCalibrationScanStatus,
  type OutcomeCalibrationSource,
} from './OutcomeCalibrationContract.js'

export {
  freezeOutcomeCalibrationProfile,
  isOutcomeCalibrationProfile,
}
export type {
  OutcomeCalibrationConfig,
  OutcomeCalibrationEntry,
  OutcomeCalibrationProfile,
}

export interface OutcomeCalibrationMatch {
  entry: OutcomeCalibrationEntry
  baseWindow: number
  delta: -1 | 0 | 1
  /** Window bounded by runtime policy; it never overrides a hard gate. */
  evaluationWindow: number
  note: string
}

export interface OutcomeCalibrationSample {
  sessionId: string
  reflectionId: string
  trigger: ReflectionRecord['trigger']
  action: SupervisorAction
  outcome: ReflectionEvaluation['outcome']
  toolCallsObserved: number
}

export interface OutcomeCalibrationScan {
  profile: OutcomeCalibrationProfile
  scanStatus: OutcomeCalibrationScanStatus
  sources: readonly OutcomeCalibrationSource[]
}

const DEFAULT_MIN_SAMPLES = 3
const DEFAULT_MAX_SESSIONS = 50
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024

export function emptyOutcomeCalibrationProfile(
  config: OutcomeCalibrationConfig = {},
): OutcomeCalibrationProfile {
  return buildOutcomeCalibrationProfile([], config)
}

/**
 * Load a frozen, workspace-local profile from valid historical journals.
 * The current session and degraded/corrupt journals are ignored. Directory
 * names and samples are sorted, so filesystem iteration order cannot affect
 * the profile or its hash.
 */
export async function loadOutcomeCalibrationProfile(input: {
  workspaceRoot: string
  currentSessionId: string
  config?: OutcomeCalibrationConfig
}): Promise<OutcomeCalibrationProfile> {
  return (await loadOutcomeCalibrationScan(input)).profile
}

export async function loadOutcomeCalibrationScan(input: {
  workspaceRoot: string
  currentSessionId: string
  config?: OutcomeCalibrationConfig
}): Promise<OutcomeCalibrationScan> {
  if (input.config?.enabled === false) {
    return {
      profile: emptyOutcomeCalibrationProfile(input.config),
      scanStatus: 'no_history',
      sources: [],
    }
  }
  const maxSessions = clampInteger(
    input.config?.maxSessions,
    1,
    500,
    DEFAULT_MAX_SESSIONS,
  )
  let journals: Array<{ sessionId: string; journalPath: string }>
  const sessionsRoot = join(input.workspaceRoot, '.agent', 'sessions')
  try {
    const canonicalSessionsRoot = await realpath(sessionsRoot)
    const allSessionIds = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => entry.name)
      .filter(id => id !== input.currentSessionId)
      .sort(compareText)
    const eligible: Array<{ sessionId: string; journalPath: string }> = []
    for (const sessionId of allSessionIds) {
      const journalPath = await safeJournalPath(
        canonicalSessionsRoot,
        join(sessionsRoot, sessionId, 'journal.jsonl'),
      )
      if (!journalPath) continue
      const timestamp = await readFirstEnvelopeTimestamp(journalPath)
      if (!timestamp || afterCutoff(timestamp, input.config?.eligibleBefore)) continue
      eligible.push({ sessionId, journalPath })
    }
    // Inspect in stable descending id order and stop only after maxSessions
    // valid sample-bearing journals. Corrupt/degraded/empty candidates do not
    // consume the usable-history quota.
    journals = eligible.reverse()
  } catch (error) {
    return {
      profile: emptyOutcomeCalibrationProfile(input.config),
      scanStatus:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'no_history'
          : 'history_unavailable',
      sources: [],
    }
  }

  const samples: OutcomeCalibrationSample[] = []
  const sources: OutcomeCalibrationSource[] = []
  for (const { sessionId, journalPath } of journals) {
    if (sources.length >= maxSessions) break
    try {
      const loaded = await loadSession(journalPath)
      if (!loaded.ok) continue
      if (loaded.envelopes.some(envelope => envelope.sessionId !== sessionId)) continue
      if (loaded.envelopes[0]?.event.type !== 'run.started') continue
      // First validate the normal recovery path, including V5 snapshot/profile
      // consistency. Historical policy input then also receives a full reducer
      // replay so no malformed pre-snapshot sample can hide behind the fast
      // snapshot path.
      if (!diagnoseSession(loaded, input.workspaceRoot).ok) continue
      if (
        loaded.lastSnapshot?.version === 5 &&
        !diagnoseSession(
          { ...loaded, lastSnapshot: null },
          input.workspaceRoot,
        ).ok
      ) {
        continue
      }
      if (
        loaded.envelopes.some(
          envelope => envelope.event.type === 'session.recovery.branch',
        )
      ) {
        continue
      }
      const reflections = new Map<string, ReflectionRecord>()
      const reflectionIds = new Set<string>()
      const evaluated = new Set<string>()
      const evaluationIds = new Set<string>()
      const sessionSamples: OutcomeCalibrationSample[] = []
      let activePendingReflectionId: string | undefined
      let invalidLifecycle = false
      let throughSeq = 0
      for (const envelope of loaded.envelopes) {
        if (afterCutoff(envelope.timestamp, input.config?.eligibleBefore)) continue
        throughSeq = Math.max(throughSeq, envelope.seq)
        const fact = envelope.event
        if (fact.type === 'reflection.recorded') {
          if (
            reflectionIds.has(fact.reflection.id) ||
            (fact.reflection.decision && activePendingReflectionId !== undefined)
          ) {
            invalidLifecycle = true
            break
          }
          reflectionIds.add(fact.reflection.id)
          reflections.set(fact.reflection.id, fact.reflection)
          if (fact.reflection.decision) {
            activePendingReflectionId = fact.reflection.id
          }
          continue
        }
        if (fact.type !== 'reflection.evaluated') continue
        if (evaluationIds.has(fact.evaluation.id)) {
          invalidLifecycle = true
          break
        }
        evaluationIds.add(fact.evaluation.id)
        const reflection = reflections.get(fact.evaluation.reflectionId)
        if (
          !reflection?.decision ||
          evaluated.has(reflection.id) ||
          activePendingReflectionId !== reflection.id
        ) {
          invalidLifecycle = true
          break
        }
        if (
          !Number.isInteger(reflection.decision.evaluateAfterToolCalls) ||
          reflection.decision.evaluateAfterToolCalls < 1 ||
          reflection.decision.evaluateAfterToolCalls > 20
        ) {
          invalidLifecycle = true
          break
        }
        const sample: OutcomeCalibrationSample = {
          sessionId,
          reflectionId: reflection.id,
          trigger: reflection.trigger,
          action: reflection.decision.action,
          outcome: fact.evaluation.outcome,
          toolCallsObserved: fact.evaluation.toolCallsObserved,
        }
        if (!isValidSample(sample)) {
          invalidLifecycle = true
          break
        }
        sessionSamples.push(sample)
        evaluated.add(reflection.id)
        activePendingReflectionId = undefined
      }
      if (invalidLifecycle) continue
      if (sessionSamples.length > 0 && throughSeq > 0) {
        sessionSamples.sort(compareSample)
        samples.push(...sessionSamples)
        sources.push({
          sessionId,
          throughSeq,
          sampleCount: sessionSamples.length,
          sampleHash: hashSamples(sessionSamples),
        })
      }
    } catch {
      // History is advisory. Unreadable entries are ignored fail-closed and
      // cannot change current safety, completion or approval decisions.
    }
  }
  const profile = buildOutcomeCalibrationProfile(samples, {
      ...input.config,
      maxSessions,
    })
  return {
    profile,
    scanStatus: sources.length > 0 ? 'complete' : 'no_history',
    sources: Object.freeze(
      sources
        .sort((a, b) => compareText(a.sessionId, b.sessionId))
        .map(source => Object.freeze({ ...source })),
    ),
  }
}

export function buildOutcomeCalibrationProfile(
  samples: OutcomeCalibrationSample[],
  config: OutcomeCalibrationConfig = {},
): OutcomeCalibrationProfile {
  const minSamples = clampInteger(
    config.minSamples,
    1,
    100,
    DEFAULT_MIN_SAMPLES,
  )
  const maxSessions = clampInteger(
    config.maxSessions,
    1,
    500,
    DEFAULT_MAX_SESSIONS,
  )
  const validSamples = [...samples]
    .filter(isValidSample)
    .sort(compareSample)
  const selectedSessionIds = new Set(
    [...new Set(validSamples.map(sample => sample.sessionId))]
      .sort(compareText)
      .slice(-maxSessions),
  )
  const acceptedSamples = validSamples.filter(sample =>
    selectedSessionIds.has(sample.sessionId),
  )
  const groups = new Map<string, OutcomeCalibrationSample[]>()
  for (const sample of acceptedSamples) {
    const key = `${sample.trigger}\u0000${sample.action}`
    groups.set(key, [...(groups.get(key) ?? []), sample])
  }
  const entries = [...groups.values()]
    .map(group => {
      const first = group[0]!
      const effective = group.filter(sample => sample.outcome === 'effective').length
      const ineffective = group.length - effective
      const smoothedEffectiveness = (effective + 1) / (group.length + 2)
      return {
        trigger: first.trigger,
        action: first.action,
        samples: group.length,
        effective,
        ineffective,
        smoothedEffectiveness: roundCalibrationRate(smoothedEffectiveness),
      }
    })
    .sort(compareCalibrationEntry)
  return finalizeOutcomeCalibrationProfile({
    schemaVersion: 1 as const,
    sourceSessions: selectedSessionIds.size,
    pairedOutcomes: acceptedSamples.length,
    minSamples,
    maxSessions,
    entries,
  })
}

/**
 * Apply history only to the observation horizon. The typed action, rationale,
 * targets and success signals remain owned by the deterministic supervisor.
 */
export function calibrateReflectionDecision(
  reflection: ReflectionRecord,
  profile?: OutcomeCalibrationProfile,
  selectionHash?: string,
): ReflectionRecord {
  if (!reflection.decision) return reflection
  const match = matchOutcomeCalibration({
    profile,
    trigger: reflection.trigger,
    action: reflection.decision.action,
    defaultWindow: reflection.decision.evaluateAfterToolCalls,
  })
  if (!match) return reflection
  return {
    ...reflection,
    recommendation: `${reflection.recommendation} ${match.note}`,
    calibration: selectionHash
      ? {
          selectionHash,
          profileHash: profile!.hash,
          baseWindow: match.baseWindow,
          delta: match.delta,
          calibratedWindow: match.evaluationWindow,
        }
      : undefined,
    decision: {
      ...reflection.decision,
      successSignals: [...reflection.decision.successSignals],
      evaluateAfterToolCalls: match.evaluationWindow,
    },
  }
}

export function matchOutcomeCalibration(input: {
  profile?: OutcomeCalibrationProfile
  trigger: ReflectionRecord['trigger']
  action: SupervisorAction
  defaultWindow: number
}): OutcomeCalibrationMatch | undefined {
  const entry = input.profile?.entries.find(
    item => item.trigger === input.trigger && item.action === input.action,
  )
  if (!entry || !input.profile || entry.samples < input.profile.minSamples) {
    return undefined
  }
  const configured = clampInteger(input.defaultWindow, 1, 20, 3)
  const delta: -1 | 0 | 1 =
    entry.smoothedEffectiveness >= 0.75
      ? 1
      : entry.smoothedEffectiveness <= 0.4
        ? -1
        : 0
  const evaluationWindow = clampInteger(configured + delta, 1, 20, configured)
  return {
    entry,
    baseWindow: configured,
    delta,
    evaluationWindow,
    note:
      `Local history: ${entry.effective}/${entry.samples} comparable reflection ` +
      `outcomes were effective; observe up to ${evaluationWindow} tool call(s). ` +
      'This bounded policy input may shift deterministic repair timing by one call, ' +
      'but cannot override approval, scope, permission, evidence, budget or completion gates.',
  }
}

export function renderOutcomeCalibrationProfile(
  profile: OutcomeCalibrationProfile,
  selectionHash?: string,
): string | undefined {
  const eligible = profile.entries.filter(entry => entry.samples >= profile.minSamples)
  if (eligible.length === 0) return undefined
  return (
    `[OUTCOME CALIBRATION ${selectionHash ?? profile.hash}; profile ${profile.hash}] ` +
    `${profile.pairedOutcomes} paired reflection outcome(s) from ` +
    `${profile.sourceSessions} valid local session(s); ` +
    `${eligible.length} trigger/action group(s) meet the minimum of ` +
    `${profile.minSamples} comparable samples. History only tunes a future ` +
    'reflection observation window by at most one tool call. This can shift ' +
    'when deterministic repair policy reacts, but cannot bypass hard gates.'
  )
}


function compareSample(a: OutcomeCalibrationSample, b: OutcomeCalibrationSample): number {
  return (
    compareText(a.trigger, b.trigger) ||
    compareText(a.action, b.action) ||
    compareText(a.sessionId, b.sessionId) ||
    compareText(a.reflectionId, b.reflectionId) ||
    compareText(a.outcome, b.outcome) ||
    a.toolCallsObserved - b.toolCallsObserved
  )
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function afterCutoff(timestamp: string, cutoff?: string): boolean {
  return cutoff !== undefined && compareText(timestamp, cutoff) > 0
}

async function safeJournalPath(
  canonicalSessionsRoot: string,
  candidate: string,
): Promise<string | undefined> {
  try {
    const linkInfo = await lstat(candidate)
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) return undefined
    const canonical = await realpath(candidate)
    const rel = relative(canonicalSessionsRoot, canonical)
    if (
      rel === '' ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    ) {
      return undefined
    }
    const info = await stat(canonical)
    if (!info.isFile() || info.size > MAX_JOURNAL_BYTES) return undefined
    return canonical
  } catch {
    return undefined
  }
}

async function readFirstEnvelopeTimestamp(
  journalPath: string,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(journalPath, 'r')
    const buffer = Buffer.alloc(16 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead === 0) return undefined
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    if (newline < 0 && bytesRead === buffer.length) return undefined
    const firstLine = (newline >= 0 ? text.slice(0, newline) : text).trim()
    const parsed = JSON.parse(firstLine) as { timestamp?: unknown }
    return typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isValidSample(sample: OutcomeCalibrationSample): boolean {
  return (
    typeof sample.sessionId === 'string' &&
    typeof sample.reflectionId === 'string' &&
    isOutcomeCalibrationTrigger(sample.trigger) &&
    isOutcomeCalibrationAction(sample.action) &&
    (sample.outcome === 'effective' || sample.outcome === 'ineffective') &&
    Number.isInteger(sample.toolCallsObserved) &&
    sample.toolCallsObserved > 0
  )
}

function hashSamples(samples: readonly OutcomeCalibrationSample[]): string {
  return createHash('sha256')
    .update(JSON.stringify(samples))
    .digest('hex')
}
