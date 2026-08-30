import { describe, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { sanitize, redactDeep, maskKey, detectSecrets } from '../src/security/secrets.js'
import { sanitizedEnv } from '../src/policy/shellPolicy.js'
import { checkPathReal } from '../src/policy/pathPolicy.js'
import { RingBuffer } from '../src/tools/builtin/ShellTool.js'
import { ReadTool } from '../src/tools/builtin/ReadTool.js'
import { WriteTool } from '../src/tools/builtin/WriteTool.js'
import { ToolOutputStore } from '../src/tools/ToolOutputStore.js'
import { SessionJournal } from '../src/session/SessionJournal.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { fixedClock } from './helpers.js'
import type { ToolContext } from '../src/tools/Tool.js'

const execFileAsync = promisify(execFile)

// Assemble test credentials at runtime so the repository's own secret scan
// can inspect this file instead of exempting it wholesale.
const FAKE_KEY = ['sk', '-', 'fake99887766554433221100aabbccdd'].join('')

function makeCtx(workspaceRoot: string): ToolContext {
  return {
    sessionId: 'ses-test',
    callId: 'call-test',
    workspaceRoot,
    mode: 'default',
    artifactDir: join(workspaceRoot, '.agent'),
    signal: new AbortController().signal,
    clock: fixedClock(),
    ids: createSequentialIds(),
    services: {},
  }
}

describe('credential sanitization', () => {
  test('sanitize masks API keys keeping a debug prefix', () => {
    const out = sanitize(`using key ${FAKE_KEY} for auth`)
    expect(out).not.toContain(FAKE_KEY)
    expect(out).toContain('[REDACTED]')
  })

  test('sanitize covers github tokens, aws keys and generic assignments', () => {
    const githubToken = ['ghp', '_', 'a'.repeat(36)].join('')
    const awsKey = ['AKIA', 'A'.repeat(15), '1'].join('')
    const genericValue = ['super', 'secretvalue12345678'].join('')
    const genericAssignment = ['api', '_key = "', genericValue, '"'].join('')
    const text = [
      githubToken,
      awsKey,
      genericAssignment,
    ].join('\n')
    const out = sanitize(text)
    expect(out).not.toContain(githubToken)
    expect(out).not.toContain(awsKey)
    expect(out).not.toContain(genericValue)
  })

  test('redactDeep walks nested objects and arrays', () => {
    const input = {
      a: { b: [`token: ${FAKE_KEY}`], c: 1 },
      d: 'clean',
    }
    const out = redactDeep(input)
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY)
    expect(out.d).toBe('clean')
    expect(out.a.c).toBe(1)
    // unchanged input is returned by reference for clean subtrees
    expect(out.d).toBe(input.d)
  })

  test('maskKey shows first and last chars only', () => {
    expect(maskKey(FAKE_KEY)).not.toContain(FAKE_KEY.slice(6, 20))
    expect(maskKey(FAKE_KEY).startsWith('sk-f')).toBe(true)
  })

  test('detectSecrets finds embedded credentials', () => {
    expect(detectSecrets(`export OPENAI_API_KEY=${FAKE_KEY}`).length).toBeGreaterThan(0)
    expect(detectSecrets('hello world').length).toBe(0)
  })
})

