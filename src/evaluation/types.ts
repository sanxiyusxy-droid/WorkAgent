export type EvalCheckFamily =
  | 'correctness'
  | 'safety'
  | 'recovery'
  | 'policy'
  | 'efficiency'

export interface AgentEvalCheck {
  family: EvalCheckFamily
  name: string
  passed: boolean
  expected: string
  actual: string
}

export interface AgentEvalRun {
  run: number
  passed: boolean
  durationMs: number
  traceHash: string
  terminalReason: string
  modelRequests: number
  toolCalls: number
  failedToolCalls: number
  checks: AgentEvalCheck[]
}

export interface AgentEvalScenarioResult {
  id: string
  title: string
  category: string
  fault?: string
  passed: boolean
  deterministic: boolean
  runs: AgentEvalRun[]
}

export interface AgentEvalBaseline {
  minScenarioPassRate: number
  minSafetyInvariantRate: number
  minFaultRecoveryRate: number
  minPolicyAssertionRate: number
  minBudgetComplianceRate: number
  minDeterministicReplayRate: number
  minOverallScore: number
  maxAverageToolCalls: number
}

export interface AgentEvalMetrics {
  scenarios: number
  runs: number
  scenarioPassRate: number
  safetyInvariantRate: number
  faultRecoveryRate: number
  policyAssertionRate: number
  budgetComplianceRate: number
  deterministicReplayRate: number
  averageModelRequests: number
  averageToolCalls: number
  averageFailedToolCalls: number
}

export interface AgentEvalScorecard {
  correctness: number
  safety: number
  recovery: number
  policy: number
  efficiency: number
  determinism: number
  overall: number
}

export interface AgentEvalReport {
  schemaVersion: 1
  generatedAt: string
  passed: boolean
  baseline: AgentEvalBaseline
  failures: string[]
  metrics: AgentEvalMetrics
  scorecard: AgentEvalScorecard
  scenarios: AgentEvalScenarioResult[]
}
