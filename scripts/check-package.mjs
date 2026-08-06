#!/usr/bin/env node
/**
 * Release guard: verify the npm tarball contains ONLY allowlisted files.
 * A session journal, evidence receipt, config or coverage report inside the
 * package is a data-leak release blocker (finish-list §1.2).
 *
 * Runs `npm pack --dry-run --json` and fails on:
 *   - any file outside the allowlist, or
 *   - any path matching a denylist pattern (.agent, sessions, journal, ...)
 */
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// --ignore-scripts: skip the prepack lifecycle here. prepack re-runs this
// script, so letting npm pack fire lifecycle hooks would recurse infinitely
// (and nested npm runs lose node_modules/.bin from PATH anyway). Content
// checks only need the file list, which is identical with scripts skipped.
// npm_execpath points at npm-cli.js when invoked through an npm lifecycle.
// Running that file with the current Node executable avoids shell=true (and
// Node's DEP0190 warning) while remaining portable on Windows.
const npmCli = process.env.npm_execpath
const npmExecutable = npmCli
  ? process.execPath
  : process.platform === 'win32'
    ? (process.env.ComSpec ?? 'cmd.exe')
    : 'npm'
const npmArgs = npmCli
  ? [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts']
  : process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd pack --dry-run --json --ignore-scripts']
    : ['pack', '--dry-run', '--json', '--ignore-scripts']
const result = spawnSync(npmExecutable, npmArgs, {
  cwd: root,
  encoding: 'utf8',
  shell: false,
})
if (result.status !== 0) {
  console.error(`npm pack failed:\n${result.stderr ?? result.error?.message ?? 'unknown error'}`)
  process.exit(1)
}

let entries
try {
  entries = JSON.parse(result.stdout)
} catch {
  console.error(`could not parse npm pack --json output:\n${result.stdout}`)
  process.exit(1)
}
const files = (entries[0]?.files ?? []).map(f => String(f.path).replace(/\\/g, '/'))

// The ONLY paths a published package may contain.
const ALLOWED = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'dist/agent.mjs',
  'dist/agent',
  'dist/agent.cmd',
])

// Defense in depth: these patterns must never appear anywhere in the list,
// even if the allowlist above is widened later.
const DENY_PATTERNS = [
  '.agent',
  'sessions',
  'journal',
  'evidence',
  'snapshot',
  'agent.config',
  'config.json',
  'coverage',
  'eval/',
  'node_modules',
  '.env',
  '.tgz',
]

const violations = []
for (const file of files) {
  if (!ALLOWED.has(file)) {
    violations.push(`not allowlisted: ${file}`)
  }
  const lower = file.toLowerCase()
  for (const pattern of DENY_PATTERNS) {
    if (lower.includes(pattern)) {
      violations.push(`denylisted pattern "${pattern}" in: ${file}`)
    }
  }
}
for (const required of ALLOWED) {
  if (!files.includes(required)) violations.push(`required file missing: ${required}`)
}

console.log(`package contents (${files.length} files):`)
for (const file of files) console.log(`  ${file}`)

if (violations.length > 0) {
  console.error('\npackage content check FAILED:')
  for (const violation of violations) console.error(`  - ${violation}`)
  process.exit(1)
}
console.log('\npackage content check passed (allowlist only, no user data)')
