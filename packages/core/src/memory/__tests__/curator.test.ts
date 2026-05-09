import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestResult } from '../../types/result.js'
import type { MemoryProvider } from '../provider.js'
import type { ProviderOptions } from '../../agent/provider.js'

vi.mock('ai', () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn((config: unknown) => config),
  },
}))

function makeProvider(): MemoryProvider {
  return {
    init: vi.fn(),
    queryForStep: vi.fn(),
    destroy: vi.fn(),
    acquireLock: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    writeObservation: vi.fn().mockResolvedValue('obs-path'),
    deleteObservation: vi.fn().mockResolvedValue(undefined),
    searchForDuplicates: vi.fn().mockReturnValue([]),
    getAllObservations: vi.fn().mockReturnValue([]),
    getInjectedObservations: vi.fn().mockReturnValue([]),
    getRunAnalytics: vi.fn(),
  }
}

function makeResult(): TestResult {
  return {
    name: 'Hacker News homepage loads correctly',
    filePath: 'tests/web/01-homepage-basics.yaml',
    status: 'passed',
    steps: [
      {
        name: 'Navigate to the homepage',
        status: 'passed',
        duration: 50,
        trace: {
          observation: 'homepage visible',
          reasoning: 'navigation succeeded',
          plannedAction: { type: 'navigate', url: 'https://news.ycombinator.com' },
          result: 'success',
          screenStateBefore: 'homepage visible',
          subActions: [],
        },
      },
    ],
    duration: 50,
  }
}

describe('runCurator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes product, suite, and test observations with title + content and scope-specific depth', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockResolvedValueOnce({
      output: {
        decisions: [
          {
            action: 'add',
            title: 'Navigation: account recovery links live under the Security section',
            content: [
              'The account settings page groups recovery links under the Security section, not the profile header.',
              '',
              '- Recovery codes',
              '- Backup email',
            ].join('\n'),
            scope: 'product',
            reasoning: 'Product memory should keep this structural navigation fact.',
          },
          {
            action: 'add',
            title: 'Checkout suite: shipping step always precedes payment',
            content: 'Across the checkout suite, the Shipping step consistently appears before Payment and Review.',
            scope: 'suite',
            reasoning: 'Suite memory should stay short and capture cross-flow ordering.',
          },
          {
            action: 'add',
            title: 'Promo code validation: error appears only after blur',
            content: 'In this test, the promo code error did not appear until the field lost focus.',
            scope: 'test',
            reasoning: 'Test memory should stay scenario-specific.',
          },
        ],
      },
      usage: { inputTokens: 24, outputTokens: 18 },
    } as any)

    const { runCurator } = await import('../curator.js')
    const provider = makeProvider()

    const log = await runCurator({
      testResult: makeResult(),
      provider,
      model: {} as any,
      memoryRoot: 'agent-qa-memory',
      product: 'hacker-news',
      testId: 't_lack-auto-quit-dow-boat-urus',
      suiteId: 'suite_checkout',
      suiteContext: {
        position: 2,
        tests: [
          { test: 'tests/web/checkout.yaml', id: 't_checkout-step-one' },
          { test: 'tests/web/payment.yaml', id: 't_payment-step-two' },
        ],
      },
      injectedObservationIds: new Map(),
    })

    expect(provider.writeObservation).toHaveBeenCalledTimes(3)
    expect(provider.writeObservation).toHaveBeenNthCalledWith(
      1,
      'products',
      'hacker-news',
      expect.objectContaining({
        title: 'Navigation: account recovery links live under the Security section',
        content: expect.stringContaining('- Recovery codes'),
      }),
    )
    expect(provider.writeObservation).toHaveBeenNthCalledWith(
      2,
      'suites',
      'suite_checkout',
      expect.objectContaining({
        title: 'Checkout suite: shipping step always precedes payment',
        position: 2,
        suite_snapshot: [
          { test: 'tests/web/checkout.yaml', id: 't_checkout-step-one' },
          { test: 'tests/web/payment.yaml', id: 't_payment-step-two' },
        ],
      }),
    )
    expect(provider.writeObservation).toHaveBeenNthCalledWith(
      3,
      'tests',
      't_lack-auto-quit-dow-boat-urus',
      expect.objectContaining({
        title: 'Promo code validation: error appears only after blur',
        content: 'In this test, the promo code error did not appear until the field lost focus.',
      }),
    )
    expect(log.added).toBe(3)
  })

  it('shows title and content for existing observations in the curator prompt', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockResolvedValueOnce({
      output: {
        decisions: [{ action: 'noop', reasoning: 'Existing memory already covers this run.' }],
      },
      usage: { inputTokens: 8, outputTokens: 4 },
    } as any)

    const { runCurator } = await import('../curator.js')
    const provider = makeProvider()
    vi.mocked(provider.getAllObservations).mockReturnValue([
      {
        id: 'obs_existing-title-aware-memory',
        title: 'Login modal: appears after a short delay',
        content: 'The login modal appears about two seconds after the page loads.',
        trust: 0.7,
      },
    ])

    await runCurator({
      testResult: makeResult(),
      provider,
      model: {} as any,
      memoryRoot: 'agent-qa-memory',
      product: 'hacker-news',
      testId: 't_lack-auto-quit-dow-boat-urus',
      injectedObservationIds: new Map(),
    })

    expect(mockGenerateText).toHaveBeenCalledOnce()
    const prompt = mockGenerateText.mock.calls[0]?.[0]?.prompt
    expect(prompt).toContain('Login modal: appears after a short delay')
    expect(prompt).toContain('The login modal appears about two seconds after the page loads.')
  })

  it('forwards providerOptions to generateText', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockResolvedValueOnce({
      output: {
        decisions: [{ action: 'noop', reasoning: 'No new memory worth storing' }],
      },
      usage: { inputTokens: 11, outputTokens: 7 },
    } as any)

    const { runCurator } = await import('../curator.js')

    const providerOptions: ProviderOptions = {
      openai: {
        instructions: 'You are a helpful assistant.',
        store: false,
      },
    }

    const log = await runCurator({
      testResult: makeResult(),
      provider: makeProvider(),
      model: {} as any,
      providerOptions,
      memoryRoot: 'agent-qa-memory',
      product: 'hacker-news',
      testId: 't_lack-auto-quit-dow-boat-urus',
      injectedObservationIds: new Map(),
    })

    expect(mockGenerateText).toHaveBeenCalledOnce()
    expect(mockGenerateText.mock.calls[0]?.[0]).toMatchObject({
      model: {},
      providerOptions,
    })
    expect(log.errors).toEqual([])
    expect(log.tokenUsage).toEqual({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    })
  })
})
