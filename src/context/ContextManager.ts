import type { ConversationMessage, ContentBlock } from '../core/messages.js'
import type { FactEvent } from '../core/events.js'
import type { ModelGateway } from '../model/types.js'
import type { Clock, IdGenerator } from '../core/runtimePrimitives.js'
import { StreamAssembler } from '../model/StreamAssembler.js'
import { renderText } from '../tools/ToolOutputStore.js'

export interface ContextBudgetConfig {
  /** context window of the target model, in tokens */
  window: number
  /** expected model output reservation */
  reservedOutput: number
  /** fixed safety buffer (guide: absolute amount, not a percentage) */
  safetyBuffer: number
  /** how many trailing messages are always kept verbatim */
  recentTailMessages: number
  /** token budget for the protected tail (overrides message count when set) */
  recentTailTokens: number
  /** consecutive compact failures before the circuit breaker opens */
  compactFailureLimit: number
  /**
   * Conservative bias applied to the chars/4 token estimate, in percent.
   * No provider-specific tokenizer is bundled; this margin absorbs the
   * worst-case drift of the estimator (code-heavy and CJK text pack more
   * tokens per char than prose). Budget decisions use the biased estimate,
   * so the agent compacts early rather than hitting PROMPT_TOO_LONG.
   */
  estimationMarginPct: number
}

export const DEFAULT_CONTEXT_CONFIG: ContextBudgetConfig = {
  window: 128_000,
  reservedOutput: 4_096,
  safetyBuffer: 12_000,
  recentTailMessages: 6,
  recentTailTokens: 16_000,
  compactFailureLimit: 3,
  estimationMarginPct: 15,
}

/** Cheap deterministic token estimate (chars/4). */
export function estimateTokens(messages: ConversationMessage[]): number {
  let chars = 0
  for (const message of messages) {
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
        case 'thinking':
          chars += block.text.length
          break
        case 'tool_call':
          chars += JSON.stringify(block.input ?? {}).length + 40
          break
        case 'tool_result':
          chars += renderText(block.content).length + 20
          chars += block.observation ? JSON.stringify(block.observation).length : 0
          break
      }
    }
    chars += 30 // per-message overhead
  }
  return Math.ceil(chars / 4)
}

export function availableForMessages(config: ContextBudgetConfig): number {
  return config.window - config.reservedOutput - config.safetyBuffer
}

/** Tool results that can be re-fetched are the only micro-compact targets. */
const REFETCHABLE_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'Shell', 'ShellReadOnly',
  'CodeSymbols', 'FindReferences', 'CallGraph', 'CodeDiagnostics',
])

const SUMMARY_PROMPT = `Summarize the conversation so far for a coding agent that will continue the work. Output plain text with these sections, precise and complete:

1. USER INTENT (verbatim quotes of the user's requests, latest goal first)
2. USER CONSTRAINTS (explicit limits, preferences, "do not" instructions)
3. CURRENT GOAL and exact next action
4. DECISIONS made and why
5. REPOSITORY FACTS (files read/modified/created with exact paths, plus any file versions/hashes that were mentioned)
6. ERRORS and their resolution status
7. TASK/PLAN STATE (ids, statuses, pending approvals)
8. OUTSTANDING ITEMS (unfinished work that must survive compaction)

Do not call tools. Do not invent tasks that were not discussed. File names, commands, versions and error messages must be exact.`

export interface PrepareResult {
  facts: FactEvent[]
  /** true when auto-compact is circuit-broken */
  compactBroken: boolean
}

/**
 * Layered context manager (guide §10):
 * L0 output budget is enforced by ToolOutputStore at tool time.
 * L1 micro-compact clears old re-fetchable tool results (lossless: journal keeps originals).
 * L3 auto summary via the model — last resort, circuit-broken after repeated failures.
 * All mutations are expressed as context.compacted facts so replay is deterministic.
 */
export class ContextManager {
  private compactFailures = 0

  constructor(
    private readonly deps: {
      model: ModelGateway
      clock: Clock
      ids: IdGenerator
      config?: Partial<ContextBudgetConfig>
    },
  ) {}

  get config(): ContextBudgetConfig {
    return { ...DEFAULT_CONTEXT_CONFIG, ...this.deps.config }
  }

  get failuresSoFar(): number {
    return this.compactFailures
  }

