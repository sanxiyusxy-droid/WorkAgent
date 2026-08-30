#!/usr/bin/env node
/** Verify that a release tag names the exact package.json version. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function usage() {
  return [
    'Usage: node scripts/check-release-tag.mjs [--tag vX.Y.Z]',
    '',
    'Without --tag, GitHub Actions tag metadata is used. Branch builds skip.',
  ].join('\n')
}

function parseArgs(argv) {
  let tag
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--tag') {
      tag = argv[++index]
      if (!tag) throw new Error('--tag requires a value')
    } else if (arg === '--help' || arg === '-h') {
      return { help: true, tag }
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  return { help: false, tag }
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`release-tag: ${error instanceof Error ? error.message : String(error)}`)
  console.error(usage())
  process.exit(2)
}

if (options.help) {
  console.log(usage())
  process.exit(0)
}

let tag = options.tag
if (!tag && process.env.GITHUB_REF_TYPE === 'tag') {
  tag = process.env.GITHUB_REF_NAME
}
if (!tag && process.env.GITHUB_REF?.startsWith('refs/tags/')) {
  tag = process.env.GITHUB_REF.slice('refs/tags/'.length)
}

if (!tag) {
  console.log('release-tag: branch build — no tag/version check required ✓')
  process.exit(0)
}

let pkg
try {
  pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
} catch (error) {
  console.error(
    `release-tag: cannot read package.json — ` +
    `${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(2)
}
if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
  console.error('release-tag: package.json has no valid version')
  process.exit(2)
}

const normalizedTag = tag.startsWith('v') ? tag.slice(1) : tag
if (normalizedTag !== pkg.version) {
  console.error(
    `release-tag: tag ${tag} does not match package.json version ${pkg.version}`,
  )
  process.exit(1)
}

console.log(`release-tag: ${tag} matches package.json ${pkg.version} ✓`)
