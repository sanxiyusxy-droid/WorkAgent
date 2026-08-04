import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, TerminalReason, FactEvent } from '../src/core/events.js'
import { isFactEvent } from '../src/core/events.js'
import type { AgentState } from '../src/core/state.js'
import type { AgentEngine } from '../src/core/AgentEngine.js'
import { createSequentialIds, type Clock } from '../src/core/runtimePrimitives.js'
import { createRuntime, type AgentRuntime, type RuntimeChannels, type RuntimeConfig } from '../src/app/createRuntime.js'
import { ScriptedModel, type ScriptedTurn } from '../src/model/ScriptedModel.js'
import type { AskHandler, PermissionRule } from '../src/policy/PolicyEngine.js'
import type { AgentMode } from '../src/core/events.js'
import type { LoadedSession } from '../src/session/SessionLoader.js'

export function fixedClock(start = 1_000_000): Clock {
  let now = start
  return {
    now: () => {
      now += 10
      return now
    },
    isoNow: () => new Date(start).toISOString(),
  }
}

export interface TestWorld {
  workspaceRoot: string
  runtime: AgentRuntime
  model: ScriptedModel
  loaded: LoadedSession | null
  cleanup: () => Promise<void>
}

export async function makeWorld(options: {
  turns: ScriptedTurn[]
  files?: Record<string, string>
  mode?: AgentMode
  askHandler?: AskHandler
  rules?: PermissionRule[]
  persist?: boolean
  sessionId?: string
  workspaceRoot?: string
  maxTurns?: number
  channels?: RuntimeChannels
  verification?: RuntimeConfig['verification']
  context?: RuntimeConfig['context']
}): Promise<TestWorld> {
  const workspaceRoot =
    options.workspaceRoot ?? (await mkdtemp(join(tmpdir(), 'agent-test-')))

  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const full = join(workspaceRoot, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }

  const model = new ScriptedModel(options.turns)
  const { runtime, loaded } = await createRuntime({
    model,
    config: {
      workspaceRoot,
      mode: options.mode,
      persist: options.persist ?? false,
      sessionId: options.sessionId,
      maxTurns: options.maxTurns ?? 20,
      rules: options.rules,
      verification: options.verification,
      context: options.context,
    },
    askHandler: options.askHandler,
    channels: options.channels,
    clock: fixedClock(),
    ids: createSequentialIds(),
  })

  return {
    workspaceRoot,
    runtime,
    model,
    loaded,
    cleanup: async () => {
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

export interface RunResult {
  events: AgentEvent[]
  facts: FactEvent[]
  terminal: TerminalReason
}

export async function collectRun(
  engine: AgentEngine,
  state: AgentState,
  signal?: AbortSignal,
): Promise<RunResult> {
  const controller = new AbortController()
  const events: AgentEvent[] = []
  const run = engine.run(state, signal ?? controller.signal)
  let step = await run.next()
  while (!step.done) {
    events.push(step.value)
    step = await run.next()
  }
  return {
    events,
    facts: events.filter(isFactEvent),
    terminal: step.value,
  }
}

/**
 * Build a state that already contains one user message. When the runtime
 * persists a journal, the message is also recorded as a user.message.accepted
 * fact so full replay and snapshot recovery see the same conversation.
 */
export async function stateWithUser(
  world: TestWorld,
  text: string,
): Promise<AgentState> {
  const state = world.runtime.makeInitialState()
  const message = world.runtime.makeUserMessage(text, null)
  if (world.runtime.journal) {
    await world.runtime.journal.append(
      { type: 'user.message.accepted', message },
      message.turnId,
      'flush',
    )
  }
  return { ...state, messages: [message] }
}

export function acceptedCallIds(result: RunResult): string[] {
  return result.facts
    .filter(f => f.type === 'tool.call.accepted')
    .map(f => (f.type === 'tool.call.accepted' ? f.call.id : ''))
}

export function completedCallIds(result: RunResult): string[] {
  return result.facts
    .filter(f => f.type === 'tool.call.completed')
    .map(f => (f.type === 'tool.call.completed' ? f.result.callId : ''))
}
