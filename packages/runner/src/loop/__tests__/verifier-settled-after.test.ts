// A frame depends only on the time after the send, so the interval, not call order, picks it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { PlatformAdapter, ActionResult } from '../../platform.js'
import type { ActionPlan, PlanResult, Planner, StepContext, VerificationResult, VerifyResult, Verifier } from '../types.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'
import type { StepResult } from '../../result.js'
import { executeStep } from '../index.js'
import { buildAgentScreenState } from './screen-fixtures.js'
import { makeActionPlan, makeAdapter, makePlanner, makeStepContext } from './loop-harness.js'

// Mirrors of index.ts: VERIFY_SETTLE_INTERVAL_MS and DEFAULT_SETTLE_MAX_POLLS.
const VERIFY_SETTLE_INTERVAL_MS = 500
const MAX_POLLS = 3

const MESSAGE = 'See you at noon'

const TYPED = buildAgentScreenState({
  platform: 'ios',
  elements: [
    { ref: 'e1', role: 'textbox', name: 'Message composer', value: MESSAGE, bounds: { x: 0, y: 780, width: 320, height: 44 } },
    { ref: 'e2', role: 'button', name: 'Send', bounds: { x: 330, y: 780, width: 50, height: 44 } },
  ],
})

const SENT = buildAgentScreenState({
  platform: 'ios',
  elements: [
    { ref: 'e3', role: 'text', name: MESSAGE, bounds: { x: 20, y: 700, width: 300, height: 40 } },
    { ref: 'e1', role: 'textbox', name: 'Message composer', value: '', bounds: { x: 0, y: 780, width: 320, height: 44 } },
    { ref: 'e2', role: 'button', name: 'Send', bounds: { x: 330, y: 780, width: 50, height: 44 } },
  ],
})

const hasMessageRow = (state: ScreenState): boolean =>
  state.elements.some(el => el.role === 'text' && el.name === MESSAGE)

interface ObserveEntry {
  index: number
  offsetFromSend: number | undefined
  frame: string
  at: number
  state: ScreenState
}

async function driveWithFakeClock<T>(pending: Promise<T>): Promise<T> {
  let done = false
  let failed = false
  let value: T | undefined
  let error: unknown
  pending.then(
    v => { done = true; value = v },
    e => { done = true; failed = true; error = e },
  )
  for (let step = 0; step < 1000 && !done; step++) await vi.advanceTimersByTimeAsync(10)
  if (!done) throw new Error('executeStep did not settle within 1000 fake-clock steps')
  if (failed) throw error
  return value as T
}

function makeSendAdapter(inFlightMs: number) {
  const log: ObserveEntry[] = []
  let sentAt: number | undefined
  let executes = 0
  const adapter: PlatformAdapter = {
    platform: 'ios',
    async setup() {},
    async cleanup() {},
    async observe() {
      const offsetFromSend = sentAt === undefined ? undefined : Date.now() - sentAt
      const sent = offsetFromSend !== undefined && offsetFromSend >= inFlightMs
      const state = sent ? SENT : TYPED
      log.push({ index: log.length, offsetFromSend, frame: sent ? 'SENT' : 'TYPED', at: Date.now(), state })
      return state
    },
    async execute(): Promise<ActionResult> {
      executes++
      sentAt = Date.now()
      return { success: true }
    },
  }
  return { adapter, log, executeCount: () => executes }
}

interface RecordingVerifier extends Verifier {
  calls: unknown[][]
  observesAtCall: number[]
}

function makeMessageRowVerifier(observeCount: () => number): RecordingVerifier {
  const v: RecordingVerifier = {
    calls: [],
    observesAtCall: [],
    async verify(...args: unknown[]): Promise<VerifyResult> {
      v.calls.push(args)
      v.observesAtCall.push(observeCount())
      const call = verifyCall(args)
      return hasMessageRow(call.after)
        ? { verification: passed(args, 'The message was sent and the composer is clear') }
        : {
            verification: scriptedVerification({
              step: call.step,
              pass: false,
              reasoning: 'The text is still in the composer and no new message appears',
            }),
          }
    },
  }
  return v
}

