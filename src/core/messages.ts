/**
 * Internal message protocol.
 * Never let a provider SDK type leak into the rest of the project.
 */

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type ToolResultContent =
  | { kind: 'text'; text: string }
  | { kind: 'json'; value: unknown }
  | {
      kind: 'externalized'
      artifactId: string
      path: string
      originalChars: number
      sha256: string
      previewHead: string
      previewTail: string
    }

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      callId: string
      ok: boolean
      content: ToolResultContent
      errorCode?: string
      observation?: ToolObservation
    }

export interface ConversationMessage {
  id: string
  parentId: string | null
  sessionId: string
  turnId: string
  role: 'system' | 'user' | 'assistant'
  content: ContentBlock[]
  createdAt: string
  meta?: {
    model?: string
    usage?: TokenUsage
    source?: 'human' | 'engine' | 'tool' | 'recovery'
    synthetic?: boolean
  }
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
  /** message id of the assistant message that emitted this call */
  parentMessageId: string
  /** position among the calls of the same assistant message (received order) */
  receivedIndex: number
}

export interface ToolCallResult {
  callId: string
  toolName: string
  ok: boolean
  content: ToolResultContent
  errorCode?: string
  durationMs: number
  synthetic?: boolean
  /**
   * Machine-readable result of the tool contract. Unlike the rendered
   * content, this stays small and stable so loop policy can reason about
   * success without scraping prose.
   */
  observation?: ToolObservation
}

export interface ToolContractCheck {
  id: string
  passed: boolean
  detail?: string
}

export interface ToolObservation {
  summary: string
  preconditions: ToolContractCheck[]
  postconditions: ToolContractCheck[]
  /** Small, tool-specific facts intended for policy/replanning code. */
  fields?: Record<string, unknown>
}

/** Stable machine-readable tool error codes. */
export type ToolErrorCode =
  | 'UNKNOWN_TOOL'
  | 'TOOL_NOT_AVAILABLE_IN_MODE'
  | 'TOOL_NOT_AVAILABLE_FOR_ACTION'
  | 'INPUT_VALIDATION_ERROR'
  | 'SEMANTIC_VALIDATION_ERROR'
  | 'PRECONDITION_FAILED'
  | 'POSTCONDITION_FAILED'
  | 'PERMISSION_DENIED'
  | 'PERMISSION_REQUIRED'
  | 'TOOL_ABORTED'
  | 'TIMEOUT'
  | 'PROCESS_EXIT_NONZERO'
  | 'FILE_VERSION_CONFLICT'
  | 'OUTPUT_EXTERNALIZED'
  | 'INTERNAL_TOOL_ERROR'
  | 'INTERRUPTED_DURING_PREVIOUS_RUN'
  | 'ALREADY_COMMITTED'
  | 'UNKNOWN_OUTCOME_REQUIRES_INSPECTION'
  | 'REPLAN_APPROVAL_PENDING'

export interface StructuredToolError {
  code: ToolErrorCode
  message: string
  issues?: Array<{ path: Array<string | number>; expected?: string; received?: string }>
  retryable: boolean
  hint?: string
}

export class InvariantError extends Error {
  constructor(
    readonly invariant: string,
    message?: string,
  ) {
    super(message ?? invariant)
    this.name = 'InvariantError'
  }
}
