import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { ModelProviderId } from '@vostride/agent-qa-schema'

import { anthropicCompatible, anthropicSubscription } from './anthropic.js'
import { gemini } from './gemini.js'
import { getProviderOptions, openaiCompatible, openaiSubscription } from './openai.js'
import type { Transport } from '../auth.js'

export type AdapterBody = (transport: Transport, modelId: string) => LanguageModelV4

export const ADAPTERS: Record<ModelProviderId, AdapterBody> = {
  'openai-compatible': openaiCompatible,
  'anthropic-compatible': anthropicCompatible,
  'openai-subscription': openaiSubscription,
  'anthropic-subscription': anthropicSubscription,
  gemini,
}

export { getProviderOptions }
