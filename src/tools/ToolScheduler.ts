import type { ToolCall } from '../core/messages.js'
import type { AgentEvent } from '../core/events.js'
import type { ResourceClaim, ToolDefinition } from './Tool.js'
import type { ToolRegistry } from './ToolRegistry.js'

export interface ScheduledCall {
  call: ToolCall
  /** run the call, returning its buffered events in emission order */
  run: () => Promise<AgentEvent[]>
}

function overlaps(a: string, b: string): boolean {
  if (a === b) return true
  if (a.endsWith('*') && b.startsWith(a.slice(0, -1))) return true
  if (b.endsWith('*') && a.startsWith(b.slice(0, -1))) return true
  // workspace:* overlaps any file:/process: claim
  if (a === 'workspace:*' || b === 'workspace:*') return true
  return false
}

export function conflicts(a: ResourceClaim[], b: ResourceClaim[]): boolean {
  return a.some(x =>
    b.some(
      y =>
        overlaps(x.resource, y.resource) &&
        (x.mode === 'write' || y.mode === 'write'),
    ),
  )
}

interface PreparedCall extends ScheduledCall {
  exclusive: boolean
  claims: ResourceClaim[]
}

/**
 * Concurrency rules (ADR-006):
 * - consecutive shared tools with non-conflicting resource claims run in parallel
 * - exclusive tools and resource conflicts form FIFO barriers
 * - execution completion order may vary, but terminal results are always
 *   replayed in the order calls were received — keeping history reproducible.
 */
export class ToolScheduler {
  constructor(private readonly registry: ToolRegistry) {}

  prepare(item: ScheduledCall, workspaceRoot: string): PreparedCall {
    const tool = this.registry.resolve(item.call.name) as
      | ToolDefinition<any, any>
      | undefined
    if (!tool) {
      // unknown tools are cheap error results; treat as shared, no claims
      return { ...item, exclusive: false, claims: [] }
    }
    const parsed = tool.inputSchema.safeParse(item.call.input)
    if (!parsed.success) {
      // schema failure produces an error result; no side effects, no claims
      return { ...item, exclusive: false, claims: [] }
    }
    try {
      const claims = tool.resources(parsed.data, {
        workspaceRoot,
      } as never)
      return {
        ...item,
        exclusive: tool.concurrency(parsed.data) === 'exclusive',
        claims,
      }
    } catch {
      // resource declaration failure: safest interpretation
      return {
        ...item,
        exclusive: true,
        claims: [{ resource: 'workspace:*', mode: 'write' }],
      }
    }
  }

  async *executeBatch(
    items: ScheduledCall[],
    workspaceRoot: string,
  ): AsyncGenerator<AgentEvent> {
    const prepared = items.map(item => this.prepare(item, workspaceRoot))

    // buffered events per call, keyed by received index
    const buffers = new Map<number, Promise<AgentEvent[]>>()
    let running: Array<{ index: number; claims: ResourceClaim[]; done: Promise<void> }> = []

    const drain = async () => {
      await Promise.all(running.map(r => r.done))
      running = []
    }

    for (let index = 0; index < prepared.length; index++) {
      const item = prepared[index]!
      const runningClaims = running.flatMap(r => r.claims)
      if (item.exclusive || conflicts(item.claims, runningClaims)) {
        await drain()
        const promise = item.run()
        buffers.set(index, promise)
        running.push({
          index,
          claims: item.claims,
          done: promise.then(() => undefined, () => undefined),
        })
        if (item.exclusive) {
          // exclusive call is its own barrier
          await drain()
        }
      } else {
        const promise = item.run()
        buffers.set(index, promise)
        running.push({
          index,
          claims: item.claims,
          done: promise.then(() => undefined, () => undefined),
        })
      }
    }
    await drain()

    // replay buffered events strictly in received order
    for (let index = 0; index < prepared.length; index++) {
      const events = await buffers.get(index)!
      for (const event of events) yield event
    }
  }
}
