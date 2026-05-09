import { describe, it, expect } from 'vitest'
import { buildStepPrompt, buildSystemPrompt } from '../prompts.js'
import type { ScreenState } from '../../types/platform.js'
import type { StepContext } from '../types.js'

function makeContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    stepInstruction: 'click button',
    testName: 'test',
    previousSteps: [],
    plannerModel: {} as any,
    verifierModel: {} as any,
    healingConfig: { maxAttempts: 3 },
    ...overrides,
  }
}

function makeScreenState(overrides?: Partial<ScreenState>): ScreenState {
  return {
    tree: '- button "Submit" [ref=e1]',
    elements: [{ ref: 'e1', role: 'button', name: 'Submit', attributes: {} }],
    timestamp: Date.now(),
    metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
    ...overrides,
  }
}

const screenState = makeScreenState()

describe('buildStepPrompt context merging', () => {
  it('includes both suite and test context with labels when both present', () => {
    const ctx = makeContext({ suiteContext: 'SC', testContext: 'TC' })
    const result = buildStepPrompt('click button', screenState, ctx)
    expect(result).toContain('Suite context: SC\nTest context: TC')
  })

  it('includes only suite context label when only suite has context', () => {
    const ctx = makeContext({ suiteContext: 'SC' })
    const result = buildStepPrompt('click button', screenState, ctx)
    expect(result).toContain('Suite context: SC')
    expect(result).not.toContain('Test context')
  })

  it('includes only test context label when only test has context', () => {
    const ctx = makeContext({ testContext: 'TC' })
    const result = buildStepPrompt('click button', screenState, ctx)
    expect(result).toContain('Test context: TC')
    expect(result).not.toContain('Suite context')
  })

  it('has no context line when neither is present', () => {
    const ctx = makeContext({})
    const result = buildStepPrompt('click button', screenState, ctx)
    expect(result).not.toContain('context:')
    expect(result).not.toContain('Suite context')
    expect(result).not.toContain('Test context')
  })
})

describe('buildStepPrompt rich previous step format', () => {
  it('includes rich previous step fields when present', () => {
    const ctx = makeContext({
      previousSteps: [{
        instruction: 'click login',
        outcome: 'passed',
        reasoning: 'Found the login button',
        plannedAction: 'click on ref="e5"',
        verifierResponse: 'Login button was clicked successfully',
      }],
    })
    const result = buildStepPrompt('next step', screenState, ctx)
    expect(result).toContain('"click login"')
    expect(result).toContain('Reasoning: Found the login button')
    expect(result).toContain('Action: click on ref="e5"')
    expect(result).toContain('Verification: Login button was clicked successfully')
  })

  it('omits rich fields when not present (basic format)', () => {
    const ctx = makeContext({
      previousSteps: [{ instruction: 'click login', outcome: 'passed' }],
    })
    const result = buildStepPrompt('next step', screenState, ctx)
    expect(result).toContain('"click login"')
    expect(result).toContain('passed')
    expect(result).not.toContain('Reasoning:')
    expect(result).not.toContain('Action:')
    expect(result).not.toContain('Verification:')
  })

  it('includes all sub-actions without limit', () => {
    const subActions = Array.from({ length: 15 }, (_, i) => ({
      action: `action-${i}`,
      reasoning: `reasoning-${i}`,
      result: 'success' as const,
    }))
    const ctx = makeContext({ subActionHistory: subActions })
    const result = buildStepPrompt('next step', screenState, ctx)
    for (let i = 0; i < 15; i++) {
      expect(result).toContain(`action-${i}`)
    }
  })
})

describe('buildSystemPrompt agentRules injection', () => {
  it('appends custom rules when agentRules provided', () => {
    const result = buildSystemPrompt(undefined, 'custom rule 1')
    expect(result).toContain('Custom rules:\ncustom rule 1')
  })

  it('does not include Custom rules when agentRules is undefined', () => {
    const result = buildSystemPrompt(undefined, undefined)
    expect(result).not.toContain('Custom rules:')
  })

  it('preserves platform and appends agentRules with markdown content', () => {
    const result = buildSystemPrompt('web', '# My Rules\n- rule A')
    expect(result).toContain('Custom rules:\n# My Rules\n- rule A')
  })
})
