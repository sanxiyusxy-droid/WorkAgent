import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { checkPathReal } from '../policy/pathPolicy.js'
import { detectSecrets, sanitize } from '../security/secrets.js'
import { computeVersion } from '../workspace/FileVersion.js'
import { LocalHashEmbeddingProvider, tokenize } from './LocalHashEmbedding.js'
import { planRetrievalQuery } from './QueryPlanner.js'
import {
  diversifyCandidates,
  rerankCandidates,
  type RetrievalCandidate,
} from './Reranker.js'
import { expandChunkGraph } from './ContextGraph.js'
import type {
  EmbeddingProvider,
  ContextRelation,
  ExpandedContextResult,
  ExpandContextOptions,
  RefreshResult,
  RankingSignals,
  RetrievalChunk,
  RetrievalHit,
  RetrievalKind,
  RetrievalQueryPlan,
  RetrievalSearchResult,
  RetrievalStatus,
  RetrievalTrace,
  Retriever,
  SearchOptions,
} from './types.js'

const execFileAsync = promisify(execFile)
const SCHEMA_VERSION = 1
const DEFAULT_MAX_FILES = 20_000
const DEFAULT_MAX_FILE_BYTES = 1_000_000
const DEFAULT_MAX_CHUNKS = 60_000
const DEFAULT_MAX_CHUNK_LINES = 120
const DEFAULT_MAX_CHUNK_CHARS = 12_000
const DEFAULT_OVERLAP_LINES = 8
const MIN_VECTOR_SIMILARITY = 0.08

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp',
  '.rb', '.php', '.swift', '.kt', '.kts', '.scala', '.sql', '.sh', '.ps1',
])
const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt'])
const CONFIG_EXTENSIONS = new Set([
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml',
])
const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.agent', 'node_modules', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'target', 'vendor',
])
const IGNORED_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'composer.lock', 'cargo.lock', 'agent.config.json',
  'retrieval-cases.json',
  'context-graph-cases.json', 'retrieval-baseline.json',
])
const SENSITIVE_NAME = /(?:^|[._-])(secret|secrets|credential|credentials|token|tokens|password|passwd|private|keystore)(?:[._-]|$)/i

interface IndexedFileRecord {
  uri: string
  version: string
  size: number
  mtimeMs: number
  chunks: RetrievalChunk[]
}

interface IndexCache {
  schemaVersion: number
  embeddingProvider: string
  embeddingDimensions: number
  builtAt: string
  indexVersion: string
  repositoryVersion?: string
  files: Record<string, IndexedFileRecord>
}

interface FileManifest {
  uri: string
  absolute: string
  size: number
  mtimeMs: number
}

interface ChunkDraft extends Omit<RetrievalChunk, 'embedding'> {}

export interface CodeRetrieverOptions {
  persistence?: boolean
  refreshOnSearch?: boolean
  cacheDir?: string
  maxFiles?: number
  maxFileBytes?: number
  maxChunks?: number
  embeddingProvider?: EmbeddingProvider
  defaultMaxPerFile?: number
  diversityLambda?: number
  now?: () => number
}

/**
 * Versioned repository retriever. Index mutation is serialized internally;
 * readers always observe one immutable cache generation. Search is hybrid:
 * BM25 and vector rankings are fused with Reciprocal Rank Fusion (RRF).
 */
export class CodeRetriever implements Retriever {
  private cache?: IndexCache
  private cacheLoaded = false
  private readonly dirtyPaths = new Set<string>()
  private operation: Promise<void> = Promise.resolve()
  private readonly persistence: boolean
  private readonly refreshOnSearch: boolean
  private readonly cachePath: string
  private readonly maxFiles: number
  private readonly maxFileBytes: number
  private readonly maxChunks: number
  private readonly embedding: EmbeddingProvider
  private readonly defaultMaxPerFile: number
  private readonly diversityLambda: number
  private readonly now: () => number

  constructor(
    private readonly workspaceRoot: string,
    options: CodeRetrieverOptions = {},
  ) {
    this.persistence = options.persistence !== false
    this.refreshOnSearch = options.refreshOnSearch !== false
    this.cachePath = join(
      options.cacheDir ?? join(workspaceRoot, '.agent', 'index'),
      'code-rag-v1.json',
    )
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS
    this.embedding = options.embeddingProvider ?? new LocalHashEmbeddingProvider()
    this.defaultMaxPerFile = clamp(options.defaultMaxPerFile ?? 3, 1, 20)
    this.diversityLambda = Math.min(1, Math.max(0, options.diversityLambda ?? 0.75))
    this.now = options.now ?? Date.now
  }

