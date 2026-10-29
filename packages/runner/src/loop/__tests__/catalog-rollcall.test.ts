// D-20 catalog roll-call — the phase's permanent conformance anchor (Phase 360, Plan 02).
//
// Registry-driven, NOT a hand-kept verb list: instantiate ToolRegistry + registerAllActions,
// assert the frozen counts, then walk EVERY registered id. A per-verb minimal-valid-args
// fixture map is keyed BY the registry walk (a completeness guard fails naming any registered
// id without a fixture, so the registry stays the source of truth), and each fixture is proven
// to convert through toolCallToActionPlan (the emission→plan boundary). The dispatch-totality
// leg then asserts every (id, legal-platform) pair is either a runner mint (MINT_VERBS from
// ../../compound/dispatch-mint.js) or reaches adapter.execute via the loop harness with a
// call-logging fake adapter — an assertNever-style totality proof expressed at runtime.
//
// RED today: the dispatch-totality leg imports MINT_VERBS from a module Plans 08/10 land, so it
// fails on the missing import; once that module exists it fails naming the ids the flip has not
// yet routed (Plans 04-07). The frozen-count + fixture-completeness legs pass today by design.
// The walk is driver-free (fake adapters only) and deterministic.
import { describe, it, expect } from 'vitest'
import type { Platform } from '@vostride/agent-qa-schema'

import { ToolRegistry } from '../../tools/registry.js'
import { EXPOSURE } from '../../tools/registry.js'
import { registerAllActions } from '../../tools/actions/index.js'
import { toolCallToActionPlan } from '../../tools/builder.js'
import type { PlatformAdapter, Action, ActionResult } from '../../platform.js'
import type { LoopPorts } from '../ports.js'
import type { ActionPlan } from '../types.js'
import { executeStep } from '../index.js'
import { buildAgentScreenState } from './screen-fixtures.js'
import { makePlanner, makeStepContext, makeActionPlan } from './loop-harness.js'

const PLATFORMS: Platform[] = ['web', 'android', 'ios']

const registry = new ToolRegistry()
registerAllActions(registry)
const defs = registry.getAll()

// Plan-envelope fields toolCallToActionPlan destructures before the strict action parse.
const PLAN_ENVELOPE = {
  reasoning: 'roll-call fixture',
  confidence: 1,
  stepComplete: false,
  doesActionAdvanceUsTowardsGoal: true,
}

// Minimal-valid EMISSION args per verb type (schema defaults fill the rest). Keyed by verb
// `type`, consumed BY the registry walk — the completeness guard proves no registered id is
// missing an entry, so the registry (not this map) is the source of truth.
const FIXTURES: Record<string, Record<string, unknown>> = {
  // common
  assertAI: { claim: 'the page shows a success banner' },
  assertValue: { source: 'url', op: 'isDefined' },
  extractAI: { query: 'extract the order id', schema: [{ name: 'orderId', type: 'string', description: 'the id' }] },
  reportValue: { value: '42' },
  clearText: { ref: 'e1' },
  delay: { ms: 100 },
  keypress: { keys: ['Enter'] },
  openApp: { appName: 'Settings' },
  scroll: { mode: 'direction', direction: 'down' },
  setVariable: { name: 'token', value: 'abc' },
  waitFor: { on: 'text', text: 'Loading' },
  // web
  click: { ref: 'e1' },
  copy: { ref: 'e1' },
  doubleClick: { ref: 'e1' },
  fileUpload: { ref: 'e1', files: ['fixture.txt'] },
  fill: { ref: 'e1', text: 'hello' },
  focus: { ref: 'e1' },
  handleDialog: { accept: true },
  hover: { ref: 'e1' },
  inspect: { what: 'console' },
  navigate: { to: 'reload' },
  networkState: { mode: 'offline' },
  paste: { ref: 'e1', value: 'pasted' },
  rightClick: { ref: 'e1' },
  route: { urlPattern: '**/api/**' },
  select: { ref: 'e1', value: 'US' },
  setCookies: { cookies: [{ name: 'session', value: 'x' }] },
  setLocalStorage: { entries: [{ key: 'k', value: 'v' }] },
  storageState: { op: 'save', name: 'authed' },
  tab: { action: 'new', url: 'https://example.test' },
  uniqueValue: { prefix: 'user' },
  unroute: {},
  waitForUrl: { pattern: '**/dashboard**' },
  // mobile shared
  doubleTap: { ref: 'e1' },
  drag: { fromRef: 'e1', toRef: 'e2' },
  hideKeyboard: {},
  longpress: { ref: 'e1' },
  multiTap: { fingers: 2, ref: 'e1' },
  nativeSelect: { ref: 'e1', value: 'Option' },
  pinch: { scale: 2, ref: 'e1' },
  setOrientation: { orientation: 'portrait' },
  swipe: { mode: 'direction', direction: 'up' },
  tap: { ref: 'e1' },
  tapCoordinate: { x: 100, y: 200, coordSpace: 'viewport' },
  // android-only
  pressBack: {},
  pressHome: {},
  pressRecent: {},
  openNotifications: {},
  openQuickSettings: {},
  intent: { action: 'android.intent.action.VIEW' },
  keyevent: { keycode: 'KEYCODE_ENTER' },
  // ios-only
  pressButton: { button: 'home' },
  pickerSelect: { ref: 'e1', value: 'March' },
  swipeFromEdge: { edge: 'left' },
  openUniversalLink: { url: 'https://example.test/deep' },
}

