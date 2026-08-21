import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolResultContent } from '../core/messages.js'
import { sanitize as redactSecrets } from '../security/secrets.js'

export interface BoundOptions {
  callId: string
  toolName: string
  maxChars: number
}

/**
 * Output budget: large results are externalized to the session artifact
 * directory instead of being truncated and lost. The replacement text for a
 * given callId is frozen forever — resume and prompt cache must stay
 * byte-identical.
 */
export class ToolOutputStore {
  /** callId -> frozen replacement content */
  private readonly frozen = new Map<string, ToolResultContent>()

  constructor(private readonly artifactDir: string) {}

  async bound(
    content: ToolResultContent,
    options: BoundOptions,
  ): Promise<ToolResultContent> {
    const existing = this.frozen.get(options.callId)
    if (existing) return existing

    const text = renderText(content)
    if (text.length <= options.maxChars) {
      this.frozen.set(options.callId, content)
      return content
    }

    const dir = join(this.artifactDir, 'tool-results')
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, `${sanitizeFileName(options.callId)}.txt`)
    // SANITIZING SINK: externalized artifacts live outside the journal, so
    // they get the same credential redaction independently.
    const redacted = redactSecrets(text)
    await writeFile(filePath, redacted, 'utf8')

    const sha256 = createHash('sha256').update(redacted).digest('hex')
    const previewChars = Math.max(200, Math.floor(options.maxChars / 4))
    const externalized: ToolResultContent = {
      kind: 'externalized',
      artifactId: options.callId,
      path: filePath,
      originalChars: redacted.length,
      sha256,
      previewHead: redacted.slice(0, previewChars),
      previewTail: redacted.slice(-previewChars),
    }
    this.frozen.set(options.callId, externalized)
    return externalized
  }

  /** Used on resume so replacements stay byte-identical. */
  restoreFrozen(callId: string, content: ToolResultContent): void {
    this.frozen.set(callId, content)
  }
}

export function renderText(content: ToolResultContent): string {
  switch (content.kind) {
    case 'text':
      return content.text
    case 'json':
      return JSON.stringify(content.value, null, 2)
    case 'externalized':
      return [
        `Output is ${content.originalChars} characters and was stored at:`,
        content.path,
        '',
        'Preview (head):',
        content.previewHead,
        '',
        'Preview (tail):',
        content.previewTail,
        '',
        'Use Read with offset/limit to inspect the complete output.',
        `sha256: ${content.sha256}`,
      ].join('\n')
  }
}

/** Provider-facing envelope. Contract observations stay structured instead
 * of forcing the model to scrape a human-oriented serializer. */
export function renderModelToolResult(input: {
  content: ToolResultContent
  observation?: import('../core/messages.js').ToolObservation
}): string {
  if (!input.observation) return renderText(input.content)
  return JSON.stringify({
    observation: input.observation,
    output: renderText(input.content),
  })
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}
