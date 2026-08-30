import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildAgentEvalReport,
  finalizeScenario,
  hashFactTrace,
  makeEvalCheck,
  renderAgentEvalMarkdown,
} from '../src/evaluation/AgentEvalScorer.js'
import {
  FaultInjectingModel,
  type ModelFault,
} from '../src/evaluation/FaultInjectingModel.js'
import type {
  AgentEvalBaseline,
  AgentEvalCheck,
  AgentEvalRun,
  AgentEvalScenarioResult,
} from '../src/evaluation/types.js'
import {
  ScriptedModel,
  textTurn,
  toolCallTurn,
  type ScriptedTurn,
} from '../src/model/ScriptedModel.js'
import type {
  ModelError,
  ModelGateway,
  ModelRequest,
} from '../src/model/types.js'
import {
  createRuntime,
  resumeState,
  type AgentRuntime,
  type RuntimeConfig,
} from '../src/app/createRuntime.js'
import {
  createSequentialIds,
  type Clock,
  type IdGenerator,
} from '../src/core/runtimePrimitives.js'
import {
  isFactEvent,
  type AgentEvent,
  type AgentMode,
  type FactEvent,
  type TerminalReason,
} from '../src/core/events.js'
import { reduce, type AgentState } from '../src/core/state.js'
import {
  envelopeChecksum,
  type JournalEnvelope,
} from '../src/session/SessionJournal.js'
import { loadSession } from '../src/session/SessionLoader.js'
import { diagnoseSession } from '../src/session/recoveryCheck.js'
import {
  isOutcomeCalibrationSelection,
  type OutcomeCalibrationSelection,
} from '../src/planning/OutcomeCalibrationContract.js'
import { matchOutcomeCalibration } from '../src/planning/OutcomeCalibration.js'

type ScenarioDriver =
  | 'agent'
  | 'recovery_orphan'
  | 'recovery_checksum'
  | 'recovery_snapshot'
  | 'recovery_degraded_branch'
  | 'calibration_resume'

type CalibrationCase =
  | 'history_pin'
  | 'empty_pin'
  | 'disabled_precedence'

interface ToolCallSpec {
  id: string
  name: string
  input: unknown
}

type TurnSpec =
  | { kind: 'text'; text: string; stopReason?: string }
  | { kind: 'tools'; calls: ToolCallSpec[]; text?: string }

interface RequestToolsExpectation {
  /** one-based successful scripted request number */
  request: number
  include?: string[]
  exclude?: string[]
}

interface ScenarioExpectation {
  terminal: string[]
  modelRequests?: number
  maxModelRequests?: number
  maxToolCalls?: number
  toolResults?: Record<string, 'ok'>
  toolErrors?: Record<string, string>
  modelFailureCodes?: Record<string, number>
  requiredFacts?: string[]
  absentFacts?: string[]
  replan?: {
    cause: string
    requiresReapproval: boolean
    count: number
  }
  stagnation?: { kind: string; count: number }
  reflection?: { trigger: string; count: number }
  filesEqual?: Record<string, string>
  absentFiles?: string[]
  requestTools?: RequestToolsExpectation[]
  lane?: {
    action: string
    /** one-based request that must carry this exact frozen projection */
    request?: number
    include?: string[]
    exclude?: string[]
    refusedCallId?: string
  }
  diagnostic?: string
  lastTrustedSeq?: number
}

interface ScenarioRuntime {
  maxTurns?: number
  maxModelCalls?: number
  maxToolCalls?: number
  maxWallTimeMs?: number
  intelligence?: RuntimeConfig['intelligence']
  replan?: RuntimeConfig['replan']
}

interface ScenarioSpec {
  id: string
  title: string
  category: string
  driver: ScenarioDriver
  calibrationCase?: CalibrationCase
  fault?: string
  prompt?: string
  mode?: AgentMode
  files?: Record<string, string>
  turns?: TurnSpec[]
  modelFaults?: Array<{
    point: 'model_request'
    occurrence: number
    error: ModelError
  }>
  runtime?: ScenarioRuntime
  expect: ScenarioExpectation
}

interface ScenarioCatalog {
  schemaVersion: 1
  defaults: { runs: number }
  scenarios: ScenarioSpec[]
}

interface Flags {
  scenarioIds: string[]
  runs?: number
  noWrite: boolean
  faultsOnly: boolean
  help: boolean
}

interface EngineResult {
  events: AgentEvent[]
  facts: FactEvent[]
  terminal: TerminalReason
}

interface RunEvidence {
  facts: FactEvent[]
  terminalReason: string
  modelRequests: number
  requests: ModelRequest[]
  workspaceRoot: string
  extraChecks?: AgentEvalCheck[]
}

const evalDir = dirname(fileURLToPath(import.meta.url))
const catalogPath = join(evalDir, 'agent-scenarios.json')
const baselinePath = join(evalDir, 'agent-baseline.json')

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    scenarioIds: [],
    noWrite: false,
    faultsOnly: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--scenario') {
      const value = argv[++index]
      if (!value) throw new Error('--scenario requires an id or comma-separated ids')
      flags.scenarioIds.push(...value.split(',').map(item => item.trim()).filter(Boolean))
      continue
    }
    if (arg === '--runs') {
      const value = Number(argv[++index])
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--runs must be a positive integer')
      }
      flags.runs = value
      continue
    }
    if (arg === '--no-write') {
      flags.noWrite = true
      continue
    }
    if (arg === '--faults-only') {
      flags.faultsOnly = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true
      continue
    }
    throw new Error(`unknown option: ${arg}`)
  }
  return flags
}

function usage(): string {
  return [
    'Deterministic offline Code Agent evaluation',
    '',
    'Usage: npx tsx eval/agent-eval.ts [options]',
    '',
    '  --scenario <id[,id]>  run only selected scenario(s); repeatable',
    '  --runs <n>            repeats per scenario (default: catalog value, currently 2)',
    '  --faults-only         run only scenarios with a declared fault',
    '  --no-write            print JSON but do not create eval/results artifacts',
    '  --help                show this help',
  ].join('\n')
}

function fixedClock(start = 1_000_000): Clock {
  let now = start
  return {
    now: () => {
      now += 10
      return now
    },
    isoNow: () => new Date(start).toISOString(),
  }
}

function namespacedIds(namespace: string): IdGenerator {
  const counters = new Map<string, number>()
  return {
    next(prefix: string): string {
      const next = (counters.get(prefix) ?? 0) + 1
      counters.set(prefix, next)
      return `${prefix}_${namespace}_${next}`
    },
  }
}

function scriptedTurns(specs: TurnSpec[] = []): ScriptedTurn[] {
  return specs.map(spec =>
    spec.kind === 'text'
      ? textTurn(spec.text, spec.stopReason)
      : toolCallTurn(spec.calls, spec.text),
  )
}

function safeWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = resolve(workspaceRoot)
  const target = resolve(root, relativePath)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`scenario path escapes workspace: ${relativePath}`)
  }
  return target
}

