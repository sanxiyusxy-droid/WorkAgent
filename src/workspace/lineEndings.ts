/**
 * Line-ending tolerant text matching for the mutation tools.
 *
 * Models almost always emit LF newlines in oldText/newText, while files on
 * Windows commonly use CRLF. An exact-match-only policy makes every Edit fail on
 * such files, so when the exact needle misses we retry with both sides
 * normalized to LF and convert the replacement back to the file's line
 * ending. Exact matches always win; the fallback only fires on a miss.
 */
export interface ReplaceMatch {
  /** number of occurrences of the (possibly normalized) oldText */
  occurrences: number
  /** oldText to match against the raw content */
  oldText: string
  /** newText converted to the file's line-ending style */
  newText: string
}

export function matchForReplace(
  content: string,
  oldText: string,
  newText: string,
): ReplaceMatch {
  const exact = countOccurrences(content, oldText)
  if (exact > 0) {
    return { occurrences: exact, oldText, newText }
  }
  // no newlines involved -> normalization cannot possibly help
  if (!oldText.includes('\n')) {
    return { occurrences: 0, oldText, newText }
  }
  const normalizedContent = content.replace(/\r\n/g, '\n')
  const normalizedOld = oldText.replace(/\r\n/g, '\n')
  const normalized = countOccurrences(normalizedContent, normalizedOld)
  if (normalized === 0) {
    return { occurrences: 0, oldText, newText }
  }
  // write back in the file's dominant line-ending style
  const crlf = content.includes('\r\n')
  if (!crlf) {
    return {
      occurrences: normalized,
      oldText: normalizedOld,
      newText: newText.split('\r\n').join('\n'),
    }
  }
  const toCrlf = (text: string) => text.split('\r\n').join('\n').split('\n').join('\r\n')
  return {
    occurrences: normalized,
    oldText: toCrlf(normalizedOld),
    newText: toCrlf(newText),
  }
}

export function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
