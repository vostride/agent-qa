import type { PromotionGateHoldReason, PromotionPath } from '@vostride/agent-qa-schema'

// A reason added to the schema fails to compile here until it has words.
export const PROMOTION_REASON_WORDS: Record<PromotionPath | PromotionGateHoldReason, string> = {
  'deterministic-verdict-floor': 'verdict floor',
  'user-sovereign': 'your decision',
  'kind-excluded': 'kind not promoted',
  'not-candidate': 'not a candidate',
  'window-closed': 'window closed',
  withheld: 'withheld',
  'needs-enrichment': 'needs enrichment',
  'evidence-incomplete': 'evidence incomplete',
  'no-confirmed-evidence': 'no confirmed evidence',
  'no-element-observation': 'no element observation',
  'missing-root-cause': 'missing root cause',
  'memory-off-anchor': 'memory off for this anchor',
  'user-deprecated': 'deprecated by you',
}

export function renderPromotionLine(entry: {
  candidateId: string
  promotionPath?: PromotionPath
  promotionHoldReason?: PromotionGateHoldReason
}): string {
  return entry.promotionPath === undefined
    ? `curation: ${entry.candidateId} held: ${entry.promotionHoldReason}`
    : `curation: ${entry.candidateId} promoted via ${entry.promotionPath}`
}
