import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'

export interface PathCheck {
  ok: boolean
  resolved: string
  reason?: 'outside_workspace' | 'sensitive_path' | 'invalid_path' | 'symlink_escape'
}

/** Sensitive path fragments that even bypassPermissions must not write to. */
const SENSITIVE_SEGMENTS = [
  '.git',
  '.hg',
  '.agent',
  '.ssh',
  '.aws',
  '.gnupg',
  '.npmrc',
  '.pypirc',
]

const SENSITIVE_FILES = new Set([
  '.bashrc',
  '.zshrc',
  '.profile',
  '.bash_profile',
])

/**
 * Path policy pipeline: reject NUL, resolve against workspace root,
 * normalize dot segments, then check escape and sensitive targets.
 * Parse failure is treated as high-risk (invalid, never silently allowed).
 */
export function checkPath(
  rawPath: string,
  workspaceRoot: string,
): PathCheck {
  if (rawPath.length === 0 || rawPath.includes('\0')) {
    return { ok: false, resolved: rawPath, reason: 'invalid_path' }
  }

  const root = resolve(workspaceRoot)
  const resolved = isAbsolute(rawPath)
    ? normalize(rawPath)
    : resolve(root, rawPath)

  const rel = relative(root, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, resolved, reason: 'outside_workspace' }
  }

  const segments = rel.split(sep).filter(Boolean)
  for (const segment of segments) {
    if (SENSITIVE_SEGMENTS.includes(segment.toLowerCase())) {
      return { ok: false, resolved, reason: 'sensitive_path' }
    }
  }
  const base = segments[segments.length - 1]
  if (base && SENSITIVE_FILES.has(base.toLowerCase())) {
    return { ok: false, resolved, reason: 'sensitive_path' }
  }

  return { ok: true, resolved }
}

/** Read-side check: only forbids escaping the workspace. */
export function checkReadPath(rawPath: string, workspaceRoot: string): PathCheck {
  if (rawPath.length === 0 || rawPath.includes('\0')) {
    return { ok: false, resolved: rawPath, reason: 'invalid_path' }
  }
  const root = resolve(workspaceRoot)
  const resolved = isAbsolute(rawPath)
    ? normalize(rawPath)
    : resolve(root, rawPath)
  const rel = relative(root, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, resolved, reason: 'outside_workspace' }
  }
  return { ok: true, resolved }
}

/**
 * Async symlink-aware path check. After the static check passes, resolve the
 * real filesystem path (following symlinks) and verify it still lives inside
 * the workspace. This prevents attacks like:
 *   workspace/link -> /etc/passwd
 *   workspace/dir-junction -> C:\outside  (Windows junction)
 *
 * A missing target is OK (it may be about to be created), but we walk up to
 * the NEAREST EXISTING ancestor and verify that ancestor's real path stays
 * inside the workspace — never assume safety because the direct parent is
 * missing.
 *
 * TOCTOU note: the filesystem can change between check and open. Tools must
 * re-run this check immediately before performing I/O; this narrows the race
 * window but does not eliminate it. A true elimination requires O_NOFOLLOW /
 * fd-relative operations, which are platform-specific and out of scope for
 * the documented threat model (single-user, locally trusted workspace).
 */
export async function checkPathReal(
  rawPath: string,
  workspaceRoot: string,
  options?: { read?: boolean },
): Promise<PathCheck> {
  // first pass the static check (write policy by default, read policy on demand)
  const staticCheck = options?.read
    ? checkReadPath(rawPath, workspaceRoot)
    : checkPath(rawPath, workspaceRoot)
  if (!staticCheck.ok) return staticCheck

  const root = resolve(workspaceRoot)

  // resolve the real path of the workspace root itself (it may be a symlink)
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    // workspace root doesn't exist yet — static check is sufficient
    return staticCheck
  }

  // walk up from the target to the nearest existing ancestor, remembering
  // how many segments were skipped (each skipped segment will be created
  // under the verified ancestor).
  let probe = staticCheck.resolved
  let realAncestor: string | null = null
  while (probe.length > 0) {
    try {
      realAncestor = await realpath(probe)
      break
    } catch {
      const parent = probe.slice(0, probe.lastIndexOf(sep))
      if (parent.length === 0 || parent === probe) break
      probe = parent
    }
  }

  if (realAncestor === null) {
    // nothing exists on the path yet — verify the root containment lexically
    const rel = relative(realRoot, staticCheck.resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, resolved: staticCheck.resolved, reason: 'symlink_escape' }
    }
    return staticCheck
  }

  const relReal = relative(realRoot, realAncestor)
  if (relReal.startsWith('..') || isAbsolute(relReal)) {
    return { ok: false, resolved: staticCheck.resolved, reason: 'symlink_escape' }
  }

  return staticCheck
}
