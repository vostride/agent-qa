// Plan 12 mutation anchors (file:line:column at each assertion's toEqualTypeOf):
// packages/eval/src/replay/__tests__/result.test-d.ts:15:5 — refusal coverage
// packages/eval/src/replay/__tests__/result.test-d.ts:16:71 — historical refusal retained
// packages/eval/src/replay/__tests__/result.test-d.ts:17:69 — unshipped refusal excluded
// packages/eval/src/replay/__tests__/result.test-d.ts:18:70 — brief-source coverage
// packages/eval/src/replay/__tests__/result.test-d.ts:19:67 — turn-match coverage
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
