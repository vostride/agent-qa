import { expectTypeOf } from 'vitest'
// prettier-ignore
import { GATE_VERDICTS, GATE_NUMBERS, BENEFITS, MARKS } from '../knowledge/gate-receipt'
// prettier-ignore
import type { GateVerdict, GateNumber, Benefit, Mark } from '../knowledge/gate-receipt'

/** Each closed vocabulary's union names no member its runtime list leaves out. */

expectTypeOf<
  Exclude<GateVerdict, (typeof GATE_VERDICTS)[number]>
>().toEqualTypeOf<never>()

expectTypeOf<Exclude<GateNumber, (typeof GATE_NUMBERS)[number]>>().toEqualTypeOf<never>()
expectTypeOf<Exclude<Benefit, (typeof BENEFITS)[number]>>().toEqualTypeOf<never>()
expectTypeOf<Exclude<Mark, (typeof MARKS)[number]>>().toEqualTypeOf<never>()
expectTypeOf<Extract<GateNumber, 1>>().toEqualTypeOf<never>()
expectTypeOf<Extract<Mark, 'confirmed-defect'>>().toEqualTypeOf<never>()
