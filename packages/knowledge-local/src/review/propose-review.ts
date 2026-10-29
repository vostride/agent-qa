// Reads only: nothing here can change a byte of the knowledge store; `apply-review.ts` writes.

import { asRecordId, canonicalJson, KnowledgeMarkInputSchema } from '@vostride/agent-qa-schema'
import type {
  BundleProvenance,
  Delta,
  KnowledgeAcceptInput,
  KnowledgeForgetInput,
  KnowledgeMarkInput,
  KnowledgeProjection,
  KnowledgeRejectInput,
  KnowledgeTargetRef,
  ScopeKey,
} from '@vostride/agent-qa-schema'

import { deriveBundleTrust, loadBundle } from '../bundle-read.js'
import { enumerateBundleDirs } from '../bundle-scan.js'

/**
 * The §7.7 projections a forget in THIS store actually scrubs, enumerated honestly.
 *
 * `KNOWLEDGE_PROJECTIONS` declares four — `fts`, `vec`, `graph`, `exemplar` — and a receipt
 * claiming all four would be a receipt nobody can trust. `scrubDeadRecallRows` (index-rebuild.ts)
 * deletes the FTS row, deletes the record from every materialised vec table, and deletes the
 * record's graph edges plus the nodes those edges orphaned. It does NOT touch the exemplar
 * ranking, and it should not: an exemplar in this system is a TEST reference drawn from the
 * run-outcome projection (`serving/get-authoring-brief.ts`), not a knowledge record, so a
 * forgotten record has no exemplar row to scrub. Listing `exemplar` anyway would be the receipt
 * asserting work nobody did — which is worse than a receipt that says less, because a shorter
 * true list can be lengthened and a false one cannot be believed.
 *
 * When the exemplar ranking gains knowledge-record rows, this constant is the one place that
 * fact is recorded, and the receipt widens with it.
 */
export const FORGET_SCRUBBED_PROJECTIONS: readonly KnowledgeProjection[] = ['fts', 'vec', 'graph']

/** Resolves a `MEM-` short-ID to the machine id it addresses, or `undefined`. */
export type ResolveBundleShortId = (shortId: string) => string | undefined

/** A validated mark, accept, reject or forget, in the shape the review verbs take. */
export interface ReviewChangeRequest {
  readonly verb: 'accept' | 'reject' | 'forget' | 'mark'
  readonly input: KnowledgeAcceptInput | KnowledgeRejectInput | KnowledgeForgetInput | KnowledgeMarkInput
}

export class MarkPlanIntegrityError extends Error {
  constructor(readonly recordId: string) {
    super('mark plan does not match its user-authored target and stamp')
    this.name = 'MarkPlanIntegrityError'
  }
}

export interface ResolvedReviewTarget {
  readonly recordId: string
  readonly product: string
  readonly scope: ScopeKey
  readonly provenance: BundleProvenance
  readonly status: string
  readonly summary: string
}

/**
 * Find the canonical record a target ref names.
 *
 * The two grains differ by ADDRESSING, not by cardinality: a `MEM-` short-ID goes through the
 * addressing ledger to a machine id, and a record id is that machine id already. In this store a
 * bundle directory's name IS its one canonical record id (`records` is keyed one row per
 * `bundle_id`), so "forgetting a bundle lists every member record" is total by construction here
 * rather than by an enumeration that could miss one — and the moment a bundle carries more than
 * one record, this function is where that enumeration lands.
 */
export function resolveReviewTarget(
  knowledgeRoot: string,
  target: KnowledgeTargetRef,
  resolveBundleShortId?: ResolveBundleShortId,
): ResolvedReviewTarget | undefined {
  const machineId = target.grain === 'record'
    ? target.recordId
    : resolveBundleShortId?.(target.shortId)
  if (machineId === undefined) return undefined

  for (const entry of enumerateBundleDirs(knowledgeRoot)) {
    const outcome = loadBundle(entry.dir)
    if (outcome.kind !== 'loaded') continue
    // EXACT equality: this is addressing, never search.
    if (outcome.bundle.manifest.id !== machineId) continue
    return {
      recordId: outcome.bundle.manifest.id,
      product: entry.product,
      scope: outcome.bundle.frontmatter.scope,
      provenance: outcome.bundle.provenance,
      status: deriveBundleTrust(outcome.bundle).status,
      summary: outcome.bundle.summary,
    }
  }
  return undefined
}

// `origin: 'user'` matters: agent origin is downgraded so an agent cannot make a person's call.
export function reviewDeltasFor(
  request: ReviewChangeRequest,
  resolved: ResolvedReviewTarget,
  changeId: string,
): Delta[] {
  const envelope = {
    origin: 'user' as const,
    scope: resolved.scope,
    citedIds: [asRecordId(resolved.recordId)],
  }
  switch (request.verb) {
    case 'mark': {
      const parsed = KnowledgeMarkInputSchema.safeParse(request.input)
      if (!parsed.success) throw new MarkPlanIntegrityError(resolved.recordId)
      const { plan, mark } = parsed.data
      if (plan.markId !== mark.markId || plan.fix !== mark.fix
        || plan.feedbackSource.runId !== mark.runId || plan.runTraceRef.runId !== mark.runId
        || plan.feedbackSource.testIndex !== mark.testIndex
        || plan.feedbackSource.stepIndex !== mark.stepIndex || plan.feedbackSource.kind !== mark.kind
        || canonicalJson(plan.target) !== canonicalJson(parsed.data.target)
        || plan.deltas.some((delta) => delta.origin !== 'user'
          || canonicalJson(delta.scope) !== canonicalJson(resolved.scope)
          || !delta.citedIds.includes(asRecordId(resolved.recordId)))) {
        throw new MarkPlanIntegrityError(resolved.recordId)
      }
      return plan.deltas
    }
    case 'accept':
      return [{
        ...envelope,
        kind: 'Confirm',
        targetId: asRecordId(resolved.recordId),
        // The evidence for a human accept IS the change identity: deriving the token from it
        // makes the confirmation replay-safe (a second apply of the same change is the same
        // token, which the append dedups).
        evidenceToken: `review-accept:${changeId}`,
      } as Delta]
    case 'reject':
      return [{
        ...envelope,
        kind: 'Deprecate',
        targetId: asRecordId(resolved.recordId),
        reason: (request.input as KnowledgeRejectInput).reason,
      } as Delta]
    case 'forget':
      return [{
        ...envelope,
        kind: 'Deprecate',
        targetId: asRecordId(resolved.recordId),
        reason: `forget:${changeId}`,
      } as Delta]
  }
}
