// Phase 364 RUNX-01 / D2 regression — the planner must NEVER emit an empty-content
// system message. A bare test (no suiteContext, no testContext) makes buildContextTier
// return a role:'system' message whose content is '' (appendContextSection pushes
// nothing); the old assembly placed that empty tier into the `system` array, the `ai`
// openai-responses adapter mapped it to {"role":"developer","content":""}, and the
// OpenAI Responses API rejected the request with HTTP 400.
//
// The fix drops empty-content tiers AT ASSEMBLY TIME via the pure, exported
// `assemblePlannerSystemTiers`, so no empty-content system message can reach the model
// regardless of caller. These tests pin: (1) the bare case yields a 2-tier array with no
// empty message, and (2) the with-context case retains the context tier (3 tiers) and its
// single Anthropic cache_control breakpoint.
import { describe, it, expect } from 'vitest'
import type { SystemModelMessage } from 'ai'
import type { StepContext } from '../types.js'
import { assemblePlannerSystemTiers } from '../planner.js'

function makeContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    stepInstruction: 'verify the page shows "Example Domain"',
    testName: 'example-pass',
    previousSteps: [],
    plannerModel: {} as never,
    verifierModel: {} as never,
    ...overrides,
  }
}

function contentText(content: SystemModelMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function cacheControlOf(message: SystemModelMessage): unknown {
  return (message.providerOptions as Record<string, { cacheControl?: unknown }> | undefined)?.anthropic
    ?.cacheControl
}

describe('assemblePlannerSystemTiers — empty-tier drop', () => {
  it('drops the empty context tier for a bare test with no suite/test context (2 tiers, none empty)', () => {
    const system = assemblePlannerSystemTiers(makeContext(), { platform: 'web' })

    // The empty-content context tier is dropped; only stable + volatile remain.
    expect(system).toHaveLength(2)
    // No message with empty or whitespace-only content is reachable by the model.
    expect(system.every((m) => contentText(m.content).trim().length > 0)).toBe(true)
    // Both surviving tiers are role:'system'.
    expect(system.every((m) => m.role === 'system')).toBe(true)
  })

  it('retains the context tier (3 tiers) and its cache breakpoint when suite/test context is present', () => {
    const system = assemblePlannerSystemTiers(
      makeContext({
        suiteContext: 'E-commerce checkout suite',
        testContext: 'User can sign in with valid credentials',
      }),
      { platform: 'web' },
    )

    expect(system).toHaveLength(3)
    // The retained context tier carries the suite/test framing...
    expect(contentText(system[1].content)).toContain('E-commerce checkout suite')
    expect(contentText(system[1].content)).toContain('User can sign in with valid credentials')
    // ...and keeps its single Anthropic ephemeral cache_control breakpoint.
    expect(cacheControlOf(system[1])).toEqual({ type: 'ephemeral' })
    // No empty message in the retained-context case either.
    expect(system.every((m) => contentText(m.content).trim().length > 0)).toBe(true)
  })

  it('drops the context tier when the context fields are empty strings (nothing rendered)', () => {
    // Empty-string context fields are falsy → appendContextSection pushes nothing → the
    // context tier content is '' → dropped, exactly as the both-absent bare case.
    const system = assemblePlannerSystemTiers(makeContext({ suiteContext: '', testContext: '' }), {
      platform: 'web',
    })
    expect(system).toHaveLength(2)
    expect(system.every((m) => contentText(m.content).trim().length > 0)).toBe(true)
  })

  it('always keeps the stable and volatile tiers (both non-empty by construction)', () => {
    const system = assemblePlannerSystemTiers(makeContext(), { platform: 'web' })
    // Stable tier carries the agent identity prose; volatile carries the date stamp.
    expect(contentText(system[0].content)).toContain('agent-qa test automation agent')
    expect(contentText(system.at(-1)!.content)).toContain('Current date:')
  })

  it('appends composition-root capability notes to the stable tier and never a Custom rules block', () => {
    const system = assemblePlannerSystemTiers(makeContext(), {
      platform: 'web',
      capabilityNotes: 'Console log capture is DISABLED for this test run.',
    })
    expect(contentText(system[0].content)).toContain('Runtime capability notes:\nConsole log capture is DISABLED for this test run.')
    expect(contentText(system[0].content)).not.toContain('Custom rules:')
  })
})
