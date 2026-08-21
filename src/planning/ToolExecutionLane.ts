import { createHash } from 'node:crypto'
import {
  isSupervisorAction,
  type AgentMode,
  type PlanHealthAssessment,
  type SupervisorAction,
} from '../core/events.js'
import type { StructuredToolError } from '../core/messages.js'
import { InvariantError } from '../core/messages.js'

/**
 * A turn-frozen projection of the tools that the current supervisor action may
 * reach. The projection can only REMOVE tools already admitted by mode and the
 * write lock; it is not an authorization grant and never bypasses policy.
 */
export interface ToolExecutionLane {
  version: 1
  action: SupervisorAction
  assessmentSignature: string
  lane: 'open' | 'evidence' | 'verification' | 'plan_repair' | 'approval' | 'finish'
  mode: AgentMode
  writeLocked: boolean
  replanning: boolean
  allowedTools: readonly string[]
  blockedTools: readonly string[]
  hash: string
  instruction: string
}

export interface ToolExecutionLaneInput {
  assessment?: PlanHealthAssessment
  mode: AgentMode
  writeLocked: boolean
  /** Names already admitted by the stricter mode/write-lock projection. */
  candidateTools: readonly string[]
  /** True after the engine has opened the explicit replan state machine. */
  replanning?: boolean
}

const INSPECTION_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'CodeSymbols',
  'FindReferences',
  'CallGraph',
  'CodeDiagnostics',
  'SearchCodeIndex',
  'ExpandCodeContext',
  'RefreshCodeIndex',
  'CodeIndexStatus',
  'ShellReadOnly',
  'AskUser',
  'TaskList',
])

const EVIDENCE_TOOLS = new Set([
  ...INSPECTION_TOOLS,
  'Shell',
  'FileAssert',
  'DiffAssert',
  'ManualVerify',
  'TaskUpdate',
])

const VERIFICATION_TOOLS = new Set([
  ...INSPECTION_TOOLS,
  'Shell',
  'FileAssert',
  'DiffAssert',
  'ManualVerify',
])

const PLAN_REPAIR_TOOLS = new Set([
  ...INSPECTION_TOOLS,
  'EnterPlanMode',
  'PlanRepair',
  'PlanPropose',
  'ExitPlanMode',
  'TaskCreate',
  'TaskUpdate',
])

const PLAN_REPAIR_ACTIVE_TOOLS = new Set([
  ...INSPECTION_TOOLS,
  'EnterPlanMode',
  'PlanRepair',
  'PlanPropose',
  'ExitPlanMode',
])

const APPROVAL_TOOLS = new Set([
  ...INSPECTION_TOOLS,
  'PlanPropose',
  'ExitPlanMode',
])

const FINISH_TOOLS = new Set([
  ...INSPECTION_TOOLS,
  'FileAssert',
  'DiffAssert',
  'ManualVerify',
])

/** Build one immutable, deterministic projection for a model turn and batch. */
export function buildToolExecutionLane(
  input: ToolExecutionLaneInput,
): Readonly<ToolExecutionLane> | undefined {
  const assessment = input.assessment
  if (!assessment || assessment.status === 'not_applicable') return undefined
  const action = assessment.decision.action
  if (!isSupervisorAction(action)) {
    throw new InvariantError(
      'tool_lane_unknown_action',
      `Cannot project tools for unknown supervisor action: ${String(action)}`,
    )
  }
  const lane = laneFor(action)
  const candidates = stableNames(input.candidateTools)
  const actionAllowed = allowSetFor(action, input.replanning === true)
  const allowedTools = actionAllowed
    ? candidates.filter(name => actionAllowed.has(name))
    : candidates
  const allowed = new Set(allowedTools)
  const blockedTools = candidates.filter(name => !allowed.has(name))
  const payload = {
    version: 1 as const,
    action,
    assessmentSignature: assessment.signature,
    lane,
    mode: input.mode,
    writeLocked: input.writeLocked,
    replanning: input.replanning === true,
    allowedTools,
    blockedTools,
  }
  const hash = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 16)
  return deepFreeze({
    ...payload,
    hash,
    instruction: instructionFor(action, hash),
  })
}

export function isToolAllowedByLane(
  lane: Readonly<ToolExecutionLane> | undefined,
  name: string,
): boolean {
  return !lane || lane.allowedTools.includes(name)
}

/**
 * Input-sensitive lane constraints run after global schema parsing and before
 * semantic validation or permission. They narrow a named capability without
 * changing its global schema for open execution lanes.
 */
