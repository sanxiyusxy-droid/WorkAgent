import { z } from 'zod'
import type { EvidenceStore } from './EvidenceStore.js'
import type { VerificationReport } from './types.js'
import type { AcceptanceCriterion } from '../planning/types.js'

export const VerificationReportSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL', 'PARTIAL']),
  summary: z.string(),
  checks: z.array(
    z.object({
      name: z.string(),
      criterionIds: z.array(z.string()).default([]),
      evidenceIds: z.array(z.string()).default([]),
      result: z.enum(['PASS', 'FAIL', 'SKIP']),
      expected: z.string().default(''),
      actual: z.string().default(''),
    }),
  ),
  adversarialProbeEvidenceId: z.string().optional(),
  failures: z
    .array(
      z.object({
        title: z.string(),
        severity: z.enum(['low', 'medium', 'high']),
        reproduction: z.array(z.string()).default([]),
        evidenceIds: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  unverified: z
    .array(z.object({ item: z.string(), reason: z.string() }))
    .default([]),
})

export type ReportValidation =
  | { ok: true }
  | { ok: false; reason: string }

/** Trivial commands that do not constitute meaningful adversarial probes. */
const TRIVIAL_PROBE_PATTERNS = [
  /^\s*echo\s/i,
  /^\s*true\s*$/,
  /^\s*:\s*$/,
  /^\s*cat\s+\/dev\/null\s*$/,
  /^\s*ls\s*$/,
  /^\s*pwd\s*$/,
]

/**
 * Machine validation of verifier output (guide §9.5).
 * Upgraded from "evidence exists" to "evidence semantically supports conclusion":
 * - PASS checks must reference only evidence with status 'passed'
 * - Evidence with non-zero exit codes cannot support PASS
 * - Adversarial probe must be a meaningful command (not echo/true/ls)
 * - Required acceptance criteria must be covered by check criterionIds
 * - All referenced evidence ids must exist in the runtime-issued store
 */
export function validateReport(
  report: VerificationReport,
  store: EvidenceStore,
  requiredCriteria?: AcceptanceCriterion[],
  /** receipts whose bound fileVersions no longer match the workspace */
  staleEvidenceIds?: ReadonlySet<string>,
): ReportValidation {
  // 1. existence + freshness: all referenced evidence ids must exist and
  // must have been signed for the CURRENT workspace version
  const referenced = new Set<string>([
    ...report.checks.flatMap(c => c.evidenceIds),
    ...report.failures.flatMap(f => f.evidenceIds),
    ...(report.adversarialProbeEvidenceId ? [report.adversarialProbeEvidenceId] : []),
  ])

  for (const id of referenced) {
    if (!store.exists(id)) {
      return { ok: false, reason: `unknown evidence: ${id}` }
    }
    if (staleEvidenceIds?.has(id)) {
      return {
        ok: false,
        reason:
          `stale evidence: ${id} — the workspace files this receipt was ` +
          'bound to changed after it was signed; re-run the check',
      }
    }
  }

  // 2. semantic: PASS checks must only reference evidence with status 'passed'
  if (report.verdict === 'PASS') {
    for (const check of report.checks) {
      if (check.result !== 'PASS') continue
      for (const evId of check.evidenceIds) {
        const receipt = store.get(evId)
        if (!receipt) continue
        if (receipt.status !== 'passed') {
          return {
            ok: false,
            reason:
              `check "${check.name}" claims PASS but evidence ${evId} has status ` +
              `"${receipt.status}" — evidence must be 'passed' to support PASS`,
          }
        }
        // failed commands (non-zero exit) cannot support PASS
        if (receipt.observation.exitCode !== undefined && receipt.observation.exitCode !== 0) {
          return {
            ok: false,
            reason:
              `check "${check.name}" claims PASS but evidence ${evId} has ` +
              `exitCode=${receipt.observation.exitCode} — failed commands cannot support PASS`,
          }
        }
      }

      // 2b. criterion binding: every criterion a PASS check claims must be
      // backed by a passed receipt whose own criterionIds contain it —
      // a check cannot claim criteria its evidence never measured
      for (const criterionId of check.criterionIds) {
        const backed = check.evidenceIds.some(evId => {
          const receipt = store.get(evId)
          return (
            receipt !== undefined &&
            receipt.status === 'passed' &&
            receipt.criterionIds.includes(criterionId)
          )
        })
        if (!backed) {
          return {
            ok: false,
            reason:
              `check "${check.name}" claims criterion "${criterionId}" but none of its ` +
              `passed evidence receipts (${check.evidenceIds.join(', ') || 'none'}) ` +
              'was signed for that criterion',
          }
        }
      }
    }
  }

  // 3. adversarial probe quality
  if (report.verdict === 'PASS') {
    if (!report.adversarialProbeEvidenceId) {
      return { ok: false, reason: 'PASS requires an adversarial probe evidence id' }
    }
    const probeReceipt = store.get(report.adversarialProbeEvidenceId)
    if (probeReceipt) {
      const input = probeReceipt.invocation.normalizedInput as Record<string, unknown> | undefined
      const command = typeof input?.command === 'string' ? input.command : ''
      if (TRIVIAL_PROBE_PATTERNS.some(p => p.test(command))) {
        return {
          ok: false,
          reason:
            `adversarial probe "${command.trim()}" is trivial — ` +
            'probe must exercise a boundary, error path, or idempotency condition',
        }
      }
    }
    if (report.checks.some(c => c.result !== 'PASS')) {
      return { ok: false, reason: 'PASS contains failed or skipped checks' }
    }
    if (report.checks.length === 0) {
      return { ok: false, reason: 'PASS requires at least one check' }
    }
    if (report.checks.every(c => c.evidenceIds.length === 0)) {
      return { ok: false, reason: 'PASS checks must reference evidence' }
    }
  }

  // 4. criterion coverage: required criteria must appear in check criterionIds
  if (requiredCriteria && requiredCriteria.length > 0 && report.verdict === 'PASS') {
    const coveredIds = new Set(report.checks.flatMap(c => c.criterionIds))
    const uncovered = requiredCriteria
      .filter(c => c.required && c.evidenceKind !== 'manual')
      .filter(c => !coveredIds.has(c.id))
    if (uncovered.length > 0) {
      return {
        ok: false,
        reason:
          `required acceptance criteria not covered by any check: ` +
          uncovered.map(c => `${c.id} ("${c.statement}")`).join(', '),
      }
    }

    // 4b. evidence-kind quality: a criterion of kind 'test' must be backed
    // by evidence signed as a test run, not by a plain command, and so on
    for (const criterion of requiredCriteria) {
      if (!criterion.required || criterion.evidenceKind === 'manual') continue
      const backing = report.checks
        .filter(c => c.result === 'PASS' && c.criterionIds.includes(criterion.id))
        .flatMap(c => c.evidenceIds)
        .map(evId => store.get(evId))
        .filter((r): r is NonNullable<typeof r> => r !== undefined && r.status === 'passed')
      const kindMatched = backing.some(r => r.kind === criterion.evidenceKind)
      if (backing.length > 0 && !kindMatched) {
        return {
          ok: false,
          reason:
            `criterion "${criterion.id}" requires evidence of kind ` +
            `"${criterion.evidenceKind}" but the backing receipts are ` +
            `[${[...new Set(backing.map(r => r.kind))].join(', ')}]`,
        }
      }
    }
  }

  if (report.verdict === 'PARTIAL' && report.unverified.length === 0) {
    return { ok: false, reason: 'PARTIAL must list environmental limits in unverified' }
  }

  if (report.verdict === 'FAIL' && report.failures.length === 0) {
    return { ok: false, reason: 'FAIL must list at least one failure' }
  }

  return { ok: true }
}
