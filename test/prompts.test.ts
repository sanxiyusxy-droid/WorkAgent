import { describe, expect, test } from 'vitest'
import type { Interface as ReadlineInterface } from 'node:readline/promises'
import { Spinner } from '../src/cli/spinner.js'
import { askPermission, askPlanApproval, askUserQuestion } from '../src/cli/prompts.js'
import { PolicyEngine } from '../src/policy/PolicyEngine.js'
import { createSequentialIds } from '../src/core/runtimePrimitives.js'
import { fixedClock } from './helpers.js'
import { WriteTool } from '../src/tools/builtin/WriteTool.js'
import { ShellTool } from '../src/tools/builtin/ShellTool.js'
import { ReadTool } from '../src/tools/builtin/ReadTool.js'
import type { ToolContext } from '../src/tools/Tool.js'
import type { PlanVersion } from '../src/planning/types.js'

const ERASE = '\r\u001b[2K'

/** Fake readline that answers scripted lines. */
function fakeReadline(answers: string[]): {
  rl: ReadlineInterface
  asked: string[]
} {
  const asked: string[] = []
  const rl = {
    question: async (prompt: string) => {
      asked.push(prompt)
      return answers.shift() ?? ''
    },
  } as unknown as ReadlineInterface
  return { rl, asked }
}

function harness(answers: string[], options: { intervalMs?: number } = {}) {
  const chunks: string[] = []
  const write = (text: string) => chunks.push(text)
  const spinner = new Spinner({
    write,
    isTty: true, // force ticking so the regression can actually reproduce
    intervalMs: options.intervalMs ?? 5,
  })
  const policy = new PolicyEngine({ clock: fixedClock(), ids: createSequentialIds() })
  const { rl, asked } = fakeReadline(answers)
  return {
    deps: { rl, spinner, policy, write },
    spinner,
    policy,
    chunks,
    asked,
    raw: () => chunks.join(''),
  }
}

function makeCtx(): ToolContext {
  return {
    sessionId: 'ses_1',
    callId: 'call_1',
    workspaceRoot: 'C:/ws',
    mode: 'default',
    artifactDir: 'C:/ws/.agent',
    signal: new AbortController().signal,
    clock: fixedClock(),
    ids: createSequentialIds(),
    services: {},
  }
}

