import { expectTypeOf } from 'vitest'
import type { BriefSource, TurnMatch } from '../brief-tiers'
import { BRIEF_SOURCES, TURN_MATCHES } from '../brief-tiers'
import type { ReplayRefusal } from '../result'
import { REPLAY_REFUSAL_REASONS } from '../result'

expectTypeOf<
  Exclude<ReplayRefusal['reason'], (typeof REPLAY_REFUSAL_REASONS)[number]>
>().toEqualTypeOf<never>()
expectTypeOf<Extract<ReplayRefusal['reason'], 'unsupported-brief'>>().toEqualTypeOf<'unsupported-brief'>()
expectTypeOf<Extract<ReplayRefusal['reason'], 'brief-too-large'>>().toEqualTypeOf<never>()
expectTypeOf<Exclude<BriefSource, (typeof BRIEF_SOURCES)[number]>>().toEqualTypeOf<never>()
expectTypeOf<Exclude<TurnMatch, (typeof TURN_MATCHES)[number]>>().toEqualTypeOf<never>()
