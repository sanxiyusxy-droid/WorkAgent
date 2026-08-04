import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/**
 * File version = sha256 of raw bytes. Used as the optimistic-concurrency
 * precondition for Edit: "I last read version X" must still hold at write
 * time, otherwise FILE_VERSION_CONFLICT.
 */
export function computeVersion(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

export async function readFileVersion(path: string): Promise<{
  content: string
  version: string
}> {
  const buffer = await readFile(path)
  return { content: buffer.toString('utf8'), version: computeVersion(buffer) }
}
