import { describe, expect, test } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../src/tools/builtin/ShellTool.js'
import { makeWorld, collectRun, stateWithUser } from './helpers.js'
import { textTurn, toolCallTurn } from '../src/model/ScriptedModel.js'

/**
 * Shell hardening E2E (guide §7): bounded output, process-tree kill on
 * timeout, and the engine-level contract for chatty commands.
 * Helper scripts are written to disk instead of inline `-e` strings so the
 * tests never depend on shell quoting behavior.
 */

const NODE = JSON.stringify(process.execPath)

describe('runProcess output bound', () => {
  test('chatty command: ring buffer keeps only the tail and marks truncation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-shell-'))
    try {
      // 150k of noise followed by a marker: the marker must survive because
      // the ring buffer retains the TAIL (errors/status live at the end)
      const script =
        "process.stdout.write('A'.repeat(150000));" +
        "process.stdout.write('TAIL-MARKER');"
      await writeFile(join(dir, 'chatty.js'), script, 'utf8')
      const controller = new AbortController()
      const result = await runProcess({
        command: `${NODE} chatty.js`,
        cwd: dir,
        timeoutMs: 30_000,
        signal: controller.signal,
      })
      expect(result.exitCode).toBe(0)
      expect(result.truncated.stdout).toBe(true)
      // memory stayed bounded: the retained string never exceeds capacity
      expect(result.stdout.length).toBeLessThanOrEqual(100_000)
      expect(result.stdout.endsWith('TAIL-MARKER')).toBe(true)
      expect(result.stdout.includes('A'.repeat(1000))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runProcess timeout and process-tree kill', () => {
  test('timeout kills the whole tree: grandchild heartbeat stops', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-shell-'))
    try {
      // spawner: forks a grandchild writing a heartbeat every 100ms, then
      // idles forever. The grandchild stays in the same process group (no
      // detached) so a group/tree kill must take it down too.
      const spawner = `
const { spawn } = require('child_process')
const path = require('path')
const hb = path.join(__dirname, process.argv[2])
spawn(process.execPath, ['-e',
  "const fs=require('fs');const hb=" + JSON.stringify(hb) +
  ";setInterval(()=>fs.writeFileSync(hb,String(Date.now())),100)"],
  { stdio: 'ignore' })
setInterval(() => {}, 1000)
`
      await writeFile(join(dir, 'spawner.js'), spawner, 'utf8')
      const controller = new AbortController()
      const startedAt = Date.now()
      const result = await runProcess({
        command: `${NODE} spawner.js hb.txt`,
        cwd: dir,
        timeoutMs: 800,
        signal: controller.signal,
      })
      expect(result.timedOut).toBe(true)
      expect(result.exitCode === null || result.exitCode !== 0).toBe(true)
      // the promise must settle promptly after the timeout, not hang
      expect(Date.now() - startedAt).toBeLessThan(10_000)

      // heartbeat proof: if the grandchild survived, hb.txt keeps changing
      await new Promise(resolve => setTimeout(resolve, 600))
      const t1 = await readFile(join(dir, 'hb.txt'), 'utf8')
      await new Promise(resolve => setTimeout(resolve, 400))
      const t2 = await readFile(join(dir, 'hb.txt'), 'utf8')
      expect(t2).toBe(t1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('abort signal kills the tree as well', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-shell-'))
    try {
      await writeFile(
        join(dir, 'sleeper.js'),
        'setInterval(() => {}, 1000)',
        'utf8',
      )
      const controller = new AbortController()
      const pending = runProcess({
        command: `${NODE} sleeper.js`,
        cwd: dir,
        timeoutMs: 30_000,
        signal: controller.signal,
      })
      await new Promise(resolve => setTimeout(resolve, 300))
      controller.abort()
      const startedAt = Date.now()
      const result = await pending
      expect(result.exitCode === null || result.exitCode !== 0).toBe(true)
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Shell E2E through the engine', () => {
  test('chatty command: tool result stays bounded via externalization', async () => {
    const world = await makeWorld({
      mode: 'bypassPermissions',
      turns: [
        toolCallTurn([
          { id: 's1', name: 'Shell', input: { command: `${NODE} chatty.js` } },
        ]),
        textTurn('done'),
        textTurn('The command succeeded, but no workspace-wide validation was run.'),
      ],
    })
    try {
      await writeFile(
        join(world.workspaceRoot, 'chatty.js'),
        "process.stdout.write('B'.repeat(150000));process.stdout.write('END');",
        'utf8',
      )
      const result = await collectRun(
        world.runtime.engine,
        await stateWithUser(world, 'run the chatty command'),
      )
      expect(result.terminal.reason).toBe('completed_with_unverified_items')
      const completed = result.facts.find(
        f => f.type === 'tool.call.completed' && f.result.callId === 's1',
      )
      expect(completed).toBeDefined()
      if (completed && completed.type === 'tool.call.completed') {
        expect(completed.result.ok).toBe(true)
        // 100k ring-tail + framing > the 30k tool result cap, so the output
        // is externalized to an artifact instead of bloating the context
        expect(completed.result.content.kind).toBe('externalized')
        if (completed.result.content.kind === 'externalized') {
          expect(completed.result.content.originalChars).toBeLessThanOrEqual(
            110_000,
          )
        }
      }
    } finally {
      await world.cleanup()
    }
  })
})
