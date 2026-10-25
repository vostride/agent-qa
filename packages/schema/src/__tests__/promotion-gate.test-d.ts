import { expectTypeOf } from 'vitest'
import { PROMOTION_GATE_HOLD_REASONS, PROMOTION_PATHS } from '../knowledge/promotion-gate'
import type { PromotionGateHoldReason, PromotionPath } from '../knowledge/promotion-gate'

/**
 * The `satisfies` clauses on `PROMOTION_GATE_HOLD_REASONS` and `PROMOTION_PATHS` reject an entry
 * that names no member; these bars reject a member the runtime list does not name.
 */
expectTypeOf<
  Exclude<PromotionGateHoldReason, (typeof PROMOTION_GATE_HOLD_REASONS)[number]>
>().toEqualTypeOf<never>()
expectTypeOf<Exclude<PromotionPath, (typeof PROMOTION_PATHS)[number]>>().toEqualTypeOf<never>()
