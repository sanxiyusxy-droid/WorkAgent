import type { AgentState } from '../core/state.js'
import type { AcceptanceCriterion, PlanVersion } from './types.js'
import type { EvidenceReceipt } from '../verification/types.js'
import {
  receiptIsUsable,
  requiredCriteriaWithoutUsableEvidence,
} from '../verification/criteriaEvidence.js'
import { tasksForPlan } from './PlanSupervisor.js'
import { workspacePathKey } from '../workspace/pathKey.js'

export interface CompletionRequirement {
  kind:
    | 'open_tasks'
    | 'missing_evidence'
    | 'manual_verification_required'
    | 'blocked_tasks'
    | 'failed_tasks'
    | 'replan_in_progress'
    | 'unverified_workspace_changes'
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
  /** current runtime workspace revision; used by the implicit no-plan gate */
  workspaceRevision?: number
}): CompletionGateResult {
  const { state, approvedPlan, evidence } = input
  const missing: CompletionRequirement[] = []

  if (state.recovery.replanning) {
    missing.push({
      kind: 'replan_in_progress',
      detail: state.recovery.replanAwaitingApproval
        ? 'a replacement plan is still awaiting approval'
        : 'a durable low-impact plan adjustment is still open',
    })
  }

  // 1. open tasks
  const currentTasks = tasksForPlan(state.tasks, approvedPlan)
  const open = currentTasks.filter(
    t => t.status === 'pending' || t.status === 'in_progress',
  )
  if (open.length > 0) {
    missing.push({
      kind: 'open_tasks',
      detail: `open tasks: ${open.map(t => `${t.id}(${t.status})`).join(', ')}`,
    })
  }
  const blocked = currentTasks.filter(t => t.status === 'blocked')
  if (blocked.length > 0) {
    missing.push({
      kind: 'blocked_tasks',
      detail: `blocked tasks: ${blocked
        .map(t => `${t.id}: ${t.blockedReason ?? 'no reason'}`)
        .join('; ')}`,
    })
  }
  const failed = currentTasks.filter(t => t.status === 'failed')
  if (failed.length > 0) {
    missing.push({
      kind: 'failed_tasks',
      detail: `failed tasks: ${failed.map(t => t.id).join(', ')}`,
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

  // 3. Mutation verification is a durable state obligation, independent of
  // compressible model messages and independent of whether a plan exists.
  // It is opened before a side effect starts and therefore also covers
  // postcondition failures, process crashes and unknown Shell outcomes.
  const pendingMutation = state.workspace.pendingVerification
  const hasRelevantMutationEvidence = pendingMutation
    ? evidenceSatisfiesPendingMutation(evidence, {
        state,
        staleEvidenceIds: input.staleEvidenceIds,
        workspaceRoot: input.workspaceRoot,
        workspaceRevision: input.workspaceRevision,
      })
    : true
  if (
    pendingMutation &&
    !hasRelevantMutationEvidence
  ) {
    const sources = pendingMutation.sources
      .map(source => `${source.toolName}:${source.callId}(${source.outcome})`)
      .join(', ')
    const scope =
      pendingMutation.scope === 'workspace'
        ? 'the whole workspace (the exact Shell write set is unknown)'
        : `paths ${pendingMutation.changedPaths.join(', ')}`
    missing.push({
      kind: 'unverified_workspace_changes',
      detail:
        `a durable workspace verification obligation is still open for ${scope}; ` +
        `sources: ${sources}. Evidence must be collected at workspace revision ` +
        `${pendingMutation.revision}, use a runtime-observed test/build/lint/` +
        'typecheck or assertion, and bind every known changed path. Version/help ' +
        'commands and model-declared evidenceKind alone do not verify the change',
    })
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
        '\nRepair or replan failed/blocked work and attach the required evidence; ' +
        'do not claim completion while these requirements remain.',
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

function evidenceSatisfiesPendingMutation(
  evidence: EvidenceReceipt[],
  input: {
    state: AgentState
    staleEvidenceIds?: ReadonlySet<string>
    workspaceRoot?: string
    workspaceRevision?: number
  },
): boolean {
  const pending = input.state.workspace.pendingVerification
  if (!pending) return true
  const expectedRevision = input.workspaceRevision ?? input.state.workspace.revision
  if (
    expectedRevision !== pending.revision ||
    pending.revision !== input.state.workspace.revision
  ) {
    return false
  }
  const candidates = evidence.filter(receipt =>
    receipt.workspaceRevision === expectedRevision &&
    receipt.sessionId === input.state.sessionId &&
    receipt.runId === input.state.runId &&
    receiptIsUsable(receipt, {
      staleEvidenceIds: input.staleEvidenceIds,
      expectedWorkspaceRoot: input.workspaceRoot,
    }) &&
    validationScope(receipt, pending.changedPaths) !== undefined,
  )
  if (pending.scope === 'workspace') {
    const hasGlobalValidator = candidates.some(
      receipt => validationScope(receipt, pending.changedPaths) === 'workspace',
    )
    if (!hasGlobalValidator) return false
    // Unknown workspace scope requires a global validator. When exact paths
    // are also known from earlier mutations, the receipts must additionally
    // bind every one of them at this revision; otherwise an unrelated global
    // command could conceal an unobserved known file change.
    if (pending.changedPaths.length === 0) return true
  }

  const root = input.workspaceRoot ?? input.state.workspace.root
  const covered = new Set<string>()
  for (const receipt of candidates) {
    for (const path of receiptCoveredMutationPaths(
      receipt,
      pending.changedPaths,
      root,
    )) {
      covered.add(path)
    }
  }
  return pending.changedPaths.every(path => covered.has(path))
}

function validationScope(
  receipt: EvidenceReceipt,
  changedPaths: string[],
): 'paths' | 'workspace' | undefined {
  const tool = receipt.invocation.tool
  if (tool === 'FileAssert') {
    return receipt.kind === 'file_assertion' ? 'paths' : undefined
  }
  if (tool === 'DiffAssert') {
    return receipt.kind === 'diff_assertion' ? 'paths' : undefined
  }
  if (tool === 'ManualVerify') return undefined
  if (tool !== 'Shell' && tool !== 'ShellReadOnly') return undefined
  if (receipt.kind !== 'command' && receipt.kind !== 'test') return undefined

  const normalized = receipt.invocation.normalizedInput
  if (!normalized || typeof normalized !== 'object' || !('command' in normalized)) {
    return undefined
  }
  const command = (normalized as { command?: unknown }).command
  return typeof command === 'string'
    ? recognizedValidationScope(command, changedPaths)
    : undefined
}

function receiptBoundPaths(
  receipt: EvidenceReceipt,
  workspaceRoot: string,
): Set<string> {
  const bound = new Set<string>()
  if (!receipt.fileVersions) return bound
  for (const path of Object.keys(receipt.fileVersions)) {
    try {
      bound.add(workspacePathKey(workspaceRoot, path))
    } catch {
      // A signed binding outside the workspace is irrelevant, never coverage.
    }
  }
  return bound
}

function receiptCoveredMutationPaths(
  receipt: EvidenceReceipt,
  changedPaths: string[],
  workspaceRoot: string,
): Set<string> {
  const bound = receiptBoundPaths(receipt, workspaceRoot)
  const normalizedInput = receipt.invocation.normalizedInput
  if (
    (receipt.invocation.tool === 'Shell' ||
      receipt.invocation.tool === 'ShellReadOnly') &&
    normalizedInput &&
    typeof normalizedInput === 'object' &&
    'command' in normalizedInput &&
    typeof (normalizedInput as { command?: unknown }).command === 'string'
  ) {
    const command = (normalizedInput as { command: string }).command
      .replace(/\\/g, '/')
      .toLowerCase()
    if (/^(?:rg|grep)\b/.test(command.trim())) {
      return new Set(
        changedPaths.filter(path => {
          return bound.has(path) && commandMentionsPath(command, path)
        }),
      )
    }
  }
  return bound
}

/**
 * Completion evidence is based on the actual runtime command, never merely
 * on the model-selected evidenceKind. The allowlist intentionally names
 * validators/assertions rather than arbitrary successful commands.
 */
function recognizedValidationScope(
  command: string,
  changedPaths: string[],
): 'paths' | 'workspace' | undefined {
  // Completion proof accepts one simple command only. Shell control syntax
  // can turn a real validator into an unconditional success (`|| true`) or
  // add unobserved side effects, so reject it before normalization.
  if (/[|&;<>{}\r\n`]|\$\(|\$\{/.test(command)) return undefined
  const normalized = command.trim().replace(/\\/g, '/').toLowerCase()
  if (!normalized) return undefined
  if (
    /(?:^|\s)(?:--help|-h|--version|-v|--dry-run|--listtests|--if-present|--passwithnotests|--allow-no-tests)(?:[\s=]|$)/i.test(
      normalized,
    )
  ) {
    return undefined
  }

  const validatorPatterns = [
    /^(?:npm(?:\.cmd)?|pnpm|yarn|bun)\s+(?:test\b|(?:run\s+)?(?:test|build|lint|typecheck|check|verify)(?::[\w.-]+)?\b)/,
    /^(?:npx|pnpm\s+exec|yarn\s+dlx|bunx)\s+(?:vitest|jest|eslint|tsc|mocha|ava)\b/,
    /^node\s+--test(?:\s|$)/,
    /^(?:pytest|python(?:3)?\s+-m\s+pytest)(?:\s|$)/,
    /^(?:cargo\s+(?:test|check|clippy)|go\s+test|dotnet\s+(?:test|build)|mvn\s+(?:test|verify)|gradle\s+(?:test|check|build)|make\s+(?:test|check|build|lint))(?:\s|$)/,
    /^(?:tsc\b|eslint\b|vitest\b|jest\b)/,
    /^git\s+diff\b.*(?:^|\s)--check(?:\s|$)/,
  ]
  if (validatorPatterns.some(pattern => pattern.test(normalized))) {
    return 'workspace'
  }

  // Grep/ripgrep is accepted as a narrow assertion only when its command
  // names every changed path; fileVersions separately proves exact binding.
  if (!/^(?:rg|grep)\b/.test(normalized) || changedPaths.length === 0) {
    return undefined
  }
  return changedPaths.some(path => {
    return commandMentionsPath(normalized, path)
  }) ? 'paths' : undefined
}

function commandMentionsPath(command: string, path: string): boolean {
  const normalized = command.replace(/\\/g, '/').toLowerCase()
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase()
  const escaped = normalizedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s"'])(?:\\./)?${escaped}(?=$|[\\s"'])`).test(
    normalized,
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
