// The frozen four-stage vocabulary, pinned at the TYPE.
//
// D-15 freezes the denominator: WTST-05's comparison against the reference distribution
// (75 / 57 / 25 / 73), the per-run digest block and every chat render consume this exact shape.
// A fifth stage would invalidate every recorded comparison, so it is refused by exact key-set
// equality rather than by a contains check — a contains check passes happily while the
// vocabulary grows beside the pinned names, which is the one drift direction this file exists
// to catch.
//
// THIS FILE IS THE ONLY TYPE AUTHORITY FOR THE CLAIM. `vitest`'s `typecheck.include` is
// `*.test-d.ts`, and a `.test.ts` is transpiled and never checked — so the runtime census in
// `funnel.test.ts` and this pin are two halves of one mechanism rather than a duplicate.

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

// ---- 3. The side counter is NOT a stage --------------------------------------------------------
//
// Stated as an exact key set, because that is what makes folding a refusal into a stage a
// compile error rather than something a reviewer has to notice. D-15's whole argument is that
// working-as-intended refusals inflating the filter rate would break comparison against the
// reference distribution. The equality is two-sided on purpose: it also refuses a SECOND key
// beside the funnel, which is how a retired counter comes back under a new name.
expectTypeOf<keyof FunnelSideCounters>().toEqualTypeOf<'dedupRefusals'>()
expectTypeOf<AuthoringFunnelStage>().not.toMatchTypeOf<keyof FunnelSideCounters>()

// ---- 4. The keep rate is OPTIONAL — absence is a value the type can express --------------------
//
// `0/0` rendered as `0%` would report a loop that filtered perfectly when in fact nothing
// happened, so the absent case has to be representable rather than defaulted.
expectTypeOf<AuthoringFunnel['keepRate']>().toEqualTypeOf<number | undefined>()
