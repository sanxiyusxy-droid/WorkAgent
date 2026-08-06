import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AgentEvent } from '../src/core/events.js'
import type { AcceptanceCriterion } from '../src/planning/types.js'
import { requiredCriteriaWithoutEvidence } from '../src/planning/completionGate.js'
import { findStaleReceipts } from '../src/verification/freshness.js'
import { makeWorld, type TestWorld } from './helpers.js'

const execFileAsync = promisify(execFile)

async function approveCriteria(
  world: TestWorld,
  criteria: AcceptanceCriterion[],
): Promise<void> {
  const plan = await world.runtime.plans.createVersion({
    goal: 'verify evidence tools',
    acceptanceCriteria: criteria,
  })
  world.runtime.plans.markAwaitingApproval(plan.planId, plan.version)
  world.runtime.plans.markApproved(plan.planId, plan.version, 'approval_test')
}

async function runTool(
  world: TestWorld,
  callId: string,
  name: string,
  input: unknown,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of world.runtime.toolRuntime.executeOne({
    call: {
      id: callId,
      name,
      input,
      parentMessageId: 'assistant_1',
      receivedIndex: 0,
    },
    mode: 'default',
    sessionId: world.runtime.sessionId,
    workspaceRoot: world.workspaceRoot,
    artifactDir: world.runtime.artifactDir,
    signal: new AbortController().signal,
  })) {
    events.push(event)
  }
  return events
}

function completed(events: AgentEvent[]) {
  return events.find(event => event.type === 'tool.call.completed')
}

const FILE: AcceptanceCriterion = {
  id: 'ac_file',
  statement: 'app contains the new behavior',
  evidenceKind: 'file_assertion',
  required: true,
}
const DIFF: AcceptanceCriterion = {
  id: 'ac_diff',
  statement: 'the implementation diff is present',
  evidenceKind: 'diff_assertion',
  required: true,
}
const MANUAL: AcceptanceCriterion = {
  id: 'ac_manual',
  statement: 'the user reviewed the interaction',
  evidenceKind: 'manual',
  required: true,
}

