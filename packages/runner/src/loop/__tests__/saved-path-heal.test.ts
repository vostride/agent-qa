import { describe, expect, it } from 'vitest'
import type { CachedPlanValue } from '../../cache/port.js'
import type { StepResult, TestResult } from '../../result.js'
import { deriveMemberOutcome } from '../../run/verdict.js'
import {
  CLICK_SAVE,
  FILL_EMAIL,
  FILL_NAME,
  forgetCalls,
  recordingCache,
  runStep,
  scriptedPlanner,
} from './fixtures/saved-path.js'
import type { RecordingCache } from './fixtures/saved-path.js'

function outcomeOf(step: StepResult) {
  const test: TestResult = {
    name: 'save a contact',
    filePath: 'save-a-contact.test.yaml',
    status: step.status === 'passed' ? 'passed' : 'failed',
    steps: [step],
    duration: 1,
  }
  return deriveMemberOutcome(test)
}

async function savedThreeTurnPath(): Promise<{ cache: RecordingCache; keys: string[] }> {
  const cache = recordingCache()
  const first = await runStep({ cache, planner: scriptedPlanner([FILL_NAME, FILL_EMAIL, CLICK_SAVE]) })
  expect(first.status).toBe('passed')
  const keys = [...cache.sets]
  expect(new Set(keys).size).toBe(3)
  forgetCalls(cache)
  return { cache, keys }
}

describe('healed means a saved path failed and was repaired', () => {
  it('a replayed cached action that fails and is repaired ends healed', async () => {
    const { cache, keys } = await savedThreeTurnPath()

    const step = await runStep({
      cache,
      planner: scriptedPlanner([FILL_NAME]),
      results: [{ success: false, error: 'The field did not take the text' }],
    })

    expect(step.status).toBe('passed')
    expect(step.evidence!.subActions[0].plan).toBe('Replayed from cache')
    expect(step.evidence!.subActions[0].result.success).toBe(false)
    expect(step.evidence!.selfHeal).toBeDefined()
    expect(outcomeOf(step)).toBe('healed')
    expect(cache.invalidated).toEqual([keys[0]])
  })

  it('a cached entry that can never replay is a plain miss that ends passed', async () => {
    const { cache, keys } = await savedThreeTurnPath()
    cache.store.set(keys[0], {
      plannedActions: [{ type: 'tapCoordinate', x: 195, y: 142 }],
      groundedLocator: [],
      completesStep: false,
    } as unknown as CachedPlanValue)

    const step = await runStep({ cache, planner: scriptedPlanner([FILL_NAME]) })

    expect(step.status).toBe('passed')
    expect(step.evidence!.cacheStatus).toBe('miss')
    expect(step.evidence!.cacheMiss?.reason).toBe('non-replayable')
    expect(step.evidence!.selfHeal).toBeUndefined()
    expect(outcomeOf(step)).toBe('passed')
  })
})
