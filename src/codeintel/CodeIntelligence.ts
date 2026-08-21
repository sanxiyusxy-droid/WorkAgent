import { execFile } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
])
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs'])
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.agent', 'node_modules', 'dist', 'build', 'coverage',
  '.next', '.venv', '__pycache__',
])
const MAX_FILES = 20_000
const MAX_FILE_BYTES = 2_000_000

export type SymbolKind =
  | 'function' | 'class' | 'interface' | 'type' | 'enum'
  | 'namespace' | 'variable' | 'method'

export interface CodeSymbol {
  name: string
  kind: SymbolKind
  file: string
  line: number
  column: number
  exported: boolean
  signature: string
}

export interface CodeReference {
  symbol: string
  file: string
  line: number
  column: number
  text: string
  definition: boolean
}

export interface CallGraphNode {
  id: string
  name: string
  kind: SymbolKind
  file: string
  line: number
}

export interface CallGraphEdge {
  from: string
  to: string
  callLine: number
}

export interface CodeDiagnostic {
  file?: string
  line?: number
  column?: number
  severity: 'error' | 'warning'
  code?: string
  message: string
}

export interface DiagnosticsResult {
  available: boolean
  engine: 'typescript' | 'node-check' | 'none'
  exitCode: number | null
  diagnostics: CodeDiagnostic[]
  truncated: boolean
  detail?: string
}

interface IndexedFile {
  path: string
  lines: string[]
}

interface IndexSnapshot {
  files: IndexedFile[]
  symbols: CodeSymbol[]
  filesScanned: number
}

/**
 * Deterministic repository-level source index. It intentionally provides
 * honest lexical intelligence rather than claiming full language-server
 * semantics. One snapshot is shared by all tools and invalidated on writes.
 */
export class CodeIntelligenceService {
  private snapshot?: Promise<IndexSnapshot>
  private generation = 0

  constructor(private readonly workspaceRoot: string) {}

  invalidate(_path?: string): void {
    this.generation += 1
    this.snapshot = undefined
  }

  async symbols(query: string, limit: number, signal?: AbortSignal): Promise<{
    matches: CodeSymbol[]
    filesScanned: number
    truncated: boolean
  }> {
    const index = await this.index(signal)
    const needle = query.toLowerCase()
    const ranked = index.symbols
      .filter(symbol => symbol.name.toLowerCase().includes(needle))
      .sort((a, b) =>
        rankSymbol(a.name, needle) - rankSymbol(b.name, needle) ||
        a.name.localeCompare(b.name) || a.file.localeCompare(b.file) || a.line - b.line,
      )
    return {
      matches: ranked.slice(0, limit),
      filesScanned: index.filesScanned,
      truncated: ranked.length > limit,
    }
  }

