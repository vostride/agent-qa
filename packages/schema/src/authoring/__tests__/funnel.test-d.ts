// Exact key equality: a fifth stage would invalidate every recorded comparison.

import { expectTypeOf, test } from 'vitest'

import { AUTHORING_FUNNEL_STAGES } from '../funnel'
import type { AuthoringFunnel, AuthoringFunnelStage, FunnelSideCounters } from '../funnel'

test('the authoring funnel has exactly four stages', () => {
  expectTypeOf<AuthoringFunnelStage>().toEqualTypeOf<
    'built' | 'passedStably' | 'addedValue' | 'writeEligible'
  >()

  // The value side of the same claim: a fifth member cannot be appended without editing this line.
  expectTypeOf<typeof AUTHORING_FUNNEL_STAGES>().toEqualTypeOf<
    readonly ['built', 'passedStably', 'addedValue', 'writeEligible']
  >()
})

test('the stage record is keyed by the stage vocabulary', () => {
  // Not merely "has these four": the record is keyed BY the vocabulary, so the two cannot drift.
  expectTypeOf<keyof AuthoringFunnel['stages']>().toEqualTypeOf<AuthoringFunnelStage>()
})

test('the side counter is not a stage and there is exactly one', () => {
  expectTypeOf<keyof FunnelSideCounters>().toEqualTypeOf<'dedupRefusals'>()
  expectTypeOf<AuthoringFunnelStage>().not.toMatchTypeOf<keyof FunnelSideCounters>()
})

test('the keep rate is optional so an empty funnel reports none', () => {
  // `0/0` rendered as `0%` would report a loop that filtered perfectly when in fact nothing
  // happened, so the absent case has to be representable rather than defaulted.
  expectTypeOf<AuthoringFunnel['keepRate']>().toEqualTypeOf<number | undefined>()
})
