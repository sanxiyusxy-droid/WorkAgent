import { createHash } from 'node:crypto'
import type { ToolCall } from './messages.js'
import type {
  ExecutionStrategy,
  PlanHealthAssessment,
  ReflectionRecord,
  StagnationRecord,
} from './events.js'
import type { AgentState } from './state.js'

const HISTORY_LIMIT = 12

export function fingerprintToolCall(call: Pick<ToolCall, 'name' | 'input'>): string {
  const canonical = stableStringify(call.input)
  return `${call.name}:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
}

export function appendBounded<T>(items: T[], item: T): T[] {
  return [...items, item].slice(-HISTORY_LIMIT)
}

export function toolOutcomeSignature(input: {
  toolName: string
  ok: boolean
  errorCode?: string
}): string {
  return input.ok
    ? `ok:${input.toolName}`
    : `error:${input.toolName}:${input.errorCode ?? 'UNKNOWN'}`
}

/** Pure policy: identical recovered state always produces the same result. */
export function detectStagnation(state: AgentState): StagnationRecord | null {
  const fingerprints = state.recovery.recentToolFingerprints
  const outcomes = state.recovery.recentOutcomeSignatures

  const lastThreeCalls = fingerprints.slice(-3)
  if (lastThreeCalls.length === 3 && new Set(lastThreeCalls).size === 1) {
    const signature = `repeated_call:${lastThreeCalls[0]}`
    if (signature !== state.recovery.lastStagnationSignature) {
      return {
        kind: 'repeated_call',
        signature,
        score: 1,
        detail: 'The same tool and arguments were issued three times consecutively.',
      }
    }
  }

  const lastThreeOutcomes = outcomes.slice(-3)
  if (
    lastThreeOutcomes.length === 3 &&
    lastThreeOutcomes[0]!.startsWith('error:') &&
    new Set(lastThreeOutcomes).size === 1
  ) {
    const signature = `repeated_failure:${lastThreeOutcomes[0]}`
    if (signature !== state.recovery.lastStagnationSignature) {
      return {
        kind: 'repeated_failure',
        signature,
        score: 1,
        detail: 'The last three tool calls failed with the same tool/error signature.',
      }
    }
  }

  const callsWithoutProgress =
    state.budget.used.toolCalls - state.recovery.lastProgressToolCalls
  const recent = fingerprints.slice(-8)
  if (
    callsWithoutProgress >= 8 &&
    recent.length >= 8 &&
    new Set(recent).size <= 3
  ) {
    const signature = `no_progress:${recent.join('|')}`
    if (signature !== state.recovery.lastStagnationSignature) {
      return {
        kind: 'no_progress',
        signature,
        score: Math.min(1, callsWithoutProgress / 12),
        detail:
          `${callsWithoutProgress} tool calls produced no workspace, task, or evidence progress ` +
          'while cycling through at most three operations.',
      }
    }
  }
  return null
}

export function deriveExecutionStrategy(state: AgentState): {
  strategy: ExecutionStrategy
  reason: string
} | null {
  const ratios = [
    remainingRatio(state.budget.used.modelCalls, state.budget.maxModelCalls),
    remainingRatio(state.budget.used.toolCalls, state.budget.maxToolCalls),
    remainingRatio(state.iteration, state.budget.maxTurns),
  ]
  const remaining = Math.min(...ratios)
  let desired: ExecutionStrategy = 'normal'
  let reason = `minimum remaining call/turn budget is ${Math.round(remaining * 100)}%`
  if (remaining <= 0.15) {
    desired = 'critical'
  } else if (
    remaining <= 0.4 ||
    state.recovery.consecutiveFailures >= 2 ||
    state.recovery.stagnationCount >= 2 ||
    state.recovery.ineffectiveReflectionCount >= 2
  ) {
    desired = 'conservative'
    if (state.recovery.stagnationCount >= 2) {
      reason = `${state.recovery.stagnationCount} stagnation signals were recorded`
    } else if (state.recovery.consecutiveFailures >= 2) {
      reason = `${state.recovery.consecutiveFailures} consecutive failed tool batches`
    } else if (state.recovery.ineffectiveReflectionCount >= 2) {
      reason =
        `${state.recovery.ineffectiveReflectionCount} consecutive reflection recommendations ` +
        'produced no measurable progress'
    }
  }

  // Strategy only tightens during a run. This prevents prompt/config
  // oscillation near a threshold and makes replay behavior easy to audit.
  if (rank(desired) <= rank(state.recovery.executionStrategy)) return null
  return { strategy: desired, reason }
}

export function strategyInstructions(strategy: ExecutionStrategy): string | undefined {
  if (strategy === 'normal') return undefined
  if (strategy === 'conservative') {
    return [
      'Execution strategy: CONSERVATIVE.',
      'Batch related reads, reuse existing observations, prefer a local step repair over replacing the whole plan,',
      'and avoid speculative scope expansion. Verify the highest-risk unknown first.',
    ].join(' ')
  }
  return [
    'Execution strategy: CRITICAL BUDGET.',
    'Do not expand scope. Use existing evidence, perform only completion-critical actions,',
    'and finish with an explicit blocked/unverified result if correctness cannot be established safely.',
  ].join(' ')
}

export function adaptiveMaxOutputTokens(
  configured: number,
  strategy: ExecutionStrategy,
): number {
  if (strategy === 'critical') return Math.min(configured, 1_024)
  if (strategy === 'conservative') return Math.min(configured, 2_048)
  return configured
}

export function shouldReflect(
  state: AgentState,
  trigger: ReflectionRecord['trigger'],
  interval: number,
): boolean {
  if (trigger === 'stagnation' || trigger === 'replan' || trigger === 'verification') {
    return true
  }
  if (
    state.recovery.lastReflectionTrigger === trigger &&
    state.recovery.lastReflectionToolCalls === state.budget.used.toolCalls
  ) {
    return false
  }
  if (trigger === 'completion') return true
  return state.budget.used.toolCalls - state.recovery.lastReflectionToolCalls >= interval
}

export function buildReflection(input: {
  state: AgentState
  id: string
  createdAt: string
  trigger: ReflectionRecord['trigger']
  detail?: string
  assessment?: PlanHealthAssessment
  evaluationWindow?: number
}): ReflectionRecord {
  const { state, trigger } = input
  const completedTasks = state.tasks.filter(task => task.status === 'completed').length
  const evidenceGaps: string[] = []
  if (state.activePlan?.approved && state.evidenceIds.length === 0) {
    evidenceGaps.push('The approved plan has no recorded evidence receipts yet.')
  }
  if (state.workspace.touchedFiles.length > 0 && !state.lastVerification) {
    evidenceGaps.push('Workspace changes have not received an independent verification verdict.')
  }
  if (
    input.assessment &&
    input.assessment.metrics.coveredCriteria < input.assessment.metrics.requiredCriteria
  ) {
    evidenceGaps.push(
      `${input.assessment.metrics.requiredCriteria - input.assessment.metrics.coveredCriteria} ` +
      'required acceptance criteria lack usable evidence.',
    )
  }
  if (input.assessment?.metrics.blockedTasks) {
    evidenceGaps.push(
      `${input.assessment.metrics.blockedTasks} blocked task(s) require an explicit resolution.`,
    )
  }
  const assumptions = [
    state.activePlan
      ? `Active plan ${state.activePlan.planId}@${state.activePlan.version} is ` +
        (state.activePlan.approved ? 'approved.' : 'not approved.')
      : 'No active persisted plan is assumed.',
    `${state.recovery.consecutiveFailures} consecutive failed tool batches are currently tracked.`,
  ]
  const recommendation = recommendationFor(trigger, state.recovery.executionStrategy)
  const successfulToolCalls = Object.values(state.toolResults).filter(result => result.ok).length
  const supervisedRecommendation = input.assessment
    ? `${input.assessment.decision.action}: ${input.assessment.decision.rationale}`
    : recommendation
  return {
    id: input.id,
    trigger,
    createdAt: input.createdAt,
    summary:
      input.detail ??
      `${completedTasks}/${state.tasks.length} tasks completed; ` +
      `${state.workspace.touchedFiles.length} files touched; ` +
      `${state.evidenceIds.length} evidence receipts recorded.`,
    assumptions,
    progress: {
      completedTasks,
      totalTasks: state.tasks.length,
      touchedFiles: state.workspace.touchedFiles.length,
      toolCalls: state.budget.used.toolCalls,
      evidenceReceipts: state.evidenceIds.length,
      successfulToolCalls,
    },
    evidenceGaps,
    recommendation: supervisedRecommendation,
    decision: input.assessment
      ? {
          ...input.assessment.decision,
          successSignals: [...input.assessment.decision.successSignals],
          evaluateAfterToolCalls: Math.max(1, input.evaluationWindow ?? 3),
        }
      : undefined,
  }
}

export function renderReflection(reflection: ReflectionRecord): string {
  return [
    `[ENGINE REFLECTION: ${reflection.trigger}]`,
    `Summary: ${reflection.summary}`,
    `Assumptions: ${reflection.assumptions.join(' ')}`,
    `Evidence gaps: ${reflection.evidenceGaps.length > 0 ? reflection.evidenceGaps.join(' ') : 'none identified'}`,
    `Next strategy: ${reflection.recommendation}`,
    reflection.decision
      ? `Success signals: ${reflection.decision.successSignals.join('; ')}. Evaluate after ${reflection.decision.evaluateAfterToolCalls} tool call(s).`
      : undefined,
    'Do not repeat an unchanged failing action; update the hypothesis or repair only the affected plan step.',
  ].filter((line): line is string => Boolean(line)).join('\n')
}

function remainingRatio(used: number, max: number): number {
  if (max <= 0) return 0
  return Math.max(0, Math.min(1, (max - used) / max))
}

function rank(strategy: ExecutionStrategy): number {
  return strategy === 'normal' ? 0 : strategy === 'conservative' ? 1 : 2
}

function recommendationFor(
  trigger: ReflectionRecord['trigger'],
  strategy: ExecutionStrategy,
): string {
  if (strategy === 'critical') {
    return 'Resolve only completion-critical gaps, then terminate explicitly.'
  }
  if (trigger === 'stagnation') {
    return 'Change the working hypothesis, gather one discriminating observation, or repair the failed step.'
  }
  if (trigger === 'verification') {
    return 'Fix only reproduced verification findings and refresh their evidence.'
  }
  if (trigger === 'replan') {
    return 'Preserve unaffected plan steps and revise the smallest failed unit.'
  }
  if (trigger === 'completion') {
    return 'Check evidence freshness and acceptance criteria before claiming completion.'
  }
  return 'Compare progress with the plan, close the highest-risk evidence gap, and continue.'
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}
