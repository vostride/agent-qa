// Unit tests for the runner-owned LLMVerifier (353-03, D-02). The v1
// core/src/agent/__tests__/verifier.test.ts was a loop-integration test (executeStep)
// and belongs with the loop re-derivation (wave 4); these assert the verifier's own
// contract with a mocked `ai` model: structured output → VerifyResult, never-crash
// fallback, and abort rethrow (T-353-07 — abort is the only rethrow).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NoObjectGeneratedError } from 'ai'
import type { ScreenState } from '@vostride/agent-qa-schema'
import { asRef } from '@vostride/agent-qa-schema'
import type { Action } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { LLMVerifier } from '../verifier.js'
import type { ExtractField } from '../types.js'
import { makeFakeTokenAccounting } from './loop-harness.js'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateText: vi.fn(),
    Output: { ...actual.Output, object: vi.fn((config: any) => config) },
  }
})

const before: ScreenState = makeScreenState()
const after: ScreenState = makeScreenState({ url: 'https://example.test/after' })
const action: Action = { type: 'click', ref: asRef('e2') }

// 2026-10-11 (439-01): the model's structured output is per-condition (D-07, D-10).
function metOutput(reasoning: string) {
  return {
    conditions: [{
      quote: 'log in',
      verdict: 'met',
      needs: 'none',
      controlRef: '',
      file: { name: '', match: 'none', text: '' },
      citations: [{ source: 'final-screen', quote: 'button "Log in"' }],
      reasoning,
    }],
    dialogs: [],
    isAppError: false,
    reasoning,
  }
}

