import { describe, it, expect } from 'vitest'
import type { ScreenState } from '../../types/platform.js'
import type { StepContext } from '../types.js'
import { buildStepPrompt } from '../prompts.js'

function makeScreenState(): ScreenState {
  return {
    tree: '',
    elements: [],
    timestamp: Date.now(),
    metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
  }
}

function makeStepContext(overrides?: Partial<StepContext>): StepContext {
  return {
    stepInstruction: 'Click login button',
    testName: 'Login test',
    previousSteps: [],
    plannerModel: {} as any,
    verifierModel: {} as any,
    healingConfig: { maxAttempts: 3 },
    ...overrides,
  }
}

describe('buildStepPrompt with memory context', () => {
  it('includes memory-context when memoryContext is set', () => {
    const memoryBlock = `<memory-context>
[Past observations for this step. These are from previous runs — trust live observation over memory.]

- Login modal appears (trust: 0.80)
</memory-context>`

    const context = makeStepContext({ memoryContext: memoryBlock })
    const result = buildStepPrompt('Click login button', makeScreenState(), context)

    expect(result).toContain('<memory-context>')
    expect(result).toContain('trust live observation over memory')
  })

  it('memory context appears before Current step', () => {
    const memoryBlock = `<memory-context>
[Past observations — trust live observation over memory.]

- Login modal appears (trust: 0.80)
</memory-context>`

    const context = makeStepContext({ memoryContext: memoryBlock })
    const result = buildStepPrompt('Click login button', makeScreenState(), context)

    const memIdx = result.indexOf('<memory-context>')
    const stepIdx = result.indexOf('Current step:')
    expect(memIdx).toBeGreaterThan(-1)
    expect(stepIdx).toBeGreaterThan(-1)
    expect(memIdx).toBeLessThan(stepIdx)
  })

  it('omits memory section when memoryContext is undefined', () => {
    const context = makeStepContext({ memoryContext: undefined })
    const result = buildStepPrompt('Click login button', makeScreenState(), context)

    expect(result).not.toContain('<memory-context>')
  })
})
