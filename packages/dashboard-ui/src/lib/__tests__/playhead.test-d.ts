import { expectTypeOf, test } from 'vitest'
import {
  TIMELINE_AXES, MARKER_RESULTS, MARKER_FRAMES, PLAYER_SOURCES,
  type TimelineAxis, type MarkerResult, type MarkerFrame, type PlayerSource,
} from '../playhead'

test('timeline axes are an exact union', () => {
  type Expected = 'time' | 'ordinal'
  expectTypeOf<TimelineAxis>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof TIMELINE_AXES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<TimelineAxis, (typeof TIMELINE_AXES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof TIMELINE_AXES)[number], TimelineAxis>>().toEqualTypeOf<never>()
})

test('marker results are an exact union', () => {
  // 2026-10-08 (437-03, D-05): 'no-input' joins the closed set for a tap that sent no input.
  type Expected = 'passed' | 'failed' | 'healed' | 'no-input'
  expectTypeOf<MarkerResult>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof MARKER_RESULTS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<MarkerResult, (typeof MARKER_RESULTS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof MARKER_RESULTS)[number], MarkerResult>>().toEqualTypeOf<never>()
})

test('marker frames are an exact union', () => {
  type Expected = 'available' | 'absent'
  expectTypeOf<MarkerFrame>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof MARKER_FRAMES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<MarkerFrame, (typeof MARKER_FRAMES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof MARKER_FRAMES)[number], MarkerFrame>>().toEqualTypeOf<never>()
})

test('player sources are an exact union', () => {
  type Expected = 'frames' | 'video'
  expectTypeOf<PlayerSource>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof PLAYER_SOURCES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<PlayerSource, (typeof PLAYER_SOURCES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof PLAYER_SOURCES)[number], PlayerSource>>().toEqualTypeOf<never>()
})
