import type {
  AgentMode,
  DecisionTraceStep,
  PermissionBehavior,
  PermissionDecision,
  PermissionReason,
  RuleSource,
} from '../core/events.js'
import type { ToolDefinition, ToolContext } from '../tools/Tool.js'
import type { Clock, IdGenerator } from '../core/runtimePrimitives.js'
import { checkPath } from './pathPolicy.js'
import { analyzeShellCommand } from './shellPolicy.js'

export interface PermissionRule {
  id: string
  effect: 'allow' | 'ask' | 'deny'
  tool: string
  matcher?: {
    kind: 'exact' | 'prefix' | 'path' | 'argv'
    value: string | string[]
  }
  scope: 'once' | 'session' | 'project' | 'user'
  source: RuleSource
}

export interface PolicyRequest {
  tool: ToolDefinition<any, any>
  input: unknown
  callId: string
  mode: AgentMode
  context: ToolContext
}

export type AskHandler = (
  request: PolicyRequest,
  reason: PermissionReason,
) => Promise<'allow' | 'deny'>

/**
 * Tool-policy ask codes that an explicit user allow rule must NOT satisfy.
 * A parse failure is high risk by invariant: we cannot describe what we would
 * be allowing, so a stored rule can never cover it.
 */
const UNBYPASSABLE_ASK_CODES = new Set(['shell_unparseable'])

/**
 * Fixed, non-negotiable priority:
 *   1. hard safety rules
 *   2. explicit deny rules
 *   3. explicit ask rules
 *   4. tool-specific policy
 *   5. mode policy
 *   6. explicit allow rules
 *   7. default ask
 * bypassPermissions only skips ordinary asks — hard safety still applies.
 */
export class PolicyEngine {
  private readonly rules: PermissionRule[]

  constructor(
    private readonly deps: {
      clock: Clock
      ids: IdGenerator
      rules?: PermissionRule[]
      askHandler?: AskHandler
    },
  ) {
    this.rules = deps.rules ?? []
  }

  addSessionRule(rule: Omit<PermissionRule, 'id' | 'scope' | 'source'>): void {
    this.rules.push({
      ...rule,
      id: this.deps.ids.next('rule'),
      scope: 'session',
      source: 'session',
    })
  }

  async decide(request: PolicyRequest): Promise<PermissionDecision> {
    const trace: DecisionTraceStep[] = []
    const effectiveReadOnly = this.isEffectivelyReadOnly(request)

    // 1. hard safety — cannot be bypassed by any mode
    const hard = this.hardSafetyCheck(request, effectiveReadOnly)
    trace.push({ stage: 'hard_safety', detail: hard ? hard.rule : 'pass' })
    if (hard) {
      return this.finish(request, 'deny', { type: 'hard_safety', rule: hard.rule }, trace)
    }

    // 2. explicit deny rules — never overridden by broader allow
    const deny = this.matchRules(request, 'deny')
    trace.push({ stage: 'deny_rules', detail: deny?.id ?? 'no match' })
    if (deny) {
      return this.finish(
        request, 'deny',
        { type: 'user_rule', ruleId: deny.id, source: deny.source }, trace,
      )
    }

    // 3. explicit ask rules
    const ask = this.matchRules(request, 'ask')
    trace.push({ stage: 'ask_rules', detail: ask?.id ?? 'no match' })
    if (ask && request.mode !== 'bypassPermissions') {
      return this.resolveAsk(
        request,
        { type: 'user_rule', ruleId: ask.id, source: ask.source },
        trace,
      )
    }

    // 4. tool-specific policy
    const own = await request.tool.permission(request.input, request.context)
    trace.push({ stage: 'tool_policy', detail: `${own.behavior}${own.code ? `:${own.code}` : ''}` })
    if (own.behavior === 'deny') {
      return this.finish(
        request, 'deny', { type: 'tool_policy', code: own.code ?? 'tool_deny' }, trace,
      )
    }
    const toolWantsAsk = own.behavior === 'ask'
    // a stored allow rule is prior human approval, so it satisfies a tool's
    // "ask" — except when the tool could not parse what it would be allowing
    const askIsUnbypassable =
      toolWantsAsk && own.code !== undefined && UNBYPASSABLE_ASK_CODES.has(own.code)

    // 5. mode policy
    const mode = this.applyMode(request, toolWantsAsk, effectiveReadOnly)
    trace.push({ stage: 'mode', detail: `${request.mode}:${mode ?? 'no decision'}` })
    if (mode === 'allow') {
      return this.finish(request, 'allow', { type: 'mode', mode: request.mode }, trace)
    }
    if (mode === 'deny') {
      return this.finish(request, 'deny', { type: 'mode', mode: request.mode }, trace)
    }

    // 6. explicit allow rules
    const allow = this.matchRules(request, 'allow')
    trace.push({ stage: 'allow_rules', detail: allow?.id ?? 'no match' })
    if (allow && !askIsUnbypassable) {
      return this.finish(
        request, 'allow',
        { type: 'user_rule', ruleId: allow.id, source: allow.source }, trace,
      )
    }

    // 7. default ask
    return this.resolveAsk(
      request,
      toolWantsAsk
        ? { type: 'tool_policy', code: own.code ?? 'tool_ask' }
        : { type: 'default' },
      trace,
    )
  }

  // --- internals ---

