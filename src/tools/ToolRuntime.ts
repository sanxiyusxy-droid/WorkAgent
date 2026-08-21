import type { ZodError } from 'zod'
import type {
  StructuredToolError,
  ToolCall,
  ToolCallResult,
  ToolContractCheck,
  ToolObservation,
} from '../core/messages.js'
import type { AgentEvent } from '../core/events.js'
import type { AgentMode } from '../core/events.js'
import type { ToolContext, ToolDefinition, ToolServices } from './Tool.js'
import type { ToolRegistry } from './ToolRegistry.js'
import type { ToolOutputStore } from './ToolOutputStore.js'
import type { PolicyEngine } from '../policy/PolicyEngine.js'
import type { Clock, IdGenerator } from '../core/runtimePrimitives.js'
import { IdempotencyLedger } from './IdempotencyLedger.js'
import { ProgressThrottle, type ProgressChunk } from './toolProgress.js'
import { redactDeep } from '../security/secrets.js'
import {
  validateToolInputForLane,
  type ToolExecutionLane,
} from '../planning/ToolExecutionLane.js'

export interface ExecuteToolRequest {
  call: ToolCall
  mode: AgentMode
  sessionId: string
  workspaceRoot: string
  artifactDir: string
  signal: AbortSignal
  /** Frozen projection used for both model schemas and this exact batch. */
  lane?: Readonly<ToolExecutionLane>
  writeLocked?: boolean
  /**
   * Side channel for transient events (live tool progress). Bypasses the
   * scheduler buffer so long-running commands stream in real time; these
   * events are never persisted and never replayed.
   */
  onTransient?: (event: AgentEvent) => void
}

/**
 * The single side-effect entry point. Pipeline order is fixed:
 * lookup -> schema -> semantic validate -> permission -> execute -> serialize -> bound.
 * Model input errors and tool failures become normal tool_result payloads;
 * only invariant damage may throw out of this pipeline.
 */
export class ToolRuntime {
  readonly idempotency: IdempotencyLedger

  constructor(
    private readonly deps: {
      registry: ToolRegistry
      policy: PolicyEngine
      outputStore: ToolOutputStore
      clock: Clock
      ids: IdGenerator
      services?: ToolServices
      artifactDir: string
      /**
       * Runtime write lock: while a replan requiring re-approval is pending,
       * every side-effecting tool is refused here IN ADDITION to being
       * removed from the model-facing schema.
       */
      writeLock?: () => boolean
    },
  ) {
    this.idempotency = new IdempotencyLedger(deps.artifactDir)
  }

