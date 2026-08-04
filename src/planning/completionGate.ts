import type { AgentState } from '../core/state.js'
import type { AcceptanceCriterion, PlanVersion } from './types.js'
import type { EvidenceReceipt } from '../verification/types.js'

export interface CompletionRequirement {
  kind: 'open_tasks' | 'missing_evidence' | 'blocked_tasks'
  detail: string
}

export interface CompletionGateResult {
  action: 'complete' | 'continue'
  requiresVerification: boolean
  missing: CompletionRequirement[]
  /** engine-injected message when action === 'continue' */
  message?: string
  riskScore: number
}

/**
 * Completion is evidence-driven (guide §9.6). The gate never reads the
 * assistant's prose — only task state, criteria coverage and risk.
 */
export function evaluateCompletion(input: {
  state: AgentState
  approvedPlan?: PlanVersion
  evidence: EvidenceReceipt[]
  riskThreshold: number
}): CompletionGateResult {
  const { state, approvedPlan, evidence } = input
  const missing: CompletionRequirement[] = []

  // 1. open tasks
  const open = state.tasks.filter(
    t => t.status === 'pending' || t.status === 'in_progress',
  )
  if (open.length > 0) {
    missing.push({
      kind: 'open_tasks',
      detail: `open tasks: ${open.map(t => `${t.id}(${t.status})`).join(', ')}`,
    })
  }
  const blocked = state.tasks.filter(t => t.status === 'blocked')
  if (blocked.length > 0) {
    missing.push({
      kind: 'blocked_tasks',
      detail: `blocked tasks: ${blocked
        .map(t => `${t.id}: ${t.blockedReason ?? 'no reason'}`)
        .join('; ')}`,
    })
  }

  // 2. required acceptance criteria of the approved plan need passed evidence
  if (approvedPlan) {
    const uncovered = requiredCriteriaWithoutEvidence(
      approvedPlan.acceptanceCriteria,
      evidence,
    )
    if (uncovered.length > 0) {
      missing.push({
        kind: 'missing_evidence',
        detail:
          `required acceptance criteria without passed evidence: ` +
          uncovered.map(c => `${c.id} ("${c.statement}")`).join(', '),
      })
    }
  }

  const riskScore = verificationRisk(state)

  if (missing.length > 0) {
    return {
      action: 'continue',
      requiresVerification: false,
      missing,
      riskScore,
      message:
        'Completion gate: the run is not finishable yet.\n' +
        missing.map(m => `- [${m.kind}] ${m.detail}`).join('\n') +
        '\nEither finish the work (with evidence) or mark tasks blocked/failed ' +
        'with honest reasons, then summarize the true state.',
    }
  }

  return {
    action: 'complete',
    requiresVerification: riskScore >= input.riskThreshold,
    missing: [],
    riskScore,
  }
}

export function requiredCriteriaWithoutEvidence(
  criteria: AcceptanceCriterion[],
  evidence: EvidenceReceipt[],
): AcceptanceCriterion[] {
  return criteria
    .filter(c => c.required && c.evidenceKind !== 'manual')
    .filter(
      c =>
        !evidence.some(
          e => e.criterionIds.includes(c.id) && e.status === 'passed',
        ),
    )
}

/** Risk scoring (guide §9.6): decides whether L2 verification is forced. */
export function verificationRisk(state: AgentState): number {
  let score = 0
  const writes = Object.values(state.toolResults).filter(
    r =>
      (r.toolName === 'Edit' || r.toolName === 'Write' || r.toolName === 'ApplyPatch') &&
      r.ok,
  )
  score += Math.min(writes.length, 5)
  const shellWrites = Object.values(state.toolResults).filter(
    r => r.toolName === 'Shell' && r.ok,
  )
  score += Math.min(shellWrites.length, 3)
  const failures = Object.values(state.toolResults).filter(r => !r.ok)
  score += Math.min(failures.length, 2)
  return score
}
