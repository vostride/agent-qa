import { describe, expect, it } from 'vitest'

import { asRef } from '@vostride/agent-qa-schema'
import type { ElementInfo, Ref } from '@vostride/agent-qa-schema'

import { GroundingError } from '../../tools/errors.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import {
  assembleLadder,
  groundActionPlan,
  matchDescriptor,
  runLadder,
} from '../index.js'
import type { GateResult, GroundingRung, RungRequest } from '../index.js'

// A fake visual rung injected via options proves the capability-negotiation seam.
function fakeVisualRung(resolved: string): GroundingRung {
  return {
    stage: 'visual',
    run(): { kind: 'resolved'; ref: Ref } {
      return { kind: 'resolved', ref: resolved as unknown as Ref }
    },
  }
}

// A minimal ElementInfo with an optional parent link for hierarchy disambiguation.
function element(
  ref: string,
  role: string,
  nameNormalized: string,
  parentRef?: string,
): ElementInfo {
  return {
    ref: asRef(ref),
    role,
    name: nameNormalized,
    nameNormalized,
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
    ...(parentRef !== undefined ? { hierarchy: { parentRef: asRef(parentRef) } } : {}),
  }
}

function expectFailure(result: GateResult, code: string): GroundingError {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a gate failure')
  expect(result.error).toBeInstanceOf(GroundingError)
  expect(result.error.code).toBe(code)
  return result.error
}

describe('GROUND roll-call — one green proof per acceptance criterion', () => {
  it('a descriptor-bearing emission action grounds to an execution-shape action (ref set, target gone) with no second model', () => {
    // A planner emits a natural-language descriptor instead of a raw ref. The default
    // single-model ref-first strategy resolves it against the persisted elements/refMap —
    // groundActionPlan is a pure synchronous function: no second model is consulted.
    const result = groundActionPlan({
      toolName: 'web_click',
      action: { type: 'click', target: { role: 'button', name: 'Log in' } },
      screenState: makeScreenState(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    // Fully grounded, execution-shape: a ref is committed and the descriptor is gone.
    expect((result.action as { ref?: string }).ref).toBe('e2')
    expect((result.action as { target?: unknown }).target).toBeUndefined()
    // The descriptor lane strips the committed-ref rung — a single tree-search resolution,
    // no model call, proving the L9 BYOM floor (no second model required).
    expect(result.attempts).toEqual([{ stage: 'tree-search', outcome: 'resolved', resolvedRef: 'e2' }])
  })

  it('the ladder is auditable ref → tree-search → visual:skipped and the visual rung is capability-gated', () => {
    // Default assembly is [ref, tree-search], with no visual rung.
    const defaultLadder = assembleLadder()
    expect(defaultLadder.map((rung) => rung.stage)).toEqual(['ref', 'tree-search'])

    // A supplied visual rung is appended ONLY under vision:true (capability negotiation).
    expect(assembleLadder({ vision: false, extraRungs: [fakeVisualRung('e2')] })).toHaveLength(2)
    expect(assembleLadder({ vision: true, extraRungs: [fakeVisualRung('e2')] })).toHaveLength(3)

    // One attempt per attempted rung, plus `visual:skipped` when no visual rung ran.
    const request: RungRequest = {
      descriptor: { role: 'button', name: 'nonexistent widget' },
      elements: makeScreenState().elements,
      refMap: makeScreenState().refMap as Record<Ref, unknown>,
    }
    const outcome = runLadder(defaultLadder, request)
    expect(outcome.resolvedRef).toBeUndefined()
    expect(outcome.attempts).toEqual([
      { stage: 'ref', outcome: 'no-match' },
      { stage: 'tree-search', outcome: 'no-match' },
      { stage: 'visual', outcome: 'skipped' },
    ])
  })

  it('an ungroundable descriptor yields the §12.17 self-correcting error, and ref_not_in_snapshot / coords_out_of_bounds surface on the live gate path', () => {
    const screenState = makeScreenState()

    // §12.17 self-correcting form: no silent best-guess — a structured re-observe/refine error.
    const unresolved = groundActionPlan({
      toolName: 'web_click',
      action: { type: 'click', target: { role: 'button', name: 'nonexistent widget' } },
      screenState,
    })
    const unresolvedError = expectFailure(unresolved, 'descriptor_unresolved')
    expect(unresolvedError.message).toContain('no element matching')
    expect(unresolvedError.message).toContain('re-observe or refine')

    // ref_not_in_snapshot is actually raised on the live path for a stale committed ref.
    const stale = groundActionPlan({
      toolName: 'web_click',
      action: { type: 'click', ref: 'e99' },
      screenState,
    })
    const staleError = expectFailure(stale, 'ref_not_in_snapshot')
    expect(staleError.message).toContain('e99')

    // coords_out_of_bounds is actually raised for a viewport coord beyond the captured bound.
    const oob = groundActionPlan({
      toolName: 'mobile_tapCoordinate',
      action: { type: 'tapCoordinate', x: 1200, y: 900, coordSpace: 'viewport' },
      screenState,
    })
    expectFailure(oob, 'coords_out_of_bounds')
  })

  it('re-grounding uses nameNormalized + hierarchy — the prior ancestor chain disambiguates a name-collision', () => {
    // The re-ground decision the self-heal runs; the loop leg is covered in reground-heal.test.ts.
    const priorContainer = element('cA', 'group', 'item a')
    const priorTarget = element('e1', 'button', 'delete', 'cA')
    const priorElements = [priorContainer, priorTarget]

    // Fresh observation: two identical "Delete" buttons under different containers — an
    // ambiguity a name-only match cannot break.
    const freshA = [element('g1', 'group', 'item a'), element('d1', 'button', 'delete', 'g1')]
    const freshB = [element('g2', 'group', 'item b'), element('d2', 'button', 'delete', 'g2')]
    const fresh = [...freshA, ...freshB]

    // No prior context: the matcher refuses to guess.
    const ambiguous = matchDescriptor({ descriptor: { role: 'button', name: 'Delete' }, elements: fresh })
    expect(ambiguous.kind).toBe('ambiguous')

    // With the prior element's ancestor chain, hierarchy disambiguation resolves to the
    // button under the matching container.
    const healed = matchDescriptor({
      descriptor: { role: 'button', name: 'Delete' },
      elements: fresh,
      prior: { target: priorTarget, elements: priorElements },
    })
    expect(healed.kind).toBe('resolved')
    if (healed.kind !== 'resolved') throw new Error('expected a resolved re-ground')
    expect(healed.ref).toBe('d1')
  })
})