  async *executeOne(req: ExecuteToolRequest): AsyncGenerator<AgentEvent> {
    const startedAt = this.deps.clock.now()
    const tool = this.deps.registry.resolve(req.call.name)

    if (!tool) {
      yield this.completed(req, startedAt, {
        code: 'UNKNOWN_TOOL',
        message: `unknown tool: ${req.call.name}`,
        retryable: true,
        hint: `Available tools: ${this.deps.registry
          .availableFor(req.mode, { writeLocked: req.writeLocked, lane: req.lane })
          .map(t => t.name)
          .join(', ')}`,
      })
      return
    }

    // 1. projection guards: mode, frozen write lock and action lane are
    // checked independently so error semantics stay precise. The action lane
    // is allow-list based and therefore fails closed even if blockedTools in a
    // reconstructed/audit object is incomplete.
    const modeAvailable = this.deps.registry.isAvailableIn(tool.name, req.mode)
    const lockedAvailable = this.deps.registry.isAvailableIn(tool.name, req.mode, {
      writeLocked: req.writeLocked,
    })
    const actionRefused = Boolean(req.lane && !req.lane.allowedTools.includes(tool.name))
    if (!modeAvailable || !lockedAvailable || actionRefused) {
      const lockRefused = modeAvailable && !lockedAvailable
      yield this.completed(req, startedAt, {
        code: !modeAvailable
          ? 'TOOL_NOT_AVAILABLE_IN_MODE'
          : lockRefused
            ? 'REPLAN_APPROVAL_PENDING'
            : 'TOOL_NOT_AVAILABLE_FOR_ACTION',
        message: !modeAvailable
          ? `${tool.name} is not available in ${req.mode} mode`
          : lockRefused
            ? `write access is suspended: ${tool.name} is outside the frozen write-lock projection until the revised plan is approved`
            : `${tool.name} is not available while the supervisor action is ${req.lane!.action} (projection ${req.lane!.hash})`,
        retryable: modeAvailable,
        hint:
          lockRefused
            ? 'Propose the revised plan with PlanPropose and request approval via ExitPlanMode.'
            : actionRefused
            ? `${req.lane!.instruction} Available tools: ${req.lane!.allowedTools.join(', ') || '(none)'}`
            : req.mode === 'plan'
            ? 'Plan mode is read-only. Persist the plan with PlanPropose, then ' +
              'call ExitPlanMode to request approval — approval restores the ' +
              'previous mode automatically and you continue executing. Do not ' +
              'ask the user to switch modes manually.'
            : `Available tools: ${this.deps.registry
                .availableFor(req.mode, { writeLocked: req.writeLocked, lane: req.lane })
                .map(t => t.name)
                .join(', ')}`,
      })
      return
    }

    // 2. schema validation
    const parsed = tool.inputSchema.safeParse(req.call.input)
    if (!parsed.success) {
      yield this.completed(req, startedAt, zodToError(parsed.error))
      return
    }

    const laneInputError = validateToolInputForLane(req.lane, tool.name, parsed.data)
    if (laneInputError) {
      yield this.completed(req, startedAt, laneInputError)
      return
    }

    const ctx: ToolContext = {
      sessionId: req.sessionId,
      callId: req.call.id,
      workspaceRoot: req.workspaceRoot,
      mode: req.mode,
      artifactDir: req.artifactDir,
      signal: req.signal,
      clock: this.deps.clock,
      ids: this.deps.ids,
      services: this.deps.services ?? {},
    }

    // 3. semantic validation
    const semantic = await tool.validate(parsed.data, ctx)
    if (!semantic.ok) {
      yield this.completed(req, startedAt, semantic.error)
      return
    }

    // 4. permission (policy engine owns the full priority chain)
    const decision = await this.deps.policy.decide({
      tool,
      input: parsed.data,
      callId: req.call.id,
      mode: req.mode,
      context: ctx,
    })
    yield { type: 'permission.decided', decision }

    if (decision.behavior !== 'allow') {
      yield this.completed(req, startedAt, {
        code: 'PERMISSION_DENIED',
        message: `permission ${decision.behavior} for ${tool.name} (${decision.reason.type})`,
        retryable: false,
        hint:
          decision.reason.type === 'hard_safety'
            ? `blocked by hard safety rule: ${decision.reason.rule}`
            : 'The user declined or policy denied this action.',
      })
      return
    }

    const effectiveInput =
      decision.updatedInput !== undefined
        ? (decision.updatedInput as never)
        : parsed.data

    // 4a. runtime contract preconditions. These are deliberately separate
    // from schema/semantic validation: they describe live state that must be
    // true at the exact execution boundary.
    let preconditions: ToolContractCheck[]
    try {
      preconditions = await tool.preconditions(effectiveInput, ctx)
    } catch (error) {
      yield this.completed(req, startedAt, classifyToolError(error))
      return
    }
    const failedPreconditions = failedChecks(preconditions)
    if (failedPreconditions.length > 0) {
      yield this.completed(
        req,
        startedAt,
        {
          code: 'PRECONDITION_FAILED',
          message: `tool preconditions failed: ${formatChecks(failedPreconditions)}`,
          retryable: true,
          hint: 'Refresh the relevant workspace state, then retry with updated input.',
        },
        contractObservation(
          `${tool.name} was not executed because its preconditions failed`,
          preconditions,
          [],
        ),
      )
      return
    }

    // 5. execute
    if (req.signal.aborted) {
      yield this.completed(req, startedAt, {
        code: 'TOOL_ABORTED',
        message: 'aborted before execution',
        retryable: false,
      })
      return
    }

    // 5a. idempotency guard for side-effecting tools.
    // The key follows the tool's idempotency scope (finish-list §1.4):
    // - 'operation': args-derived BUSINESS identity — a model retry with a
    //   fresh callId is still recognized as the same side effect
    // - 'invocation': call-level identity — only the crash-recovery replay
    //   of the SAME call dedupes; repeating the same command later is legal
    const hasSideEffects = !tool.readOnly(parsed.data)
    let idempotencyKey: string | undefined
    if (hasSideEffects) {
      if (this.deps.writeLock?.()) {
        yield this.completed(req, startedAt, {
          code: 'REPLAN_APPROVAL_PENDING',
          message:
            `write access is suspended: a replan requires re-approval. ` +
            `${tool.name} is disabled until the new plan version is approved.`,
          retryable: true,
          hint: 'Propose the revised plan with PlanPropose and request approval via ExitPlanMode.',
        })
        return
      }
      idempotencyKey =
        tool.idempotencyScope === 'invocation'
          ? IdempotencyLedger.computeKey({
              sessionId: req.sessionId,
              callId: req.call.id,
              toolName: tool.name,
              args: parsed.data,
            })
          : IdempotencyLedger.computeOperationKey({
              sessionId: req.sessionId,
              toolName: tool.name,
              args: parsed.data,
            })
      const record = this.idempotency.getRecord(idempotencyKey)

      if (record && this.idempotency.isApplied(idempotencyKey)) {
        // The effect was committed previously. Tools with a probe RE-VERIFY
        // the proof against live external state: if the file was edited back
        // or the proof no longer holds, the operation becomes re-executable
        // instead of being skipped forever.
        if (tool.inspectOutcome) {
          const inspection = await tool.inspectOutcome(parsed.data, ctx, record)
          if (inspection.applied) {
            yield this.deduplicated(req, startedAt, inspection.detail)
            return
          }
          const from = this.idempotency.adjudicate(
            idempotencyKey,
            'resolved_not_applied',
            inspection.detail,
            this.deps.clock.isoNow(),
          )
          await this.idempotency.flush()
          yield this.adjudicationFact(
            req,
            from ?? record.status,
            'resolved_not_applied',
            inspection.detail,
          )
          // proof invalidated → fall through and re-execute normally
        } else {
          yield this.completed(req, startedAt, {
            code: 'ALREADY_COMMITTED',
            message:
              `this exact ${tool.name} operation was already committed ` +
              `(proof: ${record.proof ?? 'none'}); ` +
              'skipping re-execution to avoid a duplicate side effect',
            retryable: false,
            hint: 'Read the current state if you need to verify the effect.',
          })
          return
        }
      } else if (record && this.idempotency.needsInspection(idempotencyKey)) {
        // interrupted previously (running/unknown): outcome uncertain.
        // Verifiable tools adjudicate automatically via inspectOutcome;
        // everything else still refuses blind re-execution.
        if (tool.inspectOutcome) {
          const inspection = await tool.inspectOutcome(parsed.data, ctx, record)
          const to = inspection.applied ? 'resolved_applied' : 'resolved_not_applied'
          const from = this.idempotency.adjudicate(
            idempotencyKey,
            to,
            inspection.detail,
            this.deps.clock.isoNow(),
          )
          await this.idempotency.flush()
          yield this.adjudicationFact(req, from ?? record.status, to, inspection.detail)
          if (inspection.applied) {
            yield this.deduplicated(req, startedAt, inspection.detail)
            return
          }
          // effect verified absent → safe to re-execute below
        } else {
          yield this.completed(req, startedAt, {
            code: 'UNKNOWN_OUTCOME_REQUIRES_INSPECTION',
            message:
              `a previous attempt of this ${tool.name} operation ended with an ` +
              'UNKNOWN outcome (interrupted mid side effect). Re-executing blindly ' +
              'may duplicate the effect.',
            retryable: true,
            hint:
              'Inspect current state first (Read/Grep/ShellReadOnly). If the effect ' +
              'is already applied, continue without it; if not, retry with changed ' +
              'arguments so the operation identity differs.',
          })
          return
        }
      }
      // unseen / resolved_not_applied / abandoned → execute normally
      // mark running before side effect begins
      this.idempotency.markRunning(
        idempotencyKey,
        req.call.id,
        tool.name,
        this.deps.clock.isoNow(),
      )
      await this.idempotency.flush()
    }

    // live progress streaming (transient): rate-limited and budgeted, so
    // chatty commands can neither flood the terminal nor grow memory
    const throttle = req.onTransient
      ? new ProgressThrottle(req.onTransient, req.call.id, () => this.deps.clock.now())
      : undefined

    try {
      const output = await tool.execute(
        effectiveInput,
        ctx,
        data => {
          // progress is transient by design: streamed to the UI, never
          // persisted, never part of recovery
          if (
            throttle &&
            typeof data === 'object' &&
            data !== null &&
            'stream' in data &&
            'text' in data
          ) {
            throttle.push(data as ProgressChunk)
          }
        },
      )
      throttle?.flush()
      const postconditions = await tool.postconditions(effectiveInput, output.data, ctx)
      let observed: Omit<ToolObservation, 'preconditions' | 'postconditions'>
      try {
        observed = await tool.observe(effectiveInput, output.data, ctx)
      } catch (error) {
        // Observation enriches policy but must never turn a successful tool
        // into an unknown side effect. Record the instrumentation defect.
        observed = {
          summary: `${tool.name} completed; structured observation failed`,
          fields: {
            observationError: error instanceof Error ? error.message : String(error),
          },
        }
      }
      const observation = contractObservation(
        observed.summary,
        preconditions,
        postconditions,
        observed.fields,
      )
      const failedPostconditions = failedChecks(postconditions)
      if (failedPostconditions.length > 0) {
        // execute may already have changed external state. Keep the ledger
        // fail-closed and persist tool-declared workspace facts before
        // returning the contract failure.
        if (idempotencyKey) {
          this.idempotency.markUnknown(idempotencyKey, this.deps.clock.isoNow())
          await this.idempotency.flush()
        }
        if (output.facts) {
          for (const fact of output.facts) {
            if (fact.type === 'workspace.changed') {
              this.deps.services?.evidence?.bumpWorkspaceRevision(fact.path)
              this.deps.services?.codeIntelligence?.invalidate(fact.path)
              this.deps.services?.codeRetriever?.invalidate(fact.path)
            }
            yield fact
          }
        }
        yield this.completed(
          req,
          startedAt,
          {
            code: 'POSTCONDITION_FAILED',
            message: `tool postconditions failed: ${formatChecks(failedPostconditions)}`,
            retryable: true,
            hint: 'Inspect current state before retrying; the side effect may have been applied.',
          },
          observation,
        )
        return
      }
      // 6. serialize + output budget
      const content = tool.serialize(output.data, req.call.id)
      const bounded = await this.deps.outputStore.bound(content, {
        callId: req.call.id,
        toolName: tool.name,
        maxChars: tool.maxResultChars,
      })
      const result: ToolCallResult = {
        callId: req.call.id,
        toolName: tool.name,
        ok: true,
        content: bounded,
        durationMs: this.deps.clock.now() - startedAt,
        observation,
      }
      // mark committed after successful side effect, storing the commit proof
      if (idempotencyKey) {
        this.idempotency.markCommitted(idempotencyKey, output.commitProof, this.deps.clock.isoNow())
        await this.idempotency.flush()
      }
      // tool-declared facts flow back through events, never by direct mutation
      if (output.facts) {
        for (const fact of output.facts) {
          if (fact.type === 'workspace.changed') {
            // the workspace moved on: receipts signed for the previous
            // revision become stale (finish-list §1.6)
            this.deps.services?.evidence?.bumpWorkspaceRevision(fact.path)
            this.deps.services?.codeIntelligence?.invalidate(fact.path)
            this.deps.services?.codeRetriever?.invalidate(fact.path)
          }
          yield fact
        }
      }
      yield { type: 'tool.call.completed', result }
    } catch (error) {
      // show the last captured output even when the run ended badly
      // (abort, timeout, spawn error)
      throttle?.flush()
      // mark unknown on failure (side effect may have partially applied)
      if (idempotencyKey) {
        this.idempotency.markUnknown(idempotencyKey, this.deps.clock.isoNow())
        await this.idempotency.flush()
      }
      yield this.completed(req, startedAt, classifyToolError(error))
    }
  }

