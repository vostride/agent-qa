import { describe, it, expect } from 'vitest'
import {
  fromEditorStep,
  fromRunDetailStep,
  groupPhasesIntoSubActions,
  withDisplayStepProgress,
} from '../lib/display-step'
import type { LivePhase } from '@/lib/display-step'
import type { RunDetailStep } from '@vostride/agent-qa-schema'

function phase(p: LivePhase['phase'], overrides: Partial<LivePhase> = {}): LivePhase {
  return { phase: p, timestamp: new Date().toISOString(), ...overrides }
}

describe('groupPhasesIntoSubActions', () => {
  it('returns null for empty phases', () => {
    expect(groupPhasesIntoSubActions([])).toBeNull()
  })

  it('returns success for a complete cycle with verify success=true', () => {
    const phases = [
      phase('observe', { text: 'saw button' }),
      phase('plan', { text: 'click it', confidence: 0.9 }),
      phase('execute', { action: { type: 'click' } }),
      phase('verify', { success: true, text: 'button clicked' }),
    ]
    const result = groupPhasesIntoSubActions(phases)!
    expect(result).toHaveLength(1)
    expect(result[0].result).toBe('success')
  })

  it('returns failure for a complete cycle with verify success=false', () => {
    const phases = [
      phase('observe', { text: 'saw button' }),
      phase('plan', { text: 'click it' }),
      phase('execute', { action: { type: 'click' } }),
      phase('verify', { success: false, text: 'failed' }),
    ]
    const result = groupPhasesIntoSubActions(phases)!
    expect(result).toHaveLength(1)
    expect(result[0].result).toBe('failure')
  })

  it('returns in-progress for an incomplete last group', () => {
    const phases = [
      phase('observe', { text: 'saw button' }),
      phase('plan', { text: 'click it' }),
    ]
    const result = groupPhasesIntoSubActions(phases)!
    expect(result).toHaveLength(1)
    expect(result[0].result).toBe('in-progress')
  })

  it('returns [success, in-progress] for first complete + second incomplete', () => {
    const phases = [
      phase('observe', { text: 'saw button' }),
      phase('plan', { text: 'click it' }),
      phase('execute', { action: { type: 'click' } }),
      phase('verify', { success: true, text: 'clicked' }),
      phase('observe', { text: 'saw input' }),
      phase('plan', { text: 'type text' }),
    ]
    const result = groupPhasesIntoSubActions(phases)!
    expect(result).toHaveLength(2)
    expect(result[0].result).toBe('success')
    expect(result[1].result).toBe('in-progress')
  })

  it('starts a new group on heal boundary', () => {
    const phases = [
      phase('observe', { text: 'saw button' }),
      phase('plan', { text: 'click it' }),
      phase('execute', { action: { type: 'click' } }),
      phase('verify', { success: false, text: 'failed' }),
      phase('heal'),
      phase('observe', { text: 'healed view' }),
      phase('plan', { text: 'retry click' }),
      phase('execute', { action: { type: 'click' } }),
      phase('verify', { success: true, text: 'success' }),
    ]
    const result = groupPhasesIntoSubActions(phases)!
    expect(result).toHaveLength(3)
    expect(result[0].result).toBe('failure')
    expect(result[1].result).toBe('failure')
    expect(result[2].result).toBe('success')
  })

  it('populates observation, reasoning, and planned action from phases', () => {
    const phases = [
      phase('observe', { text: 'observed text' }),
      phase('plan', { text: 'plan text', confidence: 0.85 }),
      phase('execute', { action: { type: 'click', target: '#btn' } }),
      phase('verify', { success: true, text: 'verified' }),
    ]
    const result = groupPhasesIntoSubActions(phases)!
    expect(result[0].observation).toBe('observed text')
    expect(result[0].reasoning).toBe('plan text')
    expect(result[0].plannedAction).toEqual({ type: 'click', target: '#btn' })
    expect(result[0].confidence).toBe(0.85)
    expect(result[0].verifierReasoning).toBe('verified')
  })
})

describe('fromEditorStep', () => {
  it('falls back to sub-action reasoning when phase events are unavailable', () => {
    const displayStep = fromEditorStep({
      id: 'live-step-1',
      draftId: 'live-step-1',
      instruction: 'Verify the README renders',
      status: 'passed',
      duration: 1200,
      error: undefined,
      phases: [],
      executionHistory: [],
      capturedVariables: undefined,
      consoleLogs: [],
      networkLogs: [],
      variableSnapshot: null,
      originalStepName: null,
      executionLogs: [],
      executionGeneration: 1,
      liveSubActions: [{
        index: 0,
        observation: 'README section is visible',
        reasoning: 'The page is already in the expected state',
        plannedAction: { type: 'verify', target: 'README section' },
        result: 'success',
        confidence: 0.91,
      }],
    }, 0)

    expect(displayStep.observation).toBe('README section is visible')
    expect(displayStep.reasoning).toBe('The page is already in the expected state')
    expect(displayStep.plannedAction).toEqual({ type: 'verify', target: 'README section' })
    expect(displayStep.confidence).toBe(0.91)
  })
})

describe('withDisplayStepProgress', () => {
  // THE DURABLE STEP IS THE ONLY ROW THIS NUMBERS NOW. The v1 builder these two fixtures
  // used to call — and the row it read, with its capture paths and its per-step token counters —
  // are deleted; refs are the only artifact addressing and the projection carries the spend. The
  // property under test is unchanged: numbering is DISPLAY-ONLY and never edits the identity a
  // deep link selects by.
  it('adds display-only progress without mutating the durable step identity', () => {
    const step = (stepIndex: number, stepText: string): RunDetailStep => ({
      testIndex: 0,
      stepIndex,
      stepText,
      cacheStatus: 'miss',
      verifierVerdict: { pass: true, reasoning: 'looks right' },
      selfHealOccurred: false,
      briefDigest: `d0${String(stepIndex)}`,
      status: 'passed',
      durationMs: 1000,
    })

    const rawA = fromRunDetailStep(step(0, 'Open home'), [])
    const rawB = fromRunDetailStep(step(1, 'Submit form'), [])

    const display = withDisplayStepProgress([rawA, rawB])

    expect(display.map((s) => [s.id, s.displayStepOrder, s.displayStepTotal])).toEqual([
      ['0:0', 1, 2],
      ['0:1', 2, 2],
    ])
    expect(display[0].rawStepOrder).toBe(0)
    expect(display[1].rawStepOrder).toBe(1)
    expect(display[0].id).toBe(rawA.id)
    expect(display[1].id).toBe(rawB.id)
  })

  // The A11y tab's field used to arrive on the v1 row; a durable step carries none, and the tab
  // renders its not-captured state rather than an empty violation list that would read as "clean".
  it('leaves accessibility violations ABSENT on a durable step, not empty', () => {
    const durable = fromRunDetailStep(
      {
        testIndex: 0,
        stepIndex: 0,
        stepText: 'Inspect image alt text',
        cacheStatus: 'miss',
        verifierVerdict: { pass: true, reasoning: 'alt text present' },
        selfHealOccurred: false,
        briefDigest: 'd00',
        status: 'passed',
        durationMs: 1000,
      },
      [],
    )

    expect(durable.accessibilityViolations).toBeUndefined()
  })
})
