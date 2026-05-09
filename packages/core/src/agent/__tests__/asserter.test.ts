import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScreenState } from '../../types/platform.js'
import { AssertionEvaluator, LLMAssertionEvaluator, createAsserter } from '../asserter.js'
import type { AssertionInput } from '../types.js'

vi.mock('ai', () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn((config: any) => config),
  },
}))

function makeScreenState(overrides?: Partial<ScreenState>): ScreenState {
  return {
    tree: 'heading "Welcome to Dashboard"\nbutton "Logout" [ref=btn-1]\ntext "You have 3 items in your cart"\nlink "Settings" [ref=link-1]',
    elements: [
      { ref: 'h-1', role: 'heading', name: 'Welcome to Dashboard', attributes: {} },
      { ref: 'btn-1', role: 'button', name: 'Logout', attributes: {} },
      { ref: 'txt-1', role: 'text', name: 'You have 3 items in your cart', attributes: {} },
      { ref: 'link-1', role: 'link', name: 'Settings', attributes: {} },
    ],
    url: 'https://example.com/dashboard',
    timestamp: Date.now(),
    metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
    ...overrides,
  }
}

describe('AssertionEvaluator', () => {
  const evaluator = new AssertionEvaluator()

  describe('text-presence', () => {
    it('text found in screen tree → passes', async () => {
      const input: AssertionInput = { type: 'text-presence', value: 'Welcome to Dashboard' }
      const result = await evaluator.evaluate(input, makeScreenState())

      expect(result.passed).toBe(true)
      expect(result.assertionType).toBe('text-presence')
      expect(result.reasoning).toBeDefined()
    })

    it('text not found → fails with actual showing snippet', async () => {
      const input: AssertionInput = { type: 'text-presence', value: 'Nonexistent text' }
      const result = await evaluator.evaluate(input, makeScreenState())

      expect(result.passed).toBe(false)
      expect(result.assertionType).toBe('text-presence')
      expect(result.reasoning).toContain('not found')
    })

    it('case-insensitive match', async () => {
      const input: AssertionInput = { type: 'text-presence', value: 'welcome to dashboard' }
      const result = await evaluator.evaluate(input, makeScreenState())

      expect(result.passed).toBe(true)
    })
  })

  describe('element-visibility', () => {
    it('element with matching name exists → passes', async () => {
      const input: AssertionInput = { type: 'element-visibility', value: 'Logout' }
      const result = await evaluator.evaluate(input, makeScreenState())

      expect(result.passed).toBe(true)
      expect(result.assertionType).toBe('element-visibility')
    })

    it('no matching element → fails', async () => {
      const input: AssertionInput = { type: 'element-visibility', value: 'Delete Account' }
      const result = await evaluator.evaluate(input, makeScreenState())

      expect(result.passed).toBe(false)
      expect(result.assertionType).toBe('element-visibility')
      expect(result.reasoning).toContain('not found')
    })
  })

  describe('url-match', () => {
    it('exact URL matches → passes', async () => {
      const input: AssertionInput = { type: 'url-match', value: 'https://example.com/dashboard' }
      const result = await evaluator.evaluate(input, makeScreenState())

      expect(result.passed).toBe(true)
      expect(result.assertionType).toBe('url-match')
    })

    it('URL doesn\'t match → fails with actual URL', async () => {
      const input: AssertionInput = { type: 'url-match', value: 'https://example.com/settings' }
      const result = await evaluator.evaluate(input, makeScreenState())

      expect(result.passed).toBe(false)
      expect(result.actual).toContain('/dashboard')
    })

    it('glob pattern matches', async () => {
      const input: AssertionInput = { type: 'url-match', value: 'https://example.com/dash*' }
      const result = await evaluator.evaluate(input, makeScreenState())

      expect(result.passed).toBe(true)
    })
  })

  describe('element-count', () => {
    it('correct count → passes', async () => {
      const input: AssertionInput = { type: 'element-count', value: 'button', expected: '1' }
      const result = await evaluator.evaluate(input, makeScreenState())

      expect(result.passed).toBe(true)
      expect(result.assertionType).toBe('element-count')
    })

    it('wrong count → fails with actual count', async () => {
      const input: AssertionInput = { type: 'element-count', value: 'button', expected: '5' }
      const result = await evaluator.evaluate(input, makeScreenState())

      expect(result.passed).toBe(false)
      expect(result.actual).toBe('1')
    })

    it('element not found → count is 0, fails if expected > 0', async () => {
      const input: AssertionInput = { type: 'element-count', value: 'checkbox', expected: '2' }
      const result = await evaluator.evaluate(input, makeScreenState())

      expect(result.passed).toBe(false)
      expect(result.actual).toBe('0')
    })
  })
})

describe('LLMAssertionEvaluator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('AI assertion: "verify the cart has 3 items" with screen showing 3 items → passes', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockResolvedValueOnce({
      output: {
        passed: true,
        reasoning: 'The screen shows "You have 3 items in your cart"',
        evidence: 'text "You have 3 items in your cart"',
      },
    } as any)

    const evaluator = new LLMAssertionEvaluator({} as any)
    const input: AssertionInput = { type: 'ai', value: 'verify the cart has 3 items' }
    const result = await evaluator.evaluate(input, makeScreenState())

    expect(result.passed).toBe(true)
    expect(result.assertionType).toBe('ai')
    expect(result.reasoning).toContain('3 items')
  })

  it('AI assertion: "verify the user is logged in" with login button → fails', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockResolvedValueOnce({
      output: {
        passed: false,
        reasoning: 'The screen shows a Login button, indicating user is not logged in',
        evidence: 'button "Login"',
      },
    } as any)

    const screen = makeScreenState({
      tree: 'button "Login" [ref=btn-1]',
      elements: [{ ref: 'btn-1', role: 'button', name: 'Login', attributes: {} }],
    })

    const evaluator = new LLMAssertionEvaluator({} as any)
    const input: AssertionInput = { type: 'ai', value: 'verify the user is logged in' }
    const result = await evaluator.evaluate(input, screen)

    expect(result.passed).toBe(false)
    expect(result.assertionType).toBe('ai')
  })

  it('AI assertion: LLM error → returns failed with error message', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockRejectedValueOnce(new Error('Overloaded'))

    const evaluator = new LLMAssertionEvaluator({} as any)
    const input: AssertionInput = { type: 'ai', value: 'verify something' }
    const result = await evaluator.evaluate(input, makeScreenState())

    expect(result.passed).toBe(false)
    expect(result.reasoning).toContain('Overloaded')
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
  })
})

describe('createAsserter', () => {
  it('routes text-presence to explicit evaluator', async () => {
    const asserter = createAsserter()
    const input: AssertionInput = { type: 'text-presence', value: 'Welcome' }
    const result = await asserter.evaluate(input, makeScreenState())

    expect(result.passed).toBe(true)
    expect(result.assertionType).toBe('text-presence')
  })

  it('routes ai type to LLM evaluator', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockResolvedValueOnce({
      output: {
        passed: true,
        reasoning: 'Looks good',
        evidence: 'Evidence here',
      },
    } as any)

    const asserter = createAsserter({} as any)
    const input: AssertionInput = { type: 'ai', value: 'verify something' }
    const result = await asserter.evaluate(input, makeScreenState())

    expect(result.passed).toBe(true)
    expect(result.assertionType).toBe('ai')
  })

  it('throws if ai type requested without model', async () => {
    const asserter = createAsserter()
    const input: AssertionInput = { type: 'ai', value: 'verify something' }

    await expect(asserter.evaluate(input, makeScreenState())).rejects.toThrow()
  })
})
