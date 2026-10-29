// C439-ENDINGS (439 D-08, D-09): a give-up, an infeasible declaration and both limit stops are
// judged once per condition over a settled final screen, and the step error names what is
// unproven after the original reason; the verdicts never turn an ending into a pass. Timeout and
// abort make no verifier call and record the requested outcome as unverified.

import { describe, expect, it } from 'vitest'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { metVerification } from '../../testing/condition-verdicts.js'
import { createTimeoutAbortReason } from '../abort.js'
import { executeStep } from '../index.js'
import type { LoopPorts } from '../ports.js'
import type {
  ActionPlan,
  ConditionJudgment,
  Planner,
  VerificationResult,
  Verifier,
} from '../types.js'
import { makeActionPlan, makeStepContext } from './loop-harness.js'

interface Observation {
  state: ScreenState
  afterDispatches: number
}

function trackingAdapter(executeDelayMs = 0): PlatformAdapter & {
  executed: Action[]
  observations: Observation[]
} {
  const executed: Action[] = []
  const observations: Observation[] = []
  return {
    executed,
    observations,
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe(): Promise<ScreenState> {
      const state = makeScreenState({
        tree: ['[Viewport: 390x844] [1 elements]', '- button "Save" [ref=e2]'].join('\n'),
      })
      observations.push({ state, afterDispatches: executed.length })
      return state
    },
    async execute(action: Action): Promise<ActionResult> {
      executed.push(action)
      if (executeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, executeDelayMs))
      return { success: true }
    },
  }
}

function scriptedPlanner(plans: ActionPlan[]): Planner & { calls: number } {
  const planner = {
    calls: 0,
    async plan() {
      const plan = plans[Math.min(planner.calls, plans.length - 1)]
      planner.calls++
      return { plan }
    },
  }
  return planner
}

interface VerifyCall {
  step: string
  after: ScreenState
  action: Action
}

function recordingVerifier(
  answer: (call: VerifyCall) => VerificationResult,
): Verifier & { calls: VerifyCall[] } {
  const calls: VerifyCall[] = []
  return {
    calls,
    async verify(step, _before, after, action) {
      const call = { step, after, action }
      calls.push(call)
      return { verification: answer(call) }
    },
  }
}

function condition(quote: string, overrides: Partial<ConditionJudgment>): ConditionJudgment {
  return {
    quote,
    verdict: 'unverified',
    needs: 'none',
    controlRef: '',
    file: { name: '', match: 'none', text: '' },
    citations: [],
    reasoning: '',
    ...overrides,
  }
}

function verdicts(...conditions: ConditionJudgment[]): VerificationResult {
  return { conditions, dialogs: [], isAppError: false, reasoning: 'Judged at the ending' }
}

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

const limits = (maxActions: number, maxPlanningTurns: number) => ({
  maxActions,
  maxPlanningTurns,
  previousStepCount: 0,
})

