import { describe, expect, it } from 'vitest'

import type { ProviderV4 } from '@ai-sdk/provider'

import { createModel } from '../registry.js'

describe('gateway decline', () => {
  it('returns the built-in provider model even when the AI SDK default provider throws', () => {
    const globalWithDefaultProvider = globalThis as typeof globalThis & {
      AI_SDK_DEFAULT_PROVIDER?: ProviderV4
    }
    const original = globalWithDefaultProvider.AI_SDK_DEFAULT_PROVIDER
    const throwingProvider: ProviderV4 = {
      specificationVersion: 'v4',
      languageModel(modelId) {
        throw new Error(`gateway should not resolve language model ${modelId}`)
      },
      embeddingModel(modelId) {
        throw new Error(`gateway should not resolve embedding model ${modelId}`)
      },
      imageModel(modelId) {
        throw new Error(`gateway should not resolve image model ${modelId}`)
      },
    }

    try {
      globalWithDefaultProvider.AI_SDK_DEFAULT_PROVIDER = throwingProvider

      const model = createModel(
        {
          provider: 'openai-compatible',
          model: 'local-chat-model',
          baseURL: 'http://localhost:11434/v1',
          auth: { mode: 'none' },
        },
        { kind: 'none' },
        (text) => text,
      )

      expect(model.specificationVersion).toBe('v4')
      expect(model.provider).toBe('openai.chat')
      expect(model.provider).not.toBe('gateway')
      expect(model.modelId).toBe('local-chat-model')
    } finally {
      globalWithDefaultProvider.AI_SDK_DEFAULT_PROVIDER = original
    }
  })
})
