// Live on an emulator's Settings app; `scrollGesture` answers false only at the list's end.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executeStep, scriptedVerification } from '@vostride/agent-qa-runner'
import type {
  Action,
  ActionPlan,
  PlannerConfig,
  Planner,
  PlatformAdapter,
  StepContext,
  StepResult,
  Verifier,
} from '@vostride/agent-qa-runner'
import type { OperationEvidence, Ref, ScreenState } from '@vostride/agent-qa-schema'
import { AndroidPlatformAdapter } from '../adapter.js'

const LIVE = process.env.AGENT_QA_ANDROID_LIVE === '1'
const SETTINGS = 'com.android.settings'
const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }

type Turn = (screen: ScreenState) => ActionPlan

function refFor(screen: ScreenState, name: string): Ref {
  const element = screen.elements.find((e) => e.name === name)
  if (element === undefined) throw new Error(`"${name}" is not on the screen`)
  return element.ref
}

function act(action: ActionPlan['action'], stepComplete: boolean, reasoning: string): ActionPlan {
  return { reasoning, action, confidence: 0.9, stepComplete, stepFailed: false }
}

function onScreen(screen: ScreenState, name: string): boolean {
  const height = (screen.metadata.viewportHeight as number | undefined) ?? Number.POSITIVE_INFINITY
  return screen.elements.some((e) =>
    e.name === name && e.bounds !== undefined && e.bounds.height > 0 && e.bounds.y >= 0 && e.bounds.y < height)
}

interface Run {
  result: StepResult
  executed: Action[]
  planned: ActionPlan[]
  verifierEvidence: (OperationEvidence | undefined)[]
}

