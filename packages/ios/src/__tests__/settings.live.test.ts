// Live on a simulator's Settings app; only a tap on a switch's unlabelled knob flips it.

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
import { IOSPlatformAdapter } from '../adapter.js'

const LIVE = process.env.AGENT_QA_437_IOS_LIVE === '1'
const UDID = process.env.AGENT_QA_437_IOS_UDID
const SETTINGS = 'com.apple.Preferences'
const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }
const ACCESSIBILITY = 'Accessibility'
const MOTION = 'Motion'
const CURSOR = 'Prefer Non-Blinking Cursor'
const GENERAL = 'General'
const ABOUT = 'About'

type Turn = (screen: ScreenState) => ActionPlan
type Element = ScreenState['elements'][number]

function act(action: ActionPlan['action'], stepComplete: boolean, reasoning: string): ActionPlan {
  return { reasoning, action, confidence: 0.9, stepComplete, stepFailed: false }
}

function onScreen(screen: ScreenState, element: Element): boolean {
  const height = (screen.metadata.viewportHeight as number | undefined) ?? Number.POSITIVE_INFINITY
  return element.bounds !== undefined && element.bounds.height > 0 && element.bounds.y >= 0 && element.bounds.y < height
}

function button(screen: ScreenState, name: string): Element | undefined {
  return screen.elements.find((e) => e.name === name && e.role === 'button' && onScreen(screen, e))
}

function cursorSwitch(screen: ScreenState): Element | undefined {
  return screen.elements.find((e) => e.name === CURSOR && e.role === 'switch')
}

function cursorKnob(screen: ScreenState): Element | undefined {
  const outer = cursorSwitch(screen)
  if (outer === undefined) return undefined
  return screen.elements.find((e) => e.role === 'switch' && e.hierarchy?.parentRef === outer.ref)
}

function knobChecked(screen: ScreenState): boolean | undefined {
  const checked = cursorKnob(screen)?.state.checked
  return typeof checked === 'boolean' ? checked : undefined
}

function toMotion(screen: ScreenState, last: boolean): ActionPlan {
  const motion = button(screen, MOTION)
  if (motion !== undefined) return act({ type: 'tap', ref: motion.ref }, last, 'Open Motion')
  const accessibility = button(screen, ACCESSIBILITY)
  if (accessibility !== undefined) return act({ type: 'tap', ref: accessibility.ref }, false, 'Open Accessibility')
  const target = screen.elements.some((e) => e.name === MOTION) ? MOTION : ACCESSIBILITY
  return act({ type: 'scroll', mode: 'untilVisible', text: target, direction: 'down', maxSwipes: 6, retryOpposite: false }, false, `Bring ${target} into view`)
}

interface SwitchTurn {
  original?: boolean
  value?: string
  refs: Set<Ref>
  unreadable?: boolean
}

// One turn function serves every planning turn: reach Accessibility → Motion, then plan the knob
// tap with the desired state chosen from the knob's own observed checked state.
function toCursor(seen: SwitchTurn, desired: (original: boolean) => 'checked' | 'unchecked'): Turn {
  return (screen) => {
    const knob = cursorKnob(screen)
    if (knob === undefined) return toMotion(screen, false)
    const checked = knob.state.checked
    if (typeof checked !== 'boolean') {
      seen.unreadable = true
      return { reasoning: 'The Prefer Non-Blinking Cursor knob exposes no checked state', action: { type: 'wait', duration: 0 }, confidence: 0.9, stepComplete: false, stepFailed: true }
    }
    seen.original ??= checked
    seen.value ??= knob.value
    seen.refs.add(knob.ref)
    return act({ type: 'tap', ref: knob.ref, desiredState: desired(seen.original) }, true, 'Set the Prefer Non-Blinking Cursor switch')
  }
}

interface Run {
  result: StepResult
  executed: Action[]
  planned: ActionPlan[]
  after?: ScreenState
}

