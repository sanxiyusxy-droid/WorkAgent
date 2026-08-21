import { describe, expect, test } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime, resumeState } from '../src/app/createRuntime.js'
import { reduce } from '../src/core/state.js'
import type { FactEvent } from '../src/core/events.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { FaultInjectingModel } from '../src/evaluation/FaultInjectingModel.js'
import { ScriptedModel, textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import type { ModelRequest } from '../src/model/types.js'
import {
  envelopeChecksum,
  type JournalEnvelope,
} from '../src/session/SessionJournal.js'
import { loadSession } from '../src/session/SessionLoader.js'
import { collectRun, fixedClock } from './helpers.js'

const SOURCE_SESSION_ID = 'ses-fault-source'

const request: ModelRequest = {
  system: 'test',
  messages: [],
  tools: [],
  maxOutputTokens: 128,
}

function sourceEnvelope(
  seq: number,
  event: FactEvent,
  parentEventId: string | null,
): JournalEnvelope {
  const base = {
    schemaVersion: 1 as const,
    seq,
    eventId: `evt_source_${seq}`,
    sessionId: SOURCE_SESSION_ID,
    runId: 'run_source',
    turnId: 'turn_source',
    parentEventId,
    timestamp: new Date(1_000_000 + seq * 1_000).toISOString(),
    event,
  }
  return { ...base, checksum: envelopeChecksum(base) }
}

async function seedCorruptSource(workspaceRoot: string): Promise<string> {
  const sessionDir = join(
    workspaceRoot,
    '.agent',
    'sessions',
    SOURCE_SESSION_ID,
  )
  await mkdir(sessionDir, { recursive: true })
  const journalPath = join(sessionDir, 'journal.jsonl')
  const message = {
    id: 'msg_source_1',
    parentId: null,
    sessionId: SOURCE_SESSION_ID,
    turnId: 'turn_source',
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'recover this session' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    meta: { source: 'human' as const },
  }
  const envelopes = [
    sourceEnvelope(
      1,
      { type: 'run.started', runId: 'run_source', configHash: 'source' },
      null,
    ),
    sourceEnvelope(
      2,
      { type: 'user.message.accepted', message },
      'evt_source_1',
    ),
    sourceEnvelope(
      3,
      {
        type: 'replan.adjustment.applied',
        cause: 'injected_corruption',
        summary: 'there is no preceding replan request',
      },
      'evt_source_2',
    ),
  ]
  await writeFile(
    journalPath,
    envelopes.map(envelope => JSON.stringify(envelope)).join('\n') + '\n',
    'utf8',
  )
  return journalPath
}

describe('v1.5 deterministic fault evaluation', () => {
  test('journal I/O errors are not mistaken for a missing session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-journal-io-'))
    try {
      await expect(loadSession(directory)).rejects.toMatchObject({
        code: expect.stringMatching(/^(EISDIR|EPERM|EACCES)$/),
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('recovery repairs a durable completion that lost its result message', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-result-gap-'))
    const ids = createSequentialIds()
    const clock = fixedClock()
    const sessionId = 'ses-unmessaged-result'
    try {
      const { runtime: source } = await createRuntime({
        model: new ScriptedModel([]),
        config: {
          workspaceRoot,
          sessionId,
          persist: true,
          context: { enabled: false },
          verification: { enabled: false },
          intelligence: { enabled: false },
          retrieval: { enabled: false },
        },
        ids,
        clock,
      })
      const assistant = {
        id: 'msg_tool_call',
        parentId: null,
        sessionId,
        turnId: 'turn_gap',
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_call' as const,
            id: 'read_gap',
            name: 'Read',
            input: { path: 'a.txt' },
          },
        ],
        createdAt: clock.isoNow(),
        meta: { source: 'engine' as const },
      }
      const accepted: FactEvent = {
        type: 'tool.call.accepted',
        call: {
          id: 'read_gap',
          name: 'Read',
          input: { path: 'a.txt' },
          parentMessageId: assistant.id,
          receivedIndex: 0,
        },
      }
      const completed: FactEvent = {
        type: 'tool.call.completed',
        result: {
          callId: 'read_gap',
          toolName: 'Read',
          ok: true,
          content: { kind: 'text', text: 'alpha' },
          durationMs: 2,
        },
      }
      await source.journal!.append(
        { type: 'assistant.message.completed', message: assistant },
        assistant.turnId,
        'flush',
      )
      await source.journal!.append(accepted, assistant.turnId, 'flush')
      await source.journal!.append(completed, assistant.turnId, 'flush')

      const { runtime: recoveredRuntime, loaded } = await createRuntime({
        model: new ScriptedModel([]),
        config: {
          workspaceRoot,
          sessionId,
          persist: true,
          context: { enabled: false },
          verification: { enabled: false },
          intelligence: { enabled: false },
          retrieval: { enabled: false },
        },
        ids,
        clock,
      })
      expect(loaded?.openToolCalls).toEqual([])
      expect(loaded?.unmessagedResults.map(result => result.callId)).toEqual([
        'read_gap',
      ])

      const recovered = await resumeState(recoveredRuntime, loaded!)
      expect(recovered.recoveryFacts).toHaveLength(1)
      expect(recovered.recoveryFacts[0]).toMatchObject({
        type: 'tool.result.message',
        message: {
          meta: { source: 'recovery', synthetic: true },
          content: [
            {
              type: 'tool_result',
              callId: 'read_gap',
              ok: true,
              content: { kind: 'text', text: 'alpha' },
            },
          ],
        },
      })

      const finalLoad = await loadSession(recoveredRuntime.journalPath)
      expect(
        finalLoad.envelopes.filter(
          envelope => envelope.event.type === 'tool.call.completed',
        ),
      ).toHaveLength(1)
      expect(finalLoad.unmessagedResults).toEqual([])
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('FaultInjectingModel reports an unconsumed deterministic plan', async () => {
    const delegate = new ScriptedModel([textTurn('first request succeeds')])
    const model = new FaultInjectingModel(delegate, [
      {
        point: 'model_request',
        occurrence: 2,
        error: { code: 'CONNECTION', retryable: true },
      },
    ])

    for await (const _event of model.stream(
      request,
      new AbortController().signal,
    )) {
      // drain the successful first physical request
    }

    expect(model.requestCount).toBe(1)
    expect(model.injections).toEqual([])
    expect(() => model.assertScheduleConsumed()).toThrow(
      'fault schedule not fully consumed; missed request(s): 2',
    )
  })

  test('a retryable injected failure persists one fact and counts physical calls', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-fault-model-'))
    try {
      const delegate = new ScriptedModel([textTurn('recovered')])
      const model = new FaultInjectingModel(delegate, [
        {
          point: 'model_request',
          occurrence: 1,
          error: { code: 'RATE_LIMIT', retryAfterMs: 0, retryable: true },
        },
      ])
      const { runtime } = await createRuntime({
        model,
        config: {
          workspaceRoot,
          persist: true,
          maxTurns: 4,
          maxModelCalls: 4,
          context: { enabled: false },
          verification: { enabled: false },
          intelligence: { enabled: false },
          retrieval: { enabled: false },
        },
        clock: fixedClock(),
        ids: createSequentialIds(),
      })
      const initial = runtime.makeInitialState()
      const message = runtime.makeUserMessage('answer after retry', null)
      const userFact: FactEvent = { type: 'user.message.accepted', message }
      await runtime.journal!.append(userFact, message.turnId, 'flush')
      const withUser = reduce(initial, userFact)

      const result = await collectRun(runtime.engine, withUser)
      model.assertScheduleConsumed()

      const failures = result.facts.filter(
        (fact): fact is Extract<
          FactEvent,
          { type: 'model.attempt.failed' }
        > => fact.type === 'model.attempt.failed',
      )
      expect(result.terminal).toEqual({ reason: 'completed' })
      expect(model.requestCount).toBe(2)
      expect(delegate.requests).toHaveLength(1)
      expect(model.injections).toEqual([
        { occurrence: 1, code: 'RATE_LIMIT' },
      ])
      expect(failures).toEqual([
        {
          type: 'model.attempt.failed',
          failure: {
            code: 'RATE_LIMIT',
            attempt: 1,
            action: 'retry',
            delayMs: 0,
          },
        },
      ])

      const replayed = result.facts.reduce(
        (state, fact) => reduce(state, fact),
        withUser,
      )
      expect(replayed.budget.used.modelCalls).toBe(2)
      expect(replayed.recovery.modelRetries).toBe(1)

      const loaded = await loadSession(runtime.journalPath)
      expect(loaded.ok).toBe(true)
      expect(
        loaded.envelopes.filter(
          envelope => envelope.event.type === 'model.attempt.failed',
        ),
      ).toHaveLength(1)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('physical retry attempts cannot exceed the model-call budget', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-fault-budget-'))
    try {
      const delegate = new ScriptedModel([textTurn('must not be requested')])
      const model = new FaultInjectingModel(delegate, [
        {
          point: 'model_request',
          occurrence: 1,
          error: { code: 'RATE_LIMIT', retryAfterMs: 0, retryable: true },
        },
      ])
      const { runtime } = await createRuntime({
        model,
        config: {
          workspaceRoot,
          persist: false,
          maxTurns: 4,
          maxModelCalls: 1,
          context: { enabled: false },
          verification: { enabled: false },
          intelligence: { enabled: false },
          retrieval: { enabled: false },
        },
        clock: fixedClock(),
        ids: createSequentialIds(),
      })
      const initial = runtime.makeInitialState()
      const message = runtime.makeUserMessage('respect the call budget', null)
      const result = await collectRun(runtime.engine, {
        ...initial,
        messages: [message],
      })

      expect(result.terminal).toEqual({
        reason: 'budget_exhausted',
        kind: 'model_calls',
      })
      expect(model.requestCount).toBe(1)
      expect(delegate.requests).toHaveLength(0)
      expect(
        result.facts.filter(fact => fact.type === 'model.attempt.failed'),
      ).toHaveLength(1)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('aborting during Retry-After interrupts the backoff immediately', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-fault-abort-'))
    try {
      const delegate = new ScriptedModel([textTurn('must not be requested')])
      const model = new FaultInjectingModel(delegate, [
        {
          point: 'model_request',
          occurrence: 1,
          error: { code: 'RATE_LIMIT', retryAfterMs: 10_000, retryable: true },
        },
      ])
      const { runtime } = await createRuntime({
        model,
        config: {
          workspaceRoot,
          persist: false,
          context: { enabled: false },
          verification: { enabled: false },
          intelligence: { enabled: false },
          retrieval: { enabled: false },
        },
        clock: fixedClock(),
        ids: createSequentialIds(),
      })
      const initial = runtime.makeInitialState()
      const message = runtime.makeUserMessage('abort the retry', null)
      const controller = new AbortController()
      const startedAt = Date.now()
      const timer = setTimeout(() => controller.abort('test abort'), 20)
      const result = await collectRun(
        runtime.engine,
        { ...initial, messages: [message] },
        controller.signal,
      )
      clearTimeout(timer)

      expect(result.terminal).toEqual({ reason: 'aborted', at: 'calling_model' })
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(model.requestCount).toBe(1)
      expect(delegate.requests).toHaveLength(0)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('a degraded branch starts at seq 1 and remains hard read-only after reload', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-fault-branch-'))
    try {
      const sourceJournalPath = await seedCorruptSource(workspaceRoot)
      const sourceBefore = await readFile(sourceJournalPath, 'utf8')
      const ids = createSequentialIds()
      const clock = fixedClock()

      const branchModel = new ScriptedModel([])
      const { runtime: branchRuntime, loaded: sourceLoaded } =
        await createRuntime({
          model: branchModel,
          config: {
            workspaceRoot,
            persist: true,
            recoveryForkFrom: SOURCE_SESSION_ID,
            context: { enabled: false },
            verification: { enabled: false },
            intelligence: { enabled: false },
            retrieval: { enabled: false },
          },
          clock,
          ids,
        })
      expect(sourceLoaded).not.toBeNull()

      const degraded = await resumeState(branchRuntime, sourceLoaded!, {
        degraded: true,
      })
      expect(degraded.replayFailure?.allowDegraded).toBe(true)
      const branchFact: FactEvent = {
        type: 'session.recovery.branch',
        fromSessionId: SOURCE_SESSION_ID,
        failureSeq: 3,
        issues: ['[reducer] seq 3 replan_adjustment_without_request'],
      }
      await branchRuntime.journal!.append(
        branchFact,
        degraded.state.turnId,
        'flush',
      )
      const firstBranchState = reduce(degraded.state, branchFact)
      expect(firstBranchState.mode).toBe('plan')
      expect(firstBranchState.recovery.degradedRecovery).toBe(true)
      expect(await readFile(sourceJournalPath, 'utf8')).toBe(sourceBefore)

      const firstLoad = await loadSession(branchRuntime.journalPath)
      expect(firstLoad.ok).toBe(true)
      expect(firstLoad.envelopes.map(envelope => envelope.seq)).toEqual([1, 2])
      expect(firstLoad.envelopes[0]!.event.type).toBe('run.started')
      expect(firstLoad.envelopes[1]!.event.type).toBe(
        'session.recovery.branch',
      )

      const retryModel = new ScriptedModel([
        toolCallTurn([
          {
            id: 'write_forbidden',
            name: 'Write',
            input: {
              path: 'forbidden.txt',
              content: 'must not be written',
              overwrite: true,
            },
          },
        ]),
        textTurn('write stayed blocked'),
      ])
      const { runtime: reloadedRuntime, loaded: branchLoaded } =
        await createRuntime({
          model: retryModel,
          config: {
            workspaceRoot,
            sessionId: branchRuntime.sessionId,
            persist: true,
            mode: 'bypassPermissions',
            maxTurns: 4,
            context: { enabled: false },
            verification: { enabled: false },
            intelligence: { enabled: false },
            retrieval: { enabled: false },
          },
          clock,
          ids,
        })
      expect(branchLoaded?.ok).toBe(true)
      const secondRecovery = await resumeState(
        reloadedRuntime,
        branchLoaded!,
      )
      expect(secondRecovery.replayFailure).toBeNull()
      expect(secondRecovery.state.mode).toBe('plan')
      expect(secondRecovery.state.recovery.degradedRecovery).toBe(true)

      const followup = reloadedRuntime.makeUserMessage(
        'try a write after branch reload',
        null,
      )
      const followupFact: FactEvent = {
        type: 'user.message.accepted',
        message: followup,
      }
      await reloadedRuntime.journal!.append(
        followupFact,
        followup.turnId,
        'flush',
      )
      const runState = reduce(secondRecovery.state, followupFact)
      const run = await collectRun(reloadedRuntime.engine, runState)
      const writeResult = run.facts.find(
        fact =>
          fact.type === 'tool.call.completed' &&
          fact.result.callId === 'write_forbidden',
      )
      expect(retryModel.requests[0]!.tools.map(tool => tool.name)).not.toContain(
        'Write',
      )
      expect(writeResult).toMatchObject({
        type: 'tool.call.completed',
        result: { callId: 'write_forbidden', toolName: 'Write', ok: false },
      })
      await expect(
        access(join(workspaceRoot, 'forbidden.txt')),
      ).rejects.toThrow()

      const finalLoad = await loadSession(reloadedRuntime.journalPath)
      expect(finalLoad.ok).toBe(true)
      expect(finalLoad.envelopes.map(envelope => envelope.seq)).toEqual(
        Array.from(
          { length: finalLoad.envelopes.length },
          (_value, index) => index + 1,
        ),
      )
      expect(await readFile(sourceJournalPath, 'utf8')).toBe(sourceBefore)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
