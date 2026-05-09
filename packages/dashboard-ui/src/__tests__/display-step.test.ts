import { describe, it, expect } from 'vitest'
import { fromEditorStep, fromStepRow, groupPhasesIntoSubActions, withDisplayStepProgress } from '../lib/display-step'
import type { LivePhase } from '@/hooks/use-execution-events'
import type { StepRow } from '@/lib/api'

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
      subActionsData: [{
        index: 0,
        observation: 'README section is visible',
        reasoning: 'The page is already in the expected state',
        plannedAction: { type: 'verify', target: 'README section' },
        result: 'success',
        screenStateBefore: '<main />',
        cached: false,
        confidence: 0.91,
      }],
    }, 0)

    expect(displayStep.observation).toBe('README section is visible')
    expect(displayStep.reasoning).toBe('The page is already in the expected state')
    expect(displayStep.plannedAction).toEqual({ type: 'verify', target: 'README section' })
    expect(displayStep.confidence).toBe(0.91)
  })
})

describe('fromStepRow', () => {
  it('preserves recorded accessibility violations for the A11y tab', () => {
    const displayStep = fromStepRow({
      id: 'step-a11y',
      runId: 'run-a',
      name: 'Inspect image alt text',
      status: 'passed',
      duration: 1000,
      action: null,
      observation: null,
      reasoning: null,
      plannedAction: null,
      result: null,
      error: null,
      screenshotPath: null,
      screenshotBeforePath: null,
      healingAttempts: null,
      retryCount: 0,
      capturedVariables: null,
      stepOrder: 0,
      annotationData: null,
      healingScreenshotPaths: null,
      accessibilityViolations: [{
        ruleId: 'image-alt',
        impact: 'critical',
        description: 'Images must have alternate text',
        help: 'Image elements must have alternate text',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt',
        nodes: [{ html: '<img src="hero.png">', target: ['img'] }],
      }],
      consoleLogs: null,
      networkLogs: null,
      confidence: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      subActionsData: null,
      variableSnapshot: null,
      originalStepName: null,
      screenContextBefore: null,
      screenContextAfter: null,
      createdAt: '2026-05-10T00:00:00.000Z',
    } satisfies StepRow)

    expect(displayStep.accessibilityViolations).toEqual([
      expect.objectContaining({ ruleId: 'image-alt', impact: 'critical' }),
    ])
  })
})

describe('withDisplayStepProgress', () => {
  it('adds display-only suite progress without mutating raw child step identity', () => {
    const rawA = fromStepRow({
      id: 'step-a',
      runId: 'run-a',
      name: 'Open home',
      status: 'passed',
      duration: 1000,
      action: null,
      observation: null,
      reasoning: null,
      plannedAction: null,
      result: null,
      error: null,
      screenshotPath: null,
      screenshotBeforePath: null,
      healingAttempts: null,
      retryCount: 0,
      capturedVariables: null,
      stepOrder: 0,
      annotationData: null,
      healingScreenshotPaths: null,
      accessibilityViolations: null,
      consoleLogs: null,
      networkLogs: null,
      confidence: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      subActionsData: null,
      variableSnapshot: null,
      originalStepName: null,
      screenContextBefore: null,
      screenContextAfter: null,
      createdAt: '2026-04-18T00:00:00.000Z',
    } satisfies StepRow)
    const rawB = fromStepRow({
      id: 'step-b',
      runId: 'run-b',
      name: 'Submit form',
      status: 'failed',
      duration: 1200,
      action: null,
      observation: null,
      reasoning: null,
      plannedAction: null,
      result: null,
      error: null,
      screenshotPath: null,
      screenshotBeforePath: null,
      healingAttempts: null,
      retryCount: 0,
      capturedVariables: null,
      stepOrder: 0,
      annotationData: null,
      healingScreenshotPaths: null,
      accessibilityViolations: null,
      consoleLogs: null,
      networkLogs: null,
      confidence: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      subActionsData: null,
      variableSnapshot: null,
      originalStepName: null,
      screenContextBefore: null,
      screenContextAfter: null,
      createdAt: '2026-04-18T00:00:01.000Z',
    } satisfies StepRow)

    const display = withDisplayStepProgress([rawA, rawB])

    expect(display.map((step) => [step.id, step.displayStepOrder, step.displayStepTotal])).toEqual([
      ['step-a', 1, 2],
      ['step-b', 2, 2],
    ])
    expect(display[0].rawRunId).toBe('run-a')
    expect(display[0].rawStepOrder).toBe(0)
    expect(display[1].rawRunId).toBe('run-b')
    expect(display[1].rawStepOrder).toBe(0)
  })
})