  invalidate(path?: string): void {
    if (!path) {
      this.dirtyPaths.add('*')
      return
    }
    this.dirtyPaths.add(normalizeUri(path))
  }

  async search(query: string, options: SearchOptions = {}): Promise<RetrievalHit[]> {
    return (await this.searchDetailed(query, options)).hits
  }

  async searchDetailed(
    query: string,
    options: SearchOptions = {},
  ): Promise<RetrievalSearchResult> {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length === 0) throw new Error('retrieval query must not be empty')
    return this.exclusive(async () => {
      const started = this.now()
      const queryPlan = planRetrievalQuery(normalizedQuery, options.intent ?? 'auto')
      await this.ensureFresh(options.freshness ?? 'auto', options.signal)
      const cache = this.cache
      if (!cache) {
        return {
          hits: [],
          trace: makeTrace(queryPlan, this.embedding.id, {
            corpusChunks: 0,
            bm25Candidates: 0,
            vectorCandidates: 0,
            fusedCandidates: 0,
            rerankedCandidates: 0,
            returnedHits: 0,
          }, 0, this.defaultMaxPerFile, options.diversity !== false),
        }
      }

      const limit = clamp(options.limit ?? 8, 1, 50)
      const maxChars = clamp(options.maxChars ?? 30_000, 500, 100_000)
      const maxPerFile = clamp(options.maxPerFile ?? this.defaultMaxPerFile, 1, 20)
      const prefix = options.pathPrefix ? normalizeUri(options.pathPrefix) : undefined
      const kinds = options.kinds ? new Set(options.kinds) : undefined
      const chunks = Object.values(cache.files)
        .flatMap(file => file.chunks)
        .filter(chunk => !prefix || chunk.uri === prefix || chunk.uri.startsWith(prefix + '/'))
        .filter(chunk => !kinds || kinds.has(chunk.kind))
      if (chunks.length === 0) {
        return {
          hits: [],
          indexVersion: cache.indexVersion,
          repositoryVersion: cache.repositoryVersion,
          trace: makeTrace(queryPlan, this.embedding.id, {
            corpusChunks: 0,
            bm25Candidates: 0,
            vectorCandidates: 0,
            fusedCandidates: 0,
            rerankedCandidates: 0,
            returnedHits: 0,
          }, Math.max(0, this.now() - started), maxPerFile, options.diversity !== false),
        }
      }

      const averageLength = chunks.reduce((sum, chunk) => sum + chunk.termCount, 0) /
        Math.max(chunks.length, 1)
      const candidates = new Map<string, RetrievalCandidate>()
      for (const chunk of chunks) {
        candidates.set(chunk.sourceId, {
          chunk,
          bm25: 0,
          vector: 0,
          rrf: 0,
          rerank: 0,
          diversity: 0,
          signals: emptyRankingSignals(),
        })
      }
      const variants = queryPlan.variants.length > 0
        ? queryPlan.variants
        : [normalizedQuery]
      const vectors = await this.embedding.embed(variants, options.signal)
      const bm25CandidateIds = new Set<string>()
      const vectorCandidateIds = new Set<string>()
      const candidateCount = Math.min(chunks.length, Math.max(100, limit * 12))
      for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
        const variant = variants[variantIndex]!
        const terms = [...new Set(tokenize(variant))].filter(term => term.length > 1)
        const documentFrequency = new Map<string, number>()
        for (const term of terms) {
          documentFrequency.set(
            term,
            chunks.reduce((count, chunk) =>
              count + (chunk.termFrequencies[term] ? 1 : 0), 0),
          )
        }
        const vector = vectors[variantIndex] ?? []
        const current = [...candidates.values()].map(candidate => {
          const bm25 = bm25Score(
            candidate.chunk,
            terms,
            documentFrequency,
            chunks.length,
            averageLength,
          )
          const vectorScore = dot(vector, candidate.chunk.embedding)
          candidate.bm25 = Math.max(candidate.bm25, bm25)
          candidate.vector = Math.max(candidate.vector, vectorScore)
          return { candidate, bm25, vector: vectorScore }
        })
        const bm25Rank = current
          .filter(item => item.bm25 > 0)
          .sort((a, b) => b.bm25 - a.bm25 ||
            a.candidate.chunk.sourceId.localeCompare(b.candidate.chunk.sourceId))
          .slice(0, candidateCount)
        const vectorRank = current
          .filter(item => item.vector >= MIN_VECTOR_SIMILARITY)
          .sort((a, b) => b.vector - a.vector ||
            a.candidate.chunk.sourceId.localeCompare(b.candidate.chunk.sourceId))
          .slice(0, candidateCount)
        const weight = variantIndex === 0 ? 1 : 0.75
        addCandidateRrf(bm25Rank.map(item => item.candidate), weight, bm25CandidateIds)
        addCandidateRrf(vectorRank.map(item => item.candidate), weight, vectorCandidateIds)
      }

      const fused = [...candidates.values()].filter(candidate => candidate.rrf > 0)
      const reranked = options.rerank === false
        ? fused.map(candidate => ({
            ...candidate,
            rerank: candidate.rrf,
            signals: emptyRankingSignals(),
          })).sort((a, b) => b.rerank - a.rerank ||
            a.chunk.sourceId.localeCompare(b.chunk.sourceId))
        : rerankCandidates(fused, queryPlan)
      const ranked = diversifyCandidates(reranked, {
        limit,
        enabled: options.diversity !== false,
        maxPerFile,
        lambda: this.diversityLambda,
      })
      const hits: RetrievalHit[] = []
      let remainingChars = maxChars
      for (const item of ranked) {
        if (hits.length >= limit || remainingChars < 200) break
        const content = item.chunk.content.length <= remainingChars
          ? item.chunk.content
          : item.chunk.content.slice(0, Math.max(0, remainingChars - 24)) + '\n[chunk truncated]'
        remainingChars -= content.length
        hits.push(toHit(item.chunk, item, content))
      }
      return {
        hits,
        indexVersion: cache.indexVersion,
        repositoryVersion: cache.repositoryVersion,
        trace: makeTrace(queryPlan, this.embedding.id, {
          corpusChunks: chunks.length,
          bm25Candidates: bm25CandidateIds.size,
          vectorCandidates: vectorCandidateIds.size,
          fusedCandidates: fused.length,
          rerankedCandidates: reranked.length,
          returnedHits: hits.length,
        }, Math.max(0, this.now() - started), maxPerFile, options.diversity !== false),
      }
    })
  }

  async expand(
    sourceIds: string[],
    options: ExpandContextOptions = {},
  ): Promise<ExpandedContextResult> {
    return this.exclusive(async () => {
      await this.ensureFresh(options.freshness ?? 'auto', options.signal)
      const cache = this.cache
      const seedSourceIds = [...new Set(sourceIds)].slice(0, 50)
      if (!cache) {
        return { seedSourceIds, missingSourceIds: seedSourceIds, hits: [], edges: [] }
      }
      const maxHits = clamp(options.maxHits ?? 20, 1, 50)
      const maxChars = clamp(options.maxChars ?? 40_000, 500, 100_000)
      const relations = options.relations ?? ['adjacent', 'imports', 'calls']
      const graph = expandChunkGraph(
        Object.values(cache.files).flatMap(file => file.chunks),
        seedSourceIds,
        {
          relations,
          depth: options.depth ?? 1,
          maxHits,
          focusTerms: options.focus ? [...new Set(tokenize(options.focus))] : [],
        },
      )
      let remainingChars = maxChars
      const hits: RetrievalHit[] = []
      for (const item of graph.discovered) {
        if (hits.length >= maxHits || remainingChars < 200) break
        const content = item.chunk.content.length <= remainingChars
          ? item.chunk.content
          : item.chunk.content.slice(0, Math.max(0, remainingChars - 24)) +
            '\n[chunk truncated]'
        remainingChars -= content.length
        hits.push(toExpandedHit(item.chunk, content, item.distance, item.relations))
      }
      const returnedIds = new Set([...seedSourceIds, ...hits.map(hit => hit.sourceId)])
      return {
        seedSourceIds,
        missingSourceIds: graph.missingSourceIds,
        hits,
        edges: graph.edges.filter(edge =>
          returnedIds.has(edge.fromSourceId) && returnedIds.has(edge.toSourceId),
        ),
        indexVersion: cache.indexVersion,
        repositoryVersion: cache.repositoryVersion,
      }
    })
  }

  async refresh(paths?: string[], signal?: AbortSignal): Promise<RefreshResult> {
    return this.exclusive(() => this.refreshInternal(paths, signal))
  }

  async status(): Promise<RetrievalStatus> {
    return this.exclusive(async () => {
      await this.loadCache()
      const files = this.cache ? Object.keys(this.cache.files).length : 0
      const chunks = this.cache
        ? Object.values(this.cache.files).reduce((sum, file) => sum + file.chunks.length, 0)
        : 0
      return {
        initialized: Boolean(this.cache),
        schemaVersion: SCHEMA_VERSION,
        indexVersion: this.cache?.indexVersion,
        repositoryVersion: this.cache?.repositoryVersion,
        embeddingProvider: this.embedding.id,
        builtAt: this.cache?.builtAt,
        files,
        chunks,
        dirtyPaths: [...this.dirtyPaths].sort(),
        persistence: this.persistence,
        cachePath: this.persistence ? this.cachePath : undefined,
      }
    })
  }

  private async ensureFresh(
    freshness: NonNullable<SearchOptions['freshness']>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.loadCache()
    if (freshness === 'force') {
      await this.refreshInternal(undefined, signal, true)
      return
    }
    if (!this.cache) {
      await this.refreshInternal(undefined, signal)
      return
    }
    if (this.dirtyPaths.size > 0) {
      const dirty = this.dirtyPaths.has('*') ? undefined : [...this.dirtyPaths]
      await this.refreshInternal(dirty, signal)
      return
    }
    if (freshness === 'auto' && this.refreshOnSearch) {
      await this.refreshInternal(undefined, signal)
    }
  }

  private async refreshInternal(
    paths?: string[],
    signal?: AbortSignal,
    forceAll = false,
  ): Promise<RefreshResult> {
    const started = this.now()
    // The public service can be called without going through the tool runtime.
    // Re-check explicit paths immediately before discovery so symlinks and
    // Windows junctions cannot escape the workspace boundary.
    for (const path of paths ?? []) {
      const check = await checkPathReal(path, this.workspaceRoot, { read: true })
      if (!check.ok) {
        throw new Error(`refresh path rejected: ${check.reason ?? 'invalid_path'}`)
      }
    }
    await this.loadCache()
    if (signal?.aborted) throw abortError()
    const full = !paths || paths.length === 0
    const discovery = await discoverFiles({
      root: this.workspaceRoot,
      paths,
      maxFiles: this.maxFiles,
      maxFileBytes: this.maxFileBytes,
      signal,
    })
    const previous = this.cache
    const nextFiles: Record<string, IndexedFileRecord> = previous
      ? { ...previous.files }
      : {}
    const forced = new Set(
      this.dirtyPaths.has('*')
        ? discovery.manifests.keys()
        : [...this.dirtyPaths],
    )
    if (paths) for (const path of paths) forced.add(normalizeUri(path))

    let filesUpdated = 0
    let filesReused = 0
    let filesDeleted = 0
    const repositoryVersion = await resolveRepositoryVersion(this.workspaceRoot)
    const repositoryChanged = previous?.repositoryVersion !== repositoryVersion
    let changed = !previous || previous.embeddingProvider !== this.embedding.id || repositoryChanged
    const indexedAt = new Date(this.now()).toISOString()

    for (const manifest of discovery.manifests.values()) {
      if (signal?.aborted) throw abortError()
      const old = previous?.files[manifest.uri]
      const explicitlyDirty = forceAll || [...forced].some(path =>
        path === manifest.uri || path === '*' || manifest.uri.startsWith(path + '/'),
      )
      if (
        old && !explicitlyDirty && old.size === manifest.size &&
        old.mtimeMs === manifest.mtimeMs && previous?.embeddingProvider === this.embedding.id
      ) {
        nextFiles[manifest.uri] = repositoryChanged
          ? {
              ...old,
              chunks: old.chunks.map(chunk => ({ ...chunk, repositoryVersion })),
            }
          : old
        filesReused += 1
        continue
      }
      const indexed = await this.indexFile(manifest, repositoryVersion, indexedAt, signal)
      if (indexed) {
        nextFiles[manifest.uri] = indexed
        filesUpdated += 1
        changed = true
      } else if (nextFiles[manifest.uri]) {
        delete nextFiles[manifest.uri]
        filesDeleted += 1
        changed = true
      }
    }

    for (const uri of Object.keys(nextFiles)) {
      const inScope = full || discovery.scopes.some(scope =>
        uri === scope || uri.startsWith(scope + '/'),
      )
      if (inScope && !discovery.manifests.has(uri)) {
        delete nextFiles[uri]
        filesDeleted += 1
        changed = true
      }
    }

    trimChunkBudget(nextFiles, this.maxChunks)
    const chunks = Object.values(nextFiles).reduce((sum, file) => sum + file.chunks.length, 0)
    const redactedChunks = Object.values(nextFiles).reduce(
      (sum, file) => sum + file.chunks.filter(chunk => chunk.redacted).length,
      0,
    )
    if (changed || !previous) {
      const cache: IndexCache = {
        schemaVersion: SCHEMA_VERSION,
        embeddingProvider: this.embedding.id,
        embeddingDimensions: this.embedding.dimensions,
        builtAt: indexedAt,
        indexVersion: computeIndexVersion(nextFiles, this.embedding.id, repositoryVersion),
        repositoryVersion,
        files: nextFiles,
      }
      this.cache = cache
      if (this.persistence) await this.persist(cache)
    }
    this.dirtyPaths.clear()
    return {
      indexVersion: this.cache?.indexVersion ??
        computeIndexVersion(nextFiles, this.embedding.id, repositoryVersion),
      repositoryVersion: this.cache?.repositoryVersion ?? repositoryVersion,
      filesScanned: discovery.manifests.size,
      filesUpdated,
      filesDeleted,
      filesReused,
      chunks,
      redactedChunks,
      durationMs: Math.max(0, this.now() - started),
      full,
    }
  }

  private async indexFile(
    manifest: FileManifest,
    repositoryVersion: string | undefined,
    indexedAt: string,
    signal?: AbortSignal,
  ): Promise<IndexedFileRecord | undefined> {
    let buffer: Buffer
    try {
      buffer = await readFile(manifest.absolute)
    } catch {
      return undefined
    }
    if (signal?.aborted) throw abortError()
    if (buffer.length > this.maxFileBytes || buffer.includes(0)) return undefined
    const raw = buffer.toString('utf8')
    const version = computeVersion(buffer)
    const redacted = detectSecrets(raw).length > 0
    const safeContent = sanitize(raw)
    const drafts = chunkDocument({
      uri: manifest.uri,
      content: safeContent,
      version,
      repositoryVersion,
      indexedAt,
      redacted,
    })
    const embeddings = await this.embedding.embed(
      drafts.map(draft => retrievalEmbeddingText(draft)),
      signal,
    )
    const chunks = drafts.map((draft, index) => ({
      ...draft,
      embedding: embeddings[index] ?? new Array(this.embedding.dimensions).fill(0),
    }))
    return {
      uri: manifest.uri,
      version,
      size: manifest.size,
      mtimeMs: manifest.mtimeMs,
      chunks,
    }
  }

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) return
    this.cacheLoaded = true
    if (!this.persistence) return
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, 'utf8')) as unknown
      if (isValidCache(parsed, this.embedding, this.maxFiles, this.maxChunks)) {
        this.cache = parsed
      }
    } catch {
      // Missing or partial cache is recoverable: the next search rebuilds it.
    }
  }

  private async persist(cache: IndexCache): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true })
    const temporary = this.cachePath + '.' + process.pid + '.tmp'
    await writeFile(temporary, JSON.stringify(cache), 'utf8')
    try {
      await rename(temporary, this.cachePath)
    } catch {
      await rm(this.cachePath, { force: true })
      await rename(temporary, this.cachePath)
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }
}