function passed(args: unknown[], reasoning: string): VerificationResult {
  const call = verifyCall(args)
  return scriptedVerification({ step: call.step, after: call.after, pass: true, reasoning })
}

function verifyCall(args: unknown[]): { step: string; before: ScreenState; after: ScreenState; authorContext: unknown } {
  return {
    step: args[0] as string,
    before: args[1] as ScreenState,
    after: args[2] as ScreenState,
    authorContext: args[8],
  }
}

function capturingPlanner(plans: ActionPlan[]): Planner & { failureContexts: (string | undefined)[] } {
  let call = 0
  const p = {
    failureContexts: [] as (string | undefined)[],
    async plan(_step: string, _state: ScreenState, context: StepContext): Promise<PlanResult> {
      p.failureContexts.push(context.failureContext)
      const plan = plans[Math.min(call, plans.length - 1)]
      call++
      return { plan }
    },
  }
  return p
}

const tapSend = makeActionPlan({
  reasoning: 'Tap Send to send the typed message',
  action: { type: 'tap', ref: 'e2' },
  stepComplete: true,
})

describe('verifier AFTER observation settles with a 500 ms interval', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('element-24 tracer: a composer that clears within the interval is judged cleared, with one send', async () => {
    const { adapter, log, executeCount } = makeSendAdapter(300)
    const verifier = makeMessageRowVerifier(() => log.length)
    const planner = capturingPlanner([tapSend])

    const result = await driveWithFakeClock<StepResult>(executeStep(
      'Send the message',
      { adapter, planner, verifier, plannerConfig: { maxActions: 3, maxPlanningTurns: 3, previousStepCount: 0 } },
      makeStepContext({ stepInstruction: 'Send the message' }),
    ))

    expect(log.map(e => e.frame)).toEqual(['TYPED', 'TYPED', 'TYPED', 'SENT', 'SENT'])
    expect(log[0].offsetFromSend).toBeUndefined()
    expect(log[1].offsetFromSend).toBeUndefined()
    expect(log[2].offsetFromSend).toBeLessThan(100)
    expect(log[3].at - log[2].at).toBe(VERIFY_SETTLE_INTERVAL_MS)
    expect(log[4].at - log[3].at).toBe(VERIFY_SETTLE_INTERVAL_MS)
    expect(log).toHaveLength(5)

    expect(result.status).toBe('passed')
    expect(executeCount()).toBe(1)
    expect(planner.failureContexts).toHaveLength(1)
    expect(verifier.calls).toHaveLength(1)
    expect(verifier.observesAtCall).toEqual([5])
    expect(verifyCall(verifier.calls[0]).after).toBe(log[4].state)
  })

  it('limit: an effect slower than the interval gives two identical uncleared frames, and the verifier rejects', async () => {
    const { adapter, log, executeCount } = makeSendAdapter(800)
    const verifier = makeMessageRowVerifier(() => log.length)
    const bail = makeActionPlan({ action: { type: 'reportValue', value: 'n/a' }, stepComplete: false, stepFailed: true })
    const planner = capturingPlanner([tapSend, bail])

    const result = await driveWithFakeClock<StepResult>(executeStep(
      'Send the message',
      { adapter, planner, verifier, plannerConfig: { maxActions: 3, maxPlanningTurns: 3, previousStepCount: 0 } },
      makeStepContext({ stepInstruction: 'Send the message' }),
    ))

    expect(log[2].frame).toBe('TYPED')
    expect(log[2].offsetFromSend).toBeLessThan(100)
    expect(log[3].frame).toBe('TYPED')
    expect(log[3].at - log[2].at).toBe(VERIFY_SETTLE_INTERVAL_MS)
    // The rejected completion at observe 4, then the give-up's own judgment over a fresh settle.
    expect(verifier.observesAtCall).toEqual([4, 9])
    expect(verifier.calls).toHaveLength(2)
    expect(result.evidence?.conditionVerdicts?.ending).toBe('give-up')
    expect(verifyCall(verifier.calls[0]).after).toBe(log[3].state)
    expect(hasMessageRow(verifyCall(verifier.calls[0]).after)).toBe(false)

    expect(planner.failureContexts).toHaveLength(2)
    expect(planner.failureContexts[1]).toContain('The text is still in the composer and no new message appears')
    expect(result.status).toBe('failed')
    expect(executeCount()).toBe(1)
  })

  it('bound: a screen that never settles takes 1 + MAX_POLLS observes, 500 ms apart, and verify judges the last', async () => {
    // Distinct words: normalizeAccessibleName drops digits, so "frame 1" and "frame 2" would hash alike.
    const words = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett']
    let n = 0
    let executedAtObserve = -1
    const log: ObserveEntry[] = []
    const adapter: PlatformAdapter = {
      platform: 'ios',
      async setup() {},
      async cleanup() {},
      async observe() {
        const state = buildAgentScreenState({
          platform: 'ios',
          elements: [{ ref: 'e2', role: 'button', name: words[n % words.length], bounds: { x: 0, y: 0, width: 50, height: 44 } }],
        })
        log.push({ index: log.length, offsetFromSend: undefined, frame: words[n % words.length], at: Date.now(), state })
        n++
        return state
      },
      async execute(): Promise<ActionResult> {
        executedAtObserve = log.length
        return { success: true }
      },
    }
    const verify = vi.fn(async (...args: unknown[]): Promise<VerifyResult> => ({
      verification: passed(args, 'done'),
    }))
    const observesAtVerify: number[] = []
    const verifier: Verifier = {
      verify: async (...args: unknown[]) => {
        observesAtVerify.push(log.length)
        return verify(...args)
      },
    }

    const result = await driveWithFakeClock<StepResult>(executeStep(
      'Tap the button',
      { adapter, planner: makePlanner([makeActionPlan({ action: { type: 'tap', ref: 'e2' } })]), verifier },
      makeStepContext(),
    ))

    const verifyPath = log.slice(executedAtObserve, observesAtVerify[0])
    expect(verifyPath).toHaveLength(1 + MAX_POLLS)
    expect(verifyPath.map(e => e.at - verifyPath[0].at)).toEqual([0, 500, 1000, 1500])
    expect(verify).toHaveBeenCalledTimes(1)
    expect(verifyCall(verify.mock.calls[0]).after).toBe(verifyPath[verifyPath.length - 1].state)
    expect(result.status).toBe('passed')
  })
})

describe('verifier author context carries the step position', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function ninthArgFor(overrides: Partial<StepContext>): Promise<unknown> {
    const verify = vi.fn(async (...args: unknown[]): Promise<VerifyResult> => ({
      verification: passed(args, 'done'),
    }))
    const result = await driveWithFakeClock<StepResult>(executeStep(
      'Click the Log in button',
      { adapter: makeAdapter(), planner: makePlanner([makeActionPlan()]), verifier: { verify } },
      makeStepContext(overrides),
    ))
    expect(result.status).toBe('passed')
    expect(verify).toHaveBeenCalledTimes(1)
    return verifyCall(verify.mock.calls[0]).authorContext
  }

  it('passes the position with the author context', async () => {
    expect(await ninthArgFor({ testContext: 'T', stepNumber: 2, stepCount: 3 }))
      .toEqual({ testContext: 'T', stepNumber: 2, stepCount: 3 })
  })

  it('passes undefined for a position without author context', async () => {
    expect(await ninthArgFor({ stepNumber: 2, stepCount: 3 })).toBeUndefined()
  })
})