async function runStep(
  adapter: PlatformAdapter,
  instruction: string,
  turns: Turn[],
  check: (after: ScreenState) => boolean,
): Promise<Run> {
  const run: Omit<Run, 'result'> = { executed: [], planned: [] }
  const counting = new Proxy(adapter, {
    get(target, property) {
      if (property === 'execute') {
        return async (action: Action) => {
          run.executed.push(action)
          return target.execute(action)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  const planner: Planner = {
    async plan(_step, screen) {
      const plan = turns[Math.min(run.planned.length, turns.length - 1)](screen)
      run.planned.push(plan)
      return { plan }
    },
  }
  const verifier: Verifier = {
    async verify(step, _before, after, action) {
      run.after = after
      const pass = check(after)
      const reasoning = pass ? 'requested outcome seen' : 'requested outcome absent'
      return { verification: scriptedVerification({ step, after, action, pass, reasoning }) }
    },
  }
  const context: StepContext = {
    stepInstruction: instruction,
    testName: '437 iOS live',
    previousSteps: [],
    plannerModel: {} as StepContext['plannerModel'],
    verifierModel: {} as StepContext['verifierModel'],
  }
  const result = await executeStep(instruction, { adapter: counting, planner, verifier, plannerConfig: LIMITS }, context)
  return { ...run, result }
}

function tapsOn(executed: Action[], refs: Set<Ref>): Action[] {
  return executed.filter((a) => a.type === 'tap' && refs.has((a as { ref?: Ref }).ref as Ref))
}

describe.skipIf(!LIVE)('Settings switches and rows under desiredState on a live simulator', () => {
  let adapter: IOSPlatformAdapter | undefined
  let restore: SwitchTurn | undefined

  beforeEach(async () => {
    const created = new IOSPlatformAdapter()
    await created.setup({
      platform: 'ios',
      bundleId: SETTINGS,
      ...(UDID ? { udid: UDID } : {}),
    } as Parameters<typeof created.setup>[0])
    adapter = created
    const driver = (created as unknown as { driver: WebdriverIO.Browser }).driver
    await driver.terminateApp(SETTINGS)
    await driver.activateApp(SETTINGS)
  }, 180_000)

  afterEach(async () => {
    try {
      if (restore?.original !== undefined && adapter !== undefined) {
        for (let attempt = 0; ; attempt++) {
          const knob = cursorKnob(await adapter.observe())
          if (knob === undefined) throw new Error('The Prefer Non-Blinking Cursor knob is not on screen; its original value could not be restored')
          if (knob.state.checked === restore.original) break
          if (attempt === 3) throw new Error(`The Prefer Non-Blinking Cursor knob reads ${String(knob.state.checked)} after restoring, not ${String(restore.original)}`)
          await adapter.execute({ type: 'tap', ref: knob.ref })
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
    } finally {
      restore = undefined
      await adapter?.cleanup()
      adapter = undefined
    }
  }, 120_000)

  it("a switch's value is read as its checked state", async () => {
    const run = await runStep(adapter!, 'Open Accessibility, then Motion', [(screen) => toMotion(screen, true)],
      (after) => cursorKnob(after) !== undefined)

    expect(run.result.status).toBe('passed')
    const screen = run.after!
    const outer = cursorSwitch(screen)
    const knob = cursorKnob(screen)
    expect(outer, 'the labelled Prefer Non-Blinking Cursor switch is observed').toBeDefined()
    expect(knob, 'its knob is observed as a child switch').toBeDefined()
    for (const control of [knob!, outer!]) {
      const reading = `value=${control.value} checked=${String(control.state.checked)}`
      expect(['0', '1'], reading).toContain(control.value)
      expect(typeof control.state.checked, reading).toBe('boolean')
      expect(control.state.checked, reading).toBe(control.value === '1')
    }
  }, 300_000)

  it('a switch already in the requested state sends no input', async () => {
    const seen: SwitchTurn = { refs: new Set() }
    restore = seen
    const inState = (original: boolean) => (original ? 'checked' : 'unchecked')
    const run = await runStep(adapter!, 'Leave Prefer Non-Blinking Cursor as it is', [toCursor(seen, inState)],
      (after) => seen.original !== undefined && knobChecked(after) === seen.original)

    expect(seen.unreadable, 'the knob exposes no boolean checked state').toBeUndefined()
    expect(typeof seen.original, 'the knob was reached and read').toBe('boolean')
    const current = inState(seen.original!)
    expect(run.result.status).toBe('passed')
    expect(tapsOn(run.executed, seen.refs), 'no input reached the knob').toHaveLength(0)
    const subs = run.result.evidence!.subActions
    const knobTaps = subs.filter((s) => s.plannedAction.type === 'tap' && seen.refs.has((s.plannedAction as { ref?: Ref }).ref as Ref))
    expect(knobTaps).toHaveLength(1)
    const sub = knobTaps[0]
    expect(sub.result.success).toBe(false)
    expect(sub.result.error).toBeUndefined()
    expect(sub.result.metadata?.['idempotentNoop']).toEqual({ currentState: current, inputSent: false })
    expect(sub.operationEvidence?.input?.[0]?.inputSent).toBe(false)
    expect(run.executed).toHaveLength(subs.length - 1)
    const after = cursorKnob(await adapter!.observe())
    expect(after?.value, 'the knob value is unchanged').toBe(seen.value)
  }, 300_000)

  it('a switch not in the requested state is tapped once', async () => {
    const seen: SwitchTurn = { refs: new Set() }
    restore = seen
    const flipped = (original: boolean) => (original ? 'unchecked' : 'checked')
    const run = await runStep(adapter!, 'Turn Prefer Non-Blinking Cursor to the other state', [toCursor(seen, flipped)],
      (after) => seen.original !== undefined && knobChecked(after) === !seen.original)

    expect(seen.unreadable, 'the knob exposes no boolean checked state').toBeUndefined()
    expect(typeof seen.original, 'the knob was reached and read').toBe('boolean')
    expect(run.result.status).toBe('passed')
    const knobTaps = tapsOn(run.executed, seen.refs)
    expect(knobTaps, 'the knob was tapped exactly once').toHaveLength(1)
    expect(knobTaps[0]).toMatchObject({ desiredState: flipped(seen.original!) })
    const subs = run.result.evidence!.subActions
    const last = subs[subs.length - 1]
    expect(last.result.success).toBe(true)
    expect(last.result.metadata?.['idempotentNoop']).toBeUndefined()
    const after = cursorKnob(await adapter!.observe())
    expect(after?.state.checked).toBe(!seen.original)
    expect(after?.value, 'the knob value flipped').toBe(seen.original ? '0' : '1')
  }, 300_000)

  it('an ordinary row is not a toggle and is tapped under desiredState unselected', async () => {
    let general: Element | undefined
    const run = await runStep(adapter!, 'Open General', [
      (screen) => {
        general = button(screen, GENERAL)
        if (general === undefined) throw new Error(`"${GENERAL}" is not on the Settings home page`)
        return act({ type: 'tap', ref: general.ref, desiredState: 'unselected' }, true, 'Open General')
      },
    ], (after) => button(after, ABOUT) !== undefined)

    expect(general, 'the General row was observed').toBeDefined()
    expect(isToggleElement(general!)).toBe(false)
    expect(general!.state.selected).toBeUndefined()
    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(run.executed[0]).toMatchObject({ type: 'tap', ref: general!.ref, desiredState: 'unselected' })
    const sub = run.result.evidence!.subActions[0]
    expect(sub.result.success).toBe(true)
    expect(sub.result.metadata?.['idempotentNoop']).toBeUndefined()
  }, 300_000)
})