const PLAN: PlanVersion = {
  planId: 'plan_1',
  version: 1,
  status: 'awaiting_approval',
  goal: 'build the thing',
  nonGoals: [],
  assumptions: ['node is installed'],
  decisions: [],
  steps: [
    { id: 's1', title: 'scaffold', description: '', files: [], dependsOn: [], expectedOutcome: '' },
  ],
  acceptanceCriteria: [
    { id: 'ac1', statement: 'tests pass', evidenceKind: 'test', required: true },
  ],
  risks: [],
  createdAt: 't',
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('interactive prompts do not fight the spinner', () => {
  test('askPermission stops the spinner timer before reading input', async () => {
    const h = harness(['y'])
    h.spinner.start('running tools…')
    expect(h.spinner.isRunning).toBe(true)

    const decision = await askPermission(
      h.deps,
      { tool: WriteTool, input: { path: 'a.txt', content: 'x', overwrite: false } },
      { type: 'tool_policy', code: 'tool_ask' },
    )

    // regression: with clear() the timer kept erasing the line the user typed on,
    // which silently turned "y" into an empty answer and denied the action
    expect(h.spinner.isRunning).toBe(false)
    expect(decision).toBe('allow')
  })

  test('no erase sequence is emitted after the question is printed', async () => {
    const h = harness(['y'], { intervalMs: 5 })
    h.spinner.start('running tools…')
    await sleep(20) // let it tick a few times

    const before = h.chunks.length
    await askPermission(
      h.deps,
      { tool: WriteTool, input: { path: 'a.txt', content: 'x', overwrite: false } },
      { type: 'default' },
    )
    await sleep(30) // a live timer would erase here

    const after = h.chunks.slice(before).join('')
    // exactly one erase: the one that removed the spinner itself
    expect(after.split(ERASE).length - 1).toBe(1)
    expect(after.indexOf(ERASE)).toBeLessThan(after.indexOf('permission required'))
  })

  test('answers map to decisions; empty input denies', async () => {
    const yes = harness(['y'])
    expect(
      await askPermission(
        yes.deps,
        { tool: ReadTool, input: { path: 'a.txt', offset: 0, limit: 10 } },
        { type: 'default' },
      ),
    ).toBe('allow')

    const empty = harness([''])
    expect(
      await askPermission(
        empty.deps,
        { tool: WriteTool, input: { path: 'a.txt', content: 'x', overwrite: false } },
        { type: 'default' },
      ),
    ).toBe('deny')

    const no = harness(['n'])
    expect(
      await askPermission(
        no.deps,
        { tool: WriteTool, input: { path: 'a.txt', content: 'x', overwrite: false } },
        { type: 'default' },
      ),
    ).toBe('deny')
  })

  test('"a" allows and installs a session rule that survives the next call', async () => {
    const h = harness(['a'])
    const decision = await askPermission(
      h.deps,
      { tool: WriteTool, input: { path: 'a.txt', content: 'x', overwrite: false } },
      { type: 'default' },
    )
    expect(decision).toBe('allow')
    expect(h.raw()).toContain('session rule added')

    // the rule must now allow the same tool without asking again
    const second = await h.policy.decide({
      tool: WriteTool,
      input: { path: 'b.txt', content: 'y', overwrite: false },
      callId: 'call_2',
      mode: 'default',
      context: makeCtx(),
    })
    expect(second.behavior).toBe('allow')
    expect(second.reason).toMatchObject({ type: 'user_rule' })
  })

  test('shell "always" proposals are argv-scoped, and absent for interpreters', async () => {
    const h = harness(['a'])
    await askPermission(
      h.deps,
      { tool: ShellTool, input: { command: 'npm test', timeoutMs: 1000 } },
      { type: 'tool_policy', code: 'shell_write' },
    )
    expect(h.raw()).toContain('Shell commands starting with "npm test"')

    // `node` can execute anything: no persistent rule may be offered
    const interpreter = harness(['a'])
    const decision = await askPermission(
      interpreter.deps,
      { tool: ShellTool, input: { command: 'node script.js', timeoutMs: 1000 } },
      { type: 'tool_policy', code: 'shell_write' },
    )
    expect(interpreter.raw()).not.toContain('always:')
    expect(decision).toBe('deny') // "a" without a proposal is not an approval
  })

  test('permission reasons are explained in plain language', async () => {
    const h = harness([''])
    await askPermission(
      h.deps,
      { tool: WriteTool, input: { path: 'a.txt', content: 'x', overwrite: false } },
      { type: 'tool_policy', code: 'tool_ask' },
    )
    expect(h.raw()).toContain('this tool changes files and needs your approval')
    expect(h.raw()).not.toContain('tool policy: tool_ask')
  })

  test('plan approval stops the spinner and offers confirm-and-execute', async () => {
    const h = harness(['y'])
    h.spinner.start('thinking…')
    const approved = await askPlanApproval(h.deps, PLAN)
    expect(h.spinner.isRunning).toBe(false)
    expect(approved).toBe(true)
    const raw = h.raw()
    expect(raw).toContain('confirm and execute')
    expect(raw).toContain('build the thing')
    expect(raw).toContain('ac1')
  })

  test('askUser stops the spinner and supports numeric option shortcuts', async () => {
    const h = harness(['2'])
    h.spinner.start('running tools…')
    const answer = await askUserQuestion(h.deps, {
      question: 'which one?',
      options: ['first', 'second'],
    })
    expect(h.spinner.isRunning).toBe(false)
    expect(answer).toBe('second')
  })
})
