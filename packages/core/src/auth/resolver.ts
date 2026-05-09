import { getLLMAuthProviderPlugin, type LLMAuthProviderPlugin } from './plugin-registry.js'
import { getCredential, writeAuth } from './store.js'
import type { AuthCredential, LLMProviderMode, OAuthTokens, ResolvedLLMAuth } from './types.js'

interface LLMAuthConfig {
  provider: LLMProviderMode | string
  model: string
  baseURL?: string
  providerHeaders?: Record<string, string>
}

function missingMessage(provider: string, plugin?: LLMAuthProviderPlugin): string {
  if (plugin) {
    return `Authenticate "${plugin.label}" for this config before testing.`
  }

  switch (provider) {
    case 'gemini':
      return 'Save a Gemini API key for this config before testing.'
    case 'openai-compatible':
      return 'Save an API key for this config before testing.'
    case 'anthropic-compatible':
      return 'Save an API key or bearer token for this config before testing.'
    default:
      return `Provider "${provider}" requires an auth plugin.`
  }
}

function unauthenticated(configName: string, provider: 'openai-compatible' | 'anthropic-compatible'): ResolvedLLMAuth {
  return {
    kind: 'unauthenticated',
    credentialKey: configName,
    provider,
    optional: true,
    message: 'Testing without a saved credential.',
  }
}

function isCompatibleProvider(provider: string): provider is 'openai-compatible' | 'anthropic-compatible' {
  return provider === 'openai-compatible' || provider === 'anthropic-compatible'
}

function usesApiKey(
  provider: string,
  plugin?: LLMAuthProviderPlugin,
): provider is 'openai-compatible' | 'anthropic-compatible' | 'gemini' {
  return !plugin && (provider === 'openai-compatible' || provider === 'anthropic-compatible' || provider === 'gemini')
}

function unusableCredential(
  configName: string,
  provider: string,
  plugin?: LLMAuthProviderPlugin,
): ResolvedLLMAuth {
  return isCompatibleProvider(provider)
    ? unauthenticated(configName, provider)
    : missing(configName, provider, plugin)
}

function missing(configName: string, provider: string, plugin?: LLMAuthProviderPlugin): ResolvedLLMAuth {
  return {
    kind: 'missing',
    credentialKey: configName,
    provider,
    required: true,
    message: missingMessage(provider, plugin),
  }
}

function getOAuthTokens(
  configName: string,
  expectedProvider: string,
  authPath?: string,
): () => Promise<OAuthTokens> {
  return async () => {
    const credential = await getCredential(configName, authPath)
    if (credential?.type !== 'oauth' || credential.provider !== expectedProvider) {
      throw new Error(`Expected ${expectedProvider} OAuth credential for ${configName}`)
    }
    return credential.tokens
  }
}

function writeRefreshedOAuth(
  configName: string,
  expectedProvider: string,
  authPath?: string,
): (tokens: OAuthTokens) => Promise<void> {
  return async (tokens) => {
    const current = await getCredential(configName, authPath)
    if (current?.type !== 'oauth' || current.provider !== expectedProvider) {
      throw new Error(`Expected ${expectedProvider} OAuth credential for ${configName}`)
    }
    await writeAuth(configName, { ...current, tokens }, authPath)
  }
}

function authFetch(
  configName: string,
  plugin: LLMAuthProviderPlugin,
  credential: Extract<AuthCredential, { type: 'oauth' }>,
  authPath?: string,
): ResolvedLLMAuth {
  const expectedProvider = plugin.credentialProviderId
  const getTokens = getOAuthTokens(configName, expectedProvider, authPath)
  const onRefreshed = writeRefreshedOAuth(configName, expectedProvider, authPath)

  return {
    kind: 'auth-fetch',
    credentialKey: configName,
    provider: plugin.providerId,
    modelAdapter: plugin.modelAdapter,
    fetch: plugin.createAuthFetch({ getTokens, onRefreshed }),
    expires: credential.tokens.expires,
  }
}

export async function resolveLLMAuth(
  configName: string,
  llmConfig: LLMAuthConfig,
  authPath?: string,
): Promise<ResolvedLLMAuth> {
  const credential = await getCredential(configName, authPath)
  const plugin = getLLMAuthProviderPlugin(llmConfig.provider)

  if (!credential) {
    if (isCompatibleProvider(llmConfig.provider)) {
      return unauthenticated(configName, llmConfig.provider)
    }
    return missing(configName, llmConfig.provider, plugin)
  }

  if (credential.type === 'api') {
    if (credential.provider !== llmConfig.provider) {
      return unusableCredential(configName, llmConfig.provider, plugin)
    }
    if (!usesApiKey(llmConfig.provider, plugin)) {
      return missing(configName, llmConfig.provider, plugin)
    }
    return {
      kind: 'api-key',
      credentialKey: configName,
      provider: llmConfig.provider,
      apiKey: credential.key,
    }
  }

  if (credential.type === 'bearer') {
    if (credential.provider !== llmConfig.provider || llmConfig.provider !== 'anthropic-compatible') {
      return unusableCredential(configName, llmConfig.provider, plugin)
    }
    return {
      kind: 'bearer-token',
      credentialKey: configName,
      provider: 'anthropic-compatible',
      token: credential.token,
    }
  }

  if (credential.type === 'oauth') {
    if (plugin) {
      if (credential.provider !== plugin.credentialProviderId) {
        return missing(configName, llmConfig.provider, plugin)
      }
      return authFetch(configName, plugin, credential, authPath)
    }
    return unusableCredential(configName, llmConfig.provider)
  }

  return missing(configName, llmConfig.provider, plugin)
}
