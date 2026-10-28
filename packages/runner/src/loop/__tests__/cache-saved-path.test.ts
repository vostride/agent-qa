import { describe, expect, it } from 'vitest'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { ActionPlan, Verifier } from '../types.js'
import { metVerification } from '../../testing/condition-verdicts.js'
import { makeActionPlan, makeVerifier } from './loop-harness.js'
import {
  CLICK_SAVE,
  adapterOver,
  FILL_EMAIL,
  FILL_NAME,
  el,
  forgetCalls,
  formScreens,
  recordingCache,
  runStep,
  scriptedPlanner,
  screen,
  silentPlanner,
} from './fixtures/saved-path.js'
import type { RecordingCache } from './fixtures/saved-path.js'

function watchedVerifier(
  cache: RecordingCache,
  inner: Verifier = makeVerifier(),
): Verifier & { setsSeen: number[] } {
  const setsSeen: number[] = []
  return {
    setsSeen,
    async verify(...args) {
      setsSeen.push(cache.sets.length)
      return inner.verify(...args)
    },
  }
}

describe('a passing step saves its whole path', () => {
  it('a passing step of several turns saves every turn once the verifier passes, and an unchanged rerun replays them with no planner call', async () => {
    const cache = recordingCache()
    const verifier = watchedVerifier(cache)
    const first = await runStep({
      cache,
      planner: scriptedPlanner([FILL_NAME, FILL_EMAIL, CLICK_SAVE]),
      verifier,
    })

    expect(first.status).toBe('passed')
    expect(verifier.setsSeen).toEqual([0])
    expect(cache.sets).toEqual(cache.gets.map((get) => get.key))
    expect(new Set(cache.sets).size).toBe(3)
    expect(cache.sets.map((key) => cache.store.get(key)!.completesStep)).toEqual([
      false,
      false,
      true,
    ])

    forgetCalls(cache)
    const planner = silentPlanner()
    const second = await runStep({ cache, planner })

    expect(second.status).toBe('passed')
    expect(planner.calls).toBe(0)
    expect(cache.gets).toHaveLength(3)
    expect(cache.gets.every((get) => get.hit)).toBe(true)
    expect(second.evidence!.cacheStatus).toBe('hit')
    expect(cache.sets).toEqual([])
  })

  it('a step that fails saves nothing', async () => {
    const cache = recordingCache()
    const giveUp = makeActionPlan({
      reasoning: 'The contact cannot be saved',
      action: { type: 'delay', ms: 0 },
      stepComplete: false,
      stepFailed: true,
    })
    const result = await runStep({
      cache,
      planner: scriptedPlanner([FILL_NAME, FILL_EMAIL, CLICK_SAVE, giveUp]),
      verifier: makeVerifier([{ success: false, reasoning: 'The contact is not saved' }]),
    })

    expect(result.status).toBe('failed')
    expect(cache.sets).toEqual([])
  })

  it('a failed turn leaves no gap in the saved path', async () => {
    const cache = recordingCache()
    const first = await runStep({
      cache,
      planner: scriptedPlanner([FILL_NAME, FILL_NAME, FILL_EMAIL, CLICK_SAVE]),
      results: [{ success: false, error: 'The field did not take the text' }],
    })

    expect(first.status).toBe('passed')
    expect(cache.gets[1].key).toBe(cache.gets[0].key)
    expect(cache.sets).toEqual(cache.gets.slice(1).map((get) => get.key))
    expect(new Set(cache.sets).size).toBe(3)

    forgetCalls(cache)
    const planner = silentPlanner()
    const second = await runStep({ cache, planner })

    expect(second.status).toBe('passed')
    expect(planner.calls).toBe(0)
    expect(cache.gets.every((get) => get.hit)).toBe(true)
    expect(second.evidence!.cacheStatus).toBe('hit')
  })

  it('a turn that cannot replay keeps its place, so the rerun plans it live before replaying the saved turn after it', async () => {
    const termsScreens = (): ScreenState[] => [
      screen('https://signup.test/terms', [
        el('e1', 'checkbox', 'Accept the terms', 120),
        el('e2', 'button', 'Submit', 180),
      ]),
      screen('https://signup.test/terms', [
        el('e1', 'checkbox', 'Accept the terms', 120, 'checked'),
        el('e2', 'button', 'Submit', 180),
      ]),
      screen('https://signup.test/done', [el('e1', 'heading', 'Thanks for signing up', 80)]),
    ]
    const tapTerms = makeActionPlan({
      reasoning: 'Tick the terms box',
      action: { type: 'tapCoordinate', x: 30, y: 142 },
      stepComplete: false,
    })
    const submit = makeActionPlan({
      reasoning: 'Submit the form',
      action: { type: 'click', ref: 'e2' },
      stepComplete: true,
    })
    const cache = recordingCache()
    const first = await runStep({
      cache,
      screens: termsScreens(),
      planner: scriptedPlanner([tapTerms, submit]),
    })

    expect(first.status).toBe('passed')
    expect(cache.gets[1].key).not.toBe(cache.gets[0].key)
    expect(cache.sets).toEqual([cache.gets[1].key])

    forgetCalls(cache)
    const adapter = adapterOver(termsScreens())
    const planner = scriptedPlanner([tapTerms])
    const second = await runStep({ cache, planner, adapter })

    expect(second.status).toBe('passed')
    expect(cache.gets.map((get) => get.hit)).toEqual([false, true])
    expect(adapter.executed.map((action) => action.type)).toEqual(['tapCoordinate', 'click'])
    expect(planner.calls).toBe(1)
    expect(second.evidence!.cacheStatus).toBe('miss')
  })

  it('a rerun that needs a live turn after replaying saved turns is a miss, and only the live turn is saved', async () => {
    const cache = recordingCache()
    await runStep({ cache, planner: scriptedPlanner([FILL_NAME, FILL_EMAIL, CLICK_SAVE]) })

    forgetCalls(cache)
    const planner = scriptedPlanner([CLICK_SAVE])
    const second = await runStep({ cache, planner, screens: formScreens(true) })

    expect(second.status).toBe('passed')
    expect(cache.gets.map((get) => get.hit)).toEqual([true, true, false])
    expect(planner.calls).toBe(1)
    expect(second.evidence!.cacheStatus).toBe('miss')
    expect(cache.sets).toEqual([cache.gets[2].key])
    expect(cache.store.get(cache.gets[2].key)!.completesStep).toBe(true)
  })
})