describe('how a step that ends without a pass is judged', () => {
  it('a give-up is judged once and names the unproven condition', async () => {
    const step = 'Save the draft'
    const adapter = trackingAdapter()
    const planner = scriptedPlanner([
      makeActionPlan({ reasoning: 'Clicking Save', stepComplete: false }),
      makeActionPlan({
        reasoning: 'The Save button does nothing',
        stepComplete: false,
        stepFailed: true,
      }),
    ])
    const verifier = recordingVerifier(() =>
      verdicts(condition(step, { verdict: 'unverified', reasoning: 'no confirmation shown' })),
    )
    const result = await executeStep(step, ports({ adapter, planner, verifier }), makeStepContext())
    expect(verifier.calls).toHaveLength(1)
    expect(verifier.calls[0].action).toEqual({ type: 'click', ref: 'e2' })
    expect(result.status).toBe('failed')
    expect(result.error).toBe(
      'Step failed: The Save button does nothing — Unverified: "Save the draft" (no confirmation shown)',
    )
    expect(result.evidence?.conditionVerdicts?.ending).toBe('give-up')
    expect(result.evidence?.conditionVerdicts?.conditions.map((c) => c.verdict)).toEqual([
      'unverified',
    ])
    expect(result.evidence?.verifierVerdict).toEqual({ pass: false, reasoning: result.error })
    expect(result.evidence?.verdictSource).toBeUndefined()
    expect(result.evidence?.limitUsage?.verifierCalls).toBe(1)
  })

  it('an "N/A" infeasible declaration still names its unmet condition', async () => {
    const step = 'Export the report'
    const adapter = trackingAdapter()
    const planner = scriptedPlanner([
      makeActionPlan({
        reasoning: 'Cannot export',
        stepComplete: false,
        stepFailed: true,
        failureKind: 'infeasible',
        failureReason: 'N/A',
      }),
    ])
    const verifier = recordingVerifier(() =>
      verdicts(condition(step, { verdict: 'not-met', reasoning: 'The Export button is disabled' })),
    )
    const result = await executeStep(step, ports({ adapter, planner, verifier }), makeStepContext())
    expect(verifier.calls).toHaveLength(1)
    expect(verifier.calls[0].action).toEqual({ type: 'delay', ms: 0 })
    expect(adapter.executed).toHaveLength(0)
    expect(result.status).toBe('failed')
    expect(result.error).toBe(
      'Step declared infeasible: N/A — Not met: "Export the report" (The Export button is disabled)',
    )
    expect(result.evidence?.termination).toEqual({ kind: 'infeasible', reason: 'N/A' })
    expect(result.evidence?.conditionVerdicts?.ending).toBe('infeasible')
    expect(result.evidence?.conditionVerdicts?.conditions[0]).toMatchObject({
      quote: 'Export the report',
      verdict: 'not-met',
      reason: 'The Export button is disabled',
    })
  })

  it('an ambiguity refusal keeps its candidates first', async () => {
    const step = 'Click Edit on the address'
    const refusal = 'Two "Edit" buttons match: row "Elm Street" and row "Oak Avenue"'
    const adapter = trackingAdapter()
    const planner = scriptedPlanner([
      makeActionPlan({
        reasoning: 'Ambiguous',
        stepComplete: false,
        stepFailed: true,
        failureKind: 'infeasible',
        failureReason: refusal,
      }),
    ])
    const verifier = recordingVerifier(() =>
      verdicts(condition(step, { verdict: 'unverified', reasoning: 'no Edit was clicked' })),
    )
    const result = await executeStep(step, ports({ adapter, planner, verifier }), makeStepContext())
    expect(result.status).toBe('failed')
    expect(result.error?.startsWith(`Step declared infeasible: ${refusal} — `)).toBe(true)
    expect(result.error).toContain('Unverified: "Click Edit on the address" (no Edit was clicked)')
    expect(result.evidence?.termination).toEqual({ kind: 'infeasible', reason: refusal })
  })

  it('an action-limit stop observes, then is judged', async () => {
    const step = 'Press the dead button until something happens'
    const adapter = trackingAdapter()
    const planner = scriptedPlanner([makeActionPlan({ reasoning: 'Pressing', stepComplete: false })])
    const verifier = recordingVerifier(() =>
      verdicts(condition(step, { verdict: 'unverified', reasoning: 'nothing changed on screen' })),
    )
    const result = await executeStep(
      step,
      ports({ adapter, planner, verifier, plannerConfig: limits(2, 10) }),
      makeStepContext(),
    )
    const reason = 'Stopped: action limit reached — 2 of 2 actions used'
    expect(adapter.executed).toHaveLength(2)
    expect(verifier.calls).toHaveLength(1)
    const afterLast = adapter.observations.filter((o) => o.afterDispatches === 2)
    // One settle after the last dispatch: two matching observations, the latest is judged.
    expect(afterLast).toHaveLength(2)
    expect(verifier.calls[0].after).toBe(afterLast[afterLast.length - 1].state)
    expect(result.status).toBe('failed')
    expect(result.error).toBe(
      `${reason} — Unverified: "${step}" (nothing changed on screen)`,
    )
    expect(result.evidence?.limitStop).toMatchObject({
      limit: 'actions',
      reason,
      requestedOutcome: 'unverified',
    })
    expect(result.evidence?.conditionVerdicts?.ending).toBe('limit-stop')
    expect(result.evidence?.limitUsage).toMatchObject({ actionsUsed: 2, verifierCalls: 1 })
    expect(result.evidence?.verdictSource).toBeUndefined()
  })

  it('a planning-turn limit stop is judged', async () => {
    const step = 'Find the hidden setting'
    const adapter = trackingAdapter()
    const planner = scriptedPlanner([makeActionPlan({ reasoning: 'Looking', stepComplete: false })])
    const verifier = recordingVerifier(() =>
      verdicts(condition(step, { verdict: 'unverified', reasoning: 'the setting was not found' })),
    )
    const result = await executeStep(
      step,
      ports({ adapter, planner, verifier, plannerConfig: limits(10, 1) }),
      makeStepContext(),
    )
    expect(planner.calls).toBe(1)
    expect(verifier.calls).toHaveLength(1)
    expect(result.status).toBe('failed')
    expect(result.evidence?.limitStop?.limit).toBe('planning-turns')
    expect(result.evidence?.conditionVerdicts?.ending).toBe('limit-stop')
    expect(result.error).toContain(' — Unverified: "Find the hidden setting" (the setting was not found)')
    expect(result.evidence?.limitUsage).toMatchObject({ planningCallsUsed: 1, verifierCalls: 1 })
  })

  it('a give-up whose conditions are all met still fails', async () => {
    const step = 'Open the settings'
    const adapter = trackingAdapter()
    const planner = scriptedPlanner([
      makeActionPlan({
        reasoning: 'I cannot find a settings entry',
        stepComplete: false,
        stepFailed: true,
      }),
    ])
    const verifier = recordingVerifier((call) => metVerification({ step: call.step, after: call.after }))
    const result = await executeStep(step, ports({ adapter, planner, verifier }), makeStepContext())
    expect(verifier.calls).toHaveLength(1)
    expect(result.status).toBe('failed')
    expect(result.error).toBe('Step failed: I cannot find a settings entry')
    expect(result.evidence?.conditionVerdicts?.ending).toBe('give-up')
    expect(result.evidence?.conditionVerdicts?.conditions.map((c) => c.verdict)).toEqual(['met'])
    expect(result.evidence?.verifierVerdict?.pass).toBe(false)
  })

  it('timeout and abort make no verifier call', async () => {
    const step = 'Wait for the report'
    const verifier = recordingVerifier(() => verdicts(condition(step, { verdict: 'met' })))

    const slow = trackingAdapter(30)
    const timedOut = await executeStep(
      step,
      ports({
        adapter: slow,
        planner: scriptedPlanner([makeActionPlan({ stepComplete: false })]),
        verifier,
        stepTimeout: 5,
      }),
      makeStepContext(),
    )
    expect(timedOut.status).toBe('failed')
    expect(timedOut.error).toBe('Step timed out after 5ms')
    expect(timedOut.evidence?.conditionVerdicts).toEqual({
      ending: 'timeout',
      conditions: [
        { quote: step, verdict: 'unverified', reason: 'Step timed out after 5ms', citations: [] },
      ],
    })

    const timeoutReason = createTimeoutAbortReason('step', 250)
    const timeoutController = new AbortController()
    timeoutController.abort(timeoutReason)
    const abortedByTimeout = await executeStep(
      step,
      ports({
        adapter: trackingAdapter(),
        planner: scriptedPlanner([makeActionPlan()]),
        verifier,
        abortSignal: timeoutController.signal,
      }),
      makeStepContext(),
    )
    expect(abortedByTimeout.status).toBe('failed')
    expect(abortedByTimeout.evidence?.conditionVerdicts).toEqual({
      ending: 'timeout',
      conditions: [
        { quote: step, verdict: 'unverified', reason: timeoutReason.message, citations: [] },
      ],
    })

    const controller = new AbortController()
    controller.abort()
    const cancelled = await executeStep(
      step,
      ports({
        adapter: trackingAdapter(),
        planner: scriptedPlanner([makeActionPlan()]),
        verifier,
        abortSignal: controller.signal,
      }),
      makeStepContext(),
    )
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.evidence?.conditionVerdicts).toEqual({
      ending: 'cancelled',
      conditions: [
        { quote: step, verdict: 'unverified', reason: cancelled.error, citations: [] },
      ],
    })

    expect(verifier.calls).toHaveLength(0)
  })
})
