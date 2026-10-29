// THE LIVE PAGE'S TWO ARRANGEMENTS (428 D-06 · PXH-LIVE-04).
//
// Below 768 px of measured page width the page stacks with the preview on top; at 768 and above it
// is docked, and an unmeasured page (width 0) is docked. The switch changes the panels' ids and the
// Group's orientation, never the Group's key (426-11's idiom), so these cells pin the boundary and
// the ids the page reads.

import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  LIVE_RUN_LAYOUTS,
  LIVE_RUN_STACK_BELOW_PX,
  liveRunLayoutOf,
  liveRunPanelIds,
  type LiveRunLayout,
} from '@/lib/live-run-layout'

describe('the live page stacks below 768 px of measured width', () => {
  it('LAYOUT-BOUNDARY-768: 0 docked, 400 stacked, 767 stacked, 768 docked, 1280 docked', () => {
    expect(LIVE_RUN_STACK_BELOW_PX).toBe(768)
    expect([0, 400, 767, 768, 1280].map((width) => [width, liveRunLayoutOf(width)])).toEqual([
      [0, 'docked'],
      [400, 'stacked'],
      [767, 'stacked'],
      [768, 'docked'],
      [1280, 'docked'],
    ])
  })

  it('the layouts are docked and stacked, and each has its own preview and steps ids', () => {
    expect(LIVE_RUN_LAYOUTS).toEqual(['docked', 'stacked'])
    expectTypeOf<(typeof LIVE_RUN_LAYOUTS)[number]>().toEqualTypeOf<LiveRunLayout>()

    const ids = LIVE_RUN_LAYOUTS.map((layout) => liveRunPanelIds(layout))
    for (const one of ids) {
      expect(Object.keys(one).sort()).toEqual(['preview', 'steps'])
      expect(one.preview).not.toBe(one.steps)
    }
    const every = ids.flatMap((one) => [one.preview, one.steps])
    expect(new Set(every).size, `ids: ${JSON.stringify(ids)}`).toBe(4)
  })
})
