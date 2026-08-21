import { createHash } from 'node:crypto'
import type {
  ReflectionRecord,
  SupervisorAction,
} from '../core/events.js'

const REFLECTION_TRIGGERS = new Set<ReflectionRecord['trigger']>([
  'periodic',
  'stagnation',
  'replan',
  'verification',
  'completion',
])

const SUPERVISOR_ACTIONS = new Set<SupervisorAction>([
  'continue_step',
  'gather_evidence',
  'run_verification',
  'resolve_blocker',
  'repair_plan',
  'request_reapproval',
  'finish',
])

const PROFILE_KEYS = [
  'schemaVersion',
  'sourceSessions',
  'pairedOutcomes',
  'minSamples',
  'maxSessions',
  'entries',
  'hash',
] as const
const ENTRY_KEYS = [
  'trigger',
  'action',
  'samples',
  'effective',
  'ineffective',
  'smoothedEffectiveness',
] as const
const SOURCE_KEYS = ['sessionId', 'throughSeq', 'sampleCount', 'sampleHash'] as const
const POLICY_KEYS = ['minSamples', 'maxSessions'] as const
const SELECTION_KEYS = [
  'schemaVersion',
  'algorithm',
  'origin',
  'scanStatus',
  'eligibleBefore',
  'policy',
  'sources',
  'profile',
  'hash',
] as const

export interface OutcomeCalibrationConfig {
  enabled?: boolean
  minSamples?: number
  maxSessions?: number
  eligibleBefore?: string
}

export interface OutcomeCalibrationEntry {
  readonly trigger: ReflectionRecord['trigger']
  readonly action: SupervisorAction
  readonly samples: number
  readonly effective: number
  readonly ineffective: number
  /** Laplace-smoothed descriptive rate; never used to bypass policy. */
  readonly smoothedEffectiveness: number
}

export interface OutcomeCalibrationProfile {
  readonly schemaVersion: 1
  readonly sourceSessions: number
  readonly pairedOutcomes: number
  readonly minSamples: number
  readonly maxSessions: number
  readonly entries: readonly OutcomeCalibrationEntry[]
  readonly hash: string
}

export type OutcomeCalibrationSelectionSource =
  | 'history_scan'
  | 'legacy_backfill'
  | 'test_injected'

export type OutcomeCalibrationScanStatus =
  | 'complete'
  | 'no_history'
  | 'history_unavailable'

export interface OutcomeCalibrationSource {
  readonly sessionId: string
  readonly throughSeq: number
  readonly sampleCount: number
  readonly sampleHash: string
}

/**
 * Durable provenance for the workspace-local adaptive policy chosen at boot.
 * The full canonical profile is journaled so resume never needs to reconstruct
 * it from mutable historical sessions.
 */
export interface OutcomeCalibrationSelection {
  readonly schemaVersion: 1
  readonly algorithm: 'reflection-window-v1'
  readonly origin: OutcomeCalibrationSelectionSource
  readonly scanStatus: OutcomeCalibrationScanStatus
  readonly eligibleBefore: string
  readonly policy: {
    readonly minSamples: number
    readonly maxSessions: number
  }
  readonly sources: readonly OutcomeCalibrationSource[]
  readonly profile: OutcomeCalibrationProfile
  readonly hash: string
}

export interface CalibrationProfileBase {
  schemaVersion: 1
  sourceSessions: number
  pairedOutcomes: number
  minSamples: number
  maxSessions: number
  entries: OutcomeCalibrationEntry[]
}

interface CalibrationSelectionBase {
  schemaVersion: 1
  algorithm: 'reflection-window-v1'
  origin: OutcomeCalibrationSelectionSource
  scanStatus: OutcomeCalibrationScanStatus
  eligibleBefore: string
  policy: {
    minSamples: number
    maxSessions: number
  }
  sources: readonly OutcomeCalibrationSource[]
  profile: OutcomeCalibrationProfile
}