describe('runtime-issued assertion evidence tools', () => {
  test('FileAssert, DiffAssert and ManualVerify cover all approved criteria', async () => {
    const world = await makeWorld({
      turns: [],
      files: { 'app.txt': 'old behavior\n' },
      channels: { askUser: async () => 'Confirm' },
    })
    try {
      await execFileAsync('git', ['init'], { cwd: world.workspaceRoot })
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: world.workspaceRoot })
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: world.workspaceRoot })
      await execFileAsync('git', ['add', 'app.txt'], { cwd: world.workspaceRoot })
      await execFileAsync('git', ['commit', '-m', 'baseline'], { cwd: world.workspaceRoot })
      await writeFile(join(world.workspaceRoot, 'app.txt'), 'new behavior\n', 'utf8')
      await approveCriteria(world, [FILE, DIFF, MANUAL])

      const fileEvents = await runTool(world, 'file_1', 'FileAssert', {
        path: 'app.txt',
        criterionIds: [FILE.id],
        expected: { exists: true, contains: ['new behavior'], notContains: ['old behavior'] },
      })
      const diffEvents = await runTool(world, 'diff_1', 'DiffAssert', {
        paths: ['app.txt'],
        criterionIds: [DIFF.id],
        expectedAdded: ['new behavior'],
        expectedRemoved: ['old behavior'],
      })
      const manualEvents = await runTool(world, 'manual_1', 'ManualVerify', {
        criterionIds: [MANUAL.id],
      })

      expect(completed(fileEvents)).toMatchObject({ result: { ok: true } })
      expect(completed(diffEvents)).toMatchObject({ result: { ok: true } })
      expect(completed(manualEvents)).toMatchObject({ result: { ok: true } })
      const receipts = world.runtime.evidence.list()
      expect(receipts.map(receipt => [receipt.kind, receipt.status])).toEqual([
        ['file_assertion', 'passed'],
        ['diff_assertion', 'passed'],
        ['manual', 'passed'],
      ])
      const stale = await findStaleReceipts(world.runtime.evidence)
      expect(requiredCriteriaWithoutEvidence(
        [FILE, DIFF, MANUAL],
        receipts,
        stale,
        world.workspaceRoot,
      )).toEqual([])
    } finally {
      await world.cleanup()
    }
  })

  test('manual rejection creates failed evidence and cannot satisfy completion', async () => {
    const world = await makeWorld({
      turns: [],
      channels: { askUser: async () => 'Reject' },
    })
    try {
      await approveCriteria(world, [MANUAL])
      await runTool(world, 'manual_reject', 'ManualVerify', {
        criterionIds: [MANUAL.id],
      })
      const receipt = world.runtime.evidence.list()[0]!
      expect(receipt).toMatchObject({ kind: 'manual', status: 'failed' })
      expect(requiredCriteriaWithoutEvidence([MANUAL], [receipt])).toEqual([MANUAL])
    } finally {
      await world.cleanup()
    }
  })

  test('headless manual verification and criterion kind mismatch are rejected', async () => {
    const world = await makeWorld({ turns: [], files: { 'app.txt': 'x' } })
    try {
      await approveCriteria(world, [MANUAL])
      const manual = await runTool(world, 'manual_headless', 'ManualVerify', {
        criterionIds: [MANUAL.id],
      })
      expect(completed(manual)).toMatchObject({
        result: { ok: false, errorCode: 'SEMANTIC_VALIDATION_ERROR' },
      })

      const mismatched = await runTool(world, 'file_wrong_kind', 'FileAssert', {
        path: 'app.txt',
        criterionIds: [MANUAL.id],
        expected: { exists: true },
      })
      expect(completed(mismatched)).toMatchObject({
        result: { ok: false, errorCode: 'SEMANTIC_VALIDATION_ERROR' },
      })
      expect(world.runtime.evidence.list()).toEqual([])
    } finally {
      await world.cleanup()
    }
  })

  test('an asserted-missing file becomes stale when externally created', async () => {
    const world = await makeWorld({ turns: [] })
    try {
      await approveCriteria(world, [FILE])
      await runTool(world, 'file_missing', 'FileAssert', {
        path: 'generated.txt',
        criterionIds: [FILE.id],
        expected: { exists: false },
      })
      const receipt = world.runtime.evidence.list()[0]!
      expect(receipt.status).toBe('passed')
      expect((await findStaleReceipts(world.runtime.evidence)).has(receipt.id)).toBe(false)
      await writeFile(join(world.workspaceRoot, 'generated.txt'), 'created externally', 'utf8')
      expect((await findStaleReceipts(world.runtime.evidence)).has(receipt.id)).toBe(true)
    } finally {
      await world.cleanup()
    }
  })

  test('FileAssert blocks workspace escape and DiffAssert is inconclusive outside Git', async () => {
    const world = await makeWorld({ turns: [], files: { 'app.txt': 'x' } })
    try {
      await approveCriteria(world, [FILE, DIFF])
      const escaped = await runTool(world, 'file_escape', 'FileAssert', {
        path: '../outside.txt',
        criterionIds: [FILE.id],
        expected: { exists: false },
      })
      expect(completed(escaped)).toMatchObject({
        result: { ok: false, errorCode: 'SEMANTIC_VALIDATION_ERROR' },
      })

      await runTool(world, 'diff_no_git', 'DiffAssert', {
        paths: ['app.txt'],
        criterionIds: [DIFF.id],
        expectedAdded: [],
        expectedRemoved: [],
      })
      expect(world.runtime.evidence.list()[0]).toMatchObject({
        kind: 'diff_assertion', status: 'inconclusive',
      })
    } finally {
      await world.cleanup()
    }
  })
})