export function validateToolInputForLane(
  lane: Readonly<ToolExecutionLane> | undefined,
  name: string,
  input: unknown,
): StructuredToolError | undefined {
  if (
    !lane ||
    (lane.action !== 'gather_evidence' && lane.action !== 'run_verification') ||
    name !== 'Shell'
  ) {
    return undefined
  }
  const criterionIds = isRecord(input) ? input.criterionIds : undefined
  if (
    !Array.isArray(criterionIds) ||
    criterionIds.length === 0 ||
    criterionIds.some(id => typeof id !== 'string' || id.trim().length === 0)
  ) {
    return {
      code: 'TOOL_NOT_AVAILABLE_FOR_ACTION',
      message:
        `Shell requires non-empty criterionIds while the supervisor action is ` +
        `${lane.action} (projection ${lane.hash})`,
      retryable: true,
      hint:
        'Bind the command/test to acceptance criterion ids, or use ShellReadOnly for an unbound read-only observation.',
    }
  }
  return undefined
}

export function renderToolExecutionLane(
  lane: Readonly<ToolExecutionLane> | undefined,
): string | undefined {
  if (!lane) return undefined
  const allowed = lane.allowedTools.length > 0
    ? lane.allowedTools.join(', ')
    : '(no tools; return plain text to hand control to the completion gate)'
  return [
    `[TOOL EXECUTION LANE: ${lane.lane.toUpperCase()} / ${lane.action}]`,
    `Projection ${lane.hash} is frozen for this model turn and tool batch.`,
    `Reachable tools: ${allowed}.`,
    lane.instruction,
    'This lane only removes capabilities. Mode, write lock, permission, contracts, idempotency, evidence and completion gates still apply.',
  ].join('\n')
}

function laneFor(action: SupervisorAction): ToolExecutionLane['lane'] {
  switch (action) {
    case 'gather_evidence': return 'evidence'
    case 'run_verification': return 'verification'
    case 'repair_plan': return 'plan_repair'
    case 'request_reapproval': return 'approval'
    case 'finish': return 'finish'
    case 'continue_step':
    case 'resolve_blocker':
      return 'open'
  }
}

function allowSetFor(
  action: SupervisorAction,
  replanning: boolean,
): ReadonlySet<string> | undefined {
  switch (action) {
    // These two actions deliberately remain open. A ready task may need any
    // registered implementation tool, and an arbitrary blocker needs a safe
    // diagnostic escape hatch. All normal policy layers still apply.
    case 'continue_step':
    case 'resolve_blocker':
      return undefined
    case 'gather_evidence':
      return EVIDENCE_TOOLS
    case 'run_verification':
      return VERIFICATION_TOOLS
    case 'repair_plan':
      return replanning ? PLAN_REPAIR_ACTIVE_TOOLS : PLAN_REPAIR_TOOLS
    case 'request_reapproval':
      return APPROVAL_TOOLS
    case 'finish':
      return FINISH_TOOLS
  }
}

function instructionFor(action: SupervisorAction, hash: string): string {
  switch (action) {
    case 'gather_evidence':
      return 'Collect only kind-matched evidence for the uncovered criteria. Shell must include non-empty criterionIds. Direct workspace edit tools are withheld until plan health changes.'
    case 'run_verification':
      return 'Use inspection or evidence tools only when a prerequisite is genuinely missing; Shell must include non-empty criterionIds. Otherwise return plain text so the engine can invoke its independent verifier.'
    case 'repair_plan':
      return 'Repair the smallest affected plan step or persist a replacement plan before attempting more workspace writes.'
    case 'request_reapproval':
      return 'Persist the revised plan with PlanPropose, then call ExitPlanMode. Workspace writes remain locked pending approval.'
    case 'finish':
      return 'Do not make new workspace changes. Return a fact-grounded final response so the completion gate can decide.'
    case 'resolve_blocker':
      return 'Obtain one discriminating observation, then update the blocked task honestly. The lane stays open to avoid trapping valid recovery work.'
    case 'continue_step':
      return `Continue the targeted step. Projection ${hash} does not narrow implementation tools; ordinary policy remains authoritative.`
  }
}

function stableNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort(stableCompare)
}

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T extends ToolExecutionLane>(value: T): Readonly<T> {
  Object.freeze(value.allowedTools)
  Object.freeze(value.blockedTools)
  return Object.freeze(value)
}
