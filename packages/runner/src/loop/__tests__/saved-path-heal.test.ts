import { describe, expect, it } from 'vitest'
import type { ElementInfo, ScreenState } from '@vostride/agent-qa-schema'
import type { CachedPlanValue } from '../../cache/port.js'
import type { StepResult, TestResult } from '../../result.js'
import { deriveMemberOutcome } from '../../run/verdict.js'
import { makeActionPlan, makeVerifier } from './loop-harness.js'
import {
  CLICK_SAVE,
  FILL_EMAIL,
  FILL_NAME,
  el,
  forgetCalls,
  formScreens,
  recordingCache,
  runStep,
  screen,
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

const CONFIRM_SAVED = makeActionPlan({
  reasoning: 'Open the saved contact',
  action: { type: 'click', ref: 'e1' },
  stepComplete: true,
})

function rejectOnceVerifier() {
  return makeVerifier([
    { success: false, reasoning: 'The saved contact is not shown' },
    { success: true, reasoning: 'The contact is saved' },
  ])
}

// The screen identity hashes nameNormalized and the strict re-find compares the name, so a
// renamed element whose nameNormalized is kept leaves the cache key unchanged.
function renamed(element: ElementInfo, name: string): ElementInfo {
  return { ...element, name }
}

function draftScreens(buttons: ElementInfo[]): ScreenState[] {
  return [
    screen('https://notes.test/draft', [el('e1', 'textbox', 'Title', 120, 'Plan'), ...buttons]),
    screen('https://notes.test/saved', [el('e1', 'heading', 'Draft saved', 80)]),
  ]
}

const CLICK_SECOND = makeActionPlan({
  reasoning: 'Save the draft',
  action: { type: 'click', ref: 'e2' },
  stepComplete: true,
})

async function savedOneTurnPath(
  screens: ScreenState[],
): Promise<{ cache: RecordingCache; key: string }> {
  const cache = recordingCache()
  const first = await runStep({ cache, screens, planner: scriptedPlanner([CLICK_SECOND]) })
  expect(first.status).toBe('passed')
  expect(cache.sets).toHaveLength(1)
  const key = cache.sets[0]
  forgetCalls(cache)
  return { cache, key }
}

async function savedThreeTurnPath(): Promise<{ cache: RecordingCache; keys: string[] }> {
  const cache = recordingCache()
  const first = await runStep({
    cache,
    planner: scriptedPlanner([FILL_NAME, FILL_EMAIL, CLICK_SAVE]),
  })
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

  it('a cached replay the verifier rejects is invalidated, every replayed turn with it, and the repaired step reads healed', async () => {
    const { cache, keys } = await savedThreeTurnPath()

    const step = await runStep({
      cache,
      planner: scriptedPlanner([CONFIRM_SAVED]),
      verifier: rejectOnceVerifier(),
    })

    expect(step.status).toBe('passed')
    expect(cache.gets.map((get) => get.hit)).toEqual([true, true, true, false])
    expect(cache.invalidated).toEqual(keys)
    expect(step.evidence!.selfHeal).toBeDefined()
    expect(outcomeOf(step)).toBe('healed')
    const liveKey = cache.gets[3].key
    expect(new Set(cache.sets)).toEqual(new Set([...keys, liveKey]))
    expect(cache.store.get(liveKey)!.completesStep).toBe(true)
    expect(keys.map((key) => cache.store.get(key)!.completesStep)).toEqual([false, false, false])
  })

  it('a claim a live turn makes after replayed turns is not a saved-path failure', async () => {
    const { cache } = await savedThreeTurnPath()

    const step = await runStep({
      cache,
      screens: formScreens(true),
      planner: scriptedPlanner([CLICK_SAVE, CONFIRM_SAVED]),
      verifier: rejectOnceVerifier(),
    })

    expect(step.status).toBe('passed')
    expect(cache.gets.slice(0, 3).map((get) => get.hit)).toEqual([true, true, false])
    expect(cache.invalidated).toEqual([])
    expect(step.evidence!.selfHeal).toBeUndefined()
  })

  it('a cached target that is gone from the page makes the repair read healed', async () => {
    const saveDraft = el('e2', 'button', 'Save draft', 240)
    const { cache, key } = await savedOneTurnPath(draftScreens([saveDraft]))
    const planner = scriptedPlanner([CLICK_SECOND])

    const step = await runStep({
      cache,
      screens: draftScreens([renamed(saveDraft, 'Save Draft')]),
      planner,
    })

    expect(cache.gets[0]).toEqual({ key, hit: true })
    expect(step.evidence!.cacheMiss?.reason).toBe('strict-absent')
    expect(cache.invalidated[0]).toBe(key)
    expect(planner.calls).toBe(1)
    expect(step.status).toBe('passed')
    expect(step.evidence!.selfHeal).toBeDefined()
    expect(step.evidence!.selfHeal!.failedDecision.plan).toBe('Replayed from cache')
    expect(step.evidence!.selfHeal!.failedDecision.result.success).toBe(false)
    expect(outcomeOf(step)).toBe('healed')
  })

  it('a cached target that is no longer unique makes the repair read healed', async () => {
    const save = el('e2', 'button', 'Save', 240)
    const saveAs = el('e3', 'button', 'Save as', 300)
    const { cache, key } = await savedOneTurnPath(draftScreens([save, saveAs]))

    const step = await runStep({
      cache,
      screens: draftScreens([save, renamed(saveAs, 'Save')]),
      planner: scriptedPlanner([CLICK_SECOND]),
    })

    expect(cache.gets[0]).toEqual({ key, hit: true })
    expect(step.evidence!.cacheMiss?.reason).toBe('strict-not-unique')
    expect(cache.invalidated[0]).toBe(key)
    expect(step.status).toBe('passed')
    expect(step.evidence!.selfHeal).toBeDefined()
    expect(step.evidence!.selfHeal!.failedDecision.plan).toBe('Replayed from cache')
    expect(outcomeOf(step)).toBe('healed')
  })
})
