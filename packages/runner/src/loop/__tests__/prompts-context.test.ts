import { describe, it, expect } from 'vitest'
import type { ModelMessage, SystemModelMessage } from 'ai'
import {
  buildSystemPrompt,
  buildContextTier,
  composeTurnMessages,
} from '../prompts.js'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { StepContext } from '../types.js'
import { buildAgentScreenState, type LooseScreenState } from './screen-fixtures.js'

function makeContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    stepInstruction: 'click button',
    testName: 'test',
    previousSteps: [],
    plannerModel: {} as any,
    verifierModel: {} as any,
    ...overrides,
  }
}

function makeScreenState(overrides: LooseScreenState = {}): ScreenState {
  return buildAgentScreenState({
    tree: '- button "Submit" [ref=e1]',
    elements: [{ ref: 'e1', role: 'button', name: 'Submit', attributes: {} }],
    timestamp: Date.now(),
    metadata: { coordSpace: 'viewport', viewportWidth: 0, viewportHeight: 0 },
    ...overrides,
  })
}

const screenState = makeScreenState()

// Render the CONTEXT tier's text (the byte-stable suite/test framing) for `.toContain`.
function contextText(context: StepContext): string {
  const tier = buildContextTier(context) as SystemModelMessage
  return typeof tier.content === 'string' ? tier.content : JSON.stringify(tier.content)
}

// Concatenate the text parts of the per-turn ModelMessage[] into one rendered string
// so the existing content assertions run unchanged against the turn content.
function renderTurn(messages: ModelMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
            .join(''),
    )
    .join('\n')
}

describe('context tier merging (was step-prompt context merging)', () => {
  it('includes both suite and test context with labels when both present', () => {
    const ctx = makeContext({ suiteContext: 'SC', testContext: 'TC' })
    const result = contextText(ctx)
    expect(result).toContain('Suite context: SC\nTest context: TC')
  })

  it('includes only suite context label when only suite has context', () => {
    const ctx = makeContext({ suiteContext: 'SC' })
    const result = contextText(ctx)
    expect(result).toContain('Suite context: SC')
    expect(result).not.toContain('Test context')
  })

  it('includes only test context label when only test has context', () => {
    const ctx = makeContext({ testContext: 'TC' })
    const result = contextText(ctx)
    expect(result).toContain('Test context: TC')
    expect(result).not.toContain('Suite context')
  })

  it('has no context line when neither is present', () => {
    const ctx = makeContext({})
    const result = contextText(ctx)
    expect(result).not.toContain('context:')
    expect(result).not.toContain('Suite context')
    expect(result).not.toContain('Test context')
  })
})

describe('turn content rich previous step format (was step-prompt)', () => {
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
    const result = renderTurn(composeTurnMessages(ctx, screenState))
    expect(result).toContain('"click login"')
    expect(result).toContain('Reasoning: Found the login button')
    expect(result).toContain('Action: click on ref="e5"')
    expect(result).toContain('Verification: Login button was clicked successfully')
  })

  it('omits rich fields when not present (basic format)', () => {
    const ctx = makeContext({
      previousSteps: [{ instruction: 'click login', outcome: 'passed' }],
    })
    const result = renderTurn(composeTurnMessages(ctx, screenState))
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
    const result = renderTurn(composeTurnMessages(ctx, screenState))
    for (let i = 0; i < 15; i++) {
      expect(result).toContain(`action-${i}`)
    }
  })
})

describe('buildSystemPrompt custom-rules removal', () => {
  it('never renders a Custom rules block', () => {
    expect(buildSystemPrompt(undefined)).not.toContain('Custom rules:')
    expect(buildSystemPrompt('web')).not.toContain('Custom rules:')
  })

  it('accepts no second argument — the injection path is gone', () => {
    expect(buildSystemPrompt.length).toBeLessThanOrEqual(1)
  })
})
