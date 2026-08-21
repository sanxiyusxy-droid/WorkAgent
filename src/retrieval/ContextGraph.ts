import { posix } from 'node:path'
import type {
  ContextEdge,
  ContextRelation,
  RetrievalChunk,
} from './types.js'

export interface GraphExpansion {
  missingSourceIds: string[]
  discovered: Array<{
    chunk: RetrievalChunk
    distance: number
    relations: ContextRelation[]
  }>
  edges: ContextEdge[]
}

export function expandChunkGraph(
  chunks: RetrievalChunk[],
  sourceIds: string[],
  input: {
    relations: ContextRelation[]
    depth: 1 | 2
    maxHits: number
    focusTerms: string[]
  },
): GraphExpansion {
  const byId = new Map(chunks.map(chunk => [chunk.sourceId, chunk]))
  const byUri = new Map<string, RetrievalChunk[]>()
  const bySymbol = new Map<string, RetrievalChunk[]>()
  for (const chunk of chunks) {
    byUri.set(chunk.uri, [...(byUri.get(chunk.uri) ?? []), chunk])
    if (chunk.symbol) {
      const key = chunk.symbol.toLowerCase()
      bySymbol.set(key, [...(bySymbol.get(key) ?? []), chunk])
    }
  }
  for (const values of byUri.values()) values.sort((a, b) => a.startLine - b.startLine)
  const fileText = new Map(
    [...byUri].map(([uri, values]) => [uri, values.map(value => value.content).join('\n')]),
  )
  const imports = new Map<string, string[]>()
  for (const [uri, content] of fileText) {
    imports.set(uri, resolveImports(uri, content, byUri))
  }
  const importedBy = new Map<string, string[]>()
  for (const [from, targets] of imports) {
    for (const target of targets) {
      importedBy.set(target, [...(importedBy.get(target) ?? []), from])
    }
  }

  const missingSourceIds = sourceIds.filter(sourceId => !byId.has(sourceId))
  const seeds = sourceIds.map(sourceId => byId.get(sourceId)).filter(isPresent)
  const seedSet = new Set(seeds.map(seed => seed.sourceId))
  const visited = new Set(seedSet)
  const queue = seeds.map(chunk => ({ chunk, distance: 0 }))
  const discovered = new Map<string, {
    chunk: RetrievalChunk
    distance: number
    relations: Set<ContextRelation>
  }>()
  const edges: ContextEdge[] = []
  const edgeKeys = new Set<string>()

  while (queue.length > 0 && discovered.size < input.maxHits) {
    const current = queue.shift()!
    if (current.distance >= input.depth) continue
    const nextDistance = current.distance + 1
    const neighbors = graphNeighbors(
      current.chunk,
      input.relations,
      byUri,
      bySymbol,
      imports,
      importedBy,
      input.focusTerms,
    )
    for (const neighbor of neighbors) {
      if (neighbor.chunk.sourceId === current.chunk.sourceId) continue
      const edgeKey = current.chunk.sourceId + ':' + neighbor.relation + ':' +
        neighbor.chunk.sourceId
      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey)
        edges.push({
          fromSourceId: current.chunk.sourceId,
          toSourceId: neighbor.chunk.sourceId,
          relation: neighbor.relation,
          distance: nextDistance,
        })
      }
      if (seedSet.has(neighbor.chunk.sourceId)) continue
      const existing = discovered.get(neighbor.chunk.sourceId)
      if (existing) {
        existing.relations.add(neighbor.relation)
        continue
      }
      if (discovered.size >= input.maxHits) break
      discovered.set(neighbor.chunk.sourceId, {
        chunk: neighbor.chunk,
        distance: nextDistance,
        relations: new Set([neighbor.relation]),
      })
      if (!visited.has(neighbor.chunk.sourceId)) {
        visited.add(neighbor.chunk.sourceId)
        queue.push({ chunk: neighbor.chunk, distance: nextDistance })
      }
    }
  }

  return {
    missingSourceIds,
    discovered: [...discovered.values()]
      .map(item => ({ ...item, relations: [...item.relations].sort() })),
    edges: edges.slice(0, input.maxHits * 6),
  }
}

