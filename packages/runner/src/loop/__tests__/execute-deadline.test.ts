import { describe, expect, it } from 'vitest'
import type { Action, ExecuteOptions, PlatformAdapter } from '../../platform.js'
import type { LoopPorts } from '../ports.js'
import { executeStep } from '../index.js'
import { makeAdapter, makePlanner, makeStepContext, makeVerifier } from './loop-harness.js'

function recordingAdapter(): { adapter: PlatformAdapter; calls: unknown[][] } {
  const calls: unknown[][] = []
  const base = makeAdapter()
  const adapter: PlatformAdapter = {
    ...base,
    async execute(action: Action, options?: ExecuteOptions) {
      calls.push([action, options])
      return base.execute(action)
    },
  }
  return { adapter, calls }
}

async function runOnce(overrides: Partial<LoopPorts>): Promise<unknown[][]> {
  const { adapter, calls } = recordingAdapter()
  const result = await executeStep(
    'Click the Log in button',
    { adapter, planner: makePlanner(), verifier: makeVerifier(), ...overrides },
    makeStepContext(),
  )
  expect(result.status).toBe('passed')
  expect(calls).toHaveLength(1)
  return calls
}

describe('the time left to the step deadline reaches execute', () => {
  it('the loop hands execute the time left to the step deadline and the abort signal', async () => {
    const controller = new AbortController()
    const [[, options]] = await runOnce({ stepTimeout: 5_000, abortSignal: controller.signal })

    const handed = options as ExecuteOptions | undefined
    expect(handed?.abortSignal).toBe(controller.signal)
    expect(Number.isInteger(handed?.remainingStepMs)).toBe(true)
    expect(handed!.remainingStepMs!).toBeGreaterThan(0)
    expect(handed!.remainingStepMs!).toBeLessThanOrEqual(5_000)
  })

  it('without a step deadline execute gets no remaining time', async () => {
    for (const overrides of [{ stepTimeout: 0 }, {}] satisfies Partial<LoopPorts>[]) {
      const [[, options]] = await runOnce(overrides)
      expect(JSON.stringify(options ?? {})).toBe('{}')
    }
  })
})
