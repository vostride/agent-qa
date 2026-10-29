// the loop is bounded ONLY by the per-step action limit, the user
// timeouts/abort, and the verdict — there is no attempt counter (Pitfall 5's regression
// lock). An always-failing adapter must terminate cleanly at the action limit.
import { describe, it, expect } from 'vitest'
import type { LoopPorts } from '../ports.js'
import type { Planner } from '../types.js'
import { executeStep } from '../index.js'
import { createTimeoutAbortReason } from '../abort.js'
import { makeActionPlan, makeAdapter, makePlanner, makeStepContext } from './loop-harness.js'

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

describe('loop bounds', () => {
  it('an always-failing adapter terminates at the action limit with a failed result and no counter', async () => {
    let planCalls = 0
    const planner: Planner = {
      async plan() { planCalls++; return { plan: makeActionPlan({ stepComplete: false }) } },
    }
    const result = await executeStep(
      'Do something that always fails',
      ports({
        adapter: makeAdapter({ executeResult: { success: false, error: 'Always fails' } }),
        planner,
        plannerConfig: { maxActions: 5, maxPlanningTurns: 5, previousStepCount: 0 },
      }),
      makeStepContext(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toBe('Stopped: action limit reached — 5 of 5 actions used')
    // Each failed dispatch is one action, so the loop replanned exactly maxActions times —
    // bounded by the limit, not a consecutive-failure counter (which would have bailed at 3).
    expect(planCalls).toBe(5)
  })

  it('a never-completing successful adapter also terminates at the action limit', async () => {
    let planCalls = 0
    const planner: Planner = {
      async plan() { planCalls++; return { plan: makeActionPlan({ stepComplete: false }) } },
    }
    const result = await executeStep(
      'Loop forever',
      ports({ adapter: makeAdapter({ executeResult: { success: true } }), planner, plannerConfig: { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 } }),
      makeStepContext(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toBe('Stopped: action limit reached — 4 of 4 actions used')
    expect(planCalls).toBe(4)
  })

  it('a pre-aborted (timeout) signal returns the v1 timeout-reason failure', async () => {
    const controller = new AbortController()
    controller.abort(createTimeoutAbortReason('step', 30))
    const result = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter(), planner: makePlanner(), abortSignal: controller.signal }),
      makeStepContext(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toBe('Step timed out after 30ms')
  })

  it('a pre-aborted (cancel) signal returns cancelled without calling the planner', async () => {
    const controller = new AbortController()
    controller.abort(new Error('User cancelled'))
    let planCalls = 0
    const planner: Planner = { async plan() { planCalls++; return { plan: makeActionPlan() } } }
    const result = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter(), planner, abortSignal: controller.signal }),
      makeStepContext(),
    )
    expect(result.status).toBe('cancelled')
    expect(result.error).toBe('The run was cancelled before this step finished.')
    expect(planCalls).toBe(0)
  })

  it('a timeout abort raised during the planner call cannot be converted to passed', async () => {
    const controller = new AbortController()
    const planner: Planner = {
      async plan(_step, _screen, _context, abortSignal) {
        return new Promise((resolve, reject) => {
          abortSignal?.addEventListener('abort', () => reject(new Error('planner aborted')), { once: true })
          setTimeout(() => controller.abort(createTimeoutAbortReason('step', 30)), 5)
          setTimeout(() => resolve({ plan: makeActionPlan() }), 100)
        })
      },
    }
    const result = await executeStep('Click Log in', ports({ adapter: makeAdapter(), planner, abortSignal: controller.signal }), makeStepContext())
    expect(result.status).toBe('failed')
    expect(result.error).toBe('Step timed out after 30ms')
  })
})
