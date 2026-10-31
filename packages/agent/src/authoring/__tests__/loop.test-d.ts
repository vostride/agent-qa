// A `keyof` pin fails by name if the stopped arm ever grows a `proposal` key.

import { expectTypeOf, test } from 'vitest'

import type { AuthoringStop } from '@vostride/agent-qa-schema'

import type { AuthoringLoopOutcome } from '../loop.js'
import type { RepairAbandonment } from '../repair.js'
import type { RouterStopSignalClass, StopRoute } from '../router.js'

test('the authoring loop outcome has exactly four arms', () => {
  expectTypeOf<AuthoringLoopOutcome['kind']>().toEqualTypeOf<
    'drafted' | 'refused' | 'repaired' | 'stopped'
  >()
})

test('the stopped arm has a fixed key set and carries a stop route', () => {
  // A key added to or dropped from the stopped arm fails here by name.

  expectTypeOf<keyof Extract<AuthoringLoopOutcome, { kind: 'stopped' }>>().toEqualTypeOf<
    'kind' | 'draftRef' | 'receipt' | 'route' | 'abandonment'
  >()

  expectTypeOf<Extract<AuthoringLoopOutcome, { kind: 'stopped' }>['route']>().toEqualTypeOf<StopRoute>()
})

test('the router stop classes and repair abandonments match the schema authoring stop', () => {
  // The router's three stop classes and the schema's `AUTHORING_STOP_SIGNAL_CLASSES` are the same
  // vocabulary seen from either side of the op's output contract. A word added to one and not the
  // other is a drift the projection could never detect, because both halves would still parse.

  expectTypeOf<RouterStopSignalClass>().toEqualTypeOf<AuthoringStop['signalClass']>()
  expectTypeOf<NonNullable<AuthoringStop['repairAbandonment']>>().toEqualTypeOf<
    RepairAbandonment['kind']
  >()
})
