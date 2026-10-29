import { describe, it, expect } from 'vitest'
import type { InputEvidence, OperationEvidence, ScreenState } from '@vostride/agent-qa-schema'
import type { PlatformAdapter, Action, ActionResult } from '../../platform.js'
import type { LoopPorts } from '../ports.js'
import { executeStep } from '../index.js'
import { buildAgentScreenState } from './screen-fixtures.js'
import { makeActionPlan, makeStepContext, makePlanner } from './loop-harness.js'
import type { ActionPlan, Planner, StepContext, Verifier } from '../types.js'
import { buildVerificationPrompt, composeTurnMessages } from '../prompts.js'
import type { VerifierStepRecord } from '../step-record.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'

const FIELD = buildAgentScreenState({
  url: 'https://x.test/form',
  elements: [{ ref: 'e1', role: 'textbox', name: 'Phone', bounds: { x: 20, y: 80, width: 300, height: 44 } }],
  metadata: { coordSpace: 'viewport', viewportWidth: 390, viewportHeight: 844 },
})

const FILL = { type: 'fill', ref: 'e1', text: '+13920741751', clearMode: 'replace', submit: true }
const KEYEVENT = { type: 'keyevent', keycode: 66 }

type VerifyArgs = Parameters<Verifier['verify']>

function scriptedAdapter(observation: ScreenState, result: ActionResult): PlatformAdapter {
  return {
    platform: 'android',
    async setup() {},
    async cleanup() {},
    async observe() {
      return observation
    },
    async execute(_action: Action): Promise<ActionResult> {
      return result
    },
  }
}

function capturingVerifier(captured: VerifyArgs[]): Verifier {
  return {
    async verify(...args: VerifyArgs) {
      captured.push(args)
      const [step, , after, action] = args
      return { verification: scriptedVerification({ step, after, action, pass: true, reasoning: 'Step completed' }) }
    },
  }
}

function contextCapturingPlanner(plans: ActionPlan[], contexts: StepContext[]): Planner {
  let call = 0
  return {
    async plan(_step, _screen, context) {
      contexts.push({ ...context, subActionHistory: [...(context.subActionHistory ?? [])] })
      const plan = plans[Math.min(call, plans.length - 1)]
      call++
      return { plan }
    },
  }
}

const STOP_PLAN = makeActionPlan({ action: { type: 'stepFailed' }, stepComplete: false, stepFailed: true })

async function runVerified(action: Record<string, unknown> & { type: string }, result: ActionResult) {
  const captured: VerifyArgs[] = []
  const ports: LoopPorts = {
    adapter: scriptedAdapter(FIELD, result),
    planner: makePlanner([makeActionPlan({ action, stepComplete: true })]),
    verifier: capturingVerifier(captured),
    plannerConfig: { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 },
  }
  const step = await executeStep('Enter the phone number', ports, makeStepContext())
  return { captured, step }
}

async function runReplanned(action: Record<string, unknown> & { type: string }, result: ActionResult) {
  const contexts: StepContext[] = []
  const plans = [makeActionPlan({ action, stepComplete: false }), STOP_PLAN]
  const ports: LoopPorts = {
    adapter: scriptedAdapter(FIELD, result),
    planner: contextCapturingPlanner(plans, contexts),
    verifier: capturingVerifier([]),
    plannerConfig: { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 },
  }
  await executeStep('Enter the phone number', ports, makeStepContext())
  return contexts
}

function verifierPrompt(args: VerifyArgs): string {
  const [step, before, after, action] = args
  const evidence = args[9] as OperationEvidence | undefined
  const record = args[10] as VerifierStepRecord | undefined
  return buildVerificationPrompt(step, before, after, action, false, undefined, undefined, undefined, evidence, record)
}

function plannerTurn(context: StepContext): string {
  return composeTurnMessages(context, FIELD)
    .map((message) => String(message.content))
    .join('\n')
}

function inputOf(step: Awaited<ReturnType<typeof executeStep>>): InputEvidence | undefined {
  return step.evidence?.subActions[0]?.operationEvidence?.input?.[0]
}

