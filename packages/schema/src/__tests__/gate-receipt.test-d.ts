import { expectTypeOf } from 'vitest'
// prettier-ignore
import { GATE_VERDICTS, GATE_NUMBERS, CROSS_CHECKS, DEGRADATIONS, BENEFITS, MARKS } from '../knowledge/gate-receipt'
// prettier-ignore
import type { GateVerdict, GateNumber, CrossCheck, Degradation, Benefit, Mark } from '../knowledge/gate-receipt'

/** Each closed vocabulary's union names no member its runtime list leaves out. */

expectTypeOf<
  Exclude<GateVerdict, (typeof GATE_VERDICTS)[number]>
>().toEqualTypeOf<never>()

expectTypeOf<Exclude<GateNumber, (typeof GATE_NUMBERS)[number]>>().toEqualTypeOf<never>()
expectTypeOf<Exclude<CrossCheck, (typeof CROSS_CHECKS)[number]>>().toEqualTypeOf<never>()
expectTypeOf<Exclude<Degradation, (typeof DEGRADATIONS)[number]>>().toEqualTypeOf<never>()
expectTypeOf<Exclude<Benefit, (typeof BENEFITS)[number]>>().toEqualTypeOf<never>()
expectTypeOf<Exclude<Mark, (typeof MARKS)[number]>>().toEqualTypeOf<never>()
expectTypeOf<Extract<CrossCheck, 'not_run'>>().toEqualTypeOf<never>()
expectTypeOf<Extract<Mark, 'confirmed-defect'>>().toEqualTypeOf<never>()

import type { z } from 'zod'
// prettier-ignore
import { GATE1_REASONS, GATE1_TARGET_SOURCES, GATE1_K_SOURCES, GATE1_HARM_ORIGINS, gate1SpendSchema } from '../knowledge/gate-receipt'
// prettier-ignore
import type { Gate1Reason, Gate1TargetSource, Gate1KSource, Gate1HarmOrigin } from '../knowledge/gate-receipt'

// prettier-ignore
expectTypeOf<Exclude<Gate1Reason, (typeof GATE1_REASONS)[number]>>().toEqualTypeOf<never>()
// prettier-ignore
expectTypeOf<Extract<Gate1Reason, 'same_family_refused'>>().toEqualTypeOf<never>()
// prettier-ignore
expectTypeOf<Exclude<Gate1TargetSource, (typeof GATE1_TARGET_SOURCES)[number]>>().toEqualTypeOf<never>()
// prettier-ignore
expectTypeOf<Extract<Gate1TargetSource, 'staged'>>().toEqualTypeOf<never>()
// prettier-ignore
expectTypeOf<Exclude<Gate1KSource, (typeof GATE1_K_SOURCES)[number]>>().toEqualTypeOf<never>()
// prettier-ignore
expectTypeOf<Extract<Gate1KSource, 'floor'>>().toEqualTypeOf<never>()
// prettier-ignore
expectTypeOf<Exclude<Gate1HarmOrigin, (typeof GATE1_HARM_ORIGINS)[number]>>().toEqualTypeOf<never>()
// prettier-ignore
expectTypeOf<Extract<Gate1HarmOrigin, 'held-out'>>().toEqualTypeOf<never>()
// prettier-ignore
expectTypeOf<keyof z.infer<typeof gate1SpendSchema>>().toEqualTypeOf<'screens' | 'modelCalls' | 'promptTokens' | 'completionTokens' | 'wallClockMs'>()