  async references(symbol: string, limit: number, signal?: AbortSignal): Promise<{
    matches: CodeReference[]
    filesScanned: number
    truncated: boolean
  }> {
    const index = await this.index(signal)
    const references: CodeReference[] = []
    const expression = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'g')
    const definitions = new Set(
      index.symbols
        .filter(item => item.name === symbol)
        .map(item => `${item.file}:${item.line}:${item.column}`),
    )
    for (const file of index.files) {
      for (let i = 0; i < file.lines.length; i++) {
        expression.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = expression.exec(file.lines[i]!)) !== null) {
          const column = match.index + 1
          references.push({
            symbol,
            file: file.path,
            line: i + 1,
            column,
            text: file.lines[i]!.trim().slice(0, 300),
            definition: definitions.has(`${file.path}:${i + 1}:${column}`),
          })
          if (references.length > limit) {
            return {
              matches: references.slice(0, limit),
              filesScanned: index.filesScanned,
              truncated: true,
            }
          }
        }
      }
    }
    return { matches: references, filesScanned: index.filesScanned, truncated: false }
  }

  async callGraph(focus: string | undefined, limit: number, signal?: AbortSignal): Promise<{
    nodes: CallGraphNode[]
    edges: CallGraphEdge[]
    truncated: boolean
  }> {
    const index = await this.index(signal)
    const callable = index.symbols.filter(symbol =>
      symbol.kind === 'function' || symbol.kind === 'method',
    )
    const byName = new Map<string, CodeSymbol[]>()
    for (const symbol of callable) {
      byName.set(symbol.name, [...(byName.get(symbol.name) ?? []), symbol])
    }
    const edges: CallGraphEdge[] = []
    const nodeMap = new Map<string, CallGraphNode>()
    const callers = focus ? callable.filter(symbol => symbol.name === focus) : callable
    for (const caller of callers) {
      const file = index.files.find(item => item.path === caller.file)
      if (!file) continue
      const end = findBlockEnd(file.lines, caller.line - 1)
      const body = file.lines.slice(caller.line - 1, end + 1)
      for (let offset = 0; offset < body.length; offset++) {
        for (const call of body[offset]!.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
          const name = call[1]!
          if (CONTROL_WORDS.has(name) || name === caller.name) continue
          const targets = byName.get(name)
          if (!targets?.length) continue
          const target = chooseNearestTarget(caller, targets)
          const from = symbolId(caller)
          const to = symbolId(target)
          nodeMap.set(from, toNode(caller))
          nodeMap.set(to, toNode(target))
          if (!edges.some(edge => edge.from === from && edge.to === to)) {
            edges.push({ from, to, callLine: caller.line + offset })
          }
          if (edges.length >= limit) {
            return { nodes: [...nodeMap.values()], edges, truncated: true }
          }
        }
      }
    }
    return { nodes: [...nodeMap.values()], edges, truncated: false }
  }

  async diagnostics(input: {
    path?: string
    maxIssues: number
    signal?: AbortSignal
  }): Promise<DiagnosticsResult> {
    const requested = input.path ? join(this.workspaceRoot, input.path) : undefined
    const extension = requested ? extname(requested).toLowerCase() : undefined
    const tsc = join(this.workspaceRoot, 'node_modules', 'typescript', 'bin', 'tsc')
    const tsconfig = join(this.workspaceRoot, 'tsconfig.json')
    if (
      await exists(tsc) &&
      (await exists(tsconfig) || (extension && !JAVASCRIPT_EXTENSIONS.has(extension)))
    ) {
      const args = [tsc, '--noEmit', '--pretty', 'false']
      if (await exists(tsconfig)) args.push('--project', tsconfig)
      else if (requested) args.push(requested)
      return this.runDiagnosticProcess(
        'typescript', process.execPath, args, input.maxIssues, input.signal,
      )
    }
    if (requested && extension && JAVASCRIPT_EXTENSIONS.has(extension)) {
      return this.runDiagnosticProcess(
        'node-check', process.execPath, ['--check', requested], input.maxIssues, input.signal,
      )
    }
    return {
      available: false,
      engine: 'none',
      exitCode: null,
      diagnostics: [],
      truncated: false,
      detail:
        'No diagnostics engine found. Install TypeScript in the target workspace, ' +
        'or provide a JavaScript file path for node --check.',
    }
  }

  private async runDiagnosticProcess(
    engine: 'typescript' | 'node-check',
    file: string,
    args: string[],
    maxIssues: number,
    signal?: AbortSignal,
  ): Promise<DiagnosticsResult> {
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    try {
      const result = await execFileAsync(file, args, {
        cwd: this.workspaceRoot,
        signal,
        timeout: 60_000,
        maxBuffer: 4_000_000,
        windowsHide: true,
      })
      stdout = result.stdout
      stderr = result.stderr
    } catch (error) {
      const failure = error as Error & {
        stdout?: string
        stderr?: string
        code?: number | string
      }
      stdout = failure.stdout ?? ''
      stderr = failure.stderr ?? failure.message
      exitCode = typeof failure.code === 'number' ? failure.code : 1
    }
    const parsed = parseDiagnostics(`${stdout}\n${stderr}`)
    return {
      available: true,
      engine,
      exitCode,
      diagnostics: parsed.slice(0, maxIssues),
      truncated: parsed.length > maxIssues,
    }
  }

  private async index(signal?: AbortSignal): Promise<IndexSnapshot> {
    if (!this.snapshot) {
      const generation = this.generation
      this.snapshot = buildIndex(this.workspaceRoot, signal).then(snapshot => {
        if (generation !== this.generation) this.snapshot = undefined
        return snapshot
      }).catch(error => {
        if (generation === this.generation) this.snapshot = undefined
        throw error
      })
    }
    return this.snapshot
  }
}

