import { generateText } from 'ai'
import { describe, expect, it } from 'vitest'

import type { ModelProfile, ModelProviderId } from '@vostride/agent-qa-schema'

import { ADAPTERS, getProviderOptions } from '../adapters/index.js'
import { applyProviderOptions, deriveTransport } from '../auth.js'
import type { Transport } from '../auth.js'
import { stubModel } from './stub-model.js'

interface AdapterCase {
  provider: ModelProviderId
  modelId: string
  transport: Transport
  expectedProvider: string
}

function fakeFetchCounter(): { fetch: typeof globalThis.fetch; calls: () => number } {
  let callCount = 0
  return {
    fetch: async () => {
      callCount += 1
      return new Response('{}')
    },
    calls: () => callCount,
  }
}

describe('ADAPTERS', () => {
  it('constructs a v3 model for each built-in provider without making a request', () => {
    const { fetch, calls } = fakeFetchCounter()
    const cases: AdapterCase[] = [
      {
        provider: 'openai-compatible',
        modelId: 'local-chat-model',
        expectedProvider: 'openai.chat',
        transport: {
          baseURL: 'http://localhost:11434/v1',
          apiKey: 'openai-compatible',
          fetch,
        },
      },
      {
        provider: 'openai-subscription',
        modelId: 'gpt-5.1',
        expectedProvider: 'openai.responses',
        transport: {
          apiKey: 'placeholder',
          fetch,
        },
      },
      {
        provider: 'anthropic-compatible',
        modelId: 'claude-local',
        expectedProvider: 'anthropic.messages',
        transport: {
          baseURL: 'http://localhost:8080',
          apiKey: 'anthropic-compatible',
          headers: { 'x-routing-key': 'local' },
          fetch,
        },
      },
      {
        provider: 'anthropic-subscription',
        modelId: 'claude-sonnet-4-5',
        expectedProvider: 'anthropic.messages',
        transport: {
          apiKey: 'placeholder',
          fetch,
        },
      },
      {
        provider: 'gemini',
        modelId: 'gemini-2.5-flash',
        expectedProvider: 'google.generative-ai',
        transport: {
          apiKey: 'placeholder',
          fetch,
        },
      },
    ]

    for (const testCase of cases) {
      const model = ADAPTERS[testCase.provider](testCase.transport, testCase.modelId)

      expect(model.specificationVersion).toBe('v3')
      expect(model.provider).toBe(testCase.expectedProvider)
      expect(model.modelId).toBe(testCase.modelId)
    }
    expect(calls()).toBe(0)
  })

  it('returns OpenAI Responses provider options only for the subscription path', () => {
    const { fetch } = fakeFetchCounter()

    expect(getProviderOptions({ provider: 'openai-subscription', fetch })).toEqual({
      openai: {
        instructions: 'You are a helpful assistant.',
        store: false,
        systemMessageMode: 'system',
      },
    })
    expect(getProviderOptions({ modelAdapter: 'openai-responses', fetch })).toEqual({
      openai: {
        instructions: 'You are a helpful assistant.',
        store: false,
        systemMessageMode: 'system',
      },
    })
    expect(getProviderOptions({ provider: 'openai-compatible', fetch })).toBeUndefined()
  })
})

describe('providerOptions threading', () => {
  it('carries profile providerOptions into the derived Transport', () => {
    const profile: ModelProfile = {
      provider: 'anthropic-compatible',
      model: 'claude-local',
      baseURL: 'http://localhost:8080',
      providerOptions: { anthropic: { thinking: { type: 'enabled' } } },
      auth: { mode: 'none' },
    }

    const transport = deriveTransport(profile, { kind: 'none' })

    expect(transport.providerOptions).toEqual({ anthropic: { thinking: { type: 'enabled' } } })
  })

  it('returns the same model instance when transport has no providerOptions', () => {
    const model = stubModel()

    expect(applyProviderOptions(model, {})).toBe(model)
  })

  it('delivers profile providerOptions to the provider generate call', async () => {
    let captured: unknown
    const model = stubModel({
      async doGenerate(options) {
        captured = options.providerOptions
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          warnings: [],
        }
      },
    })

    const bag = { anthropic: { thinking: { type: 'enabled' } } }
    const wrapped = applyProviderOptions(model, { providerOptions: bag })

    await generateText({ model: wrapped, prompt: 'hello' })

    expect(captured).toMatchObject(bag)
  })
})
