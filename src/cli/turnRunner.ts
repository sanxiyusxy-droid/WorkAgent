import type { AgentEngine } from '../core/AgentEngine.js'
import type { AgentEvent, TerminalReason } from '../core/events.js'
import { isFactEvent } from '../core/events.js'
import { reduce, type AgentState } from '../core/state.js'

export interface TurnOutcome {
  state: AgentState
  terminal: TerminalReason | undefined
}

/**
 * Drive one engine run while mirroring every fact through the shared pure
 * reducer. This is the CLI's ONLY state transition source: plans, replan
 * flags, evidence, workspace sets, compaction, budget and recovery counters
 * all stay true across turns. The previous hand-rolled half-reducer in the
 * CLI loop dropped most of that state between turns.
 *
 * `onEvent` observers (renderer, metrics) see events BEFORE they are folded
 * into state, exactly like the interactive loop.
 */
export async function driveTurn(
  engine: AgentEngine,
  initial: AgentState,
  signal: AbortSignal,
  onEvent?: (event: AgentEvent) => void,
): Promise<TurnOutcome> {
  let state = initial
  let terminal: TerminalReason | undefined
  const run = engine.run(state, signal)
  let step = await run.next()
  while (!step.done) {
    const event = step.value
    onEvent?.(event)
    if (isFactEvent(event)) {
      state = reduce(state, event)
      if (event.type === 'run.terminated') {
        terminal = event.terminal
      }
    }
    step = await run.next()
  }
  return { state, terminal }
}
