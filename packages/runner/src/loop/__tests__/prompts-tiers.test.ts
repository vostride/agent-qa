import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ModelMessage, SystemModelMessage } from 'ai'
import { sha256hex, type ScreenState } from '@vostride/agent-qa-schema'
import type { StepContext } from '../types.js'
import { buildAgentScreenState, type LooseScreenState } from './screen-fixtures.js'
import {
  buildSystemPrompt,
  buildContextTier,
  buildVolatileTier,
  captureServedPromptTurn,
  composeTurnMessages,
} from '../prompts.js'

const PREV_STEP_INSTRUCTION = 'navigate to the login page'
const SCREEN_TREE_TOKEN = 'Sign In'

function makeContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    stepInstruction: 'click the Sign In button',
    testName: 'login test',
    suiteContext: 'E-commerce checkout suite',
    testContext: 'User can sign in with valid credentials',
    previousSteps: [],
    plannerModel: {} as never,
    verifierModel: {} as never,
    ...overrides,
  }
}

function makeScreenState(overrides: LooseScreenState = {}): ScreenState {
  return buildAgentScreenState({
    tree: `- button "${SCREEN_TREE_TOKEN}" [ref=e1]`,
    elements: [{ ref: 'e1', role: 'button', name: SCREEN_TREE_TOKEN, attributes: {} }],
    metadata: { coordSpace: 'viewport', viewportWidth: 0, viewportHeight: 0 },
    ...overrides,
  })
}

// The planner `system` value: an ordered [stable, context, volatile] array of tier messages.
function buildPlannerSystem(
  ctx: StepContext,
  platform: 'web' | 'android' | 'ios' = 'web',
): SystemModelMessage[] {
  const stable: SystemModelMessage = { role: 'system', content: buildSystemPrompt(platform) }
  const context = buildContextTier(ctx) as SystemModelMessage
  const volatile = buildVolatileTier(ctx) as SystemModelMessage
  return [stable, context, volatile]
}

