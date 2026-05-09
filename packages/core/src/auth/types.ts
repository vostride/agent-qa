export type AuthProvider = string

export type LLMModelAdapter = 'openai-responses' | 'anthropic-messages'

export type BuiltInLLMProviderMode =
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'openai-subscription'
  | 'anthropic-subscription'
  | 'gemini'

export type LLMProviderMode = BuiltInLLMProviderMode | (string & {})

export interface OAuthTokens {
  access: string
  refresh: string
  expires: number
  accountId?: string
}

export type AuthCredential =
  | { type: 'oauth'; provider: AuthProvider; tokens: OAuthTokens }
  | { type: 'api'; provider: string; key: string }
  | { type: 'bearer'; provider: string; token: string }

export type AuthStore = Record<string, AuthCredential>

export type ResolvedLLMAuth =
  | { kind: 'api-key'; credentialKey: string; provider: BuiltInLLMProviderMode; apiKey: string }
  | { kind: 'bearer-token'; credentialKey: string; provider: 'anthropic-compatible'; token: string }
  | {
    kind: 'auth-fetch'
    credentialKey: string
    provider: string
    modelAdapter: LLMModelAdapter
    fetch: typeof globalThis.fetch
    expires?: number
  }
  | {
    kind: 'unauthenticated'
    credentialKey: string
    provider: 'openai-compatible' | 'anthropic-compatible'
    optional: true
    message: string
  }
  | {
    kind: 'missing'
    credentialKey: string
    provider: string
    required: true
    message: string
  }

export type TokenRefreshFn = (
  provider: AuthProvider,
  refreshToken: string,
) => Promise<OAuthTokens>
