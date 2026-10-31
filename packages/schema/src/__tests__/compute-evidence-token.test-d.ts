import { expectTypeOf, test } from 'vitest'
import { computeEvidenceToken } from '../ids/compute-evidence-token'
import type { EvidenceToken } from '../ids/record-id'

test('computeEvidenceToken takes an observation anchor and returns an evidence token', () => {
  expectTypeOf(computeEvidenceToken).returns.toEqualTypeOf<EvidenceToken>()
  expectTypeOf(computeEvidenceToken).parameter(0).toMatchTypeOf<{
    attributingObservationId: string
    anchor: string
    buildOrdinal: number
  }>()
})