function graphNeighbors(
  chunk: RetrievalChunk,
  relations: ContextRelation[],
  byUri: Map<string, RetrievalChunk[]>,
  bySymbol: Map<string, RetrievalChunk[]>,
  imports: Map<string, string[]>,
  importedBy: Map<string, string[]>,
  focusTerms: string[],
): Array<{ chunk: RetrievalChunk; relation: ContextRelation }> {
  const result: Array<{ chunk: RetrievalChunk; relation: ContextRelation }> = []
  if (relations.includes('adjacent')) {
    const fileChunks = byUri.get(chunk.uri) ?? []
    const index = fileChunks.findIndex(item => item.sourceId === chunk.sourceId)
    for (const neighbor of [fileChunks[index - 1], fileChunks[index + 1]]) {
      if (neighbor) result.push({ chunk: neighbor, relation: 'adjacent' })
    }
  }
  if (relations.includes('imports')) {
    for (const uri of imports.get(chunk.uri) ?? []) {
      for (const target of (byUri.get(uri) ?? []).slice(0, 2)) {
        result.push({ chunk: target, relation: 'imports' })
      }
    }
  }
  if (relations.includes('imported_by')) {
    for (const uri of importedBy.get(chunk.uri) ?? []) {
      const target = byUri.get(uri)?.[0]
      if (target) result.push({ chunk: target, relation: 'imported_by' })
    }
  }
  if (relations.includes('calls')) {
    const calls = unique(
      [...chunk.content.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)]
        .map(match => match[1]!.toLowerCase())
        .filter(name => !CONTROL_WORDS.has(name) && name !== chunk.symbol?.toLowerCase()),
    ).slice(0, 40)
    for (const call of calls) {
      for (const target of (bySymbol.get(call) ?? []).slice(0, 2)) {
        result.push({ chunk: target, relation: 'calls' })
      }
    }
  }
  const uniqueTargets = new Map<string, { chunk: RetrievalChunk; relation: ContextRelation }>()
  for (const item of result) {
    uniqueTargets.set(item.relation + ':' + item.chunk.sourceId, item)
  }
  return [...uniqueTargets.values()].sort((a, b) =>
    focusScore(b.chunk, focusTerms) - focusScore(a.chunk, focusTerms) ||
    a.relation.localeCompare(b.relation) || a.chunk.uri.localeCompare(b.chunk.uri) ||
    a.chunk.startLine - b.chunk.startLine,
  )
}

function focusScore(chunk: RetrievalChunk, terms: string[]): number {
  if (terms.length === 0) return 0
  const target = (chunk.uri + '\n' + (chunk.symbol ?? '')).toLowerCase()
  return terms.reduce((score, term) => score + (target.includes(term.toLowerCase()) ? 1 : 0), 0)
}

function resolveImports(
  fromUri: string,
  content: string,
  byUri: Map<string, RetrievalChunk[]>,
): string[] {
  const specs = unique([
    ...[...content.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)]
      .map(match => match[1]!),
    ...[...content.matchAll(/^\s*(?:from|import)\s+([.\w/]+)/gm)]
      .map(match => match[1]!),
  ])
  const uris = new Set(byUri.keys())
  const resolved: string[] = []
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue
    const base = posix.normalize(posix.join(posix.dirname(fromUri), spec))
    const withoutExtension = base.replace(/\.[A-Za-z0-9]+$/, '')
    const candidates = [base]
    for (const extension of SOURCE_LIKE_EXTENSIONS) {
      candidates.push(withoutExtension + extension)
      candidates.push(posix.join(base, 'index' + extension))
    }
    const match = candidates.find(candidate => uris.has(candidate))
    if (match) resolved.push(match)
  }
  return unique(resolved)
}

const SOURCE_LIKE_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go',
  '.rs', '.java', '.cs', '.cpp', '.c', '.rb', '.php', '.swift', '.kt',
]
const CONTROL_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
])

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined
}