export function finalizeOutcomeCalibrationProfile(
  base: CalibrationProfileBase,
): OutcomeCalibrationProfile {
  return freezeOutcomeCalibrationProfile({
    schemaVersion: 1,
    sourceSessions: base.sourceSessions,
    pairedOutcomes: base.pairedOutcomes,
    minSamples: base.minSamples,
    maxSessions: base.maxSessions,
    entries: base.entries,
    hash: hashProfileBase(base),
  })
}

export function isOutcomeCalibrationProfile(
  value: unknown,
): value is OutcomeCalibrationProfile {
  if (!hasExactKeys(value, PROFILE_KEYS)) return false
  const candidate = value as Partial<OutcomeCalibrationProfile>
  if (
    candidate.schemaVersion !== 1 ||
    !isNonNegativeInteger(candidate.sourceSessions) ||
    !isNonNegativeInteger(candidate.pairedOutcomes) ||
    !isPositiveInteger(candidate.minSamples) ||
    !isPositiveInteger(candidate.maxSessions) ||
    !Array.isArray(candidate.entries) ||
    !candidate.entries.every(isCalibrationEntry) ||
    typeof candidate.hash !== 'string'
  ) {
    return false
  }
  const base: CalibrationProfileBase = {
    schemaVersion: 1,
    sourceSessions: candidate.sourceSessions,
    pairedOutcomes: candidate.pairedOutcomes,
    minSamples: candidate.minSamples,
    maxSessions: candidate.maxSessions,
    entries: candidate.entries,
  }
  const sampleTotal = candidate.entries.reduce(
    (total, entry) => total + entry.samples,
    0,
  )
  const stableEntries = [...candidate.entries].sort(compareCalibrationEntry)
  return (
    candidate.minSamples <= 100 &&
    candidate.maxSessions <= 500 &&
    candidate.sourceSessions <= candidate.maxSessions &&
    candidate.sourceSessions <= candidate.pairedOutcomes &&
    candidate.pairedOutcomes === sampleTotal &&
    candidate.entries.every((entry, index) => entry === stableEntries[index]) &&
    new Set(candidate.entries.map(entry => calibrationKey(entry))).size ===
      candidate.entries.length &&
    candidate.hash === hashProfileBase(base)
  )
}

/** Validate, clone and deeply freeze a profile at a trust boundary. */
export function freezeOutcomeCalibrationProfile(
  profile: OutcomeCalibrationProfile,
): OutcomeCalibrationProfile {
  if (!isOutcomeCalibrationProfile(profile)) {
    throw new Error('invalid outcome calibration profile')
  }
  const entries = profile.entries.map(entry => Object.freeze({
    trigger: entry.trigger,
    action: entry.action,
    samples: entry.samples,
    effective: entry.effective,
    ineffective: entry.ineffective,
    smoothedEffectiveness: entry.smoothedEffectiveness,
  }))
  return Object.freeze({
    schemaVersion: 1,
    sourceSessions: profile.sourceSessions,
    pairedOutcomes: profile.pairedOutcomes,
    minSamples: profile.minSamples,
    maxSessions: profile.maxSessions,
    entries: Object.freeze(entries),
    hash: profile.hash,
  })
}

export function buildOutcomeCalibrationSelection(input: {
  origin: OutcomeCalibrationSelectionSource
  scanStatus: OutcomeCalibrationScanStatus
  eligibleBefore: string
  sources?: readonly OutcomeCalibrationSource[]
  profile: OutcomeCalibrationProfile
}): OutcomeCalibrationSelection {
  const profile = freezeOutcomeCalibrationProfile(input.profile)
  const sources = [...(input.sources ?? [])]
    .map(source => ({
      sessionId: source.sessionId,
      throughSeq: source.throughSeq,
      sampleCount: source.sampleCount,
      sampleHash: source.sampleHash,
    }))
    .sort(compareCalibrationSource)
  const base: CalibrationSelectionBase = {
    schemaVersion: 1,
    algorithm: 'reflection-window-v1',
    origin: input.origin,
    scanStatus: input.scanStatus,
    eligibleBefore: input.eligibleBefore,
    policy: {
      minSamples: profile.minSamples,
      maxSessions: profile.maxSessions,
    },
    sources,
    profile,
  }
  const selection = {
    ...base,
    hash: hashSelectionBase(base),
  }
  if (!isOutcomeCalibrationSelection(selection)) {
    throw new Error('invalid outcome calibration selection')
  }
  return freezeOutcomeCalibrationSelection(selection)
}

