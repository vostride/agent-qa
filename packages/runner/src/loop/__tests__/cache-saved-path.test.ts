import { describe, expect, it } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import type { CacheKey, ElementInfo, ScreenState } from '@vostride/agent-qa-schema'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import type { ActionPlanCache, CachedPlanValue } from '../../cache/port.js'
import type { LoopPorts } from '../ports.js'
import type { ActionPlan, Planner, PlanResult, Verifier } from '../types.js'
import { executeStep } from '../index.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { makeActionPlan, makeStepContext, makeVerifier } from './loop-harness.js'

const STEP = 'Save the contact details'

function el(ref: string, role: string, name: string, y: number, value?: string): ElementInfo {
  const bounds = { x: 20, y, width: 350, height: 44 }
  return {
    ref: asRef(ref),
    role,
    name,
    nameNormalized: name.toLowerCase(),
    ...(value !== undefined ? { value } : {}),
    bounds,
    center: { x: 195, y: y + 22 },
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  }
}

function screen(url: string, elements: ElementInfo[]): ScreenState {
  const refMap: ScreenState['refMap'] = {}
  for (const element of elements) {
    refMap[element.ref] = { bounds: element.bounds!, center: element.center! }
  }
  return makeScreenState({
    url,
    tree: elements
      .map((element) => `- ${element.role} "${element.name}" [ref=${element.ref}]`)
      .join('\n'),
    elements,
    refMap,
  })
}

function formScreens(changedLast = false): ScreenState[] {
  const extra = changedLast ? [el('e9', 'text', 'Unsaved changes', 320)] : []
  return [
    screen('https://contacts.test/new', [
      el('e1', 'textbox', 'Name', 120),
      el('e2', 'textbox', 'Email', 180),
      el('e3', 'button', 'Save', 240),
    ]),
    screen('https://contacts.test/new', [
      el('e1', 'textbox', 'Name', 120, 'Ada'),
      el('e2', 'textbox', 'Email', 180),
      el('e3', 'button', 'Save', 240),
    ]),
    screen('https://contacts.test/new', [
      el('e1', 'textbox', 'Name', 120, 'Ada'),
      el('e2', 'textbox', 'Email', 180, 'ada@example.test'),
      el('e3', 'button', 'Save', 240),
      ...extra,
    ]),
    screen('https://contacts.test/saved', [el('e1', 'heading', 'Contact saved', 80)]),
  ]
}

const FILL_NAME = makeActionPlan({
  reasoning: 'Enter the name',
  action: { type: 'fill', ref: 'e1', text: 'Ada' },
  stepComplete: false,
})
const FILL_EMAIL = makeActionPlan({
  reasoning: 'Enter the email',
  action: { type: 'fill', ref: 'e2', text: 'ada@example.test' },
  stepComplete: false,
})
const CLICK_SAVE = makeActionPlan({
  reasoning: 'Save the contact',
  action: { type: 'click', ref: 'e3' },
  stepComplete: true,
})

// The screen advances only when an action succeeds.
function adapterOver(
  screens: ScreenState[],
  results: ActionResult[] = [],
): PlatformAdapter & { executed: Action[] } {
  let index = 0
  const executed: Action[] = []
  return {
    platform: 'web',
    executed,
    async setup() {},
    async cleanup() {},
    async observe() {
      return screens[Math.min(index, screens.length - 1)]
    },
    async execute(action: Action): Promise<ActionResult> {
      const result = results[executed.length] ?? { success: true }
      executed.push(action)
      if (result.success) index++
      return result
    },
  }
}

function scriptedPlanner(plans: ActionPlan[]): Planner & { calls: number } {
  const planner = {
    calls: 0,
    async plan(): Promise<PlanResult> {
      const plan = plans[Math.min(planner.calls, plans.length - 1)]
      planner.calls++
      return { plan }
    },
  }
  return planner
}

function silentPlanner(): Planner & { calls: number } {
  const planner = {
    calls: 0,
    async plan(): Promise<PlanResult> {
      planner.calls++
      throw new Error('no planner call expected')
    },
  }
  return planner
}

interface RecordingCache extends ActionPlanCache {
  store: Map<string, CachedPlanValue>
  gets: { key: string; hit: boolean }[]
  sets: string[]
  invalidated: string[]
}

function recordingCache(): RecordingCache {
  const store = new Map<string, CachedPlanValue>()
  const gets: { key: string; hit: boolean }[] = []
  const sets: string[] = []
  const invalidated: string[] = []
  return {
    store,
    gets,
    sets,
    invalidated,
    async get(key: CacheKey) {
      const value = store.get(key) ?? null
      gets.push({ key, hit: value !== null })
      return value
    },
    async set(key: CacheKey, value: CachedPlanValue) {
      sets.push(key)
      store.set(key, value)
    },
    async invalidate(key: CacheKey) {
      invalidated.push(key)
      store.delete(key)
    },
  }
}

