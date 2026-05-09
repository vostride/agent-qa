import { describe, it, expect } from 'vitest'
import type { ScreenState } from '../../types/platform.js'
import type { StepContext } from '../types.js'
import { buildStepPrompt } from '../prompts.js'

function makeScreenState(overrides?: Partial<ScreenState>): ScreenState {
  return {
    tree: 'button "Sign In" [ref=btn-1]',
    elements: [
      { ref: 'btn-1', role: 'button', name: 'Sign In', attributes: {} },
    ],
    url: 'https://example.com/login',
    timestamp: Date.now(),
    metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
    ...overrides,
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

describe('buildStepPrompt with DOM context', () => {
  it('includes DOM context when metadata has domContext', () => {
    const context = makeStepContext()
    const screenState = makeScreenState({
      metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0, domContext: 'div\n  button "Click me"' },
    })

    const result = buildStepPrompt('Click login button', screenState, context)

    expect(result).toContain('DOM structure (supplementary context')
    expect(result).toContain('div\n  button "Click me"')
  })

  it('excludes DOM context when metadata.domContext absent', () => {
    const context = makeStepContext()
    const screenState = makeScreenState({ metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 } })

    const result = buildStepPrompt('Click login button', screenState, context)

    expect(result).not.toContain('DOM structure')
  })

  it('DOM context is included in full without truncation', () => {
    const longDom = 'div\n' + '  span "Some text content here"\n'.repeat(500)
    const context = makeStepContext()
    const screenState = makeScreenState({
      metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0, domContext: longDom },
    })

    const result = buildStepPrompt('Click login button', screenState, context)

    expect(result).toContain('DOM structure (supplementary context')
    expect(result).toContain(longDom)
  })
})
