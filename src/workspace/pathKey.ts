import process from 'node:process'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Canonical workspace-relative identity for durable scope facts. */
export function workspacePathKey(workspaceRoot: string, path: string): string {
  const root = resolve(workspaceRoot)
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  const normalized = rel.split(sep).join('/')
  if (
    normalized.length === 0 ||
    isAbsolute(rel) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`path is not a workspace file: ${path}`)
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
