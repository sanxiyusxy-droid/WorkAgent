import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodeIntelligenceService } from '../src/codeintel/CodeIntelligence.js'
import { makeWorld } from './helpers.js'
import { collectRun, stateWithUser } from './helpers.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'

describe('v1.1 code intelligence', () => {
  test('indexes symbols, references and call edges deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-codeintel-'))
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(
        join(root, 'src', 'math.ts'),
        [
          'export function add(a: number, b: number) { return a + b }',
          'export function total() { return add(1, 2) }',
          'export class Calculator {',
          '  multiply(a: number, b: number) { return a * b }',
          '}',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        join(root, 'src', 'use.ts'),
        "import { add } from './math.js'\nexport const answer = add(20, 22)\n",
        'utf8',
      )
      const service = new CodeIntelligenceService(root)

      const symbols = await service.symbols('add', 20)
      expect(symbols.matches[0]).toMatchObject({
        name: 'add',
        kind: 'function',
        file: 'src/math.ts',
        line: 1,
      })
      const references = await service.references('add', 20)
      expect(references.matches.filter(item => item.definition)).toHaveLength(1)
      expect(references.matches.some(item => item.file === 'src/use.ts')).toBe(true)

      const graph = await service.callGraph('total', 20)
      expect(graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          from: 'src/math.ts:2:total',
          to: 'src/math.ts:1:add',
        }),
      ]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('cache invalidates explicitly and JavaScript diagnostics use node --check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-codeintel-'))
    try {
      await writeFile(join(root, 'first.js'), 'function first() { return 1 }\n', 'utf8')
      const service = new CodeIntelligenceService(root)
      expect((await service.symbols('second', 10)).matches).toHaveLength(0)
      await writeFile(join(root, 'second.js'), 'function second( {\n', 'utf8')
      // shared snapshot remains consistent until a workspace.changed fact invalidates it
      expect((await service.symbols('second', 10)).matches).toHaveLength(0)
      service.invalidate('second.js')
      expect((await service.symbols('second', 10)).matches).toHaveLength(1)

      const diagnostics = await service.diagnostics({
        path: 'second.js',
        maxIssues: 20,
      })
      expect(diagnostics).toMatchObject({ available: true, engine: 'node-check' })
      expect(diagnostics.exitCode).not.toBe(0)
      expect(diagnostics.diagnostics.length).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('all four code-intelligence tools are registered', async () => {
    const world = await makeWorld({ turns: [], persist: false })
    try {
      expect(world.runtime.registry.names()).toEqual(expect.arrayContaining([
        'CodeSymbols',
        'FindReferences',
        'CallGraph',
        'CodeDiagnostics',
      ]))
    } finally {
      await world.cleanup()
    }
  })

  test('all four tools execute through the runtime contract', async () => {
    const world = await makeWorld({
      files: {
        'math.ts': [
          'export function add(a: number, b: number) { return a + b }',
          'export function total() { return add(1, 2) }',
        ].join('\n'),
        'broken.js': 'function broken( {\n',
      },
      turns: [
        toolCallTurn([
          { id: 'symbols', name: 'CodeSymbols', input: { query: 'add' } },
          { id: 'refs', name: 'FindReferences', input: { symbol: 'add' } },
          { id: 'graph', name: 'CallGraph', input: { symbol: 'total' } },
          { id: 'diagnostics', name: 'CodeDiagnostics', input: { path: 'broken.js' } },
        ]),
        textTurn('done'),
      ],
    })
    try {
      const run = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'inspect the code'),
      )
      expect(run.terminal).toEqual({ reason: 'completed' })
      const results = run.facts
        .filter(f => f.type === 'tool.call.completed')
        .map(f => f.type === 'tool.call.completed' ? f.result : undefined)
        .filter(result => result !== undefined)
      expect(results).toHaveLength(4)
      expect(results.every(result => result.ok)).toBe(true)
      expect(results.every(result =>
        result.observation?.postconditions.every(check => check.passed),
      )).toBe(true)
      expect(results.find(result => result.callId === 'diagnostics')?.observation)
        .toMatchObject({ fields: { available: true, engine: 'node-check' } })
    } finally {
      await world.cleanup()
    }
  })
})
