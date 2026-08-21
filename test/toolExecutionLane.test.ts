import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import type { PlanHealthAssessment, SupervisorAction } from '../src/core/events.js'
import { defineTool } from '../src/tools/Tool.js'
import { ToolRegistry } from '../src/tools/ToolRegistry.js'
import { ToolRuntime } from '../src/tools/ToolRuntime.js'
import { ToolOutputStore } from '../src/tools/ToolOutputStore.js'
import { PolicyEngine } from '../src/policy/PolicyEngine.js'
import {
  buildToolExecutionLane,
  renderToolExecutionLane,
} from '../src/planning/ToolExecutionLane.js'
import { fixedClock, makeWorld, collectRun, stateWithUser } from './helpers.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ALL_TOOLS = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Shell', 'ShellReadOnly',
  'ApplyPatch', 'AskUser', 'FileAssert', 'DiffAssert', 'ManualVerify',
  'CodeSymbols', 'FindReferences', 'CallGraph', 'CodeDiagnostics',
  'SearchCodeIndex', 'ExpandCodeContext', 'RefreshCodeIndex',
  'CodeIndexStatus', 'EnterPlanMode', 'PlanPropose', 'PlanRepair',
  'ExitPlanMode', 'TaskCreate', 'TaskUpdate', 'TaskList',
]

