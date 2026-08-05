import type { EvidenceStore } from './EvidenceStore.js'
import { CODE_BINDING_KINDS } from './types.js'
import { readFileVersion } from '../workspace/FileVersion.js'

/**
 * Evidence freshness gate (finish-list §1.6). A receipt signed for a PREVIOUS
 * version of the code cannot support a verdict about the current one.
 * Two complementary strategies, per receipt:
 *
 * 1. Fine-grained: receipts bound to explicit fileVersions are judged by
 *    those files alone — touching an UNRELATED file does not age them.
 *    Missing files count as stale: the observation no longer reflects reality.
 * 2. Workspace revision: receipts of code-binding kinds WITHOUT fileVersions
 *    are judged by the workspace revision counter — ANY workspace change after
 *    signing ages them. Receipts with no binding at all are stale by
 *    definition: an unbound code test can never support a PASS.
 *
 * 'manual' receipts are exempt (human observations carry their own context).
 */
export async function findStaleReceipts(evidence: EvidenceStore): Promise<Set<string>> {
  const stale = new Set<string>()
  const currentRevision = evidence.workspaceRevision

  for (const receipt of evidence.list()) {
    const fileVersions = receipt.fileVersions ?? {}
    const hasFileBinding = Object.keys(fileVersions).length > 0

    if (hasFileBinding) {
      for (const [path, signedVersion] of Object.entries(fileVersions)) {
        try {
          const current = await readFileVersion(path)
          if (current.version !== signedVersion) {
            stale.add(receipt.id)
            break
          }
        } catch {
          stale.add(receipt.id)
          break
        }
      }
      continue
    }

    if (!CODE_BINDING_KINDS.has(receipt.kind)) continue

    // no fine-grained binding: fall back to the workspace revision strategy.
    // Unsigned (undefined) or signed before the current revision => stale.
    if (receipt.workspaceRevision === undefined || receipt.workspaceRevision < currentRevision) {
      stale.add(receipt.id)
    }
  }

  return stale
}
