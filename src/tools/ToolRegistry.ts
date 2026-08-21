import type { AgentMode } from '../core/events.js'
import type { ToolExecutionLane } from '../planning/ToolExecutionLane.js'
import { isToolAllowedByLane } from '../planning/ToolExecutionLane.js'
import type { ToolDefinition } from './Tool.js'

/** Tools visible to the model while in plan mode. Capability projection is
 * enforced here — not merely denied at the permission layer. */
const PLAN_ALLOWED_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'CodeSymbols',
  'FindReferences',
  'CallGraph',
  'CodeDiagnostics',
  'SearchCodeIndex',
  'ExpandCodeContext',
  'RefreshCodeIndex',
  'CodeIndexStatus',
  'ShellReadOnly',
  'AskUser',
  'PlanPropose',
  'ExitPlanMode',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
])

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any, any>>()

  register(tool: ToolDefinition<any, any>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  resolve(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name)
  }

  /** Stable, sorted, mode-projected tool list. Order stability protects
   * prompt caching and golden transcripts. When `writeLocked` is set (a
   * replan requiring re-approval is pending), the projection collapses to
   * the read-only + plan toolset — side-effecting tools disappear from the
   * model-facing schema, not just the runtime. */
  availableFor(
    mode: AgentMode,
    opts?: { writeLocked?: boolean; lane?: Readonly<ToolExecutionLane> },
  ): ToolDefinition<any, any>[] {
    const restricted = mode === 'plan' || opts?.writeLocked === true
    return [...this.tools.values()]
      .filter(t => (restricted ? PLAN_ALLOWED_TOOLS.has(t.name) : true))
      .filter(t => isToolAllowedByLane(opts?.lane, t.name))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Whether a registered tool is reachable in this mode. `resolve()` is
   * mode-agnostic on purpose (the runtime needs the definition to explain the
   * refusal), so callers must consult this before executing.
   */
  isAvailableIn(
    name: string,
    mode: AgentMode,
    opts?: { writeLocked?: boolean; lane?: Readonly<ToolExecutionLane> },
  ): boolean {
    if (!this.tools.has(name)) return false
    const restricted = mode === 'plan' || opts?.writeLocked === true
    if (restricted && !PLAN_ALLOWED_TOOLS.has(name)) return false
    return isToolAllowedByLane(opts?.lane, name)
  }

  names(): string[] {
    return [...this.tools.keys()].sort()
  }
}