export function isOutcomeCalibrationSelection(
  value: unknown,
): value is OutcomeCalibrationSelection {
  if (!hasExactKeys(value, SELECTION_KEYS)) return false
  const candidate = value as Partial<OutcomeCalibrationSelection>
  if (
    candidate.schemaVersion !== 1 ||
    candidate.algorithm !== 'reflection-window-v1' ||
    !isSelectionSource(candidate.origin) ||
    !isScanStatus(candidate.scanStatus) ||
    !isCanonicalIso(candidate.eligibleBefore) ||
    !hasExactKeys(candidate.policy, POLICY_KEYS) ||
    !isPositiveInteger(candidate.policy.minSamples) ||
    candidate.policy.minSamples > 100 ||
    !isPositiveInteger(candidate.policy.maxSessions) ||
    candidate.policy.maxSessions > 500 ||
    !Array.isArray(candidate.sources) ||
    !candidate.sources.every(isCalibrationSource) ||
    !isOutcomeCalibrationProfile(candidate.profile) ||
    typeof candidate.hash !== 'string'
  ) {
    return false
  }
  if (
    candidate.policy.minSamples !== candidate.profile.minSamples ||
    candidate.policy.maxSessions !== candidate.profile.maxSessions
  ) {
    return false
  }
  const stableSources = [...candidate.sources].sort(compareCalibrationSource)
  if (
    !candidate.sources.every((source, index) => source === stableSources[index]) ||
    new Set(candidate.sources.map(source => source.sessionId)).size !==
      candidate.sources.length
  ) {
    return false
  }
  if (
    candidate.origin !== 'test_injected' &&
    (candidate.sources.length !== candidate.profile.sourceSessions ||
      candidate.sources.reduce((total, source) => total + source.sampleCount, 0) !==
        candidate.profile.pairedOutcomes)
  ) {
    return false
  }
  if (
    candidate.scanStatus === 'complete' &&
    candidate.origin !== 'test_injected' &&
    candidate.sources.length === 0
  ) {
    return false
  }
  if (
    candidate.scanStatus !== 'complete' &&
    (candidate.sources.length > 0 || candidate.profile.pairedOutcomes > 0)
  ) {
    return false
  }
  const base: CalibrationSelectionBase = {
    schemaVersion: 1,
    algorithm: 'reflection-window-v1',
    origin: candidate.origin,
    scanStatus: candidate.scanStatus,
    eligibleBefore: candidate.eligibleBefore,
    policy: {
      minSamples: candidate.policy.minSamples,
      maxSessions: candidate.policy.maxSessions,
    },
    sources: candidate.sources,
    profile: candidate.profile,
  }
  return candidate.hash === hashSelectionBase(base)
}

/** Validate, clone and deeply freeze a durable selection. */
export function freezeOutcomeCalibrationSelection(
  selection: OutcomeCalibrationSelection,
): OutcomeCalibrationSelection {
  if (!isOutcomeCalibrationSelection(selection)) {
    throw new Error('invalid outcome calibration selection')
  }
  return Object.freeze({
    schemaVersion: 1,
    algorithm: 'reflection-window-v1',
    origin: selection.origin,
    scanStatus: selection.scanStatus,
    eligibleBefore: selection.eligibleBefore,
    policy: Object.freeze({
      minSamples: selection.policy.minSamples,
      maxSessions: selection.policy.maxSessions,
    }),
    sources: Object.freeze(
      selection.sources.map(source => Object.freeze({
        sessionId: source.sessionId,
        throughSeq: source.throughSeq,
        sampleCount: source.sampleCount,
        sampleHash: source.sampleHash,
      })),
    ),
    profile: freezeOutcomeCalibrationProfile(selection.profile),
    hash: selection.hash,
  })
}

