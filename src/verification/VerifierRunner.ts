import { AgentEngine } from '../core/AgentEngine.js'
import { createInitialState } from '../core/state.js'
import type { ConversationMessage } from '../core/messages.js'
import type { ModelGateway } from '../model/types.js'
import { createRetryPolicy } from '../model/retryPolicy.js'
import { ToolRegistry } from '../tools/ToolRegistry.js'
import { ToolRuntime } from '../tools/ToolRuntime.js'
import { ToolScheduler } from '../tools/ToolScheduler.js'
import { ToolOutputStore } from '../tools/ToolOutputStore.js'
import { PolicyEngine } from '../policy/PolicyEngine.js'
import { ReadTool } from '../tools/builtin/ReadTool.js'
import { GlobTool } from '../tools/builtin/GlobTool.js'
import { GrepTool } from '../tools/builtin/GrepTool.js'
import { ShellReadOnlyTool } from '../tools/builtin/ShellTool.js'
import type { EvidenceStore } from './EvidenceStore.js'
import { readFileVersion } from '../workspace/FileVersion.js'
import type { PlanVersion } from '../planning/types.js'
import type { Clock, IdGenerator } from '../core/runtimePrimitives.js'
import type { VerificationReport } from './types.js'
import { validateReport, VerificationReportSchema } from './verdict.js'

const VERIFIER_SYSTEM = `You are an adversarial verification agent. Your goal is to BREAK the implementation, not to confirm it.

Known lazy patterns you must avoid:
- reading code instead of running it
- checking only the happy path
- trusting the implementer's own claims or tests

Rules:
- You are read-only: Read/Glob/Grep and ShellReadOnly (audited read-only commands) are your only tools.
- Every claim in your report must reference evidenceId values printed by ShellReadOnly runs. You cannot fabricate evidence.
- Run at least one adversarial probe (boundary, idempotency, error path).
- Before declaring FAIL, check whether the behavior is intentional or protected upstream.
- PARTIAL is only for environmental limits, and must list them.

When you are done, output ONLY a JSON object (no prose, no code fence) matching:
{
  "verdict": "PASS" | "FAIL" | "PARTIAL",
  "summary": string,
  "checks": [{ "name": string, "criterionIds": string[], "evidenceIds": string[], "result": "PASS"|"FAIL"|"SKIP", "expected": string, "actual": string }],
  "adversarialProbeEvidenceId": string,
  "failures": [{ "title": string, "severity": "low"|"medium"|"high", "reproduction": string[], "evidenceIds": string[] }],
  "unverified": [{ "item": string, "reason": string }]
}`

export interface VerifierOutcome {
  report: VerificationReport
  valid: boolean
  validationError?: string
}

/**
 * Evidence freshness: a receipt whose bound fileVersions no longer match
 * the workspace was signed for a PREVIOUS version of the code and cannot
 * support a verdict about the current one. Missing files count as stale —
 * the observation no longer reflects reality either.
 */
export async function findStaleReceipts(evidence: EvidenceStore): Promise<Set<string>> {
  const stale = new Set<string>()
  for (const receipt of evidence.list()) {
    if (!receipt.fileVersions || Object.keys(receipt.fileVersions).length === 0) continue
    for (const [path, signedVersion] of Object.entries(receipt.fileVersions)) {
      try {
        const current = await readFileVersion(path)
        if (current.version !== signedVersion) {
          stale.add(receipt.id)
          break
        }
      } catch {
        stale.add(receipt.id)
        break
      }
    }
  }
  return stale
}

/**
 * Read-only verification subagent (guide §9.3): separate engine, separate
 * budget, restricted registry, shared EvidenceStore so its evidence ids are
 * verifiable, structured JSON output that is machine-validated.
 */
export class VerifierRunner {
  constructor(
    private readonly deps: {
      model: ModelGateway
      evidence: EvidenceStore
      clock: Clock
      ids: IdGenerator
      workspaceRoot: string
      artifactDir: string
      maxTurns?: number
    },
  ) {}