describe('input evidence in the verifier and planner prompts', () => {
  it('an unverified keyboard-path fill with a sent Enter reaches the verifier', async () => {
    const { captured, step } = await runVerified(FILL, {
      success: true,
      metadata: {
        fillVerdict: { verb: 'fill', verdict: 'unverified', path: 'keyboard' },
        fillSubmit: { sent: true, outcome: 'sent' },
      },
    })
    expect(inputOf(step)).toEqual({
      verb: 'fill',
      inputSent: true,
      fillVerdict: 'unverified',
      inputPath: 'keyboard',
      submit: 'sent',
    })
    expect(step.evidence?.subActions[0]?.result.metadata?.['fillVerdict']).toEqual({
      verb: 'fill',
      verdict: 'unverified',
      path: 'keyboard',
    })
    expect(captured).toHaveLength(1)
    expect(verifierPrompt(captured[0])).toContain(
      'fill (keyboard path): typed, but the value could not be read back (unverified)',
    )
  })

  it('a mismatch holds Enter and the planner sees why', async () => {
    const error = 'field reads "+1392" after typing "+13920741751" — re-observe and retry'
    const contexts = await runReplanned(FILL, {
      success: false,
      error,
      metadata: {
        fillReread: { expected: '+13920741751', actual: '+1392' },
        fillVerdict: { verb: 'fill', verdict: 'mismatch' },
        fillSubmit: { sent: false, outcome: 'not-sent', reason: 'mismatch' },
      },
    })
    expect(contexts).toHaveLength(2)
    const history = contexts[1].subActionHistory ?? []
    expect(history).toHaveLength(1)
    expect(history[0].result).toBe('failure')
    const turn = plannerTurn(contexts[1])
    expect(turn).toContain(` — FAILED: ${error.slice(0, 120)}`)
    expect(turn).toContain('fill: the field reads differently from the requested text (mismatch)')
    expect(turn).toContain('fill: Enter not sent (the text did not match)')
  })

  it('a refused fill is recorded as no input sent', async () => {
    const { step } = await runVerified(FILL, {
      success: false,
      error: 'Element e1 is single-line and the text has line breaks. Nothing was typed.',
      metadata: { fillRefusal: { verb: 'fill', cause: 'single-line-field', evidence: 'text-has-line-breaks' } },
    })
    const entry = inputOf(step)
    expect(entry).toEqual({ verb: 'fill', inputSent: false, unavailableReason: 'single-line-field' })
    const contexts = await runReplanned(FILL, {
      success: false,
      error: 'Element e1 is single-line and the text has line breaks. Nothing was typed.',
      metadata: { fillRefusal: { verb: 'fill', cause: 'single-line-field', evidence: 'text-has-line-breaks' } },
    })
    expect(plannerTurn(contexts[1])).toContain(
      'fill: no input sent — the field is single-line and the text has line breaks',
    )
  })

  it('an unavailable keyevent is recorded and rendered', async () => {
    const { captured, step } = await runVerified(KEYEVENT, {
      success: false,
      error: 'keyevent unavailable: Appium does not allow mobile: shell (adb_shell not enabled)',
      metadata: { shellAction: { verb: 'keyevent', outcome: 'unavailable', reason: 'adb-shell-disabled' } },
    })
    expect(inputOf(step)).toEqual({ verb: 'keyevent', inputSent: false, unavailableReason: 'adb-shell-disabled' })
    const contexts = await runReplanned(KEYEVENT, {
      success: false,
      error: 'keyevent unavailable: Appium does not allow mobile: shell (adb_shell not enabled)',
      metadata: { shellAction: { verb: 'keyevent', outcome: 'unavailable', reason: 'adb-shell-disabled' } },
    })
    expect(plannerTurn(contexts[1])).toContain('keyevent: unavailable (Appium does not allow mobile: shell)')
    // No failed keyevent is verified as a completion; the one call is the limit stop's own
    // judgment (439 D-08).
    expect(captured).toHaveLength(1)
    expect(step.evidence?.conditionVerdicts?.ending).toBe('limit-stop')
  })

  it('a secure fill renders as not read back', async () => {
    const { captured, step } = await runVerified(FILL, {
      success: true,
      metadata: {
        fillReread: { expected: '<len:12>', actual: '<len:12>' },
        fillVerdict: { verb: 'fill', verdict: 'unverified', secure: true },
      },
    })
    expect(inputOf(step)).toEqual({ verb: 'fill', inputSent: true, fillVerdict: 'unverified', secure: true })
    expect(verifierPrompt(captured[0])).toContain('fill: secure field, the value is not read back (unverified)')
  })

  it('an ordinary exact fill with a sent Enter adds nothing to the prompts', async () => {
    const ordinary: ActionResult = {
      success: true,
      metadata: {
        fillReread: { expected: '+13920741751', actual: '+13920741751' },
        fillVerdict: { verb: 'fill', verdict: 'exact' },
        fillSubmit: { sent: true, outcome: 'sent' },
      },
    }
    const bare: ActionResult = { success: true }

    const withMeta = await runVerified(FILL, ordinary)
    const without = await runVerified(FILL, bare)
    expect(withMeta.captured[0]).toHaveLength(11)
    expect(withMeta.captured[0][9]).toBeUndefined()
    // 439 D-03: the verifier's record names every fill verdict, an ordinary one included.
    expect(verifierPrompt(withMeta.captured[0])).toContain(
      'action 1: fill on ref="e1": input sent, fill verdict exact, Enter sent',
    )
    expect(verifierPrompt(without.captured[0])).not.toContain('Operation evidence')
    expect(inputOf(withMeta.step)).toEqual({ verb: 'fill', inputSent: true, fillVerdict: 'exact', submit: 'sent' })

    const metaContexts = await runReplanned(FILL, ordinary)
    const bareContexts = await runReplanned(FILL, bare)
    const metaTurn = plannerTurn(metaContexts[1])
    expect(metaTurn).not.toContain('Operation evidence')
    expect(metaTurn).toBe(plannerTurn(bareContexts[1]))
  })

  it('a legacy fillSubmit block on an iOS fill still derives input evidence', async () => {
    const { captured, step } = await runVerified(FILL, {
      success: true,
      data: 'submit not sent: Return would add a new line in this multi-line field; tap its send or submit control',
      metadata: {
        fillReread: { expected: 'message', actual: 'message' },
        fillSubmit: { sent: false, reason: 'multi-line-field' },
      },
    })
    expect(inputOf(step)).toEqual({
      verb: 'fill',
      inputSent: true,
      submit: 'not-sent',
      submitReason: 'multi-line-field',
    })
    expect(verifierPrompt(captured[0])).toContain('fill: Enter not sent (multi-line field)')
  })

  it('a clearText that left text renders the clear wording', async () => {
    const { captured } = await runVerified({ type: 'clearText', ref: 'e1' }, {
      success: true,
      metadata: { fillVerdict: { verb: 'clearText', verdict: 'unverified', path: 'native' } },
    })
    expect(verifierPrompt(captured[0])).toContain('clearText (native path): the value could not be read back (unverified)')
    const contexts = await runReplanned({ type: 'clearText', ref: 'e1' }, {
      success: false,
      error: 'field still reads "x" after clearing — re-observe and retry',
      metadata: { fillVerdict: { verb: 'clearText', verdict: 'mismatch' } },
    })
    expect(plannerTurn(contexts[1])).toContain('clearText: text remains in the field (mismatch)')
  })

  it('the input evidence never carries the typed or read-back text', async () => {
    const { step } = await runVerified(FILL, {
      success: false,
      error: 'field reads "+1392" after typing "+13920741751" — re-observe and retry',
      metadata: {
        fillReread: { expected: '+13920741751', actual: '+1392' },
        fillVerdict: { verb: 'fill', verdict: 'mismatch' },
      },
    })
    const serialized = JSON.stringify(step.evidence?.subActions[0]?.operationEvidence)
    expect(serialized).not.toContain('+1392')
  })
})
