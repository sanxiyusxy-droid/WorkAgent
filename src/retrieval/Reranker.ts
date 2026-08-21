import { tokenize } from './LocalHashEmbedding.js'
import type {
  RankingSignals,
  RetrievalChunk,
  RetrievalQueryPlan,
} from './types.js'

export interface RetrievalCandidate {
  chunk: RetrievalChunk
  bm25: number
  vector: number
  rrf: number
  rerank: number
  diversity: number
  signals: RankingSignals
}

export function rerankCandidates(
  candidates: RetrievalCandidate[],
  plan: RetrievalQueryPlan,
): RetrievalCandidate[] {
  const rankingTerms = [...new Set([...plan.terms, ...plan.expansions])]
  return candidates.map(candidate => {
    const pathTokens = new Set(tokenize(candidate.chunk.uri))
    const symbolTokens = new Set(tokenize(candidate.chunk.symbol ?? ''))
    const matchedTerms = rankingTerms.filter(term => Boolean(candidate.chunk.termFrequencies[term]))
    const pathTerms = rankingTerms.filter(term => pathTokens.has(term))
    const symbolTerms = rankingTerms.filter(term => symbolTokens.has(term))
    const coverage = matchedTerms.length / Math.max(rankingTerms.length, 1)
    const pathCoverage = pathTerms.length / Math.max(rankingTerms.length, 1)
    const symbolCoverage = symbolTerms.length / Math.max(rankingTerms.length, 1)
    const searchable = (
      candidate.chunk.uri + '\n' + (candidate.chunk.symbol ?? '') + '\n' +
      candidate.chunk.content
    ).toLowerCase()
    const exactPhrase = plan.phrases.some(phrase => searchable.includes(phrase)) ||
      (plan.normalized.length <= 120 && searchable.includes(plan.normalized.toLowerCase()))
    const intentBoost = intentPrior(candidate.chunk, plan)
    const density = matchedTerms.reduce(
      (sum, term) => sum + Math.min(candidate.chunk.termFrequencies[term] ?? 0, 4),
      0,
    ) / Math.max(candidate.chunk.termCount, 1)
    const rerank =
      candidate.rrf * 20 +
      Math.log1p(Math.max(0, candidate.bm25)) * 0.4 +
      Math.max(0, candidate.vector) * 0.5 +
      coverage * 3 + pathCoverage * 2.2 + symbolCoverage * 1.6 +
      (exactPhrase ? 1.5 : 0) + Math.min(density * 30, 0.8) + intentBoost
    return {
      ...candidate,
      rerank,
      signals: {
        matchedTerms,
        pathTerms,
        symbolTerms,
        coverage,
        intentBoost,
        exactPhrase,
      },
    }
  }).sort(compareCandidates)
}

export function diversifyCandidates(
  ranked: RetrievalCandidate[],
  input: {
    limit: number
    enabled: boolean
    maxPerFile: number
    lambda: number
  },
): RetrievalCandidate[] {
  if (ranked.length === 0) return []
  const min = Math.min(...ranked.map(item => item.rerank))
  const max = Math.max(...ranked.map(item => item.rerank))
  const relevance = (item: RetrievalCandidate) =>
    max === min ? 1 : (item.rerank - min) / (max - min)
  if (!input.enabled) {
    return ranked.slice(0, input.limit).map(item => ({
      ...item,
      diversity: relevance(item),
    }))
  }

  const selected: RetrievalCandidate[] = []
  const remaining = [...ranked]
  const perFile = new Map<string, number>()
  while (selected.length < input.limit && remaining.length > 0) {
    let bestIndex = -1
    let bestScore = Number.NEGATIVE_INFINITY
    for (let index = 0; index < remaining.length; index++) {
      const candidate = remaining[index]!
      if ((perFile.get(candidate.chunk.uri) ?? 0) >= input.maxPerFile) continue
      const similarity = selected.length === 0
        ? 0
        : Math.max(...selected.map(item => chunkSimilarity(candidate.chunk, item.chunk)))
      const score = input.lambda * relevance(candidate) - (1 - input.lambda) * similarity
      if (
        score > bestScore ||
        (score === bestScore && bestIndex >= 0 && compareCandidates(candidate, remaining[bestIndex]!) < 0)
      ) {
        bestIndex = index
        bestScore = score
      }
    }
    if (bestIndex < 0) break
    const [chosen] = remaining.splice(bestIndex, 1)
    selected.push({ ...chosen!, diversity: bestScore })
    perFile.set(chosen!.chunk.uri, (perFile.get(chosen!.chunk.uri) ?? 0) + 1)
  }
  return selected
}

function intentPrior(chunk: RetrievalChunk, plan: RetrievalQueryPlan): number {
  const uri = chunk.uri.toLowerCase()
  const isTest = /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\./.test(uri)
  const isDocs = chunk.kind === 'documentation' || /(^|\/)docs?\//.test(uri) ||
    /(^|\/)readme\./.test(uri)
  const isSource = /(^|\/)src\//.test(uri)
  if (plan.intent === 'tests') return isTest ? 0.9 : -0.15
  if (plan.intent === 'documentation') return isDocs ? 0.9 : -0.1
  if (plan.intent === 'configuration') return chunk.kind === 'configuration' ? 0.8 : -0.1
  if (plan.intent === 'implementation') {
    return (isSource ? 0.65 : 0) + (isTest ? -0.35 : 0) + (isDocs ? -0.25 : 0) +
      (chunk.kind === 'code' ? 0.15 : 0)
  }
  return 0
}

function chunkSimilarity(left: RetrievalChunk, right: RetrievalChunk): number {
  let similarity = 0
  const length = Math.min(left.embedding.length, right.embedding.length)
  for (let index = 0; index < length; index++) {
    similarity += (left.embedding[index] ?? 0) * (right.embedding[index] ?? 0)
  }
  if (left.uri === right.uri) similarity = Math.max(similarity, 0.85)
  return Math.max(0, Math.min(1, similarity))
}

function compareCandidates(left: RetrievalCandidate, right: RetrievalCandidate): number {
  return right.rerank - left.rerank || right.rrf - left.rrf ||
    right.bm25 - left.bm25 || right.vector - left.vector ||
    left.chunk.sourceId.localeCompare(right.chunk.sourceId)
}
