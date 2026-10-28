import { describe, expect, it } from 'vitest'
import type { StepEvidence } from '@vostride/agent-qa-schema'
import type { StepResult, TestResult } from '../../result.js'
import { deriveAggregateVerdict, deriveMemberOutcome } from '../verdict.js'
import { executeStep } from '../../loop/index.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import {
  makeActionPlan,
  makeAdapter,
  makePlanner,
  makeStepContext,
  makeVerifier,
} from '../../loop/__tests__/loop-harness.js'
import { ports, recordingCache } from '../../loop/__tests__/fixtures/saved-path.js'

const STEP = 'Add the mug to the bag'

function settled(cacheStatus: StepEvidence['cacheStatus']): StepResult {
  return {
    name: 'a step',
    status: 'passed',
    duration: 1,
    evidence: { cacheStatus } as StepEvidence,
  }
}

function sixStepTest(step2: StepResult): TestResult {
  return {
    name: 'buy a mug',
    filePath: 'buy-a-mug.test.yaml',
    status: 'passed',
    steps: [
      settled('hit'),
      settled('miss'),
      step2,
      settled('hit'),
      settled('bypass'),
      settled('bypass'),
    ],
    duration: 1,
  }
}

describe('a step with no saved path that recovers ends passed', () => {
  it('a step with no saved path whose first action fails and whose next action passes ends passed, and so do its test and run', async () => {
    const cache = recordingCache()
    const adapter = makeAdapter({
      observeResults: [
        makeScreenState({ url: 'https://shop.test/mug' }),
        makeScreenState({ url: 'https://shop.test/mug' }),
        makeScreenState({ url: 'https://shop.test/bag' }),
      ],
      executeResults: [{ success: false, error: 'not found' }, { success: true }],
    })
    const planner = makePlanner([
      makeActionPlan({ reasoning: 'Press the add button', action: { type: 'click', ref: 'e1' } }),
      makeActionPlan({ reasoning: 'Press Add to bag', action: { type: 'click', ref: 'e2' } }),
    ])

    const step = await executeStep(
      STEP,
      ports({ adapter, planner, verifier: makeVerifier(), cache }),
      makeStepContext({ stepInstruction: STEP }),
    )

    expect(cache.gets.every((get) => !get.hit)).toBe(true)
    expect(step.status).toBe('passed')
    expect(step.evidence!.cacheStatus).toBe('miss')
    expect(step.evidence!.selfHeal).toBeUndefined()
    const [failed, recovering] = step.evidence!.subActions
    expect(failed.result.success).toBe(false)
    expect(failed.plan).toBe('Press the add button')
    expect(recovering.result.success).toBe(true)

    const test = sixStepTest(step)
    expect(deriveMemberOutcome(test)).toBe('passed')
    expect(deriveAggregateVerdict({ runCancelled: false, outcomes: ['passed'] })).toBe('passed')
  })

  it('a step with no saved path whose first completion claim is rejected ends passed', async () => {
    const cache = recordingCache()
    const adapter = makeAdapter({
      observeResults: [
        makeScreenState({ url: 'https://shop.test/mug' }),
        makeScreenState({ url: 'https://shop.test/mug' }),
        makeScreenState({ url: 'https://shop.test/mug-added' }),
        makeScreenState({ url: 'https://shop.test/bag' }),
      ],
    })
    const planner = makePlanner([
      makeActionPlan({ reasoning: 'Press the add button', action: { type: 'click', ref: 'e1' } }),
      makeActionPlan({ reasoning: 'Open the bag', action: { type: 'click', ref: 'e2' } }),
    ])
    const verifier = makeVerifier([
      { success: false, reasoning: 'The bag is not shown' },
      { success: true, reasoning: 'The bag holds one mug' },
    ])

    const step = await executeStep(
      STEP,
      ports({ adapter, planner, verifier, cache }),
      makeStepContext({ stepInstruction: STEP }),
    )

    expect(step.status).toBe('passed')
    expect(step.evidence!.selfHeal).toBeUndefined()
    const [rejected, recovering] = step.evidence!.subActions
    expect(rejected.plan).toBe('Press the add button')
    expect(rejected.stateAfter).toEqual(recovering.stateBefore)
    expect(deriveMemberOutcome(sixStepTest(step))).toBe('passed')
  })
})