export function chunkDocument(input: {
  uri: string
  content: string
  version: string
  repositoryVersion?: string
  indexedAt: string
  redacted?: boolean
}): ChunkDraft[] {
  const extension = extname(input.uri).toLowerCase()
  const kind = kindForExtension(extension) ?? 'configuration'
  const language = languageForExtension(extension)
  const lines = input.content.split(/\r?\n/)
  const boundaries = kind === 'documentation'
    ? documentBoundaries(lines)
    : kind === 'code'
      ? codeBoundaries(lines)
      : []
  const segments = makeSegments(lines.length, boundaries)
  const drafts: ChunkDraft[] = []
  let fragment = 0
  for (const segment of segments) {
    let start = segment.start
    while (start <= segment.end) {
      let end = Math.min(segment.end, start + DEFAULT_MAX_CHUNK_LINES - 1)
      let content = lines.slice(start, end + 1).join('\n').trimEnd()
      while (end > start && content.length > DEFAULT_MAX_CHUNK_CHARS) {
        end -= 1
        content = lines.slice(start, end + 1).join('\n').trimEnd()
      }
      if (content.length > DEFAULT_MAX_CHUNK_CHARS) {
        content = content.slice(0, DEFAULT_MAX_CHUNK_CHARS)
      }
      if (content.trim().length > 0) {
        const sourceId = makeSourceId(
          input.uri,
          input.version,
          start + 1,
          end + 1,
          segment.symbol,
          fragment,
        )
        const terms = tokenize(input.uri + '\n' + (segment.symbol ?? '') + '\n' + content)
        drafts.push({
          sourceId,
          uri: input.uri,
          version: input.version,
          repositoryVersion: input.repositoryVersion,
          kind,
          language,
          symbol: segment.symbol,
          startLine: start + 1,
          endLine: end + 1,
          content,
          redacted: input.redacted ?? false,
          indexedAt: input.indexedAt,
          termFrequencies: countTerms(terms),
          termCount: terms.length,
        })
        fragment += 1
      }
      if (end >= segment.end) break
      start = Math.max(start + 1, end - DEFAULT_OVERLAP_LINES + 1)
    }
  }
  return drafts
}

