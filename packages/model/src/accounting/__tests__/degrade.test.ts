import type { ModelMessage, ToolResultPart } from 'ai'
import { describe, expect, it } from 'vitest'

import { degrade } from '../degrade.js'
import {
  FIXTURE_IMAGE_DATA,
  assistantReasoning,
  assistantText,
  makeModelMessages,
  screenshotOutput,
  systemMessage,
  textOutput,
  toolExchange,
  userText,
} from './message-fixtures.js'

const HYGIENE_ONLY = { budget: Number.MAX_SAFE_INTEGER }

function reasoningTexts(message: ModelMessage): string[] {
  if (!Array.isArray(message.content)) return []
  const texts: string[] = []
  for (const part of message.content) {
    if (part.type === 'reasoning') texts.push(part.text)
  }
  return texts
}

function toolResults(message: ModelMessage): ToolResultPart[] {
  if (message.role !== 'tool') return []
  return message.content.filter((part): part is ToolResultPart => part.type === 'tool-result')
}

describe('degrade — hygiene pass', () => {
  it('strips reasoning from historical assistant turns while preserving message order', () => {
    const messages: ModelMessage[] = [
      systemMessage(),
      userText('first'),
      assistantReasoning('early thinking', 'early answer'),
      userText('second'),
      assistantText('later answer'),
    ]

    const outcome = degrade(messages, HYGIENE_ONLY)
    expect(outcome.ok).toBe(true)

    const result = outcome.messages
    // Order preserved, roles unchanged.
    expect(result.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant'])
    // The historical assistant reasoning is gone; the text survives.
    expect(reasoningTexts(result[2])).toEqual([])
    expect(Array.isArray(result[2].content) && result[2].content.some(p => p.type === 'text')).toBe(true)
  })

  it("keeps the last message's reasoning (reasoning: 'before-last-message')", () => {
    const messages: ModelMessage[] = [
      systemMessage(),
      userText('go'),
      assistantReasoning('final thinking', 'final answer'),
    ]

    const result = degrade(messages, HYGIENE_ONLY).messages
    const last = result[result.length - 1]
    expect(reasoningTexts(last)).toContain('final thinking')
  })

  it('strips base64 from a historical image-data tool result, keeping the most recent verbatim', () => {
    const messages: ModelMessage[] = [
      systemMessage(),
      userText('inspect'),
      ...toolExchange([{ toolCallId: 'hist-shot', toolName: 'screenshot', output: screenshotOutput() }]),
      userText('again'),
      ...toolExchange([{ toolCallId: 'recent-shot', toolName: 'screenshot', output: screenshotOutput() }]),
    ]

    const result = degrade(messages, HYGIENE_ONLY).messages

    // Historical screenshot: base64 gone.
    const historical = result.flatMap(toolResults).find(r => r.toolCallId === 'hist-shot')!
    const serialized = JSON.stringify(historical)
    expect(serialized).not.toContain(FIXTURE_IMAGE_DATA)
    expect(serialized).toContain('historical screenshot omitted')

    // Most recent screenshot: preserved verbatim (base64 intact).
    const recent = result.flatMap(toolResults).find(r => r.toolCallId === 'recent-shot')!
    expect(JSON.stringify(recent)).toContain(FIXTURE_IMAGE_DATA)
  })

  it('hash-dedups content-identical historical tool results down to a one-liner', () => {
    const messages: ModelMessage[] = [
      systemMessage(),
      userText('a'),
      ...toolExchange([{ toolCallId: 'dup-1', toolName: 'inspect', output: textOutput('IDENTICAL PAYLOAD') }]),
      userText('b'),
      ...toolExchange([{ toolCallId: 'dup-2', toolName: 'inspect', output: textOutput('IDENTICAL PAYLOAD') }]),
      userText('c'),
      // A final tool message so both dup exchanges are historical.
      ...toolExchange([{ toolCallId: 'final', toolName: 'inspect', output: textOutput('final') }]),
    ]

    const result = degrade(messages, HYGIENE_ONLY).messages
    const all = result.flatMap(toolResults)
    const second = all.find(r => r.toolCallId === 'dup-2')!
    expect(second.output).toEqual({ type: 'text', value: '…[duplicate tool result elided]' })
  })

  it('removes messages emptied by pruning while preserving the rest', () => {
    const messages: ModelMessage[] = [
      systemMessage(),
      userText('keep me'),
      { role: 'assistant', content: [{ type: 'reasoning', text: 'only reasoning, becomes empty' }] },
      userText('final'),
    ]

    const result = degrade(messages, HYGIENE_ONLY).messages
    // The reasoning-only assistant message collapses to empty and is removed.
    expect(result.map(m => m.role)).toEqual(['system', 'user', 'user'])
  })
})

describe('degrade — determinism', () => {
  it('same input twice ⇒ deep-equal output', () => {
    const first = degrade(makeModelMessages(), HYGIENE_ONLY)
    const second = degrade(makeModelMessages(), HYGIENE_ONLY)
    expect(first).toEqual(second)
  })

  it('does not mutate its input', () => {
    const input = makeModelMessages()
    const snapshot = JSON.stringify(input)
    degrade(input, HYGIENE_ONLY)
    expect(JSON.stringify(input)).toEqual(snapshot)
  })
})

const TRUNCATION_MARKER = '…[truncated to fit context budget]'
// One token per message — lets a test force N evictions deterministically.
const perMessage = (messages: ModelMessage[]): number => messages.length

function allCallIds(messages: ModelMessage[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) if (part.type === 'tool-call') ids.push(part.toolCallId)
    }
  }
  return ids
}

