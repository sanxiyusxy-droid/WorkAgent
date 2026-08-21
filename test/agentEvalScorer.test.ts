import { describe, expect, test } from 'vitest'
import type { AgentEvent, FactEvent } from '../src/core/events.js'
import {
  buildAgentEvalReport,
  canonicalFactTrace,
  finalizeScenario,
  hashFactTrace,
  makeEvalCheck,
  renderAgentEvalMarkdown,
} from '../src/evaluation/AgentEvalScorer.js'
import type {
  AgentEvalBaseline,
  AgentEvalReport,
  AgentEvalRun,
} from '../src/evaluation/types.js'
import { MetricsCollector } from '../src/observability/metrics.js'

const passingBaseline: AgentEvalBaseline = {
  minScenarioPassRate: 1,
  minSafetyInvariantRate: 1,
  minFaultRecoveryRate: 1,
  minPolicyAssertionRate: 1,
  minBudgetComplianceRate: 1,
  minDeterministicReplayRate: 1,
  minOverallScore: 100,
  maxAverageToolCalls: 4,
}

function passingRun(run: number, traceHash = '0123456789abcdef'): AgentEvalRun {
  return {
    run,
    passed: true,
    durationMs: 25,
    traceHash,
    terminalReason: 'completed',
    modelRequests: 2,
    toolCalls: 2,
    failedToolCalls: 0,
    checks: [
      makeEvalCheck('correctness', 'external verifier', true, true, true),
      makeEvalCheck('safety', 'tool lifecycle', true, 0, 0),
      makeEvalCheck('recovery', 'recovered result', true, 'completed', 'completed'),
      makeEvalCheck('policy', 'replan policy', true, 'bounded repair', 'bounded repair'),
      makeEvalCheck('efficiency', 'tool budget', true, '<= 4', 2),
    ],
  }
}

describe('AgentEvalScorer', () => {
  test('builds a full-score report and renders Markdown from the JSON report', () => {
    const scenario = finalizeScenario({
      id: 'retry-then-complete',
      title: 'Retry a transient model failure',
      category: 'recovery',
      fault: 'model_timeout',
      runs: [passingRun(1), passingRun(2)],
    })

    const report = buildAgentEvalReport({
      scenarios: [scenario],
      baseline: passingBaseline,
      generatedAt: '2026-08-06T12:00:00.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      passed: true,
      failures: [],
      metrics: {
        scenarios: 1,
        runs: 2,
        scenarioPassRate: 1,
        safetyInvariantRate: 1,
        faultRecoveryRate: 1,
        policyAssertionRate: 1,
        budgetComplianceRate: 1,
        deterministicReplayRate: 1,
        averageModelRequests: 2,
        averageToolCalls: 2,
        averageFailedToolCalls: 0,
      },
      scorecard: {
        correctness: 100,
        safety: 100,
        recovery: 100,
        policy: 100,
        efficiency: 100,
        determinism: 100,
        overall: 100,
      },
    })

    // The human report must be a pure projection of the serializable JSON
    // result, not a second independently calculated scorecard.
    const roundTripped = JSON.parse(JSON.stringify(report)) as AgentEvalReport
    const markdown = renderAgentEvalMarkdown(roundTripped)
    expect(markdown).toContain('- Gate: PASS')
    expect(markdown).toContain('- Overall score: 100/100')
    expect(markdown).toContain('| retry-then-complete | recovery | model_timeout | PASS | yes | 0123456789abcdef |')
    expect(markdown).toContain('- Average model requests: 2.00')
    expect(markdown).toContain('- Average tool calls: 2.00')
  })

  test('reports every violated baseline instead of masking a partial failure', () => {
    const run: AgentEvalRun = {
      ...passingRun(1),
      toolCalls: 3,
      checks: [
        makeEvalCheck('safety', 'no orphan calls', false, 0, 1),
        makeEvalCheck('policy', 'bounded replan', true, true, true),
        makeEvalCheck('efficiency', 'tool budget', true, '<= 4', 3),
      ],
    }
    const scenario = finalizeScenario({
      id: 'unsafe-but-completed',
      title: 'A semantic pass with a safety regression',
      category: 'safety',
      runs: [run],
    })
    const report = buildAgentEvalReport({
      scenarios: [scenario],
      baseline: { ...passingBaseline, minOverallScore: 85, maxAverageToolCalls: 2 },
      generatedAt: '2026-08-06T12:00:00.000Z',
    })

    expect(report.passed).toBe(false)
    expect(report.metrics.safetyInvariantRate).toBe(0)
    expect(report.scorecard).toMatchObject({ safety: 0, overall: 80 })
    expect(report.failures).toEqual([
      'safetyInvariantRate 0 is below 1',
      'overallScore 80 is below 85',
      'averageToolCalls 3 exceeds 2',
    ])

    const markdown = renderAgentEvalMarkdown(report)
    expect(markdown).toContain('- Gate: FAIL')
    expect(markdown).toContain('## Gate failures')
    expect(markdown).toContain('## Failed checks')
    expect(markdown).toContain(
      '- unsafe-but-completed run 1 / no orphan calls: expected 0, got 1',
    )
  })

  test('canonicalizes volatile fact fields while preserving policy-relevant trace changes', () => {
    const facts = traceFacts('run-a', 'evaluation-a', 'src\\app.ts', 'effective')
    const replay = traceFacts('run-b', 'evaluation-b', 'src/app.ts', 'effective')
    const changed = traceFacts('run-c', 'evaluation-c', 'src/app.ts', 'ineffective')

    expect(canonicalFactTrace(facts)).toEqual([
      'run.started',
      'model.attempt.failed:1:TIMEOUT:retry',
      'tool.call.accepted:c1:Edit',
      'tool.call.completed:c1:ok',
      'workspace.changed:modified:src/app.ts',
      'replan.requested:verification_failed:false',
      'reflection.evaluated:effective:continue_step',
      'run.terminated:completed',
    ])
    expect(hashFactTrace(facts)).toBe(hashFactTrace(replay))
    expect(hashFactTrace(facts)).toMatch(/^[a-f0-9]{16}$/)
    expect(hashFactTrace(changed)).not.toBe(hashFactTrace(facts))
  })
})

