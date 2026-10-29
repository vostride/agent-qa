// RED scaffold (Wave 0, Phase 359 · EXEC-04 · D-13/D-14/D-15/D-16 · Pattern 5 · spec §12.13).
// Pins the toggle/picker idempotency contract BEFORE Plans 03/04/08 wire it:
//   Block A — the pure comparator `desiredStateSatisfied(action, screenState)` (D-15): suppress
//     an action ONLY on positive persisted-state evidence (tap/click on a classifier toggle vs
//     state.checked, 437 D-01/D-02; select/nativeSelect/pickerSelect vs the persisted value);
//     undefined/missing state or a non-toggle ⇒ act.
//   Block B — the dispatch-seam short-circuit (D-14): at the ONE chokepoint before adapter.execute,
//     a satisfied desiredState mints a no-input ActionResult (success false, no error) with
//     metadata.idempotentNoop { currentState, inputSent: false } WITHOUT calling the adapter
//     (437 D-05); an unsatisfied desiredState falls through
//     to a plain tap. The desiredState param must survive toolCallToActionPlan to the seam (D-13).
//
// RED BY DESIGN:
//   - Block A: `../../compound/idempotency.js` does not exist until the compound plan lands — the
//     unresolved import fails the whole suite at collection (vitest strips types; `tsc -p .` stays
//     green via @ts-expect-error, removed when the module lands).
//   - Block B: the shipped seam has no idempotency check and the tap/click emission schema has no
//     desiredState param — so the zero-execute / idempotentNoop-metadata / desiredState-survival
//     assertions are un-wired-seam failures (GREEN when Plans 04+08 land).
import { describe, it, expect } from 'vitest'
import type { ScreenState, ElementInfo, ElementState } from '@vostride/agent-qa-schema'
import { asRef } from '@vostride/agent-qa-schema'
import type { PlatformAdapter, Action, ActionResult } from '../../platform.js'
import type { LoopPorts } from '../ports.js'
import { executeStep } from '../index.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { buildAgentScreenState } from './screen-fixtures.js'
import { makeActionPlan, makeStepContext, makeVerifier, makePlanner } from './loop-harness.js'
import { ToolRegistry } from '../../tools/registry.js'
import { registerAllActions } from '../../tools/actions/index.js'
import { toolCallToActionPlan } from '../../tools/builder.js'
import { desiredStateSatisfied } from '../../compound/idempotency.js'

// ---------------------------------------------------------------------------
// Block A — pure comparator fixtures (via the canonical v2 factory, 352 precedent)
// ---------------------------------------------------------------------------

function checkable(
  state: Partial<ElementState>,
  opts: { role?: string; value?: string; attributes?: Record<string, string> } = {},
): ScreenState {
  const element: ElementInfo = {
    ref: asRef('e1'),
    role: opts.role ?? 'checkbox',
    name: 'Wi-Fi',
    nameNormalized: 'wi-fi',
    state: { enabled: true, focused: false, visible: true, ...state },
    labels: {},
    attributes: opts.attributes ?? {},
    ...(opts.value !== undefined ? { value: opts.value } : {}),
  }
  return makeScreenState({ elements: [element] })
}

const ALL_DESIRED = ['checked', 'unchecked', 'selected', 'unselected'] as const

const TOGGLE_FIXTURES: { label: string; role: string; attributes?: Record<string, string> }[] = [
  { label: 'role checkbox', role: 'checkbox' },
  { label: 'role switch', role: 'switch' },
  { label: 'role radio', role: 'radio' },
  { label: 'role button with checkable "true"', role: 'button', attributes: { checkable: 'true' } },
]

function ordinary(selected: boolean): ScreenState {
  return checkable(
    { selected },
    { role: 'button', attributes: { checkable: 'false', selected: String(selected) } },
  )
}

