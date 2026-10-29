// C437-ANDROID-LIVE (437 D-20): the toggle fix run live on an emulator's Settings app
// (com.android.settings), through the real runner loop with a scripted planner and verifier. No
// model is called. It proves on a device that an ordinary node exposing `selected` is never
// skipped as already satisfied: a row tapped under desiredState unselected is sent, by ref and by
// coordinate. A real toggle keeps desired-state idempotency on its checked state: the Dark theme
// switch already in the requested state is not tapped and is recorded as no input sent, and out of
// state it is tapped once. The switch's original state is restored after each cell.
//
// C437-ANDROID-SECURE-LIVE (437 D-18): on an Appium started without relaxed security or any
// insecure feature, a shell key event (`keyevent`, `openQuickSettings`) is refused by the server
// and recorded as unavailable with reason adb-shell-disabled; nothing throws and the step does not
// pass, even with a verifier that would accept any screen.
//
// Skipped unless AGENT_QA_437_ANDROID_LIVE=1, with a booted emulator and Appium reachable at
// AGENT_QA_APPIUM_URL or http://localhost:4723. The secure cells also need
// AGENT_QA_437_SECURE_APPIUM_URL naming such a plain Appium server; they point the session at it
// for their own setup only. A skip is never a pass.

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
import { isToggleElement } from '@vostride/agent-qa-schema'
import type { Ref, ScreenState } from '@vostride/agent-qa-schema'
import { AndroidPlatformAdapter } from '../adapter.js'

const LIVE = process.env.AGENT_QA_437_ANDROID_LIVE === '1'
const SECURE_APPIUM_URL = process.env.AGENT_QA_437_SECURE_APPIUM_URL
const SETTINGS = 'com.android.settings'
const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }
const ROW = 'Network & internet'
const DISPLAY = 'Display & touch'
const DARK_THEME = 'Dark theme'

type Turn = (screen: ScreenState) => ActionPlan
type Element = ScreenState['elements'][number]

function elementFor(screen: ScreenState, name: string): Element {
  const element = screen.elements.find((e) => e.name === name)
  if (element === undefined) throw new Error(`"${name}" is not on the screen`)
  return element
}

function refFor(screen: ScreenState, name: string): Ref {
  return elementFor(screen, name).ref
}

function act(action: ActionPlan['action'], stepComplete: boolean, reasoning: string): ActionPlan {
  return { reasoning, action, confidence: 0.9, stepComplete, stepFailed: false }
}

function onScreen(screen: ScreenState, name: string): boolean {
  const height = (screen.metadata.viewportHeight as number | undefined) ?? Number.POSITIVE_INFINITY
  return screen.elements.some((e) =>
    e.name === name && e.bounds !== undefined && e.bounds.height > 0 && e.bounds.y >= 0 && e.bounds.y < height)
}

function onNetworkPage(screen: ScreenState): boolean {
  return onScreen(screen, 'Airplane mode') || onScreen(screen, 'Internet')
}

function darkThemeSwitch(screen: ScreenState): Element | undefined {
  return screen.elements.find((e) => e.name === DARK_THEME && isToggleElement(e))
}

function darkThemeChecked(screen: ScreenState): boolean | undefined {
  const checked = darkThemeSwitch(screen)?.state.checked
  return typeof checked === 'boolean' ? checked : undefined
}

interface SwitchTurn {
  original?: boolean
  ref?: Ref
  unreadable?: boolean
}

// One turn function serves every planning turn: reach Display & touch, then plan the switch tap
// with the desired state chosen from the switch's own observed checked state.
function toDarkTheme(seen: SwitchTurn, desired: (original: boolean) => 'checked' | 'unchecked'): Turn {
  return (screen) => {
    const control = darkThemeSwitch(screen)
    if (control !== undefined) {
      const checked = control.state.checked
      if (typeof checked !== 'boolean') {
        seen.unreadable = true
        return { reasoning: 'The Dark theme switch exposes no checked state', action: { type: 'wait', duration: 0 }, confidence: 0.9, stepComplete: false, stepFailed: true }
      }
      seen.original ??= checked
      seen.ref = control.ref
      return act({ type: 'tap', ref: control.ref, desiredState: desired(seen.original) }, true, 'Set the Dark theme switch')
    }
    if (onScreen(screen, DISPLAY)) return act({ type: 'tap', ref: refFor(screen, DISPLAY) }, false, 'Open Display & touch')
    const target = screen.elements.some((e) => e.name === DARK_THEME) ? DARK_THEME : DISPLAY
    return act({ type: 'scroll', mode: 'untilVisible', text: target, direction: 'down', maxSwipes: 6, retryOpposite: false }, false, `Bring ${target} into view`)
  }
}