  /**
   * Treat readOnly as a claim that must agree with explicit workspace resource
   * locks. Third-party tools cannot opt out of write policy by declaring
   * readOnly=true while also claiming a file/workspace write. Resource
   * inspection failures fail closed. `process:workspace` remains only a
   * scheduling lock because ShellReadOnly legitimately uses it.
   */
  private isEffectivelyReadOnly(request: PolicyRequest): boolean {
    try {
      if (request.tool.readOnly(request.input) !== true) return false
      const claims = request.tool.resources(request.input, request.context)
      const hasExplicitWorkspaceWrite =
        request.tool.resourcesExplicit === true &&
        claims.some(claim =>
          claim.mode === 'write' &&
          (claim.resource === 'workspace:*' || claim.resource.startsWith('file:')),
        )
      return !hasExplicitWorkspaceWrite
    } catch {
      return false
    }
  }

  private hardSafetyCheck(
    request: PolicyRequest,
    effectiveReadOnly: boolean,
  ): { rule: string } | null {
    const input = request.input as Record<string, unknown> | null

    // Writing tools must stay inside the workspace and away from
    // sensitive paths — regardless of mode.
    const isWrite = !effectiveReadOnly
    const path = typeof input?.path === 'string' ? input.path : undefined
    if (isWrite && path) {
      const check = checkPath(path, request.context.workspaceRoot)
      if (!check.ok) {
        return { rule: `write_path_${check.reason}` }
      }
    }

    // Unparseable or dangerous shell commands are denied outright.
    const command = typeof input?.command === 'string' ? input.command : undefined
    if ((request.tool.name === 'Shell' || request.tool.name === 'ShellReadOnly') && command) {
      const analysis = analyzeShellCommand(command)
      if (analysis.classification === 'dangerous') {
        return { rule: `shell_dangerous:${analysis.reason ?? ''}` }
      }
      if (request.tool.name === 'ShellReadOnly' && analysis.classification !== 'readonly') {
        return { rule: `shell_readonly_violation:${analysis.classification}` }
      }
    }

    return null
  }

  private matchRules(
    request: PolicyRequest,
    effect: PermissionRule['effect'],
  ): PermissionRule | null {
    const input = request.input as Record<string, unknown> | null
    const candidates = this.rules.filter(
      r => r.effect === effect && r.tool === request.tool.name,
    )
    let best: PermissionRule | null = null
    let bestSpecificity = -1
    for (const rule of candidates) {
      const spec = this.ruleMatches(rule, input)
      if (spec !== null && spec > bestSpecificity) {
        best = rule
        bestSpecificity = spec
      }
    }
    return best
  }

  /** Returns specificity (higher = more specific) or null when not matching. */
  private ruleMatches(
    rule: PermissionRule,
    input: Record<string, unknown> | null,
  ): number | null {
    if (!rule.matcher) return 0

    const { kind, value } = rule.matcher
    if (kind === 'argv') {
      const command = typeof input?.command === 'string' ? input.command : ''
      const analysis = analyzeShellCommand(command)
      if (analysis.classification === 'unparseable') return null
      const prefix = Array.isArray(value) ? value : [value]
      if (prefix.length > analysis.argv.length) return null
      const matches = prefix.every((token, i) => analysis.argv[i] === token)
      return matches ? prefix.length * 10 : null
    }

    const target =
      typeof input?.path === 'string'
        ? input.path
        : typeof input?.command === 'string'
          ? input.command
          : ''
    const pattern = Array.isArray(value) ? value.join(' ') : value

    if (kind === 'exact') return target === pattern ? 100 : null
    if (kind === 'prefix' || kind === 'path') {
      return target.startsWith(pattern) ? pattern.length : null
    }
    return null
  }

  private applyMode(
    request: PolicyRequest,
    toolWantsAsk: boolean,
    effectiveReadOnly: boolean,
  ): PermissionBehavior | null {
    const { mode, tool } = request
    const readOnly = effectiveReadOnly

    switch (mode) {
      case 'default':
        return readOnly ? 'allow' : null
      case 'acceptEdits': {
        if (readOnly) return 'allow'
        // workspace edits auto-approved; shell still follows rules
        if (tool.name === 'Edit' || tool.name === 'Write' || tool.name === 'ApplyPatch') {
          return 'allow'
        }
        return null
      }
      case 'plan':
        // plan mode tools were already projected by the registry;
        // anything write-capable reaching here is denied.
        return readOnly ? 'allow' : 'deny'
      case 'dontAsk':
        return readOnly ? 'allow' : 'deny'
      case 'bypassPermissions':
        // ordinary asks skipped; hard safety already ran above
        return toolWantsAsk ? 'allow' : 'allow'
    }
  }

  private async resolveAsk(
    request: PolicyRequest,
    reason: PermissionReason,
    trace: DecisionTraceStep[],
  ): Promise<PermissionDecision> {
    if (request.mode === 'dontAsk') {
      trace.push({ stage: 'ask', detail: 'dontAsk mode -> deny' })
      return this.finish(request, 'deny', { type: 'mode', mode: 'dontAsk' }, trace)
    }
    if (!this.deps.askHandler) {
      trace.push({ stage: 'ask', detail: 'no ask handler -> deny' })
      return this.finish(request, 'deny', reason, trace)
    }
    const answer = await this.deps.askHandler(request, reason)
    trace.push({ stage: 'ask', detail: `user:${answer}` })
    return this.finish(request, answer, reason, trace)
  }

  private finish(
    request: PolicyRequest,
    behavior: PermissionBehavior,
    reason: PermissionReason,
    trace: DecisionTraceStep[],
  ): PermissionDecision {
    return {
      id: this.deps.ids.next('perm'),
      callId: request.callId,
      toolName: request.tool.name,
      behavior,
      reason,
      decidedAt: this.deps.clock.isoNow(),
      trace,
    }
  }
}