function allResultIds(messages: ModelMessage[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const part of message.content) if (part.type === 'tool-result') ids.push(part.toolCallId)
    } else if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) if (part.type === 'tool-result') ids.push(part.toolCallId)
    }
  }
  return ids
}

function mixedExchangeHistory(): ModelMessage[] {
  return [
    systemMessage(),
    userText('start'),
    ...toolExchange([{ toolCallId: 'ex1', toolName: 'inspect', output: textOutput('r1') }]),
    ...toolExchange([
      { toolCallId: 'ex2a', toolName: 'inspect', output: textOutput('r2a') },
      { toolCallId: 'ex2b', toolName: 'inspect', output: textOutput('r2b') },
    ]),
    ...toolExchange([{ toolCallId: 'ex3', toolName: 'inspect', output: textOutput('r3') }]),
    userText('most recent instruction'),
  ]
}

describe('degrade — eviction', () => {
  it('leaves no orphaned tool-call/tool-result after any degrade (single + fan-out)', () => {
    // Budget forces some but not all exchanges to be evicted.
    for (const budget of [3, 4, 5, 6, 7]) {
      const result = degrade(mixedExchangeHistory(), { budget, estimate: perMessage }).messages
      const calls = new Set(allCallIds(result))
      const results = new Set(allResultIds(result))
      // Every remaining tool-result has a matching tool-call and vice versa.
      for (const id of results) expect(calls.has(id)).toBe(true)
      for (const id of calls) expect(results.has(id)).toBe(true)
    }
  })

  it('evicts the oldest exchange first, keeping newer exchanges', () => {
    // 9 messages; budget 7 ⇒ evict exactly the oldest exchange (ex1).
    const result = degrade(mixedExchangeHistory(), { budget: 7, estimate: perMessage }).messages
    const ids = new Set([...allCallIds(result), ...allResultIds(result)])
    expect(ids.has('ex1')).toBe(false)
    // The multi-tool fan-out and the newest exchange survive intact.
    expect(ids.has('ex2a')).toBe(true)
    expect(ids.has('ex2b')).toBe(true)
    expect(ids.has('ex3')).toBe(true)
  })

  it('evicts a multi-tool fan-out exchange atomically (never half)', () => {
    // Tight budget forces eviction past the fan-out exchange.
    const result = degrade(mixedExchangeHistory(), { budget: 3, estimate: perMessage }).messages
    const ids = new Set([...allCallIds(result), ...allResultIds(result)])
    // ex2a and ex2b always travel together.
    expect(ids.has('ex2a')).toBe(ids.has('ex2b'))
  })
})