export function compareCalibrationEntry(
  a: OutcomeCalibrationEntry,
  b: OutcomeCalibrationEntry,
): number {
  return compareText(a.trigger, b.trigger) || compareText(a.action, b.action)
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function roundCalibrationRate(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

export function isOutcomeCalibrationTrigger(
  value: unknown,
): value is ReflectionRecord['trigger'] {
  return typeof value === 'string' &&
    REFLECTION_TRIGGERS.has(value as ReflectionRecord['trigger'])
}

export function isOutcomeCalibrationAction(
  value: unknown,
): value is SupervisorAction {
  return typeof value === 'string' &&
    SUPERVISOR_ACTIONS.has(value as SupervisorAction)
}

export function isOutcomeCalibrationCutoff(value: unknown): value is string {
  return isCanonicalIso(value)
}

function calibrationKey(entry: OutcomeCalibrationEntry): string {
  return `${entry.trigger}\u0000${entry.action}`
}

function hashProfileBase(base: CalibrationProfileBase): string {
  return createHash('sha256')
    .update(JSON.stringify(base))
    .digest('hex')
    .slice(0, 16)
}

function hashSelectionBase(base: CalibrationSelectionBase): string {
  return createHash('sha256')
    .update(JSON.stringify(base))
    .digest('hex')
}

function isSelectionSource(
  value: unknown,
): value is OutcomeCalibrationSelectionSource {
  return value === 'history_scan' ||
    value === 'legacy_backfill' ||
    value === 'test_injected'
}

function isScanStatus(value: unknown): value is OutcomeCalibrationScanStatus {
  return value === 'complete' ||
    value === 'no_history' ||
    value === 'history_unavailable'
}

function compareCalibrationSource(
  a: OutcomeCalibrationSource,
  b: OutcomeCalibrationSource,
): number {
  return compareText(a.sessionId, b.sessionId)
}

function isCalibrationSource(value: unknown): value is OutcomeCalibrationSource {
  if (!hasExactKeys(value, SOURCE_KEYS)) return false
  const source = value as Partial<OutcomeCalibrationSource>
  return (
    typeof source.sessionId === 'string' &&
    source.sessionId.length > 0 &&
    Number.isInteger(source.throughSeq) &&
    (source.throughSeq as number) > 0 &&
    Number.isInteger(source.sampleCount) &&
    (source.sampleCount as number) > 0 &&
    typeof source.sampleHash === 'string' &&
    /^[a-f0-9]{64}$/.test(source.sampleHash)
  )
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}

function isCalibrationEntry(value: unknown): value is OutcomeCalibrationEntry {
  if (!hasExactKeys(value, ENTRY_KEYS)) return false
  const entry = value as Partial<OutcomeCalibrationEntry>
  return (
    isOutcomeCalibrationTrigger(entry.trigger) &&
    isOutcomeCalibrationAction(entry.action) &&
    isPositiveInteger(entry.samples) &&
    isNonNegativeInteger(entry.effective) &&
    isNonNegativeInteger(entry.ineffective) &&
    entry.effective + entry.ineffective === entry.samples &&
    typeof entry.smoothedEffectiveness === 'number' &&
    entry.smoothedEffectiveness >= 0 &&
    entry.smoothedEffectiveness <= 1 &&
    Number.isFinite(entry.smoothedEffectiveness) &&
    entry.smoothedEffectiveness ===
      roundCalibrationRate((entry.effective + 1) / (entry.samples + 2))
  )
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort(compareText)
  const canonical = [...expected].sort(compareText)
  return actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
}