function codeBoundaries(lines: string[]): Array<{ line: number; symbol?: string }> {
  const boundaries: Array<{ line: number; symbol?: string }> = []
  const declaration = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|struct|trait|impl|def|fn)\s+([A-Za-z_$][\w$]*)/
  const assigned = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/
  let depth = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (depth === 0) {
      const match = declaration.exec(line) ?? assigned.exec(line)
      if (match) boundaries.push({ line: index, symbol: match[1] })
    }
    depth = Math.max(0, depth + braceDelta(line))
  }
  return boundaries
}

function documentBoundaries(lines: string[]): Array<{ line: number; symbol?: string }> {
  const result: Array<{ line: number; symbol?: string }> = []
  for (let index = 0; index < lines.length; index++) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(lines[index] ?? '')
    if (match) result.push({ line: index, symbol: match[1]!.slice(0, 160) })
  }
  return result
}

function makeSegments(
  lineCount: number,
  boundaries: Array<{ line: number; symbol?: string }>,
): Array<{ start: number; end: number; symbol?: string }> {
  if (lineCount === 0) return []
  if (boundaries.length === 0) return [{ start: 0, end: lineCount - 1 }]
  const segments: Array<{ start: number; end: number; symbol?: string }> = []
  if (boundaries[0]!.line > 0) {
    segments.push({ start: 0, end: boundaries[0]!.line - 1 })
  }
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index]!
    const end = (boundaries[index + 1]?.line ?? lineCount) - 1
    segments.push({ start: boundary.line, end, symbol: boundary.symbol })
  }
  return segments
}