function contentText(content: SystemModelMessage['content'] | ModelMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function cacheControlOf(message: SystemModelMessage): unknown {
  return (message.providerOptions as Record<string, { cacheControl?: unknown }> | undefined)?.anthropic?.cacheControl
}

afterEach(() => {
  vi.useRealTimers()
})

describe('planner system tiers — ordering', () => {
  it('assembles system as an ordered [stable, context, volatile] array of role:system messages', () => {
    const system = buildPlannerSystem(makeContext())
    expect(system).toHaveLength(3)
    expect(system.every((m) => m.role === 'system')).toBe(true)
    // The context tier carries the app/suite/test framing (byte-stable per run).
    expect(contentText(system[1].content)).toContain('E-commerce checkout suite')
  })
})

describe('planner system tiers — single cache breakpoint', () => {
  it('places exactly one ephemeral cache_control breakpoint, on the context message', () => {
    const system = buildPlannerSystem(makeContext())
    expect(cacheControlOf(system[1])).toEqual({ type: 'ephemeral' })
    // Stable (above) and volatile (below) carry no breakpoint — exactly one breakpoint total.
    expect(cacheControlOf(system[0])).toBeUndefined()
    expect(cacheControlOf(system[2])).toBeUndefined()
  })
})

describe('planner system tiers — cached-prefix byte-stability', () => {
  it('keeps stable + context tiers byte-identical across two turns of the same run', () => {
    const ctx = makeContext()
    const first = buildPlannerSystem(ctx)
    const second = buildPlannerSystem(ctx)
    // Everything at or above the breakpoint (stable + context) must be byte-stable.
    expect(contentText(second[0].content)).toBe(contentText(first[0].content))
    expect(contentText(second[1].content)).toBe(contentText(first[1].content))
  })
})

describe('volatile tier — date-granularity stamp', () => {
  it('stamps the volatile tier at date granularity (identical bytes across two intra-day clock times)', () => {
    const ctx = makeContext()
    vi.useFakeTimers()

    vi.setSystemTime(new Date('2026-07-05T09:00:00Z'))
    const morning = contentText((buildVolatileTier(ctx) as SystemModelMessage).content)

    vi.setSystemTime(new Date('2026-07-05T15:37:42Z'))
    const afternoon = contentText((buildVolatileTier(ctx) as SystemModelMessage).content)

    // Same calendar day → identical bytes (minute/second precision would bust the KV cache).
    expect(afternoon).toBe(morning)
  })

  it('uses one bound UTC date byte-exactly across a midnight boundary', () => {
    const ctx = makeContext({ promptDate: '2026-07-24' })
    vi.useFakeTimers()

    vi.setSystemTime(new Date('2026-07-24T23:59:59.999Z'))
    const beforeMidnight = contentText((buildVolatileTier(ctx) as SystemModelMessage).content)

    vi.setSystemTime(new Date('2026-07-25T00:00:00.001Z'))
    const afterMidnight = contentText((buildVolatileTier(ctx) as SystemModelMessage).content)

    expect(beforeMidnight).toContain('Current date: 2026-07-24')
    expect(afterMidnight).toBe(beforeMidnight)
  })

  it('keeps every turn for one StepContext on its bound date', () => {
    const ctx = makeContext({ promptDate: '2026-07-24' })
    vi.useFakeTimers()

    const turnDates = [
      '2026-07-24T00:00:00.000Z',
      '2026-07-25T12:34:56.789Z',
      '2026-08-01T23:59:59.999Z',
    ].map((now) => {
      vi.setSystemTime(new Date(now))
      return contentText((buildVolatileTier(ctx) as SystemModelMessage).content)
    })

    expect(new Set(turnDates)).toEqual(new Set([turnDates[0]]))
    expect(turnDates[0]).toContain('Current date: 2026-07-24')
  })

  it('retains the current UTC-date fallback for legacy callers without a bound date', () => {
    const ctx = makeContext()
    vi.useFakeTimers()

    vi.setSystemTime(new Date('2026-07-24T23:59:59.999Z'))
    const beforeMidnight = contentText((buildVolatileTier(ctx) as SystemModelMessage).content)

    vi.setSystemTime(new Date('2026-07-25T00:00:00.001Z'))
    const afterMidnight = contentText((buildVolatileTier(ctx) as SystemModelMessage).content)

    expect(beforeMidnight).toContain('Current date: 2026-07-24')
    expect(afterMidnight).toContain('Current date: 2026-07-25')
    expect(afterMidnight).not.toBe(beforeMidnight)
  })
})

describe('served prompt-turn capture', () => {
  it('snapshots the exact production tier bytes and their named SHA-256 digests', () => {
    const ctx = makeContext({
      promptDate: '2026-07-24',
      knowledgePolicyL0: 'Policy line one\nPolicy line two',
      knowledgeBriefL1: 'Caution line',
      knowledgeBriefL2: 'Procedure line',
    })
    const expectedContextTier = contentText(buildContextTier(ctx).content)
    const expectedVolatileTier = contentText(buildVolatileTier(ctx).content)

    const turn = captureServedPromptTurn(ctx, 7, 13)

    expect(turn).toEqual({
      ordinal: 7,
      turnOrdinal: 13,
      runDate: '2026-07-24',
      policyL0: ctx.knowledgePolicyL0,
      learnedL1: ctx.knowledgeBriefL1,
      learnedL2: ctx.knowledgeBriefL2,
      contextTier: expectedContextTier,
      volatileTier: expectedVolatileTier,
      policyDigest: sha256hex(ctx.knowledgePolicyL0 ?? ''),
      contextTierDigest: sha256hex(expectedContextTier),
      volatileTierDigest: sha256hex(expectedVolatileTier),
    })
  })

  it('copies ordinals unchanged and is byte-deterministic for repeated identical input', () => {
    const ctx = makeContext({
      promptDate: '2026-07-24',
      knowledgePolicyL0: 'Keep the checkout policy stable.',
      knowledgeBriefL1: 'Treat stale totals cautiously.',
      knowledgeBriefL2: 'Open the cart before checkout.',
    })

    const first = captureServedPromptTurn(ctx, 41, 9)
    const second = captureServedPromptTurn(ctx, 41, 9)

    expect(first.ordinal).toBe(41)
    expect(first.turnOrdinal).toBe(9)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('requires a valid bound UTC date without falling back to the wall clock', () => {
    expect(() => captureServedPromptTurn(makeContext(), 0, 0)).toThrow(
      /valid YYYY-MM-DD UTC date/,
    )
    expect(() =>
      captureServedPromptTurn(makeContext({ promptDate: '2026-02-30' }), 0, 0),
    ).toThrow(/valid YYYY-MM-DD UTC date/)
    expect(() =>
      captureServedPromptTurn(makeContext({ promptDate: '2026/07/24' }), 0, 0),
    ).toThrow(/valid YYYY-MM-DD UTC date/)
  })
})

describe('per-turn state placement', () => {
  it('emits per-turn screen/history state as turn messages, never in the system tiers', () => {
    const ctx = makeContext({
      previousSteps: [{ instruction: PREV_STEP_INSTRUCTION, outcome: 'passed' }],
      // Leakage probe: a sub-action token that cannot collide with the fixed stable-tier
      // rule text. (The literal "scroll down" appears verbatim in Rule 3 and Rule 14 of
      // buildSystemPrompt — Rule 14's "scroll down for content at the bottom" is pinned
      // by the qa-mindset suite — so it is unusable as an isolation probe.)
      subActionHistory: [{ action: 'expand the accordion panel', result: 'success' }],
    })
    const screen = makeScreenState()

    const system = buildPlannerSystem(ctx)
    const messages = composeTurnMessages(ctx, screen)

    const systemText = system.map((m) => contentText(m.content)).join('\n')
    const messagesText = JSON.stringify(messages)

    // Per-turn state (screen tree, previous steps, sub-action history) lives in messages...
    expect(messagesText).toContain(SCREEN_TREE_TOKEN)
    expect(messagesText).toContain(PREV_STEP_INSTRUCTION)
    expect(messagesText).toContain('expand the accordion panel')

    // ...and never leaks into the cached system prefix.
    expect(systemText).not.toContain(SCREEN_TREE_TOKEN)
    expect(systemText).not.toContain(PREV_STEP_INSTRUCTION)
    expect(systemText).not.toContain('expand the accordion panel')
  })
})

describe('empty ingredient slots', () => {
  it('omits working-memory and brief messages entirely when those slots are empty', () => {
    const ctx = makeContext() // no knowledgeBrief, no workingMemory
    const screen = makeScreenState()

    const messages = composeTurnMessages(ctx, screen)
    // No blank/degenerate message is pushed for an empty slot.
    expect(messages.every((m) => contentText(m.content).trim().length > 0)).toBe(true)

    // The volatile tier renders no 'Knowledge brief' section when the brief is unbound.
    const volatile = contentText((buildVolatileTier(ctx) as SystemModelMessage).content)
    expect(volatile).not.toContain('Knowledge brief')
  })
})

describe('non-Anthropic provider no-op', () => {
  it('lets a non-Anthropic run read identical tier content while ignoring providerOptions.anthropic', () => {
    const context = buildContextTier(makeContext()) as SystemModelMessage
    // A non-Anthropic provider passes the message through untouched (a plain object spread
    // mirrors the SDK no-op: the anthropic-namespaced key is simply never parsed).
    const merged = { ...context }
    expect(() => JSON.stringify(merged)).not.toThrow()
    expect(contentText(merged.content)).toBe(contentText(context.content))
    // Reading/ignoring the anthropic namespace never throws on a non-Anthropic run.
    expect(() => (merged.providerOptions as Record<string, unknown> | undefined)?.anthropic).not.toThrow()
  })
})
