import type { ModelCapabilities, ModelProfile } from '@vostride/agent-qa-schema'
import type { LanguageModelUsage, ModelMessage } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveCapabilities } from '../../capability/resolve.js'
import { capabilityKey, overrideStore } from '../../capability/override-store.js'
import { createTokenAccounting } from '../token-accounting.js'
import {
  FIXTURE_IMAGE_DATA,
  assistantText,
  mediaOutput,
  screenshotOutput,
  systemMessage,
  toolExchange,
  userText,
  userWithImage,
} from './message-fixtures.js'

const KNOWN_CAPS = resolveCapabilities({
  provider: 'anthropic-compatible',
  model: 'claude-sonnet-4',
  auth: { mode: 'api-key' },
})

function fixedCaps(caps: ModelCapabilities): () => ModelCapabilities {
  return () => caps
}

function usage(inputTokens: number | undefined): LanguageModelUsage {
  return {
    inputTokens,
    outputTokens: 999,
    totalTokens: undefined,
    reasoningTokens: undefined,
    cachedInputTokens: undefined,
  } as unknown as LanguageModelUsage
}

// chars/4 over a single text part, no images: a stable baseline the tests reason against.
const TEXT = 'Log in with the demo account and confirm the dashboard renders.'
const TEXT_TOKENS = Math.ceil(TEXT.length / 4)

describe('createTokenAccounting — estimate two-signal (chars/4 + per-image)', () => {
  it('estimates chars/4 over text parts before any recordUsage', () => {
    const acc = createTokenAccounting({ getCapabilities: fixedCaps(KNOWN_CAPS) })
    expect(acc.estimate([userText(TEXT)])).toBe(TEXT_TOKENS)
  })

  it('charges a flat per-image constant, never base64 length, for inline user images', () => {
    const perImageTokens = 1600
    const acc = createTokenAccounting({ getCapabilities: fixedCaps(KNOWN_CAPS), perImageTokens })
    // A huge base64 payload must not inflate the estimate beyond the flat constant.
    const bigImage = FIXTURE_IMAGE_DATA.repeat(500)
    const withBig = acc.estimate([userWithImage('screen', bigImage)])
    const withSmall = acc.estimate([userWithImage('screen', FIXTURE_IMAGE_DATA)])
    expect(withBig).toBe(withSmall)
    // 'screen' text (6 chars → 2 tokens) + one flat image constant.
    expect(withBig).toBe(Math.ceil('screen'.length / 4) + perImageTokens)
  })

  it('charges per-image for BOTH image-data and media parts in historical tool results', () => {
    const perImageTokens = 1600
    const acc = createTokenAccounting({ getCapabilities: fixedCaps(KNOWN_CAPS), perImageTokens })
    const shot = toolExchange([{ toolCallId: 'c1', toolName: 'screenshot', output: screenshotOutput() }])
    const media = toolExchange([{ toolCallId: 'c2', toolName: 'screenshot', output: mediaOutput() }])
    const before = acc.estimate([userText(TEXT)])
    const after = acc.estimate([userText(TEXT), ...shot, ...media])
    expect(after - before).toBeGreaterThanOrEqual(2 * perImageTokens)
  })
})

describe('createTokenAccounting — recordUsage anchor', () => {
  it('floors a subsequent matching-prefix estimate to the recorded inputTokens', () => {
    const acc = createTokenAccounting({ getCapabilities: fixedCaps(KNOWN_CAPS) })
    const messages: ModelMessage[] = [systemMessage(), userText(TEXT)]
    const before = acc.estimate(messages)
    acc.recordUsage(usage(before + 5000), messages)
    // Same prefix, plus a new appended turn: the anchor floors the estimate up.
    const grown: ModelMessage[] = [...messages, assistantText('ok'), userText('next')]
    expect(acc.estimate(grown)).toBeGreaterThanOrEqual(before + 5000)
  })

  it('is a no-op when usage.inputTokens is undefined (pure chars/4 stays)', () => {
    const acc = createTokenAccounting({ getCapabilities: fixedCaps(KNOWN_CAPS) })
    const messages: ModelMessage[] = [userText(TEXT)]
    const before = acc.estimate(messages)
    acc.recordUsage(usage(undefined), messages)
    expect(acc.estimate(messages)).toBe(before)
  })

  it('does not floor once the anchored prefix identity no longer matches', () => {
    const acc = createTokenAccounting({ getCapabilities: fixedCaps(KNOWN_CAPS) })
    const messages: ModelMessage[] = [systemMessage(), userText(TEXT)]
    acc.recordUsage(usage(99999), messages)
    // A different prefix (edited first turn) must not inherit the stale anchor.
    const diverged: ModelMessage[] = [systemMessage(), userText('a completely different opening turn')]
    expect(acc.estimate(diverged)).toBe(acc.estimate(diverged.map(m => m)))
    expect(acc.estimate(diverged)).toBeLessThan(99999)
  })

  it('ignores outputTokens (thinking models never self-trigger degrade)', () => {
    const acc = createTokenAccounting({ getCapabilities: fixedCaps(KNOWN_CAPS) })
    const messages: ModelMessage[] = [userText(TEXT)]
    const before = acc.estimate(messages)
    acc.recordUsage(usage(before), messages)
    expect(acc.estimate(messages)).toBe(before)
  })
})

describe('createTokenAccounting — getCeilings reactive thunk', () => {
  const profile: ModelProfile = {
    provider: 'openai-compatible',
    model: 'totally-unknown-model-xyz',
    auth: { mode: 'api-key' },
  }

  afterEach(() => {
    overrideStore.delete(capabilityKey(profile.provider, profile.model))
  })

  it('returns contextWindow/maxOutput from the thunk', () => {
    const acc = createTokenAccounting({ getCapabilities: fixedCaps(KNOWN_CAPS) })
    expect(acc.getCeilings()).toEqual({
      contextWindow: KNOWN_CAPS.contextWindow,
      maxOutput: KNOWN_CAPS.maxOutput,
    })
  })

  it('yields the smallest window (UNKNOWN_FLOOR) for an unknown family', () => {
    const acc = createTokenAccounting({ getCapabilities: () => resolveCapabilities(profile) })
    expect(acc.getCeilings().contextWindow).toBe(8192)
    expect(acc.getCeilings().maxOutput).toBe(4096)
  })

  it('reflects an override-store window shrink on the very next call', () => {
    const acc = createTokenAccounting({ getCapabilities: () => resolveCapabilities(profile) })
    expect(acc.getCeilings().contextWindow).toBe(8192)
    overrideStore.set(capabilityKey(profile.provider, profile.model), 4000)
    expect(acc.getCeilings().contextWindow).toBe(4000)
  })
})

describe('createTokenAccounting — degrade delegates policy-free', () => {
  it('reduces messages via the instance estimate when over budget', () => {
    const acc = createTokenAccounting({ getCapabilities: fixedCaps(KNOWN_CAPS) })
    const big = 'x'.repeat(4000)
    const messages: ModelMessage[] = [
      systemMessage(),
      userText('first request'),
      ...toolExchange([{ toolCallId: 't1', toolName: 'inspect', output: { type: 'text', value: big } }]),
      userText('final request'),
    ]
    const budget = 50
    const outcome = acc.degrade(messages, { budget })
    expect(outcome.ok).toBe(true)
    expect(acc.estimate(outcome.messages)).toBeLessThan(acc.estimate(messages))
  })
})
