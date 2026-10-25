import { describe, expect, it } from 'vitest'
import { PROMOTION_GATE_HOLD_REASONS, PROMOTION_PATHS } from '../knowledge/promotion-gate'

/**
 * `promotionHoldReason` is persisted in knowledge-local commit outcomes and printed by the CLI,
 * and `promotionPath` is persisted in `evidence/gates.jsonl` promotion lines. These cells spell
 * both vocabularies out, so a member widened in through a cast fails here by name. The import is
 * relative to `src` so the cell reads the source, not a built barrel.
 */
describe('the promotion vocabularies', () => {
  it('declares the promotion-gate hold reasons in declaration order', () => {
    expect([...PROMOTION_GATE_HOLD_REASONS]).toEqual([
      'kind-excluded',
      'not-candidate',
      'window-closed',
      'withheld',
      'needs-enrichment',
      'evidence-incomplete',
      'no-confirmed-evidence',
      'no-element-observation',
      'missing-root-cause',
      'memory-off-anchor',
      'user-deprecated',
    ])
  })
  it('declares the promotion paths in declaration order', () => {
    expect([...PROMOTION_PATHS]).toEqual(['deterministic-verdict-floor', 'user-sovereign'])
  })
})