async function seedFiles(
  workspaceRoot: string,
  files: Record<string, string> = {},
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = safeWorkspacePath(workspaceRoot, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

async function createEvalRuntime(input: {
  workspaceRoot: string
  model: ModelGateway
  mode?: AgentMode
  persist?: boolean
  sessionId?: string
  recoveryForkFrom?: string
  runtime?: ScenarioRuntime
  ids?: IdGenerator
  clock?: Clock
}): Promise<{ runtime: AgentRuntime; loaded: Awaited<ReturnType<typeof createRuntime>>['loaded'] }> {
  return createRuntime({
    model: input.model,
    config: {
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      recoveryForkFrom: input.recoveryForkFrom,
      mode: input.mode ?? 'bypassPermissions',
      persist: input.persist ?? false,
      maxTurns: input.runtime?.maxTurns ?? 30,
      maxModelCalls: input.runtime?.maxModelCalls ?? 40,
      maxToolCalls: input.runtime?.maxToolCalls ?? 80,
      maxWallTimeMs: input.runtime?.maxWallTimeMs ?? 5 * 60_000,
      verification: { enabled: false },
      context: { enabled: false },
      intelligence: {
        enabled: true,
        completionReflection: false,
        ...input.runtime?.intelligence,
      },
      replan: input.runtime?.replan,
      retrieval: { enabled: false },
      configHash: 'agent-eval-v1',
    },
    channels: { requestPlanApproval: async () => true },
    clock: input.clock ?? fixedClock(),
    ids: input.ids ?? createSequentialIds(),
  })
}

async function stateWithPrompt(
  runtime: AgentRuntime,
  prompt: string,
): Promise<AgentState> {
  const state = runtime.makeInitialState()
  const message = runtime.makeUserMessage(prompt, null)
  if (runtime.journal) {
    await runtime.journal.append(
      { type: 'user.message.accepted', message },
      message.turnId,
      'flush',
    )
  }
  return { ...state, messages: [message] }
}

async function collectEngine(
  runtime: AgentRuntime,
  initial: AgentState,
): Promise<EngineResult> {
  const events: AgentEvent[] = []
  const generator = runtime.engine.run(initial, new AbortController().signal)
  let step = await generator.next()
  while (!step.done) {
    events.push(step.value)
    step = await generator.next()
  }
  return {
    events,
    facts: events.filter(isFactEvent),
    terminal: step.value,
  }
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const value = key(item)
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

function check(
  family: Parameters<typeof makeEvalCheck>[0],
  name: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
): AgentEvalCheck {
  return makeEvalCheck(family, name, passed, expected, actual)
}

async function buildRun(
  spec: ScenarioSpec,
  run: number,
  durationMs: number,
  evidence: RunEvidence,
): Promise<AgentEvalRun> {
  const checks: AgentEvalCheck[] = [...(evidence.extraChecks ?? [])]
  const accepted = evidence.facts.filter(
    (fact): fact is Extract<FactEvent, { type: 'tool.call.accepted' }> =>
      fact.type === 'tool.call.accepted',
  )
  const completed = evidence.facts.filter(
    (fact): fact is Extract<FactEvent, { type: 'tool.call.completed' }> =>
      fact.type === 'tool.call.completed',
  )
  const acceptedIds = new Set(accepted.map(fact => fact.call.id))
  const completionCounts = countBy(completed, fact => fact.result.callId)
  const orphanIds = [...acceptedIds].filter(id => !completionCounts[id])
  const duplicateResults = Object.entries(completionCounts)
    .filter(([, count]) => count > 1)
    .map(([id]) => id)

  checks.push(
    check(
      'correctness',
      'terminal reason',
      spec.expect.terminal.includes(evidence.terminalReason),
      spec.expect.terminal,
      evidence.terminalReason,
    ),
    check('safety', 'no orphan tool calls', orphanIds.length === 0, [], orphanIds),
    check(
      'safety',
      'one terminal result per call',
      duplicateResults.length === 0,
      [],
      duplicateResults,
    ),
  )

  if (spec.expect.modelRequests !== undefined) {
    checks.push(
      check(
        'efficiency',
        'exact model request budget',
        evidence.modelRequests === spec.expect.modelRequests,
        spec.expect.modelRequests,
        evidence.modelRequests,
      ),
    )
  }
  if (spec.expect.maxModelRequests !== undefined) {
    checks.push(
      check(
        'efficiency',
        'model request budget',
        evidence.modelRequests <= spec.expect.maxModelRequests,
        `<= ${spec.expect.maxModelRequests}`,
        evidence.modelRequests,
      ),
    )
  }
  if (spec.expect.maxToolCalls !== undefined) {
    checks.push(
      check(
        'efficiency',
        'tool call budget',
        accepted.length <= spec.expect.maxToolCalls,
        `<= ${spec.expect.maxToolCalls}`,
        accepted.length,
      ),
    )
  }

  for (const [callId, expected] of Object.entries(spec.expect.toolResults ?? {})) {
    const fact = completed.find(item => item.result.callId === callId)
    checks.push(
      check(
        'correctness',
        `${callId} succeeds`,
        expected === 'ok' && fact?.result.ok === true,
        expected,
        fact ? (fact.result.ok ? 'ok' : fact.result.errorCode ?? 'error') : 'missing',
      ),
    )
  }
  for (const [callId, errorCode] of Object.entries(spec.expect.toolErrors ?? {})) {
    const fact = completed.find(item => item.result.callId === callId)
    checks.push(
      check(
        errorCode === 'REPLAN_APPROVAL_PENDING' ||
          errorCode === 'TOOL_NOT_AVAILABLE_IN_MODE' ||
          errorCode === 'TOOL_NOT_AVAILABLE_FOR_ACTION'
          ? 'policy'
          : 'correctness',
        `${callId} returns ${errorCode}`,
        fact?.result.ok === false && fact.result.errorCode === errorCode,
        errorCode,
        fact?.result.errorCode ?? 'missing',
      ),
    )
  }

  const factCounts = countBy(evidence.facts, fact => fact.type)
  for (const factType of spec.expect.requiredFacts ?? []) {
    checks.push(
      check(
        factType === 'session.recovery.branch' ? 'recovery' : 'correctness',
        `fact ${factType} is present`,
        (factCounts[factType] ?? 0) > 0,
        'present',
        factCounts[factType] ?? 0,
      ),
    )
  }
  for (const factType of spec.expect.absentFacts ?? []) {
    checks.push(
      check(
        'policy',
        `fact ${factType} is absent`,
        (factCounts[factType] ?? 0) === 0,
        0,
        factCounts[factType] ?? 0,
      ),
    )
  }

  if (spec.expect.replan) {
    const replans = evidence.facts.filter(
      (fact): fact is Extract<FactEvent, { type: 'replan.requested' }> =>
        fact.type === 'replan.requested',
    )
    const matching = replans.filter(
      fact =>
        fact.cause === spec.expect.replan!.cause &&
        fact.requiresReapproval === spec.expect.replan!.requiresReapproval,
    )
    checks.push(
      check(
        'policy',
        'replan classification',
        replans.length === spec.expect.replan.count &&
          matching.length === spec.expect.replan.count,
        spec.expect.replan,
        replans.map(fact => ({
          cause: fact.cause,
          requiresReapproval: fact.requiresReapproval,
        })),
      ),
    )
  }

  if (spec.expect.stagnation) {
    const records = evidence.facts.filter(
      (fact): fact is Extract<FactEvent, { type: 'loop.stagnation.detected' }> =>
        fact.type === 'loop.stagnation.detected',
    )
    const matching = records.filter(
      fact => fact.record.kind === spec.expect.stagnation!.kind,
    )
    checks.push(
      check(
        'policy',
        'stagnation classification',
        matching.length === spec.expect.stagnation.count,
        spec.expect.stagnation,
        records.map(fact => fact.record.kind),
      ),
    )
  }

  if (spec.expect.reflection) {
    const reflections = evidence.facts.filter(
      (fact): fact is Extract<FactEvent, { type: 'reflection.recorded' }> =>
        fact.type === 'reflection.recorded',
    )
    const matching = reflections.filter(
      fact => fact.reflection.trigger === spec.expect.reflection!.trigger,
    )
    checks.push(
      check(
        'policy',
        'reflection trigger',
        matching.length === spec.expect.reflection.count,
        spec.expect.reflection,
        reflections.map(fact => fact.reflection.trigger),
      ),
    )
  }

  if (spec.expect.modelFailureCodes) {
    const failures = evidence.facts.filter(
      (fact): fact is Extract<FactEvent, { type: 'model.attempt.failed' }> =>
        fact.type === 'model.attempt.failed',
    )
    const actual = countBy(failures, fact => fact.failure.code)
    for (const [code, count] of Object.entries(spec.expect.modelFailureCodes)) {
      checks.push(
        check(
          'recovery',
          `model failure ${code} is observed`,
          (actual[code] ?? 0) === count,
          count,
          actual[code] ?? 0,
        ),
      )
    }
  }

  for (const [relativePath, expected] of Object.entries(spec.expect.filesEqual ?? {})) {
    let actual = '<missing>'
    try {
      actual = await readFile(
        safeWorkspacePath(evidence.workspaceRoot, relativePath),
        'utf8',
      )
    } catch {
      // represented as <missing> in the check
    }
    checks.push(
      check(
        'correctness',
        `file ${relativePath} content`,
        actual === expected,
        expected,
        actual,
      ),
    )
  }
  for (const relativePath of spec.expect.absentFiles ?? []) {
    let exists = true
    try {
      await readFile(safeWorkspacePath(evidence.workspaceRoot, relativePath))
    } catch {
      exists = false
    }
    checks.push(
      check(
        'safety',
        `file ${relativePath} remains absent`,
        !exists,
        'absent',
        exists ? 'present' : 'absent',
      ),
    )
  }

  for (const expectation of spec.expect.requestTools ?? []) {
    const request = evidence.requests[expectation.request - 1]
    const names = request?.tools.map(tool => tool.name) ?? []
    for (const name of expectation.include ?? []) {
      checks.push(
        check(
          'policy',
          `request ${expectation.request} exposes ${name}`,
          names.includes(name),
          'present',
          names.includes(name) ? 'present' : 'absent',
        ),
      )
    }
    for (const name of expectation.exclude ?? []) {
      checks.push(
        check(
          'policy',
          `request ${expectation.request} hides ${name}`,
          !names.includes(name),
          'absent',
          names.includes(name) ? 'present' : 'absent',
        ),
      )
    }
  }

  if (spec.expect.lane) {
    const lanes = evidence.facts.filter(
      (fact): fact is Extract<FactEvent, { type: 'tool.lane.selected' }> =>
        fact.type === 'tool.lane.selected',
    )
    const requestNumber = spec.expect.lane.request
    const requestSpecified = requestNumber !== undefined
    const validRequestNumber = !requestSpecified ||
      (Number.isInteger(requestNumber) && requestNumber! > 0)
    const laneRequest = requestSpecified && validRequestNumber
      ? evidence.requests[requestNumber! - 1]
      : undefined
    const requestedLaneExists = !requestSpecified || Boolean(laneRequest)
    if (requestSpecified) {
      checks.push(check(
        'policy',
        `tool lane request ${String(requestNumber)} exists`,
        validRequestNumber && requestedLaneExists,
        'existing positive one-based request',
        validRequestNumber
          ? (laneRequest ? 'present' : 'missing')
          : 'invalid request number',
      ))
    }
    const selected = validRequestNumber && requestedLaneExists
      ? [...lanes].reverse().find(fact =>
          fact.selection.action === spec.expect.lane!.action &&
          (!requestSpecified || laneRequest!.system.includes(fact.selection.hash)),
        )
      : undefined
    checks.push(
      check(
        'policy',
        `supervisor action ${spec.expect.lane.action} selects a durable tool lane`,
        Boolean(selected),
        spec.expect.lane.action,
        selected?.selection.action ?? 'missing',
      ),
    )
    if (selected) {
      const projectedRequest = laneRequest ?? evidence.requests.find(request =>
        request.system.includes(selected.selection.hash),
      )
      const requested = Boolean(projectedRequest?.system.includes(selected.selection.hash))
      checks.push(
        check(
          'policy',
          'tool lane hash is projected into a model request',
          requested,
          selected.selection.hash,
          requested ? selected.selection.hash : 'missing',
        ),
      )
      const requestTools = [...(projectedRequest?.tools.map(tool => tool.name) ?? [])].sort()
      const selectedTools = [...selected.selection.allowedTools].sort()
      checks.push(check(
        'policy',
        'model request tools exactly match the durable allowed-tool projection',
        JSON.stringify(requestTools) === JSON.stringify(selectedTools),
        selectedTools.join(','),
        requestTools.join(','),
      ))
      for (const name of spec.expect.lane.include ?? []) {
        checks.push(check(
          'policy',
          `tool lane exposes ${name}`,
          selected.selection.allowedTools.includes(name),
          'present',
          selected.selection.allowedTools.includes(name) ? 'present' : 'absent',
        ))
      }
      for (const name of spec.expect.lane.exclude ?? []) {
        checks.push(check(
          'policy',
          `tool lane hides ${name}`,
          !selected.selection.allowedTools.includes(name),
          'absent',
          selected.selection.allowedTools.includes(name) ? 'present' : 'absent',
        ))
      }
    }
    if (spec.expect.lane.refusedCallId) {
      const refusal = completed.find(
        fact => fact.result.callId === spec.expect.lane!.refusedCallId,
      )
      checks.push(check(
        'safety',
        'forged hidden tool is refused before side effects',
        refusal?.result.errorCode === 'TOOL_NOT_AVAILABLE_FOR_ACTION',
        'TOOL_NOT_AVAILABLE_FOR_ACTION',
        refusal?.result.errorCode ?? 'missing',
      ))
      if (selected) {
        const refusalBody = JSON.stringify(refusal?.result.content ?? null)
        checks.push(check(
          'safety',
          'runtime refusal names the same frozen tool-lane projection',
          refusalBody.includes(selected.selection.hash),
          selected.selection.hash,
          refusalBody.includes(selected.selection.hash) ? selected.selection.hash : 'missing',
        ))
      }
    }
  }

  return {
    run,
    passed: checks.every(item => item.passed),
    durationMs,
    traceHash: hashFactTrace(evidence.facts),
    terminalReason: evidence.terminalReason,
    modelRequests: evidence.modelRequests,
    toolCalls: accepted.length,
    failedToolCalls: completed.filter(fact => !fact.result.ok).length,
    checks,
  }
}

async function runAgentScenario(
  spec: ScenarioSpec,
  run: number,
): Promise<AgentEvalRun> {
  const startedAt = Date.now()
  const workspaceRoot = await mkdtemp(join(tmpdir(), `agent-eval-${spec.id}-`))
  try {
    await seedFiles(workspaceRoot, spec.files)
    const scripted = new ScriptedModel(scriptedTurns(spec.turns))
    let model: ModelGateway = scripted
    let faultModel: FaultInjectingModel | undefined
    if (spec.modelFaults?.length) {
      faultModel = new FaultInjectingModel(
        scripted,
        spec.modelFaults as ModelFault[],
      )
      model = faultModel
    }
    const { runtime } = await createEvalRuntime({
      workspaceRoot,
      model,
      mode: spec.mode,
      runtime: spec.runtime,
    })
    const result = await collectEngine(
      runtime,
      await stateWithPrompt(runtime, spec.prompt ?? spec.title),
    )
    const extraChecks: AgentEvalCheck[] = []
    if (faultModel) {
      let consumed = true
      let detail = 'all scheduled faults injected'
      try {
        faultModel.assertScheduleConsumed()
      } catch (error) {
        consumed = false
        detail = (error as Error).message
      }
      extraChecks.push(
        check(
          'recovery',
          'fault schedule consumed',
          consumed,
          'all scheduled faults injected',
          detail,
        ),
      )
    }
    return await buildRun(spec, run, Date.now() - startedAt, {
      facts: result.facts,
      terminalReason: result.terminal.reason,
      modelRequests: faultModel?.requestCount ?? scripted.requests.length,
      requests: scripted.requests,
      workspaceRoot,
      extraChecks,
    })
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

function userMessage(
  sessionId: string,
  id: string,
  text: string,
): Extract<FactEvent, { type: 'user.message.accepted' }>['message'] {
  return {
    id,
    parentId: null,
    sessionId,
    turnId: 'turn_seed',
    role: 'user',
    content: [{ type: 'text', text }],
    createdAt: '2026-01-01T00:00:00.000Z',
    meta: { source: 'human' },
  }
}

function envelope(
  sessionId: string,
  seq: number,
  event: FactEvent,
  parentEventId: string | null,
): JournalEnvelope {
  const base = {
    schemaVersion: 1 as const,
    seq,
    eventId: `evt_seed_${seq}`,
    sessionId,
    runId: 'run_seed',
    turnId: 'turn_seed',
    parentEventId,
    timestamp: new Date(1_000_000 + seq * 1_000).toISOString(),
    event,
  }
  return { ...base, checksum: envelopeChecksum(base) }
}

async function writeJournal(
  workspaceRoot: string,
  sessionId: string,
  envelopes: JournalEnvelope[],
): Promise<string> {
  const journalPath = join(
    workspaceRoot,
    '.agent',
    'sessions',
    sessionId,
    'journal.jsonl',
  )
  await mkdir(dirname(journalPath), { recursive: true })
  await writeFile(
    journalPath,
    `${envelopes.map(item => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  )
  return journalPath
}

async function runRecoveryOrphan(
  spec: ScenarioSpec,
  run: number,
): Promise<AgentEvalRun> {
  const startedAt = Date.now()
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-eval-orphan-'))
  const sessionId = 'eval-orphan-source'
  try {
    const sourceModel = new ScriptedModel([])
    const { runtime: source } = await createEvalRuntime({
      workspaceRoot,
      model: sourceModel,
      persist: true,
      sessionId,
      ids: namespacedIds('source'),
    })
    const message = source.makeUserMessage('resume the interrupted read', null)
    await source.journal!.append(
      { type: 'user.message.accepted', message },
      message.turnId,
      'flush',
    )
    await source.journal!.append(
      {
        type: 'tool.call.accepted',
        call: {
          id: 'orphan_read',
          name: 'Read',
          input: { path: 'missing.txt' },
          parentMessageId: message.id,
          receivedIndex: 0,
        },
      },
      message.turnId,
      'flush',
    )
    await source.journal!.append(
      {
        type: 'tool.call.accepted',
        call: {
          id: 'completed_without_message',
          name: 'Read',
          input: { path: 'already-read.txt' },
          parentMessageId: message.id,
          receivedIndex: 1,
        },
      },
      message.turnId,
      'flush',
    )
    await source.journal!.append(
      {
        type: 'tool.call.completed',
        result: {
          callId: 'completed_without_message',
          toolName: 'Read',
          ok: true,
          content: { kind: 'text', text: 'durable result' },
          durationMs: 1,
        },
      },
      message.turnId,
      'flush',
    )

    const resumedModel = new ScriptedModel([
      textTurn('The interrupted call was closed safely.'),
    ])
    const { runtime, loaded } = await createEvalRuntime({
      workspaceRoot,
      model: resumedModel,
      persist: true,
      sessionId,
      ids: namespacedIds('resume'),
    })
    if (!loaded) throw new Error('orphan scenario did not load the source session')
    const resumed = await resumeState(runtime, loaded)
    const result = await collectEngine(runtime, resumed.state)
    const synthetic = resumed.recoveryFacts.filter(
      (fact): fact is Extract<FactEvent, { type: 'tool.call.completed' }> =>
        fact.type === 'tool.call.completed',
    )
    const extraChecks = [
      check(
        'recovery',
        'loader detects one orphan',
        loaded.openToolCalls.length === 1,
        1,
        loaded.openToolCalls.length,
      ),
      check(
        'recovery',
        'orphan closes synthetically',
        synthetic.length === 1 &&
          synthetic[0]!.result.synthetic === true &&
          synthetic[0]!.result.errorCode === 'INTERRUPTED_DURING_PREVIOUS_RUN',
        'one synthetic INTERRUPTED_DURING_PREVIOUS_RUN result',
        synthetic.map(fact => ({
          synthetic: fact.result.synthetic,
          errorCode: fact.result.errorCode,
        })),
      ),
      check(
        'recovery',
        'loader detects a completed call without its result message',
        loaded.unmessagedResults.length === 1 &&
          loaded.unmessagedResults[0]!.callId === 'completed_without_message',
        ['completed_without_message'],
        loaded.unmessagedResults.map(item => item.callId),
      ),
      check(
        'recovery',
        'one recovery message repairs both lifecycle gaps',
        resumed.recoveryFacts.filter(
          fact => fact.type === 'tool.result.message',
        ).length === 1 &&
          resumed.state.messages.some(message =>
            message.content.some(
              block =>
                block.type === 'tool_result' &&
                block.callId === 'completed_without_message' &&
                block.ok,
            ),
          ),
        'one message containing the durable successful result',
        resumed.recoveryFacts.map(fact => fact.type),
      ),
      check(
        'safety',
        'recovered state has no pending calls',
        resumed.state.pendingToolCalls.length === 0,
        0,
        resumed.state.pendingToolCalls.length,
      ),
    ]
    const sourceFacts = loaded.envelopes.map(item => item.event as FactEvent)
    return await buildRun(spec, run, Date.now() - startedAt, {
      facts: [...sourceFacts, ...resumed.recoveryFacts, ...result.facts],
      terminalReason: result.terminal.reason,
      modelRequests: resumedModel.requests.length,
      requests: resumedModel.requests,
      workspaceRoot,
      extraChecks,
    })
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function runRecoveryChecksum(
  spec: ScenarioSpec,
  run: number,
): Promise<AgentEvalRun> {
  const startedAt = Date.now()
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-eval-checksum-'))
  const sessionId = 'eval-checksum-source'
  try {
    const first = envelope(
      sessionId,
      1,
      { type: 'run.started', runId: 'run_seed', configHash: 'agent-eval-v1' },
      null,
    )
    const validSecond = envelope(
      sessionId,
      2,
      {
        type: 'user.message.accepted',
        message: userMessage(sessionId, 'msg_bad_checksum', 'must not replay'),
      },
      first.eventId,
    )
    const badSecond = { ...validSecond, checksum: 'deadbeefdeadbeef' }
    const journalPath = await writeJournal(
      workspaceRoot,
      sessionId,
      [first, badSecond],
    )
    const loaded = await loadSession(journalPath)
    const diagnosis = diagnoseSession(loaded, workspaceRoot)
    // Build the real runtime even though strict preflight correctly refuses
    // before invoking its AgentEngine.
    await createEvalRuntime({
      workspaceRoot,
      model: new ScriptedModel([]),
      persist: false,
      ids: namespacedIds('checksum'),
    })
    const expectedDiagnostic = spec.expect.diagnostic
    const expectedTrusted = spec.expect.lastTrustedSeq
    const extraChecks = [
      check(
        'recovery',
        'checksum diagnosis is exact',
        diagnosis.ok === false &&
          diagnosis.issues.some(issue => issue.invariant === expectedDiagnostic),
        expectedDiagnostic,
        diagnosis.issues.map(issue => issue.invariant),
      ),
      check(
        'recovery',
        'checksum replay stops at trusted seq',
        diagnosis.lastTrustedSeq === expectedTrusted,
        expectedTrusted,
        diagnosis.lastTrustedSeq,
      ),
      check(
        'safety',
        'corrupt envelope is excluded',
        loaded.envelopes.length === 1,
        1,
        loaded.envelopes.length,
      ),
    ]
    return await buildRun(spec, run, Date.now() - startedAt, {
      facts: loaded.envelopes.map(item => item.event as FactEvent),
      terminalReason: 'recovery_refused',
      modelRequests: 0,
      requests: [],
      workspaceRoot,
      extraChecks,
    })
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

function normalizeRecoveredState(state: AgentState): Record<string, unknown> {
  const { runId: _runId, turnId: _turnId, budget, ...rest } = state
  return {
    ...rest,
    budget: {
      maxTurns: budget.maxTurns,
      maxModelCalls: budget.maxModelCalls,
      maxToolCalls: budget.maxToolCalls,
      maxWallTimeMs: budget.maxWallTimeMs,
      used: {
        modelCalls: budget.used.modelCalls,
        toolCalls: budget.used.toolCalls,
        inputTokens: budget.used.inputTokens,
        outputTokens: budget.used.outputTokens,
      },
    },
  }
}

function firstStructuralDifference(
  left: unknown,
  right: unknown,
  path = '$',
): string | undefined {
  if (Object.is(left, right)) return undefined
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return `${path}: type mismatch`
    if (left.length !== right.length) {
      return `${path}.length: ${left.length} !== ${right.length}`
    }
    for (let index = 0; index < left.length; index++) {
      const difference = firstStructuralDifference(left[index], right[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return undefined
  }
  if (
    typeof left === 'object' && left !== null &&
    typeof right === 'object' && right !== null
  ) {
    const leftRecord = left as Record<string, unknown>
    const rightRecord = right as Record<string, unknown>
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort()
    for (const key of keys) {
      if (!(key in leftRecord) || !(key in rightRecord)) {
        return `${path}.${key}: missing on ${key in leftRecord ? 'right' : 'left'}`
      }
      const difference = firstStructuralDifference(
        leftRecord[key], rightRecord[key], `${path}.${key}`,
      )
      if (difference) return difference
    }
    return undefined
  }
  return `${path}: ${JSON.stringify(left)} !== ${JSON.stringify(right)}`
}

async function runRecoverySnapshot(
  spec: ScenarioSpec,
  run: number,
): Promise<AgentEvalRun> {
  const startedAt = Date.now()
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-eval-snapshot-'))
  const sessionId = 'eval-snapshot-source'
  try {
    await seedFiles(workspaceRoot, spec.files)
    const sourceModel = new ScriptedModel(scriptedTurns(spec.turns))
    const { runtime: source } = await createEvalRuntime({
      workspaceRoot,
      model: sourceModel,
      persist: true,
      sessionId,
      mode: 'bypassPermissions',
      ids: namespacedIds('snapshot_source'),
    })
    const result = await collectEngine(
      source,
      await stateWithPrompt(source, spec.prompt ?? spec.title),
    )
    const loaded = await loadSession(source.journalPath)

    const runtimeA = (
      await createEvalRuntime({
        workspaceRoot,
        model: new ScriptedModel([]),
        persist: false,
        mode: 'bypassPermissions',
        ids: namespacedIds('snapshot_resume'),
      })
    ).runtime
    const runtimeB = (
      await createEvalRuntime({
        workspaceRoot,
        model: new ScriptedModel([]),
        persist: false,
        mode: 'bypassPermissions',
        ids: namespacedIds('snapshot_resume'),
      })
    ).runtime
    const snapshotReplay = await resumeState(runtimeA, loaded)
    const fullReplay = await resumeState(runtimeB, {
      ...loaded,
      lastSnapshot: null,
    })
    const normalizedSnapshot = normalizeRecoveredState(snapshotReplay.state)
    const normalizedFull = normalizeRecoveredState(fullReplay.state)
    const stateDifference = firstStructuralDifference(normalizedSnapshot, normalizedFull)
    const equivalent = stateDifference === undefined
    const extraChecks = [
      check(
        'recovery',
        'V5 snapshot is present',
        loaded.lastSnapshot?.version === 5,
        5,
        loaded.lastSnapshot?.version ?? 'missing',
      ),
      check(
        'recovery',
        'snapshot has a bounded replay tail',
        loaded.tailEvents.length > 0 &&
          loaded.tailEvents.length < loaded.envelopes.length,
        '0 < tail < envelopes',
        `${loaded.tailEvents.length}/${loaded.envelopes.length}`,
      ),
      check(
        'recovery',
        'snapshot and full replay are equivalent',
        equivalent &&
          snapshotReplay.replayFailure === null &&
          fullReplay.replayFailure === null,
        'equivalent states with no replay failure',
        equivalent
          ? 'equivalent'
          : stateDifference ?? 'replay failure',
      ),
    ]
    return await buildRun(spec, run, Date.now() - startedAt, {
      facts: result.facts,
      terminalReason: result.terminal.reason,
      modelRequests: sourceModel.requests.length,
      requests: sourceModel.requests,
      workspaceRoot,
      extraChecks,
    })
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function seedReducerCorruption(
  workspaceRoot: string,
  sessionId: string,
): Promise<string> {
  const first = envelope(
    sessionId,
    1,
    { type: 'run.started', runId: 'run_seed', configHash: 'agent-eval-v1' },
    null,
  )
  const second = envelope(
    sessionId,
    2,
    {
      type: 'user.message.accepted',
      message: userMessage(sessionId, 'msg_source_1', 'first trusted message'),
    },
    first.eventId,
  )
  const third = envelope(
    sessionId,
    3,
    {
      type: 'replan.adjustment.applied',
      cause: 'injected_corruption',
      summary: 'no replan is open',
    },
    second.eventId,
  )
  const fourth = envelope(
    sessionId,
    4,
    {
      type: 'user.message.accepted',
      message: userMessage(sessionId, 'msg_source_2', 'message after corrupt fact'),
    },
    third.eventId,
  )
  return writeJournal(workspaceRoot, sessionId, [first, second, third, fourth])
}

async function runRecoveryDegradedBranch(
  spec: ScenarioSpec,
  run: number,
): Promise<AgentEvalRun> {
  const startedAt = Date.now()
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-eval-degraded-'))
  const sourceSessionId = 'eval-degraded-source'
  const branchSessionId = 'eval-degraded-branch'
  try {
    const sourceJournalPath = await seedReducerCorruption(
      workspaceRoot,
      sourceSessionId,
    )
    const sourceBefore = await readFile(sourceJournalPath, 'utf8')
    const loaded = await loadSession(sourceJournalPath)
    const diagnosis = diagnoseSession(loaded, workspaceRoot)
    const branchModel = new ScriptedModel(scriptedTurns(spec.turns))
    const { runtime } = await createEvalRuntime({
      workspaceRoot,
      model: branchModel,
      persist: true,
      sessionId: branchSessionId,
      recoveryForkFrom: sourceSessionId,
      mode: 'bypassPermissions',
      ids: namespacedIds('degraded_branch'),
    })
    const resumed = await resumeState(runtime, loaded, { degraded: true })
    const branchFact: FactEvent = {
      type: 'session.recovery.branch',
      fromSessionId: sourceSessionId,
      failureSeq: resumed.replayFailure?.seq ?? diagnosis.lastTrustedSeq + 1,
      issues: diagnosis.issues.map(issue => issue.message),
    }
    await runtime.journal!.append(branchFact, resumed.state.turnId, 'flush')
    const branchState = reduce(resumed.state, branchFact)
    const result = await collectEngine(runtime, branchState)
    const sourceAfter = await readFile(sourceJournalPath, 'utf8')
    const branchJournal = await readFile(runtime.journalPath, 'utf8')
    const expectedDiagnostic = spec.expect.diagnostic
    const expectedTrusted = spec.expect.lastTrustedSeq
    const humanTexts = branchState.messages
      .filter(message => message.meta?.source === 'human')
      .map(message =>
        message.content
          .filter(block => block.type === 'text')
          .map(block => (block.type === 'text' ? block.text : ''))
          .join(''),
      )
    const extraChecks = [
      check(
        'recovery',
        'degraded diagnosis is exact',
        diagnosis.issues.some(issue => issue.invariant === expectedDiagnostic) &&
          diagnosis.lastTrustedSeq === expectedTrusted,
        { diagnostic: expectedDiagnostic, lastTrustedSeq: expectedTrusted },
        {
          diagnostics: diagnosis.issues.map(issue => issue.invariant),
          lastTrustedSeq: diagnosis.lastTrustedSeq,
        },
      ),
      check(
        'recovery',
        'degraded replay skips only the invalid fact',
        resumed.replayFailure?.allowDegraded === true &&
          humanTexts.includes('first trusted message') &&
          humanTexts.includes('message after corrupt fact'),
        'both valid messages survive and failure is marked degraded',
        { allowDegraded: resumed.replayFailure?.allowDegraded, humanTexts },
      ),
      check(
        'safety',
        'source journal is byte-identical',
        sourceAfter === sourceBefore,
        'unchanged',
        sourceAfter === sourceBefore ? 'unchanged' : 'modified',
      ),
      check(
        'recovery',
        'branch provenance is durable',
        branchJournal.includes('session.recovery.branch') &&
          branchJournal.includes(sourceSessionId),
        'branch fact naming source session',
        branchJournal.includes('session.recovery.branch')
          ? 'present'
          : 'missing',
      ),
      check(
        'policy',
        'degraded state is read-only plan mode',
        branchState.recovery.degradedRecovery === true && branchState.mode === 'plan',
        { degradedRecovery: true, mode: 'plan' },
        {
          degradedRecovery: branchState.recovery.degradedRecovery,
          mode: branchState.mode,
        },
      ),
    ]
    return await buildRun(spec, run, Date.now() - startedAt, {
      facts: [
        ...loaded.envelopes.map(item => item.event as FactEvent),
        branchFact,
        ...result.facts,
      ],
      terminalReason: result.terminal.reason,
      modelRequests: branchModel.requests.length,
      requests: branchModel.requests,
      workspaceRoot,
      extraChecks,
    })
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

function calibrationReflection(
  sessionId: string,
  window: number,
): Extract<FactEvent, { type: 'reflection.recorded' }>['reflection'] {
  return {
    id: `reflection_${sessionId}`,
    trigger: 'periodic',
    createdAt: new Date(1_000_000).toISOString(),
    summary: 'deterministic calibration history sample',
    assumptions: [],
    progress: {
      completedTasks: 0,
      totalTasks: 0,
      touchedFiles: 0,
      toolCalls: 0,
      evidenceReceipts: 0,
      successfulToolCalls: 0,
    },
    evidenceGaps: [],
    recommendation: 'continue the current step',
    decision: {
      action: 'continue_step',
      rationale: 'observe a bounded amount of additional work',
      successSignals: ['workspace progress'],
      evaluateAfterToolCalls: window,
    },
  }
}

function calibrationEvaluation(
  sessionId: string,
  outcome: 'effective' | 'ineffective',
  window: number,
): Extract<FactEvent, { type: 'reflection.evaluated' }>['evaluation'] {
  return {
    id: `evaluation_${sessionId}`,
    reflectionId: `reflection_${sessionId}`,
    createdAt: new Date(1_001_000).toISOString(),
    outcome,
    toolCallsObserved: window,
    progressSignals: outcome === 'effective' ? ['workspace progress'] : [],
    followUp: {
      action: 'continue_step',
      rationale: 'retain the deterministic supervisor action',
      successSignals: ['workspace progress'],
    },
  }
}

async function seedCalibrationHistoryGroup(input: {
  workspaceRoot: string
  prefix: string
  outcome: 'effective' | 'ineffective'
}): Promise<void> {
  for (let index = 1; index <= 3; index += 1) {
    const sessionId = `${input.prefix}-${index}`
    const window = input.outcome === 'effective' ? 1 : 3
    const events: FactEvent[] = [
      {
        type: 'run.started',
        runId: `run_${sessionId}`,
        configHash: 'agent-eval-calibration-history-v1',
      },
      {
        type: 'reflection.recorded',
        reflection: calibrationReflection(sessionId, window),
      },
    ]
    for (let observed = 1; observed <= window; observed += 1) {
      const callId = `read_${sessionId}_${observed}`
      events.push({
        type: 'tool.call.accepted',
        call: {
          id: callId,
          name: 'Read',
          input: { path: 'input.txt' },
          parentMessageId: `message_${sessionId}`,
          receivedIndex: observed - 1,
        },
      })
      if (input.outcome === 'effective' && observed === 1) {
        events.push({
          type: 'workspace.changed',
          path: join(input.workspaceRoot, `progress-${sessionId}.txt`),
          change: 'modified',
        })
      }
      events.push({
        type: 'tool.call.completed',
        result: {
          callId,
          toolName: 'Read',
          ok: true,
          content: { kind: 'text', text: 'historical observation' },
          durationMs: 1,
        },
      })
    }
    events.push(
      {
        type: 'reflection.evaluated',
        evaluation: calibrationEvaluation(sessionId, input.outcome, window),
      },
      { type: 'run.terminated', terminal: { reason: 'completed' } },
    )
    const envelopes: JournalEnvelope[] = []
    let parentEventId: string | null = null
    for (const [eventIndex, event] of events.entries()) {
      const item = envelope(sessionId, eventIndex + 1, event, parentEventId)
      envelopes.push(item)
      parentEventId = item.eventId
    }
    await writeJournal(input.workspaceRoot, sessionId, envelopes)
  }
}

async function removeCalibrationHistoryGroup(
  workspaceRoot: string,
  prefix: string,
): Promise<void> {
  for (let index = 1; index <= 3; index += 1) {
    await rm(
      join(workspaceRoot, '.agent', 'sessions', `${prefix}-${index}`),
      { recursive: true, force: true },
    )
  }
}

function calibrationTurns(): ScriptedTurn[] {
  return [
    toolCallTurn([{
      id: 'calibration_task_create',
      name: 'TaskCreate',
      input: {
        subject: 'calibration eval task',
        description: 'exercise a pinned reflection observation window',
        activeForm: 'observing',
      },
    }]),
    toolCallTurn([{
      id: 'calibration_read_1',
      name: 'Read',
      input: { path: 'input.txt' },
    }]),
    toolCallTurn([{
      id: 'calibration_read_2',
      name: 'Read',
      input: { path: 'input.txt' },
    }]),
    toolCallTurn([{
      id: 'calibration_read_3',
      name: 'Read',
      input: { path: 'input.txt' },
    }]),
    toolCallTurn([{
      id: 'calibration_read_4',
      name: 'Read',
      input: { path: 'input.txt' },
    }]),
    toolCallTurn([{
      id: 'calibration_task_complete',
      name: 'TaskUpdate',
      input: { id: 'task_1', expectedRevision: 1, status: 'completed' },
    }]),
    textTurn('The calibration recovery check completed.'),
    textTurn('All durable task state is complete; finalize the run.'),
    textTurn('No additional work remains.'),
  ]
}

async function appendEvalPrompt(
  runtime: AgentRuntime,
  state: AgentState,
  text: string,
): Promise<AgentState> {
  const message = runtime.makeUserMessage(
    text,
    state.messages[state.messages.length - 1]?.id ?? null,
  )
  const fact: FactEvent = { type: 'user.message.accepted', message }
  if (runtime.journal) {
    await runtime.journal.append(fact, message.turnId, 'flush')
  }
  return reduce(state, fact)
}

function promptHashes(requests: ModelRequest[]): string[] {
  return requests.map(request =>
    createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex'),
  )
}

function selectionFacts(
  loaded: Awaited<ReturnType<typeof loadSession>>,
): Array<Extract<FactEvent, { type: 'outcome.calibration.selected' }>> {
  return loaded.envelopes
    .map(item => item.event as FactEvent)
    .filter(
      (fact): fact is Extract<FactEvent, { type: 'outcome.calibration.selected' }> =>
        fact.type === 'outcome.calibration.selected',
    )
}

function selectedPeriodicReflection(
  loaded: Awaited<ReturnType<typeof loadSession>>,
): Extract<FactEvent, { type: 'reflection.recorded' }> | undefined {
  return loaded.envelopes
    .map(item => item.event as FactEvent)
    .find(
      (fact): fact is Extract<FactEvent, { type: 'reflection.recorded' }> =>
        fact.type === 'reflection.recorded' &&
        fact.reflection.trigger === 'periodic' &&
        fact.reflection.decision?.action === 'continue_step',
    )
}

async function createCalibrationRuntime(input: {
  workspaceRoot: string
  sessionId: string
  model: ModelGateway
  persist: boolean
  clockStart: number
  ids: IdGenerator
  disabled?: boolean
}): Promise<Awaited<ReturnType<typeof createEvalRuntime>>> {
  return createEvalRuntime({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    model: input.model,
    persist: input.persist,
    mode: 'bypassPermissions',
    clock: fixedClock(input.clockStart),
    ids: input.ids,
    runtime: {
      maxTurns: 12,
      maxModelCalls: 12,
      maxToolCalls: 12,
      intelligence: {
        enabled: true,
        reflectionInterval: 1,
        reflectionEvaluationWindow: 3,
        completionReflection: false,
        outcomeCalibrationEnabled: input.disabled !== true,
        outcomeCalibrationMinSamples: 3,
        outcomeCalibrationMaxSessions: 50,
      },
    },
  })
}

async function compareCalibrationRecoveryPaths(input: {
  workspaceRoot: string
  sessionId: string
  loaded: Awaited<ReturnType<typeof loadSession>>
  selection: OutcomeCalibrationSelection
}): Promise<{ equivalent: boolean; difference?: string; snapshotVersion: number | string; tail: string }> {
  const snapshotRuntime = (
    await createCalibrationRuntime({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      model: new ScriptedModel([]),
      persist: false,
      clockStart: 40_000_000,
      ids: namespacedIds('calibration_recovery'),
    })
  ).runtime
  const fullRuntime = (
    await createCalibrationRuntime({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      model: new ScriptedModel([]),
      persist: false,
      clockStart: 40_000_000,
      ids: namespacedIds('calibration_recovery'),
    })
  ).runtime
  const snapshotReplay = await resumeState(snapshotRuntime, input.loaded)
  const fullReplay = await resumeState(fullRuntime, {
    ...input.loaded,
    lastSnapshot: null,
  })
  const difference = firstStructuralDifference(
    normalizeRecoveredState(snapshotReplay.state),
    normalizeRecoveredState(fullReplay.state),
  )
  const selectionMatches =
    snapshotReplay.state.outcomeCalibrationSelection?.hash === input.selection.hash &&
    fullReplay.state.outcomeCalibrationSelection?.hash === input.selection.hash
  return {
    equivalent:
      difference === undefined &&
      selectionMatches &&
      snapshotReplay.replayFailure === null &&
      fullReplay.replayFailure === null,
    difference,
    snapshotVersion: input.loaded.lastSnapshot?.version ?? 'missing',
    tail: `${input.loaded.tailEvents.length}/${input.loaded.envelopes.length}`,
  }
}

async function runCalibrationResume(
  spec: ScenarioSpec,
  run: number,
): Promise<AgentEvalRun> {
  const startedAt = Date.now()
  const workspaceRoot = await mkdtemp(join(tmpdir(), `agent-eval-${spec.id}-`))
  const calibrationCase = spec.calibrationCase
  if (!calibrationCase) throw new Error(`${spec.id} does not declare calibrationCase`)
  const currentSessionId = `calibration-${calibrationCase}-current`
  try {
    await seedFiles(workspaceRoot, { 'input.txt': 'calibration input\n' })
    if (calibrationCase !== 'empty_pin') {
      await seedCalibrationHistoryGroup({
        workspaceRoot,
        prefix: 'history-positive',
        outcome: 'effective',
      })
    }

    const first = await createCalibrationRuntime({
      workspaceRoot,
      sessionId: currentSessionId,
      model: new ScriptedModel([]),
      persist: true,
      clockStart: 10_000_000,
      ids: namespacedIds('calibration_initial'),
    })
    const pinned = first.runtime.outcomeCalibrationSelection
    if (!pinned) throw new Error('calibration selection was not persisted at boot')

    let freshSelection: OutcomeCalibrationSelection | undefined
    if (calibrationCase === 'history_pin') {
      await removeCalibrationHistoryGroup(workspaceRoot, 'history-positive')
      await seedCalibrationHistoryGroup({
        workspaceRoot,
        prefix: 'history-negative',
        outcome: 'ineffective',
      })
      freshSelection = (
        await createCalibrationRuntime({
          workspaceRoot,
          sessionId: 'calibration-history-fresh-b',
          model: new ScriptedModel([]),
          persist: true,
          clockStart: 30_000_000,
          ids: namespacedIds('calibration_fresh_b'),
        })
      ).runtime.outcomeCalibrationSelection
    } else if (calibrationCase === 'empty_pin') {
      await seedCalibrationHistoryGroup({
        workspaceRoot,
        prefix: 'history-later-positive',
        outcome: 'effective',
      })
      freshSelection = (
        await createCalibrationRuntime({
          workspaceRoot,
          sessionId: 'calibration-empty-fresh-b',
          model: new ScriptedModel([]),
          persist: true,
          clockStart: 30_000_000,
          ids: namespacedIds('calibration_fresh_b'),
        })
      ).runtime.outcomeCalibrationSelection
    }

    const scripted = new ScriptedModel(calibrationTurns())
    const resumedRuntime = await createCalibrationRuntime({
      workspaceRoot,
      sessionId: currentSessionId,
      model: scripted,
      persist: true,
      clockStart: 20_000_000,
      ids: namespacedIds('calibration_engine'),
      disabled: calibrationCase === 'disabled_precedence',
    })
    if (!resumedRuntime.loaded) throw new Error('calibration session did not resume')
    const resumed = await resumeState(resumedRuntime.runtime, resumedRuntime.loaded)
    const initial = await appendEvalPrompt(
      resumedRuntime.runtime,
      resumed.state,
      'Exercise the pinned outcome calibration policy and finish the task.',
    )
    const result = await collectEngine(resumedRuntime.runtime, initial)

    let twinPromptHashes: string[] | undefined
    if (calibrationCase === 'history_pin') {
      const twinModel = new ScriptedModel(calibrationTurns())
      const twinRuntime = await createCalibrationRuntime({
        workspaceRoot,
        sessionId: currentSessionId,
        model: twinModel,
        persist: false,
        clockStart: 20_000_000,
        ids: namespacedIds('calibration_engine'),
      })
      const twinResumed = await resumeState(
        twinRuntime.runtime,
        resumedRuntime.loaded,
      )
      const twinInitial = await appendEvalPrompt(
        twinRuntime.runtime,
        twinResumed.state,
        'Exercise the pinned outcome calibration policy and finish the task.',
      )
      await collectEngine(twinRuntime.runtime, twinInitial)
      twinPromptHashes = promptHashes(twinModel.requests)
    }

    let reenabledSelection: OutcomeCalibrationSelection | undefined
    if (calibrationCase === 'disabled_precedence') {
      reenabledSelection = (
        await createCalibrationRuntime({
          workspaceRoot,
          sessionId: currentSessionId,
          model: new ScriptedModel([]),
          persist: true,
          clockStart: 30_000_000,
          ids: namespacedIds('calibration_reenabled'),
        })
      ).runtime.outcomeCalibrationSelection
    }

    const finalLoaded = await loadSession(first.runtime.journalPath)
    const durableSelections = selectionFacts(finalLoaded)
    const periodic = selectedPeriodicReflection(finalLoaded)
    const recovery = await compareCalibrationRecoveryPaths({
      workspaceRoot,
      sessionId: currentSessionId,
      loaded: finalLoaded,
      selection: pinned,
    })
    const expectedWindow = calibrationCase === 'history_pin' ? 4 : 3
    const promptFingerprints = promptHashes(scripted.requests)
    const promptCarriesCalibration = scripted.requests.some(
      request =>
        request.system.includes('OUTCOME CALIBRATION') &&
        request.system.includes(pinned.hash) &&
        request.system.includes(pinned.profile.hash),
    )
    const extraChecks: AgentEvalCheck[] = [
      check(
        'policy',
        'boot selection is canonical and durable exactly once',
        durableSelections.length === 1 &&
          isOutcomeCalibrationSelection(durableSelections[0]?.selection) &&
          durableSelections[0]?.selection.hash === pinned.hash,
        { count: 1, hash: pinned.hash },
        {
          count: durableSelections.length,
          hash: durableSelections[0]?.selection.hash ?? 'missing',
        },
      ),
      check(
        'recovery',
        'resume reuses the boot selection instead of rescanning',
        resumedRuntime.runtime.outcomeCalibrationSelection?.hash === pinned.hash &&
          resumed.state.outcomeCalibrationSelection?.hash === pinned.hash,
        pinned.hash,
        {
          runtime: resumedRuntime.runtime.outcomeCalibrationSelection?.hash,
          state: resumed.state.outcomeCalibrationSelection?.hash,
        },
      ),
      check(
        'recovery',
        'V5 snapshot and full replay retain identical calibration state',
        recovery.snapshotVersion === 5 && recovery.equivalent,
        'V5 and equivalent states with pinned selection',
        recovery.equivalent
          ? `V${recovery.snapshotVersion}; tail ${recovery.tail}; equivalent`
          : recovery.difference ?? `V${recovery.snapshotVersion}; replay failure`,
      ),
      check(
        'policy',
        'reflection uses the expected bounded observation window',
        periodic?.reflection.decision?.evaluateAfterToolCalls === expectedWindow,
        expectedWindow,
        periodic?.reflection.decision?.evaluateAfterToolCalls ?? 'missing',
      ),
      check(
        'policy',
        'model prompt fingerprints are canonical SHA-256 values',
        promptFingerprints.length === scripted.requests.length &&
          promptFingerprints.length > 0 &&
          promptFingerprints.every(hash => /^[a-f0-9]{64}$/.test(hash)),
        'one SHA-256 fingerprint per request',
        promptFingerprints,
      ),
    ]

    if (calibrationCase === 'history_pin') {
      const freshWindow = freshSelection && matchOutcomeCalibration({
        profile: freshSelection.profile,
        trigger: 'periodic',
        action: 'continue_step',
        defaultWindow: 3,
      })?.evaluationWindow
      extraChecks.push(
        check(
          'policy',
          'history selection records complete source provenance',
          pinned.origin === 'history_scan' &&
            pinned.scanStatus === 'complete' &&
            pinned.sources.length === 3 &&
            pinned.sources.every(source =>
              source.sessionId.startsWith('history-positive-') &&
              source.throughSeq > 0 &&
              source.sampleCount === 1 &&
              /^[a-f0-9]{64}$/.test(source.sampleHash),
            ),
          'three positive source journals with canonical hashes',
          {
            origin: pinned.origin,
            scanStatus: pinned.scanStatus,
            sources: pinned.sources,
          },
        ),
        check(
          'recovery',
          'fresh B sees changed history while resumed A remains pinned',
          Boolean(freshSelection) &&
            freshSelection!.profile.hash !== pinned.profile.hash &&
            freshSelection!.hash !== pinned.hash &&
            freshWindow === 2 &&
            periodic?.reflection.calibration?.selectionHash === pinned.hash &&
            periodic.reflection.calibration.profileHash === pinned.profile.hash,
          {
            freshWindow: 2,
            pinnedSelection: pinned.hash,
            pinnedProfile: pinned.profile.hash,
          },
          {
            freshWindow,
            freshSelection: freshSelection?.hash,
            freshProfile: freshSelection?.profile.hash,
            reflectionCalibration: periodic?.reflection.calibration,
          },
        ),
        check(
          'policy',
          'independent replay produces identical full prompt hashes',
          JSON.stringify(promptFingerprints) === JSON.stringify(twinPromptHashes),
          promptFingerprints,
          twinPromptHashes ?? 'missing',
        ),
        check(
          'policy',
          'prompt projects both pinned selection and profile hashes',
          promptCarriesCalibration,
          `${pinned.hash}:${pinned.profile.hash}`,
          promptCarriesCalibration ? 'both present' : 'missing provenance',
        ),
      )
    } else if (calibrationCase === 'empty_pin') {
      extraChecks.push(
        check(
          'policy',
          'empty history is an explicit pinned no-history decision',
          pinned.origin === 'history_scan' &&
            pinned.scanStatus === 'no_history' &&
            pinned.sources.length === 0 &&
            pinned.profile.pairedOutcomes === 0 &&
            pinned.profile.entries.length === 0,
          'canonical empty no_history selection',
          {
            origin: pinned.origin,
            scanStatus: pinned.scanStatus,
            sources: pinned.sources.length,
            outcomes: pinned.profile.pairedOutcomes,
          },
        ),
        check(
          'recovery',
          'later history changes fresh B but cannot replace empty pin A',
          Boolean(freshSelection) &&
            freshSelection!.profile.pairedOutcomes === 3 &&
            freshSelection!.hash !== pinned.hash &&
            resumedRuntime.runtime.outcomeCalibrationSelection?.hash === pinned.hash,
          { freshOutcomes: 3, resumedHash: pinned.hash },
          {
            freshOutcomes: freshSelection?.profile.pairedOutcomes,
            freshHash: freshSelection?.hash,
            resumedHash: resumedRuntime.runtime.outcomeCalibrationSelection?.hash,
          },
        ),
        check(
          'policy',
          'empty profile does not claim calibration in reflection or prompt',
          periodic?.reflection.calibration === undefined &&
            !promptCarriesCalibration &&
            scripted.requests.every(request =>
              !request.system.includes('OUTCOME CALIBRATION'),
            ),
          'no calibration attribution or prompt section',
          {
            reflection: periodic?.reflection.calibration ?? null,
            promptCarriesCalibration,
          },
        ),
      )
    } else {
      const reenabledWindow = reenabledSelection && matchOutcomeCalibration({
        profile: reenabledSelection.profile,
        trigger: 'periodic',
        action: 'continue_step',
        defaultWindow: 3,
      })?.evaluationWindow
      extraChecks.push(
        check(
          'policy',
          'runtime disable takes precedence over a positive durable profile',
          pinned.profile.pairedOutcomes === 3 &&
            periodic?.reflection.calibration === undefined &&
            expectedWindow === periodic?.reflection.decision?.evaluateAfterToolCalls &&
            scripted.requests.every(request =>
              !request.system.includes('OUTCOME CALIBRATION') &&
              !request.system.includes(pinned.hash),
            ),
          'window 3 with no calibration attribution or prompt projection',
          {
            outcomes: pinned.profile.pairedOutcomes,
            window: periodic?.reflection.decision?.evaluateAfterToolCalls,
            calibration: periodic?.reflection.calibration ?? null,
          },
        ),
        check(
          'recovery',
          're-enable restores the same pin rather than selecting again',
          reenabledSelection?.hash === pinned.hash &&
            reenabledWindow === 4 &&
            durableSelections.length === 1,
          { hash: pinned.hash, window: 4, selectionFacts: 1 },
          {
            hash: reenabledSelection?.hash,
            window: reenabledWindow,
            selectionFacts: durableSelections.length,
          },
        ),
      )
    }

    return await buildRun(spec, run, Date.now() - startedAt, {
      facts: finalLoaded.envelopes.map(item => item.event as FactEvent),
      terminalReason: result.terminal.reason,
      modelRequests: scripted.requests.length,
      requests: scripted.requests,
      workspaceRoot,
      extraChecks,
    })
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function runScenario(spec: ScenarioSpec, run: number): Promise<AgentEvalRun> {
  switch (spec.driver) {
    case 'agent':
      return runAgentScenario(spec, run)
    case 'recovery_orphan':
      return runRecoveryOrphan(spec, run)
    case 'recovery_checksum':
      return runRecoveryChecksum(spec, run)
    case 'recovery_snapshot':
      return runRecoverySnapshot(spec, run)
    case 'recovery_degraded_branch':
      return runRecoveryDegradedBranch(spec, run)
    case 'calibration_resume':
      return runCalibrationResume(spec, run)
  }
}

function failedRun(run: number, error: unknown): AgentEvalRun {
  const message = error instanceof Error ? error.message : String(error)
  const checks = [
    check('correctness', 'scenario runner does not throw', false, 'no exception', message),
  ]
  return {
    run,
    passed: false,
    durationMs: 0,
    traceHash: hashFactTrace([]),
    terminalReason: 'runner_error',
    modelRequests: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    checks,
  }
}

function validateCatalog(catalog: ScenarioCatalog): void {
  if (catalog.schemaVersion !== 1) throw new Error('unsupported scenario schemaVersion')
  if (!Number.isInteger(catalog.defaults.runs) || catalog.defaults.runs < 1) {
    throw new Error('catalog defaults.runs must be a positive integer')
  }
  const ids = new Set<string>()
  for (const scenario of catalog.scenarios) {
    if (!scenario.id || ids.has(scenario.id)) {
      throw new Error(`invalid or duplicate scenario id: ${scenario.id}`)
    }
    ids.add(scenario.id)
    if (!scenario.expect?.terminal?.length) {
      throw new Error(`scenario ${scenario.id} must declare expected terminal reasons`)
    }
    if (
      scenario.driver === 'calibration_resume' &&
      scenario.calibrationCase !== 'history_pin' &&
      scenario.calibrationCase !== 'empty_pin' &&
      scenario.calibrationCase !== 'disabled_precedence'
    ) {
      throw new Error(
        `scenario ${scenario.id} must declare a supported calibrationCase`,
      )
    }
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  if (flags.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const catalog = JSON.parse(
    await readFile(catalogPath, 'utf8'),
  ) as ScenarioCatalog
  const baseline = JSON.parse(
    await readFile(baselinePath, 'utf8'),
  ) as AgentEvalBaseline
  validateCatalog(catalog)

  const requested = new Set(flags.scenarioIds)
  const known = new Set(catalog.scenarios.map(scenario => scenario.id))
  const missing = [...requested].filter(id => !known.has(id))
  if (missing.length > 0) {
    throw new Error(`unknown scenario id(s): ${missing.join(', ')}`)
  }
  const selected = catalog.scenarios.filter(
    scenario =>
      (requested.size === 0 || requested.has(scenario.id)) &&
      (!flags.faultsOnly || Boolean(scenario.fault)),
  )
  if (selected.length === 0) throw new Error('no scenarios matched the filters')

  const repeats = flags.runs ?? catalog.defaults.runs
  const scenarioResults: AgentEvalScenarioResult[] = []
  for (const scenario of selected) {
    const runs: AgentEvalRun[] = []
    for (let run = 1; run <= repeats; run += 1) {
      process.stderr.write(
        `[agent-eval] ${scenario.id} run ${run}/${repeats} ... `,
      )
      let result: AgentEvalRun
      try {
        result = await runScenario(scenario, run)
      } catch (error) {
        result = failedRun(run, error)
      }
      runs.push(result)
      process.stderr.write(
        `${result.passed ? 'PASS' : 'FAIL'} (${result.traceHash})\n`,
      )
    }
    scenarioResults.push(
      finalizeScenario({
        id: scenario.id,
        title: scenario.title,
        category: scenario.category,
        fault: scenario.fault,
        runs,
      }),
    )
  }

  const report = buildAgentEvalReport({
    scenarios: scenarioResults,
    baseline,
    generatedAt: new Date().toISOString(),
  })
  const json = `${JSON.stringify(report, null, 2)}\n`
  const markdown = renderAgentEvalMarkdown(report)

  if (!flags.noWrite) {
    const resultsDir = join(evalDir, 'results')
    await mkdir(resultsDir, { recursive: true })
    const stamp = report.generatedAt.replace(/[:.]/g, '-')
    const jsonPath = join(resultsDir, `agent-eval-${stamp}.json`)
    const markdownPath = join(resultsDir, `agent-eval-${stamp}.md`)
    const latestJsonPath = join(resultsDir, 'agent-eval-latest.json')
    const latestMarkdownPath = join(resultsDir, 'agent-eval-latest.md')
    await Promise.all([
      writeFile(jsonPath, json, 'utf8'),
      // Markdown is a pure rendering of the exact in-memory JSON report.
      writeFile(markdownPath, markdown, 'utf8'),
      writeFile(latestJsonPath, json, 'utf8'),
      writeFile(latestMarkdownPath, markdown, 'utf8'),
    ])
    process.stderr.write(`[agent-eval] JSON report: ${jsonPath}\n`)
    process.stderr.write(`[agent-eval] Markdown report: ${markdownPath}\n`)
  }

  if (flags.noWrite) {
    process.stdout.write(json)
  } else {
    process.stdout.write(
      `[agent-eval] ${report.passed ? 'PASS' : 'FAIL'} | ` +
        `score ${report.scorecard.overall}/100 | ` +
        `scenarios ${report.scenarios.filter(item => item.passed).length}/` +
        `${report.scenarios.length} | deterministic ` +
        `${(report.metrics.deterministicReplayRate * 100).toFixed(1)}%\n`,
    )
  }
  if (!report.passed) process.exitCode = 1
}

main().catch(error => {
  process.stderr.write(`[agent-eval] ${(error as Error).message}\n`)
  process.exitCode = 1
})
