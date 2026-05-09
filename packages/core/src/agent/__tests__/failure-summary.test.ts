import { describe, expect, it } from 'vitest'
import { generateFailureSummary } from '../failure-summary.js'
import type { StepResult, StepTrace } from '../../types/result.js'

function makeTrace(overrides: Partial<StepTrace> = {}): StepTrace {
  return {
    observation: 'page content',
    reasoning: 'The current page URL does not match the expected URL.',
    plannedAction: { type: 'assert', condition: 'URL equals expected value' },
    result: 'failure',
    error: 'Assertion failed',
    screenStateBefore: 'Example Domain page',
    cached: false,
    ...overrides,
  } as StepTrace
}

function makeStep(overrides: Partial<StepResult> = {}): StepResult {
  return {
    name: 'Verify URL',
    status: 'failed',
    duration: 100,
    error: 'Step failed: The current page URL does not match the expected URL.',
    trace: makeTrace(),
    ...overrides,
  }
}

describe('generateFailureSummary', () => {
  it('suppresses agent reasoning when assertion error and reasoning match', () => {
    const reason = 'The current page URL does not match the expected URL.'
    const summary = generateFailureSummary([
      makeStep({
        error: reason,
        trace: makeTrace({ reasoning: reason }),
      }),
    ])

    expect(summary).toContain(`Step 1/1 "Verify URL" failed: ${reason}`)
    expect(summary).not.toContain('Agent reasoning:')
  })

  it('suppresses matching reasoning when the error is prefixed with Step failed', () => {
    const reason = 'The current page URL does not match the expected URL.'
    const summary = generateFailureSummary([
      makeStep({
        error: `Step failed:   ${reason}`,
        trace: makeTrace({ reasoning: reason }),
      }),
    ])

    expect(summary).toContain(`Step 1/1 "Verify URL" failed: Step failed:   ${reason}`)
    expect(summary).not.toContain('Agent reasoning:')
  })

  it('preserves distinct agent reasoning', () => {
    const summary = generateFailureSummary([
      makeStep({
        error: 'Element not found',
        trace: makeTrace({ reasoning: 'The checkout panel never opened' }),
      }),
    ])

    expect(summary).toContain('Step 1/1 "Verify URL" failed: Element not found')
    expect(summary).toContain('Agent reasoning: The checkout panel never opened')
  })

  it('keeps the attempted action line for planned assertions', () => {
    const summary = generateFailureSummary([
      makeStep({
        error: 'Expected page title to match',
        trace: makeTrace({
          reasoning: 'The title assertion failed',
          plannedAction: { type: 'assert', condition: 'title is Example Domain' },
        }),
      }),
    ])

    expect(summary).toContain('Attempted action: assert')
  })

  it('prints healing attempt counts', () => {
    const summary = generateFailureSummary([
      makeStep({
        healingAttempts: [
          {
            action: { type: 'click', ref: 'learn-more' },
            observationBefore: 'link visible',
            success: false,
          },
        ],
      }),
    ])

    expect(summary).toContain('1 healing attempt(s) were tried before giving up.')
  })

  it('prints total failed step count when multiple steps fail', () => {
    const summary = generateFailureSummary([
      makeStep({ name: 'First failure' }),
      makeStep({ name: 'Second failure', error: 'Another failure' }),
    ])

    expect(summary).toContain('Step 1/2 "First failure" failed:')
    expect(summary).toContain('(2 steps failed in total)')
  })
})