  private completed(
    req: ExecuteToolRequest,
    startedAt: number,
    error: StructuredToolError,
    observation?: ToolObservation,
  ): AgentEvent {
    const result: ToolCallResult = {
      callId: req.call.id,
      toolName: req.call.name,
      ok: false,
      content: { kind: 'json', value: { ok: false, error } },
      errorCode: error.code,
      durationMs: this.deps.clock.now() - startedAt,
      observation,
    }
    return { type: 'tool.call.completed', result }
  }

  /**
   * Successful DEDUPLICATED result (finish-list §1.4): the side effect is
   * verified already applied, so the call succeeds instead of failing with
   * ALREADY_COMMITTED. ok:true keeps failure counters and Replan detectors
   * untouched.
   */
  private deduplicated(
    req: ExecuteToolRequest,
    startedAt: number,
    detail: string,
  ): AgentEvent {
    const result: ToolCallResult = {
      callId: req.call.id,
      toolName: req.call.name,
      ok: true,
      content: {
        kind: 'text',
        text:
          `deduplicated: this ${req.call.name} operation was already applied ` +
          `(verified against current state: ${detail}). No side effect was repeated.`,
      },
      durationMs: this.deps.clock.now() - startedAt,
    }
    return { type: 'tool.call.completed', result }
  }