describe('MetricsCollector evaluation metrics', () => {
  test('aggregates usage, tool outcomes, retries, replans and reflection evaluations', () => {
    const metrics = new MetricsCollector()
    const events: AgentEvent[] = [
      {
        type: 'assistant.message.completed',
        message: assistantMessage('assistant-1', { inputTokens: 999, outputTokens: 999 }),
        usage: { inputTokens: 10, outputTokens: 4 },
      },
      {
        type: 'model.attempt.failed',
        failure: { attempt: 1, code: 'TIMEOUT', action: 'retry', delayMs: 10 },
      },
      {
        type: 'model.attempt.failed',
        failure: { attempt: 2, code: 'AUTH', action: 'surface', delayMs: 0 },
      },
      {
        type: 'tool.call.accepted',
        call: { id: 'c1', name: 'Read', input: {}, parentMessageId: 'assistant-1', receivedIndex: 0 },
      },
      {
        type: 'tool.call.accepted',
        call: { id: 'c2', name: 'Shell', input: {}, parentMessageId: 'assistant-1', receivedIndex: 1 },
      },
      {
        type: 'tool.call.completed',
        result: {
          callId: 'c1',
          toolName: 'Read',
          ok: true,
          content: { kind: 'text', text: 'ok' },
          durationMs: 7,
        },
      },
      {
        type: 'tool.call.completed',
        result: {
          callId: 'c2',
          toolName: 'Shell',
          ok: false,
          content: { kind: 'text', text: 'timed out' },
          errorCode: 'TIMEOUT',
          durationMs: 13,
        },
      },
      { type: 'replan.requested', cause: 'verification_failed', requiresReapproval: false },
      { type: 'reflection.recorded', reflection: reflectionRecord() },
      { type: 'reflection.evaluated', evaluation: reflectionEvaluation('effective') },
      { type: 'reflection.evaluated', evaluation: reflectionEvaluation('ineffective') },
      {
        type: 'loop.stagnation.detected',
        record: {
          kind: 'repeated_failure',
          signature: 'same-error',
          score: 1,
          detail: 'same failure repeated',
        },
      },
      {
        type: 'strategy.adapted',
        from: 'normal',
        to: 'conservative',
        reason: 'retry pressure',
      },
      { type: 'plan.health.assessed', assessment: healthyAssessment() },
      {
        type: 'session.recovery.branch',
        fromSessionId: 'source-session',
        failureSeq: 4,
        issues: ['checksum mismatch'],
      },
      {
        type: 'idempotency.adjudicated',
        toolName: 'Write',
        callId: 'c3',
        from: 'running',
        to: 'committed',
        detail: 'target content matches',
      },
      { type: 'run.terminated', terminal: { reason: 'completed' } },
    ]

    metrics.recordAll(events)
    const snapshot = metrics.snapshot()

    expect(snapshot.usage).toMatchObject({
      modelTurns: 1,
      modelAttempts: 3,
      failedModelAttempts: 2,
      toolCalls: 2,
      inputTokens: 10,
      outputTokens: 4,
    })
    expect(snapshot.tools).toEqual({
      completed: 2,
      succeeded: 1,
      failed: 1,
      successRate: 0.5,
      totalDurationMs: 20,
      byErrorCode: { TIMEOUT: 1 },
    })
    expect(snapshot.perTool).toEqual({
      Read: { calls: 1, failures: 0 },
      Shell: { calls: 1, failures: 1 },
    })
    expect(snapshot.planning).toEqual({
      replans: 1,
      replanByCause: { verification_failed: 1 },
      reflectionsRecorded: 1,
      reflectionsEvaluated: 2,
      effectiveReflections: 1,
      ineffectiveReflections: 1,
      stagnations: 1,
      strategyTransitions: 1,
      planHealthAssessments: 1,
    })
    expect(snapshot.recovery).toEqual({
      modelRetries: 1,
      branches: 1,
      idempotencyAdjudications: 1,
    })
    expect(snapshot.correctness).toEqual({
      orphanToolCalls: 0,
      duplicateToolResults: 0,
    })
    expect(snapshot.loop.terminal).toBe('completed')
    expect(metrics.formatSummary()).toContain('tool success: 1/2; model retries: 1')
    expect(metrics.formatSummary()).toContain('replans/reflections evaluated: 1/2')
  })
})

