// The cached value is descriptor-only: the observed role,
// the exact name and, when the planner stated a row the observed row holds, those row words.
// Never a ref/selector/coordinates, never a position and never the step `data` value. The
// overfit guard is a deep scan of the serialized value for a sentinel ref and a sentinel data
// value.
import { describe, expect, it } from 'vitest'

import { asRef } from '@vostride/agent-qa-schema'
import type { ElementInfo } from '@vostride/agent-qa-schema'
import type { Action } from '../../platform.js'

import { buildCachedPlanValue, toGroundedLocator } from '../value.js'

const SENTINEL_REF = 'ref-DO-NOT-STORE-9f9f'
const SENTINEL_DATA = 'order-id-should-never-persist-4242'

function element(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    ref: asRef(overrides.ref ?? 'e1'),
    role: overrides.role ?? 'button',
    name: overrides.name ?? 'Checkout',
    nameNormalized: overrides.nameNormalized ?? 'checkout',
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
    ...overrides,
  }
}

describe('toGroundedLocator — descriptor-only projection', () => {
  it('projects an action + elements to a role+nameNormalized descriptor with no ref', () => {
    const elements = [element({ ref: asRef(SENTINEL_REF), role: 'button', name: 'Cart  (3) ', nameNormalized: 'cart' })]
    const action = { type: 'click', ref: SENTINEL_REF } as unknown as Action

    const locator = toGroundedLocator(action, elements)

    // the exact name with spacing tidied, its badge kept; no ordinal.
    expect(locator).toEqual({ role: 'button', name: 'Cart (3)' })
    expect(Object.hasOwn(locator as object, 'ref')).toBe(false)
    expect(JSON.stringify(locator)).not.toContain(SENTINEL_REF)
  })
})

describe('buildCachedPlanValue — no ref/selector/coordinates/data in the value (overfit guard)', () => {
  it('assembles a descriptor-only CachedPlanValue that omits the raw ref and step data', () => {
    const elements = [element({ ref: asRef(SENTINEL_REF), role: 'button', name: 'Checkout', nameNormalized: 'checkout' })]
    const action = { type: 'click', ref: SENTINEL_REF, data: SENTINEL_DATA } as unknown as Action

    const value = buildCachedPlanValue({
      plannedActions: [action],
      elements,
      completesStep: true,
    })

    expect(value.completesStep).toBe(true)
    expect(value.groundedLocator).toHaveLength(1)
    expect(value.groundedLocator[0]).toEqual({ role: 'button', name: 'Checkout' })

    // Deep scan: neither the sentinel ref nor the sentinel step data may survive.
    const serialized = JSON.stringify(value)
    expect(serialized).not.toContain(SENTINEL_REF)
    expect(serialized).not.toContain(SENTINEL_DATA)
  })
})

describe('toGroundedLocator — the stated row', () => {
  const rows = [
    element({ ref: asRef('r1'), role: 'listitem', name: '', nameNormalized: '', text: 'Work 7 Elm Street, Springfield' }),
    element({ ref: asRef('e1'), role: 'button', name: 'Edit label', nameNormalized: 'edit label', hierarchy: { parentRef: asRef('r1') } }),
    element({ ref: asRef('e2'), role: 'button', name: 'Edit label', nameNormalized: 'edit label' }),
  ]
  const click = (ref: string) => ({ type: 'click', ref }) as unknown as Action

  it('keeps the stated row only when the observed row holds it', () => {
    expect(toGroundedLocator(click('e1'), rows, { name: 'Edit label', row: ' 7 Elm Street ' }))
      .toEqual({ role: 'button', name: 'Edit label', row: '7 Elm Street' })
    expect(toGroundedLocator(click('e1'), rows, { name: 'Edit label', row: '1 Home Street' }))
      .toEqual({ role: 'button', name: 'Edit label' })
    expect(toGroundedLocator(click('e2'), rows, { name: 'Edit label', row: '7 Elm Street' }))
      .toEqual({ role: 'button', name: 'Edit label' })
    expect(toGroundedLocator(click('e1'), rows, { name: 'Edit label', row: ' , ' }))
      .toEqual({ role: 'button', name: 'Edit label' })
    expect(toGroundedLocator(click('e1'), rows)).toEqual({ role: 'button', name: 'Edit label' })
  })

  it('buildCachedPlanValue carries the decision\'s stated row per lane', () => {
    const value = buildCachedPlanValue({
      plannedActions: [click('e1')],
      elements: rows,
      completesStep: true,
      statedTargets: { ref: { role: 'button', name: 'Edit label', row: '7 Elm Street' } },
    })

    expect(value.groundedLocator).toEqual([{ role: 'button', name: 'Edit label', row: '7 Elm Street' }])
    expect(JSON.stringify(value.plannedActions)).not.toContain('Elm')
  })
})