async function discoverFiles(input: {
  root: string
  paths?: string[]
  maxFiles: number
  maxFileBytes: number
  signal?: AbortSignal
}): Promise<{ manifests: Map<string, FileManifest>; scopes: string[] }> {
  const manifests = new Map<string, FileManifest>()
  const scopes = (input.paths ?? []).map(normalizeUri)
  if (!input.paths || input.paths.length === 0) {
    await walkDirectory(input.root, input, manifests)
    return { manifests, scopes: [''] }
  }
  for (const path of input.paths) {
    if (input.signal?.aborted || manifests.size >= input.maxFiles) break
    const absolute = resolve(input.root, path)
    let metadata
    try {
      metadata = await stat(absolute)
    } catch {
      continue
    }
    if (metadata.isDirectory()) {
      await walkDirectory(absolute, input, manifests)
    } else if (metadata.isFile()) {
      await addManifest(absolute, input, manifests, metadata)
    }
  }
  return { manifests, scopes }
}

async function walkDirectory(
  directory: string,
  input: {
    root: string
    maxFiles: number
    maxFileBytes: number
    signal?: AbortSignal
  },
  manifests: Map<string, FileManifest>,
): Promise<void> {
  if (input.signal?.aborted || manifests.size >= input.maxFiles) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (input.signal?.aborted || manifests.size >= input.maxFiles) return
    if (entry.isSymbolicLink()) continue
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        await walkDirectory(absolute, input, manifests)
      }
    } else if (entry.isFile()) {
      await addManifest(absolute, input, manifests)
    }
  }
}