  async run(input: {
    goal: string
    approvedPlan?: PlanVersion
    touchedSummary: string
    signal: AbortSignal
  }): Promise<VerifierOutcome> {
    const registry = new ToolRegistry()
    registry.register(ReadTool)
    registry.register(GlobTool)
    registry.register(GrepTool)
    registry.register(ShellReadOnlyTool)

    // no ask handler: anything that would ask is denied — verifier is read-only
    const policy = new PolicyEngine({ clock: this.deps.clock, ids: this.deps.ids })
    const outputStore = new ToolOutputStore(this.deps.artifactDir)
    const toolRuntime = new ToolRuntime({
      registry,
      policy,
      outputStore,
      clock: this.deps.clock,
      ids: this.deps.ids,
      services: { evidence: this.deps.evidence },
      artifactDir: this.deps.artifactDir,
    })

    const engine = new AgentEngine({
      model: this.deps.model,
      registry,
      toolRuntime,
      scheduler: new ToolScheduler(registry),
      retryPolicy: createRetryPolicy({ maxAttempts: 2 }),
      journal: null, // verifier facts flow back via verification.completed
      clock: this.deps.clock,
      ids: this.deps.ids,
      config: {
        maxOutputTokens: 4096,
        artifactDir: this.deps.artifactDir,
        projectInstructions: VERIFIER_SYSTEM,
      },
    })

    let feedback: string | null = null
    // freshness snapshot for this verification round: the verifier is
    // read-only, so the workspace cannot change underneath this loop
    const stale = await findStaleReceipts(this.deps.evidence)
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await this.collectFinalText(engine, input, feedback)
      const parsed = this.parseReport(text)
      if (!parsed.ok) {
        feedback = parsed.reason
        continue
      }
      const validation = validateReport(
        parsed.report,
        this.deps.evidence,
        input.approvedPlan?.acceptanceCriteria,
        stale,
      )
      if (validation.ok) {
        return { report: parsed.report, valid: true }
      }
      feedback = validation.reason
    }

    // two strikes: degrade to PARTIAL, never let the main agent claim PASS
    return {
      report: {
        verdict: 'PARTIAL',
        summary: `verifier failed to produce a valid report: ${feedback}`,
        checks: [],
        failures: [],
        unverified: [{ item: 'entire verification', reason: feedback ?? 'invalid report' }],
      },
      valid: false,
      validationError: feedback ?? undefined,
    }
  }

  private async collectFinalText(
    engine: AgentEngine,
    input: { goal: string; approvedPlan?: PlanVersion; touchedSummary: string },
    feedback: string | null,
  ): Promise<string> {
    const sessionId = this.deps.ids.next('vses')
    const state = createInitialState({
      sessionId,
      runId: this.deps.ids.next('vrun'),
      turnId: this.deps.ids.next('vturn'),
      workspaceRoot: this.deps.workspaceRoot,
      budget: {
        maxTurns: this.deps.maxTurns ?? 10,
        maxModelCalls: 15,
        maxToolCalls: 40,
        maxWallTimeMs: 10 * 60_000,
      },
      now: this.deps.clock.now(),
    })

    const parts = [
      `Original goal:\n${input.goal}`,
      input.approvedPlan
        ? `Approved plan v${input.approvedPlan.version} acceptance criteria:\n` +
          input.approvedPlan.acceptanceCriteria
            .map(c => `- ${c.id} (${c.evidenceKind}${c.required ? ', required' : ''}): ${c.statement}`)
            .join('\n')
        : 'No approved plan; verify against the stated goal.',
      `Changed state summary:\n${input.touchedSummary}`,
      feedback
        ? `Your previous report was rejected: ${feedback}. Produce a corrected JSON report.`
        : 'Verify the implementation now.',
    ]

    const userMessage: ConversationMessage = {
      id: this.deps.ids.next('msg'),
      parentId: null,
      sessionId,
      turnId: state.turnId,
      role: 'user',
      content: [{ type: 'text', text: parts.join('\n\n') }],
      createdAt: this.deps.clock.isoNow(),
      meta: { source: 'engine', synthetic: true },
    }

    let finalText = ''
    const controller = new AbortController()
    const run = engine.run(
      { ...state, messages: [userMessage] },
      controller.signal,
    )
    let step = await run.next()
    while (!step.done) {
      const event = step.value
      if (event.type === 'assistant.message.completed') {
        const text = event.message.content
          .filter(b => b.type === 'text')
          .map(b => (b.type === 'text' ? b.text : ''))
          .join('')
        if (text.trim().length > 0) finalText = text
      }
      step = await run.next()
    }
    return finalText
  }

  private parseReport(
    text: string,
  ): { ok: true; report: VerificationReport } | { ok: false; reason: string } {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) {
      return { ok: false, reason: 'no JSON object found in verifier output' }
    }
    let raw: unknown
    try {
      raw = JSON.parse(text.slice(start, end + 1))
    } catch (error) {
      return { ok: false, reason: `invalid JSON: ${(error as Error).message}` }
    }
    const parsed = VerificationReportSchema.safeParse(raw)
    if (!parsed.success) {
      return {
        ok: false,
        reason: `schema violation: ${parsed.error.issues
          .map(i => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      }
    }
    return { ok: true, report: parsed.data }
  }
}
