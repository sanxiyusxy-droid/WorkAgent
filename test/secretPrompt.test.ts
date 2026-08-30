import { PassThrough, Writable } from 'node:stream'
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline/promises'
import { describe, expect, test } from 'vitest'
import {
  ConcealableTerminalOutput,
  questionSecret,
} from '../src/cli/secretPrompt.js'
import { runSetupWizard } from '../src/cli/setupWizard.js'

function captureDestination(): {
  destination: Writable
  text: () => string
} {
  let captured = ''
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      captured += chunk.toString()
      callback()
    },
  })
  return { destination, text: () => captured }
}

describe('non-echoing secret prompt', () => {
  test('shows the prompt but suppresses readline echo and cursor redraws', async () => {
    const captured = captureDestination()
    const output = new ConcealableTerminalOutput(captured.destination)
    const rl = {
      question: async (prompt: string) => {
        expect(prompt).toBe('')
        output.write('super-secret-key')
        output.write('\u001b[2Kcursor-redraw')
        return 'super-secret-key'
      },
    } as unknown as ReadlineInterface

    await expect(questionSecret(rl, output, 'API key: ')).resolves.toBe(
      'super-secret-key',
    )
    expect(captured.text()).toBe('API key: \n')
  })

  test('restores visible output when reading fails', async () => {
    const captured = captureDestination()
    const output = new ConcealableTerminalOutput(captured.destination)
    const history = ['existing command']
    const rl = {
      history,
      question: async () => {
        history.unshift('must-not-remain-in-history')
        output.write('must-not-leak')
        throw new Error('input closed')
      },
    } as unknown as ReadlineInterface

    await expect(questionSecret(rl, output, 'API key: ')).rejects.toThrow(
      'input closed',
    )
    output.write('visible again')
    expect(captured.text()).toBe('API key: \nvisible again')
    expect(history).toEqual(['existing command'])
  })

  test('removes the secret from a real readline history before echo resumes', async () => {
    const input = new PassThrough()
    const captured = captureDestination()
    const output = new ConcealableTerminalOutput(captured.destination)
    const rl = createInterface({
      input,
      output: output as NodeJS.WritableStream,
      terminal: true,
      historySize: 20,
    })
    const history = (rl as ReadlineInterface & { history: string[] }).history
    history.push('existing command')
    let inputHandle: NodeJS.Immediate | undefined
    try {
      const answer = questionSecret(rl, output, 'API key: ')
      // questionSecret first awaits an output-drain microtask. Queue input on
      // the next turn so the real readline question has installed listeners.
      inputHandle = setImmediate(() => input.write('history-sensitive-key\n'))
      await expect(answer).resolves.toBe('history-sensitive-key')
      expect(history).toEqual(['existing command'])
      expect(captured.text()).not.toContain('history-sensitive-key')
    } finally {
      if (inputHandle) clearImmediate(inputHandle)
      rl.close()
    }
  })

  test('setup refuses to fall back to an echoing readline question', async () => {
    const rl = { question: async () => '1' } as unknown as ReadlineInterface
    await expect(runSetupWizard(rl)).rejects.toThrow(/non-echoing API-key prompt/)
  })
})
