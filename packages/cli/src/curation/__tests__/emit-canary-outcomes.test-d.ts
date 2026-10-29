import { expectTypeOf, it } from 'vitest'
import type { Verdict } from '@vostride/agent-qa-schema'
import { NON_SIGNAL_CLASSES, type NonSignalClass } from '../emit-canary-outcomes.js'

it('the non-signal classes are exactly NON_SIGNAL_CLASSES, within verdict classes', () => {
  expectTypeOf<Exclude<NonSignalClass, (typeof NON_SIGNAL_CLASSES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<NonSignalClass>().toMatchTypeOf<Verdict['class']>()
})