  /** Audit fact for a ledger adjudication (journal-only state transition). */
  private adjudicationFact(
    req: ExecuteToolRequest,
    from: string,
    to: string,
    detail: string,
  ): AgentEvent {
    return {
      type: 'idempotency.adjudicated',
      toolName: req.call.name,
      callId: req.call.id,
      from,
      to,
      detail,
    }
  }
}

function failedChecks(checks: ToolContractCheck[]): ToolContractCheck[] {
  return checks.filter(check => !check.passed)
}

function formatChecks(checks: ToolContractCheck[]): string {
  return checks
    .map(check => `${check.id}${check.detail ? ` (${check.detail})` : ''}`)
    .join(', ')
}

function contractObservation(
  summary: string,
  preconditions: ToolContractCheck[],
  postconditions: ToolContractCheck[],
  fields?: Record<string, unknown>,
): ToolObservation {
  const observation = redactDeep({
    summary,
    preconditions,
    postconditions,
    ...(fields ? { fields } : {}),
  })
  const encoded = JSON.stringify(observation)
  if (encoded.length <= 16_000) return observation
  return {
    summary: observation.summary.slice(0, 1_000),
    preconditions: observation.preconditions.map(boundCheck),
    postconditions: observation.postconditions.map(boundCheck),
    fields: {
      observationTruncated: true,
      originalChars: encoded.length,
    },
  }
}

