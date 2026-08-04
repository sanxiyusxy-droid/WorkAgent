import type { z } from 'zod'
import type {
  StructuredToolError,
  ToolResultContent,
} from '../core/messages.js'
import type { AgentMode, FactEvent, PermissionBehavior } from '../core/events.js'
import type { Clock, IdGenerator } from '../core/runtimePrimitives.js'
import type { PlanStore, ApprovalRegistry } from '../planning/PlanStore.js'
import type { TaskStore } from '../planning/TaskStore.js'
import type { EvidenceStore } from '../verification/EvidenceStore.js'
import type { PlanVersion } from '../planning/types.js'

export type ConcurrencyClass = 'shared' | 'exclusive'
export type InterruptBehavior = 'cancel' | 'block'

export interface ResourceClaim {
  resource: string
  mode: 'read' | 'write'
}

/**
 * Runtime services available to tools. Tools never touch engine state
 * directly; they call services and return declarative facts.
 */
export interface ToolServices {
  plans?: PlanStore
  approvals?: ApprovalRegistry
  tasks?: TaskStore
  evidence?: EvidenceStore
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

  readOnly(input: Input): boolean
  destructive(input: Input): boolean
  concurrency(input: Input): ConcurrencyClass
  resources(input: Input, ctx: ToolContext): ResourceClaim[]
  interruptBehavior(input: Input): InterruptBehavior

  validate(input: Input, ctx: ToolContext): Promise<ValidationResult>
  permission(input: Input, ctx: ToolContext): Promise<ToolPermissionHint>
  execute(
    input: Input,
    ctx: ToolContext,
    progress: (value: unknown) => void,
  ): Promise<ToolExecutionResult<Output>>
  serialize(output: Output, callId: string): ToolResultContent
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
  readOnly?: (input: Input) => boolean
  destructive?: (input: Input) => boolean
  concurrency?: (input: Input) => ConcurrencyClass
  resources?: (input: Input, ctx: ToolContext) => ResourceClaim[]
  interruptBehavior?: (input: Input) => InterruptBehavior
  validate?: (input: Input, ctx: ToolContext) => Promise<ValidationResult>
  permission?: (input: Input, ctx: ToolContext) => Promise<ToolPermissionHint>
  execute: (
    input: Input,
    ctx: ToolContext,
    progress: (value: unknown) => void,
  ) => Promise<ToolExecutionResult<Output>>
  serialize?: (output: Output, callId: string) => ToolResultContent
}

export function defineTool<Input, Output>(
  spec: ToolSpec<Input, Output>,
): ToolDefinition<Input, Output> {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    maxResultChars: spec.maxResultChars ?? 30_000,
    readOnly: spec.readOnly ?? (() => false),
    destructive: spec.destructive ?? (() => false),
    concurrency: spec.concurrency ?? (() => 'exclusive'),
    resources:
      spec.resources ?? (() => [{ resource: 'workspace:*', mode: 'write' }]),
    interruptBehavior: spec.interruptBehavior ?? (() => 'block'),
    validate: spec.validate ?? (async () => ({ ok: true })),
    permission: spec.permission ?? (async () => ({ behavior: 'ask' })),
    execute: spec.execute,
    serialize:
      spec.serialize ??
      ((output: Output): ToolResultContent => ({
        kind: 'json',
        value: output,
      })),
  }
}
