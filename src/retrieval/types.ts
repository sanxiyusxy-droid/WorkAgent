export type RetrievalKind = 'code' | 'documentation' | 'configuration'
export type RetrievalIntent =
  | 'implementation' | 'documentation' | 'tests' | 'configuration' | 'unknown'
export type ContextRelation = 'adjacent' | 'imports' | 'calls' | 'imported_by'

export interface RetrievalChunk {
  sourceId: string
  uri: string
  version: string
  repositoryVersion?: string
  kind: RetrievalKind
  language: string
  symbol?: string
  startLine: number
  endLine: number
  content: string
  redacted: boolean
  indexedAt: string
  termFrequencies: Record<string, number>
  termCount: number
  embedding: number[]
}

export interface RetrievalScores {
  bm25: number
  vector: number
  rrf: number
  rerank: number
  diversity: number
}

export interface RetrievalHit {
  sourceId: string
  uri: string
  version: string
  repositoryVersion?: string
  score: number
  scores: RetrievalScores
  content: string
  metadata: {
    kind: RetrievalKind
    language: string
    symbol?: string
    startLine: number
    endLine: number
    indexedAt: string
    redacted: boolean
    trust: 'untrusted_repository_content'
    citation: string
    ranking?: RankingSignals
    expansion?: {
      distance: number
      relations: ContextRelation[]
    }
  }
}

export interface RankingSignals {
  matchedTerms: string[]
  pathTerms: string[]
  symbolTerms: string[]
  coverage: number
  intentBoost: number
  exactPhrase: boolean
}

export interface RetrievalQueryPlan {
  original: string
  normalized: string
  intent: RetrievalIntent
  terms: string[]
  identifiers: string[]
  expansions: string[]
  phrases: string[]
  variants: string[]
}

export interface RetrievalTrace {
  queryPlan: RetrievalQueryPlan
  stages: {
    corpusChunks: number
    bm25Candidates: number
    vectorCandidates: number
    fusedCandidates: number
    rerankedCandidates: number
    returnedHits: number
  }
  ranking: {
    sparse: 'bm25'
    vector: string
    fusion: 'rrf-k60'
    reranker: 'local-feature-v1'
    diversity: 'mmr-v1' | 'disabled'
    maxPerFile: number
  }
  durationMs: number
}

export interface RetrievalSearchResult {
  hits: RetrievalHit[]
  trace: RetrievalTrace
  indexVersion?: string
  repositoryVersion?: string
}

export interface SearchOptions {
  limit?: number
  pathPrefix?: string
  kinds?: RetrievalKind[]
  maxChars?: number
  freshness?: 'auto' | 'cached' | 'force'
  intent?: RetrievalIntent | 'auto'
  rerank?: boolean
  diversity?: boolean
  maxPerFile?: number
  signal?: AbortSignal
}

export interface ContextEdge {
  fromSourceId: string
  toSourceId: string
  relation: ContextRelation
  distance: number
}

export interface ExpandContextOptions {
  focus?: string
  relations?: ContextRelation[]
  depth?: 1 | 2
  maxHits?: number
  maxChars?: number
  freshness?: 'auto' | 'cached' | 'force'
  signal?: AbortSignal
}

export interface ExpandedContextResult {
  seedSourceIds: string[]
  missingSourceIds: string[]
  hits: RetrievalHit[]
  edges: ContextEdge[]
  indexVersion?: string
  repositoryVersion?: string
}

export interface RefreshResult {
  indexVersion: string
  repositoryVersion?: string
  filesScanned: number
  filesUpdated: number
  filesDeleted: number
  filesReused: number
  chunks: number
  redactedChunks: number
  durationMs: number
  full: boolean
}

export interface RetrievalStatus {
  initialized: boolean
  schemaVersion: number
  indexVersion?: string
  repositoryVersion?: string
  embeddingProvider: string
  builtAt?: string
  files: number
  chunks: number
  dirtyPaths: string[]
  persistence: boolean
  cachePath?: string
}

export interface Retriever {
  search(query: string, options?: SearchOptions): Promise<RetrievalHit[]>
  searchDetailed(query: string, options?: SearchOptions): Promise<RetrievalSearchResult>
  expand(sourceIds: string[], options?: ExpandContextOptions): Promise<ExpandedContextResult>
  refresh(paths?: string[], signal?: AbortSignal): Promise<RefreshResult>
  status(): Promise<RetrievalStatus>
  invalidate(path?: string): void
}

/**
 * Batch embedding boundary. v1.2 ships with a local deterministic provider,
 * while hosted embedding models can be injected without coupling them to the
 * agent engine or tool runtime.
 */
export interface EmbeddingProvider {
  readonly id: string
  readonly dimensions: number
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>
}
