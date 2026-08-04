import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ApprovalToken, PlanVersion } from './types.js'
import type { Clock, IdGenerator } from '../core/runtimePrimitives.js'
import { InvariantError } from '../core/messages.js'

/**
 * Versioned plan store. Plan versions are immutable once created; a new
 * revision supersedes the old one. ExitPlanMode only accepts references to
 * persisted versions — never inline plan text.
 */
export class PlanStore {
  private readonly plans = new Map<string, PlanVersion[]>()
  private lastApprovedRef?: PlanVersion

  constructor(
    private readonly deps: {
      artifactDir: string
      clock: Clock
      ids: IdGenerator
      persist?: boolean
    },
  ) {}

  async createVersion(input: {
    planId?: string
    goal: string
    nonGoals?: string[]
    assumptions?: string[]
    decisions?: Array<{ decision: string; rationale: string }>
    steps?: PlanVersion['steps']
    acceptanceCriteria?: PlanVersion['acceptanceCriteria']
    risks?: string[]
  }): Promise<PlanVersion> {
    const planId = input.planId ?? this.deps.ids.next('plan')
    const existing = this.plans.get(planId) ?? []

    // supersede previous draft/awaiting versions
    for (const version of existing) {
      if (version.status === 'draft' || version.status === 'awaiting_approval') {
        version.status = 'superseded'
      }
    }

    const plan: PlanVersion = {
      planId,
      version: existing.length + 1,
      status: 'draft',
      goal: input.goal,
      nonGoals: input.nonGoals ?? [],
      assumptions: input.assumptions ?? [],
      decisions: input.decisions ?? [],
      steps: input.steps ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      risks: input.risks ?? [],
      createdAt: this.deps.clock.isoNow(),
    }
    existing.push(plan)
    this.plans.set(planId, existing)

    if (this.deps.persist !== false) {
      const dir = join(this.deps.artifactDir, 'plans')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, `${planId}-v${plan.version}.json`),
        JSON.stringify(plan, null, 2),
        'utf8',
      )
    }
    return plan
  }

  get(planId: string, version: number): PlanVersion | undefined {
    return this.plans.get(planId)?.find(p => p.version === version)
  }

  latest(planId: string): PlanVersion | undefined {
    const versions = this.plans.get(planId)
    return versions?.[versions.length - 1]
  }

  /** The most recently approved plan version, if any. */
  lastApproved(): PlanVersion | undefined {
    return this.lastApprovedRef
  }

  markAwaitingApproval(planId: string, version: number): PlanVersion {
    const plan = this.mustGet(planId, version)
    if (plan.status !== 'draft') {
      throw new InvariantError(
        'plan_version_immutable',
        `plan ${planId}@${version} is ${plan.status}, cannot await approval`,
      )
    }
    plan.status = 'awaiting_approval'
    return plan
  }

  markApproved(planId: string, version: number, tokenId: string): PlanVersion {
    const plan = this.mustGet(planId, version)
    if (plan.status !== 'awaiting_approval') {
      throw new InvariantError(
        'plan_version_immutable',
        `plan ${planId}@${version} is ${plan.status}, cannot approve`,
      )
    }
    plan.status = 'approved'
    plan.approvedAt = this.deps.clock.isoNow()
    plan.approvalTokenId = tokenId
    this.lastApprovedRef = plan
    return plan
  }

  /**
   * Supersede any version — including approved ones. Reapproval replans
   * invalidate the previously approved version; the runtime write gate
   * derives from `lastApproved()`, so clearing it here is the source of
   * truth for "no approved plan".
   */
  async markSuperseded(planId: string, version: number): Promise<PlanVersion> {
    const plan = this.mustGet(planId, version)
    if (plan.status !== 'superseded') {
      plan.status = 'superseded'
      if (this.lastApprovedRef === plan) {
        this.lastApprovedRef = undefined
      }
      if (this.deps.persist !== false) {
        // rewrite the persisted artifact so restarts see the final status
        const dir = join(this.deps.artifactDir, 'plans')
        await mkdir(dir, { recursive: true })
        await writeFile(
          join(dir, `${planId}-v${plan.version}.json`),
          JSON.stringify(plan, null, 2),
          'utf8',
        )
      }
    }
    return plan
  }

  private mustGet(planId: string, version: number): PlanVersion {
    const plan = this.get(planId, version)
    if (!plan) {
      throw new InvariantError('plan_not_found', `no plan ${planId}@${version}`)
    }
    return plan
  }

  /**
   * Restore a plan version from journal replay (recovery path).
   * Does not persist — the plan was already persisted in the original run.
   */
  restore(plan: PlanVersion): void {
    const existing = this.plans.get(plan.planId) ?? []
    if (!existing.some(p => p.version === plan.version)) {
      existing.push(plan)
      this.plans.set(plan.planId, existing)
    }
    if (plan.status === 'approved') {
      this.lastApprovedRef = plan
    }
  }
}

/**
 * One-shot approval tokens bound to (session, plan, version).
 * Prevents "UI showed v2, model switched to v3 at approval time".
 */
export class ApprovalRegistry {
  private readonly tokens = new Map<string, ApprovalToken>()

  constructor(private readonly deps: { clock: Clock; ttlMs?: number }) {}

  issue(input: {
    sessionId: string
    planId: string
    planVersion: number
  }): ApprovalToken {
    const now = this.deps.clock.now()
    const token: ApprovalToken = {
      token: randomBytes(16).toString('hex'),
      sessionId: input.sessionId,
      planId: input.planId,
      planVersion: input.planVersion,
      action: 'exit_plan_mode',
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (this.deps.ttlMs ?? 10 * 60_000)).toISOString(),
    }
    this.tokens.set(token.token, token)
    return token
  }

  /** Validates and consumes a token exactly once. */
  consume(input: {
    token: string
    sessionId: string
    planId: string
    planVersion: number
  }): { ok: true; token: ApprovalToken } | { ok: false; reason: string } {
    const token = this.tokens.get(input.token)
    if (!token) return { ok: false, reason: 'unknown token' }
    if (token.consumedAt) return { ok: false, reason: 'token already consumed' }
    if (new Date(token.expiresAt).getTime() < this.deps.clock.now()) {
      return { ok: false, reason: 'token expired' }
    }
    if (
      token.sessionId !== input.sessionId ||
      token.planId !== input.planId ||
      token.planVersion !== input.planVersion
    ) {
      return {
        ok: false,
        reason:
          `token bound to ${token.planId}@${token.planVersion}, ` +
          `not ${input.planId}@${input.planVersion}`,
      }
    }
    token.consumedAt = this.deps.clock.isoNow()
    return { ok: true, token }
  }
}
