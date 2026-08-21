import { createHash } from 'node:crypto'
import type { FactEvent } from '../core/events.js'
import type {
  AgentEvalBaseline,
  AgentEvalCheck,
  AgentEvalMetrics,
  AgentEvalReport,
  AgentEvalRun,
  AgentEvalScenarioResult,
  AgentEvalScorecard,
  EvalCheckFamily,
} from './types.js'

export function makeEvalCheck(
  family: EvalCheckFamily,
  name: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
): AgentEvalCheck {
  return {
    family,
    name,
    passed,
    expected: printable(expected),
    actual: printable(actual),
  }
}

export function finalizeScenario(input: {
  id: string
  title: string
  category: string
  fault?: string
  runs: AgentEvalRun[]
}): AgentEvalScenarioResult {
  const hashes = new Set(input.runs.map(run => run.traceHash))
  const deterministic = input.runs.length > 0 && hashes.size === 1
  return {
    ...input,
    passed:
      input.runs.length > 0 &&
      deterministic &&
      input.runs.every(run => run.passed),
    deterministic,
  }
}

export function buildAgentEvalReport(input: {
  scenarios: AgentEvalScenarioResult[]
  baseline: AgentEvalBaseline
  generatedAt: string
}): AgentEvalReport {
  const runs = input.scenarios.flatMap(scenario => scenario.runs)
  const metrics: AgentEvalMetrics = {
    scenarios: input.scenarios.length,
    runs: runs.length,
    scenarioPassRate: ratio(
      input.scenarios.filter(scenario => scenario.passed).length,
      input.scenarios.length,
    ),
    safetyInvariantRate: familyRate(runs, 'safety'),
    faultRecoveryRate: ratio(
      input.scenarios.filter(scenario => scenario.fault && scenario.passed).length,
      input.scenarios.filter(scenario => scenario.fault).length,
    ),
    policyAssertionRate: familyRate(runs, 'policy'),
    budgetComplianceRate: familyRate(runs, 'efficiency'),
    deterministicReplayRate: ratio(
      input.scenarios.filter(scenario => scenario.deterministic).length,
      input.scenarios.length,
    ),
    averageModelRequests: average(runs.map(run => run.modelRequests)),
    averageToolCalls: average(runs.map(run => run.toolCalls)),
    averageFailedToolCalls: average(runs.map(run => run.failedToolCalls)),
  }
  const scorecard: AgentEvalScorecard = {
    correctness: round(metrics.scenarioPassRate * 100),
    safety: round(metrics.safetyInvariantRate * 100),
    recovery: round(metrics.faultRecoveryRate * 100),
    policy: round(metrics.policyAssertionRate * 100),
    efficiency: round(metrics.budgetComplianceRate * 100),
    determinism: round(metrics.deterministicReplayRate * 100),
    overall: 0,
  }
  scorecard.overall = round(
    scorecard.correctness * 0.3 +
      scorecard.safety * 0.2 +
      scorecard.recovery * 0.2 +
      scorecard.policy * 0.15 +
      scorecard.efficiency * 0.1 +
      scorecard.determinism * 0.05,
  )

  const failures: string[] = []
  compareMinimum(failures, 'scenarioPassRate', metrics.scenarioPassRate, input.baseline.minScenarioPassRate)
  compareMinimum(failures, 'safetyInvariantRate', metrics.safetyInvariantRate, input.baseline.minSafetyInvariantRate)
  compareMinimum(failures, 'faultRecoveryRate', metrics.faultRecoveryRate, input.baseline.minFaultRecoveryRate)
  compareMinimum(failures, 'policyAssertionRate', metrics.policyAssertionRate, input.baseline.minPolicyAssertionRate)
  compareMinimum(failures, 'budgetComplianceRate', metrics.budgetComplianceRate, input.baseline.minBudgetComplianceRate)
  compareMinimum(
    failures,
    'deterministicReplayRate',
    metrics.deterministicReplayRate,
    input.baseline.minDeterministicReplayRate,
  )
  if (scorecard.overall < input.baseline.minOverallScore) {
    failures.push(
      `overallScore ${scorecard.overall} is below ${input.baseline.minOverallScore}`,
    )
  }
  if (metrics.averageToolCalls > input.baseline.maxAverageToolCalls) {
    failures.push(
      `averageToolCalls ${round(metrics.averageToolCalls)} exceeds ${input.baseline.maxAverageToolCalls}`,
    )
  }

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    passed: failures.length === 0,
    baseline: input.baseline,
    failures,
    metrics,
    scorecard,
    scenarios: input.scenarios,
  }
}

