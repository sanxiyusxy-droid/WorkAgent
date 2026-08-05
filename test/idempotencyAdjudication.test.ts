import { describe, expect, test } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeWorld, collectRun, stateWithUser } from './helpers.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { IdempotencyLedger } from '../src/tools/IdempotencyLedger.js'
import { WriteTool } from '../src/tools/builtin/WriteTool.js'
import { computeVersion } from '../src/workspace/FileVersion.js'

/**
 * Idempotency business semantics (finish-list §1.4):
 * - Shell dedupes only the crash-recovery replay of the SAME call
 *   (invocation scope); repeating a command after file changes is legal
 * - a committed proof that no longer holds re-opens the operation
 * - UNKNOWN outcomes are adjudicated via inspectOutcome, not left to the
 *   model to guess
 * - deduplicated successes never feed failure-driven Replan
 */

const NODE = JSON.stringify(process.execPath)

describe('idempotency business semantics', () => {
  test('Shell invocation scope: the same command runs again at a later stage', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      files: {
        'append.js': `require('fs').appendFileSync('runs.txt', 'ran\\n')`,
      },
      turns: [
        toolCallTurn([{ id: 's1', name: 'Shell', input: { command: `${NODE} append.js` } }]),
        // same command, fresh callId, later execution stage: must run again
        toolCallTurn([{ id: 's2', name: 'Shell', input: { command: `${NODE} append.js` } }]),
        textTurn('done'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'run the script twice'),
      )
      for (const callId of ['s1', 's2']) {
        const completion = result.facts.find(
          f => f.type === 'tool.call.completed' && f.result.callId === callId,
        )
        expect(completion).toMatchObject({ result: { ok: true } })
      }
      // the second run was NOT deduplicated away
      expect(
        result.facts.some(f => f.type === 'tool.call.completed' && !f.result.ok),
      ).toBe(false)
      const runs = await readFile(join(world.workspaceRoot, 'runs.txt'), 'utf8')
      expect(runs).toBe('ran\nran\n')
    } finally {
      await world.cleanup()
    }
  })

  test('invalidated proof: a file edited back externally re-opens the operation', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      turns: [
        toolCallTurn([
          { id: 'w1', name: 'Write', input: { path: 'out.txt', content: 'v1', overwrite: true } },
        ]),
        textTurn('done'),
      ],
    })
    try {
      // seed the ledger: this exact operation was committed previously...
      const parsed = WriteTool.inputSchema.parse({
        path: 'out.txt',
        content: 'v1',
        overwrite: true,
      })
      const opKey = IdempotencyLedger.computeOperationKey({
        sessionId: world.runtime.sessionId,
        toolName: 'Write',
        args: parsed,
      })
      const ledger = world.runtime.toolRuntime.idempotency
      ledger.markRunning(opKey, 'old_call', 'Write', '2026-01-01T00:00:00Z')
      ledger.markCommitted(opKey, computeVersion('v1'), '2026-01-01T00:00:01Z')
      await ledger.flush()
      // ...but the file was externally changed back afterwards
      await writeFile(join(world.workspaceRoot, 'out.txt'), 'external', 'utf8')

      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write it'),
      )
      const completion = result.facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'w1',
      )
      expect(completion).toMatchObject({ result: { ok: true } })
      // the stale record was adjudicated and the effect re-applied
      expect(result.facts).toContainEqual(
        expect.objectContaining({
          type: 'idempotency.adjudicated',
          toolName: 'Write',
          from: 'committed',
          to: 'resolved_not_applied',
        }),
      )
      expect(ledger.getStatus(opKey)).toBe('committed')
      await expect(
        readFile(join(world.workspaceRoot, 'out.txt'), 'utf8'),
      ).resolves.toBe('v1')
    } finally {
      await world.cleanup()
    }
  })

  test('UNKNOWN outcome with the effect present: adjudicated applied, safe deduplicated success', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      turns: [
        toolCallTurn([
          { id: 'w1', name: 'Write', input: { path: 'u.txt', content: 'maybe', overwrite: true } },
        ]),
        textTurn('done'),
      ],
    })
    try {
      // interrupted mid side effect: ledger says unknown, file did land
      const parsed = WriteTool.inputSchema.parse({
        path: 'u.txt',
        content: 'maybe',
        overwrite: true,
      })
      const opKey = IdempotencyLedger.computeOperationKey({
        sessionId: world.runtime.sessionId,
        toolName: 'Write',
        args: parsed,
      })
      const ledger = world.runtime.toolRuntime.idempotency
      ledger.markRunning(opKey, 'old_call', 'Write', '2026-01-01T00:00:00Z')
      ledger.markUnknown(opKey, '2026-01-01T00:00:01Z')
      await ledger.flush()
      await writeFile(join(world.workspaceRoot, 'u.txt'), 'maybe', 'utf8')

      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write it'),
      )
      const completion = result.facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'w1',
      )
      expect(completion).toBeDefined()
      if (completion!.type === 'tool.call.completed') {
        expect(completion!.result.ok).toBe(true)
        expect(JSON.stringify(completion!.result.content)).toContain('deduplicated')
      }
      expect(result.facts).toContainEqual(
        expect.objectContaining({
          type: 'idempotency.adjudicated',
          from: 'unknown',
          to: 'resolved_applied',
        }),
      )
      expect(ledger.getStatus(opKey)).toBe('resolved_applied')
      await expect(
        readFile(join(world.workspaceRoot, 'u.txt'), 'utf8'),
      ).resolves.toBe('maybe')
    } finally {
      await world.cleanup()
    }
  })

  test('deduplicated success never feeds failure-driven Replan', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      // the write is already committed on disk and in the ledger → the call
      // dedupes. Two preceding failures put the run one event away from the
      // consecutive-failure replan threshold: if the dedup counted as a
      // failure, a replan would fire here.
      files: { 'out.txt': 'v' },
      turns: [
        toolCallTurn([{ id: 'r1', name: 'Read', input: { path: 'missing-1.txt' } }]),
        toolCallTurn([{ id: 'r2', name: 'Read', input: { path: 'missing-2.txt' } }]),
        toolCallTurn([
          { id: 'w1', name: 'Write', input: { path: 'out.txt', content: 'v', overwrite: true } },
        ]),
        textTurn('done'),
      ],
    })
    try {
      const parsed = WriteTool.inputSchema.parse({
        path: 'out.txt',
        content: 'v',
        overwrite: true,
      })
      const opKey = IdempotencyLedger.computeOperationKey({
        sessionId: world.runtime.sessionId,
        toolName: 'Write',
        args: parsed,
      })
      const ledger = world.runtime.toolRuntime.idempotency
      ledger.markRunning(opKey, 'old_call', 'Write', '2026-01-01T00:00:00Z')
      ledger.markCommitted(opKey, computeVersion('v'), '2026-01-01T00:00:01Z')
      await ledger.flush()

      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'work'),
      )
      const dedup = result.facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 'w1',
      )
      expect(dedup).toMatchObject({ result: { ok: true } })
      // ok:true kept the failure counter from reaching the threshold
      expect(result.facts.some(f => f.type === 'replan.requested')).toBe(false)
      expect(result.terminal.reason).toBe('completed')
    } finally {
      await world.cleanup()
    }
  })
})
