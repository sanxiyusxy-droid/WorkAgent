import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'
import { parseRetrievalEvalFlags } from '../eval/retrieval-eval.js'

const execFileAsync = promisify(execFile)
const tagScript = fileURLToPath(new URL('../scripts/check-release-tag.mjs', import.meta.url))

describe('release gate command contracts', () => {
  test('retrieval eval explicitly accepts no-write/help and rejects unknown flags', () => {
    expect(parseRetrievalEvalFlags(['--no-write'])).toEqual({ noWrite: true, help: false })
    expect(parseRetrievalEvalFlags(['--help'])).toEqual({ noWrite: false, help: true })
    expect(() => parseRetrievalEvalFlags(['--no-wirte'])).toThrow('unknown option')
  })

  test('release tag must equal the package version after removing v', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    const explicit = await execFileAsync(
      'node', [tagScript, '--tag', `v${pkg.version}`],
    )
    expect(explicit.stdout).toContain(`matches package.json ${pkg.version}`)

    const taggedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_REF: `refs/tags/v${pkg.version}`,
    }
    delete taggedEnv.GITHUB_REF_TYPE
    delete taggedEnv.GITHUB_REF_NAME
    const acceptedRef = await execFileAsync('node', [tagScript], { env: taggedEnv })
    expect(acceptedRef.stdout).toContain(`matches package.json ${pkg.version}`)

    let failure: { code?: number; stderr?: string } | undefined
    try {
      await execFileAsync('node', [tagScript], {
        env: { ...taggedEnv, GITHUB_REF: `refs/tags/v${pkg.version}-wrong` },
      })
    } catch (error) {
      failure = error as { code?: number; stderr?: string }
    }
    expect(failure?.code).toBe(1)
    expect(failure?.stderr).toContain('does not match package.json version')
  })
})
