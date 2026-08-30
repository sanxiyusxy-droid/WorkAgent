import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { describe, expect, test } from 'vitest'
import { defineTool } from '../src/tools/Tool.js'
import { loadSession } from '../src/session/SessionLoader.js'
import { resumeState } from '../src/app/createRuntime.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { collectRun, makeWorld, stateWithUser } from './helpers.js'
import { findStaleReceipts } from '../src/verification/freshness.js'
import { MISSING_FILE_VERSION } from '../src/workspace/FileVersion.js'

const PathInput = z.object({ path: z.string().min(1) }).strict()

describe('durable workspace verification obligations', () => {
  test('the obligation is flushed before execute and survives a kill-point recovery', async () => {
    let executeRan = false
    const Probe = defineTool({
      name: 'PrecommitProbe',
      description: 'test-only workspace mutation probe',
      inputSchema: PathInput,
      readOnly: () => false,
      resources: (input, ctx) => [{
        resource: `file:${join(ctx.workspaceRoot, input.path)}`,
        mode: 'write' as const,
      }],
      workspaceMutation: input => ({ scope: 'paths', paths: [input.path] }),
      permission: async () => ({ behavior: 'allow' }),
      execute: async input => {
        executeRan = true
        return { data: input }
      },
    })
    const world = await makeWorld({
      persist: true,
      sessionId: 'precommit-kill-point',
      mode: 'bypassPermissions',
      turns: [],
    })
    try {
      world.runtime.registry.register(Probe)
      const generator = world.runtime.toolRuntime.executeOne({
        call: {
          id: 'probe_1', name: 'PrecommitProbe', input: { path: 'out.txt' },
          parentMessageId: 'm', receivedIndex: 0,
        },
        mode: 'bypassPermissions',
        sessionId: world.runtime.sessionId,
        turnId: 'turn_precommit',
        workspaceRoot: world.workspaceRoot,
        artifactDir: world.runtime.artifactDir,
        signal: new AbortController().signal,
      })
      let step = await generator.next()
      while (!step.done && step.value.type !== 'workspace.mutation.started') {
        step = await generator.next()
      }
      expect(step.done).toBe(false)
      expect(step.value).toMatchObject({
        type: 'workspace.mutation.started',
        callId: 'probe_1',
        durableBeforeExecution: true,
      })
      expect(executeRan).toBe(false)
      await generator.return(undefined)

      const journalText = await readFile(world.runtime.journalPath, 'utf8')
      expect(journalText).toContain('"type":"workspace.mutation.started"')

      const loaded = await loadSession(world.runtime.journalPath)
      const resumedWorld = await makeWorld({
        persist: true,
        sessionId: 'precommit-kill-point',
        workspaceRoot: world.workspaceRoot,
        mode: 'bypassPermissions',
        turns: [],
      })
      try {
        const resumed = await resumeState(resumedWorld.runtime, loaded)
        expect(resumed.replayFailure).toBeNull()
        expect(resumed.state.workspace.revision).toBe(1)
        expect(resumed.state.workspace.pendingVerification).toMatchObject({
          scope: 'paths',
          changedPaths: ['out.txt'],
          sources: [{ callId: 'probe_1', outcome: 'unknown' }],
        })
        expect(resumedWorld.runtime.evidence.workspaceRevision).toBe(1)
      } finally {
        await resumedWorld.cleanup()
      }
    } finally {
      await world.cleanup()
    }
  })

  test('postcondition failure after a real change remains blocked', async () => {
    const PostFail = defineTool({
      name: 'PostFailWrite',
      description: 'test-only failing write',
      inputSchema: PathInput,
      readOnly: () => false,
      resources: () => [{ resource: 'workspace:*', mode: 'write' as const }],
      workspaceMutation: input => ({ scope: 'paths', paths: [input.path] }),
      permission: async () => ({ behavior: 'allow' }),
      execute: async (input, ctx) => {
        await writeFile(join(ctx.workspaceRoot, input.path), 'changed', 'utf8')
        return {
          data: input,
          facts: [{
            type: 'workspace.changed' as const,
            path: input.path,
            change: 'created' as const,
          }],
        }
      },
      postconditions: async () => [{ id: 'forced-failure', passed: false }],
    })
    const world = await makeWorld({
      mode: 'bypassPermissions',
      turns: [
        toolCallTurn([{
          id: 'post_fail', name: 'PostFailWrite', input: { path: 'out.txt' },
        }]),
        textTurn('done'),
        textTurn('cannot verify'),
      ],
    })
    try {
      world.runtime.registry.register(PostFail)
      const run = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write with a failing postcondition'),
      )
      expect(run.facts).toContainEqual(expect.objectContaining({
        type: 'workspace.mutation.started', callId: 'post_fail',
      }))
      expect(run.facts).toContainEqual(expect.objectContaining({
        type: 'workspace.changed', callId: 'post_fail',
      }))
      expect(run.facts).toContainEqual(expect.objectContaining({
        type: 'tool.call.completed',
        result: expect.objectContaining({
          callId: 'post_fail', ok: false, errorCode: 'POSTCONDITION_FAILED',
        }),
      }))
      expect(run.terminal).toMatchObject({
        reason: 'completed_with_unverified_items',
        items: [expect.stringContaining('PostFailWrite:post_fail(changed)')],
      })
    } finally {
      await world.cleanup()
    }
  })

  test('execute throw after a partial write retains an unknown obligation', async () => {
    const ThrowAfterWrite = defineTool({
      name: 'ThrowAfterWrite',
      description: 'test-only partial write',
      inputSchema: PathInput,
      readOnly: () => false,
      resources: () => [{ resource: 'workspace:*', mode: 'write' as const }],
      workspaceMutation: input => ({ scope: 'paths', paths: [input.path] }),
      permission: async () => ({ behavior: 'allow' }),
      execute: async (input, ctx) => {
        await writeFile(join(ctx.workspaceRoot, input.path), 'partial', 'utf8')
        throw new Error('crashed after write')
      },
    })
    const world = await makeWorld({
      mode: 'bypassPermissions',
      turns: [
        toolCallTurn([{
          id: 'throw_write', name: 'ThrowAfterWrite', input: { path: 'partial.txt' },
        }]),
        textTurn('done'),
        textTurn('cannot verify'),
      ],
    })
    try {
      world.runtime.registry.register(ThrowAfterWrite)
      const run = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'perform a partial write'),
      )
      await expect(
        readFile(join(world.workspaceRoot, 'partial.txt'), 'utf8'),
      ).resolves.toBe('partial')
      expect(run.facts).not.toContainEqual(expect.objectContaining({
        type: 'workspace.changed', callId: 'throw_write',
      }))
      expect(run.terminal).toMatchObject({
        reason: 'completed_with_unverified_items',
        items: [expect.stringContaining('ThrowAfterWrite:throw_write(unknown)')],
      })
    } finally {
      await world.cleanup()
    }
  })

  test('a non-readonly Shell command opens workspace-wide unknown scope', async () => {
    const world = await makeWorld({
      mode: 'acceptEdits',
      askHandler: async () => 'allow',
      files: {
        'mutate.js': "require('node:fs').writeFileSync('shell-output.txt','changed')",
      },
      turns: [
        toolCallTurn([{
          id: 'shell_write', name: 'Shell', input: { command: 'node mutate.js' },
        }]),
        textTurn('done'),
        textTurn('cannot verify'),
      ],
    })
    try {
      const run = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'change a file through Shell'),
      )
      await expect(
        readFile(join(world.workspaceRoot, 'shell-output.txt'), 'utf8'),
      ).resolves.toBe('changed')
      expect(run.facts).toContainEqual(expect.objectContaining({
        type: 'workspace.mutation.started',
        callId: 'shell_write', scope: 'workspace',
      }))
      expect(run.terminal).toMatchObject({
        reason: 'completed_with_unverified_items',
        items: [expect.stringContaining('whole workspace')],
      })
    } finally {
      await world.cleanup()
    }
  })

  test('a readOnly declaration cannot override an explicit file write resource or forge precommit', async () => {
    const ContradictoryTool = defineTool({
      name: 'ContradictoryWrite',
      description: 'test-only contradictory workspace writer',
      inputSchema: PathInput,
      readOnly: () => true,
      resources: (input, ctx) => [{
        resource: `file:${join(ctx.workspaceRoot, input.path)}`,
        mode: 'write' as const,
      }],
      permission: async () => ({ behavior: 'allow' }),
      execute: async (input, ctx) => {
        await writeFile(join(ctx.workspaceRoot, input.path), 'changed', 'utf8')
        return {
          data: input,
          facts: [{
            type: 'workspace.mutation.started' as const,
            mutationId: 'forged',
            callId: 'forged-call',
            toolName: 'forged-tool',
            scope: 'paths' as const,
            paths: ['forged.txt'],
            reason: 'tool output cannot precommit after execution',
            durableBeforeExecution: true,
          }],
        }
      },
    })
    const world = await makeWorld({
      mode: 'bypassPermissions',
      turns: [
        toolCallTurn([{
          id: 'contradictory', name: 'ContradictoryWrite', input: { path: 'out.txt' },
        }]),
        textTurn('done'),
        textTurn('cannot verify'),
      ],
    })
    try {
      world.runtime.registry.register(ContradictoryTool)
      const run = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'run the contradictory tool'),
      )
      await expect(readFile(join(world.workspaceRoot, 'out.txt'), 'utf8'))
        .resolves.toBe('changed')
      const mutations = run.facts.filter(
        fact => fact.type === 'workspace.mutation.started',
      )
      expect(mutations).toHaveLength(1)
      expect(mutations[0]).toMatchObject({
        callId: 'contradictory', toolName: 'ContradictoryWrite', scope: 'workspace',
      })
      expect(run.terminal.reason).toBe('completed_with_unverified_items')
    } finally {
      await world.cleanup()
    }
  })

  test('an unbound FileAssert closes a mutation obligation without forging plan evidence', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      turns: [
        toolCallTurn([{
          id: 'write_1', name: 'Write',
          input: { path: 'out.txt', content: 'verified value', overwrite: true },
        }]),
        toolCallTurn([{
          id: 'assert_1', name: 'FileAssert',
          input: {
            path: 'out.txt',
            criterionIds: [],
            expected: { contains: ['verified value'] },
          },
        }]),
        textTurn('written and verified'),
      ],
    })
    try {
      const run = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write and verify out.txt'),
      )
      expect(run.terminal).toEqual({ reason: 'completed' })
      const receipt = world.runtime.evidence.list().find(
        item => item.invocation.tool === 'FileAssert',
      )
      expect(receipt).toMatchObject({
        kind: 'file_assertion',
        status: 'passed',
        criterionIds: [],
        workspaceRevision: 1,
      })
    } finally {
      await world.cleanup()
    }
  })

  test('a deleted path can be verified as missing and becomes stale if it reappears', async () => {
    const DeletePath = defineTool({
      name: 'DeletePath',
      description: 'test-only path deletion',
      inputSchema: PathInput,
      readOnly: () => false,
      resources: (input, ctx) => [{
        resource: `file:${join(ctx.workspaceRoot, input.path)}`,
        mode: 'write' as const,
      }],
      workspaceMutation: input => ({ scope: 'paths', paths: [input.path] }),
      permission: async () => ({ behavior: 'allow' }),
      execute: async (input, ctx) => {
        await unlink(join(ctx.workspaceRoot, input.path))
        return {
          data: input,
          facts: [{
            type: 'workspace.changed' as const,
            path: input.path,
            change: 'deleted' as const,
          }],
        }
      },
    })
    const world = await makeWorld({
      mode: 'bypassPermissions',
      files: {
        'gone.txt': 'remove me',
        'verify.test.js': [
          "const test = require('node:test')",
          "const assert = require('node:assert/strict')",
          "const { existsSync } = require('node:fs')",
          "test('gone', () => assert.equal(existsSync('gone.txt'), false))",
        ].join('\n'),
      },
      turns: [
        toolCallTurn([{
          id: 'delete_1', name: 'DeletePath', input: { path: 'gone.txt' },
        }]),
        toolCallTurn([{
          id: 'verify_delete', name: 'Shell',
          input: {
            command: 'node --test verify.test.js',
            evidenceKind: 'test',
            evidenceFiles: ['gone.txt'],
          },
        }]),
        textTurn('deleted and verified'),
      ],
    })
    try {
      world.runtime.registry.register(DeletePath)
      const run = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'delete gone.txt and verify it is absent'),
      )
      expect(run.terminal.reason).toBe('completed')
      const receipt = world.runtime.evidence.list().find(
        item => item.invocation.tool === 'Shell',
      )!
      const deletedPath = join(world.workspaceRoot, 'gone.txt')
      expect(receipt.fileVersions?.[deletedPath]).toBe(MISSING_FILE_VERSION)

      // Auto-capture uses the same signed absence marker for changed paths.
      const auto = await world.runtime.evidence.record({
        kind: 'test', status: 'passed',
        invocation: { tool: 'runtime-test', normalizedInput: {} },
        observation: { exitCode: 0, outputPreview: 'absent' },
        startedAt: 't',
      })
      expect(auto.fileVersions?.[deletedPath]).toBe(MISSING_FILE_VERSION)
      expect((await findStaleReceipts(world.runtime.evidence)).has(receipt.id)).toBe(false)

      await writeFile(deletedPath, 'reappeared', 'utf8')
      const stale = await findStaleReceipts(world.runtime.evidence)
      expect(stale.has(receipt.id)).toBe(true)
      expect(stale.has(auto.id)).toBe(true)
    } finally {
      await world.cleanup()
    }
  })
})
