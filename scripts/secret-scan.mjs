#!/usr/bin/env node
/**
 * Pre-commit secret scanner.
 *
 * Usage:
 *   node scripts/secret-scan.mjs                         scan staged files (git)
 *   node scripts/secret-scan.mjs --staged --allow-empty  pre-commit scan
 *   node scripts/secret-scan.mjs --all                   scan all tracked files
 *   node scripts/secret-scan.mjs --all --include-dir X   also scan package output
 *   node scripts/secret-scan.mjs --dir X                 scan a directory tree (no git)
 *
 * Behavior outside a git repository: instead of silently skipping (which
 * produces a false green), the scanner walks the whole project directory.
 *
 * Install as a git hook:
 *   copy to .git/hooks/pre-commit (or use husky/simple-git-hooks)
 *
 * Exit code 1 if any secret is found; exit code 2 if the scan cannot cover
 * its selected files (including an unintentional empty selection).
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const rootReal = realpathSync(root)
const GIT_MAX_BUFFER = 64 * 1024 * 1024

function runGit(args) {
  return execFileSync('git', args, {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
  })
}

function gitFailureSummary(error) {
  if (error && typeof error === 'object') {
    if ('code' in error && error.code === 'ENOBUFS') return 'output exceeded the 64 MiB safety limit'
    if ('status' in error && typeof error.status === 'number') return `exit status ${error.status}`
    if ('code' in error && typeof error.code === 'string') return error.code
  }
  return error instanceof Error ? error.message : String(error)
}

function inspectGitWorktree() {
  try {
    const result = runGit(['rev-parse', '--is-inside-work-tree']).toString('utf8').trim()
    if (result === 'true') return true
    if (result === 'false') {
      throw new Error('the project is a Git repository but not a working tree')
    }
    throw new Error(`unexpected Git worktree response: ${JSON.stringify(result)}`)
  } catch (error) {
    // Git uses status 128 for a directory that is genuinely outside a
    // repository. Every other probe failure (missing Git, unsafe repository,
    // corrupt metadata, etc.) must fail closed instead of changing scan scope.
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? Buffer.from(error.stderr ?? '').toString('utf8')
      : ''
    if (
      error && typeof error === 'object' && 'status' in error && error.status === 128 &&
      /not a git repository/i.test(stderr)
    ) {
      return false
    }
    throw error
  }
}

function usage() {
  return [
    'Usage: node scripts/secret-scan.mjs [--staged | --all | --dir PATH] [options]',
    '',
    '  --staged             scan staged added/copied/modified files (default)',
    '  --all                scan every tracked file',
    '  --dir PATH           scan a directory tree without Git selection',
    '  --include-dir PATH   add a package/build directory (repeatable; with --all)',
    '  --allow-empty        deliberately allow an empty staged/directory scan',
    '  --help               show this help',
  ].join('\n')
}

function parseArgs(argv) {
  let mode = null
  let directory = null
  let allowEmpty = false
  let help = false
  const includeDirs = []

  function selectMode(nextMode) {
    if (mode !== null && mode !== nextMode) {
      throw new Error(`cannot combine --${mode} with --${nextMode}`)
    }
    mode = nextMode
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--staged') {
      selectMode('staged')
    } else if (arg === '--all') {
      selectMode('all')
    } else if (arg === '--dir') {
      selectMode('dir')
      directory = argv[++index]
      if (!directory) throw new Error('--dir requires a path')
    } else if (arg === '--include-dir') {
      const value = argv[++index]
      if (!value) throw new Error('--include-dir requires a path')
      includeDirs.push(value)
    } else if (arg === '--allow-empty') {
      allowEmpty = true
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }

  mode ??= 'staged'
  if (mode === 'dir' && includeDirs.length > 0) {
    throw new Error('--include-dir cannot be combined with --dir')
  }
  if (mode !== 'all' && includeDirs.length > 0) {
    throw new Error('--include-dir requires --all')
  }
  return { mode, directory, includeDirs, allowEmpty, help }
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`secret-scan: ${error instanceof Error ? error.message : String(error)}`)
  console.error(usage())
  process.exit(2)
}

if (options.help) {
  console.log(usage())
  process.exit(0)
}

// inline the detection logic to keep this script dependency-free at runtime
const SECRET_PATTERNS = [
  { pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g, label: 'sk-key' },
  { pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g, label: 'anthropic-key' },
  { pattern: /\bgh[pousr]_[a-zA-Z0-9]{36,}\b/g, label: 'github-token' },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, label: 'aws-key' },
  { pattern: /\bBearer\s+[a-zA-Z0-9._\-]{20,}\b/g, label: 'bearer-token' },
  {
    pattern: /\b(api[_-]?key|apikey|secret|token|password|passwd)\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})["']?/gi,
    label: 'generic-secret',
  },
]

// Whole-file exemptions are intentionally empty. If one is ever unavoidable,
// it must be a canonical repository-relative path and matched with Set.has —
// never a suffix that another tracked path can impersonate.
const ALLOWLIST = new Set()

function detectSecrets(text) {
  const hits = []
  for (const { pattern, label } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      hits.push({ label, index: match.index })
    }
  }
  return hits
}

// directories never worth scanning
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', '.agent', '.idea', '.vscode',
])

/** Recursively collect files under a directory without leaving its real root. */
function walk(dir, base, baseReal = realpathSync(base)) {
  const out = []
  let entries
  try {
    const dirReal = realpathSync(dir)
    if (!isInside(baseReal, dirReal)) {
      throw new Error('directory resolves outside scan root')
    }
    entries = readdirSync(dir)
  } catch (error) {
    throw new Error(
      `cannot read ${relative(base, dir).split(sep).join('/') || '.'}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  for (const entry of entries) {
    const full = join(dir, entry)
    let info
    let entryReal
    try {
      info = lstatSync(full)
      entryReal = realpathSync(full)
    } catch (error) {
      throw new Error(
        `cannot inspect ${relative(base, full).split(sep).join('/')}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!isInside(baseReal, entryReal)) {
      throw new Error(
        `${relative(base, full).split(sep).join('/')} resolves outside scan root`,
      )
    }
    // Never follow a workspace-controlled symlink/junction, even when it
    // currently points inside the root. Git-selected links use index blobs or
    // receive the same realpath containment check before filesystem reads.
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.toLowerCase())) continue
      out.push(...walk(full, base, baseReal))
    } else if (info.isFile()) {
      out.push(relative(base, full).split(sep).join('/'))
    }
  }
  return out
}

