import { expectTypeOf, test } from 'vitest'
import type { z } from 'zod'
import type { Action, ActionFamily } from '../index'
import { ACTION_FAMILIES, ACTION_FAMILY_BY_TYPE, ActionFamilySchema, actionFamilyOf } from '../index'

test('ActionFamily is exactly the ten families of the list and the schema', () => {
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

test('the family map covers exactly the action types, and actionFamilyOf maps one to a family', () => {
  type Mapped = keyof typeof ACTION_FAMILY_BY_TYPE
  expectTypeOf<Exclude<Action['type'], Mapped>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Mapped, Action['type']>>().toEqualTypeOf<never>()
  expectTypeOf<Mapped>().toEqualTypeOf<Action['type']>()
  expectTypeOf<Parameters<typeof actionFamilyOf>>().toEqualTypeOf<[Action['type']]>()
  expectTypeOf<ReturnType<typeof actionFamilyOf>>().toEqualTypeOf<ActionFamily>()
})
