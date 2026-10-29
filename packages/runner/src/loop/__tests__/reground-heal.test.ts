// RED scaffold (Wave 0, LOOP-04 · D-10/D-11 · Pitfall 7). Pins the re-ground-first
// self-heal: a ref-resolution failure ('Unknown ref "…"') triggers re-observe → re-find the
// prior observation's element by its role, exact name and row words (strictMatch, 438 D-08:
// unique or nothing, no ordinal and no hierarchy tiebreak) → patch the ref → re-execute, WITH
// NO new planning turn (planner.plan called exactly once). The heal is recorded in the
// sub-action grounding trail only; StepEvidence.selfHeal stays reserved for replan heals
// Non-ref failures (a bare timeout) keep the replan-with-failure-context path (the
// conservative classifier), and only one heal is attempted per planned action.
//
// Under the shipped loop a ref failure just replans (planner called twice) and never
// records a grounding trail — the intended RED (GREEN when Plan 07 lands the heal).
import { describe, it, expect, vi } from 'vitest'
import type { LoopPorts } from '../ports.js'
import type { Planner } from '../types.js'
import { executeStep } from '../index.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { makeActionPlan, makeAdapter, makeStepContext, makeVerifier } from './loop-harness.js'

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

const UNKNOWN_REF_ERROR = 'Unknown ref "e2". Available refs: e1'
const TIMEOUT_ERROR = 'Timeout 30000ms exceeded waiting for locator'

const threeScreens = () => [makeScreenState(), makeScreenState(), makeScreenState()]

describe('re-ground-first self-heal', () => {
  it('heals a ref-resolution failure by re-grounding and re-executing WITHOUT a new planning turn', async () => {
    const adapter = makeAdapter({
      observeResults: threeScreens(),
      executeResults: [{ success: false, error: UNKNOWN_REF_ERROR }, { success: true }],
    })
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan({ action: { type: 'click', ref: 'e2' } }) })

    const result = await executeStep(
      'Click Log in',
      ports({ adapter, planner: { plan: plannerSpy } as unknown as Planner, verifier: makeVerifier() }),
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    expect(plannerSpy).toHaveBeenCalledTimes(1) // re-ground heal — no replan turn
  })

  it('records the heal in the grounding trail only — StepEvidence.selfHeal stays unpopulated', async () => {
    const adapter = makeAdapter({
      observeResults: threeScreens(),
      executeResults: [{ success: false, error: UNKNOWN_REF_ERROR }, { success: true }],
    })
    const planner: Planner = { plan: vi.fn().mockResolvedValue({ plan: makeActionPlan({ action: { type: 'click', ref: 'e2' } }) }) }

    const result = await executeStep('Click Log in', ports({ adapter, planner, verifier: makeVerifier() }), makeStepContext())

    expect(result.status).toBe('passed')
    expect(result.evidence?.selfHeal).toBeUndefined()
    const healed = result.evidence?.subActions?.find(
      (s) => (s as { grounding?: unknown }).grounding !== undefined,
    ) as {
      grounding?: {
        descriptor: Record<string, unknown>
        attempts: Array<{ stage: string; outcome: string }>
      }
    } | undefined
    expect(healed?.grounding).toBeDefined()
    expect(healed?.grounding?.attempts.some((a) => a.stage === 'tree-search' && a.outcome === 'resolved')).toBe(true)
    // the strict heal names the exact observed identity and never a position.
    expect(healed?.grounding?.descriptor).toEqual({ role: 'button', name: 'Log in' })
  })

  it('does NOT heal a non-ref execution failure (bare timeout) — it takes the replan path', async () => {
    const adapter = makeAdapter({
      observeResults: [makeScreenState(), makeScreenState(), makeScreenState(), makeScreenState()],
      executeResults: [{ success: false, error: TIMEOUT_ERROR }, { success: true }],
    })
    const plannerSpy = vi.fn()
      .mockResolvedValueOnce({ plan: makeActionPlan({ action: { type: 'click', ref: 'e2' } }) })
      .mockResolvedValueOnce({ plan: makeActionPlan({ action: { type: 'click', ref: 'e1' } }) })

    const result = await executeStep(
      'Click Log in',
      ports({ adapter, planner: { plan: plannerSpy }, verifier: makeVerifier() }),
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    expect(plannerSpy).toHaveBeenCalledTimes(2) // timeout is not a ref failure — replan, no heal
  })

  it('attempts only ONE heal per planned action, then falls through to the failure-context path', async () => {
    const adapter = makeAdapter({
      observeResults: [makeScreenState(), makeScreenState(), makeScreenState(), makeScreenState()],
      executeResults: [
        { success: false, error: UNKNOWN_REF_ERROR }, // first failure → heal
        { success: false, error: UNKNOWN_REF_ERROR }, // heal re-execute still fails → replan
        { success: true }, // replanned action succeeds
      ],
    })
    const plannerSpy = vi.fn()
      .mockResolvedValueOnce({ plan: makeActionPlan({ action: { type: 'click', ref: 'e2' } }) })
      .mockResolvedValueOnce({ plan: makeActionPlan({ action: { type: 'click', ref: 'e1' } }) })

    const result = await executeStep(
      'Click Log in',
      ports({ adapter, planner: { plan: plannerSpy }, verifier: makeVerifier() }),
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    // one heal recorded on the first action, then a single replan (no unbounded heal loop).
    expect(plannerSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    const withGrounding = result.evidence?.subActions?.filter(
      (s) => (s as { grounding?: unknown }).grounding !== undefined,
    )
    expect(withGrounding && withGrounding.length).toBeGreaterThan(0)
  })
})
