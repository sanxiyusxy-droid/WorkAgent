import { z } from 'zod'
import { describe, expect, test } from 'vitest'
import { defineTool } from '../src/tools/Tool.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { collectRun, makeWorld, stateWithUser } from './helpers.js'

describe('v1.1 unified tool contracts', () => {
  test('enforces pre/postconditions and records structured observations', async () => {
    let executions = 0
    const ContractTool = defineTool({
      name: 'ContractProbe',
      description: 'test-only contract probe',
      inputSchema: z.object({ mode: z.enum(['pre-fail', 'post-fail', 'pass', 'large']) }).strict(),
      readOnly: () => true,
      concurrency: () => 'shared',
      resources: () => [{ resource: 'test:contract', mode: 'read' }],
      permission: async () => ({ behavior: 'allow' }),
      preconditions: async input => [{
        id: 'input-ready',
        passed: input.mode !== 'pre-fail',
        detail: input.mode,
      }],
      execute: async input => {
        executions += 1
        return { data: { valid: input.mode !== 'post-fail', mode: input.mode } }
      },
      postconditions: async (_input, output) => [{
        id: 'output-valid',
        passed: output.valid,
      }],
      observe: async (_input, output) => ({
        summary: `probe ${output.mode}`,
        fields: output.mode === 'large'
          ? { payload: 'x'.repeat(20_000) }
          : { valid: output.valid },
      }),
    })
    const world = await makeWorld({
      turns: [
        toolCallTurn([
          { id: 'pre', name: 'ContractProbe', input: { mode: 'pre-fail' } },
          { id: 'post', name: 'ContractProbe', input: { mode: 'post-fail' } },
          { id: 'pass', name: 'ContractProbe', input: { mode: 'pass' } },
          { id: 'large', name: 'ContractProbe', input: { mode: 'large' } },
        ]),
        textTurn('done'),
      ],
    })
    try {
      world.runtime.registry.register(ContractTool)
      const run = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'exercise contracts'),
      )
      expect(run.terminal).toEqual({ reason: 'completed' })
      expect(executions).toBe(3)
      const results = run.facts
        .filter(f => f.type === 'tool.call.completed')
        .map(f => f.type === 'tool.call.completed' ? f.result : undefined)
        .filter(result => result !== undefined)
      expect(results.find(result => result.callId === 'pre')).toMatchObject({
        ok: false,
        errorCode: 'PRECONDITION_FAILED',
        observation: {
          preconditions: [{ id: 'input-ready', passed: false, detail: 'pre-fail' }],
          postconditions: [],
        },
      })
      expect(results.find(result => result.callId === 'post')).toMatchObject({
        ok: false,
        errorCode: 'POSTCONDITION_FAILED',
        observation: {
          summary: 'probe post-fail',
          postconditions: [{ id: 'output-valid', passed: false }],
        },
      })
      expect(results.find(result => result.callId === 'pass')).toMatchObject({
        ok: true,
        observation: {
          summary: 'probe pass',
          fields: { valid: true },
        },
      })
      expect(results.find(result => result.callId === 'large')).toMatchObject({
        ok: true,
        observation: {
          fields: {
            observationTruncated: true,
            originalChars: expect.any(Number),
          },
        },
      })
    } finally {
      await world.cleanup()
    }
  })
})
