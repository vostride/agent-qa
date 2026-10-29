// HARN-01 / D-15 / D-27: screen equality or change decides nothing in executeStep. Legitimate
// repetition on a screen whose screenIdentityHash never changes runs to completion, and the only
// re-dispatch after an execution error is the planner's own next plan.
import { describe, expect, it } from 'vitest'
import { asRef, screenIdentityHash } from '@vostride/agent-qa-schema'
import type { ElementInfo, ScreenState } from '@vostride/agent-qa-schema'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'
import { executeStep } from '../index.js'
import type { LoopPorts } from '../ports.js'
import type { ActionPlan, Planner, Verifier } from '../types.js'
import { makeActionPlan, makeStepContext } from './loop-harness.js'

function el(ref: string, role: string, name: string, y: number): ElementInfo {
  const bounds = { x: 20, y, width: 350, height: 44 }
  return {
    ref: asRef(ref),
    role,
    name,
    nameNormalized: name.toLowerCase(),
    bounds,
    center: { x: 195, y: y + 22 },
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  }
}

function screen(elements: ElementInfo[]): ScreenState {
  const refMap: ScreenState['refMap'] = {}
  for (const element of elements) {
    refMap[element.ref] = { bounds: element.bounds!, center: element.center! }
  }
  return makeScreenState({
    url: 'https://counter.test/',
    tree: elements.map((e) => `- ${e.role} "${e.name}" [ref=${e.ref}]`).join('\n'),
    elements,
    refMap,
  })
}

const COUNTER_SCREEN = screen([el('e1', 'button', 'Increment', 120)])
const DELETE_ROWS_SCREEN = screen(
  ['e1', 'e2', 'e3', 'e4', 'e5'].map((ref, i) => el(ref, 'button', 'Delete', 100 + i * 60)),
)

interface Trace {
  events: string[]
  executed: Action[]
  observedHashes: string[]
}

function unchangingAdapter(
  state: ScreenState,
  trace: Trace,
  results?: ActionResult[],
): PlatformAdapter {
  let executeCall = 0
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      const fresh = structuredClone(state)
      trace.observedHashes.push(screenIdentityHash(fresh))
      return fresh
    },
    async execute(action: Action): Promise<ActionResult> {
      trace.events.push('execute')
      trace.executed.push(action)
      const result = results?.[Math.min(executeCall, results.length - 1)] ?? { success: true }
      executeCall++
      return result
    },
  }
}

function scriptedPlanner(plans: ActionPlan[], trace: Trace): Planner {
  let call = 0
  return {
    async plan() {
      trace.events.push('plan')
      const plan = plans[Math.min(call, plans.length - 1)]
      call++
      return { plan }
    },
  }
}

function passingVerifier(trace: Trace): Verifier {
  return {
    async verify(step, _before, after, action) {
      trace.events.push('verify')
      return {
        verification: scriptedVerification({
          step,
          after,
          action,
          pass: true,
          reasoning: 'Requested outcome observed',
        }),
      }
    },
  }
}

function newTrace(): Trace {
  return { events: [], executed: [], observedHashes: [] }
}

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return { plannerConfig: { maxActions: 20, maxPlanningTurns: 20, previousStepCount: 0 }, ...overrides }
}

function pressPlans(refs: string[]): ActionPlan[] {
  return refs.map((ref, i) =>
    makeActionPlan({
      reasoning: `Press ${ref} (${i + 1} of ${refs.length})`,
      action: { type: 'click', ref },
      stepComplete: i === refs.length - 1,
    }),
  )
}

type StepRun = { trace: Trace; result: Awaited<ReturnType<typeof executeStep>> }

async function runFivePresses(): Promise<StepRun> {
  const trace = newTrace()
  const result = await executeStep(
    'Press Increment five times',
    ports({
      adapter: unchangingAdapter(COUNTER_SCREEN, trace),
      planner: scriptedPlanner(pressPlans(['e1', 'e1', 'e1', 'e1', 'e1']), trace),
      verifier: passingVerifier(trace),
    }),
    makeStepContext({ stepInstruction: 'Press Increment five times' }),
  )
  return { trace, result }
}

