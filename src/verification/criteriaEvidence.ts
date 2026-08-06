import { resolve } from 'node:path'
import type { AcceptanceCriterion } from '../planning/types.js'
import { verifySha256 } from './EvidenceStore.js'
import type { EvidenceReceipt } from './types.js'

export interface EvidenceUsabilityOptions {
  staleEvidenceIds?: ReadonlySet<string>
  expectedWorkspaceRoot?: string
}

function sameWorkspace(actual: string, expected: string): boolean {
  const left = resolve(actual)
  const right = resolve(expected)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/** Runtime-issued evidence is usable only while its integrity and bindings hold. */
export function receiptIsUsable(
  receipt: EvidenceReceipt,
  options: EvidenceUsabilityOptions = {},
): boolean {
  if (receipt.status !== 'passed' || !verifySha256(receipt)) return false
  if (options.staleEvidenceIds?.has(receipt.id)) return false
  if (
    options.expectedWorkspaceRoot &&
    (!receipt.workspaceRoot ||
      !sameWorkspace(receipt.workspaceRoot, options.expectedWorkspaceRoot))
  ) {
    return false
  }
  return true
}

/** A receipt must measure the criterion and use the requested evidence kind. */
export function receiptSupportsCriterion(
  receipt: EvidenceReceipt,
  criterion: AcceptanceCriterion,
  options: EvidenceUsabilityOptions = {},
): boolean {
  return (
    receiptIsUsable(receipt, options) &&
    receipt.criterionIds.includes(criterion.id) &&
    receipt.kind === criterion.evidenceKind
  )
}

/** Shared rule used by task completion, the completion gate and verifier. */
export function requiredCriteriaWithoutUsableEvidence(
  criteria: AcceptanceCriterion[],
  evidence: EvidenceReceipt[],
  options: EvidenceUsabilityOptions = {},
): AcceptanceCriterion[] {
  return criteria
    .filter(criterion => criterion.required)
    .filter(
      criterion =>
        !evidence.some(receipt =>
          receiptSupportsCriterion(receipt, criterion, options),
        ),
    )
}