function boundCheck(check: ToolContractCheck): ToolContractCheck {
  return {
    id: check.id.slice(0, 200),
    passed: check.passed,
    ...(check.detail ? { detail: check.detail.slice(0, 500) } : {}),
  }
}

function zodToError(error: ZodError): StructuredToolError {
  return {
    code: 'INPUT_VALIDATION_ERROR',
    message: 'tool input failed schema validation',
    issues: error.issues.map(issue => ({
      path: issue.path,
      expected: 'expected' in issue ? String(issue.expected) : issue.message,
      received: 'received' in issue ? String(issue.received) : undefined,
    })),
    retryable: true,
    hint: 'Fix the listed fields and call the tool again.',
  }
}

export function classifyToolError(error: unknown): StructuredToolError {
  if (error && typeof error === 'object' && 'toolErrorCode' in error) {
    const err = error as Error & { toolErrorCode: StructuredToolError['code'] }
    return {
      code: err.toolErrorCode,
      message: err.message,
      retryable: err.toolErrorCode === 'FILE_VERSION_CONFLICT' ||
        err.toolErrorCode === 'SEMANTIC_VALIDATION_ERROR' ||
        err.toolErrorCode === 'PRECONDITION_FAILED' ||
        err.toolErrorCode === 'POSTCONDITION_FAILED',
      hint:
        err.toolErrorCode === 'FILE_VERSION_CONFLICT'
          ? 'Re-read the file to get the current version, then retry the edit.'
          : undefined,
    }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'TOOL_ABORTED', message: 'tool aborted', retryable: false }
  }
  return {
    code: 'INTERNAL_TOOL_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
}
