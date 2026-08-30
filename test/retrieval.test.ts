import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { mergeConfig } from '../src/app/config.js'
import { CodeRetriever, chunkDocument } from '../src/retrieval/CodeRetriever.js'
import { planRetrievalQuery } from '../src/retrieval/QueryPlanner.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { RefreshCodeIndexTool } from '../src/tools/builtin/RetrievalTools.js'
import type { ToolContext } from '../src/tools/Tool.js'
import { collectRun, makeWorld, stateWithUser } from './helpers.js'

describe('v1.2/v1.3 code retrieval and context graph', () => {
  test('query planning preserves the original and derives bounded intent-aware variants', () => {
    const plan = planRetrievalQuery(
      'Find tests for "ToolRuntime permission pipeline" and error TS2322',
    )
    expect(plan).toMatchObject({
      intent: 'tests',
      original: 'Find tests for "ToolRuntime permission pipeline" and error TS2322',
    })
    expect(plan.identifiers).toEqual(expect.arrayContaining(['tool', 'runtime', 'ts2322']))
    expect(plan.phrases).toContain('toolruntime permission pipeline')
    expect(plan.variants.length).toBeGreaterThan(1)
    expect(plan.variants.length).toBeLessThanOrEqual(4)
  })

  test('chunks code on symbol boundaries with stable versioned source IDs', () => {
    const input = {
      uri: 'src/math.ts',
      content: [
        "import { value } from './value.js'",
        'export function add(a: number, b: number) { return a + b }',
        'export class Calculator {',
        '  multiply(a: number, b: number) { return a * b }',
        '}',
      ].join('\n'),
      version: 'sha256:abc',
      repositoryVersion: 'a'.repeat(40),
      indexedAt: '2026-08-06T00:00:00.000Z',
    }
    const first = chunkDocument(input)
    const second = chunkDocument(input)

    expect(first.map(chunk => chunk.sourceId)).toEqual(second.map(chunk => chunk.sourceId))
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'add', startLine: 2, version: 'sha256:abc' }),
      expect.objectContaining({ symbol: 'Calculator', startLine: 3 }),
    ]))
    expect(first.every(chunk => chunk.termCount > 0)).toBe(true)
  })

  test('hybrid search returns RRF scores and integrity-checked citations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-retrieval-'))
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(
        join(root, 'src', 'ToolRuntime.ts'),
        'export class ToolRuntime { executePermissionPipeline() { return "allow" } }\n',
        'utf8',
      )
      await writeFile(
        join(root, 'src', 'unrelated.ts'),
        'export function paintCanvas() { return "blue" }\n',
        'utf8',
      )
      const retriever = new CodeRetriever(root, {
        persistence: false,
        refreshOnSearch: false,
      })
      await retriever.refresh()

      const detailed = await retriever.searchDetailed('tool runtime permission pipeline', {
        limit: 3,
        freshness: 'cached',
      })
      const hits = detailed.hits
      expect(hits[0]).toMatchObject({
        uri: 'src/ToolRuntime.ts',
        version: expect.stringMatching(/^sha256:/),
        metadata: {
          kind: 'code',
          trust: 'untrusted_repository_content',
          startLine: 1,
        },
      })
      expect(hits[0]!.scores.bm25).toBeGreaterThan(0)
      expect(hits[0]!.scores.vector).toBeGreaterThan(0)
      expect(hits[0]!.scores.rrf).toBeGreaterThan(0)
      expect(hits[0]!.scores.rerank).toBeGreaterThan(0)
      expect(hits[0]!.metadata.ranking?.matchedTerms.length).toBeGreaterThan(0)
      expect(hits[0]!.metadata.citation).toContain('[src:' + hits[0]!.sourceId + ']')
      expect(detailed.trace).toMatchObject({
        queryPlan: { intent: 'implementation' },
        ranking: {
          sparse: 'bm25',
          fusion: 'rrf-k60',
          reranker: 'local-feature-v1',
          diversity: 'mmr-v1',
        },
      })
      expect(detailed.trace.stages.fusedCandidates).toBeGreaterThanOrEqual(hits.length)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('MMR diversity enforces a per-file cap without losing citations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-retrieval-'))
    try {
      await writeFile(
        join(root, 'many.ts'),
        [
          'export function searchAlpha() { return "retrieval search" }',
          'export function searchBeta() { return "retrieval search" }',
          'export function searchGamma() { return "retrieval search" }',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        join(root, 'other.ts'),
        'export function searchDelta() { return "retrieval search" }\n',
        'utf8',
      )
      const retriever = new CodeRetriever(root, {
        persistence: false,
        refreshOnSearch: false,
      })
      await retriever.refresh()
      const hits = await retriever.search('retrieval search function', {
        limit: 4,
        maxPerFile: 1,
        freshness: 'cached',
      })
      expect(hits).toHaveLength(2)
      expect(new Set(hits.map(hit => hit.uri)).size).toBe(2)
      expect(hits.every(hit => hit.metadata.citation.includes('[src:'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('context expansion follows adjacent chunks, imports, calls and reverse imports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-retrieval-'))
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(
        join(root, 'src', 'main.ts'),
        [
          "import { helper } from './helper.js'",
          'export function main() { return helper() }',
          'export function neighbor() { return main() }',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        join(root, 'src', 'helper.ts'),
        'export function helper() { return 42 }\n',
        'utf8',
      )
      const retriever = new CodeRetriever(root, {
        persistence: false,
        refreshOnSearch: false,
      })
      await retriever.refresh()
      const main = (await retriever.search('main', {
        pathPrefix: 'src/main.ts',
        freshness: 'cached',
      })).find(hit => hit.metadata.symbol === 'main')!
      const expanded = await retriever.expand([main.sourceId], {
        relations: ['adjacent', 'imports', 'calls'],
        depth: 1,
        maxHits: 10,
        freshness: 'cached',
      })
      expect(expanded.missingSourceIds).toEqual([])
      expect(expanded.hits.some(hit => hit.uri === 'src/helper.ts')).toBe(true)
      expect(expanded.edges.map(edge => edge.relation)).toEqual(expect.arrayContaining([
        'adjacent', 'imports', 'calls',
      ]))
      expect(expanded.hits.every(hit => hit.metadata.expansion?.distance === 1)).toBe(true)

      const helper = (await retriever.search('helper', {
        pathPrefix: 'src/helper.ts',
        freshness: 'cached',
      }))[0]!
      const reverse = await retriever.expand([helper.sourceId], {
        relations: ['imported_by'],
        depth: 1,
        freshness: 'cached',
      })
      expect(reverse.hits.some(hit => hit.uri === 'src/main.ts')).toBe(true)
      expect(reverse.edges.some(edge => edge.relation === 'imported_by')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('invalidations incrementally replace changed chunks and synchronize deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-retrieval-'))
    try {
      const file = join(root, 'service.ts')
      await writeFile(file, 'export function oldBehavior() { return 1 }\n', 'utf8')
      const retriever = new CodeRetriever(root, {
        persistence: false,
        refreshOnSearch: false,
      })
      const initial = await retriever.refresh()
      const oldHit = (await retriever.search('oldBehavior', { freshness: 'cached' }))[0]!
      expect(initial.filesUpdated).toBe(1)

      await writeFile(file, 'export function newBehavior() { return 2 }\n', 'utf8')
      retriever.invalidate('service.ts')
      expect((await retriever.status()).dirtyPaths).toEqual(['service.ts'])
      const newHit = (await retriever.search('newBehavior', { freshness: 'cached' }))[0]!
      expect(newHit.version).not.toBe(oldHit.version)
      expect(newHit.sourceId).not.toBe(oldHit.sourceId)
      expect((await retriever.status()).dirtyPaths).toEqual([])

      await unlink(file)
      retriever.invalidate('service.ts')
      expect(await retriever.search('newBehavior', { freshness: 'cached' })).toEqual([])
      expect((await retriever.status()).files).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('auto freshness discovers external edits without a workspace fact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-retrieval-'))
    try {
      const file = join(root, 'external.ts')
      await writeFile(file, 'export function beforeExternalEdit() { return 1 }\n', 'utf8')
      const retriever = new CodeRetriever(root, {
        persistence: false,
        refreshOnSearch: true,
      })
      await retriever.refresh()
      const before = (await retriever.search('beforeExternalEdit'))[0]!

      await writeFile(
        file,
        'export function afterExternalEditWithDifferentSize() { return 200 }\n',
        'utf8',
      )
      const after = (await retriever.search('afterExternalEditWithDifferentSize'))[0]!
      expect(after.version).not.toBe(before.version)
      expect(after.sourceId).not.toBe(before.sourceId)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('explicit refresh rejects a symlink or junction escaping the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-retrieval-'))
    const outside = await mkdtemp(join(tmpdir(), 'agent-retrieval-outside-'))
    try {
      await writeFile(
        join(outside, 'outside.ts'),
        'export const outsideWorkspace = true\n',
        'utf8',
      )
      await symlink(
        outside,
        join(root, 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )

      const retriever = new CodeRetriever(root, {
        persistence: false,
        refreshOnSearch: false,
      })
      const validation = await RefreshCodeIndexTool.validate(
        { paths: ['linked/outside.ts'] },
        { workspaceRoot: root } as ToolContext,
      )
      expect(validation).toMatchObject({
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: 'refresh path rejected: symlink_escape',
        },
      })
      await expect(retriever.refresh(['linked/outside.ts']))
        .rejects.toThrow('refresh path rejected: symlink_escape')
      expect(await retriever.status()).toMatchObject({ initialized: false, files: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('persistent cache reloads and indexed source text is secret-sanitized', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-retrieval-'))
    try {
      // Build the fake credential at runtime so repository-wide secret scans
      // can stay fail-closed without allowlisting this whole test file.
      const fakeCredential = ['sk', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('-')
      await writeFile(
        join(root, 'auth.ts'),
        `export const apiKey = '${fakeCredential}'\n`,
        'utf8',
      )
      await writeFile(join(root, 'credentials.json'), '{"token":"do-not-index"}', 'utf8')
      const first = new CodeRetriever(root, { refreshOnSearch: false })
      const refreshed = await first.refresh()
      expect(refreshed.redactedChunks).toBeGreaterThan(0)
      const hit = (await first.search('apiKey', { freshness: 'cached' }))[0]!
      expect(hit.content).toContain('[REDACTED]')
      expect(hit.content).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890')
      expect(hit.metadata.redacted).toBe(true)
      expect(await first.search('do-not-index', { freshness: 'cached' })).toEqual([])

      const cacheText = await readFile(
        join(root, '.agent', 'index', 'code-rag-v1.json'),
        'utf8',
      )
      expect(cacheText).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890')
      const reloaded = new CodeRetriever(root, { refreshOnSearch: false })
      expect(await reloaded.status()).toMatchObject({ initialized: true, files: 1 })

      const tampered = JSON.parse(cacheText) as {
        files: Record<string, { chunks: Array<{ uri: string }> }>
      }
      tampered.files['auth.ts']!.chunks[0]!.uri = '../../outside.ts'
      await writeFile(
        join(root, '.agent', 'index', 'code-rag-v1.json'),
        JSON.stringify(tampered),
        'utf8',
      )
      const rejected = new CodeRetriever(root, { refreshOnSearch: false })
      expect(await rejected.status()).toMatchObject({ initialized: false, files: 0 })
      expect((await rejected.search('apiKey', { freshness: 'cached' }))[0]!.uri)
        .toBe('auth.ts')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retrieval tools run through normal runtime contracts in plan mode', async () => {
    const world = await makeWorld({
      mode: 'plan',
      files: {
        'src/engine.ts': 'export function resumableAgentLoop() { return "continue" }\n',
      },
      turns: [
        toolCallTurn([
          {
            id: 'search',
            name: 'SearchCodeIndex',
            input: { query: 'resumable agent loop', limit: 5 },
          },
          { id: 'status', name: 'CodeIndexStatus', input: {} },
          {
            id: 'expand',
            name: 'ExpandCodeContext',
            input: { sourceIds: ['aaaaaaaaaaaaaaaaaaaa'] },
          },
          { id: 'refresh', name: 'RefreshCodeIndex', input: { paths: ['src'] } },
        ]),
        textTurn('done'),
      ],
    })
    try {
      expect(world.runtime.registry.names()).toEqual(expect.arrayContaining([
        'SearchCodeIndex', 'ExpandCodeContext', 'RefreshCodeIndex', 'CodeIndexStatus',
      ]))
      const run = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'inspect the agent loop'),
      )
      expect(run.terminal).toEqual({ reason: 'completed' })
      const results = run.facts
        .filter(fact => fact.type === 'tool.call.completed')
        .map(fact => fact.type === 'tool.call.completed' ? fact.result : undefined)
        .filter(result => result !== undefined)
      expect(results).toHaveLength(4)
      expect(results.every(result => result.ok)).toBe(true)
      expect(results.find(result => result.callId === 'search')?.observation)
        .toMatchObject({ fields: { hitCount: 1 } })
    } finally {
      await world.cleanup()
    }
  })

  test('retrieval configuration merges by normal priority and can disable tools', async () => {
    const config = mergeConfig({
      user: { retrieval: { maxFiles: 100, refreshOnSearch: false } },
      project: { retrieval: { maxFiles: 200, maxPerFile: 4 } },
      cli: { retrieval: { enabled: false } },
    })
    expect(config.retrieval).toMatchObject({
      enabled: false,
      refreshOnSearch: false,
      maxFiles: 200,
      maxPerFile: 4,
    })

    const world = await makeWorld({
      turns: [],
      persist: false,
      retrieval: { enabled: false },
    })
    try {
      expect(world.runtime.codeRetriever).toBeUndefined()
      expect(world.runtime.registry.names()).not.toContain('SearchCodeIndex')
    } finally {
      await world.cleanup()
    }
  })
})
