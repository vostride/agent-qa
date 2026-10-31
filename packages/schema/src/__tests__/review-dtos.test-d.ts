// `satisfies` catches an entry naming no arm; only these checks catch an arm no entry names.
import { expectTypeOf, test } from 'vitest'

import { DELTA_KINDS } from '../delta/delta'
import type { Delta } from '../delta/delta'
import { DELTA_ORIGINS } from '../delta/envelope'
import type { DeltaEnvelope } from '../delta/envelope'
import type {
  ForgetReceiptV1,
  ForgetTargetRef,
  KnowledgeChangeOutput,
  KnowledgeReviewVerb,
  KnowledgeTargetRef,
} from '../knowledge/change'
import type { ImprovementPlanKnowledge } from '../functions/feedback'
import type { BriefWhyResult } from '../knowledge/review-verbs'
import { BRIEF_WHY_RESULT_KINDS } from '../knowledge/review-verbs'
import type { ServedRetrievalTraceV1 } from '../brief/retrieval-trace'

test('the delta kinds and origins match their runtime lists in both directions', () => {
  // 1. Both directions of the §7.3 projections.
  expectTypeOf<Exclude<Delta['kind'], (typeof DELTA_KINDS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof DELTA_KINDS)[number], Delta['kind']>>().toEqualTypeOf<never>()
  expectTypeOf<
    Exclude<DeltaEnvelope['origin'], (typeof DELTA_ORIGINS)[number]>
  >().toEqualTypeOf<never>()
  expectTypeOf<
    Exclude<(typeof DELTA_ORIGINS)[number], DeltaEnvelope['origin']>
  >().toEqualTypeOf<never>()
})

test('the brief why result has exactly two arms and only the answered arm carries a trace', () => {
  // 2. The why-result union has exactly the two arms the constant names — in both directions,
  // so adding a `re-run` arm to the union without touching the constant is a compile error.
  expectTypeOf<Exclude<BriefWhyResult['kind'], (typeof BRIEF_WHY_RESULT_KINDS)[number]>>()
    .toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof BRIEF_WHY_RESULT_KINDS)[number], BriefWhyResult['kind']>>()
    .toEqualTypeOf<never>()

  // The trace lives only on the answered arm, or a re-run result would need no new arm.
  expectTypeOf<Extract<BriefWhyResult, { kind: 'answered' }>['trace']>()
    .toEqualTypeOf<ServedRetrievalTraceV1>()
  expectTypeOf<
    Extract<keyof Extract<BriefWhyResult, { kind: 'no-trace' }>, 'trace'>
  >().toEqualTypeOf<never>()
})

test('knowledge changes and forget receipts keep their schema types', () => {
  // 3. A change's deltas keep their §7.3 static type through the boundary.
  expectTypeOf<ImprovementPlanKnowledge['deltas']>().toEqualTypeOf<Delta[]>()

  // The forget target is the SAME type as a change's target, not a parallel one.
  expectTypeOf<ForgetTargetRef>().toEqualTypeOf<KnowledgeTargetRef>()
  expectTypeOf<Extract<KnowledgeChangeOutput, { outcome: 'target-not-found' }>['target']>()
    .toEqualTypeOf<KnowledgeTargetRef>()

  expectTypeOf<ForgetReceiptV1['resultingBundleStatus']>()
    .toEqualTypeOf<'active' | 'tombstoned' | 'forgotten'>()
})

test('knowledge targets and review verbs are closed', () => {
  const target: KnowledgeTargetRef = { grain: 'bundle', shortId: 'MEM-001' }

  // @ts-expect-error the target grain is closed; a product-wide forget is not expressible.
  const wideTarget: KnowledgeTargetRef = { grain: 'product', product: 'shop' }

  // @ts-expect-error the review verb vocabulary is closed at accept/reject/forget/mark.
  const purge: KnowledgeReviewVerb = 'purge'

  void target
  void wideTarget
  void purge
})
