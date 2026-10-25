export type PromotionPath = 'deterministic-verdict-floor' | 'user-sovereign'
// prettier-ignore
export const PROMOTION_PATHS = ['deterministic-verdict-floor', 'user-sovereign'] as const satisfies readonly PromotionPath[]
export const PROMOTION_PATH_STRENGTH: Record<PromotionPath, number> = {
  'deterministic-verdict-floor': 0,
  'user-sovereign': 1,
}
export function strongerPromotionPath(a: PromotionPath, b: PromotionPath): PromotionPath {
  return PROMOTION_PATH_STRENGTH[a] >= PROMOTION_PATH_STRENGTH[b] ? a : b
}