interface Run {
  result: StepResult
  executed: Action[]
  planned: ActionPlan[]
}

async function runStep(
  adapter: PlatformAdapter,
  instruction: string,
  turns: Turn[],
  check: (after: ScreenState) => boolean,
): Promise<Run> {
  const executed: Action[] = []
  const planned: ActionPlan[] = []
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
    async verify(step, _before, after, action) {
      const pass = check(after)
      const reasoning = pass ? 'requested outcome seen' : 'requested outcome absent'
      return { verification: scriptedVerification({ step, after, action, pass, reasoning }) }
    },
  }
  const context: StepContext = {
    stepInstruction: instruction,
    testName: '437 Android live',
    previousSteps: [],
    plannerModel: {} as StepContext['plannerModel'],
    verifierModel: {} as StepContext['verifierModel'],
  }
  const result = await executeStep(instruction, { adapter: counting, planner, verifier, plannerConfig: LIMITS }, context)
  return { result, executed, planned }
}

async function openSettings(): Promise<AndroidPlatformAdapter> {
  const created = new AndroidPlatformAdapter()
  await created.setup({ platform: 'android', appPackage: SETTINGS, appActivity: '.Settings' } as Parameters<typeof created.setup>[0])
  const driver = (created as unknown as { driver: WebdriverIO.Browser }).driver
  await driver.terminateApp(SETTINGS)
  await driver.activateApp(SETTINGS)
  return created
}

describe.skipIf(!LIVE)('Settings rows and switches under desiredState on a live emulator', () => {
  let adapter: AndroidPlatformAdapter | undefined

  beforeEach(async () => {
    adapter = await openSettings()
  }, 120_000)

  let restore: SwitchTurn | undefined

  afterEach(async () => {
    try {
      if (restore?.original !== undefined && adapter !== undefined) {
        const screen = await adapter.observe()
        const control = darkThemeSwitch(screen)
        if (control === undefined) throw new Error('The Dark theme switch is not on screen; its original state could not be restored')
        if (control.state.checked !== restore.original) {
          const tapped = await adapter.execute({ type: 'tap', ref: control.ref })
          if (!tapped.success) throw new Error(`Restoring the Dark theme switch failed: ${tapped.error ?? 'no error text'}`)
          const after = darkThemeChecked(await adapter.observe())
          if (after !== restore.original) throw new Error(`The Dark theme switch reads ${String(after)} after restoring, not ${String(restore.original)}`)
        }
      }
    } finally {
      restore = undefined
      await adapter?.cleanup()
      adapter = undefined
    }
  }, 120_000)

  it('an ordinary row is tapped under desiredState unselected on the ref path', async () => {
    const run = await runStep(adapter!, 'Open Network & internet', [
      (screen) => act({ type: 'tap', ref: refFor(screen, ROW), desiredState: 'unselected' }, true, 'Open Network & internet'),
    ], onNetworkPage)

    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(run.executed[0]).toMatchObject({ type: 'tap', desiredState: 'unselected' })
    const sub = run.result.evidence!.subActions[0]
    expect(sub.result.success).toBe(true)
    expect(sub.result.metadata?.['idempotentNoop']).toBeUndefined()
  }, 240_000)

  it('the same row through tapCoordinate is sent', async () => {
    const run = await runStep(adapter!, 'Open Network & internet', [
      (screen) => {
        const bounds = elementFor(screen, ROW).bounds
        if (bounds === undefined) throw new Error(`"${ROW}" has no bounds`)
        const x = Math.round(bounds.x + bounds.width / 2)
        const y = Math.round(bounds.y + bounds.height / 2)
        return act({ type: 'tapCoordinate', x, y, coordSpace: 'viewport' }, true, 'Tap the Network & internet row')
      },
    ], onNetworkPage)

    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(run.executed[0]).toMatchObject({ type: 'tapCoordinate' })
    const sub = run.result.evidence!.subActions[0]
    expect(sub.result.success).toBe(true)
    expect(sub.result.metadata?.['idempotentNoop']).toBeUndefined()
  }, 240_000)

  it('a switch already in the requested state sends no input', async () => {
    const seen: SwitchTurn = {}
    restore = seen
    const inState = (original: boolean) => (original ? 'checked' : 'unchecked')
    const run = await runStep(adapter!, 'Leave Dark theme as it is', [toDarkTheme(seen, inState)],
      (after) => seen.original !== undefined && darkThemeChecked(after) === seen.original)

    expect(seen.unreadable, 'the Dark theme switch exposes no boolean checked state').toBeUndefined()
    expect(typeof seen.original, 'the Dark theme switch was reached and read').toBe('boolean')
    const current = inState(seen.original!)
    expect(run.result.status).toBe('passed')
    expect(run.executed.filter((a) => a.type === 'tap' && (a as { ref?: string }).ref === seen.ref), 'no input reached the switch').toHaveLength(0)
    const subs = run.result.evidence!.subActions
    const switchTaps = subs.filter((s) => s.plannedAction.type === 'tap' && (s.plannedAction as { ref?: string }).ref === seen.ref)
    expect(switchTaps).toHaveLength(1)
    const sub = switchTaps[0]
    expect(sub.result.success).toBe(false)
    expect(sub.result.error).toBeUndefined()
    expect(sub.result.metadata?.['idempotentNoop']).toEqual({ currentState: current, inputSent: false })
    expect(sub.operationEvidence?.input?.[0]?.inputSent).toBe(false)
    expect(run.executed).toHaveLength(subs.length - 1)
  }, 240_000)

  it('a switch not in the requested state is tapped once', async () => {
    const seen: SwitchTurn = {}
    restore = seen
    const flipped = (original: boolean) => (original ? 'unchecked' : 'checked')
    const run = await runStep(adapter!, 'Turn Dark theme to the other state', [toDarkTheme(seen, flipped)],
      (after) => seen.original !== undefined && darkThemeChecked(after) === !seen.original)

    expect(seen.unreadable, 'the Dark theme switch exposes no boolean checked state').toBeUndefined()
    expect(typeof seen.original, 'the Dark theme switch was reached and read').toBe('boolean')
    expect(run.result.status).toBe('passed')
    const switchTaps = run.executed.filter((a) => a.type === 'tap' && (a as { ref?: string }).ref === seen.ref)
    expect(switchTaps, 'the switch was tapped exactly once').toHaveLength(1)
    expect(switchTaps[0]).toMatchObject({ desiredState: flipped(seen.original!) })
    const subs = run.result.evidence!.subActions
    const last = subs[subs.length - 1]
    expect(last.result.success).toBe(true)
    expect(last.result.metadata?.['idempotentNoop']).toBeUndefined()
    expect(darkThemeChecked(await adapter!.observe())).toBe(!seen.original)
  }, 240_000)
})