describe('degrade — truncation + pins', () => {
  const bigText = 'X'.repeat(2000)

  it('truncates the largest unpinned message with the spec marker, leaving system/final byte-identical', () => {
    const system = systemMessage()
    const final = userText('final instruction stays whole')
    const messages: ModelMessage[] = [system, userText(bigText), final]

    // No tool exchanges ⇒ eviction cannot help ⇒ truncation fires. Default chars/4 estimator.
    const outcome = degrade(messages, { budget: 40 })
    expect(outcome.ok).toBe(true)

    const result = outcome.messages
    const truncated = result[1]
    const text = Array.isArray(truncated.content)
      ? truncated.content.map(p => (p.type === 'text' ? p.text : '')).join('')
      : String(truncated.content)
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(text.length).toBeLessThan(bigText.length)

    // Protected messages untouched.
    expect(result[0]).toEqual(system)
    expect(result[result.length - 1]).toEqual(final)
  })

  it('never truncates or evicts a caller-pinned message', () => {
    const pinnedText = 'PINNED-KEEP-VERBATIM'
    const messages: ModelMessage[] = [
      systemMessage(),
      { role: 'user', content: [{ type: 'text', text: pinnedText }] },
      userText(bigText),
      userText('final'),
    ]
    const pin = (message: ModelMessage): boolean =>
      Array.isArray(message.content) && message.content.some(p => p.type === 'text' && p.text === pinnedText)

    const result = degrade(messages, { budget: 40, pin }).messages
    const pinnedStill = result.find(
      m => Array.isArray(m.content) && m.content.some(p => p.type === 'text' && p.text === pinnedText),
    )
    expect(pinnedStill).toBeDefined()
    // The big unpinned message got the marker; the pinned one is verbatim.
    expect(JSON.stringify(result)).toContain(TRUNCATION_MARKER)
    expect(JSON.stringify(pinnedStill)).not.toContain(TRUNCATION_MARKER)
  })

  it('does not evict a pinned tool exchange', () => {
    const messages: ModelMessage[] = [
      systemMessage(),
      userText('start'),
      ...toolExchange([{ toolCallId: 'pinned-ex', toolName: 'inspect', output: textOutput('keep') }]),
      ...toolExchange([{ toolCallId: 'free-ex', toolName: 'inspect', output: textOutput('drop') }]),
      userText('final'),
    ]
    // Pin the assistant message holding the 'pinned-ex' tool call.
    const pin = (message: ModelMessage): boolean =>
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      message.content.some(p => p.type === 'tool-call' && p.toolCallId === 'pinned-ex')

    const result = degrade(messages, { budget: 5, estimate: perMessage, pin }).messages
    const ids = new Set([...allCallIds(result), ...allResultIds(result)])
    expect(ids.has('pinned-ex')).toBe(true)
    expect(ids.has('free-ex')).toBe(false)
  })
})

describe('degrade — cannot-fit', () => {
  it('returns a structured cannot-fit when pinned content alone exceeds budget (never throws)', () => {
    const pinnedMarker = 'PINNED-HUGE-'
    const pinnedBig: ModelMessage = {
      role: 'user',
      content: [{ type: 'text', text: pinnedMarker + 'P'.repeat(4000) }],
    }
    const messages: ModelMessage[] = [systemMessage(), pinnedBig, userText('final')]
    // Content-based pin: object identity does not survive the hygiene pass.
    const pin = (message: ModelMessage): boolean =>
      Array.isArray(message.content) &&
      message.content.some(p => p.type === 'text' && p.text.startsWith(pinnedMarker))

    let outcome!: ReturnType<typeof degrade>
    expect(() => {
      outcome = degrade(messages, { budget: 5, pin })
    }).not.toThrow()

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('pinned-content-exceeds-budget')
      expect(Array.isArray(outcome.messages)).toBe(true)
    }
  })
})
