import { expectTypeOf, test } from 'vitest'
import type { z } from 'zod'
import type { Action, ActionFamily } from '../index'
import { ACTION_FAMILIES, ACTION_FAMILY_BY_TYPE, ActionFamilySchema, actionFamilyOf } from '../index'

test('C424-FAMILIES-EXACT', () => {
  type Expected =
    | 'pointer' | 'input' | 'gesture' | 'navigate' | 'verify'
    | 'extract' | 'wait' | 'device' | 'environment' | 'script'
  expectTypeOf<ActionFamily>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof ACTION_FAMILIES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ActionFamily, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, ActionFamily>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<ActionFamily, (typeof ACTION_FAMILIES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof ACTION_FAMILIES)[number], ActionFamily>>().toEqualTypeOf<never>()
  expectTypeOf<z.infer<typeof ActionFamilySchema>>().toEqualTypeOf<ActionFamily>()
})

test('C424-FAMILIES-EXHAUSTIVE', () => {
  type Mapped = keyof typeof ACTION_FAMILY_BY_TYPE
  expectTypeOf<Exclude<Action['type'], Mapped>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Mapped, Action['type']>>().toEqualTypeOf<never>()
  expectTypeOf<Mapped>().toEqualTypeOf<Action['type']>()
  expectTypeOf<Parameters<typeof actionFamilyOf>>().toEqualTypeOf<[Action['type']]>()
  expectTypeOf<ReturnType<typeof actionFamilyOf>>().toEqualTypeOf<ActionFamily>()
})
