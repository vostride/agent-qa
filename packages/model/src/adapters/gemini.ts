import { createGoogle } from '@ai-sdk/google'

import type { LanguageModelV4 } from '@ai-sdk/provider'

import { applyProviderOptions } from '../auth.js'
import type { Transport } from '../auth.js'

export function gemini(transport: Transport, modelId: string): LanguageModelV4 {
  return applyProviderOptions(
    createGoogle({
      apiKey: transport.apiKey,
      fetch: transport.fetch,
    })(modelId),
    transport,
  )
}
