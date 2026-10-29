// C438-STRICT-REPLAY (438 D-10, D-11, SC3): every way a cache key hit can fail to replay is a
// recorded miss with its typed reason, and nothing the cache stored is dispatched. The real loop
// (executeStep) runs over makeScreenState screens with a recording adapter.
import { describe, expect, it, vi } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import type { ElementInfo, ScreenState } from '@vostride/agent-qa-schema'
import type { ActionPlanCache, CacheablePlannedAction, CachedPlanValue } from '../port.js'
import type { Action, PlatformAdapter } from '../../platform.js'
import type { ActionPlan, PlanResult } from '../../loop/types.js'
import { executeStep } from '../../loop/index.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { makeActionPlan, makeStepContext, makeVerifier } from '../../loop/__tests__/loop-harness.js'

function el(ref: string, role: string, name: string): ElementInfo {
  return {
    ref: asRef(ref),
    role,
    name,
    nameNormalized: name.toLowerCase(),
    bounds: { x: 10, y: 10, width: 100, height: 40 },
    center: { x: 60, y: 30 },
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  }
}

function screenWith(elements: ElementInfo[]): ScreenState {
  const refMap: ScreenState['refMap'] = {}
  for (const e of elements) refMap[e.ref] = { bounds: e.bounds!, center: e.center! }
  return makeScreenState({ elements, refMap })
}

function recordingAdapter(screen: ScreenState): PlatformAdapter & { executed: Action[] } {
  const executed: Action[] = []
  return {
    platform: 'web',
    executed,
    async setup() {},
    async cleanup() {},
    async observe() {
      return screen
    },
    async execute(action: Action) {
      executed.push(action)
      return { success: true }
    },
  }
}

function cacheOf(value: CachedPlanValue): ActionPlanCache & { invalidated: number } {
  let stored: CachedPlanValue | null = value
  const cache = {
    invalidated: 0,
    async get() {
      return stored
    },
    async set() {},
    async invalidate() {
      cache.invalidated++
      stored = null
    },
  }
  return cache
}

const drag = { type: 'drag', fromRef: 'stale-from', toRef: 'stale-to' }

const giveUp: ActionPlan = {
  reasoning: 'the stored target is not on the page',
  action: { type: 'delay', ms: 0 },
  confidence: 0.9,
  stepComplete: false,
  stepFailed: true,
}

function plannerOf(plan: ActionPlan) {
  return { plan: vi.fn(async (): Promise<PlanResult> => ({ plan })) }
}

describe('strict replay records why a stored target misses', () => {
  it("'Cart (3)' stored against 'Cart (4)' is a recorded miss, strict-absent", async () => {
    const adapter = recordingAdapter(screenWith([el('e1', 'button', 'Cart (4)')]))
    const cache = cacheOf({
      plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
      groundedLocator: [{ role: 'button', name: 'Cart (3)' }],
      completesStep: true,
    })
    const planner = plannerOf(makeActionPlan({ action: { type: 'click', ref: 'e1' } }))

    const result = await executeStep(
      'Open the cart',
      { adapter, planner, cache, verifier: makeVerifier() },
      makeStepContext(),
    )

    expect(planner.plan).toHaveBeenCalledTimes(1)
    expect(cache.invalidated).toBe(1)
    expect(adapter.executed).toEqual([{ type: 'click', ref: 'e1' }])
    expect(result.evidence?.cacheStatus).toBe('miss')
    expect(result.evidence?.cacheMiss).toEqual({ reason: 'strict-absent' })
  })

  it('a drag whose stored toRef target is not unique is strict-not-unique, with no execute', async () => {
    const adapter = recordingAdapter(
      screenWith([
        el('e1', 'listitem', 'Row one'),
        el('e2', 'listitem', 'Row two'),
        el('e3', 'listitem', 'Row two'),
      ]),
    )
    const cache = cacheOf({
      plannedActions: [drag as unknown as CacheablePlannedAction],
      groundedLocator: [
        { role: 'listitem', name: 'Row one' },
        { role: 'listitem', name: 'Row two' },
      ],
      completesStep: true,
    })
    const planner = plannerOf(giveUp)

    const result = await executeStep(
      'Drag row one onto row two',
      { adapter, planner, cache, verifier: makeVerifier() },
      makeStepContext(),
    )

    expect(planner.plan).toHaveBeenCalledTimes(1)
    expect(cache.invalidated).toBe(1)
    expect(adapter.executed).toEqual([])
    expect(result.evidence?.cacheStatus).toBe('miss')
    expect(result.evidence?.cacheMiss).toEqual({ reason: 'strict-not-unique' })
  })

  it('a stored value lacking a locator for its ref lane is non-replayable', async () => {
    const adapter = recordingAdapter(screenWith([el('e1', 'button', 'Log in')]))
    const cache = cacheOf({
      plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
      groundedLocator: [],
      completesStep: true,
    })
    const planner = plannerOf(giveUp)

    const result = await executeStep(
      'Click Log in',
      { adapter, planner, cache, verifier: makeVerifier() },
      makeStepContext(),
    )

    expect(planner.plan).toHaveBeenCalledTimes(1)
    expect(cache.invalidated).toBe(1)
    expect(adapter.executed).toEqual([])
    expect(result.evidence?.cacheStatus).toBe('miss')
    expect(result.evidence?.cacheMiss).toEqual({ reason: 'non-replayable' })
  })

  it("a stored nested treeitem with its parent row replays onto that parent's item", async () => {
    const child = (ref: string, parentRef: string): ElementInfo => ({
      ...el(ref, 'treeitem', 'Invoices'),
      hierarchy: { parentRef: asRef(parentRef) },
    })
    const adapter = recordingAdapter(
      screenWith([
        el('e1', 'treeitem', '2024'),
        child('e2', 'e1'),
        el('e3', 'treeitem', '2025'),
        child('e4', 'e3'),
      ]),
    )
    const cache = cacheOf({
      plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
      groundedLocator: [{ role: 'treeitem', name: 'Invoices', row: '2025' }],
      completesStep: true,
    })
    const planner = plannerOf(giveUp)

    const result = await executeStep(
      'Open the 2025 invoices',
      { adapter, planner, cache, verifier: makeVerifier() },
      makeStepContext(),
    )

    expect(adapter.executed).toEqual([{ type: 'click', ref: 'e4' }])
    expect(result.evidence?.cacheStatus).toBe('hit')
    expect(result.evidence?.cacheMiss).toBeUndefined()
    expect(cache.invalidated).toBe(0)
    expect(planner.plan).not.toHaveBeenCalled()
  })
})