async function runStep(
  adapter: PlatformAdapter,
  instruction: string,
  turns: Turn[],
  check: (after: ScreenState) => boolean,
): Promise<Run> {
  const executed: Action[] = []
  const planned: ActionPlan[] = []
  const verifierEvidence: (OperationEvidence | undefined)[] = []
  const counting = new Proxy(adapter, {
    get(target, property) {
      if (property === 'execute') {
        return async (action: Action) => {
          executed.push(action)
          return target.execute(action)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  const planner: Planner = {
    async plan(_step, screen) {
      const plan = turns[Math.min(planned.length, turns.length - 1)](screen)
      planned.push(plan)
      return { plan }
    },
  }
  const verifier: Verifier = {
    async verify(step, _before, after, action, _shot, _signal, _note, _predicate, _author, evidence) {
      verifierEvidence.push(evidence)
      const pass = check(after)
      const reasoning = pass ? 'requested outcome seen' : 'requested outcome absent'
      return { verification: scriptedVerification({ step, after, action, pass, reasoning }) }
    },
  }
  const context: StepContext = {
    stepInstruction: instruction,
    testName: 'Android live',
    previousSteps: [],
    plannerModel: {} as StepContext['plannerModel'],
    verifierModel: {} as StepContext['verifierModel'],
  }
  const result = await executeStep(instruction, { adapter: counting, planner, verifier, plannerConfig: LIMITS }, context)
  return { result, executed, planned, verifierEvidence }
}

/** No progress-subsystem evidence, and one dispatch per planned action (no loop-initiated retry). */
function expectOutcomeOnly(run: Run): void {
  const evidence = run.result.evidence!
  expect(evidence.stagnation).toBeUndefined()
  expect(evidence.cycle).toBeUndefined()
  for (const subAction of evidence.subActions) expect(subAction.localEffect).toBeUndefined()
  const plannedActions = run.planned.filter((plan) => plan.stepFailed !== true).length
  expect(run.executed).toHaveLength(plannedActions)
  expect(evidence.limitUsage?.actionsUsed).toBe(plannedActions)
}

function scrollMeta(run: Run, index: number): unknown {
  return run.result.evidence!.subActions[index].result.metadata?.['scrollUntilVisible']
}

const toEndDown = (complete: boolean): Turn => () => act(
  { type: 'scroll', mode: 'direction', direction: 'down', amount: 'toEnd', retryOpposite: false },
  complete,
  'Scroll to the end of the settings list',
)

describe.skipIf(!LIVE)('Settings scrolling and step capture through the real loop on a live emulator', () => {
  let adapter: AndroidPlatformAdapter | undefined

  beforeEach(async () => {
    const created = new AndroidPlatformAdapter()
    await created.setup({ platform: 'android', appPackage: SETTINGS, appActivity: '.Settings' } as Parameters<typeof created.setup>[0])
    adapter = created
    // Every cell starts from the top of a freshly launched Settings.
    const driver = (created as unknown as { driver: WebdriverIO.Browser }).driver
    await driver.terminateApp(SETTINGS)
    await driver.activateApp(SETTINGS)
  }, 120_000)

  afterEach(async () => {
    await adapter?.cleanup()
    adapter = undefined
  }, 120_000)

  // The row's label is written with doubled spaces. UiAutomator's textContains does not match it,
  // so the native UiScrollable rung fails and the search runs on scrollGesture swipes alone; the
  // visibility probe normalizes whitespace, so the row is still recognized when it appears.
  it('untilVisible finds a far Settings row from scrollGesture signals', async () => {
    const run = await runStep(adapter!, 'Scroll back up to Network & internet', [
      toEndDown(false),
      () => act(
        { type: 'scroll', mode: 'untilVisible', text: 'Network  &  internet', direction: 'up', maxSwipes: 6, retryOpposite: false },
        true,
        'Scroll up until Network & internet appears',
      ),
    ], (after) => onScreen(after, 'Network & internet'))

    expect(run.result.status).toBe('passed')
    expect(scrollMeta(run, 0)).toMatchObject({ outcome: 'found', endedBy: 'boundary' })
    const search = scrollMeta(run, 1) as { swipes: number }
    expect(search).toMatchObject({ outcome: 'found', endedBy: 'target-visible', reversedOnce: false })
    expect(search.swipes, 'the row was reached by swipes that scrollGesture reported as moved').toBeGreaterThan(1)
    expectOutcomeOnly(run)
  }, 240_000)

  it('toEnd ends at the driver boundary', async () => {
    const run = await runStep(adapter!, 'Scroll to the end of the settings list', [toEndDown(true)],
      (after) => onScreen(after, 'Tips & support'))

    expect(run.result.status).toBe('passed')
    const toEnd = scrollMeta(run, 0) as { swipes: number }
    expect(toEnd).toMatchObject({ outcome: 'found', endedBy: 'boundary', reversedOnce: false })
    expect(toEnd.swipes, 'scrollGesture said true while the list moved').toBeGreaterThan(1)

    // At the real end the very first gesture already answers false.
    const again = await adapter!.execute({ type: 'scroll', mode: 'direction', direction: 'down', amount: 'toEnd', retryOpposite: false })
    expect(again.metadata?.['scrollUntilVisible']).toEqual({ swipes: 1, reversedOnce: false, outcome: 'found', endedBy: 'boundary' })
    expectOutcomeOnly(run)
  }, 240_000)

  it('a step records download and clipboard capture unavailable', async () => {
    const run = await runStep(adapter!, 'Open Network & internet', [
      (screen) => act({ type: 'tap', ref: refFor(screen, 'Network & internet') }, true, 'Open Network & internet'),
    ], (after) => onScreen(after, 'Airplane mode'))

    expect(run.result.status).toBe('passed')
    expect(run.result.evidence!.operationCapture).toEqual({ download: 'unavailable', clipboard: 'unavailable', reason: 'platform' })
    for (const subAction of run.result.evidence!.subActions) expect(subAction.operationEvidence).toBeUndefined()
    expect(run.verifierEvidence).toEqual([undefined])
    expectOutcomeOnly(run)
  }, 240_000)

  it('opening and leaving the same row three times is six dispatches with no strike or skip', async () => {
    const open = (screen: ScreenState) => act({ type: 'tap', ref: refFor(screen, 'Network & internet') }, false, 'Open Network & internet')
    const leave = (last: boolean) => () => act({ type: 'pressBack' }, last, 'Go back to Settings')
    const run = await runStep(adapter!, 'Open Network & internet and go back, three times', [
      open, leave(false), open, leave(false), open, leave(true),
    ], (after) => onScreen(after, 'Network & internet') && !onScreen(after, 'Airplane mode'))

    expect(run.result.status).toBe('passed')
    expect(run.executed.map((action) => action.type)).toEqual(['tap', 'pressBack', 'tap', 'pressBack', 'tap', 'pressBack'])
    const subActions = run.result.evidence!.subActions
    expect(subActions).toHaveLength(6)
    expect(subActions.every((s) => s.result.success)).toBe(true)
    const pages = subActions.map((s) => onScreen(s.stateBefore, 'Airplane mode'))
    expect(pages, 'each tap opened the page and each back left it').toEqual([false, true, false, true, false, true])
    expectOutcomeOnly(run)
  }, 240_000)
})
