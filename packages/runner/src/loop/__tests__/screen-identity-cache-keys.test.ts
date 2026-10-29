// Pins cache keys, screen hashes, settle and screenshots on a fixed fixture. When the canonical
// form behind a pin changes, recompute the pin by running the code.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  asRef,
  screenIdentityHash,
  screenStateHash,
  sha256hexBytes,
} from '@vostride/agent-qa-schema'
import type { ArtifactRef, CacheKey, ElementInfo, ScreenState } from '@vostride/agent-qa-schema'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import type { ActionPlanCache, CachedPlanValue } from '../../cache/port.js'
import type { EvidenceArtifactStorePort, LoopPorts } from '../ports.js'
import type { ActionPlan, Planner, PlanResult, Verifier } from '../types.js'
import { executeStep } from '../index.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'
import { makeActionPlan, makeStepContext, makeVerifier } from './loop-harness.js'

const STEP = 'Sign in with the demo email'

const PINNED_KEYS = ['ef8fe0803eb452f9', '6623bb8686ac4a41', 'd23f6c4cc7b9344b']
const PINNED_SCREEN_STATE_HASHES = [
  '93b9aeaf3b2cd0c16e50b1759a3a1002c0c2897e697a9772faffad89d678ccd8',
  '7bb75fd998350024bfa3bca49b3843b03e392aa08807e0df19b1faddf8a62338',
  'e9a4863710df2f7aa042182ed58c6ab0b0751f54d320739c3ee43e77627ece27',
]
const SCREENSHOT_BYTES = Buffer.from('agent-qa 436 fixed screenshot bytes')
const PINNED_SCREENSHOT_SHA = 'e3664c4e81aef9f10bd60d796f5242fa6d5e5924871ee1a55fc22cee11c95142'
const PINNED_SCREENSHOT_CALLS = 8
const PINNED_DECISION_REFS = 3

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
      .map(element => `- ${element.role} "${element.name}" [ref=${element.ref}]`)
      .join('\n'),
    elements,
    refMap,
  })
}

function fixtureScreens(banner = false): ScreenState[] {
  const extra = banner ? [el('e9', 'banner', 'Autumn sale', 760)] : []
  return [
    screen('https://shop.test/', [
      el('e1', 'link', 'Sign in', 120),
      el('e2', 'button', 'Browse', 200),
      ...extra,
    ]),
    screen('https://shop.test/login', [
      el('e1', 'textbox', 'Email', 120),
      el('e2', 'button', 'Continue', 200),
      ...extra,
    ]),
    screen('https://shop.test/login', [
      el('e1', 'textbox', 'Email', 120, 'shopper@example.test'),
      el('e2', 'button', 'Continue', 200),
      el('e3', 'text', 'Email accepted', 260),
      ...extra,
    ]),
    screen('https://shop.test/account', [el('e1', 'heading', 'Welcome back', 80), ...extra]),
  ]
}

const FIXTURE_PLANS: ActionPlan[] = [
  makeActionPlan({
    reasoning: 'Open sign in',
    action: { type: 'click', ref: 'e1' },
    stepComplete: false,
  }),
  makeActionPlan({
    reasoning: 'Enter the demo email',
    action: { type: 'fill', ref: 'e1', text: 'shopper@example.test' },
    stepComplete: false,
  }),
  makeActionPlan({
    reasoning: 'Continue to the account',
    action: { type: 'click', ref: 'e2' },
    stepComplete: true,
  }),
]

function adapterOver(
  screens: ScreenState[],
  screenshot?: () => Promise<Buffer>,
): PlatformAdapter & { executed: Action[] } {
  let index = 0
  const executed: Action[] = []
  const adapter: PlatformAdapter & { executed: Action[] } = {
    platform: 'web',
    executed,
    async setup() {},
    async cleanup() {},
    async observe() {
      return screens[Math.min(index, screens.length - 1)]
    },
    async execute(action: Action): Promise<ActionResult> {
      executed.push(action)
      index++
      return { success: true }
    },
  }
  if (screenshot) adapter.screenshot = screenshot
  return adapter
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

interface RecordingCache extends ActionPlanCache {
  store: Map<string, CachedPlanValue>
  gets: { key: string; hit: boolean }[]
  sets: string[]
}

function recordingCache(): RecordingCache {
  const store = new Map<string, CachedPlanValue>()
  const gets: { key: string; hit: boolean }[] = []
  const sets: string[] = []
  return {
    store,
    gets,
    sets,
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
      store.delete(key)
    },
  }
}

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

async function firstRun(cache: RecordingCache) {
  const planner = scriptedPlanner(FIXTURE_PLANS)
  const result = await executeStep(
    STEP,
    ports({ adapter: adapterOver(fixtureScreens()), planner, verifier: makeVerifier(), cache }),
    makeStepContext({ stepInstruction: STEP }),
  )
  return { result, planner }
}

async function savedCache() {
  const cache = recordingCache()
  const first = await firstRun(cache)
  cache.gets.length = 0
  cache.sets.length = 0
  return { cache, first }
}