describe('v1.7 supervisor tool execution lanes', () => {
  test.each([
    ['gather_evidence', ['Shell', 'FileAssert'], ['Write', 'Edit']],
    ['run_verification', ['Read', 'Shell'], ['Write', 'ApplyPatch', 'TaskUpdate']],
    ['repair_plan', ['PlanRepair', 'PlanPropose'], ['Write', 'Shell']],
    ['request_reapproval', ['PlanPropose', 'ExitPlanMode'], ['Write', 'PlanRepair', 'TaskCreate']],
    ['finish', ['Read', 'TaskList'], ['Write', 'Shell']],
  ] as const)('%s projects a stable bounded capability set', (action, include, exclude) => {
    const first = lane(action)
    const reordered = buildToolExecutionLane({
      assessment: assessment(action),
      mode: 'bypassPermissions',
      writeLocked: false,
      candidateTools: [...ALL_TOOLS].reverse(),
    })!
    expect(first.hash).toBe(reordered.hash)
    expect(first.allowedTools).toEqual(reordered.allowedTools)
    expect(first.allowedTools).toEqual([...first.allowedTools].sort())
    for (const name of include) expect(first.allowedTools).toContain(name)
    for (const name of exclude) expect(first.allowedTools).not.toContain(name)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.allowedTools)).toBe(true)
    expect(renderToolExecutionLane(first)).toContain(first.hash)
  })

  test('open actions preserve the underlying candidate tools and no-plan state creates no lane', () => {
    expect(lane('continue_step').allowedTools).toEqual([...ALL_TOOLS].sort())
    expect(lane('resolve_blocker').allowedTools).toEqual([...ALL_TOOLS].sort())
    expect(buildToolExecutionLane({
      assessment: { ...assessment('continue_step'), status: 'not_applicable' },
      mode: 'default',
      writeLocked: false,
      candidateTools: ALL_TOOLS,
    })).toBeUndefined()
  })

  test('unknown future supervisor actions fail closed instead of reopening all tools', () => {
    const corrupted = {
      ...assessment('finish'),
      decision: {
        ...assessment('finish').decision,
        action: 'future_unrecognized_action',
      },
    } as unknown as PlanHealthAssessment
    expect(() => buildToolExecutionLane({
      assessment: corrupted,
      mode: 'bypassPermissions',
      writeLocked: false,
      candidateTools: ALL_TOOLS,
    })).toThrow(/unknown supervisor action/i)
  })

  test('mode and write-lock projection intersect with, and cannot be expanded by, an action lane', () => {
    const registry = registryWithNames(ALL_TOOLS)
    const candidates = registry.availableFor('default', { writeLocked: true }).map(tool => tool.name)
    const projection = buildToolExecutionLane({
      assessment: assessment('request_reapproval'),
      mode: 'default',
      writeLocked: true,
      candidateTools: candidates,
    })!
    const visible = registry.availableFor('default', {
      writeLocked: true,
      lane: projection,
    }).map(tool => tool.name)
    expect(visible).toContain('PlanPropose')
    expect(visible).toContain('ExitPlanMode')
    expect(visible).not.toContain('Write')
    expect(visible).not.toContain('Shell')
  })

  test('runtime refuses a forged hidden call before permission or execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lane-runtime-'))
    try {
      const execute = vi.fn(async () => ({ data: { ok: true } }))
      const readExecute = vi.fn(async () => ({ data: { ok: true } }))
      const permission = vi.fn(async () => ({ behavior: 'allow' as const }))
      let liveWriteLocked = false
      const registry = new ToolRegistry()
      registry.register(defineTool({
        name: 'Write',
        description: 'probe',
        inputSchema: z.object({}).strict(),
        permission,
        execute,
      }))
      registry.register(defineTool({
        name: 'Read',
        description: 'probe',
        inputSchema: z.object({}).strict(),
        readOnly: () => true,
        permission: async () => ({ behavior: 'allow' }),
        execute: readExecute,
      }))
      const clock = fixedClock()
      const ids = createSequentialIds()
      const runtime = new ToolRuntime({
        registry,
        policy: new PolicyEngine({ clock, ids, rules: [] }),
        outputStore: new ToolOutputStore(root),
        artifactDir: root,
        clock,
        ids,
        writeLock: () => liveWriteLocked,
      })
      const projection = buildToolExecutionLane({
        assessment: assessment('finish'),
        mode: 'bypassPermissions',
        writeLocked: false,
        candidateTools: ['Read', 'Write'],
      })!
      const incompleteAuditProjection = {
        ...projection,
        allowedTools: ['Read'],
        blockedTools: [],
      }
      const events = []
      for await (const event of runtime.executeOne({
        call: { id: 'forged', name: 'Write', input: {}, parentMessageId: 'm', receivedIndex: 0 },
        mode: 'bypassPermissions',
        sessionId: 's',
        workspaceRoot: root,
        artifactDir: root,
        signal: new AbortController().signal,
        lane: incompleteAuditProjection,
      })) events.push(event)
      const completed = events.find(event => event.type === 'tool.call.completed')
      expect(completed).toMatchObject({
        result: { ok: false, errorCode: 'TOOL_NOT_AVAILABLE_FOR_ACTION' },
      })
      expect(permission).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()

      // The frozen request said unlocked, but the live lock changed before
      // execution. The final TOCTOU guard still blocks side effects after
      // permission, while read-only tools remain usable.
      liveWriteLocked = true
      const liveLockedEvents = []
      for await (const event of runtime.executeOne({
        call: { id: 'live_locked', name: 'Write', input: {}, parentMessageId: 'm', receivedIndex: 0 },
        mode: 'bypassPermissions',
        sessionId: 's',
        workspaceRoot: root,
        artifactDir: root,
        signal: new AbortController().signal,
        writeLocked: false,
      })) liveLockedEvents.push(event)
      expect(liveLockedEvents.find(event => event.type === 'tool.call.completed')).toMatchObject({
        result: { ok: false, errorCode: 'REPLAN_APPROVAL_PENDING' },
      })
      expect(permission).toHaveBeenCalledOnce()
      expect(execute).not.toHaveBeenCalled()

      for await (const _event of runtime.executeOne({
        call: { id: 'live_read', name: 'Read', input: {}, parentMessageId: 'm', receivedIndex: 0 },
        mode: 'bypassPermissions', sessionId: 's', workspaceRoot: root,
        artifactDir: root, signal: new AbortController().signal,
        writeLocked: false,
      })) { /* drain */ }
      expect(readExecute).toHaveBeenCalledOnce()

      const lockedEvents = []
      for await (const event of runtime.executeOne({
        call: { id: 'locked', name: 'Write', input: {}, parentMessageId: 'm', receivedIndex: 0 },
        mode: 'bypassPermissions',
        sessionId: 's',
        workspaceRoot: root,
        artifactDir: root,
        signal: new AbortController().signal,
        writeLocked: true,
      })) lockedEvents.push(event)
      expect(lockedEvents.find(event => event.type === 'tool.call.completed')).toMatchObject({
        result: { ok: false, errorCode: 'REPLAN_APPROVAL_PENDING' },
      })
      expect(permission).toHaveBeenCalledOnce()
      expect(execute).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('evidence lanes require criterion-bound Shell input before permission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lane-shell-'))
    try {
      const shellPermission = vi.fn(async () => ({ behavior: 'allow' as const }))
      const shellExecute = vi.fn(async () => ({ data: { ok: true } }))
      const readonlyExecute = vi.fn(async () => ({ data: { ok: true } }))
      const registry = new ToolRegistry()
      registry.register(defineTool({
        name: 'Shell',
        description: 'probe',
        inputSchema: z.object({ criterionIds: z.array(z.string()).optional() }).strict(),
        permission: shellPermission,
        execute: shellExecute,
      }))
      registry.register(defineTool({
        name: 'ShellReadOnly',
        description: 'probe',
        inputSchema: z.object({}).strict(),
        readOnly: () => true,
        permission: async () => ({ behavior: 'allow' }),
        execute: readonlyExecute,
      }))
      const clock = fixedClock()
      const ids = createSequentialIds()
      const runtime = new ToolRuntime({
        registry,
        policy: new PolicyEngine({ clock, ids, rules: [] }),
        outputStore: new ToolOutputStore(root),
        artifactDir: root,
        clock,
        ids,
      })
      const projections = (['gather_evidence', 'run_verification'] as const).map(action =>
        buildToolExecutionLane({
          assessment: assessment(action),
          mode: 'bypassPermissions',
          writeLocked: false,
          candidateTools: ['Shell', 'ShellReadOnly'],
        })!,
      )
      const invalidInputs = [
        {},
        { criterionIds: [] },
        { criterionIds: [''] },
        { criterionIds: ['   '] },
      ]
      let invalidIndex = 0
      for (const projection of projections) {
        expect(renderToolExecutionLane(projection)).toContain('criterionIds')
        for (const input of invalidInputs) {
          const unbound = []
          for await (const event of runtime.executeOne({
            call: {
              id: `unbound_${invalidIndex++}`,
              name: 'Shell', input, parentMessageId: 'm', receivedIndex: 0,
            },
            mode: 'bypassPermissions', sessionId: 's', workspaceRoot: root,
            artifactDir: root, signal: new AbortController().signal, lane: projection,
          })) unbound.push(event)
          expect(unbound.find(event => event.type === 'tool.call.completed')).toMatchObject({
            result: { ok: false, errorCode: 'TOOL_NOT_AVAILABLE_FOR_ACTION' },
          })
        }
      }
      expect(shellPermission).not.toHaveBeenCalled()
      expect(shellExecute).not.toHaveBeenCalled()

      const projection = projections[0]!

      for await (const _event of runtime.executeOne({
        call: {
          id: 'bound', name: 'Shell', input: { criterionIds: ['ac_test'] },
          parentMessageId: 'm', receivedIndex: 0,
        },
        mode: 'bypassPermissions', sessionId: 's', workspaceRoot: root,
        artifactDir: root, signal: new AbortController().signal, lane: projection,
      })) { /* drain */ }
      expect(shellPermission).toHaveBeenCalledOnce()
      expect(shellExecute).toHaveBeenCalledOnce()

      for await (const _event of runtime.executeOne({
        call: { id: 'inspect', name: 'ShellReadOnly', input: {}, parentMessageId: 'm', receivedIndex: 0 },
        mode: 'bypassPermissions', sessionId: 's', workspaceRoot: root,
        artifactDir: root, signal: new AbortController().signal, lane: projection,
      })) { /* drain */ }
      expect(readonlyExecute).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('engine freezes one projection for provider schemas and the following batch', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      files: { 'blocked.txt': 'unchanged' },
      turns: [
        toolCallTurn([{
          id: 'create_task',
          name: 'TaskCreate',
          input: { subject: 'prepare', activeForm: 'preparing' },
        }]),
        toolCallTurn([{
          id: 'block_task',
          name: 'TaskUpdate',
          input: {
            id: 'task_1',
            expectedRevision: 1,
            status: 'blocked',
            blockedReason: 'need one observation',
          },
        }]),
        toolCallTurn([{
          id: 'fail_task',
          name: 'TaskUpdate',
          input: {
            id: 'task_1', expectedRevision: 2,
            status: 'failed', blockedReason: 'need one observation',
          },
        }]),
        toolCallTurn([{
          id: 'forged_write',
          name: 'Write',
          input: { path: 'blocked.txt', content: 'changed', overwrite: true },
        }]),
        toolCallTurn([{
          id: 'reset_task',
          name: 'TaskUpdate',
          input: {
            id: 'task_1', expectedRevision: 3,
            status: 'pending', blockedReason: '',
          },
        }]),
        toolCallTurn([{
          id: 'start_task',
          name: 'TaskUpdate',
          input: { id: 'task_1', expectedRevision: 4, status: 'in_progress' },
        }]),
        toolCallTurn([{
          id: 'complete_task',
          name: 'TaskUpdate',
          input: { id: 'task_1', expectedRevision: 5, status: 'completed' },
        }]),
        textTurn('Stopped and repaired the plan contract.'),
      ],
      intelligence: { enabled: true, reflectionInterval: 99 },
    })
    try {
      const result = await collectRun(world.runtime.engine, await stateWithUser(world, 'work'))
      expect(result.facts.find(
        fact => fact.type === 'tool.call.completed' && fact.result.callId === 'forged_write',
      )).toMatchObject({
        result: { errorCode: 'TOOL_NOT_AVAILABLE_FOR_ACTION' },
      })
      expect(world.model.requests[3]!.tools.map(tool => tool.name)).not.toContain('Write')
      const laneFact = result.facts.find(
        fact => fact.type === 'tool.lane.selected' && fact.selection.action === 'repair_plan',
      )
      expect(laneFact).toBeDefined()
      if (laneFact?.type === 'tool.lane.selected') {
        expect(world.model.requests[3]!.system).toContain(laneFact.selection.hash)
        expect(world.model.requests[3]!.tools.map(tool => tool.name).sort()).toEqual(
          [...laneFact.selection.allowedTools].sort(),
        )
      }
    } finally {
      await world.cleanup()
    }
  })
})

function assessment(action: SupervisorAction): PlanHealthAssessment {
  return {
    id: 'health_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'attention',
    score: 70,
    signature: `sig_${action}`,
    metrics: {
      totalTasks: 1, completedTasks: 0, openTasks: 1, blockedTasks: 0,
      failedTasks: 0, readyTasks: 1, requiredCriteria: 0, coveredCriteria: 0,
      scopeDriftFiles: 0, budgetRemainingRatio: 1, consecutiveFailures: 0,
      stagnationSignals: 0, ineffectiveReflections: 0,
    },
    findings: [],
    decision: { action, rationale: 'test', successSignals: ['progress'] },
  }
}

function lane(action: SupervisorAction) {
  return buildToolExecutionLane({
    assessment: assessment(action),
    mode: 'bypassPermissions',
    writeLocked: false,
    candidateTools: ALL_TOOLS,
  })!
}

function registryWithNames(names: string[]): ToolRegistry {
  const registry = new ToolRegistry()
  for (const name of names) {
    registry.register(defineTool({
      name,
      description: name,
      inputSchema: z.object({}).strict(),
      execute: async () => ({ data: {} }),
    }))
  }
  return registry
}