export function canonicalFactTrace(facts: FactEvent[]): string[] {
  return facts.map(fact => {
    switch (fact.type) {
      case 'tool.call.accepted':
        return `${fact.type}:${fact.call.id}:${fact.call.name}`
      case 'tool.call.completed':
        return `${fact.type}:${fact.result.callId}:${fact.result.ok ? 'ok' : fact.result.errorCode ?? 'error'}`
      case 'permission.decided':
        return `${fact.type}:${fact.decision.toolName}:${fact.decision.behavior}`
      case 'model.attempt.failed':
        return `${fact.type}:${fact.failure.attempt}:${fact.failure.code}:${fact.failure.action}`
      case 'workspace.changed':
        return `${fact.type}:${fact.change}:${fact.path.replaceAll('\\', '/')}`
      case 'replan.requested':
        return `${fact.type}:${fact.cause}:${fact.requiresReapproval}`
      case 'replan.adjustment.applied':
        return `${fact.type}:${fact.cause}`
      case 'loop.stagnation.detected':
        return `${fact.type}:${fact.record.kind}`
      case 'outcome.calibration.selected':
        return (
          `${fact.type}:${fact.selection.origin}:${fact.selection.profile.hash}:` +
          fact.selection.hash
        )
      case 'reflection.recorded':
        return (
          `${fact.type}:${fact.reflection.trigger}:` +
          `${fact.reflection.decision?.action ?? 'legacy'}:` +
          `${fact.reflection.decision?.evaluateAfterToolCalls ?? 'legacy'}:` +
          `${fact.reflection.calibration?.selectionHash ?? 'unselected'}`
        )
      case 'reflection.evaluated':
        return `${fact.type}:${fact.evaluation.outcome}:${fact.evaluation.followUp.action}`
      case 'plan.health.assessed':
        return `${fact.type}:${fact.assessment.status}:${fact.assessment.decision.action}`
      case 'tool.lane.selected':
        return `${fact.type}:${fact.selection.action}:${fact.selection.hash}`
      case 'strategy.adapted':
        return `${fact.type}:${fact.from}:${fact.to}`
      case 'loop.transitioned':
        return `${fact.type}:${fact.transition.reason}`
      case 'run.terminated':
        return `${fact.type}:${fact.terminal.reason}`
      case 'session.recovery.branch':
        return `${fact.type}:${fact.failureSeq}`
      default:
        return fact.type
    }
  })
}

export function hashFactTrace(facts: FactEvent[]): string {
  return createHash('sha256')
    .update(canonicalFactTrace(facts).join('\n'))
    .digest('hex')
    .slice(0, 16)
}

export function renderAgentEvalMarkdown(report: AgentEvalReport): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`
  const lines = [
    '# Code Agent evaluation report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Gate: ${report.passed ? 'PASS' : 'FAIL'}`,
    `- Overall score: ${report.scorecard.overall}/100`,
    '',
    '## Scorecard',
    '',
    '| Dimension | Score |',
    '|---|---:|',
    `| Correctness | ${report.scorecard.correctness} |`,
    `| Safety | ${report.scorecard.safety} |`,
    `| Fault recovery | ${report.scorecard.recovery} |`,
    `| Planning/reflection policy | ${report.scorecard.policy} |`,
    `| Tool efficiency | ${report.scorecard.efficiency} |`,
    `| Determinism | ${report.scorecard.determinism} |`,
    '',
    '## Metrics',
    '',
    `- Scenario pass rate: ${percent(report.metrics.scenarioPassRate)}`,
    `- Safety invariant rate: ${percent(report.metrics.safetyInvariantRate)}`,
    `- Fault recovery rate: ${percent(report.metrics.faultRecoveryRate)}`,
    `- Policy assertion rate: ${percent(report.metrics.policyAssertionRate)}`,
    `- Budget compliance rate: ${percent(report.metrics.budgetComplianceRate)}`,
    `- Deterministic replay rate: ${percent(report.metrics.deterministicReplayRate)}`,
    `- Average model requests: ${report.metrics.averageModelRequests.toFixed(2)}`,
    `- Average tool calls: ${report.metrics.averageToolCalls.toFixed(2)}`,
    '',
    '## Scenarios',
    '',
    '| Scenario | Category | Fault | Result | Deterministic | Trace |',
    '|---|---|---|---|---|---|',
    ...report.scenarios.map(scenario =>
      `| ${escapeCell(scenario.id)} | ${escapeCell(scenario.category)} | ` +
      `${escapeCell(scenario.fault ?? '-')} | ${scenario.passed ? 'PASS' : 'FAIL'} | ` +
      `${scenario.deterministic ? 'yes' : 'no'} | ${scenario.runs[0]?.traceHash ?? '-'} |`,
    ),
  ]
  if (report.failures.length > 0) {
    lines.push('', '## Gate failures', '')
    lines.push(...report.failures.map(failure => `- ${failure}`))
  }
  const failedChecks = report.scenarios.flatMap(scenario =>
    scenario.runs.flatMap(run =>
      run.checks
        .filter(check => !check.passed)
        .map(check => ({ scenario: scenario.id, run: run.run, check })),
    ),
  )
  if (failedChecks.length > 0) {
    lines.push('', '## Failed checks', '')
    lines.push(
      ...failedChecks.map(
        item =>
          `- ${item.scenario} run ${item.run} / ${item.check.name}: ` +
          `expected ${item.check.expected}, got ${item.check.actual}`,
      ),
    )
  }
  return `${lines.join('\n')}\n`
}

function familyRate(runs: AgentEvalRun[], family: EvalCheckFamily): number {
  const checks = runs.flatMap(run => run.checks.filter(check => check.family === family))
  return ratio(checks.filter(check => check.passed).length, checks.length)
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator
}

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length
}

function round(value: number): number {
  return Number(value.toFixed(2))
}

function compareMinimum(
  failures: string[],
  name: string,
  actual: number,
  expected: number,
): void {
  if (actual < expected) {
    failures.push(`${name} ${round(actual)} is below ${expected}`)
  }
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}
