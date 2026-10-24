// C436-IOS-LIVE (436 D-30): the iOS scroll path run live on a booted simulator's Settings app
// (com.apple.Preferences), through the real runner loop with a scripted planner and verifier. No
// model is called. Skipped unless AGENT_QA_436_IOS_LIVE=1, with a booted simulator (its udid in
// AGENT_QA_436_IOS_UDID, or Appium's choice) and Appium with XCUITest (10.25.0 when recorded)
// reachable at AGENT_QA_APPIUM_URL or http://localhost:4723. A skip is never a pass.
//
// XCUITest reports no movement or boundary signal, so every iOS swipe is 'unknown' (436-02): a
// search ends only when the visibility probe sees the target or maxSwipes is used.

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
import type { ScreenState } from '@vostride/agent-qa-schema'
import { IOSPlatformAdapter } from '../adapter.js'

const LIVE = process.env.AGENT_QA_436_IOS_LIVE === '1'
const SETTINGS = 'com.apple.Preferences'
const FAR_ROW = 'Privacy & Security'
const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }

function onScreen(screen: ScreenState, name: string): boolean {
  const height = (screen.metadata.viewportHeight as number | undefined) ?? Number.POSITIVE_INFINITY
  return screen.elements.some((e) =>
    e.name === name && e.bounds !== undefined && e.bounds.height > 0 && e.bounds.y >= 0 && e.bounds.y < height)
}

interface Run {
  result: StepResult
  executed: Action[]
}

async function scrollStep(adapter: PlatformAdapter, target: string): Promise<Run> {
  const executed: Action[] = []
  const counting = new Proxy(adapter, {
    get(source, property) {
      if (property === 'execute') {
        return async (action: Action) => {
          executed.push(action)
          return source.execute(action)
        }
      }
      const value: unknown = Reflect.get(source, property, source)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(source) : value
    },
  })
  const plan: ActionPlan = {
    reasoning: `Scroll down until ${FAR_ROW} appears`,
    action: { type: 'scroll', mode: 'untilVisible', text: target, direction: 'down', maxSwipes: 10, retryOpposite: false },
    confidence: 0.9,
    stepComplete: true,
    stepFailed: false,
  }
  const planner: Planner = { async plan() { return { plan } } }
  const verifier: Verifier = {
    async verify(step, _before, after, action) {
      const pass = onScreen(after, FAR_ROW)
      const reasoning = pass ? `${FAR_ROW} is on screen` : `${FAR_ROW} is not on screen`
      return { verification: scriptedVerification({ step, after, action, pass, reasoning }) }
    },
  }
  const context: StepContext = {
    stepInstruction: `Scroll to ${FAR_ROW}`,
    testName: '436 iOS live',
    previousSteps: [],
    plannerModel: {} as StepContext['plannerModel'],
    verifierModel: {} as StepContext['verifierModel'],
  }
  const result = await executeStep(context.stepInstruction, { adapter: counting, planner, verifier, plannerConfig: LIMITS }, context)
  return { result, executed }
}

function expectOutcomeOnly(run: Run): void {
  const evidence = run.result.evidence!
  expect(evidence.stagnation).toBeUndefined()
  expect(evidence.cycle).toBeUndefined()
  for (const subAction of evidence.subActions) expect(subAction.localEffect).toBeUndefined()
  expect(run.executed).toHaveLength(1)
  expect(evidence.limitUsage?.actionsUsed).toBe(1)
}

describe.skipIf(!LIVE)('C436-IOS-LIVE', () => {
  let adapter: IOSPlatformAdapter | undefined
  let driverCalls: unknown[][] = []

  beforeEach(async () => {
    const created = new IOSPlatformAdapter()
    const udid = process.env.AGENT_QA_436_IOS_UDID
    await created.setup({
      platform: 'ios',
      bundleId: SETTINGS,
      ...(udid ? { udid } : {}),
    } as Parameters<typeof created.setup>[0])
    adapter = created
    const driver = (created as unknown as { driver: WebdriverIO.Browser }).driver
    await driver.terminateApp(SETTINGS)
    await driver.activateApp(SETTINGS)
    driverCalls = []
    const execute = driver.execute.bind(driver) as (...args: unknown[]) => Promise<unknown>
    ;(driver as unknown as { execute: (...args: unknown[]) => Promise<unknown> }).execute = (...args: unknown[]) => {
      driverCalls.push(args)
      return execute(...args)
    }
  }, 180_000)

  afterEach(async () => {
    await adapter?.cleanup()
    adapter = undefined
  }, 120_000)

  // The label is written with doubled spaces so the predicate rung does not match it and the
  // search runs on swipes; the visibility probe normalizes whitespace and still recognizes it.
  it('untilVisible finds a far row by the visibility probe while swipes report unknown', async () => {
    const run = await scrollStep(adapter!, 'Privacy  &  Security')

    expect(run.result.status).toBe('passed')
    const meta = run.result.evidence!.subActions[0].result.metadata?.['scrollUntilVisible'] as { swipes: number }
    expect(meta).toMatchObject({ outcome: 'found', endedBy: 'target-visible', reversedOnce: false })
    expect(meta.swipes, 'the probe, not a boundary signal, ended a search made of unknown swipes').toBeGreaterThan(0)
    expectOutcomeOnly(run)
  }, 300_000)

  it('the predicate search runs without a direction', async () => {
    const run = await scrollStep(adapter!, FAR_ROW)

    expect(run.result.status).toBe('passed')
    const searches = driverCalls.filter((call) => call[0] === 'mobile: scroll')
    expect(searches.length).toBeGreaterThan(0)
    for (const call of searches) {
      expect(call[1]).toHaveProperty('predicateString')
      expect(call[1]).not.toHaveProperty('direction')
    }
    expect(run.result.evidence!.subActions[0].result.metadata?.['scrollUntilVisible'])
      .toMatchObject({ outcome: 'found', endedBy: 'target-visible', reversedOnce: false })
    expectOutcomeOnly(run)
  }, 300_000)
})