describe('repeated actions on an unchanged screen', () => {
  it('five presses on an unchanged screen dispatch five times and pass', async () => {
    const { trace, result } = await runFivePresses()

    expect(new Set(trace.observedHashes).size).toBe(1)
    expect(trace.executed).toHaveLength(5)
    const refs = trace.executed.map((a) => `${a.type}:${(a as { ref?: string }).ref}`)
    expect(refs).toEqual(['click:e1', 'click:e1', 'click:e1', 'click:e1', 'click:e1'])
    expect(trace.events.filter((e) => e === 'verify')).toHaveLength(1)
    expect(result.status).toBe('passed')
  })

  it('the same step run twice dispatches five times each run', async () => {
    const first = await runFivePresses()
    const second = await runFivePresses()

    expect(first.trace.executed).toHaveLength(5)
    expect(second.trace.executed).toHaveLength(5)
    expect(second.trace.executed).toEqual(first.trace.executed)
    expect(first.result.status).toBe('passed')
    expect(second.result.status).toBe('passed')
  })

  it('five same-label rows are each pressed once', async () => {
    const trace = newTrace()
    const refs = ['e1', 'e2', 'e3', 'e4', 'e5']
    const result = await executeStep(
      'Delete every row',
      ports({
        adapter: unchangingAdapter(DELETE_ROWS_SCREEN, trace),
        planner: scriptedPlanner(pressPlans(refs), trace),
        verifier: passingVerifier(trace),
      }),
      makeStepContext({ stepInstruction: 'Delete every row' }),
    )

    expect(new Set(trace.observedHashes).size).toBe(1)
    expect(trace.executed.map((a) => (a as { ref?: string }).ref)).toEqual(refs)
    expect(result.status).toBe('passed')
  })

  it('an action that leaves the screen equal is never re-dispatched by the loop', async () => {
    const trace = newTrace()
    const plans = [
      makeActionPlan({ action: { type: 'click', ref: 'e1' }, stepComplete: false }),
      makeActionPlan({ action: { type: 'click', ref: 'e1' }, stepComplete: false }),
      makeActionPlan({ action: { type: 'click', ref: 'e1' }, stepComplete: true }),
    ]
    const result = await executeStep(
      'Press Increment three times',
      ports({
        adapter: unchangingAdapter(COUNTER_SCREEN, trace),
        planner: scriptedPlanner(plans, trace),
        verifier: passingVerifier(trace),
      }),
      makeStepContext({ stepInstruction: 'Press Increment three times' }),
    )

    const planned = trace.events.filter((e) => e === 'plan').length
    expect(planned).toBe(3)
    expect(trace.executed).toHaveLength(planned)
    expect(trace.events).toEqual([
      'plan', 'execute', 'plan', 'execute', 'plan', 'execute', 'verify',
    ])
    expect(result.status).toBe('passed')
  })

  it('a planner-chosen repeat after an actual execution error is the only retry', async () => {
    const trace = newTrace()
    const plans = [
      makeActionPlan({ action: { type: 'click', ref: 'e1' }, stepComplete: true }),
      makeActionPlan({
        reasoning: 'The press errored; pressing again',
        action: { type: 'click', ref: 'e1' },
        stepComplete: true,
      }),
    ]
    const result = await executeStep(
      'Press Increment once',
      ports({
        adapter: unchangingAdapter(COUNTER_SCREEN, trace, [
          { success: false, error: 'Element is disabled' },
          { success: true },
        ]),
        planner: scriptedPlanner(plans, trace),
        verifier: passingVerifier(trace),
      }),
      makeStepContext({ stepInstruction: 'Press Increment once' }),
    )

    expect(trace.events).toEqual(['plan', 'execute', 'plan', 'execute', 'verify'])
    expect(trace.executed).toHaveLength(2)
    expect(result.status).toBe('passed')
  })
})
