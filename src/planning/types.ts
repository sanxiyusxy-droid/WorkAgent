/** Planning domain types (guide §8). */

export interface AcceptanceCriterion {
  id: string
  statement: string
  evidenceKind: 'command' | 'test' | 'file_assertion' | 'diff_assertion' | 'manual'
  required: boolean
}

export interface PlanStep {
  id: string
  title: string
  description: string
  files: string[]
  dependsOn: string[]
  expectedOutcome: string
}

export interface PlanVersion {
  planId: string
  version: number
  status: 'draft' | 'awaiting_approval' | 'approved' | 'superseded'
  goal: string
  nonGoals: string[]
  assumptions: string[]
  decisions: Array<{ decision: string; rationale: string }>
  steps: PlanStep[]
  acceptanceCriteria: AcceptanceCriterion[]
  risks: string[]
  createdAt: string
  approvedAt?: string
  approvalTokenId?: string
}

export interface ApprovalToken {
  token: string
  sessionId: string
  planId: string
  planVersion: number
  action: 'exit_plan_mode'
  issuedAt: string
  expiresAt: string
  consumedAt?: string
}

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'failed'

export interface PlanTask {
  id: string
  planId?: string
  planVersion?: number
  subject: string
  description: string
  activeForm: string
  status: TaskStatus
  dependsOn: string[]
  /** acceptance criterion ids that must have passed evidence to complete */
  acceptanceCriteria: string[]
  evidenceIds: string[]
  blockedReason?: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface UpdateTaskInput {
  id: string
  expectedRevision: number
  patch: Partial<
    Pick<
      PlanTask,
      | 'subject'
      | 'description'
      | 'activeForm'
      | 'status'
      | 'dependsOn'
      | 'acceptanceCriteria'
      | 'evidenceIds'
      | 'blockedReason'
    >
  >
}