describe('LLMVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps structured verification output to VerifyResult (success/reasoning/isAppError)', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockResolvedValueOnce({
      output: metOutput('The login form submitted and the dashboard is shown'),
      usage: { inputTokens: 120, outputTokens: 30 },
    } as any)

    const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
    const result = await verifier.verify('log in', before, after, action)

    expect(result.verification.conditions.map((condition) => condition.verdict)).toEqual(['met'])
    expect(result.verification.verifierError).toBeUndefined()
    expect(result.verification.reasoning).toContain('dashboard')
    expect(result.verification.isAppError).toBe(false)
    expect(result.tokenUsage).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 150 })
  })

  it('returns the failed-verification fallback on a non-abort model error, never throws', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockRejectedValueOnce(new Error('Overloaded'))

    const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
    const result = await verifier.verify('log in', before, after, action)

    expect(result.verification.conditions).toEqual([])
    expect(result.verification.verifierError).toBe('Overloaded')
    expect(result.verification.isAppError).toBe(false)
    expect(result.verification.reasoning).toContain('Verification failed')
    expect(result.verification.reasoning).toContain('Overloaded')
  })

  it('rethrows when the abort signal is aborted (the loop abort path depends on it)', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    const abortError = new Error('The operation was aborted')
    mockGenerateText.mockRejectedValueOnce(abortError)

    const controller = new AbortController()
    controller.abort()

    const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
    await expect(
      verifier.verify('log in', before, after, action, undefined, controller.signal),
    ).rejects.toThrow('The operation was aborted')
  })

  it('throws-then-catches empty output into the fallback (never-crash)', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockResolvedValueOnce({ output: undefined } as any)

    const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
    const result = await verifier.verify('log in', before, after, action)

    expect(result.verification.conditions).toEqual([])
    expect(result.verification.verifierError).toBeDefined()
    expect(result.verification.reasoning).toContain('Verification failed')
  })

  // Phase 355-01 (CTXB-04 / D-10) — RED until Plan 06 injects the TokenAccounting port
  // into LLMVerifier and feeds recordUsage(result.usage, messages) after each response.
  it('feeds the injected TokenAccounting recordUsage exactly once per response (D-10)', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockResolvedValueOnce({
      output: metOutput('The dashboard is shown'),
      usage: { inputTokens: 120, outputTokens: 30 },
    } as any)

    const accounting = makeFakeTokenAccounting()
    const verifier = new LLMVerifier({} as any, accounting)
    await verifier.verify('log in', before, after, action)

    expect(accounting.recordUsageCalls).toHaveLength(1)
    expect(accounting.recordUsageCalls[0].messages.length).toBeGreaterThan(0)
  })

  describe('judgeClaim', () => {
    it('makes exactly one generateText call and maps the closed judgment schema to verdict + rationale', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockResolvedValueOnce({
        output: { verdict: true, rationale: 'the welcome banner reads Welcome' },
        usage: { inputTokens: 80, outputTokens: 20 },
      } as any)

      const accounting = makeFakeTokenAccounting()
      const verifier = new LLMVerifier({} as any, accounting)
      const result = await verifier.judgeClaim('the welcome banner is visible', before, { mode: 'multimodal' })

      expect(mockGenerateText).toHaveBeenCalledTimes(1)
      expect(mockGenerateText.mock.calls[0][0].maxRetries).toBe(0)
      expect(result).toEqual({
        outcome: 'judged',
        verdict: true,
        rationale: 'the welcome banner reads Welcome',
      })
      expect(accounting.recordUsageCalls).toHaveLength(1)
    })

    it('an answer that is not a valid verdict is unresolved', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockResolvedValueOnce({ output: undefined } as any)

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const result = await verifier.judgeClaim('anything', before, { mode: 'multimodal' })

      expect(result).toEqual({
        outcome: 'unresolved',
        reason: "the model's answer was not a valid verdict",
      })
    })

    it('an answer the AI SDK rejects against the schema is not a valid verdict', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockRejectedValueOnce(
        new NoObjectGeneratedError({
          message: 'No object generated: response did not match schema.',
          text: '{"verdict":"yes"}',
          response: undefined as any,
          usage: undefined as any,
          finishReason: 'stop',
        }),
      )

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const result = await verifier.judgeClaim('anything', before, { mode: 'multimodal' })

      expect(result).toEqual({
        outcome: 'unresolved',
        reason: "the model's answer was not a valid verdict",
      })
    })

    it('an empty answer is a failed model call', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockRejectedValueOnce(
        new NoObjectGeneratedError({
          message: 'No object generated: could not parse the response.',
          text: '',
          response: undefined as any,
          usage: undefined as any,
          finishReason: 'stop',
        }),
      )

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const result = await verifier.judgeClaim('anything', before, { mode: 'multimodal' })

      expect(result).toEqual({
        outcome: 'unresolved',
        reason: 'the model call failed: the model returned an empty answer',
      })
    })

    it("a failed model call is unresolved with the provider's message", async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockRejectedValueOnce(new Error('Overloaded'))

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const result = await verifier.judgeClaim('anything', before, { mode: 'multimodal' })

      expect(result).toEqual({ outcome: 'unresolved', reason: 'the model call failed: Overloaded' })
    })

    it('rethrows when the abort signal is aborted (the loop abort path depends on it)', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockRejectedValueOnce(new Error('The operation was aborted'))

      const controller = new AbortController()
      controller.abort()
      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      await expect(
        verifier.judgeClaim('anything', before, { mode: 'multimodal', abortSignal: controller.signal }),
      ).rejects.toThrow('The operation was aborted')
    })

    function turnParts(call: unknown): { type: string; text?: string }[] {
      const messages = (call as { messages: { content: { type: string; text?: string }[] }[] }).messages
      return messages[0]!.content
    }

    it('text sends a text-only turn even with a screenshot', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockResolvedValueOnce({
        output: { verdict: true, rationale: 'the banner reads Welcome' },
        usage: { inputTokens: 80, outputTokens: 20 },
      } as any)

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      await verifier.judgeClaim('the banner is visible', before, {
        mode: 'text',
        screenshot: Buffer.from('png'),
      })

      const parts = turnParts(mockGenerateText.mock.calls[0][0])
      expect(parts.some((part) => part.type === 'image')).toBe(false)
      expect(parts[0]?.text).toContain(
        'Judge it from the accessibility tree only; no screenshot is attached.',
      )
    })

    it('visual with a screenshot attaches it and names the mode', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockResolvedValueOnce({
        output: { verdict: true, rationale: 'the banner is green' },
        usage: { inputTokens: 80, outputTokens: 20 },
      } as any)

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      await verifier.judgeClaim('the banner is green', before, {
        mode: 'visual',
        screenshot: Buffer.from('png'),
      })

      const parts = turnParts(mockGenerateText.mock.calls[0][0])
      expect(parts.some((part) => part.type === 'image')).toBe(true)
      expect(parts[0]?.text).toContain(
        'Judge it from the attached screenshot together with the accessibility tree.',
      )
    })

    it('visual with no screenshot makes no model call', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const result = await verifier.judgeClaim('the banner is green', before, { mode: 'visual' })

      expect(mockGenerateText).not.toHaveBeenCalled()
      expect(result).toEqual({ outcome: 'unresolved', reason: 'no screenshot to judge a visual claim' })
    })
  })

  describe('extractData', () => {
    const fields = [{ name: 'orderId', type: 'string' as const, description: 'the order id' }]

    it('makes exactly one generateText call and returns the extracted fields', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockResolvedValueOnce({
        output: { orderId: 'ORD-9' },
        usage: { inputTokens: 60, outputTokens: 10 },
      } as any)

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const result = await verifier.extractData('extract the order id', before, { fields })

      expect(mockGenerateText).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ outcome: 'extracted', fields: { orderId: 'ORD-9' } })
    })

    it("a failed model call is unresolved with the provider's message", async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockRejectedValueOnce(new Error('Overloaded'))

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const result = await verifier.extractData('extract the order id', before, { fields })

      expect(result).toEqual({ outcome: 'unresolved', reason: 'the model call failed: Overloaded' })
    })

    it('an answer that does not match the declared fields is unresolved', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockResolvedValueOnce({
        output: { orderId: 9 },
        usage: { inputTokens: 60, outputTokens: 10 },
      } as any)

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const result = await verifier.extractData('extract the order id', before, { fields })

      expect(result).toEqual({
        outcome: 'unresolved',
        reason: "the model's answer did not match the declared fields",
      })
    })

    it('an answer the AI SDK rejects against the schema is unresolved', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockRejectedValueOnce(
        new NoObjectGeneratedError({
          message: 'No object generated: response did not match schema.',
          text: '{"orderId":9}',
          response: undefined as any,
          usage: undefined as any,
          finishReason: 'stop',
        }),
      )

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const result = await verifier.extractData('extract the order id', before, { fields })

      expect(result).toEqual({
        outcome: 'unresolved',
        reason: "the model's answer did not match the declared fields",
      })
    })

    it('an empty answer is a failed model call', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockRejectedValueOnce(
        new NoObjectGeneratedError({
          message: 'No object generated: could not parse the response.',
          text: '',
          response: undefined as any,
          usage: undefined as any,
          finishReason: 'stop',
        }),
      )

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const result = await verifier.extractData('extract the order id', before, { fields })

      expect(result).toEqual({
        outcome: 'unresolved',
        reason: 'the model call failed: the model returned an empty answer',
      })
    })

    it('extractData rethrows when the abort signal is aborted', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockRejectedValueOnce(new Error('The operation was aborted'))

      const controller = new AbortController()
      controller.abort()
      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      await expect(
        verifier.extractData('extract the order id', before, {
          fields,
          abortSignal: controller.signal,
        }),
      ).rejects.toThrow('The operation was aborted')
    })

    const orderFields: ExtractField[] = [
      { name: 'orderNumber', type: 'string', description: 'the order number' },
      { name: 'total', type: 'number', description: 'the order total' },
      { name: 'giftWrap', type: 'boolean', description: 'whether gift wrap is on' },
      { name: 'items', type: 'array', description: 'the item names', item: { type: 'string' } },
      { name: 'address', type: 'object', description: 'the delivery address' },
      { name: 'notes', type: 'string', description: 'the delivery notes' },
    ]
    const orderAnswer = {
      orderNumber: 'A-1042',
      total: 59.9,
      giftWrap: true,
      items: ['Mug', 'Tea, loose leaf'],
      address: '{"city":"Pune","pin":"411001"}',
      notes: null,
    }

    async function extractWith(output: unknown, declared: ExtractField[] = orderFields) {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockResolvedValueOnce({
        output,
        usage: { inputTokens: 60, outputTokens: 10 },
      } as any)
      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const result = await verifier.extractData('read the order', before, { fields: declared })
      return { result, call: mockGenerateText.mock.calls[0]![0] as any }
    }

    const notTheFields = {
      outcome: 'unresolved',
      reason: "the model's answer did not match the declared fields",
    }

    it('the schema sent to the model is typed, nullable and complete', async () => {
      const { call } = await extractWith(orderAnswer)
      const { zodSchema } = await import('ai')
      const sent = (await zodSchema(call.output.schema).jsonSchema) as any

      expect(sent.required).toEqual(orderFields.map((field) => field.name))
      expect(sent.properties.total.type).toEqual(['number', 'null'])
      expect(sent.properties.address.type).toEqual(['string', 'null'])
      expect(sent.properties.giftWrap.type).toEqual(['boolean', 'null'])
    })

    it('typed values and nulls come back typed', async () => {
      const { result } = await extractWith(orderAnswer)

      expect(result).toEqual({
        outcome: 'extracted',
        fields: {
          orderNumber: 'A-1042',
          total: 59.9,
          giftWrap: true,
          items: ['Mug', 'Tea, loose leaf'],
          address: { city: 'Pune', pin: '411001' },
          notes: null,
        },
      })
    })

    it('a string where a number is declared does not match the declared fields', async () => {
      const { result } = await extractWith({ ...orderAnswer, total: '59.9' })
      expect(result).toEqual(notTheFields)
    })

    it('a missing declared field does not match the declared fields', async () => {
      const { notes: _notes, ...withoutNotes } = orderAnswer
      const { result } = await extractWith(withoutNotes)
      expect(result).toEqual(notTheFields)
    })

    it.each(['[1,2]', '5', 'not json'])(
      'object text that is not a JSON object does not match the declared fields (%s)',
      async (text) => {
        const { result } = await extractWith({ ...orderAnswer, address: text })
        expect(result).toEqual(notTheFields)
      },
    )

    it.each([
      ['a field type outside the declared types', { name: 'when', type: 'date', description: 'd' }],
      ['a field with no type', { name: 'when', description: 'd' }],
      [
        'an array item type outside the declared types',
        { name: 'when', type: 'array', description: 'd', item: { type: 'date' } },
      ],
    ])('%s does not match the declared fields and makes no model call', async (_label, field) => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())

      const result = await verifier.extractData('read the order', before, {
        fields: [field as unknown as ExtractField],
      })

      expect(result).toEqual(notTheFields)
      expect(mockGenerateText).not.toHaveBeenCalled()
    })

    it('an array of objects decodes every item, and one bad item does not match', async () => {
      const lines: ExtractField[] = [
        { name: 'lines', type: 'array', description: 'the order lines', item: { type: 'object' } },
      ]

      const decoded = await extractWith({ lines: ['{"sku":"A"}', '{"sku":"B"}'] }, lines)
      expect(decoded.result).toEqual({
        outcome: 'extracted',
        fields: { lines: [{ sku: 'A' }, { sku: 'B' }] },
      })

      const bad = await extractWith({ lines: ['{"sku":"A"}', 'x'] }, lines)
      expect(bad.result).toEqual(notTheFields)
    })
  })
})
