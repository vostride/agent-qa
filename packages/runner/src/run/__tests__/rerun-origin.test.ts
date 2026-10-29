import { describe, expect, it, vi } from 'vitest'
import type { LanguageModel } from 'ai'
import { runMemberTest } from '../member-runner.js'
import type { MemberRunConfig } from '../member-runner.js'
import type { StepResult, TestResult } from '../../result.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'

function fixture(statuses: StepResult['status'][], retries: number) {
  const execute = vi.fn(async () => ({ success: true }))
  const scheduled = vi.fn()
  const planner = { plan: vi.fn() }
  const steps = statuses.map((status, index): StepResult => ({
    name: `attempt ${index}`,
    status,
    duration: index + 1,
    ...(status === 'failed' ? { error: `failure ${index}` } : {}),
    trace: {
      observation: `observed ${index}`,
      reasoning: `reason ${index}`,
      plannedAction: { type: 'navigate', to: 'url', url: `https://example.test/${index}` },
      result: status === 'failed' ? 'failure' : 'success',
      screenStateBefore: `screen ${index}`,
    },
  }))
  let index = 0
  const config: MemberRunConfig = {
    adapter: { platform: 'web', setup: async () => {}, cleanup: async () => {},
      observe: async () => makeScreenState(), execute },
    planner,
    plannerModel: {} as LanguageModel,
    verifierModel: {} as LanguageModel,
    sink: { stepStarted() {}, hookStarted() {}, hookFinished() {},
      loopEmitFor: () => ({ stepFinalized() {}, subActionRecorded() {} }),
      testRetryScheduled: scheduled },
    testIndex: 2,
    abortSignal: new AbortController().signal,
    executeStep: async () => steps[index++],
  }
  return { steps, scheduled, planner, execute, run: () => runMemberTest({
    testId: 'retry fixture', name: 'Retry fixture', filePath: 'retry.yaml',
    url: 'https://example.test', steps: ['Visit page'], meta: { retries },
  }, config) }
}

// Structural view lets RED exercise the existing runtime before the additive DTO exists.
type WithOrigin = TestResult & {
  firstFailedAttempt?: { attempt: number; result: TestResult }
}

describe('retry origin', () => {
  it('retains the first failure through differing failures and a successful final attempt', async () => {
    const f = fixture(['failed', 'failed', 'passed'], 2)
    const result: WithOrigin = await f.run()
    expect(result.firstFailedAttempt?.attempt).toBe(0)
    expect(result.firstFailedAttempt?.result.steps[0].error).toBe('failure 0')
    expect(result.firstFailedAttempt?.result.failureSummary).toContain('failure 0')
    expect(result.firstFailedAttempt?.result).not.toHaveProperty('firstFailedAttempt')
    expect(result).toMatchObject({ status: 'passed', retryCount: 2, steps: [f.steps[2]] })
    expect(result.duration).toBeGreaterThanOrEqual(result.firstFailedAttempt!.result.duration)
    expect(f.scheduled.mock.calls.map(([event]) => event.attempt)).toEqual([1, 2])
    expect(f.execute).toHaveBeenCalledTimes(3)
    expect(f.planner.plan).not.toHaveBeenCalled()
    f.steps[0].trace!.reasoning = 'later mutation'
    result.steps[0].trace!.reasoning = 'final mutation'
    expect(result.firstFailedAttempt!.result.steps[0].trace!.reasoning).toBe('reason 0')
  })

  it('retains the first failure when retries are exhausted', async () => {
    const result: WithOrigin = await fixture(['failed', 'failed', 'failed'], 2).run()
    expect(result.firstFailedAttempt?.result.steps[0].error).toBe('failure 0')
    expect(result).toMatchObject({ status: 'failed', retryCount: 2 })
    expect(result.steps[0].error).toBe('failure 2')
    expect(JSON.stringify(result).match(/firstFailedAttempt/g)).toHaveLength(1)
  })

  it.each(['passed', 'failed'] as const)('omits origin on ordinary %s runs', async (status) => {
    expect(await fixture([status], 0).run()).not.toHaveProperty('firstFailedAttempt')
  })

  it('omits origin when the first attempt succeeds with retries available', async () => {
    const f = fixture(['passed'], 3)
    expect(await f.run()).not.toHaveProperty('firstFailedAttempt')
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.scheduled).not.toHaveBeenCalled()
  })
})
