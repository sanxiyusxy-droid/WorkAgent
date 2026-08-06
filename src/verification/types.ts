/** Evidence & verification domain types (guide §9). */

export type EvidenceKind =
  | 'command'
  | 'test'
  | 'file_assertion'
  | 'diff_assertion'
  | 'manual'

/**
 * Kinds that verify CODE BEHAVIOR (tests pass, build passes, runtime
 * behavior). They must be bound to a workspace version — a receipt with no
 * freshness binding can never support a PASS about the current workspace
 * (finish-list §1.6). Manual observations are revision-bound as well.
 */
export const CODE_BINDING_KINDS: ReadonlySet<EvidenceKind> = new Set([
  'command',
  'test',
  'file_assertion',
  'diff_assertion',
  'manual',
])

export interface EvidenceReceipt {
  id: string
  sessionId: string
  runId: string
  taskId?: string
  criterionIds: string[]
  kind: EvidenceKind
  status: 'passed' | 'failed' | 'inconclusive'
  invocation: {
    tool: string
    normalizedInput: unknown
    cwd?: string
  }
  observation: {
    exitCode?: number
    outputPreview: string
  }
  startedAt: string
  completedAt: string
  sha256: string
  /** binding: workspace root where the evidence was produced */
  workspaceRoot?: string
  /** binding: file versions (path -> sha) at the time of evidence collection */
  fileVersions?: Record<string, string>
  /**
   * binding: workspace revision (count of workspace.changed facts) at sign
   * time. Receipts without fine-grained fileVersions are judged fresh only
   * while the workspace revision has not advanced past this value.
   */
  workspaceRevision?: number
}

export type Verdict = 'PASS' | 'FAIL' | 'PARTIAL'

export interface VerificationCheck {
  name: string
  criterionIds: string[]
  evidenceIds: string[]
  result: 'PASS' | 'FAIL' | 'SKIP'
  expected: string
  actual: string
}

export interface VerificationReport {
  verdict: Verdict
  summary: string
  checks: VerificationCheck[]
  adversarialProbeEvidenceId?: string
  failures: Array<{
    title: string
    severity: 'low' | 'medium' | 'high'
    reproduction: string[]
    evidenceIds: string[]
  }>
  unverified: Array<{ item: string; reason: string }>
}