describe('Block A — desiredStateSatisfied: real toggles read checked for all four states', () => {
  for (const fx of TOGGLE_FIXTURES) {
    it(`${fx.label} with checked true satisfies checked and selected as 'checked', and neither of the others`, () => {
      const screen = checkable({ checked: true }, { role: fx.role, ...(fx.attributes ? { attributes: fx.attributes } : {}) })
      for (const type of ['tap', 'click']) {
        expect(desiredStateSatisfied({ type, ref: 'e1', desiredState: 'checked' }, screen)).toEqual({ currentState: 'checked' })
        expect(desiredStateSatisfied({ type, ref: 'e1', desiredState: 'selected' }, screen)).toEqual({ currentState: 'checked' })
        expect(desiredStateSatisfied({ type, ref: 'e1', desiredState: 'unchecked' }, screen)).toBeUndefined()
        expect(desiredStateSatisfied({ type, ref: 'e1', desiredState: 'unselected' }, screen)).toBeUndefined()
      }
    })

    it(`${fx.label} with checked false satisfies unchecked and unselected as 'unchecked', and neither of the others`, () => {
      const screen = checkable({ checked: false }, { role: fx.role, ...(fx.attributes ? { attributes: fx.attributes } : {}) })
      for (const type of ['tap', 'click']) {
        expect(desiredStateSatisfied({ type, ref: 'e1', desiredState: 'unchecked' }, screen)).toEqual({ currentState: 'unchecked' })
        expect(desiredStateSatisfied({ type, ref: 'e1', desiredState: 'unselected' }, screen)).toEqual({ currentState: 'unchecked' })
        expect(desiredStateSatisfied({ type, ref: 'e1', desiredState: 'checked' }, screen)).toBeUndefined()
        expect(desiredStateSatisfied({ type, ref: 'e1', desiredState: 'selected' }, screen)).toBeUndefined()
      }
    })

    it(`${fx.label} with checked ABSENT satisfies none of the four — positive evidence only`, () => {
      for (const selected of [undefined, true, false]) {
        const state: Partial<ElementState> = selected === undefined ? {} : { selected }
        const screen = checkable(state, { role: fx.role, ...(fx.attributes ? { attributes: fx.attributes } : {}) })
        for (const desiredState of ALL_DESIRED) {
          expect(desiredStateSatisfied({ type: 'tap', ref: 'e1', desiredState }, screen)).toBeUndefined()
        }
      }
    })
  }
})

describe('Block A — desiredStateSatisfied: an ordinary node exposing selected always acts', () => {
  it('an ordinary role-button with selected true satisfies none of the four', () => {
    for (const desiredState of ALL_DESIRED) {
      expect(desiredStateSatisfied({ type: 'tap', ref: 'e1', desiredState }, ordinary(true))).toBeUndefined()
      expect(desiredStateSatisfied({ type: 'click', ref: 'e1', desiredState }, ordinary(true))).toBeUndefined()
    }
  })

  it('an ordinary role-button with selected false satisfies none of the four', () => {
    for (const desiredState of ALL_DESIRED) {
      expect(desiredStateSatisfied({ type: 'tap', ref: 'e1', desiredState }, ordinary(false))).toBeUndefined()
      expect(desiredStateSatisfied({ type: 'click', ref: 'e1', desiredState }, ordinary(false))).toBeUndefined()
    }
  })

  it('an ordinary role-button carrying a hand-built checked state still acts', () => {
    for (const checked of [true, false]) {
      const screen = checkable({ checked, selected: checked }, { role: 'button', attributes: { checkable: 'false' } })
      for (const desiredState of ALL_DESIRED) {
        expect(desiredStateSatisfied({ type: 'tap', ref: 'e1', desiredState }, screen)).toBeUndefined()
      }
    }
  })
})

