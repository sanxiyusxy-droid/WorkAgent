import { tokenize } from './LocalHashEmbedding.js'
import type { RetrievalIntent, RetrievalQueryPlan } from './types.js'

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'what', 'when',
  'where', 'which', 'with', 'why', 'find', 'show', 'get', 'code',
])

export function planRetrievalQuery(
  query: string,
  requestedIntent: RetrievalIntent | 'auto' = 'auto',
): RetrievalQueryPlan {
  const normalized = query.normalize('NFKC').replace(/\s+/g, ' ').trim()
  const phrases = unique(
    [...normalized.matchAll(/["“”']([^"“”']{2,160})["“”']/g)]
      .map(match => match[1]!.trim().toLowerCase()),
  )
  const terms = unique(tokenize(normalized))
    .filter(term => term.length > 1 && !STOP_WORDS.has(term))
    .slice(0, 32)
  const identifiers = unique(
    (normalized.match(/[A-Za-z_$][\w$.-]*/g) ?? [])
      .filter(value =>
        /[A-Z_$.-]/.test(value) || /\d/.test(value) || value.length >= 5,
      )
      .flatMap(value => tokenize(value))
      .filter(term => term.length > 1 && !STOP_WORDS.has(term)),
  ).slice(0, 16)
  const expansions = expandDomainTerms(terms)
  const intent = requestedIntent === 'auto'
    ? inferIntent(normalized)
    : requestedIntent
  const variants = unique([
    normalized,
    terms.join(' '),
    identifiers.join(' '),
    expansions.join(' '),
    ...phrases,
  ]).filter(value => value.length > 0).slice(0, 4)
  return {
    original: query,
    normalized,
    intent,
    terms,
    identifiers,
    expansions,
    phrases,
    variants,
  }
}

function expandDomainTerms(terms: string[]): string[] {
  const present = new Set(terms)
  const expanded: string[] = []
  if (present.has('pipeline') || present.has('execution')) expanded.push('runtime')
  if (present.has('permission') || present.has('permissions')) expanded.push('policy')
  if (present.has('recovery') || present.has('replay')) expanded.push('session', 'journal')
  if (present.has('compact') || present.has('compaction')) expanded.push('context')
  if (present.has('approval')) expanded.push('token', 'version')
  if (present.has('reference') || present.has('references')) expanded.push('symbol')
  return unique(expanded.filter(term => !present.has(term))).slice(0, 8)
}

function inferIntent(query: string): RetrievalIntent {
  const lower = query.toLowerCase()
  if (/\b(test|tests|testing|spec|specs|coverage|fixture)\b|测试|用例|覆盖率/.test(lower)) {
    return 'tests'
  }
  if (/\b(doc|docs|documentation|readme|guide|architecture|adr)\b|文档|说明|架构/.test(lower)) {
    return 'documentation'
  }
  if (/\b(config|configuration|json|yaml|yml|toml|setting|settings)\b|配置/.test(lower)) {
    return 'configuration'
  }
  return 'implementation'
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim().toLowerCase()))]
}
