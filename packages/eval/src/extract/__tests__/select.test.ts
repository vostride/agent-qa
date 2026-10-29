import { describe, expect, it } from 'vitest'
import { makeV2Handoff } from '../../__tests__/fixtures/handoff-fixtures'
import { classifySubAction, collectStepSelections } from '../select'

describe('sub-action selection', () => {
  it('classifies non-empty and empty exchange arrays as live decisions', () => {
    const handoff = makeV2Handoff()
    const nonEmpty = handoff.tests[0]!.steps[0]!.subActions[0]!
    const empty = handoff.tests[0]!.steps[1]!.subActions[1]!

    expect(classifySubAction(nonEmpty)).toBe('extract')
    expect(classifySubAction(empty)).toBe('extract')
  })

  it('classifies structurally absent exchanges as a cache hit', () => {
    const cached = makeV2Handoff().tests[0]!.steps[1]!.subActions[0]!

    expect(Object.hasOwn(cached, 'exchanges')).toBe(false)
    expect(classifySubAction(cached)).toBe('cache-hit')
  })

  it('keeps recorded array ordinals while returning typed cache-hit skips', () => {
    const handoffTest = makeV2Handoff().tests[0]!
    const step = handoffTest.steps[1]!

    expect(collectStepSelections({ handoffTest, step })).toEqual({
      selections: [
        {
          testId: handoffTest.testId,
          testIndex: handoffTest.testIndex,
          stepIndex: step.stepIndex,
          decisionOrdinal: 1,
          subAction: step.subActions[1],
        },
      ],
      skips: [
        {
          testId: handoffTest.testId,
          testIndex: handoffTest.testIndex,
          stepIndex: step.stepIndex,
          decisionOrdinal: 0,
          reason: 'cache-hit',
        },
      ],
    })
  })

  it('returns one actionless skip for synthesized and planning-failure-only steps', () => {
    const handoff = makeV2Handoff()
    const cases = [
      { handoffTest: handoff.tests[0]!, step: handoff.tests[0]!.steps[2]! },
      { handoffTest: handoff.tests[1]!, step: handoff.tests[1]!.steps[1]! },
    ]

    for (const current of cases) {
      expect(collectStepSelections(current)).toEqual({
        selections: [],
        skips: [
          {
            testId: current.handoffTest.testId,
            testIndex: current.handoffTest.testIndex,
            stepIndex: current.step.stepIndex,
            reason: 'actionless',
          },
        ],
      })
    }
  })

  it('selects live decisions even when their recorded verifier verdict failed', () => {
    const handoffTest = makeV2Handoff().tests[1]!
    const step = handoffTest.steps[0]!

    expect(step.verifierVerdict.pass).toBe(false)
    expect(collectStepSelections({ handoffTest, step }).selections).toHaveLength(1)
    expect(collectStepSelections({ handoffTest, step }).skips).toEqual([])
  })
})
