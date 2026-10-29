import { describe, expect, it } from 'vitest'

import { asRef } from '@vostride/agent-qa-schema'
import type { ElementInfo, Ref, ScreenState } from '@vostride/agent-qa-schema'

import { GroundingError } from '../../tools/errors.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { groundActionPlan } from '../gate.js'
import type { GateResult, GroundActionPlanInput } from '../gate.js'

// A fake visual rung injected via options proves the capability-negotiation seam.
function fakeVisualRung(resolved: string) {
  return {
    stage: 'visual' as const,
    match() {
      return { kind: 'resolved' as const, ref: resolved as unknown as Ref }
    },
  }
}

async function gate(input: GroundActionPlanInput): Promise<GateResult> {
  return groundActionPlan(input)
}

function contentState(): ScreenState {
  // A tall/wide scrollable page so 'content' coords have room the viewport does not.
  return makeScreenState({
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 390,
      viewportHeight: 844,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 2000, contentHeight: 5000 },
    },
  })
}

function expectError(result: GateResult, code: string): GroundingError {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a gate failure')
  expect(result.error).toBeInstanceOf(GroundingError)
  expect(result.error.code).toBe(code)
  return result.error
}

describe('groundActionPlan — ref/target precedence', () => {
  it('prefers the committed ref when an action carries BOTH ref and target (target dropped)', async () => {
    const result = await gate({
      toolName: 'web_click',
      action: { type: 'click', ref: 'e2', target: { role: 'button', name: 'Log in' } } as never,
      screenState: makeScreenState(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.action.ref).toBe('e2')
    expect(result.action.target).toBeUndefined()
    expect(result.attempts).toEqual([{ stage: 'ref', outcome: 'resolved', resolvedRef: 'e2' }])
  })

  it('falls back to the target descriptor when BOTH are present but the ref is stale', async () => {
    const result = await gate({
      toolName: 'web_click',
      action: { type: 'click', ref: 'e999', target: { role: 'button', name: 'Log in' } } as never,
      screenState: makeScreenState(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.action.ref).toBe('e2')
    expect(result.action.target).toBeUndefined()
  })

  it('rejects a ref-requiring tool carrying NEITHER ref nor target with descriptor_invalid', async () => {
    const result = await gate({
      toolName: 'web_click',
      action: { type: 'click' } as never,
      screenState: makeScreenState(),
    })

    expectError(result, 'descriptor_invalid')
  })
})

describe('groundActionPlan — committed-ref validation', () => {
  it('raises ref_not_in_snapshot when the committed ref is absent from the fresh refMap', async () => {
    const result = await gate({
      toolName: 'web_click',
      action: { type: 'click', ref: 'e99' } as never,
      screenState: makeScreenState(),
    })

    const error = expectError(result, 'ref_not_in_snapshot')
    expect(error.message).toContain('e99')
    expect(error.hint.toLowerCase()).toContain('re-observe')
  })

  it('records a resolved ref attempt on the committed-ref happy path', async () => {
    const result = await gate({
      toolName: 'web_click',
      action: { type: 'click', ref: 'e2' } as never,
      screenState: makeScreenState(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.attempts).toEqual([{ stage: 'ref', outcome: 'resolved', resolvedRef: 'e2' }])
  })
})

describe('groundActionPlan — coordSpace-aware bounds', () => {
  it('raises coords_out_of_bounds for viewport coords beyond metadata.viewportWidth/Height', async () => {
    const result = await gate({
      toolName: 'mobile_tapCoordinate',
      action: { type: 'tapCoordinate', x: 1200, y: 900, coordSpace: 'viewport' } as never,
      screenState: makeScreenState(),
    })

    expectError(result, 'coords_out_of_bounds')
  })

  it('checks content coords against metadata.scroll.contentWidth/Height', async () => {
    const beyond = await gate({
      toolName: 'mobile_tapCoordinate',
      action: { type: 'tapCoordinate', x: 2500, y: 100, coordSpace: 'content' } as never,
      screenState: contentState(),
    })
    expectError(beyond, 'coords_out_of_bounds')

    const within = await gate({
      toolName: 'mobile_tapCoordinate',
      action: { type: 'tapCoordinate', x: 1500, y: 100, coordSpace: 'content' } as never,
      screenState: contentState(),
    })
    expect(within.ok).toBe(true)
  })

  it('does not bounds-check screen-space coords (passes through)', async () => {
    const result = await gate({
      toolName: 'mobile_tapCoordinate',
      action: { type: 'tapCoordinate', x: 99999, y: 99999, coordSpace: 'screen' } as never,
      screenState: makeScreenState(),
    })

    expect(result.ok).toBe(true)
  })
})

describe('groundActionPlan — target descriptor ladder', () => {
  it('resolves a target through the ladder and returns a fully-grounded, target-free action', async () => {
    const result = await gate({
      toolName: 'web_click',
      action: { type: 'click', target: { role: 'button', name: 'Log in' } } as never,
      screenState: makeScreenState(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect((result.action as { ref?: string }).ref).toBe('e2')
    expect((result.action as { target?: unknown }).target).toBeUndefined()
    expect(result.attempts).toEqual([{ stage: 'tree-search', outcome: 'resolved', resolvedRef: 'e2' }])
  })

  it('appends a visual:skipped attempt and raises descriptor_unresolved when ref+tree-search exhaust', async () => {
    const result = await gate({
      toolName: 'web_click',
      action: { type: 'click', target: { role: 'button', name: 'nonexistent widget' } } as never,
      screenState: makeScreenState(),
    })

    const error = expectError(result, 'descriptor_unresolved')
    expect(error.message).toContain('no element matching')
    expect(error.message).toContain('re-observe or refine')
    if (result.ok) throw new Error('expected failure')
    expect(result.attempts[result.attempts.length - 1]).toEqual({ stage: 'visual', outcome: 'skipped' })
    expect(result.attempts).toContainEqual({ stage: 'tree-search', outcome: 'no-match' })
  })

  it('runs an injected visual rung only under vision:true capability negotiation', async () => {
    const target = { type: 'click', target: { role: 'button', name: 'nonexistent widget' } } as never

    // vision:true — the fake visual rung is registered AND enabled, so it runs and resolves.
    const enabled = await gate({
      toolName: 'web_click',
      action: target,
      screenState: makeScreenState(),
      options: { visualRung: fakeVisualRung('e2'), vision: true },
    })
    expect(enabled.ok).toBe(true)
    if (!enabled.ok) throw new Error('expected success')
    expect(enabled.attempts).toContainEqual({ stage: 'visual', outcome: 'resolved', resolvedRef: 'e2' })

    // vision:false — the same rung is present but capability-gated off, so it never runs;
    // the trail records visual:skipped and the descriptor stays unresolved.
    const disabled = await gate({
      toolName: 'web_click',
      action: target,
      screenState: makeScreenState(),
      options: { visualRung: fakeVisualRung('e2'), vision: false },
    })
    expectError(disabled, 'descriptor_unresolved')
    if (disabled.ok) throw new Error('expected failure')
    expect(disabled.attempts).toContainEqual({ stage: 'visual', outcome: 'skipped' })
  })
})

describe('groundActionPlan — an ambiguous target never picks', () => {
  function el(ref: string, role: string, name: string, parentRef?: string): ElementInfo {
    return {
      ref: asRef(ref),
      role,
      name,
      nameNormalized: name.toLowerCase(),
      state: { enabled: true, focused: false, visible: true },
      labels: {},
      attributes: {},
      ...(parentRef !== undefined ? { hierarchy: { parentRef: asRef(parentRef) } } : {}),
    }
  }

  function twoAddScreen(): ScreenState {
    const elements = [
      el('e20', 'list', 'Cart'),
      el('e21', 'list', 'Wishlist'),
      el('e10', 'button', 'Add', 'e20'),
      el('e11', 'button', 'Add', 'e21'),
    ]
    const box = { bounds: { x: 0, y: 0, width: 10, height: 10 }, center: { x: 5, y: 5 } }
    return makeScreenState({
      elements,
      refMap: Object.fromEntries(elements.map((element) => [element.ref, box])),
    })
  }

  it('a target-only Add on two Add buttons fails descriptor_ambiguous naming 2 candidates', () => {
    const result = groundActionPlan({
      toolName: 'web_click',
      action: { type: 'click', target: { role: 'button', name: 'Add' } } as never,
      screenState: twoAddScreen(),
    })

    const error = expectError(result, 'descriptor_ambiguous')
    expect(error.message).toContain('2 elements match button "Add"')
  })

  it('a target-only Add carrying a stray position still fails descriptor_ambiguous', () => {
    const result = groundActionPlan({
      toolName: 'web_click',
      action: { type: 'click', target: { role: 'button', name: 'Add', ordinal: 0 } } as never,
      screenState: twoAddScreen(),
    })

    const error = expectError(result, 'descriptor_ambiguous')
    expect(error.message).toContain('2 elements match button "Add"')
  })

  it('the prior hierarchy still resolves one Add through the gate', () => {
    const priorTarget = el('e5', 'button', 'Add', 'e2')
    const result = groundActionPlan({
      toolName: 'web_click',
      action: { type: 'click', target: { role: 'button', name: 'Add', ordinal: 1 } } as never,
      screenState: twoAddScreen(),
      options: { prior: priorTarget, priorElements: [el('e2', 'list', 'Cart'), priorTarget] },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.action.ref).toBe('e10')
  })
})
