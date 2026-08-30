import { describe, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'
import { collectRun, makeWorld, stateWithUser } from './helpers.js'
import { computeVersion } from '../src/workspace/FileVersion.js'

describe('Edit tool', () => {
  test('successful edit with matching version', async () => {
    const original = 'const value = 1\n'
    const version = computeVersion(original)
    const world = await makeWorld({
      mode: 'acceptEdits',
      askHandler: async () => 'allow',
      files: {
        'src/a.ts': original,
        'verify.test.js':
          "const test=require('node:test');const assert=require('node:assert/strict');" +
          "const fs=require('node:fs');test('edit',()=>assert.match(fs.readFileSync('src/a.ts','utf8'),/value = 2/));",
      },
      turns: [
        toolCallTurn([
          {
            id: 'e1',
            name: 'Edit',
            input: {
              path: 'src/a.ts',
              oldText: 'const value = 1',
              newText: 'const value = 2',
              expectedVersion: version,
            },
          },
        ]),
        toolCallTurn([{
          id: 'verify_e1', name: 'Shell',
          input: {
            command: 'node --test verify.test.js', evidenceKind: 'test',
            evidenceFiles: ['src/a.ts'],
          },
        }]),
        textTurn('edited'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'change value'),
      )
      expect(result.terminal).toEqual({ reason: 'completed' })
      const completed = result.facts.find(f => f.type === 'tool.call.completed')
      expect(completed).toMatchObject({ result: { ok: true } })
      const content = await readFile(join(world.workspaceRoot, 'src/a.ts'), 'utf8')
      expect(content).toBe('const value = 2\n')
    } finally {
      await world.cleanup()
    }
  })

  test('stale version produces FILE_VERSION_CONFLICT, file untouched', async () => {
    const original = 'let x = 1\n'
    const world = await makeWorld({
      mode: 'acceptEdits',
      files: { 'src/b.ts': original },
      turns: [
        toolCallTurn([
          {
            id: 'e2',
            name: 'Edit',
            input: {
              path: 'src/b.ts',
              oldText: 'let x = 1',
              newText: 'let x = 2',
              expectedVersion: 'sha256:stale',
            },
          },
        ]),
        textTurn('conflict acknowledged'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'edit'),
      )
      const completed = result.facts.find(f => f.type === 'tool.call.completed')
      expect(completed).toMatchObject({
        result: { ok: false, errorCode: 'FILE_VERSION_CONFLICT' },
      })
      const content = await readFile(join(world.workspaceRoot, 'src/b.ts'), 'utf8')
      expect(content).toBe(original)
    } finally {
      await world.cleanup()
    }
  })

  test('LF oldText matches a CRLF file and preserves CRLF', async () => {
    const original = 'function sum(a, b) {\r\n  return a - b\r\n}\r\n'
    const version = computeVersion(original)
    const world = await makeWorld({
      mode: 'acceptEdits',
      files: { 'crlf.js': original },
      turns: [
        toolCallTurn([
          {
            id: 'e4',
            name: 'Edit',
            input: {
              path: 'crlf.js',
              // models emit LF even when the file on disk is CRLF
              oldText: 'function sum(a, b) {\n  return a - b\n}',
              newText: 'function sum(a, b) {\n  return a + b\n}',
              expectedVersion: version,
            },
          },
        ]),
        textTurn('edited'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'fix sum'),
      )
      const completed = result.facts.find(f => f.type === 'tool.call.completed')
      expect(completed).toMatchObject({ result: { ok: true } })
      const content = await readFile(join(world.workspaceRoot, 'crlf.js'), 'utf8')
      expect(content).toBe('function sum(a, b) {\r\n  return a + b\r\n}\r\n')
    } finally {
      await world.cleanup()
    }
  })

  test('ambiguous oldText rejected without replaceAll', async () => {
    const original = 'foo\nfoo\n'
    const world = await makeWorld({
      mode: 'acceptEdits',
      files: { 'c.txt': original },
      turns: [
        toolCallTurn([
          {
            id: 'e3',
            name: 'Edit',
            input: {
              path: 'c.txt',
              oldText: 'foo',
              newText: 'bar',
              expectedVersion: computeVersion(original),
            },
          },
        ]),
        textTurn('ok'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'edit'),
      )
      const completed = result.facts.find(f => f.type === 'tool.call.completed')
      expect(completed).toMatchObject({
        result: { ok: false, errorCode: 'SEMANTIC_VALIDATION_ERROR' },
      })
      expect(await readFile(join(world.workspaceRoot, 'c.txt'), 'utf8')).toBe(original)
    } finally {
      await world.cleanup()
    }
  })
})

describe('Write tool', () => {
  test('refuses to overwrite existing file without overwrite=true', async () => {
    const world = await makeWorld({
      mode: 'acceptEdits',
      files: { 'exists.txt': 'original' },
      turns: [
        toolCallTurn([
          {
            id: 'w1',
            name: 'Write',
            input: { path: 'exists.txt', content: 'clobber' },
          },
        ]),
        textTurn('ok'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write'),
      )
      const completed = result.facts.find(f => f.type === 'tool.call.completed')
      expect(completed).toMatchObject({
        result: { ok: false, errorCode: 'SEMANTIC_VALIDATION_ERROR' },
      })
      expect(await readFile(join(world.workspaceRoot, 'exists.txt'), 'utf8')).toBe(
        'original',
      )
    } finally {
      await world.cleanup()
    }
  })

  test('creates new file with parent directories', async () => {
    const world = await makeWorld({
      mode: 'acceptEdits',
      turns: [
        toolCallTurn([
          {
            id: 'w2',
            name: 'Write',
            input: { path: 'deep/nested/new.txt', content: 'hello' },
          },
        ]),
        textTurn('created'),
      ],
    })
    try {
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'write'),
      )
      const completed = result.facts.find(f => f.type === 'tool.call.completed')
      expect(completed).toMatchObject({ result: { ok: true } })
      expect(
        await readFile(join(world.workspaceRoot, 'deep/nested/new.txt'), 'utf8'),
      ).toBe('hello')
    } finally {
      await world.cleanup()
    }
  })
})