  /**
   * Token estimate used for every budget decision: the raw chars/4 estimator
   * inflated by the configured conservative margin (tokenizer drift).
   */
  private estimate(messages: ConversationMessage[]): number {
    const margin = 1 + this.config.estimationMarginPct / 100
    return Math.ceil(estimateTokens(messages) * margin)
  }

  /** Restore circuit breaker state from snapshot (recovery path). */
  restoreFailures(count: number): void {
    this.compactFailures = count
  }

  /**
   * Compute the protected tail boundary using token budget.
   * Messages from this index onward are never compacted.
   * Uses token-based protection (recentTailTokens) with message-count fallback.
   */
  private tailBoundary(messages: ConversationMessage[], config: ContextBudgetConfig): number {
    // message-count floor: always protect at least this many
    const messageBoundary = Math.max(0, messages.length - config.recentTailMessages)
    // token-based: walk backwards until we exceed the token budget
    let tokens = 0
    let tokenBoundary = messages.length
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.estimate([messages[i]!])
      if (tokens + msgTokens > config.recentTailTokens) break
      tokens += msgTokens
      tokenBoundary = i
    }
    // token budget is a hard cap on tail size; message count is a floor.
    // Use the higher boundary (less protective) to avoid over-protecting,
    // but never go below the message-count floor.
    return Math.max(tokenBoundary, messageBoundary)
  }

  /**
   * Exact protected set (guide §10.4): only the LATEST human message (the
   * current user goal) and engine-injected synthetic messages (approvals,
   * active plan / task state, replan instructions, recovery notes) must
   * survive verbatim. OLDER human messages are compressible — their content
   * is preserved by the structured summary instead.
   */
  private isIncompressible(message: ConversationMessage, index: number, messages: ConversationMessage[]): boolean {
    if (message.meta?.source === 'engine' && message.meta?.synthetic) return true
    if (message.meta?.source === 'human') return index === this.latestHumanIndex(messages)
    return false
  }

  private latestHumanIndex(messages: ConversationMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.meta?.source === 'human') return i
    }
    return -1
  }

  /**
   * Called at the top of every loop iteration. Returns facts to apply.
   * Order: estimate -> micro compact -> re-estimate -> auto compact.
   */
  async prepare(input: {
    messages: ConversationMessage[]
    sessionId: string
    turnId: string
    force?: boolean
  }): Promise<PrepareResult> {
    const config = this.config
    const budget = availableForMessages(config)
    const facts: FactEvent[] = []

    let estimate = this.estimate(input.messages)
    if (!input.force && estimate <= budget) {
      return { facts, compactBroken: false }
    }

    // ---- L1: micro compact (cheap, lossless — originals stay in journal) ----
    const micro = this.microCompact(input.messages, config)
    if (micro) {
      facts.push({ type: 'context.compacted', record: micro.record })
      estimate = this.estimate(micro.messages)
      if (!input.force && estimate <= budget) {
        return { facts, compactBroken: false }
      }
    }

    // ---- circuit breaker ----
    if (this.compactFailures >= config.compactFailureLimit) {
      return { facts, compactBroken: true }
    }

    // ---- L3: model summary (expensive, lossy — last resort) ----
    const base = micro ? micro.messages : input.messages
    try {
      const tailStart = this.tailBoundary(base, config)
      // exact protected set: within the head, only compressible messages are
      // cleared into the summary; approvals / plan state / latest user goal
      // stay verbatim in place
      const cleared: ConversationMessage[] = []
      for (const [index, message] of base.slice(0, tailStart).entries()) {
        if (!this.isIncompressible(message, index, base)) cleared.push(message)
      }
      if (cleared.length === 0) {
        return { facts, compactBroken: false }
      }
      const summary = await this.summarize(cleared, input.sessionId, input.turnId)
      const kept = [...base.filter(m => !cleared.includes(m)), summary]
      facts.push({
        type: 'context.compacted',
        record: {
          kind: 'auto',
          clearedMessageIds: cleared.map(m => m.id),
          replacements: [summary],
          summaryMessageId: summary.id,
          tokensBefore: estimate,
          tokensAfter: this.estimate(kept),
        },
      })
      this.compactFailures = 0
      return { facts, compactBroken: false }
    } catch {
      this.compactFailures += 1
      return {
        facts,
        compactBroken: this.compactFailures >= config.compactFailureLimit,
      }
    }
  }

  /**
   * Reactive path for PROMPT_TOO_LONG (guide §10.7): one forced compact,
   * caller retries the original request exactly once.
   */
  async reactiveCompact(input: {
    messages: ConversationMessage[]
    sessionId: string
    turnId: string
  }): Promise<PrepareResult> {
    return this.prepare({ ...input, force: true })
  }

  // ---- internals ----

  private microCompact(
    messages: ConversationMessage[],
    config: ContextBudgetConfig,
  ): { record: Extract<FactEvent, { type: 'context.compacted' }>['record']; messages: ConversationMessage[] } | null {
    const protectedFrom = this.tailBoundary(messages, config)
    const clearedIds: string[] = []
    const replacements: ConversationMessage[] = []
    const next: ConversationMessage[] = []

    for (const [index, message] of messages.entries()) {
      // never clear: incompressible zones, recent tail, anything but tool results
      if (index >= protectedFrom || this.isIncompressible(message, index, messages)) {
        next.push(message)
        continue
      }
      const clearable =
        message.role === 'user' &&
        message.meta?.source === 'tool' &&
        message.content.every(
          b => b.type === 'tool_result',
        )
      if (!clearable) {
        next.push(message)
        continue
      }
      const blocks: ContentBlock[] = message.content.map(block => {
        if (block.type !== 'tool_result') return block
        const rendered = renderText(block.content)
        if (rendered.length < 500) return block
        return {
          ...block,
          content: {
            kind: 'text' as const,
            text: `[Old tool result cleared to save context: callId=${block.callId}, ${rendered.length} chars. Re-run the tool if needed; the original is in the session journal.]`,
          },
          // The complete structured observation is also re-fetchable and
          // remains in the journal. Keeping it on every cleared result would
          // make long sessions grow linearly even after output compaction.
          observation: undefined,
        }
      })
      const changed = blocks.some((b, i) => b !== message.content[i])
      if (!changed) {
        next.push(message)
        continue
      }
      const replacement: ConversationMessage = {
        ...message,
        id: this.deps.ids.next('msg'),
        content: blocks,
        meta: { ...message.meta, synthetic: true },
      }
      clearedIds.push(message.id)
      replacements.push(replacement)
      next.push(replacement)
    }

    if (clearedIds.length === 0) return null
    return {
      record: {
        kind: 'micro',
        clearedMessageIds: clearedIds,
        replacements,
        tokensBefore: this.estimate(messages),
        tokensAfter: this.estimate(next),
      },
      messages: next,
    }
  }

  private async summarize(
    messages: ConversationMessage[],
    sessionId: string,
    turnId: string,
  ): Promise<ConversationMessage> {
    const transcript = messages
      .map(message => {
        const text = message.content
          .map(block => {
            if (block.type === 'text') return block.text
            if (block.type === 'tool_call') {
              return `[tool_call ${block.name} ${JSON.stringify(block.input).slice(0, 200)}]`
            }
            if (block.type === 'tool_result') {
              return `[tool_result ${block.callId}: ${renderText(block.content).slice(0, 300)}]`
            }
            return ''
          })
          .join('\n')
        return `--- ${message.role} ---\n${text}`
      })
      .join('\n\n')

    const request = {
      system: SUMMARY_PROMPT,
      messages: [
        {
          id: this.deps.ids.next('msg'),
          parentId: null,
          sessionId,
          turnId,
          role: 'user' as const,
          content: [{ type: 'text' as const, text: transcript.slice(0, 300_000) }],
          createdAt: this.deps.clock.isoNow(),
        },
      ],
      tools: [], // summarizer must not call tools
      maxOutputTokens: 2_048,
    }

    const assembler = new StreamAssembler({
      ids: this.deps.ids,
      clock: this.deps.clock,
      sessionId,
      turnId,
      parentId: null,
      model: this.deps.model.modelId,
    })
    const controller = new AbortController()
    for await (const event of this.deps.model.stream(request, controller.signal)) {
      assembler.push(event)
    }
    const turn = assembler.finish()
    const text = turn.message.content
      .filter(b => b.type === 'text')
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('')
    if (text.trim().length === 0) {
      throw new Error('empty summary')
    }

    return {
      id: this.deps.ids.next('msg'),
      parentId: null,
      sessionId,
      turnId,
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            '[CONTEXT SUMMARY — earlier conversation was compacted. ' +
            'Full history remains in the session journal.]\n\n' + text,
        },
      ],
      createdAt: this.deps.clock.isoNow(),
      // NOT synthetic: summaries are recursively compactable — a later L3
      // round folds stale summaries into the new one, so they cannot accrue
      // without bound in long sessions
      meta: { source: 'engine' },
    }
  }
}
