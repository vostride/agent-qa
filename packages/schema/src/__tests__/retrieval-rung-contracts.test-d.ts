import { describe, expectTypeOf, test } from 'vitest'
import type { z } from 'zod'

import { RETRIEVAL_RUNG_REASONS, RecordedRetrievalRungSchema } from '../index'
import type { RecordedRetrievalRung, RetrievalRungReason } from '../index'
import type * as Brief from '../brief/index'

// Independent literal unions: neither expected vocabulary is derived from production.
type SharedReason =
  | 'native-runtime-unavailable'
  | 'profile-unresolved'
  | 'model-not-downloaded'
  | 'embedder-load-failed'
  | 'index-unavailable'
  | 'floor-disabled'
  | 'profile-static-configured'
type CurrentReason = SharedReason | 'index-not-built' | 'index-locked' | 'index-corrupt'
type Rung = 'memidex' | 'bundle-scan' | 'static-floor' | 'lexical-only'

describe('retrieval rung reasons', () => {
  test('pins ten current reasons in both directions through public exports', () => {
    expectTypeOf<RetrievalRungReason>().toEqualTypeOf<CurrentReason>()
    expectTypeOf<(typeof RETRIEVAL_RUNG_REASONS)[number]>().toEqualTypeOf<CurrentReason>()
    expectTypeOf<
      Exclude<RetrievalRungReason, (typeof RETRIEVAL_RUNG_REASONS)[number]>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Exclude<(typeof RETRIEVAL_RUNG_REASONS)[number], RetrievalRungReason>
    >().toEqualTypeOf<never>()
    expectTypeOf<Brief.RetrievalRungReason>().toEqualTypeOf<RetrievalRungReason>()
  })

  test('pins the recorded rung to exactly the ten reasons', () => {
    expectTypeOf<NonNullable<RecordedRetrievalRung['reason']>>().toEqualTypeOf<CurrentReason>()
    expectTypeOf<Extract<NonNullable<RecordedRetrievalRung['reason']>, 'index-missing'>>()
      .toEqualTypeOf<never>()
  })

  test('pins one strict arm stamped 2 over the same four rungs', () => {
    expectTypeOf<RecordedRetrievalRung['schemaVersion']>().toEqualTypeOf<2>()
    expectTypeOf<RecordedRetrievalRung>().toEqualTypeOf<{
      schemaVersion: 2
      rung: Rung
      reason?: CurrentReason | undefined
    }>()
    expectTypeOf<z.infer<typeof RecordedRetrievalRungSchema>>().toEqualTypeOf<RecordedRetrievalRung>()
    expectTypeOf<Brief.RecordedRetrievalRung>().toEqualTypeOf<RecordedRetrievalRung>()
  })
})

describe('RUNG-INVALID-VERSION', () => {
  test('refuses any stamp other than 2 at the type boundary', () => {
    expectTypeOf<Extract<RecordedRetrievalRung, { schemaVersion: 3 }>>().toEqualTypeOf<never>()
    expectTypeOf<{ schemaVersion: 1; rung: 'bundle-scan'; reason: 'index-locked' }>()
      .not.toExtend<RecordedRetrievalRung>()
    expectTypeOf<{ schemaVersion: 3; rung: 'bundle-scan'; reason: 'index-corrupt' }>()
      .not.toExtend<RecordedRetrievalRung>()
    expectTypeOf<{ schemaVersion: 2; rung: 'bundle-scan'; reason: 'index-locked' }>()
      .toExtend<RecordedRetrievalRung>()
    expectTypeOf<{ schemaVersion: 1; rung: 'bundle-scan'; reason: 'index-unavailable' }>()
      .not.toExtend<RecordedRetrievalRung>()
    expectTypeOf<Extract<keyof RecordedRetrievalRung, 'detail'>>().toEqualTypeOf<never>()
  })
})