describe('sanitizing sinks', () => {
  test('journal never persists raw credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-sec-'))
    try {
      const journalPath = join(dir, 'journal.jsonl')
      const journal = new SessionJournal({
        filePath: journalPath,
        sessionId: 'ses-1',
        runId: 'run-1',
        clock: fixedClock(),
        ids: createSequentialIds(),
      })
      await journal.append(
        {
          type: 'user.message.accepted',
          message: {
            id: 'm1',
            parentId: null,
            sessionId: 'ses-1',
            turnId: 't1',
            role: 'user',
            content: [{ type: 'text', text: `my key is ${FAKE_KEY}` }],
            createdAt: new Date().toISOString(),
          },
        },
        't1',
        'flush',
      )
      const raw = await readFile(journalPath, 'utf8')
      expect(raw).not.toContain(FAKE_KEY)
      expect(raw).toContain('[REDACTED]')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('externalized tool artifacts redact credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-sec-'))
    try {
      const store = new ToolOutputStore(dir)
      const longText = `prefix ${FAKE_KEY} `.padEnd(5_000, 'x')
      const out = await store.bound(
        { kind: 'text', text: longText },
        { callId: 'call-1', toolName: 'Shell', maxChars: 100 },
      )
      expect(out.kind).toBe('externalized')
      if (out.kind === 'externalized') {
        const artifact = await readFile(out.path, 'utf8')
        expect(artifact).not.toContain(FAKE_KEY)
        expect(out.previewHead).not.toContain(FAKE_KEY)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('shell environment allowlist', () => {
  test('only allowlisted variables survive', () => {
    const env = sanitizedEnv({
      PATH: '/usr/bin',
      OPENAI_API_KEY: FAKE_KEY,
      NODE_OPTIONS: '--require evil.js',
      LD_PRELOAD: '/tmp/x.so',
      HOME: '/home/u',
      MY_CUSTOM_TOKEN: 'abc',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/u')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.LD_PRELOAD).toBeUndefined()
    expect(env.MY_CUSTOM_TOKEN).toBeUndefined()
  })

  test('AGENT_ENV_ALLOW extends the allowlist explicitly', () => {
    const env = sanitizedEnv({
      AGENT_ENV_ALLOW: 'CI_BUILD_ID',
      CI_BUILD_ID: '42',
      NOT_ALLOWED: 'nope',
    })
    expect(env.CI_BUILD_ID).toBe('42')
    expect(env.NOT_ALLOWED).toBeUndefined()
  })
})

describe('RingBuffer output bound', () => {
  test('retains only the tail within capacity', () => {
    const rb = new RingBuffer(100)
    for (let i = 0; i < 100; i++) rb.write(`line-${String(i).padStart(3, '0')}\n`)
    const text = rb.toString()
    expect(text.length).toBeLessThanOrEqual(100)
    expect(text.endsWith('099\n')).toBe(true)
    expect(text).not.toContain('line-000')
    expect(rb.overflowed).toBe(true)
  })

  test('single chunk larger than capacity is trimmed', () => {
    const rb = new RingBuffer(10)
    rb.write('abcdefghijklmnop')
    expect(rb.toString()).toBe('ghijklmnop')
  })

  test('retained tail is independent of write chunk boundaries', () => {
    const capacity = 100_000
    const body = 'A'.repeat(150_000)
    const marker = 'TAIL-MARKER'

    const singleChunk = new RingBuffer(capacity)
    singleChunk.write(body + marker)

    const splitChunks = new RingBuffer(capacity)
    splitChunks.write(body)
    splitChunks.write(marker)

    expect(splitChunks.toString()).toHaveLength(capacity)
    expect(splitChunks.toString()).toBe(singleChunk.toString())
    expect(splitChunks.toString().endsWith(marker)).toBe(true)
    expect(splitChunks.overflowed).toBe(true)
  })
})

describe('secret-scan script (no false green)', () => {
  const script = new URL('../scripts/secret-scan.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

  async function makeCleanGitRepo(): Promise<{ dir: string; copiedScript: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'agent-scan-git-'))
    const copiedScript = join(dir, 'scripts', 'secret-scan.mjs')
    await mkdir(join(dir, 'scripts'), { recursive: true })
    await copyFile(script, copiedScript)
    await writeFile(join(dir, 'clean.ts'), 'export const clean = true\n')
    await execFileAsync('git', ['init', '--quiet'], { cwd: dir })
    await execFileAsync('git', ['add', 'scripts/secret-scan.mjs', 'clean.ts'], { cwd: dir })
    await execFileAsync(
      'git',
      [
        '-c', 'user.name=Code Agent Test',
        '-c', 'user.email=code-agent@example.invalid',
        'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture',
      ],
      { cwd: dir },
    )
    return { dir, copiedScript }
  }

  test('detects a planted secret and exits non-zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-scan-'))
    try {
      await writeFile(join(dir, 'leak.env'), `OPENAI_API_KEY=${FAKE_KEY}\n`)
      let exitCode = 0
      try {
        await execFileAsync('node', [script, '--dir', dir])
      } catch (error) {
        exitCode = (error as { code?: number }).code ?? 0
      }
      expect(exitCode).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('passes a clean directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-scan-'))
    try {
      await writeFile(join(dir, 'clean.ts'), 'export const x = 1\n')
      await execFileAsync('node', [script, '--dir', dir])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a genuine non-Git project falls back to a full tree scan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-scan-nongit-'))
    try {
      const copiedScript = join(dir, 'scripts', 'secret-scan.mjs')
      await mkdir(join(dir, 'scripts'), { recursive: true })
      await copyFile(script, copiedScript)
      await writeFile(join(dir, 'planted'), `credential ${FAKE_KEY}\n`)

      let failure: { code?: number; stdout?: string; stderr?: string } | undefined
      try {
        await execFileAsync('node', [copiedScript], { cwd: dir })
      } catch (error) {
        failure = error as { code?: number; stdout?: string; stderr?: string }
      }
      expect(failure?.code).toBe(1)
      expect(failure?.stdout).toContain('not a git repository')
      expect(failure?.stderr).toContain('planted')
      expect(failure?.stderr).not.toContain(FAKE_KEY)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('fails closed for an empty directory unless explicitly allowed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-scan-empty-'))
    try {
      let failure: { code?: number; stderr?: string } | undefined
      try {
        await execFileAsync('node', [script, '--dir', dir])
      } catch (error) {
        failure = error as { code?: number; stderr?: string }
      }
      expect(failure?.code).toBe(2)
      expect(failure?.stderr).toContain('no files selected')

      const allowed = await execFileAsync('node', [script, '--dir', dir, '--allow-empty'])
      expect(allowed.stdout).toContain('intentionally allowed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a clean Git checkout cannot pass through the empty staged selection', async () => {
    const { dir, copiedScript } = await makeCleanGitRepo()
    try {
      let failure: { code?: number; stderr?: string } | undefined
      try {
        await execFileAsync('node', [copiedScript], { cwd: dir })
      } catch (error) {
        failure = error as { code?: number; stderr?: string }
      }
      expect(failure?.code).toBe(2)
      expect(failure?.stderr).toContain('staged files')

      const tracked = await execFileAsync('node', [copiedScript, '--all'], { cwd: dir })
      expect(tracked.stdout).toContain('tracked files')
      expect(tracked.stdout).toContain('2 text file(s)')

      const precommit = await execFileAsync(
        'node', [copiedScript, '--staged', '--allow-empty'], { cwd: dir },
      )
      expect(precommit.stdout).toContain('intentionally allowed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a Git selector failure fails closed instead of scanning the working tree', async () => {
    const { dir, copiedScript } = await makeCleanGitRepo()
    try {
      // rev-parse does not require the index, so repository detection succeeds;
      // the subsequent staged selector must treat this corruption as fatal.
      await writeFile(join(dir, '.git', 'index'), Buffer.from('corrupt-index'))

      let failure: { code?: number; stdout?: string; stderr?: string } | undefined
      try {
        await execFileAsync('node', [copiedScript, '--staged'], { cwd: dir })
      } catch (error) {
        failure = error as { code?: number; stdout?: string; stderr?: string }
      }
      expect(failure?.code).toBe(2)
      expect(failure?.stderr).toContain('Git staged selection failed')
      expect(failure?.stdout).not.toContain('scanning full project tree')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('staged mode scans the index blob when the working tree copy is clean', async () => {
    const { dir, copiedScript } = await makeCleanGitRepo()
    try {
      await writeFile(join(dir, 'staged.ts'), `export const key = '${FAKE_KEY}'\n`)
      await execFileAsync('git', ['add', 'staged.ts'], { cwd: dir })
      await writeFile(join(dir, 'staged.ts'), 'export const key = "clean"\n')

      let failure: { code?: number; stderr?: string } | undefined
      try {
        await execFileAsync('node', [copiedScript, '--staged'], { cwd: dir })
      } catch (error) {
        failure = error as { code?: number; stderr?: string }
      }
      expect(failure?.code).toBe(1)
      expect(failure?.stderr).toContain('staged.ts')
      expect(failure?.stderr).not.toContain(FAKE_KEY)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('staged rename paths are selected and read from their index blobs', async () => {
    const { dir, copiedScript } = await makeCleanGitRepo()
    try {
      await writeFile(join(dir, 'before.ts'), `export const key = '${FAKE_KEY}'\n`)
      await execFileAsync('git', ['add', 'before.ts'], { cwd: dir })
      await execFileAsync(
        'git',
        [
          '-c', 'user.name=Code Agent Test',
          '-c', 'user.email=code-agent@example.invalid',
          'commit', '--quiet', '--no-gpg-sign', '-m', 'rename source',
        ],
        { cwd: dir },
      )
      await execFileAsync('git', ['mv', 'before.ts', 'after.ts'], { cwd: dir })

      let failure: { code?: number; stderr?: string } | undefined
      try {
        await execFileAsync('node', [copiedScript, '--staged'], { cwd: dir })
      } catch (error) {
        failure = error as { code?: number; stderr?: string }
      }
      expect(failure?.code).toBe(1)
      expect(failure?.stderr).toContain('after.ts')
      expect(failure?.stderr).not.toContain(FAKE_KEY)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('staged type changes are selected and read from their index blobs', async () => {
    const { dir, copiedScript } = await makeCleanGitRepo()
    try {
      await writeFile(join(dir, 'typed.ts'), 'export const clean = true\n')
      await execFileAsync('git', ['add', 'typed.ts'], { cwd: dir })
      await execFileAsync(
        'git',
        [
          '-c', 'user.name=Code Agent Test',
          '-c', 'user.email=code-agent@example.invalid',
          'commit', '--quiet', '--no-gpg-sign', '-m', 'type source',
        ],
        { cwd: dir },
      )

      const blobSource = join(dir, 'type-blob.txt')
      await writeFile(blobSource, FAKE_KEY)
      const hashed = await execFileAsync('git', ['hash-object', '-w', 'type-blob.txt'], { cwd: dir })
      await execFileAsync(
        'git',
        ['update-index', '--cacheinfo', '120000', hashed.stdout.trim(), 'typed.ts'],
        { cwd: dir },
      )

      let failure: { code?: number; stderr?: string } | undefined
      try {
        await execFileAsync('node', [copiedScript, '--staged'], { cwd: dir })
      } catch (error) {
        failure = error as { code?: number; stderr?: string }
      }
      expect(failure?.code).toBe(1)
      expect(failure?.stderr).toContain('typed.ts')
      expect(failure?.stderr).not.toContain(FAKE_KEY)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('scans extensionless, multi-suffix, and uppercase text while skipping NUL binary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-scan-text-'))
    try {
      await writeFile(join(dir, 'LICENSE'), `license ${FAKE_KEY}\n`)
      await writeFile(join(dir, 'launcher'), `launcher ${FAKE_KEY}\n`)
      await writeFile(join(dir, '.env.local'), `API_KEY=${FAKE_KEY}\n`)
      await writeFile(join(dir, 'UPPER.TS'), `export const key = '${FAKE_KEY}'\n`)
      await writeFile(join(dir, 'binary.dat'), Buffer.concat([
        Buffer.from([0]), Buffer.from(FAKE_KEY, 'utf8'),
      ]))

      let failure: { code?: number; stderr?: string } | undefined
      try {
        await execFileAsync('node', [script, '--dir', dir])
      } catch (error) {
        failure = error as { code?: number; stderr?: string }
      }
      expect(failure?.code).toBe(1)
      expect(failure?.stderr).toContain('LICENSE')
      expect(failure?.stderr).toContain('launcher')
      expect(failure?.stderr).toContain('.env.local')
      expect(failure?.stderr).toContain('UPPER.TS')
      expect(failure?.stderr).not.toContain('binary.dat')
      expect(failure?.stderr).not.toContain(FAKE_KEY)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('directory discovery applies excluded names case-insensitively', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-scan-excluded-case-'))
    try {
      await writeFile(join(dir, 'clean'), 'no credential here\n')
      await mkdir(join(dir, 'NODE_MODULES'))
      await writeFile(join(dir, 'NODE_MODULES', 'dependency'), FAKE_KEY)

      const result = await execFileAsync('node', [script, '--dir', dir])
      expect(result.stdout).toContain('1 text file(s)')
      expect(result.stdout).not.toContain('NODE_MODULES')
      expect(result.stderr).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('directory discovery fails closed when a link resolves outside the scan root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-scan-dir-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'agent-scan-dir-outside-'))
    try {
      const copiedScript = join(dir, 'scripts', 'secret-scan.mjs')
      await mkdir(join(dir, 'scripts'), { recursive: true })
      await copyFile(script, copiedScript)
      await writeFile(join(dir, 'clean'), 'no credential here\n')
      await writeFile(join(outside, 'secret'), FAKE_KEY)
      try {
        await symlink(
          outside,
          join(dir, 'escape'),
          process.platform === 'win32' ? 'junction' : 'dir',
        )
      } catch {
        return // The environment may prohibit creation of directory links.
      }

      let failure: { code?: number; stderr?: string } | undefined
      try {
        await execFileAsync('node', [copiedScript], { cwd: dir })
      } catch (error) {
        failure = error as { code?: number; stderr?: string }
      }
      expect(failure?.code).toBe(2)
      expect(failure?.stderr).toContain('resolves outside scan root')
      expect(failure?.stderr).not.toContain(FAKE_KEY)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('a nested allowlist-looking suffix is still scanned', async () => {
    const { dir, copiedScript } = await makeCleanGitRepo()
    try {
      const nested = join(dir, 'nested', 'test')
      await mkdir(nested, { recursive: true })
      await writeFile(join(nested, 'security.test.ts'), `export const key = '${FAKE_KEY}'\n`)
      await execFileAsync('git', ['add', 'nested/test/security.test.ts'], { cwd: dir })

      let failure: { code?: number; stderr?: string } | undefined
      try {
        await execFileAsync('node', [copiedScript, '--all'], { cwd: dir })
      } catch (error) {
        failure = error as { code?: number; stderr?: string }
      }
      expect(failure?.code).toBe(1)
      expect(failure?.stderr).toContain('nested/test/security.test.ts')
      expect(failure?.stderr).not.toContain(FAKE_KEY)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('package mode scans untracked build output without printing the secret', async () => {
    const { dir, copiedScript } = await makeCleanGitRepo()
    try {
      await mkdir(join(dir, 'dist'))
      await writeFile(join(dir, 'dist', 'agent'), `launcher ${FAKE_KEY}\n`)
      let failure: { code?: number; stderr?: string } | undefined
      try {
        await execFileAsync(
          'node', [copiedScript, '--all', '--include-dir', 'dist'], { cwd: dir },
        )
      } catch (error) {
        failure = error as { code?: number; stderr?: string }
      }
      expect(failure?.code).toBe(1)
      expect(failure?.stderr).toContain('dist/agent')
      expect(failure?.stderr).not.toContain(FAKE_KEY)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects a Git-tracked symlink that resolves outside the scan root', async () => {
    const { dir, copiedScript } = await makeCleanGitRepo()
    const outside = await mkdtemp(join(tmpdir(), 'agent-scan-outside-'))
    try {
      const outsideFile = join(outside, 'leak.ts')
      const linkedFile = join(dir, 'linked.ts')
      await writeFile(outsideFile, `export const key = '${FAKE_KEY}'\n`)
      try {
        await symlink(outsideFile, linkedFile, 'file')
      } catch {
        return // Windows may require Developer Mode or elevated symlink rights.
      }
      await execFileAsync('git', ['add', 'linked.ts'], { cwd: dir })

      let failure: { code?: number; stderr?: string } | undefined
      try {
        await execFileAsync('node', [copiedScript, '--all'], { cwd: dir })
      } catch (error) {
        failure = error as { code?: number; stderr?: string }
      }
      expect(failure?.code).toBe(2)
      expect(failure?.stderr).toContain('resolves outside scan root')
      expect(failure?.stderr).not.toContain(FAKE_KEY)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('symlink / junction escape protection', () => {
  async function makeWorkspace(): Promise<{ workspace: string; outside: string; cleanup: () => Promise<void> }> {
    const base = await mkdtemp(join(tmpdir(), 'agent-sym-'))
    const workspace = join(base, 'ws')
    const outside = join(base, 'outside')
    await mkdir(workspace)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'top-secret-data')
    return {
      workspace,
      outside,
      cleanup: async () => rm(base, { recursive: true, force: true }),
    }
  }

  test('checkPathReal rejects a directory junction escaping the workspace (Windows)', async () => {
    if (process.platform !== 'win32') return
    const { workspace, outside, cleanup } = await makeWorkspace()
    try {
      await symlink(outside, join(workspace, 'linkdir'), 'junction')
      // file under the junctioned directory
      const check = await checkPathReal(join('linkdir', 'secret.txt'), workspace)
      expect(check.ok).toBe(false)
      expect(check.reason).toBe('symlink_escape')
      // nearest-existing-ancestor walk: missing child under escaped junction
      const deep = await checkPathReal(join('linkdir', 'a', 'b', 'c.txt'), workspace)
      expect(deep.ok).toBe(false)
      expect(deep.reason).toBe('symlink_escape')
    } finally {
      await cleanup()
    }
  })

  test('checkPathReal rejects a file symlink escaping the workspace (Unix/dev-mode)', async () => {
    const { workspace, outside, cleanup } = await makeWorkspace()
    try {
      try {
        await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'))
      } catch {
        return // symlink creation requires privileges — environment limit
      }
      const check = await checkPathReal('link.txt', workspace)
      expect(check.ok).toBe(false)
      expect(check.reason).toBe('symlink_escape')
    } finally {
      await cleanup()
    }
  })

  test('Read/Write tools refuse symlink-escaped paths', async () => {
    const { workspace, outside, cleanup } = await makeWorkspace()
    try {
      let escaped: string
      if (process.platform === 'win32') {
        await symlink(outside, join(workspace, 'linkdir'), 'junction')
        escaped = join('linkdir', 'secret.txt')
      } else {
        try {
          await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'))
        } catch {
          return // needs privileges
        }
        escaped = 'link.txt'
      }
      const ctx = makeCtx(workspace)
      const readCheck = await ReadTool.validate({ path: escaped, offset: 0, limit: 10 }, ctx)
      expect(readCheck.ok).toBe(false)
      const writeCheck = await WriteTool.validate(
        { path: escaped, content: 'x', overwrite: true },
        ctx,
      )
      expect(writeCheck.ok).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test('missing ancestors inside the workspace stay allowed', async () => {
    const { workspace, cleanup } = await makeWorkspace()
    try {
      const check = await checkPathReal(join('a', 'b', 'c', 'new.txt'), workspace)
      expect(check.ok).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test('symlinked workspace root itself resolves correctly', async () => {
    if (process.platform === 'win32') return // dir symlinks need privileges
    const base = await mkdtemp(join(tmpdir(), 'agent-sym-'))
    try {
      const real = join(base, 'real')
      const alias = join(base, 'alias')
      await mkdir(real)
      try {
        await symlink(real, alias)
      } catch {
        return
      }
      const check = await checkPathReal('file.txt', alias)
      expect(check.ok).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