function traceFacts(
  runId: string,
  evaluationId: string,
  path: string,
  outcome: 'effective' | 'ineffective',
): FactEvent[] {
  return [
    { type: 'run.started', runId, configHash: 'config' },
    {
      type: 'model.attempt.failed',
      failure: { attempt: 1, code: 'TIMEOUT', action: 'retry', delayMs: 5 },
    },
    {
      type: 'tool.call.accepted',
      call: { id: 'c1', name: 'Edit', input: {}, parentMessageId: 'm1', receivedIndex: 0 },
    },
    {
      type: 'tool.call.completed',
      result: {
        callId: 'c1',
        toolName: 'Edit',
        ok: true,
        content: { kind: 'text', text: 'done' },
        durationMs: 1,
      },
    },
    { type: 'workspace.changed', path, change: 'modified' },
    { type: 'replan.requested', cause: 'verification_failed', requiresReapproval: false },
    {
      type: 'reflection.evaluated',
      evaluation: {
        ...reflectionEvaluation(outcome),
        id: evaluationId,
        createdAt: `${evaluationId}.time`,
      },
    },
    { type: 'run.terminated', terminal: { reason: 'completed' } },
  ]
}

function assistantMessage(
  id: string,
  metaUsage: { inputTokens: number; outputTokens: number },
) {
  return {
    id,
    parentId: null,
    sessionId: 'session',
    turnId: 'turn',
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'done' }],
    createdAt: '2026-08-06T12:00:00.000Z',
    meta: { usage: metaUsage },
  }
}

function reflectionRecord() {
  return {
    id: 'reflection-1',
    trigger: 'stagnation' as const,
    createdAt: '2026-08-06T12:00:00.000Z',
    summary: 'No progress yet.',
    assumptions: [],
    progress: {
      completedTasks: 0,
      totalTasks: 1,
      touchedFiles: 0,
      toolCalls: 2,
      evidenceReceipts: 0,
      successfulToolCalls: 1,
    },
    evidenceGaps: [],
    recommendation: 'Change the hypothesis.',
    decision: {
      action: 'repair_plan' as const,
      rationale: 'The prior action failed.',
      successSignals: ['one durable progress fact'],
      evaluateAfterToolCalls: 3,
    },
  }
}

function reflectionEvaluation(outcome: 'effective' | 'ineffective') {
  return {
    id: `evaluation-${outcome}`,
    reflectionId: 'reflection-1',
    createdAt: '2026-08-06T12:00:01.000Z',
    outcome,
    toolCallsObserved: 3,
    progressSignals: outcome === 'effective' ? ['workspace changed'] : [],
    followUp: {
      action: outcome === 'effective' ? 'continue_step' as const : 'repair_plan' as const,
      rationale: 'Use the observed result.',
      successSignals: ['finish the bounded action'],
    },
  }
}

function healthyAssessment() {
  return {
    id: 'health-1',
    createdAt: '2026-08-06T12:00:02.000Z',
    status: 'healthy' as const,
    score: 100,
    signature: '0123456789abcdef',
    metrics: {
      totalTasks: 1,
      completedTasks: 1,
      openTasks: 0,
      blockedTasks: 0,
      failedTasks: 0,
      readyTasks: 0,
      requiredCriteria: 1,
      coveredCriteria: 1,
      scopeDriftFiles: 0,
      budgetRemainingRatio: 0.9,
      consecutiveFailures: 0,
      stagnationSignals: 0,
      ineffectiveReflections: 0,
    },
    findings: [],
    decision: {
      action: 'finish' as const,
      rationale: 'All durable checks passed.',
      successSignals: ['completion gate passes'],
    },
  }
}
