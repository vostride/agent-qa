// 2026-10-09 (437-17, D-05, CR-01): a skipped toggle tap reaches the live editor as its own
// outcome. The live editor reads only `result`, so a binary value there paints a correct skip as
// a red failure that invites the retry which flips the toggle.

import { describe, expect, it } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import type { StepResult, SubActionTrace } from '@vostride/agent-qa-runner'
import { toLiveSubActionData } from '../live-session.js'

function subAction(index: number, overrides: Partial<SubActionTrace>): SubActionTrace {
  return {
    index,
    observation: 'Wi-Fi switch',
    reasoning: 'turn Wi-Fi on',
    plannedAction: { type: 'tap', ref: asRef('e3') },
    result: 'success',
    screenStateBefore: 'tree',
    cached: false,
    ...overrides,
  }
}

function stepWith(subActions: SubActionTrace[]): StepResult {
  return {
    name: 'turn Wi-Fi on',
    status: 'passed',
    duration: 10,
    trace: {
      observation: 'Wi-Fi switch',
      reasoning: 'turn Wi-Fi on',
      plannedAction: { type: 'tap', ref: asRef('e3') },
      result: 'success',
      screenStateBefore: 'tree',
      subActions,
    },
  }
}

const skipped = (index: number) =>
  subAction(index, { result: 'no-input', noInputSent: { currentState: 'checked' } })

describe('C437-NO-INPUT-LABEL', () => {
  it('the live editor data carries a skipped tap as no-input', () => {
    const [once] = toLiveSubActionData(stepWith([skipped(0)]))!
    expect(once!.result).toBe('no-input')
    expect(once!.error).toBeUndefined()

    const twice = toLiveSubActionData(stepWith([skipped(0), skipped(1)]))!
    expect(twice.map((sub) => sub.result)).toEqual(['no-input', 'no-input'])
    expect(twice.every((sub) => sub.error === undefined)).toBe(true)
  })

  it('the live editor data keeps success and failure unchanged', () => {
    const data = toLiveSubActionData(
      stepWith([
        subAction(0, { result: 'success' }),
        subAction(1, { result: 'failure', error: 'element not found' }),
      ]),
    )!
    expect(data.map((sub) => sub.result)).toEqual(['success', 'failure'])
    expect(data[0]!.error).toBeUndefined()
    expect(data[1]!.error).toBe('element not found')
  })
})