function forgetCalls(cache: RecordingCache): void {
  cache.gets.length = 0
  cache.sets.length = 0
  cache.invalidated.length = 0
}

function watchedVerifier(
  cache: RecordingCache,
  inner: Verifier = makeVerifier(),
): Verifier & { setsSeen: number[] } {
  const setsSeen: number[] = []
  return {
    setsSeen,
    async verify(...args) {
      setsSeen.push(cache.sets.length)
      return inner.verify(...args)
    },
  }
}

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

async function runStep(options: {
  cache: RecordingCache
  planner: Planner
  screens?: ScreenState[]
  results?: ActionResult[]
  verifier?: Verifier
}) {
  return executeStep(
    STEP,
    ports({
      adapter: adapterOver(options.screens ?? formScreens(), options.results),
      planner: options.planner,
      verifier: options.verifier ?? makeVerifier(),
      cache: options.cache,
    }),
    makeStepContext({ stepInstruction: STEP }),
  )
}

describe('a passing step saves its whole path', () => {
  it('a passing step of several turns saves every turn once the verifier passes, and an unchanged rerun replays them with no planner call', async () => {
    const cache = recordingCache()
    const verifier = watchedVerifier(cache)
    const first = await runStep({
      cache,
      planner: scriptedPlanner([FILL_NAME, FILL_EMAIL, CLICK_SAVE]),
      verifier,
    })

    expect(first.status).toBe('passed')
    expect(verifier.setsSeen).toEqual([0])
    expect(cache.sets).toEqual(cache.gets.map((get) => get.key))
    expect(new Set(cache.sets).size).toBe(3)
    expect(cache.sets.map((key) => cache.store.get(key)!.completesStep)).toEqual([
      false,
      false,
      true,
    ])

    forgetCalls(cache)
    const planner = silentPlanner()
    const second = await runStep({ cache, planner })

    expect(second.status).toBe('passed')
    expect(planner.calls).toBe(0)
    expect(cache.gets).toHaveLength(3)
    expect(cache.gets.every((get) => get.hit)).toBe(true)
    expect(second.evidence!.cacheStatus).toBe('hit')
    expect(cache.sets).toEqual([])
  })

  it('a step that fails saves nothing', async () => {
    const cache = recordingCache()
    const giveUp = makeActionPlan({
      reasoning: 'The contact cannot be saved',
      action: { type: 'delay', ms: 0 },
      stepComplete: false,
      stepFailed: true,
    })
    const result = await runStep({
      cache,
      planner: scriptedPlanner([FILL_NAME, FILL_EMAIL, CLICK_SAVE, giveUp]),
      verifier: makeVerifier([{ success: false, reasoning: 'The contact is not saved' }]),
    })

    expect(result.status).toBe('failed')
    expect(cache.sets).toEqual([])
  })

  it('a failed turn leaves no gap in the saved path', async () => {
    const cache = recordingCache()
    const first = await runStep({
      cache,
      planner: scriptedPlanner([FILL_NAME, FILL_NAME, FILL_EMAIL, CLICK_SAVE]),
      results: [{ success: false, error: 'The field did not take the text' }],
    })

    expect(first.status).toBe('passed')
    expect(cache.gets[1].key).toBe(cache.gets[0].key)
    expect(cache.sets).toEqual(cache.gets.slice(1).map((get) => get.key))
    expect(new Set(cache.sets).size).toBe(3)

    forgetCalls(cache)
    const planner = silentPlanner()
    const second = await runStep({ cache, planner })

    expect(second.status).toBe('passed')
    expect(planner.calls).toBe(0)
    expect(cache.gets.every((get) => get.hit)).toBe(true)
    expect(second.evidence!.cacheStatus).toBe('hit')
  })

  it('a rerun that needs a live turn after replaying saved turns is a miss, and only the live turn is saved', async () => {
    const cache = recordingCache()
    await runStep({ cache, planner: scriptedPlanner([FILL_NAME, FILL_EMAIL, CLICK_SAVE]) })

    forgetCalls(cache)
    const planner = scriptedPlanner([CLICK_SAVE])
    const second = await runStep({ cache, planner, screens: formScreens(true) })

    expect(second.status).toBe('passed')
    expect(cache.gets.map((get) => get.hit)).toEqual([true, true, false])
    expect(planner.calls).toBe(1)
    expect(second.evidence!.cacheStatus).toBe('miss')
    expect(cache.sets).toEqual([cache.gets[2].key])
    expect(cache.store.get(cache.gets[2].key)!.completesStep).toBe(true)
  })
})
