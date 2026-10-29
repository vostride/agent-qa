// A `keyof` pin fails by name if the stopped arm ever grows a `proposal` key.

import { expectTypeOf } from 'vitest'

import type { AuthoringStop } from '@vostride/agent-qa-schema'

import type { AuthoringLoopOutcome } from '../loop.js'
import type { RepairAbandonment } from '../repair.js'
import type { RouterStopSignalClass, StopRoute } from '../router.js'

// ---- 1. the union's arm set, by equality -------------------------------------------------------

expectTypeOf<AuthoringLoopOutcome['kind']>().toEqualTypeOf<
  'drafted' | 'refused' | 'repaired' | 'stopped'
>()

// A key added to or dropped from the stopped arm fails here by name.

expectTypeOf<keyof Extract<AuthoringLoopOutcome, { kind: 'stopped' }>>().toEqualTypeOf<
  'kind' | 'draftRef' | 'receipt' | 'route' | 'abandonment'
>()

expectTypeOf<Extract<AuthoringLoopOutcome, { kind: 'stopped' }>['route']>().toEqualTypeOf<StopRoute>()

// ---- 3. one vocabulary, spelled in two files, pinned equal -------------------------------------
//
// The router's three stop classes and the schema's `AUTHORING_STOP_SIGNAL_CLASSES` are the same
// vocabulary seen from either side of the op's output contract. A word added to one and not the
// other is a drift the projection could never detect, because both halves would still parse.

expectTypeOf<RouterStopSignalClass>().toEqualTypeOf<AuthoringStop['signalClass']>()
expectTypeOf<NonNullable<AuthoringStop['repairAbandonment']>>().toEqualTypeOf<
  RepairAbandonment['kind']
>()