function reportScreens(): ScreenState[] {
  const [blank, named] = formScreens()
  const saved = screen('https://contacts.test/saved', [el('e1', 'heading', 'Contact saved', 80)])
  return [blank, named, saved]
}

const REPORT_TEXT = 'Ada is listed among the saved contacts'

const OPEN_SAVE = makeActionPlan({
  reasoning: 'Save the contact',
  action: { type: 'click', ref: 'e3' },
  stepComplete: false,
})

function report(value: string, stepComplete: boolean): ActionPlan {
  return makeActionPlan({
    reasoning: 'Report what the page shows',
    action: { type: 'reportValue', value },
    stepComplete,
  })
}

// A met verdict that cites the report's read.
function citingVerifier(quote: string): Verifier {
  return {
    async verify(step, _before, after, action) {
      const met = metVerification({ step, after, action })
      return {
        verification: {
          ...met,
          conditions: met.conditions.map((condition) => ({
            ...condition,
            citations: [{ source: 'read' as const, quote }],
          })),
        },
      }
    },
  }
}

function storedText(cache: RecordingCache): string {
  return JSON.stringify([...cache.store.values()])
}

describe('a report is never saved or replayed', () => {
  it('a closing report the step does not need is not saved, and the rerun claims completion on the last replayed action', async () => {
    const cache = recordingCache()
    const first = await runStep({
      cache,
      screens: reportScreens(),
      planner: scriptedPlanner([FILL_NAME, OPEN_SAVE, report(REPORT_TEXT, true)]),
    })

    expect(first.status).toBe('passed')
    expect(cache.sets).toHaveLength(2)
    expect(cache.sets.map((key) => cache.store.get(key)!.completesStep)).toEqual([false, true])
    expect(cache.store.get(cache.sets[1])!.plannedActions[0].type).toBe('click')
    for (const value of cache.store.values()) {
      expect(value.plannedActions.map((action) => action.type)).not.toContain('reportValue')
    }
    expect(storedText(cache)).not.toContain(REPORT_TEXT)

    forgetCalls(cache)
    const planner = silentPlanner()
    const second = await runStep({ cache, planner, screens: reportScreens() })

    expect(second.status).toBe('passed')
    expect(planner.calls).toBe(0)
    expect(cache.gets.every((get) => get.hit)).toBe(true)
    expect(second.evidence!.cacheStatus).toBe('hit')
    expect(second.evidence!.reportedValue).toBeUndefined()
  })

  it('a report the verdict cites keeps the saved path from claiming completion, and the rerun reads it live', async () => {
    const cache = recordingCache()
    const first = await runStep({
      cache,
      screens: reportScreens(),
      planner: scriptedPlanner([FILL_NAME, OPEN_SAVE, report(REPORT_TEXT, true)]),
      verifier: citingVerifier(REPORT_TEXT),
    })

    expect(first.status).toBe('passed')
    expect(cache.sets).toHaveLength(2)
    expect(cache.sets.map((key) => cache.store.get(key)!.completesStep)).toEqual([false, false])
    expect(storedText(cache)).not.toContain(REPORT_TEXT)

    forgetCalls(cache)
    const rerunText = 'Ada appears once among the saved contacts'
    const planner = scriptedPlanner([report(rerunText, true)])
    const second = await runStep({
      cache,
      planner,
      screens: reportScreens(),
      verifier: citingVerifier(rerunText),
    })

    expect(second.status).toBe('passed')
    expect(planner.calls).toBe(1)
    expect(cache.gets.map((get) => get.hit)).toEqual([true, true, false])
    expect(second.evidence!.cacheStatus).toBe('miss')
    expect(second.evidence!.reportedValue).toEqual({ value: rerunText })
    expect(storedText(cache)).not.toContain(rerunText)
  })

  it('a closing report after an action that cannot replay moves no completion claim', async () => {
    const cache = recordingCache()
    const tap = makeActionPlan({
      reasoning: 'Tap the save area',
      action: { type: 'tapCoordinate', x: 195, y: 262 },
      stepComplete: false,
    })
    const first = await runStep({
      cache,
      screens: reportScreens(),
      planner: scriptedPlanner([FILL_NAME, tap, report(REPORT_TEXT, true)]),
    })

    expect(first.status).toBe('passed')
    expect(cache.sets).toHaveLength(1)
    expect(cache.store.get(cache.sets[0])!.completesStep).toBe(false)
  })

  it('a cited report in the middle of a step ends the saved path before it', async () => {
    const cache = recordingCache()
    const first = await runStep({
      cache,
      screens: reportScreens(),
      planner: scriptedPlanner([FILL_NAME, report(REPORT_TEXT, false), CLICK_SAVE]),
      verifier: citingVerifier(REPORT_TEXT),
    })

    expect(first.status).toBe('passed')
    expect(cache.sets).toHaveLength(1)
    expect(cache.store.get(cache.sets[0])!.plannedActions[0].type).toBe('fill')
    expect(cache.store.get(cache.sets[0])!.completesStep).toBe(false)
    expect(storedText(cache)).not.toContain(REPORT_TEXT)
  })
})
