import type { z } from 'zod'
import type {
  StructuredToolError,
  ToolContractCheck,
  ToolObservation,
  ToolResultContent,
} from '../core/messages.js'
import type { AgentMode, FactEvent, PermissionBehavior } from '../core/events.js'
import type { Clock, IdGenerator } from '../core/runtimePrimitives.js'
import type { PlanStore, ApprovalRegistry } from '../planning/PlanStore.js'
import type { TaskStore } from '../planning/TaskStore.js'
import type { EvidenceStore } from '../verification/EvidenceStore.js'
import type { PlanVersion } from '../planning/types.js'
import type { IdempotencyRecord } from './IdempotencyLedger.js'
import type { CodeIntelligenceService } from '../codeintel/CodeIntelligence.js'
import type { CodeRetriever } from '../retrieval/CodeRetriever.js'

export type ConcurrencyClass = 'shared' | 'exclusive'
export type InterruptBehavior = 'cancel' | 'block'

/**
 * Duplicate-execution policy for side-effecting tools (finish-list §1.4).
 * - 'operation': the args-derived operation key identifies one BUSINESS
 *   operation for the whole session (file writes: same args = same effect).
 * - 'invocation': dedupe only the exact protocol call (callId), i.e. the
 *   crash-recovery replay of the SAME call. A fresh call repeating the same
 *   command at a later stage is legitimate and must not be blocked.
 */
export type IdempotencyScope = 'operation' | 'invocation'

/** Outcome of re-checking external state against a ledger record. */
export interface OutcomeInspection {
  /** true = the committed effect is verifiably present right now */
  applied: boolean
  detail: string
}

export interface ResourceClaim {
  resource: string
  mode: 'read' | 'write'
}

/**
 * Workspace-side-effect declaration used by the durable completion gate.
 * `paths` is used when a tool can determine every target before execution;
 * `workspace` deliberately fails closed for commands whose exact write set
 * cannot be known without observing the process.
 */
export type WorkspaceMutationIntent =
  | { scope: 'paths'; paths: string[]; reason?: string }
  | { scope: 'workspace'; reason: string }

/**
 * Runtime services available to tools. Tools never touch engine state
 * directly; they call services and return declarative facts.
 */
export interface ToolServices {
  plans?: PlanStore
  approvals?: ApprovalRegistry
  tasks?: TaskStore
  evidence?: EvidenceStore
  /** shared, invalidatable source index used by code-intelligence tools */
  codeIntelligence?: CodeIntelligenceService
  /** versioned hybrid repository index used by Code RAG tools */
  codeRetriever?: CodeRetriever
  /** true only while a low-impact replan is waiting for one bounded repair */
  canLocalPlanRepair?: () => boolean
  /** interactive question channel to the human user */
  askUser?: (input: { question: string; options?: string[] }) => Promise<string>
  /** human approval UI for a persisted plan version */
  requestPlanApproval?: (plan: PlanVersion) => Promise<boolean>
}

export interface ToolContext {
  sessionId: string
  callId: string
  workspaceRoot: string
  mode: AgentMode
  artifactDir: string
  signal: AbortSignal
  clock: Clock
  ids: IdGenerator
  services: ToolServices
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: StructuredToolError }

export interface ToolPermissionHint {
  behavior: PermissionBehavior
  code?: string
  message?: string
}

export interface ToolExecutionResult<T = unknown> {
  data: T
  facts?: FactEvent[]
  /**
   * Commit proof for the idempotency ledger: an externally checkable
   * fingerprint of the applied side effect (e.g. new file version hash).
   * Lets recovery distinguish "already applied" from "needs inspection".
   */
  commitProof?: string
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  readonly name: string
  readonly description: string
  readonly inputSchema: z.ZodType<Input, z.ZodTypeDef, any>
  readonly maxResultChars: number
  /** duplicate-execution policy; defaults to 'operation' */
  readonly idempotencyScope: IdempotencyScope
  /** True when the tool author supplied resource claims instead of defaults. */
  readonly resourcesExplicit?: boolean

  readOnly(input: Input): boolean
  destructive(input: Input): boolean
  concurrency(input: Input): ConcurrencyClass
  resources(input: Input, ctx: ToolContext): ResourceClaim[]
  interruptBehavior(input: Input): InterruptBehavior

  /** Declarative write intent. Evaluated after validation/idempotency checks. */
  workspaceMutation(
    input: Input,
    ctx: ToolContext,
  ): WorkspaceMutationIntent | undefined

