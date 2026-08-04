import { describe, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises'
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

const FAKE_KEY = 'sk-fake99887766554433221100aabbccdd'

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
    const text = [
      'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'AKIAAAAAAAAAAAAAAAA1',
      'api_key = "supersecretvalue12345678"',
    ].join('\n')
    const out = sanitize(text)
    expect(out).not.toContain('ghp_aaaa')
    expect(out).not.toContain('AKIAAAAAAAAAAAAAAAA1')
    expect(out).not.toContain('supersecretvalue12345678')
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
})

describe('secret-scan script (no false green)', () => {
  const script = new URL('../scripts/secret-scan.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

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
