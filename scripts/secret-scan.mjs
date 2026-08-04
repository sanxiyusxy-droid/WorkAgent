#!/usr/bin/env node
/**
 * Pre-commit secret scanner.
 *
 * Usage:
 *   node scripts/secret-scan.mjs           scan staged files (git)
 *   node scripts/secret-scan.mjs --all     scan all tracked files
 *   node scripts/secret-scan.mjs --dir X   scan a directory tree (no git)
 *
 * Behavior outside a git repository: instead of silently skipping (which
 * produces a false green), the scanner walks the whole project directory.
 *
 * Install as a git hook:
 *   copy to .git/hooks/pre-commit (or use husky/simple-git-hooks)
 *
 * Exit code 1 if any secret is found — the commit is blocked.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

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

// files that are allowed to contain key-like strings (tests, this scanner)
const ALLOWLIST = [
  'scripts/secret-scan.mjs',
  'src/security/secrets.ts',
  'test/security.test.ts',
]

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

/** Recursively collect text files under a directory (no git required). */
function walk(dir, base) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue
      out.push(...walk(full, base))
    } else if (info.isFile()) {
      out.push(relative(base, full).split(sep).join('/'))
    }
  }
  return out
}

// determine which files to scan
const allMode = process.argv.includes('--all')
const dirIndex = process.argv.indexOf('--dir')
let files
let scanRoot = root
if (dirIndex !== -1) {
  // explicit directory mode (used by tests to verify detection works)
  scanRoot = process.argv[dirIndex + 1]
  if (!scanRoot) {
    console.error('secret-scan: --dir requires a path')
    process.exit(2)
  }
  files = walk(scanRoot, scanRoot)
} else {
  try {
    if (allMode) {
      files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    } else {
      files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
        cwd: root,
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean)
    }
  } catch {
    // NOT a false green: outside git we scan the entire project tree so a
    // secret can never hide behind a missing repository.
    console.log('secret-scan: not a git repository — scanning full project tree')
    files = walk(root, root)
  }
}

// filter to text files only
const TEXT_EXTENSIONS = new Set([
  '.ts', '.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.txt', '.env',
  '.sh', '.ps1', '.cmd', '.toml', '.cfg', '.ini', '.html', '.css',
])

let violations = 0

for (const file of files) {
  const dot = file.lastIndexOf('.')
  const ext = dot === -1 ? '' : file.slice(dot)
  if (!TEXT_EXTENSIONS.has(ext)) continue
  if (ALLOWLIST.some(allowed => file.replace(/\\/g, '/').endsWith(allowed))) continue

  let content
  try {
    content = readFileSync(join(scanRoot, file), 'utf8')
  } catch {
    continue
  }

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const hits = detectSecrets(lines[i])
    if (hits.length > 0) {
      violations++
      const masked = lines[i].replace(/\b(sk-[a-zA-Z0-9]{4})[a-zA-Z0-9]+/g, '$1...')
      console.error(
        `\x1b[31mSECRET DETECTED\x1b[0m ${file}:${i + 1} [${hits.map(h => h.label).join(', ')}]`,
      )
      console.error(`  ${masked.trim().slice(0, 100)}`)
    }
  }
}

if (violations > 0) {
  console.error(`\n\x1b[31m✘ ${violations} potential secret(s) found — commit blocked.\x1b[0m`)
  console.error('  Remove the secret or add the file to ALLOWLIST in scripts/secret-scan.mjs')
  process.exit(1)
} else {
  console.log('secret-scan: no secrets detected ✓')
}
