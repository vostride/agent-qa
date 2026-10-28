import { asRef } from '@vostride/agent-qa-schema'
import type { CacheKey, ElementInfo, ScreenState } from '@vostride/agent-qa-schema'
import type { Action, ActionResult, PlatformAdapter } from '../../../platform.js'
import type { ActionPlanCache, CachedPlanValue } from '../../../cache/port.js'
import type { LoopPorts } from '../../ports.js'
import type { ActionPlan, Planner, PlanResult, Verifier } from '../../types.js'
import { executeStep } from '../../index.js'
import { makeScreenState } from '../../../testing/screen-fixtures.js'
import { makeActionPlan, makeStepContext, makeVerifier } from '../loop-harness.js'

export const STEP = 'Save the contact details'

export function el(
  ref: string,
  role: string,
  name: string,
  y: number,
  value?: string,
): ElementInfo {
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

export function screen(url: string, elements: ElementInfo[]): ScreenState {
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

export function formScreens(changedLast = false): ScreenState[] {
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

export const FILL_NAME = makeActionPlan({
  reasoning: 'Enter the name',
  action: { type: 'fill', ref: 'e1', text: 'Ada' },
  stepComplete: false,
})
export const FILL_EMAIL = makeActionPlan({
  reasoning: 'Enter the email',
  action: { type: 'fill', ref: 'e2', text: 'ada@example.test' },
  stepComplete: false,
})
export const CLICK_SAVE = makeActionPlan({
  reasoning: 'Save the contact',
  action: { type: 'click', ref: 'e3' },
  stepComplete: true,
})

// The screen advances only when an action succeeds.
export function adapterOver(
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

export function scriptedPlanner(plans: ActionPlan[]): Planner & { calls: number } {
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

export function silentPlanner(): Planner & { calls: number } {
  const planner = {
    calls: 0,
    async plan(): Promise<PlanResult> {
      planner.calls++
      throw new Error('no planner call expected')
    },
  }
  return planner
}

export interface RecordingCache extends ActionPlanCache {
  store: Map<string, CachedPlanValue>
  gets: { key: string; hit: boolean }[]
  sets: string[]
  invalidated: string[]
}

export function recordingCache(): RecordingCache {
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

export function forgetCalls(cache: RecordingCache): void {
  cache.gets.length = 0
  cache.sets.length = 0
  cache.invalidated.length = 0
}

export function ports(
  overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>,
): LoopPorts {
  return overrides
}

export async function runStep(options: {
  cache: RecordingCache
  planner: Planner
  screens?: ScreenState[]
  results?: ActionResult[]
  verifier?: Verifier
  adapter?: PlatformAdapter
}) {
  return executeStep(
    STEP,
    ports({
      adapter: options.adapter ?? adapterOver(options.screens ?? formScreens(), options.results),
      planner: options.planner,
      verifier: options.verifier ?? makeVerifier(),
      cache: options.cache,
    }),
    makeStepContext({ stepInstruction: STEP }),
  )
}