function legalPlatformsFor(surface: string): Platform[] {
  return PLATFORMS.filter((p) => EXPOSURE[p].has(surface as never))
}

// A permissive screen state: e1/e2 refs resolve for every ref-bearing verb; the viewport is
// large enough that coordinate verbs (tapCoordinate/pinch/multiTap/swipe-path) stay in bounds.
function rollcallScreen(platform: Platform) {
  return buildAgentScreenState({
    platform,
    url: 'https://example.test/',
    elements: [
      { ref: 'e1', role: 'button', name: 'Primary', bounds: { x: 20, y: 80, width: 300, height: 44 } },
      { ref: 'e2', role: 'button', name: 'Secondary', bounds: { x: 20, y: 160, width: 300, height: 44 } },
    ],
    refMap: {
      e1: { bounds: { x: 20, y: 80, width: 300, height: 44 } },
      e2: { bounds: { x: 20, y: 160, width: 300, height: 44 } },
    },
    metadata: { coordSpace: 'viewport', viewportWidth: 390, viewportHeight: 844 },
  })
}

// A recording fake adapter — its execute() logs the action and never touches a real driver.
function recordingAdapter(platform: Platform, calls: Action[]): PlatformAdapter {
  return {
    platform,
    async setup() {},
    async cleanup() {},
    async observe() {
      return rollcallScreen(platform)
    },
    async execute(action: Action): Promise<ActionResult> {
      calls.push(action)
      return { success: true }
    },
  }
}

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

// True when the runner routes the id to a real dispatch — either it reaches adapter.execute or a
// surviving runner-runtime callback (setVariable via ports.onSetVariable). Defensive: any harness
// throw counts as "not dispatched" so the walk never fails for a harness reason, only names ids.
async function dispatchReachesAdapter(action: Action, platform: Platform): Promise<boolean> {
  const calls: Action[] = []
  let setVariableRouted = false
  const adapter = recordingAdapter(platform, calls)
  try {
    const result = await executeStep(
      'roll-call dispatch probe',
      ports({
        adapter,
        planner: makePlanner([makeActionPlan({ action: action as ActionPlan['action'], stepComplete: false })]),
        // No verifier: the probe ends at its action limit, which a bound verifier would judge
        // over a settled screen; dispatch is all this probe reads.
        plannerConfig: { maxActions: 1, maxPlanningTurns: 1, previousStepCount: 0 },
        onSetVariable: () => { setVariableRouted = true },
      }),
      makeStepContext(),
    )
    void result
  } catch {
    return calls.length > 0 || setVariableRouted
  }
  return calls.length > 0 || setVariableRouted
}

describe('catalog roll-call', () => {
  it('freezes the registered catalog at 56 / web 33 / android 30 / ios 27', () => {
    expect(registry.getAll()).toHaveLength(56)
    expect(registry.getForPlatform('web')).toHaveLength(33)
    expect(registry.getForPlatform('android')).toHaveLength(30)
    expect(registry.getForPlatform('ios')).toHaveLength(27)
  })

  it('every registered id has a fixture keyed by the registry walk (completeness guard)', () => {
    const missing = defs.filter((def) => FIXTURES[def.type] === undefined).map((def) => def.id)
    expect(missing, `registered ids missing a roll-call fixture: ${missing.join(', ')}`).toEqual([])
  })

  it('every fixture converts through toolCallToActionPlan into its own verb (emission→plan boundary)', () => {
    const offenders: string[] = []
    for (const def of defs) {
      const fixture = FIXTURES[def.type]
      if (fixture === undefined) continue
      try {
        const plan = toolCallToActionPlan(def.id, { ...fixture, ...PLAN_ENVELOPE }, registry)
        if (plan.action.type !== def.type) offenders.push(`${def.id}: produced ${plan.action.type}`)
      } catch (err) {
        offenders.push(`${def.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    expect(offenders, `fixtures that failed the emission→plan conversion: ${offenders.join(' | ')}`).toEqual([])
  })

  it('every registered id on every legal platform either mints or dispatches', async () => {
    // MINT_VERBS landed with the dispatch-mint module in Plan 08 (import now resolves).
    const { MINT_VERBS } = await import('../../compound/dispatch-mint.js')
    const mintSet = new Set<string>(MINT_VERBS as readonly string[])

    const unhandled: string[] = []
    for (const def of defs) {
      const fixture = FIXTURES[def.type]
      if (fixture === undefined) continue
      let action: Action
      try {
        action = toolCallToActionPlan(def.id, { ...fixture, ...PLAN_ENVELOPE }, registry).action as unknown as Action
      } catch (err) {
        unhandled.push(`${def.id}: conversion failed (${err instanceof Error ? err.message : String(err)})`)
        continue
      }
      for (const platform of legalPlatformsFor(def.surface)) {
        if (mintSet.has(def.type)) continue
        const reached = await dispatchReachesAdapter(action, platform)
        if (!reached) unhandled.push(`${def.id}@${platform}`)
      }
    }
    expect(unhandled, `ids that neither mint nor dispatch: ${unhandled.join(', ')}`).toEqual([])
  })
})
