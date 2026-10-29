import type { EvidenceToken } from '../ids/record-id'
import type { PromotionGateInput } from './promotion-gate'

export const COLD_START_MAX_RECORDS = 2

export const COLD_START_MAX_BUDGET_FRACTION = 0.2

// An internal constitution value, never a config key.
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

// Hard exclusions run first, so no trust discount can make an excluded record eligible.
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

// Always on, so warm stores keep canary outcomes reachable; the smaller of the two caps applies.
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
