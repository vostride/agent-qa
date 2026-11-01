import { createOpenAI } from '@ai-sdk/openai'

import type { LanguageModelV3 } from '@ai-sdk/provider'

import { applyProviderOptions } from '../auth.js'
import type { Transport } from '../auth.js'

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue | undefined }

export type ProviderOptions = Record<string, Record<string, JSONValue | undefined>> | undefined

export interface ProviderOptionsConfig {
  provider?: string
  modelAdapter?: 'openai-responses' | 'anthropic-messages'
  fetch?: typeof globalThis.fetch
}

export function openaiCompatible(transport: Transport, modelId: string): LanguageModelV3 {
  return applyProviderOptions(
    createOpenAI({
      apiKey: transport.apiKey ?? 'openai-compatible',
      baseURL: transport.baseURL,
      fetch: transport.fetch,
      ...(transport.headers ? { headers: transport.headers } : {}),
    }).chat(modelId),
    transport,
  )
}

export function openaiSubscription(transport: Transport, modelId: string): LanguageModelV3 {
  return applyProviderOptions(
    createOpenAI({
      apiKey: transport.apiKey ?? 'placeholder',
      fetch: transport.fetch,
    }).responses(modelId),
    transport,
  )
}

export function getProviderOptions(config: ProviderOptionsConfig): ProviderOptions {
  if (
    config.fetch
    && (config.modelAdapter === 'openai-responses'
      || (!config.modelAdapter && config.provider === 'openai-subscription'))
  ) {
    return {
      openai: {
        instructions: 'You are a helpful assistant.',
        store: false,
        systemMessageMode: 'system',
      },
    }
  }
  return undefined
}