async function addManifest(
  absolute: string,
  input: { root: string; maxFileBytes: number },
  manifests: Map<string, FileManifest>,
  known?: Stats,
): Promise<void> {
  const uri = relative(input.root, absolute).split(sep).join('/')
  if (!isIndexable(uri)) return
  let metadata = known
  try {
    metadata ??= await stat(absolute)
  } catch {
    return
  }
  if (!metadata.isFile() || metadata.size > input.maxFileBytes) return
  manifests.set(uri, {
    uri,
    absolute,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
  })
}

function isIndexable(uri: string): boolean {
  const normalized = normalizeUri(uri)
  const parts = normalized.split('/')
  const name = parts[parts.length - 1]?.toLowerCase() ?? ''
  if (parts.some(part => IGNORED_DIRECTORIES.has(part.toLowerCase()))) return false
  if (IGNORED_FILES.has(name)) return false
  const extension = extname(name)
  const kind = kindForExtension(extension)
  if (!kind) return false
  if (kind === 'configuration' && SENSITIVE_NAME.test(name)) return false
  return true
}

function kindForExtension(extension: string): RetrievalKind | undefined {
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'documentation'
  if (CONFIG_EXTENSIONS.has(extension)) return 'configuration'
  return undefined
}

function languageForExtension(extension: string): string {
  const names: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust', '.cs': 'csharp',
    '.cpp': 'cpp', '.cc': 'cpp', '.c': 'c', '.h': 'c', '.hpp': 'cpp',
    '.md': 'markdown', '.mdx': 'markdown', '.yaml': 'yaml', '.yml': 'yaml',
    '.json': 'json', '.jsonc': 'jsonc', '.toml': 'toml', '.sql': 'sql',
    '.sh': 'shell', '.ps1': 'powershell',
  }
  return names[extension] ?? (extension.replace(/^\./, '') || 'text')
}

