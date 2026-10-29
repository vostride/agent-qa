// A never-bar catches a member added to the union alone, and the array cells catch one dropped.

import { expectTypeOf, test } from 'vitest'
import { STAGE_PRESENTATION_STATES, type StagePresentationState } from '../post-processing-view'

test('stage presentation states are an exact union', () => {
  type Expected = 'complete' | 'running' | 'pending' | 'failed' | 'skipped' | 'unavailable'
  expectTypeOf<StagePresentationState>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof STAGE_PRESENTATION_STATES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<StagePresentationState, (typeof STAGE_PRESENTATION_STATES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof STAGE_PRESENTATION_STATES)[number], StagePresentationState>>().toEqualTypeOf<never>()
})
