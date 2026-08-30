/**
 * Credential sanitization and secret detection.
 *
 * Rules:
 * - API keys never appear in logs, error messages, debug output or journal.
 * - A secret scanner checks outbound text before it reaches the terminal or
 *   the journal, replacing matches with a redacted placeholder.
 * - The config system prefers env vars / user-level store over project files
 *   for credentials (project files are committed; user files are not).
 */

/** Patterns that look like API keys or tokens in text. */
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // OpenAI / DeepSeek / generic sk- keys
  { pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g, label: 'sk-key' },
  // Anthropic keys
  { pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g, label: 'anthropic-key' },
  // GitHub tokens
  { pattern: /\bgh[pousr]_[a-zA-Z0-9]{36,}\b/g, label: 'github-token' },
  // AWS access key ids
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, label: 'aws-key' },
  // Generic bearer tokens in headers
  { pattern: /\bBearer\s+[a-zA-Z0-9._\-]{20,}\b/g, label: 'bearer-token' },
  // Generic long hex/base64 secrets preceded by key-like names
  {
    pattern: /\b(api[_-]?key|apikey|secret|token|password|passwd)\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})["']?/gi,
    label: 'generic-secret',
  },
]

const REDACTED = '[REDACTED]'

/**
 * Replace anything that looks like a credential with [REDACTED].
 * Applied to all terminal output, journal entries and error messages.
 */
export function sanitize(text: string): string {
  let result = text
  for (const { pattern } of SECRET_PATTERNS) {
    // reset lastIndex for global regexps
    pattern.lastIndex = 0
    result = result.replace(pattern, match => {
      // preserve the first 4 chars for debugging ("sk-5...")
      const prefix = match.slice(0, 4)
      return `${prefix}${REDACTED}`
    })
  }
  return result
}

/**
 * Detect secrets in text. Returns the labels of matched patterns.
 * Used by the secret scanner (pre-commit, journal validation).
 */
export function detectSecrets(text: string): Array<{ label: string; index: number }> {
  const hits: Array<{ label: string; index: number }> = []
  for (const { pattern, label } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      hits.push({ label, index: match.index })
    }
  }
  return hits
}

/**
 * Mask an API key for safe display: show first 4 and last 4 characters.
 * A key-shaped value is abbreviated to a short prefix and suffix.
 */
export function maskKey(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 3)}***`
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

/**
 * Recursively redact anything that looks like a credential inside an
 * arbitrary value (objects, arrays, strings). This is the SINGLE sanitizing
 * primitive — every outbound sink (terminal, journal, artifacts, manifests)
 * must funnel through it instead of writing ad-hoc masking.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return sanitize(value) as T
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map(item => {
      const cleaned = redactDeep(item)
      if (cleaned !== item) changed = true
      return cleaned
    })
    return (changed ? next : value) as T
  }
  if (value !== null && typeof value === 'object') {
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = redactDeep(item)
      if (cleaned !== item) changed = true
      next[key] = cleaned
    }
    return (changed ? next : value) as T
  }
  return value
}

/**
 * Scan a file's content for secrets. Returns lines that contain matches.
 * Used by the pre-commit hook and the `/scan` CLI command.
 */
export function scanFileContent(
  content: string,
  fileName: string,
): Array<{ line: number; label: string; preview: string }> {
  const results: Array<{ line: number; label: string; preview: string }> = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const hits = detectSecrets(lines[i]!)
    for (const hit of hits) {
      results.push({
        line: i + 1,
        label: hit.label,
        preview: `${fileName}:${i + 1}: ${sanitize(lines[i]!).trim().slice(0, 80)}`,
      })
    }
  }
  return results
}
