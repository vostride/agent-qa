// Exact key equality: a fifth stage would invalidate every recorded comparison.

import { expectTypeOf } from 'vitest'

import { AUTHORING_FUNNEL_STAGES } from '../funnel'
import type { AuthoringFunnel, AuthoringFunnelStage, FunnelSideCounters } from '../funnel'

// ---- 1. Exactly four stages, and exactly these four -------------------------------------------
expectTypeOf<AuthoringFunnelStage>().toEqualTypeOf<
  'built' | 'passedStably' | 'addedValue' | 'writeEligible'
>()

// The value side of the same claim: a fifth member cannot be appended without editing this line.
expectTypeOf<typeof AUTHORING_FUNNEL_STAGES>().toEqualTypeOf<
  readonly ['built', 'passedStably', 'addedValue', 'writeEligible']
>()

// ---- 2. The stage record's keys ARE the vocabulary --------------------------------------------
//
// Not merely "has these four": the record is keyed BY the vocabulary, so the two cannot drift.
expectTypeOf<keyof AuthoringFunnel['stages']>().toEqualTypeOf<AuthoringFunnelStage>()

// ---- 3. The side counter is not a stage, and the equality refuses a second counter -----------
expectTypeOf<keyof FunnelSideCounters>().toEqualTypeOf<'dedupRefusals'>()
expectTypeOf<AuthoringFunnelStage>().not.toMatchTypeOf<keyof FunnelSideCounters>()

// ---- 4. The keep rate is OPTIONAL — absence is a value the type can express --------------------
//
// `0/0` rendered as `0%` would report a loop that filtered perfectly when in fact nothing
// happened, so the absent case has to be representable rather than defaulted.
expectTypeOf<AuthoringFunnel['keepRate']>().toEqualTypeOf<number | undefined>()
