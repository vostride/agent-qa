import type { PromotionGateHoldReason, PromotionPath } from '@vostride/agent-qa-schema'

export function renderPromotionLine(entry: {
  candidateId: string
  promotionPath?: PromotionPath
  promotionHoldReason?: PromotionGateHoldReason
}): string {
  return entry.promotionPath === undefined
    ? `curation: ${entry.candidateId} held: ${entry.promotionHoldReason}`
    : `curation: ${entry.candidateId} promoted via ${entry.promotionPath}`
}