const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function'])

async function buildIndex(root: string, signal?: AbortSignal): Promise<IndexSnapshot> {
  if (signal?.aborted) throw abortError()
  const paths: string[] = []
  await collectSourceFiles(root, paths, signal)
  const files: IndexedFile[] = []
  const symbols: CodeSymbol[] = []
  for (const absolute of paths) {
    if (signal?.aborted) throw abortError()
    let buffer: Buffer
    try {
      buffer = await readFile(absolute)
    } catch {
      continue
    }
    if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) continue
    const path = relative(root, absolute).split(sep).join('/')
    const lines = buffer.toString('utf8').split('\n')
    files.push({ path, lines })
    symbols.push(...extractSymbols(path, lines))
  }
  symbols.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  )
  return { files, symbols, filesScanned: files.length }
}

function abortError(): Error {
  return Object.assign(new Error('code index build aborted'), { name: 'AbortError' })
}

async function collectSourceFiles(
  directory: string,
  out: string[],
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || out.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (signal?.aborted || out.length >= MAX_FILES) return
    if (entry.isSymbolicLink()) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) await collectSourceFiles(full, out, signal)
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(full)
    }
  }
}

function extractSymbols(file: string, lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = []
  const declaration = /\b(function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/
  const variable = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/
  const method = /^\s*(?:(?:public|private|protected|static|async|readonly|abstract|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::[^={]+)?\s*\{?/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const declared = declaration.exec(line)
    if (declared) {
      symbols.push(makeSymbol(file, i, line, declared[2]!, declared[1] as SymbolKind))
      continue
    }
    const assigned = variable.exec(line)
    if (assigned) {
      symbols.push(makeSymbol(file, i, line, assigned[1]!, 'variable'))
      continue
    }
    const member = method.exec(line)
    if (member && !CONTROL_WORDS.has(member[1]!)) {
      symbols.push(makeSymbol(file, i, line, member[1]!, 'method'))
    }
  }
  return symbols
}

function makeSymbol(
  file: string,
  lineIndex: number,
  line: string,
  name: string,
  kind: SymbolKind,
): CodeSymbol {
  return {
    name,
    kind,
    file,
    line: lineIndex + 1,
    column: line.indexOf(name) + 1,
    exported: /\bexport\b/.test(line),
    signature: line.trim().slice(0, 300),
  }
}

function findBlockEnd(lines: string[], start: number): number {
  let depth = 0
  let started = false
  for (let i = start; i < lines.length; i++) {
    for (const char of lines[i]!) {
      if (char === '{') {
        depth += 1
        started = true
      } else if (char === '}') {
        depth -= 1
        if (started && depth <= 0) return i
      }
    }
  }
  return Math.min(lines.length - 1, start + 80)
}

function chooseNearestTarget(caller: CodeSymbol, targets: CodeSymbol[]): CodeSymbol {
  return [...targets].sort((a, b) => {
    const aSame = a.file === caller.file ? 0 : 1
    const bSame = b.file === caller.file ? 0 : 1
    return aSame - bSame ||
      Math.abs(a.line - caller.line) - Math.abs(b.line - caller.line)
  })[0]!
}

function symbolId(symbol: CodeSymbol): string {
  return `${symbol.file}:${symbol.line}:${symbol.name}`
}

function toNode(symbol: CodeSymbol): CallGraphNode {
  return {
    id: symbolId(symbol),
    name: symbol.name,
    kind: symbol.kind,
    file: symbol.file,
    line: symbol.line,
  }
}

function rankSymbol(name: string, needle: string): number {
  const lower = name.toLowerCase()
  if (lower === needle) return 0
  if (lower.startsWith(needle)) return 1
  return 2
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseDiagnostics(output: string): CodeDiagnostic[] {
  const diagnostics: CodeDiagnostic[] = []
  const typescript = /^(.*?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]+\d+):\s+(.+)$/
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const match = typescript.exec(line)
    if (match) {
      diagnostics.push({
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4] === 'warning' ? 'warning' : 'error',
        code: match[5],
        message: match[6]!,
      })
    } else {
      diagnostics.push({ severity: 'error', message: line.slice(0, 1_000) })
    }
  }
  return diagnostics
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
