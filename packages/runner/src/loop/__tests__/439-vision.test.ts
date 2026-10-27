// C439-VISION (439 D-19, SC3): through the real loop, a condition only a picture can settle is
// inconclusive when the verifier was given no image, whatever the model said, and the step cannot
// pass; with an image attached the same condition passes, and a non-visual condition is unaffected.
import { describe, expect, it } from 'vitest'
import type { CitationSource } from '@vostride/agent-qa-schema'
import { executeStep } from '../index.js'
import type { LoopPorts } from '../ports.js'
import { judgeConditions } from '../requested-conditions.js'
import type { ActionPlan, ConditionJudgment, PlanResult, Planner, VerificationResult, Verifier } from '../types.js'
import { makeActionPlan, makeAdapter, makeStepContext } from './loop-harness.js'

const STEP = 'Check the banner is green'
const QUOTE = 'the banner is green'
const TEXT_ONLY = { attachImage: false, captureMode: 'textOnly' as const, promptNote: 'text only' }
const LIMITS = { maxActions: 10, maxPlanningTurns: 10, previousStepCount: 0 }

function condition(
  citations: { source: CitationSource; quote: string }[],
  needs: ConditionJudgment['needs'],
): ConditionJudgment {
  return {
    quote: QUOTE,
    verdict: 'met',
    needs,
    controlRef: '',
    file: { name: '', match: 'none', text: '' },
    citations,
    reasoning: 'The banner is green',
  }
}

function verification(conditions: ConditionJudgment[]): VerificationResult {
  return { conditions, dialogs: [], isAppError: false, reasoning: 'overall' }
}

function verifier(result: VerificationResult): Verifier {
  return {
    async verify() {
      return { verification: result }
    },
    async judgeClaim() {
      return { outcome: 'judged', verdict: true, rationale: 'The banner looks green' }
    },
  }
}

/** Plans in order; the turn after the last gives up, keeping each turn's failure context. */
function planner(plans: ActionPlan[], seen: (string | undefined)[]): Planner {
  let call = 0
  return {
    async plan(_step, _screen, context): Promise<PlanResult> {
      seen.push(context.failureContext)
      const plan = plans[call] ?? makeActionPlan({
        action: { type: 'delay', ms: 0 },
        stepComplete: false,
        stepFailed: true,
        reasoning: 'The banner colour could not be proven',
      })
      call++
      return { plan }
    },
  }
}

const clickLogIn = makeActionPlan({ action: { type: 'click', ref: 'e2' }, reasoning: 'Look at the banner' })
const visualClaim = makeActionPlan({
  action: { type: 'assertAI', claim: 'the banner is green', mode: 'visual' },
  reasoning: 'Judge the banner colour',
})

async function run(options: {
  result: VerificationResult
  plans: ActionPlan[]
  visionGate?: LoopPorts['visionGate']
  screenshot?: boolean
}) {
  const seen: (string | undefined)[] = []
  const ports: LoopPorts = {
    adapter: makeAdapter(options.screenshot ? { screenshot: async () => Buffer.from('png') } : {}),
    planner: planner(options.plans, seen),
    verifier: verifier(options.result),
    plannerConfig: LIMITS,
    ...(options.visionGate ? { visionGate: options.visionGate } : {}),
  }
  const result = await executeStep(STEP, ports, makeStepContext({ stepInstruction: STEP }))
  return { result, seen }
}

const finalScreenCitation = [{ source: 'final-screen' as const, quote: 'button "Log in"' }]

describe('C439-VISION', () => {
  it('a visual condition under a text-only gate is inconclusive', async () => {
    const result = verification([condition(finalScreenCitation, 'visual')])
    const { result: step, seen } = await run({ result, plans: [clickLogIn], visionGate: TEXT_ONLY })

    expect(step.status).toBe('failed')
    expect(step.evidence!.conditionVerdicts!.conditions[0]).toMatchObject({
      quote: QUOTE,
      verdict: 'inconclusive',
      judged: 'met',
      guard: 'visual-text-only',
      needs: 'visual',
    })
    expect(seen[1]).toContain('Inconclusive: "the banner is green"')

    const judged = judgeConditions({
      stepText: STEP,
      output: result,
      sources: { 'start-screen': '', 'final-screen': 'button "Log in"', action: '', read: '', carried: '' },
      mask: (value) => value,
      imageAttached: false,
      ending: 'completion',
    })
    expect(judged.pass).toBe(false)
    expect(judged.reason.startsWith('Inconclusive:')).toBe(true)
  })

  it('the same condition passes with an image', async () => {
    const result = verification([condition(finalScreenCitation, 'visual')])
    const { result: step } = await run({ result, plans: [clickLogIn], screenshot: true })

    expect(step.status).toBe('passed')
    expect(step.evidence!.conditionVerdicts!.conditions[0]).toMatchObject({ verdict: 'met', needs: 'visual' })
  })

  it('an assertAI visual judgment is not evidence without an image', async () => {
    const result = verification([
      condition([{ source: 'read', quote: '"the banner is green" (visual): judged true' }], 'none'),
    ])
    const { result: step } = await run({ result, plans: [visualClaim], visionGate: TEXT_ONLY })

    expect(step.status).toBe('failed')
    const recorded = step.evidence!.conditionVerdicts!.conditions[0]
    expect(recorded).toMatchObject({ verdict: 'inconclusive', judged: 'met', guard: 'visual-text-only' })
    expect(recorded.citations[0]).toMatchObject({ source: 'read', found: true })
  })

  it('a non-visual condition passes under a text-only gate', async () => {
    const result = verification([condition(finalScreenCitation, 'none')])
    const { result: step } = await run({ result, plans: [clickLogIn], visionGate: TEXT_ONLY })

    expect(step.status).toBe('passed')
    expect(step.evidence!.conditionVerdicts!.conditions[0].verdict).toBe('met')
  })
})
