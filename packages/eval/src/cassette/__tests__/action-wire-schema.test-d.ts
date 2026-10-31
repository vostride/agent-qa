import type { Action } from '@vostride/agent-qa-schema'
import { expectTypeOf, test } from 'vitest'
import type { z } from 'zod'
import { ACTION_WIRE_SCHEMAS_BY_TYPE } from '../action-wire-schema'

type SchemaMapKey = keyof typeof ACTION_WIRE_SCHEMAS_BY_TYPE

test('the action wire schemas cover every action type with the recorded field types', () => {
  expectTypeOf<SchemaMapKey>().toEqualTypeOf<Action['type']>()

  expectTypeOf<
    z.infer<(typeof ACTION_WIRE_SCHEMAS_BY_TYPE)['fill']>['text']
  >().toEqualTypeOf<string>()
  expectTypeOf<
    z.infer<(typeof ACTION_WIRE_SCHEMAS_BY_TYPE)['fill']>['submit']
  >().toEqualTypeOf<boolean>()
  expectTypeOf<
    z.infer<(typeof ACTION_WIRE_SCHEMAS_BY_TYPE)['paste']>['value']
  >().toEqualTypeOf<string>()
  expectTypeOf<
    z.infer<(typeof ACTION_WIRE_SCHEMAS_BY_TYPE)['pickerSelect']>['type']
  >().toEqualTypeOf<'pickerSelect'>()
  expectTypeOf<
    z.infer<(typeof ACTION_WIRE_SCHEMAS_BY_TYPE)['swipe']>['type']
  >().toEqualTypeOf<'swipe'>()
  expectTypeOf<
    z.infer<(typeof ACTION_WIRE_SCHEMAS_BY_TYPE)['swipe']>['durationMs']
  >().toEqualTypeOf<number>()
  expectTypeOf<
    z.infer<(typeof ACTION_WIRE_SCHEMAS_BY_TYPE)['navigate']>['type']
  >().toEqualTypeOf<'navigate'>()
})
