import type { LanguageModel } from 'ai'

const SUPPORTED_PROVIDERS = [
  'openai-compatible',
  'anthropic-compatible',
  'openai-subscription',
  'anthropic-subscription',
  'gemini',
] as const

type BuiltInProviderMode = typeof SUPPORTED_PROVIDERS[number]
type ProviderMode = BuiltInProviderMode | (string & {})
type LLMModelAdapter = 'openai-responses' | 'anthropic-messages'

export interface ModelConfig {
  provider: ProviderMode
  model: string
  modelAdapter?: LLMModelAdapter
  apiKey?: string
  authToken?: string
  baseURL?: string
  providerHeaders?: Record<string, string>
  fetch?: typeof globalThis.fetch
}

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue | undefined }
export type ProviderOptions = Record<string, Record<string, JSONValue | undefined>> | undefined

// Returns provider-specific options needed for generateText/streamText calls.
// OpenAI subscription mode uses the Responses API and requires provider options.
export function getProviderOptions(config: ModelConfig): ProviderOptions {
  if (
    config.fetch
    && (config.modelAdapter === 'openai-responses'
      || (!config.modelAdapter && config.provider === 'openai-subscription'))
  ) {
    return {
      openai: {
        instructions: 'You are a helpful assistant.',
        store: false,
      },
    }
  }
  return undefined
}


export async function createModel(config: ModelConfig): Promise<LanguageModel> {
  if (config.modelAdapter === 'openai-responses') {
    return createOpenAIResponsesModel(config)
  }
  if (config.modelAdapter === 'anthropic-messages') {
    return createAnthropicMessagesModel(config)
  }

  switch (config.provider) {
    case 'openai-compatible':
      return createOpenAICompatibleModel(config)
    case 'anthropic-compatible':
      return createAnthropicCompatibleModel(config)
    case 'openai-subscription':
      return createOpenAIResponsesModel(config)
    case 'anthropic-subscription':
      return createAnthropicMessagesModel(config)
    case 'gemini':
      return createGeminiModel(config)
    default:
      throw new Error(
        `Unknown provider "${config.provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')} or plugin providers with modelAdapter.`,
      )
  }
}

async function createAnthropicMessagesModel(config: ModelConfig): Promise<LanguageModel> {
  try {
    const { createAnthropic } = await import('@ai-sdk/anthropic')
    const provider = createAnthropic({
      apiKey: config.apiKey || (config.fetch ? 'placeholder' : undefined),
      fetch: config.fetch,
    })
    return provider(config.model) as LanguageModel
  } catch {
    throw new Error(
      'Failed to load @ai-sdk/anthropic. Install it with: pnpm add @ai-sdk/anthropic',
    )
  }
}

async function createOpenAIResponsesModel(config: ModelConfig): Promise<LanguageModel> {
  try {
    const { createOpenAI } = await import('@ai-sdk/openai')
    const provider = createOpenAI({
      apiKey: config.apiKey || (config.fetch ? 'placeholder' : undefined),
      fetch: config.fetch,
    })
    return provider.responses(config.model) as LanguageModel
  } catch {
    throw new Error(
      'Failed to load @ai-sdk/openai. Install it with: pnpm add @ai-sdk/openai',
    )
  }
}

async function createGeminiModel(config: ModelConfig): Promise<LanguageModel> {
  try {
    const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
    const provider = (createGoogleGenerativeAI as Function)({
      apiKey: config.apiKey,
      fetch: config.fetch,
    })
    return provider(config.model) as LanguageModel
  } catch {
    throw new Error(
      'Failed to load @ai-sdk/google. Install it with: pnpm add @ai-sdk/google',
    )
  }
}

async function createAnthropicCompatibleModel(config: ModelConfig): Promise<LanguageModel> {
  if (!config.baseURL) {
    throw new Error('Anthropic-Compatible provider requires a baseURL')
  }
  try {
    const { createAnthropic } = await import('@ai-sdk/anthropic')
    const provider = createAnthropic({
      baseURL: config.baseURL,
      headers: config.providerHeaders,
      fetch: config.fetch,
      ...(config.authToken
        ? { authToken: config.authToken }
        : { apiKey: config.apiKey || 'anthropic-compatible' }),
    })
    return provider(config.model) as LanguageModel
  } catch {
    throw new Error(
      'Failed to load @ai-sdk/anthropic (used for Anthropic-compatible providers). Install it with: pnpm add @ai-sdk/anthropic',
    )
  }
}

async function createOpenAICompatibleModel(config: ModelConfig): Promise<LanguageModel> {
  if (!config.baseURL) {
    throw new Error('OpenAI-Compatible provider requires a baseURL')
  }
  try {
    const { createOpenAI } = await import('@ai-sdk/openai')
    const provider = createOpenAI({
      apiKey: config.apiKey || 'openai-compatible',
      baseURL: config.baseURL,
      fetch: config.fetch,
      ...(config.providerHeaders ? { headers: config.providerHeaders } : {}),
    })
    return provider.chat(config.model) as LanguageModel
  } catch {
    throw new Error(
      'Failed to load @ai-sdk/openai (used for OpenAI-compatible providers). Install it with: pnpm add @ai-sdk/openai',
    )
  }
}
