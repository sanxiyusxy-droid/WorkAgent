import type { AgentState } from '../core/state.js'
import type { AcceptanceCriterion, PlanVersion } from './types.js'
import type { EvidenceReceipt } from '../verification/types.js'
import { requiredCriteriaWithoutUsableEvidence } from '../verification/criteriaEvidence.js'

export interface CompletionRequirement {
  kind:
    | 'open_tasks'
    | 'missing_evidence'
    | 'manual_verification_required'
    | 'blocked_tasks'
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
  /**
   * receipts that no longer match the current workspace (finish-list §1.6);
   * stale receipts cannot satisfy any acceptance criterion
   */
  staleEvidenceIds?: ReadonlySet<string>
  /** workspace in which the run is being completed */
  workspaceRoot?: string
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
      input.staleEvidenceIds,
      input.workspaceRoot,
    )
    const missingManual = uncovered.filter(c => c.evidenceKind === 'manual')
    const missingAutomated = uncovered.filter(c => c.evidenceKind !== 'manual')
    if (missingAutomated.length > 0) {
      missing.push({
        kind: 'missing_evidence',
        detail:
          `required acceptance criteria without fresh, kind-matched, passed evidence: ` +
          missingAutomated.map(c => `${c.id} ("${c.statement}")`).join(', '),
      })
    }
    if (missingManual.length > 0) {
      missing.push({
        kind: 'manual_verification_required',
        detail:
          'required manual acceptance criteria still need trusted, fresh runtime evidence: ' +
          missingManual.map(c => `${c.id} ("${c.statement}")`).join(', '),
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

/**
 * A required criterion is covered only by a receipt that is kind-matched,
 * status 'passed' AND still fresh (finish-list §1.6): an unbound or stale
 * test result about an older workspace cannot complete the run.
 */
export function requiredCriteriaWithoutEvidence(
  criteria: AcceptanceCriterion[],
  evidence: EvidenceReceipt[],
  staleEvidenceIds?: ReadonlySet<string>,
  workspaceRoot?: string,
): AcceptanceCriterion[] {
  return requiredCriteriaWithoutUsableEvidence(criteria, evidence, {
    staleEvidenceIds,
    expectedWorkspaceRoot: workspaceRoot,
  })
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