describe('screen identity in cache keys and replay', () => {
  it('cache keys for the fixed three-action fixture equal the pinned literals, and each passing turn is saved under its key', async () => {
    const cache = recordingCache()
    const { result, planner } = await firstRun(cache)
    expect(result.status).toBe('passed')
    expect(planner.calls).toBe(3)
    expect(cache.gets.map(get => get.key)).toEqual(PINNED_KEYS)
    expect(cache.gets.every(get => !get.hit)).toBe(true)
    expect(cache.sets).toEqual(PINNED_KEYS)
  })

  it('a saved cache replays every decision with zero planner calls', async () => {
    const { cache } = await savedCache()
    const planner = scriptedPlanner(FIXTURE_PLANS)
    const adapter = adapterOver(fixtureScreens())
    const result = await executeStep(
      STEP,
      ports({ adapter, planner, verifier: makeVerifier(), cache }),
      makeStepContext({ stepInstruction: STEP }),
    )
    expect(result.status).toBe('passed')
    expect(planner.calls).toBe(0)
    expect(cache.gets).toEqual(PINNED_KEYS.map(key => ({ key, hit: true })))
    expect(adapter.executed.map(action => action.type)).toEqual(['click', 'fill', 'click'])
    expect(result.evidence!.subActions).toHaveLength(3)
    expect(result.evidence!.cacheStatus).toBe('hit')
  })

  it('a screen with a different identity gains no hit', async () => {
    const { cache } = await savedCache()
    const screens = fixtureScreens(true)
    expect(screenIdentityHash(screens[0])).not.toBe(screenIdentityHash(fixtureScreens()[0]))
    const planner = scriptedPlanner(FIXTURE_PLANS)
    const result = await executeStep(
      STEP,
      ports({ adapter: adapterOver(screens), planner, verifier: makeVerifier(), cache }),
      makeStepContext({ stepInstruction: STEP }),
    )
    expect(result.status).toBe('passed')
    expect(planner.calls).toBe(3)
    expect(cache.gets).toHaveLength(3)
    expect(cache.gets.every(get => !get.hit)).toBe(true)
    expect(cache.gets.filter(get => PINNED_KEYS.includes(get.key))).toEqual([])
  })

  it('screenStateHash of the three fixture screens equals the pinned literals', async () => {
    const { result } = await firstRun(recordingCache())
    expect(result.evidence!.subActions.map(subAction => screenStateHash(subAction.stateBefore)))
      .toEqual(PINNED_SCREEN_STATE_HASHES)
  })

  it('a stable settle does not pass a step the verifier rejects', async () => {
    const constant = fixtureScreens()[1]
    const planner = scriptedPlanner([
      makeActionPlan({
        reasoning: 'Continue',
        action: { type: 'click', ref: 'e2' },
        stepComplete: true,
      }),
      makeActionPlan({
        reasoning: 'Nothing changed; the step cannot complete',
        action: { type: 'click', ref: 'e2' },
        stepComplete: false,
        stepFailed: true,
      }),
    ])
    let verifies = 0
    const verifier: Verifier = {
      async verify(step, _before, after, action) {
        verifies++
        return {
          verification: scriptedVerification({
            step,
            after,
            action,
            pass: false,
            reasoning: 'The account page is not shown',
          }),
        }
      },
    }
    const result = await executeStep(
      STEP,
      ports({ adapter: adapterOver([constant]), planner, verifier }),
      makeStepContext({ stepInstruction: STEP }),
    )
    expect(result.status).toBe('failed')
    expect(result.evidence!.verifierVerdict.pass).toBe(false)
    // The rejected completion, then the give-up's own judgment.
    expect(verifies).toBe(2)
    expect(result.evidence!.conditionVerdicts?.ending).toBe('give-up')
    expect(planner.calls).toBe(2)
    const rejected = result.evidence!.subActions[0]
    expect(screenIdentityHash(rejected.stateAfter!)).toBe(screenIdentityHash(rejected.stateBefore))
  })

  it('screenshots are recorded and the artifact sha is the sha-256 of the bytes', async () => {
    let screenshotCalls = 0
    const persisted: Uint8Array[] = []
    const store: EvidenceArtifactStorePort = {
      persistDecisionScreenshot(bytes): ArtifactRef {
        persisted.push(bytes)
        const sha = sha256hexBytes(bytes)
        return { id: `decision-screenshot:${sha}`, sha }
      },
      getBlob: () => undefined,
    }
    const planned: (Buffer | undefined)[] = []
    const planner: Planner = {
      async plan(_step, _screen, context): Promise<PlanResult> {
        planned.push(context.screenshot)
        return { plan: FIXTURE_PLANS[planned.length - 1] }
      },
    }
    const verified: (Buffer | undefined)[] = []
    const verifier: Verifier = {
      async verify(step, _before, after, action, screenshot) {
        verified.push(screenshot)
        return {
          verification: scriptedVerification({
            step,
            after,
            action,
            pass: true,
            reasoning: 'The account page is shown',
          }),
        }
      },
    }
    const adapter = adapterOver(fixtureScreens(), async () => {
      screenshotCalls++
      return SCREENSHOT_BYTES
    })
    const result = await executeStep(
      STEP,
      ports({ adapter, planner, verifier, evidenceArtifacts: store }),
      makeStepContext({ stepInstruction: STEP }),
    )
    const sha = createHash('sha256').update(SCREENSHOT_BYTES).digest('hex')
    expect(result.status).toBe('passed')
    expect(sha).toBe(PINNED_SCREENSHOT_SHA)
    expect(screenshotCalls).toBe(PINNED_SCREENSHOT_CALLS)
    expect(planned).toEqual([SCREENSHOT_BYTES, SCREENSHOT_BYTES, SCREENSHOT_BYTES])
    expect(verified).toEqual([SCREENSHOT_BYTES])
    const refs = result.evidence!.subActions.map(subAction => subAction.decisionScreenshotRef)
    expect(refs).toHaveLength(PINNED_DECISION_REFS)
    expect(refs).toEqual(refs.map(() => ({ id: `decision-screenshot:${sha}`, sha })))
    expect(persisted.map(bytes => createHash('sha256').update(bytes).digest('hex')))
      .toEqual(refs.map(() => sha))
  })
})