describe.skipIf(!LIVE || SECURE_APPIUM_URL === undefined)('shell actions are recorded unavailable under secure Appium on a live emulator', () => {
  let adapter: AndroidPlatformAdapter | undefined
  let savedUrl: string | undefined

  beforeEach(async () => {
    savedUrl = process.env.AGENT_QA_APPIUM_URL
    process.env.AGENT_QA_APPIUM_URL = SECURE_APPIUM_URL
    adapter = await openSettings()
  }, 120_000)

  afterEach(async () => {
    try {
      await adapter?.cleanup()
    } finally {
      adapter = undefined
      if (savedUrl === undefined) delete process.env.AGENT_QA_APPIUM_URL
      else process.env.AGENT_QA_APPIUM_URL = savedUrl
    }
  }, 120_000)

  const giveUp = (): ActionPlan => ({ reasoning: 'The key event was not sent', action: { type: 'wait', duration: 0 }, confidence: 0.9, stepComplete: false, stepFailed: true })

  async function expectUnavailable(verb: 'keyevent' | 'openQuickSettings', action: ActionPlan['action']): Promise<void> {
    const pending = runStep(adapter!, `Send ${verb}`, [() => act(action, true, `Send ${verb}`), giveUp], () => true)
    await expect(pending).resolves.toBeDefined()
    const run = await pending

    expect(run.executed).toHaveLength(1)
    expect(run.executed[0]).toMatchObject({ type: verb })
    const sub = run.result.evidence!.subActions[0]
    expect(sub.result.success).toBe(false)
    expect(sub.result.error).toMatch(new RegExp(`^${verb} unavailable:`))
    expect(sub.result.metadata?.['shellAction']).toEqual({ verb, outcome: 'unavailable', reason: 'adb-shell-disabled' })
    expect(run.result.status).not.toBe('passed')
  }

  it('keyevent is recorded unavailable', async () => {
    await expectUnavailable('keyevent', { type: 'keyevent', keycode: 'KEYCODE_ENTER' })
  }, 240_000)

  it('openQuickSettings is recorded unavailable', async () => {
    await expectUnavailable('openQuickSettings', { type: 'openQuickSettings' })
  }, 240_000)
})