  validate(input: Input, ctx: ToolContext): Promise<ValidationResult>
  /** Runtime-enforced assertions evaluated immediately before execution. */
  preconditions(input: Input, ctx: ToolContext): Promise<ToolContractCheck[]>
  permission(input: Input, ctx: ToolContext): Promise<ToolPermissionHint>
  execute(
    input: Input,
    ctx: ToolContext,
    progress: (value: unknown) => void,
  ): Promise<ToolExecutionResult<Output>>
  /** Runtime-enforced assertions evaluated after execute and before commit. */
  postconditions(
    input: Input,
    output: Output,
    ctx: ToolContext,
  ): Promise<ToolContractCheck[]>
  /** Stable structured observation; never require consumers to parse prose. */
  observe(
    input: Input,
    output: Output,
    ctx: ToolContext,
  ): Promise<Omit<ToolObservation, 'preconditions' | 'postconditions'>>
  serialize(output: Output, callId: string): ToolResultContent
  /**
   * Adjudication probe (finish-list §1.4): re-check external state against
   * a ledger record (committed / running / unknown). File tools compare the
   * current content hash with the commit proof; tools without a verifiable
   * outcome omit this and the runtime keeps refusing blind re-execution.
   */
  inspectOutcome?(
    input: Input,
    ctx: ToolContext,
    record: IdempotencyRecord,
  ): Promise<OutcomeInspection>
}

/**
 * Safe defaults. A new tool is exclusive, not read-only, claims the whole
 * workspace for write, blocks on interrupt and asks for permission until it
 * explicitly declares otherwise.
 */
export interface ToolSpec<Input, Output> {
  name: string
  description: string
  inputSchema: z.ZodType<Input, z.ZodTypeDef, any>
  maxResultChars?: number
  idempotencyScope?: IdempotencyScope
  readOnly?: (input: Input) => boolean
  destructive?: (input: Input) => boolean
  concurrency?: (input: Input) => ConcurrencyClass
  resources?: (input: Input, ctx: ToolContext) => ResourceClaim[]
  interruptBehavior?: (input: Input) => InterruptBehavior
  workspaceMutation?: (
    input: Input,
    ctx: ToolContext,
  ) => WorkspaceMutationIntent | undefined
  validate?: (input: Input, ctx: ToolContext) => Promise<ValidationResult>
  preconditions?: (
    input: Input,
    ctx: ToolContext,
  ) => Promise<ToolContractCheck[]>
  permission?: (input: Input, ctx: ToolContext) => Promise<ToolPermissionHint>
  execute: (
    input: Input,
    ctx: ToolContext,
    progress: (value: unknown) => void,
  ) => Promise<ToolExecutionResult<Output>>
  postconditions?: (
    input: Input,
    output: Output,
    ctx: ToolContext,
  ) => Promise<ToolContractCheck[]>
  observe?: (
    input: Input,
    output: Output,
    ctx: ToolContext,
  ) =>
    | Omit<ToolObservation, 'preconditions' | 'postconditions'>
    | Promise<Omit<ToolObservation, 'preconditions' | 'postconditions'>>
  serialize?: (output: Output, callId: string) => ToolResultContent
  inspectOutcome?: (
    input: Input,
    ctx: ToolContext,
    record: IdempotencyRecord,
  ) => Promise<OutcomeInspection>
}

export function defineTool<Input, Output>(
  spec: ToolSpec<Input, Output>,
): ToolDefinition<Input, Output> {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    maxResultChars: spec.maxResultChars ?? 30_000,
    idempotencyScope: spec.idempotencyScope ?? 'operation',
    resourcesExplicit: spec.resources !== undefined,
    readOnly: spec.readOnly ?? (() => false),
    destructive: spec.destructive ?? (() => false),
    concurrency: spec.concurrency ?? (() => 'exclusive'),
    resources:
      spec.resources ?? (() => [{ resource: 'workspace:*', mode: 'write' }]),
    interruptBehavior: spec.interruptBehavior ?? (() => 'block'),
    workspaceMutation: spec.workspaceMutation ?? (() => undefined),
    validate: spec.validate ?? (async () => ({ ok: true })),
    preconditions: spec.preconditions ?? (async () => []),
    permission: spec.permission ?? (async () => ({ behavior: 'ask' })),
    execute: spec.execute,
    postconditions: spec.postconditions ?? (async () => []),
    observe: async (input, output, ctx) =>
      spec.observe
        ? spec.observe(input, output, ctx)
        : { summary: `${spec.name} completed` },
    serialize:
      spec.serialize ??
      ((output: Output): ToolResultContent => ({
        kind: 'json',
        value: output,
      })),
    inspectOutcome: spec.inspectOutcome,
  }
}
