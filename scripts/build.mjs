#!/usr/bin/env node
/**
 * Bundle the CLI into a single self-contained ESM file plus OS launchers.
 * Output:
 *   dist/agent.mjs   single file, no node_modules needed at runtime
 *   dist/agent.cmd   Windows launcher (works from cmd, PowerShell, Explorer)
 *   dist/agent       POSIX launcher
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'dist')
const outFile = join(outDir, 'agent.mjs')

// Bind the artifact to the exact source commit so a shipped bundle can
// always be traced back to the tree it was built from.
let buildCommit = 'unknown'
try {
  buildCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
} catch {
  // no git available (e.g. tarball build): the version string still ships
}

// Start from a clean dist: leftover files (e.g. a stray .agent session
// directory from running the CLI with dist/ as workspace) would otherwise be
// packed into the tarball by `files: ["dist"]` and leak user data.
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

const result = await build({
  entryPoints: [join(root, 'src', 'cli', 'main.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: false,
  minify: false, // keep stack traces readable; size is not a constraint here
  legalComments: 'none',
  metafile: true,
  define: { __AGENT_BUILD_COMMIT__: JSON.stringify(buildCommit) },
})

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0

// A shebang is only valid on line 1. esbuild preserves the entry point's
// shebang wherever it lands, so normalize to exactly one at the top and
// add the CJS interop shim below it.
const bundled = await readFile(outFile, 'utf8')
const withoutShebangs = bundled
  .split('\n')
  .filter(line => !line.startsWith('#!'))
  .join('\n')
await writeFile(
  outFile,
  [
    '#!/usr/bin/env node',
    "import { createRequire as __createRequire } from 'node:module';",
    'const require = __createRequire(import.meta.url);',
    withoutShebangs,
  ].join('\n'),
  'utf8',
)
await chmod(outFile, 0o755).catch(() => {})

await writeFile(
  join(outDir, 'agent.cmd'),
  ['@echo off', 'setlocal', 'node "%~dp0agent.mjs" %*', ''].join('\r\n'),
  'utf8',
)

const posixLauncher = join(outDir, 'agent')
await writeFile(
  posixLauncher,
  ['#!/bin/sh', 'exec node "$(dirname "$0")/agent.mjs" "$@"', ''].join('\n'),
  'utf8',
)
await chmod(posixLauncher, 0o755).catch(() => {})

console.log(`built dist/agent.mjs (${Math.round(bytes / 1024)} KB, commit ${buildCommit})`)
console.log('launchers: dist/agent.cmd (Windows), dist/agent (POSIX)')