function retrievalEmbeddingText(chunk: ChunkDraft): string {
  return chunk.uri + '\n' + (chunk.symbol ?? '') + '\n' + chunk.content
}

function countTerms(tokens: string[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>
  for (const token of tokens) counts[token] = (counts[token] ?? 0) + 1
  return counts
}

function bm25Score(
  chunk: RetrievalChunk,
  terms: string[],
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageLength: number,
): number {
  const k1 = 1.5
  const b = 0.75
  let score = 0
  for (const term of terms) {
    const frequency = chunk.termFrequencies[term] ?? 0
    if (frequency === 0) continue
    const df = documentFrequency.get(term) ?? 0
    const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5))
    const denominator = frequency + k1 *
      (1 - b + b * chunk.termCount / Math.max(averageLength, 1))
    score += idf * frequency * (k1 + 1) / denominator
  }
  return score
}

function addCandidateRrf(
  ranking: RetrievalCandidate[],
  weight: number,
  candidateIds: Set<string>,
): void {
  for (let index = 0; index < ranking.length; index++) {
    const item = ranking[index]!
    item.rrf += weight / (60 + index + 1)
    candidateIds.add(item.chunk.sourceId)
  }
}

function toHit(
  chunk: RetrievalChunk,
  candidate: RetrievalCandidate,
  content: string,
): RetrievalHit {
  const citation = '[src:' + chunk.sourceId + '] ' + chunk.uri + ':' +
    chunk.startLine + '-' + chunk.endLine + '@' + shortVersion(chunk.version)
  return {
    sourceId: chunk.sourceId,
    uri: chunk.uri,
    version: chunk.version,
    repositoryVersion: chunk.repositoryVersion,
    score: round(candidate.rerank),
    scores: {
      bm25: round(candidate.bm25),
      vector: round(candidate.vector),
      rrf: round(candidate.rrf),
      rerank: round(candidate.rerank),
      diversity: round(candidate.diversity),
    },
    content,
    metadata: {
      kind: chunk.kind,
      language: chunk.language,
      symbol: chunk.symbol,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      indexedAt: chunk.indexedAt,
      redacted: chunk.redacted,
      trust: 'untrusted_repository_content',
      citation,
      ranking: candidate.signals,
    },
  }
}

function toExpandedHit(
  chunk: RetrievalChunk,
  content: string,
  distance: number,
  relations: ContextRelation[],
): RetrievalHit {
  const hit = toHit(chunk, {
    chunk,
    bm25: 0,
    vector: 0,
    rrf: 0,
    rerank: 1 / (distance + 1),
    diversity: 0,
    signals: emptyRankingSignals(),
  }, content)
  return {
    ...hit,
    metadata: {
      ...hit.metadata,
      ranking: undefined,
      expansion: { distance, relations },
    },
  }
}

function emptyRankingSignals(): RankingSignals {
  return {
    matchedTerms: [],
    pathTerms: [],
    symbolTerms: [],
    coverage: 0,
    intentBoost: 0,
    exactPhrase: false,
  }
}

function makeTrace(
  queryPlan: RetrievalQueryPlan,
  vectorProvider: string,
  stages: RetrievalTrace['stages'],
  durationMs: number,
  maxPerFile: number,
  diversity: boolean,
): RetrievalTrace {
  return {
    queryPlan,
    stages,
    ranking: {
      sparse: 'bm25',
      vector: vectorProvider,
      fusion: 'rrf-k60',
      reranker: 'local-feature-v1',
      diversity: diversity ? 'mmr-v1' : 'disabled',
      maxPerFile,
    },
    durationMs,
  }
}

function makeSourceId(
  uri: string,
  version: string,
  startLine: number,
  endLine: number,
  symbol: string | undefined,
  fragment: number,
): string {
  return createHash('sha256')
    .update([uri, version, startLine, endLine, symbol ?? '', fragment].join('\0'))
    .digest('hex')
    .slice(0, 20)
}

function computeIndexVersion(
  files: Record<string, IndexedFileRecord>,
  provider: string,
  repositoryVersion?: string,
): string {
  const manifest = Object.values(files)
    .sort((a, b) => a.uri.localeCompare(b.uri))
    .map(file => file.uri + '\0' + file.version + '\0' +
      file.chunks.map(chunk => chunk.sourceId).join(','))
    .join('\n')
  return 'sha256:' + createHash('sha256')
    .update(provider + '\n' + (repositoryVersion ?? 'no-git') + '\n' + manifest)
    .digest('hex')
}

