// The type-level half of the stop arm's no-proposal law.
//
// D-12's runtime cell reads the proposals STORE after an app-broken invocation and counts zero
// envelopes. That measures what the op WROTE. It cannot measure what the loop's arm could carry: a
// `proposal` key smuggled back onto the `stopped` outcome would be filed by nothing today and still
// be one edit away from being filed tomorrow. The `keyof` pins below fail BY NAME the moment such a
// key exists, which is a claim about the shape rather than about one invocation.
//
// TWO HALVES, MEASURED AS TWO LEDGER ROWS. `router.test-d.ts` carries `keyof StopRoute` — the ROUTE
// may not grow a proposal — and this file carries `keyof` of the loop's `stopped` arm. They are
// separate rows because they fail under different mutations and a single file would let one mask
// the other.
//
// This file IS typechecked. `packages/agent/vitest.config.ts` sets `typecheck.include` to
// `src/**/*.test-d.ts`, which is exactly this pattern and NOT `*.test.ts` — the sibling `loop.ts`
// cells in `*.test.ts` are not typechecked by vitest at all, and `tsc --noEmit` remains the only
// type authority for them.

import { expectTypeOf } from 'vitest'

import type { AuthoringStop } from '@vostride/agent-qa-schema'

import type { AuthoringLoopOutcome } from '../loop.js'
import type { RepairAbandonment } from '../repair.js'
import type { RouterStopSignalClass, StopRoute } from '../router.js'

// ---- 1. the union's arm set, by equality -------------------------------------------------------

expectTypeOf<AuthoringLoopOutcome['kind']>().toEqualTypeOf<
  'drafted' | 'refused' | 'repaired' | 'stopped'
>()

// ---- 2. THE D-12 PIN: the stopped arm's whole key set ------------------------------------------
//
// A `proposal` key added to this arm fails here by name, and so does a field dropped from it.

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
