// THE PRESENTATION-STATE SET, PINNED IN BOTH DIRECTIONS (425-01 · D-06/D-07, UI-SPEC S3).
//
// The runtime array and the union are two spellings of one closed set, and a never-bar is the only
// assertion that catches the half of a drift a runtime cell cannot see: a seventh member added to
// the union alone compiles everywhere and renders nothing, and a member dropped from the array
// alone leaves a state no cell ever walks.

import { expectTypeOf, test } from 'vitest'
import { STAGE_PRESENTATION_STATES, type StagePresentationState } from '../post-processing-view'

test('stage presentation states are an exact union', () => {
  type Expected = 'complete' | 'running' | 'pending' | 'failed' | 'skipped' | 'unavailable'
  expectTypeOf<StagePresentationState>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof STAGE_PRESENTATION_STATES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<StagePresentationState, (typeof STAGE_PRESENTATION_STATES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof STAGE_PRESENTATION_STATES)[number], StagePresentationState>>().toEqualTypeOf<never>()
})
