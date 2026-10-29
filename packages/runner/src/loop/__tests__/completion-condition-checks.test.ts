// through the real loop, a completion whose conditions leave
// part of the step uncovered, reword it, or whose reasoning admits the action did not happen is
// not a pass, and the planner's next turn is told why.

import { describe, expect, it } from 'vitest'
import type { ConditionRecord, ScreenState } from '@vostride/agent-qa-schema'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { executeStep } from '../index.js'
import type { LoopPorts } from '../ports.js'
import type { ActionPlan, ConditionJudgment, Planner, VerificationResult } from '../types.js'
import { makeActionPlan, makeStepContext, makeVerifier } from './loop-harness.js'

const BEFORE = makeScreenState({
  tree: ['[Viewport: 390x844] [1 elements]', '- button "Add to cart" [ref=e2]'].join('\n'),
})
const AFTER = makeScreenState({
  tree: [
    '[Viewport: 390x844] [3 elements]',
    '- button "Add to cart" [ref=e2]',
    '- text "Blue mug added" [ref=e3]',
    '- text "Cart: 2 items" [ref=e4]',
  ].join('\n'),
})

function adapter(): PlatformAdapter {
  let observed = 0
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe(): Promise<ScreenState> {
      observed++
      return observed === 1 ? BEFORE : AFTER
    },
    async execute(_action: Action): Promise<ActionResult> {
      return { success: true }
    },
  }
}

function capturingPlanner(plans: ActionPlan[], contexts: (string | undefined)[]): Planner {
  let call = 0
  return {
    async plan(_step, _screen, context) {
      contexts.push(context.failureContext)
      const plan = plans[Math.min(call, plans.length - 1)]
      call++
      return { plan }
    },
  }
}

function condition(
  quote: string,
  overrides: Partial<ConditionJudgment> = {},
): ConditionJudgment {
  return {
    quote,
    verdict: 'met',
    needs: 'none',
    controlRef: '',
    file: { name: '', match: 'none', text: '' },
    citations: [{ source: 'final-screen', quote: 'Cart: 2 items' }],
    reasoning: 'The final screen shows it',
    ...overrides,
  }
}

function verification(conditions: ConditionJudgment[]): VerificationResult {
  return { conditions, dialogs: [], isAppError: false, reasoning: 'Looks done' }
}

async function run(step: string, verdict: VerificationResult, completionReasoning?: string) {
  const contexts: (string | undefined)[] = []
  const plans = [
    makeActionPlan({
      action: { type: 'click', ref: 'e2' },
      stepComplete: true,
      ...(completionReasoning !== undefined ? { reasoning: completionReasoning } : {}),
    }),
    makeActionPlan({
      reasoning: 'Giving up',
      action: { type: 'stepFailed' },
      stepComplete: false,
      stepFailed: true,
      failureReason: 'The step could not be completed',
    }),
  ]
  const ports: LoopPorts = {
    adapter: adapter(),
    planner: capturingPlanner(plans, contexts),
    verifier: makeVerifier([verdict]),
    plannerConfig: { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 },
  }
  const result = await executeStep(step, ports, makeStepContext({ stepInstruction: step }))
  const conditions: ConditionRecord[] = result.evidence?.conditionVerdicts?.conditions ?? []
  return { result, contexts, conditions }
}

describe('a step passes only when every requested condition is checked', () => {
  it('a two-part step judged on one part does not pass', async () => {
    const step = 'Add the blue mug to the cart and verify the cart shows 2 items'
    const { result, contexts, conditions } = await run(
      step,
      verification([
        condition('Add the blue mug to the cart', {
          citations: [{ source: 'final-screen', quote: 'Blue mug added' }],
        }),
      ]),
    )

    expect(result.status).not.toBe('passed')
    expect(conditions).toHaveLength(2)
    expect(conditions[0]).toMatchObject({ quote: 'Add the blue mug to the cart', verdict: 'met' })
    expect(conditions[1]).toMatchObject({ verdict: 'unverified', guard: 'not-covered' })
    expect(conditions[1].quote).toContain('cart shows 2 items')
    const replan = contexts[1] ?? ''
    expect(replan).toContain('Unverified:')
    expect(replan).toContain('2 items')
  })

  it('a condition reworded away from the step is not a pass', async () => {
    const { result, conditions } = await run(
      'Verify the cart shows 2 items',
      verification([condition('the cart has items')]),
    )

    expect(result.status).not.toBe('passed')
    expect(conditions[0]).toMatchObject({
      quote: 'the cart has items',
      verdict: 'unverified',
      judged: 'met',
      guard: 'quote-not-in-step',
    })
  })

  it('a planner that admits the form was not submitted cannot pass', async () => {
    const { result, contexts, conditions } = await run(
      'Submit the contact form',
      verification([condition('Submit the contact form')]),
      'Filled the fields; the form has not yet been submitted',
    )

    expect(result.status).not.toBe('passed')
    // The completion's refusal reaches the planner; the give-up's own judgment reads
    // no planner reasoning, so its block keeps the verifier's met verdict and the step still fails.
    expect(contexts[1]).toContain(
      'Not met: "Submit the contact form" (The reasoning says "has not yet been submitted")',
    )
    expect(result.evidence?.conditionVerdicts?.ending).toBe('give-up')
    expect(conditions[0]).toMatchObject({ quote: 'Submit the contact form', verdict: 'met' })
  })

  it("the verifier's own admission refuses its met verdict", async () => {
    const { result, conditions } = await run(
      'Click Save',
      verification([condition('Click Save', { reasoning: 'Clicked Save but nothing happened' })]),
    )

    expect(result.status).not.toBe('passed')
    expect(conditions[0]).toMatchObject({
      verdict: 'not-met',
      judged: 'met',
      guard: 'admits-not-done',
    })
    expect(conditions[0].reason).toContain('nothing happened')
  })
})
