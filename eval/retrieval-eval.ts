import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { CodeRetriever } from '../src/retrieval/CodeRetriever.js'
import { computeVersion } from '../src/workspace/FileVersion.js'
import type { ContextRelation, RetrievalHit } from '../src/retrieval/types.js'

interface RetrievalCase {
  id: string
  query: string
  expectedUris: string[]
}

interface RetrievalBaseline {
  minRecallAtK: number
  minMrr: number
  minGraphExpansionHitRate: number
  minCitationIntegrity: number
  maxStaleHitRate: number
  maxEstimatedContextTokens: number
}

interface ContextGraphCase {
  id: string
  seedQuery: string
  seedUri: string
  expectedUri: string
  relations: ContextRelation[]
}

const workspaceRoot = process.cwd()
const cases = JSON.parse(
  await readFile(join(workspaceRoot, 'eval', 'retrieval-cases.json'), 'utf8'),
) as RetrievalCase[]
const baseline = JSON.parse(
  await readFile(join(workspaceRoot, 'eval', 'retrieval-baseline.json'), 'utf8'),
) as RetrievalBaseline
const graphCases = JSON.parse(
  await readFile(join(workspaceRoot, 'eval', 'context-graph-cases.json'), 'utf8'),
) as ContextGraphCase[]
const retriever = new CodeRetriever(workspaceRoot, {
  persistence: false,
  refreshOnSearch: false,
})
const refresh = await retriever.refresh()
const topK = 10
let hits = 0
let reciprocalRank = 0
let totalLatencyMs = 0
let totalContextChars = 0
let staleHits = 0
let totalReturnedHits = 0
let validCitations = 0
const results: Array<Record<string, unknown>> = []
const graphResults: Array<Record<string, unknown>> = []
let graphHits = 0
let totalGraphLatencyMs = 0

async function auditHits(returned: RetrievalHit[]): Promise<void> {
  totalReturnedHits += returned.length
  for (const hit of returned) {
    if (hit.metadata.citation.includes('[src:' + hit.sourceId + ']')) validCitations += 1
    try {
      const current = await readFile(join(workspaceRoot, hit.uri))
      if (computeVersion(current) !== hit.version) staleHits += 1
    } catch {
      staleHits += 1
    }
  }
}

for (const testCase of cases) {
  const started = performance.now()
  const retrieved = await retriever.search(testCase.query, {
    limit: topK,
    maxChars: 40_000,
    freshness: 'cached',
  })
  const latencyMs = performance.now() - started
  totalLatencyMs += latencyMs
  totalContextChars += retrieved.reduce((sum, hit) => sum + hit.content.length, 0)
  const rank = retrieved.findIndex(hit => testCase.expectedUris.includes(hit.uri)) + 1
  if (rank > 0) {
    hits += 1
    reciprocalRank += 1 / rank
  }
  await auditHits(retrieved)
  results.push({
    id: testCase.id,
    rank: rank || null,
    topUris: retrieved.slice(0, 3).map(hit => hit.uri),
    latencyMs: Number(latencyMs.toFixed(2)),
  })
}

for (const testCase of graphCases) {
  const seeds = await retriever.search(testCase.seedQuery, {
    pathPrefix: testCase.seedUri,
    limit: 10,
    freshness: 'cached',
  })
  const seed = seeds.find(hit => hit.uri === testCase.seedUri)
  const started = performance.now()
  const expanded = seed
    ? await retriever.expand([seed.sourceId], {
        focus: testCase.seedQuery,
        relations: testCase.relations,
        depth: 1,
        maxHits: 30,
        freshness: 'cached',
      })
    : undefined
  const latencyMs = performance.now() - started
  totalGraphLatencyMs += latencyMs
  const matched = expanded?.hits.some(hit => hit.uri === testCase.expectedUri) ?? false
  if (matched) graphHits += 1
  if (expanded) await auditHits(expanded.hits)
  graphResults.push({
    id: testCase.id,
    seedSourceId: seed?.sourceId ?? null,
    matched,
    expandedUris: expanded?.hits.slice(0, 8).map(hit => hit.uri) ?? [],
    edgeRelations: [...new Set(expanded?.edges.map(edge => edge.relation) ?? [])],
    latencyMs: Number(latencyMs.toFixed(2)),
  })
}

const metrics = {
  cases: cases.length,
  topK,
  recallAtK: cases.length === 0 ? 0 : hits / cases.length,
  mrr: cases.length === 0 ? 0 : reciprocalRank / cases.length,
  graphExpansionHitRate: graphCases.length === 0 ? 1 : graphHits / graphCases.length,
  citationIntegrity: totalReturnedHits === 0 ? 1 : validCitations / totalReturnedHits,
  staleHitRate: totalReturnedHits === 0 ? 0 : staleHits / totalReturnedHits,
  averageLatencyMs: cases.length === 0 ? 0 : totalLatencyMs / cases.length,
  averageGraphLatencyMs:
    graphCases.length === 0 ? 0 : totalGraphLatencyMs / graphCases.length,
  averageContextChars: cases.length === 0 ? 0 : totalContextChars / cases.length,
  estimatedContextTokens: cases.length === 0 ? 0 : Math.ceil(totalContextChars / cases.length / 4),
  index: {
    files: refresh.filesScanned,
    chunks: refresh.chunks,
    buildLatencyMs: refresh.durationMs,
    embeddingProvider: (await retriever.status()).embeddingProvider,
  },
}

const failures: string[] = []
if (metrics.recallAtK < baseline.minRecallAtK) failures.push('recallAtK below baseline')
if (metrics.mrr < baseline.minMrr) failures.push('mrr below baseline')
if (metrics.graphExpansionHitRate < baseline.minGraphExpansionHitRate) {
  failures.push('graphExpansionHitRate below baseline')
}
if (metrics.citationIntegrity < baseline.minCitationIntegrity) {
  failures.push('citationIntegrity below baseline')
}
if (metrics.staleHitRate > baseline.maxStaleHitRate) {
  failures.push('staleHitRate above baseline')
}
if (metrics.estimatedContextTokens > baseline.maxEstimatedContextTokens) {
  failures.push('estimatedContextTokens above baseline')
}

process.stdout.write(JSON.stringify({
  passed: failures.length === 0,
  baseline,
  failures,
  metrics,
  results,
  graphResults,
}, null, 2) + '\n')
if (failures.length > 0) process.exitCode = 1
