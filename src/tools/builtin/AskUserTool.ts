import { z } from 'zod'
import { defineTool } from '../Tool.js'

const AskUserInput = z
  .object({
    question: z.string().min(1),
    options: z.array(z.string()).optional(),
  })
  .strict()

/**
 * Structured question to the human. Pauses the loop (exclusive, blocking).
 * The interaction itself is the permission — but it requires a configured
 * channel; headless runs get a structured error instead of hanging.
 */
export const AskUserTool = defineTool<
  z.infer<typeof AskUserInput>,
  { answer: string }
>({
  name: 'AskUser',
  description:
    'Ask the human user a clarifying question and wait for the answer. ' +
    'Use for requirement ambiguity or decisions with user-visible trade-offs. ' +
    'Do not ask what you can find out by reading the workspace.',
  inputSchema: AskUserInput,
  maxResultChars: 10_000,
  readOnly: () => true,
  concurrency: () => 'exclusive',
  interruptBehavior: () => 'cancel',
  resources: () => [{ resource: 'state:user_interaction', mode: 'write' }],
  permission: async () => ({ behavior: 'allow' }),

  validate: async (_input, ctx) => {
    if (!ctx.services.askUser) {
      return {
        ok: false,
        error: {
          code: 'SEMANTIC_VALIDATION_ERROR',
          message: 'no interactive user channel available in this run',
          retryable: false,
          hint: 'Proceed with the most reasonable assumption and state it explicitly.',
        },
      }
    }
    return { ok: true }
  },

  execute: async (input, ctx) => {
    const answer = await ctx.services.askUser!({
      question: input.question,
      options: input.options,
    })
    return { data: { answer } }
  },

  serialize: output => ({
    kind: 'text',
    text: `User answered: ${output.answer}`,
  }),
})