describe('Block A — desiredStateSatisfied: pickers act on the persisted value', () => {
  it('select/nativeSelect/pickerSelect no-op when the persisted value already equals the requested value', () => {
    for (const type of ['select', 'nativeSelect', 'pickerSelect']) {
      // Already on Option A ⇒ suppress.
      expect(desiredStateSatisfied({ type, ref: 'e1', value: 'Option A' }, checkable({}, { role: 'combobox', value: 'Option A' }))).toBeDefined()
      // Different requested value ⇒ act.
      expect(desiredStateSatisfied({ type, ref: 'e1', value: 'Option B' }, checkable({}, { role: 'combobox', value: 'Option A' }))).toBeUndefined()
      // Persisted value absent ⇒ act (positive evidence only).
      expect(desiredStateSatisfied({ type, ref: 'e1', value: 'Option A' }, checkable({}, { role: 'combobox' }))).toBeUndefined()
    }
  })

  it('an action with no desiredState and a non-picker type is always undefined (no idempotency claim)', () => {
    expect(desiredStateSatisfied({ type: 'tap', ref: 'e1' }, checkable({ checked: true }))).toBeUndefined()
  })

  it('byte-pin: the hit object sorted keys are exactly ["currentState"] with a string value', () => {
    const hit = desiredStateSatisfied({ type: 'tap', ref: 'e1', desiredState: 'checked' }, checkable({ checked: true }))
    expect(Object.keys(hit!).sort()).toEqual(['currentState'])
    expect(typeof hit!.currentState).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Block B — dispatch-seam integration over the loop harness (D-13/D-14/D-16)
// ---------------------------------------------------------------------------

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

function recordingAdapter(observation: ScreenState, calls: Action[]): PlatformAdapter {
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      return observation
    },
    async execute(action: Action): Promise<ActionResult> {
      calls.push(action)
      return { success: true }
    },
  }
}

interface LooseSub {
  result?: { success?: boolean; error?: string; metadata?: Record<string, unknown> }
}

function firstSub(result: Awaited<ReturnType<typeof executeStep>>): LooseSub | undefined {
  const ev = result.evidence as { subActions?: LooseSub[] } | undefined
  return ev?.subActions?.[0]
}

describe('Block B — the seam suppresses a satisfied desiredState', () => {
  it('a checked toggle with desiredState=checked never calls adapter.execute and records idempotentNoop', async () => {
    const observation = buildAgentScreenState({
      url: 'https://x.test/settings',
      elements: [{ ref: 'e1', role: 'checkbox', name: 'Wi-Fi', state: { checked: true }, bounds: { x: 20, y: 80, width: 300, height: 44 } }],
      metadata: { coordSpace: 'viewport', viewportWidth: 390, viewportHeight: 844 },
    })
    const calls: Action[] = []
    const adapter = recordingAdapter(observation, calls)
    const plans = [makeActionPlan({ action: { type: 'tap', ref: 'e1', desiredState: 'checked' }, stepComplete: true })]

    const result = await executeStep(
      'Ensure Wi-Fi is on',
      ports({ adapter, planner: makePlanner(plans), verifier: makeVerifier(), plannerConfig: { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 } }),
      makeStepContext(),
    )

    // D-14: the check runs at the ONE chokepoint before adapter.execute ⇒ zero adapter calls.
    expect(calls.length).toBe(0)
    // D-16: the minted no-op carries metadata.idempotentNoop.currentState ...
    const sub = firstSub(result)
    const noop = sub?.result?.metadata?.['idempotentNoop'] as { currentState?: unknown } | undefined
    expect(noop).toEqual({ currentState: 'checked', inputSent: false })
    expect(sub?.result?.success).toBe(false)
    expect(sub?.result?.error).toBeUndefined()
  })

  it('an UNsatisfied desiredState=checked (state.checked false) falls through to a plain tap', async () => {
    const observation = buildAgentScreenState({
      url: 'https://x.test/settings',
      elements: [{ ref: 'e1', role: 'checkbox', name: 'Wi-Fi', state: { checked: false }, bounds: { x: 20, y: 80, width: 300, height: 44 } }],
      metadata: { coordSpace: 'viewport', viewportWidth: 390, viewportHeight: 844 },
    })
    const calls: Action[] = []
    const adapter = recordingAdapter(observation, calls)
    const plans = [makeActionPlan({ action: { type: 'tap', ref: 'e1', desiredState: 'checked' }, stepComplete: true })]

    await executeStep(
      'Turn Wi-Fi on',
      ports({ adapter, planner: makePlanner(plans), verifier: makeVerifier(), plannerConfig: { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 } }),
      makeStepContext(),
    )

    // Un-satisfied ⇒ the seam does NOT suppress; the adapter executes the plain tap.
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })
})

describe('Block B — desiredState survives toolCallToActionPlan to the seam', () => {
  it('a click tool call carrying desiredState spreads it onto the produced action plan', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    // Currently RED: the click emission schema is .strict() with no desiredState param (Plan 04
    // adds it) ⇒ toolCallToActionPlan rejects the field. When Plan 04 lands, desiredState rides
    // through to action.desiredState with zero extra plumbing (builder spreads parsed fields).
    const plan = toolCallToActionPlan(
      'web_click',
      { reasoning: 'toggle wifi', confidence: 1, stepComplete: false, ref: 'e1', desiredState: 'checked' },
      registry,
    ) as { action: Record<string, unknown> }
    expect(plan.action['desiredState']).toBe('checked')
  })
})
