import type { EmbeddingProvider } from './types.js'

/**
 * Zero-network vector baseline. Identifier subwords and character trigrams
 * are feature-hashed into a normalized dense vector. This is deliberately
 * described as local vector retrieval, not as a learned semantic embedding.
 */
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly id: string

  constructor(readonly dimensions = 192) {
    if (!Number.isInteger(dimensions) || dimensions < 32) {
      throw new Error('embedding dimensions must be an integer >= 32')
    }
    this.id = 'local-hash-v1-' + dimensions
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    return texts.map(text => {
      if (signal?.aborted) throw abortError()
      const vector = new Array<number>(this.dimensions).fill(0)
      for (const feature of embeddingFeatures(text)) {
        const hash = fnv1a(feature)
        const index = hash % this.dimensions
        const sign = (hash & 0x80000000) === 0 ? 1 : -1
        vector[index] = (vector[index] ?? 0) + sign
      }
      const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
      return magnitude === 0 ? vector : vector.map(value => value / magnitude)
    })
  }
}

export function embeddingFeatures(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const words = normalized.match(/[\p{L}\p{N}_$.-]+/gu) ?? []
  const features: string[] = []
  for (const word of words) {
    features.push('w:' + word)
    for (const part of splitIdentifier(word)) features.push('p:' + part)
    const compact = word.replace(/[^\p{L}\p{N}]/gu, '')
    if (compact.length >= 3) {
      const bounded = '^' + compact + '$'
      for (let i = 0; i <= bounded.length - 3; i++) {
        features.push('g:' + bounded.slice(i, i + 3))
      }
    }
  }
  return features
}

export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC')
  const raw = normalized.match(/[\p{L}\p{N}_$.-]+/gu) ?? []
  const tokens: string[] = []
  for (const item of raw) {
    const lower = item.toLowerCase()
    tokens.push(lower)
    tokens.push(...splitIdentifier(item).map(part => part.toLowerCase()))
  }
  return tokens.filter(token => token.length > 0)
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_$./:\\-]+|\s+/)
    .map(part => part.trim())
    .filter(part => part.length > 1)
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function abortError(): Error {
  return Object.assign(new Error('embedding aborted'), { name: 'AbortError' })
}
