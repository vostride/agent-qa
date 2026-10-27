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
      const result = await verifier.judgeClaim('the welcome banner is visible', before)

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
      const result = await verifier.judgeClaim('anything', before)

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
      const result = await verifier.judgeClaim('anything', before)

      expect(result).toEqual({
        outcome: 'unresolved',
        reason: "the model's answer was not a valid verdict",
      })
    })

    it("a failed model call is unresolved with the provider's message", async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockRejectedValueOnce(new Error('Overloaded'))

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const result = await verifier.judgeClaim('anything', before)

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
        verifier.judgeClaim('anything', before, { abortSignal: controller.signal }),
      ).rejects.toThrow('The operation was aborted')
    })
  })

  describe('extractData (AI extraction lane, D-07)', () => {
    it('makes exactly one generateText call and returns the extracted field map', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockResolvedValueOnce({
        output: { orderId: 'ORD-9' },
        usage: { inputTokens: 60, outputTokens: 10 },
      } as any)

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const fields = await verifier.extractData('extract the order id', before, {
        schema: [{ name: 'orderId', type: 'string', description: 'the order id' }],
        scope: 'run',
      })

      expect(mockGenerateText).toHaveBeenCalledTimes(1)
      expect(fields).toEqual({ orderId: 'ORD-9' })
    })

    it('degrades a failed extraction to an empty map, never throws', async () => {
      const { generateText } = await import('ai')
      const mockGenerateText = vi.mocked(generateText)
      mockGenerateText.mockRejectedValueOnce(new Error('Overloaded'))

      const verifier = new LLMVerifier({} as any, makeFakeTokenAccounting())
      const fields = await verifier.extractData('extract the order id', before)

      expect(fields).toEqual({})
    })
  })
})