function isInside(base, target) {
  const rel = relative(base, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function resolveInsideRoot(input) {
  const target = resolve(root, input)
  if (!isInside(root, target)) {
    throw new Error(`included path escapes project root: ${input}`)
  }
  const targetInfo = lstatSync(target)
  const targetReal = realpathSync(target)
  if (targetInfo.isSymbolicLink() || !isInside(rootReal, targetReal)) {
    throw new Error(`included path resolves outside project root: ${input}`)
  }
  return target
}

// determine which files to scan
let files
let scanRoot = root
let selectionDescription
let readFromIndex = false
if (options.mode === 'dir') {
  // explicit directory mode (used by tests to verify detection works)
  scanRoot = resolve(options.directory)
  try {
    files = walk(scanRoot, scanRoot)
  } catch (error) {
    console.error(`secret-scan: cannot scan directory ${scanRoot}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  selectionDescription = `directory ${scanRoot}`
} else {
  let isGitWorktree
  try {
    isGitWorktree = inspectGitWorktree()
  } catch (error) {
    console.error(
      `secret-scan: cannot determine Git repository state — failing closed ` +
      `(${gitFailureSummary(error)})`,
    )
    process.exit(2)
  }

  if (!isGitWorktree) {
    // Outside Git there is no index to inspect, so cover the complete project
    // tree. This is the sole condition under which filesystem fallback is safe.
    console.log('secret-scan: not a git repository — scanning full project tree')
    try {
      files = walk(root, root)
    } catch (walkError) {
      console.error(
        `secret-scan: cannot scan non-Git project tree: ` +
        `${walkError instanceof Error ? walkError.message : String(walkError)}`,
      )
      process.exit(2)
    }
    readFromIndex = false
    selectionDescription = 'full non-Git project tree'
  } else {
    try {
      if (options.mode === 'all') {
        files = runGit(['ls-files', '-z'])
          .toString('utf8')
          .split('\0')
          .filter(Boolean)
        selectionDescription = 'tracked files'
      } else {
        files = runGit(
          [
            'diff', '--cached', '--name-only', '-z',
            '--find-renames', '--diff-filter=ACMRT',
          ],
        )
          .toString('utf8')
          .split('\0')
          .filter(Boolean)
        readFromIndex = true
        selectionDescription = 'staged files'
      }
    } catch (gitError) {
      console.error(
        `secret-scan: Git ${options.mode} selection failed — failing closed ` +
        `(${gitFailureSummary(gitError)})`,
      )
      process.exit(2)
    }
  }

  for (const input of options.includeDirs) {
    let target
    try {
      target = resolveInsideRoot(input)
      const included = walk(target, root)
      files.push(...included)
    } catch (error) {
      console.error(`secret-scan: cannot scan included directory ${input}: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    }
  }
  if (options.includeDirs.length > 0) {
    selectionDescription += ` plus ${options.includeDirs.join(', ')}`
  }
}

files = [...new Set(files.map(file => file.replace(/\\/g, '/')))]

const candidateFiles = files.filter(file => !ALLOWLIST.has(file))

if (candidateFiles.length === 0) {
  if (options.allowEmpty) {
    console.log(`secret-scan: empty ${selectionDescription} scan intentionally allowed ✓`)
    process.exit(0)
  }
  console.error(`secret-scan: no files selected from ${selectionDescription} — failing closed`)
  console.error('  Use --allow-empty only when an empty staged scan is intentional.')
  process.exit(2)
}

let violations = 0
let readFailures = 0
let textFilesScanned = 0
let binaryFilesSkipped = 0
const scanRootReal = realpathSync(scanRoot)

for (const file of candidateFiles) {
  let contentBuffer
  try {
    if (readFromIndex) {
      // A pre-commit gate must inspect the exact blob that will be committed,
      // not a potentially different working-tree copy of the same path.
      contentBuffer = runGit(['show', `:${file}`])
    } else {
      const selectedPath = join(scanRoot, file)
      const selectedReal = realpathSync(selectedPath)
      if (!isInside(scanRootReal, selectedReal)) {
        throw new Error('selected path resolves outside scan root')
      }
      contentBuffer = readFileSync(selectedReal)
    }
  } catch (error) {
    readFailures++
    console.error(`secret-scan: cannot read selected file ${file}: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }

  // File extensions are neither complete nor case-stable. Read every
  // selected file as bytes, and skip only content that looks binary.
  if (contentBuffer.includes(0)) {
    binaryFilesSkipped++
    continue
  }
  textFilesScanned++
  const content = contentBuffer.toString('utf8')

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const hits = detectSecrets(lines[i])
    if (hits.length > 0) {
      violations++
      console.error(
        `\x1b[31mSECRET DETECTED\x1b[0m ${file}:${i + 1} [${hits.map(h => h.label).join(', ')}]`,
      )
      console.error('  <redacted; inspect the file locally>')
    }
  }
}

if (readFailures > 0) {
  console.error(`\n\x1b[31m✘ ${readFailures} selected file(s) could not be scanned — failing closed.\x1b[0m`)
  process.exit(2)
} else if (textFilesScanned === 0) {
  if (options.allowEmpty) {
    console.log(
      `secret-scan: ${binaryFilesSkipped} binary file(s) selected from ` +
      `${selectionDescription}; empty text scan intentionally allowed ✓`,
    )
    process.exit(0)
  }
  console.error(
    `secret-scan: selected ${binaryFilesSkipped} binary file(s) but no text files ` +
    `from ${selectionDescription} — failing closed`,
  )
  console.error('  Use --allow-empty only when an empty text scan is intentional.')
  process.exit(2)
} else if (violations > 0) {
  console.error(`\n\x1b[31m✘ ${violations} potential secret(s) found — commit blocked.\x1b[0m`)
  console.error('  Remove the secret; construct test credentials at runtime instead of exempting a file.')
  process.exit(1)
} else {
  const binaryNote = binaryFilesSkipped > 0
    ? `; ${binaryFilesSkipped} binary file(s) skipped by NUL detection`
    : ''
  console.log(
    `secret-scan: no secrets detected in ${textFilesScanned} text file(s) ` +
    `from ${selectionDescription}${binaryNote} ✓`,
  )
}
