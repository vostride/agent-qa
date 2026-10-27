// Q4 replay mapping · Pitfall 5 · Pitfall 9, strict since 438 D-10/D-11. Pins the cache replay
// path: a stored role + exact name replays onto the one current element that has it at whatever
// ref it now carries; a drifted name or two survivors invalidate → replan (never a pick);
// multi-ref (drag) replays re-resolve BOTH per-field refs; coordinate actions are
// non-replayable; and every grounded sub-action carries the §A8 grounding block.
import { describe, it, expect, vi } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import type { ElementInfo, ScreenState } from '@vostride/agent-qa-schema'
import type { LoopPorts } from '../ports.js'
import type { ActionPlanCache, CacheablePlannedAction, CachedPlanValue, GroundedLocator } from '../../cache/port.js'
import type { Action } from '../../platform.js'
import type { Planner } from '../types.js'
import { executeStep } from '../index.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { makeActionPlan, makeAdapter, makePlanner, makeStepContext, makeVerifier } from './loop-harness.js'

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

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
  for (const e of elements) {
    refMap[e.ref] = { bounds: e.bounds!, center: e.center! }
  }
  return makeScreenState({ elements, refMap })
}

function cacheOf(value: CachedPlanValue | null, spy?: { invalidate: () => void }): ActionPlanCache {
  return {
    async get() { return value },
    async set() {},
    async invalidate() { spy?.invalidate() },
  }
}

describe('replay re-ground mapping (Q4)', () => {
  it('exact replay: a resolving locator replays with NO planner call (preserved contract)', async () => {
    const cached: CachedPlanValue = {
      plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
      groundedLocator: [{ role: 'button', name: 'Log in' }],
      completesStep: true,
    }
    const plannerSpy = vi.fn()
    const result = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter(), planner: { plan: plannerSpy } as unknown as Planner, cache: cacheOf(cached) }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(plannerSpy).not.toHaveBeenCalled()
  })

  it('stale ref + unique substring match ⇒ re-ground replay with the patched fresh ref (no replan)', async () => {
    // 2026-10-09 (438-08): replay has no substring rung (D-10). The stored exact name replays
    // onto the element that now carries it at a new ref; a drifted name does not replay.
    const cached = (): CachedPlanValue => ({
      plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
      groundedLocator: [{ role: 'button', name: 'Log in' }],
      completesStep: true,
    })
    const moved = screenWith([el('e7', 'button', 'Log in')])
    const plannerSpy = vi.fn()
    const result = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter({ observeResults: [moved, moved] }), planner: { plan: plannerSpy } as unknown as Planner, cache: cacheOf(cached()) }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(plannerSpy).not.toHaveBeenCalled()
    expect((result.action as { ref?: string }).ref).toBe('e7')

    const drifted = screenWith([el('e7', 'button', 'Log in now')])
    const invalidateSpy = { invalidate: vi.fn() }
    const replanSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan({ action: { type: 'click', ref: 'e7' } }) })
    const replanned = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter({ observeResults: [drifted, drifted] }), planner: { plan: replanSpy }, cache: cacheOf(cached(), invalidateSpy), verifier: makeVerifier() }),
      makeStepContext(),
    )
    expect(replanned.status).toBe('passed')
    expect(invalidateSpy.invalidate).toHaveBeenCalledTimes(1)
    expect(replanSpy).toHaveBeenCalledTimes(1)
  })

  it('ambiguous match on the replay path ⇒ invalidate ⇒ replan, never a pick', async () => {
    const fresh = screenWith([el('e1', 'button', 'Add'), el('e2', 'button', 'Add')])
    const ambiguous: CachedPlanValue = {
      plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
      // Two survivors of role + exact name ⇒ not-unique ⇒ a miss on the cache path (D-10).
      groundedLocator: [{ role: 'button', name: 'Add' } satisfies GroundedLocator],
      completesStep: true,
    }
    const invalidateSpy = { invalidate: vi.fn() }
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan({ action: { type: 'click', ref: 'e1' } }) })
    const result = await executeStep(
      'Click Add',
      ports({ adapter: makeAdapter({ observeResults: [fresh, fresh] }), planner: { plan: plannerSpy }, cache: cacheOf(ambiguous, invalidateSpy), verifier: makeVerifier() }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(invalidateSpy.invalidate).toHaveBeenCalledTimes(1)
    expect(plannerSpy).toHaveBeenCalledTimes(1) // ambiguity never first-picks — it replans
  })

  it('a cached drag replays with BOTH fromRef and toRef re-resolved from per-field locators (Pitfall 5a)', async () => {
    const fresh = screenWith([el('e5', 'listitem', 'Row one'), el('e6', 'listitem', 'Row two')])
    const cachedDrag: CachedPlanValue = {
      plannedActions: [{ type: 'drag', fromRef: 'stale-from', toRef: 'stale-to' } as unknown as CacheablePlannedAction],
      groundedLocator: [
        { role: 'listitem', name: 'Row one' },
        { role: 'listitem', name: 'Row two' },
      ],
      completesStep: true,
    }
    const plannerSpy = vi.fn()
    const result = await executeStep(
      'Reorder the rows',
      ports({ adapter: makeAdapter({ observeResults: [fresh, fresh] }), planner: { plan: plannerSpy } as unknown as Planner, cache: cacheOf(cachedDrag) }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(plannerSpy).not.toHaveBeenCalled()
    expect((result.action as { fromRef?: string }).fromRef).toBe('e5')
    expect((result.action as { toRef?: string }).toRef).toBe('e6')
  })

  it('a cached coordinate action (tapCoordinate) is non-replayable ⇒ invalidate ⇒ replan', async () => {
    const cachedCoord: CachedPlanValue = {
      plannedActions: [{ type: 'tapCoordinate', coordSpace: 'viewport' } as unknown as CacheablePlannedAction],
      groundedLocator: [],
      completesStep: true,
    }
    const invalidateSpy = { invalidate: vi.fn() }
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan({ action: { type: 'tapCoordinate', x: 10, y: 20, coordSpace: 'viewport' } }) })
    const result = await executeStep(
      'Tap the widget',
      ports({ adapter: makeAdapter(), planner: { plan: plannerSpy }, cache: cacheOf(cachedCoord, invalidateSpy), verifier: makeVerifier() }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(invalidateSpy.invalidate).toHaveBeenCalledTimes(1)
    expect(plannerSpy).toHaveBeenCalledTimes(1)
  })

  it('every grounded sub-action recorded during a live plan carries the §A8 grounding block (Pitfall 9)', async () => {
    const result = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter(), planner: makePlanner(), verifier: makeVerifier() }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    const sub = result.evidence?.subActions?.[0] as { grounding?: { attempts: unknown[] } } | undefined
    expect(sub?.grounding).toBeDefined()
    expect(Array.isArray(sub?.grounding?.attempts)).toBe(true)
  })
})
