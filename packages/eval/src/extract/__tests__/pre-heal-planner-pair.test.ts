import {
  buildScreenState,
  executeStep,
  type Action as RunnerAction,
  type ActionPlan,
  type ActionResult,
  type InterimNode,
  type PlatformAdapter,
  type StepContext,
} from '@vostride/agent-qa-runner'
import type { PerTestOutcome, ScreenState } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { reconstructDecisionContext } from '../../replay/reconstruct'
import { projectInputLeg } from '../input-leg'
import { projectSidecarLeg } from '../sidecar-leg'

function screen(nodes: InterimNode[]): ScreenState {
  return buildScreenState({
    platform: 'android',
    nodes: nodes.map((node, i) => ({
      bounds: { x: 0, y: i * 60, width: 400, height: 50 },
      ...node,
    })),
    viewport: { width: 400, height: 800 },
    scroll: { offsetX: 0, offsetY: 0, contentWidth: 400, contentHeight: 800 },
    coordSpace: 'viewport',
    timestamp: 0,
  }).state
}

const PRIOR = screen([
  { role: 'button', name: 'Delete' },
  { role: 'button', name: 'Save' },
  { role: 'button', name: 'Cancel' },
])
// A banner is inserted ahead, so the fresh "Save" sits at the prior "Cancel"'s ref.
const FRESH = screen([
  { role: 'button', name: 'Banner' },
  { role: 'button', name: 'Delete' },
  { role: 'button', name: 'Save' },
  { role: 'button', name: 'Cancel' },
])

function shiftingAdapter(results: ActionResult[]): PlatformAdapter & { executed: RunnerAction[] } {
  const executed: RunnerAction[] = []
  return {
    executed,
    platform: 'android',
    async setup() {},
    async cleanup() {},
    async observe() {
      return executed.length === 0 ? PRIOR : FRESH
    },
    async execute(action: RunnerAction) {
      const result = results[Math.min(executed.length, results.length - 1)]!
      executed.push(action)
      return result
    },
  }
}

function scripted(action: ActionPlan['action']) {
  const turns: ActionPlan[] = [
    { reasoning: 'scripted', action, confidence: 0.9, stepComplete: true, stepFailed: false },
    {
      reasoning: 'giving up',
      action: { type: 'delay', ms: 0 },
      confidence: 0.9,
      stepComplete: false,
      stepFailed: true,
    },
  ]
  let calls = 0
  return {
    async plan() {
      return { plan: turns[Math.min(calls++, turns.length - 1)]! }
    },
  }
}

const model = {} as StepContext['plannerModel']

async function healedLeg() {
  const adapter = shiftingAdapter([
    {
      success: false,
      error: 'binding-lost: ref e2 — the observed element is no longer on the page; nothing was sent',
      metadata: { binding: { outcome: 'binding-lost', ref: 'e2', inputSent: false } },
    },
    { success: true },
  ])
  const result = await executeStep(
    'Click Save',
    {
      adapter,
      planner: scripted({ type: 'click', ref: 'e2', target: { role: 'button', name: 'Save' } }),
      plannerConfig: { maxActions: 10, maxPlanningTurns: 10, previousStepCount: 0 },
    },
    {
      stepInstruction: 'Click Save',
      testName: 'editor::healed-step',
      previousSteps: [],
      plannerModel: model,
      verifierModel: model,
    },
  )
  expect(result.status).toBe('passed')
  expect(adapter.executed).toEqual([
    { type: 'click', ref: 'e2' },
    { type: 'click', ref: 'e3' },
  ])
  const step = { ...result.evidence!, stepIndex: 0 }
  const decisionOrdinal = step.subActions.length - 1
  const subAction = step.subActions[decisionOrdinal]!
  const handoffTest: PerTestOutcome = {
    testId: 'editor::healed-step',
    testName: 'Click Save after the page shifted',
    testIndex: 0,
    outcome: 'passed',
    steps: [step],
    filePath: 'editor.spec.yaml',
  }
  const leg = projectInputLeg({
    handoffTest,
    step,
    subAction,
    testIndex: 0,
    stepIndex: 0,
    decisionOrdinal,
  })
  return { subAction, leg }
}

describe('C444.1-EVAL-PLANNER-PAIR', () => {
  it('a ref-healed leg is extracted with the tree the planner saw and the action it chose', async () => {
    const { subAction, leg } = await healedLeg()

    expect(leg.stateBefore.elements).toEqual(PRIOR.elements)
    const sidecar = projectSidecarLeg({ subAction })
    expect(sidecar.leg.goldAction).toEqual({ type: 'click', ref: 'e2' })
    expect(sidecar.anchorUnresolved).toBe(false)
    const gold = leg.stateBefore.elements.find((element) => element.ref === 'e2')
    expect(gold?.name).toBe('Save')
  })

  it('a ref-healed leg is replayed against the tree the planner saw', async () => {
    const { leg } = await healedLeg()

    const replayed = reconstructDecisionContext({
      leg,
      captureMode: 'textOnly',
      artifacts: { getBlob: () => undefined },
      model,
    })
    expect(replayed.screenState.elements).toEqual(PRIOR.elements)
    expect(replayed.screenState.elements).not.toEqual(FRESH.elements)
  })
})
