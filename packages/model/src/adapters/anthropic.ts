import { createAnthropic } from '@ai-sdk/anthropic'

import type { LanguageModelV4 } from '@ai-sdk/provider'

import { applyProviderOptions } from '../auth.js'
import type { Transport } from '../auth.js'

export function anthropicCompatible(transport: Transport, modelId: string): LanguageModelV4 {
  return applyProviderOptions(
    createAnthropic({
      baseURL: transport.baseURL,
      headers: transport.headers,
      fetch: transport.fetch,
      ...(transport.authToken
        ? { authToken: transport.authToken }
        : { apiKey: transport.apiKey ?? 'anthropic-compatible' }),
    })(modelId),
    transport,
  )
}

export function anthropicSubscription(transport: Transport, modelId: string): LanguageModelV4 {
  return applyProviderOptions(
    createAnthropic({
      apiKey: transport.apiKey ?? 'placeholder',
      fetch: transport.fetch,
    })(modelId),
    transport,
  )
}