function trimChunkBudget(files: Record<string, IndexedFileRecord>, maxChunks: number): void {
  let remaining = maxChunks
  for (const file of Object.values(files).sort((a, b) => a.uri.localeCompare(b.uri))) {
    if (remaining <= 0) file.chunks = []
    else if (file.chunks.length > remaining) file.chunks = file.chunks.slice(0, remaining)
    remaining -= file.chunks.length
  }
}

function braceDelta(line: string): number {
  const withoutStrings = line.replace(/(['"`]).*?\1/g, '')
  let delta = 0
  for (const character of withoutStrings) {
    if (character === '{') delta += 1
    else if (character === '}') delta -= 1
  }
  return delta
}

function normalizeUri(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
}

function dot(left: number[], right: number[]): number {
  let value = 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    value += (left[index] ?? 0) * (right[index] ?? 0)
  }
  return value
}

function shortVersion(version: string): string {
  return version.replace(/^sha256:/, '').slice(0, 12)
}

function round(value: number): number {
  return Number(value.toFixed(8))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function abortError(): Error {
  return Object.assign(new Error('code retrieval operation aborted'), { name: 'AbortError' })
}

async function resolveRepositoryVersion(root: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      timeout: 3_000,
      windowsHide: true,
      maxBuffer: 32_000,
    })
    const value = result.stdout.trim()
    return /^[0-9a-f]{40}$/i.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isValidCache(
  value: unknown,
  embedding: EmbeddingProvider,
  maxFiles: number,
  maxChunks: number,
): value is IndexCache {
  if (!isRecord(value)) return false
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    value.embeddingProvider !== embedding.id ||
    value.embeddingDimensions !== embedding.dimensions ||
    typeof value.builtAt !== 'string' ||
    typeof value.indexVersion !== 'string' ||
    !value.indexVersion.startsWith('sha256:') ||
    !isRecord(value.files)
  ) return false
  if (
    value.repositoryVersion !== undefined &&
    (typeof value.repositoryVersion !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(value.repositoryVersion))
  ) return false
  const files = Object.entries(value.files)
  if (files.length > maxFiles) return false
  let chunkCount = 0
  for (const [key, rawFile] of files) {
    if (!isRecord(rawFile) || !isSafeCacheUri(key)) return false
    if (
      rawFile.uri !== key ||
      typeof rawFile.version !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/i.test(rawFile.version) ||
      typeof rawFile.size !== 'number' || !Number.isFinite(rawFile.size) || rawFile.size < 0 ||
      typeof rawFile.mtimeMs !== 'number' || !Number.isFinite(rawFile.mtimeMs) ||
      !Array.isArray(rawFile.chunks)
    ) return false
    chunkCount += rawFile.chunks.length
    if (chunkCount > maxChunks) return false
    for (const rawChunk of rawFile.chunks) {
      if (!isRecord(rawChunk)) return false
      if (
        typeof rawChunk.sourceId !== 'string' || !/^[0-9a-f]{20}$/i.test(rawChunk.sourceId) ||
        rawChunk.uri !== key || rawChunk.version !== rawFile.version ||
        !isRetrievalKind(rawChunk.kind) || typeof rawChunk.language !== 'string' ||
        (rawChunk.symbol !== undefined && typeof rawChunk.symbol !== 'string') ||
        typeof rawChunk.startLine !== 'number' || !Number.isInteger(rawChunk.startLine) ||
        typeof rawChunk.endLine !== 'number' || !Number.isInteger(rawChunk.endLine) ||
        rawChunk.startLine < 1 || rawChunk.endLine < rawChunk.startLine ||
        typeof rawChunk.content !== 'string' ||
        rawChunk.content.length > DEFAULT_MAX_CHUNK_CHARS + 1 ||
        detectSecrets(rawChunk.content).length > 0 ||
        typeof rawChunk.redacted !== 'boolean' || typeof rawChunk.indexedAt !== 'string' ||
        !isRecord(rawChunk.termFrequencies) ||
        typeof rawChunk.termCount !== 'number' || !Number.isInteger(rawChunk.termCount) ||
        rawChunk.termCount < 0 || !Array.isArray(rawChunk.embedding) ||
        rawChunk.embedding.length !== embedding.dimensions ||
        !rawChunk.embedding.every(item => typeof item === 'number' && Number.isFinite(item))
      ) return false
    }
  }
  return true
}

function isSafeCacheUri(uri: string): boolean {
  if (uri.length === 0 || uri.includes('\0') || uri.includes('\\')) return false
  if (uri.startsWith('/') || /^[A-Za-z]:/.test(uri)) return false
  if (uri.split('/').some(part => part === '..' || part === '')) return false
  return isIndexable(uri)
}

function isRetrievalKind(value: unknown): value is RetrievalKind {
  return value === 'code' || value === 'documentation' || value === 'configuration'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
