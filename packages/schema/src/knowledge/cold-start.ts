import type { EvidenceToken } from '../ids/record-id'
import type { PromotionGateInput } from './promotion-gate'

/** LOCKED D-19 maximum for the always-on organic canary reservation. */
export const COLD_START_MAX_RECORDS = 2

/** LOCKED D-19 maximum share of the caller-supplied brief budget. */
export const COLD_START_MAX_BUDGET_FRACTION = 0.2

/**
 * PROVISIONAL D-20 candidate trust discount. M3 owns calibration from attributed outcomes;
 * this remains an internal constitution value, never a config key.
 */
export const COLD_START_TRUST_DISCOUNT = 0.5

export interface VettedCandidateInput extends Pick<
  PromotionGateInput,
  | 'kind'
  | 'status'
  | 'validityOpen'
  | 'anchors'
  | 'originClass'
  | 'withheld'
  | 'needsEnrichment'
  | 'evidenceIncomplete'
  | 'hasUserDeprecateInLineage'
  | 'memoryOffForAnchorGroup'
> {
  /** Branded tokens projected from confirmed canonical outcome events. */
  confirmedOutcomeEvidenceTokens: readonly EvidenceToken[]
}

/**
 * Implements the researcher-pinned V1-V9 positive predicate. D-21's LOCKED hard exclusions are
 * evaluated first: candidacy/open validity, withheld provenance, a memory-off anchor group, and
 * user-deprecated lineage can never become eligible through a trust discount. The remaining
 * positive checks are provisional until M3 calibrates real attributed outcomes.
 */
export function isVettedCandidate(input: VettedCandidateInput): boolean {
  const candidacyPasses = input.status === 'candidate' && input.validityOpen
  if (
    !candidacyPasses
    || input.withheld
    || input.memoryOffForAnchorGroup
    || input.hasUserDeprecateInLineage
  ) {
    return false
  }

  return (
    (input.originClass === 'agent-verified' || input.originClass === 'user')
    && !input.evidenceIncomplete
    && input.confirmedOutcomeEvidenceTokens.some((token) => token.length > 0)
    && !input.needsEnrichment
    && (input.kind === 'fact' || input.kind === 'caution')
  )
}

export interface ColdStartBudgetEntry {
  readonly tokenEstimate: number
}

/**
 * D-19's ALWAYS-ON organic canary channel, not a bootstrapping state machine. Warm stores keep
 * this reservation available so attributed candidate outcomes remain reachable. Selection is
 * pure, deterministic, and order-preserving; callers provide discounted-trust order and the real
 * brief budget, then the LOCKED two-record and twenty-percent walls apply, whichever is smaller.
 */
export function applyColdStartSubCap<T extends ColdStartBudgetEntry>(
  vetted: readonly T[],
  budgetShareTokens: number,
): T[] {
  const tokenCap = Math.max(0, budgetShareTokens) * COLD_START_MAX_BUDGET_FRACTION
  const selected: T[] = []
  let usedTokens = 0

  for (const entry of vetted) {
    if (selected.length >= COLD_START_MAX_RECORDS) break
    if (!Number.isFinite(entry.tokenEstimate) || entry.tokenEstimate < 0) break
    if (usedTokens + entry.tokenEstimate > tokenCap) break

    selected.push(entry)
    usedTokens += entry.tokenEstimate
  }

  return selected
}
