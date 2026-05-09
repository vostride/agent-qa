import type { LLMModelAdapter, OAuthTokens } from './types.js'

export type DashboardAuthMode = 'browser-poll' | 'manual-code'

export interface DashboardAuthMetadata {
  mode: DashboardAuthMode
  buttonLabel?: string
}

export interface StartAuthContext {
  configName: string
  callbackUrl?: string
}

export interface StartAuthResult {
  authorizeUrl: string
  sessionState?: unknown
  waitForTokens?: Promise<OAuthTokens>
  cleanup?: () => void
}

export interface ExchangeCodeContext {
  code: string
  sessionState: unknown
}

export interface CreateAuthFetchContext {
  getTokens: () => Promise<OAuthTokens>
  onRefreshed: (tokens: OAuthTokens) => Promise<void>
}

export interface LLMAuthProviderPlugin {
  providerId: string
  credentialProviderId: string
  label: string
  modelAdapter: LLMModelAdapter
  dashboardAuth: DashboardAuthMetadata
  startAuth?: (ctx: StartAuthContext) => Promise<StartAuthResult>
  exchangeCode?: (ctx: ExchangeCodeContext) => Promise<OAuthTokens>
  createAuthFetch: (ctx: CreateAuthFetchContext) => typeof globalThis.fetch
}

const plugins = new Map<string, LLMAuthProviderPlugin>()

function validatePlugin(plugin: LLMAuthProviderPlugin): void {
  if (!plugin.providerId.trim()) {
    throw new Error('LLM auth plugin providerId is required')
  }
  if (!plugin.credentialProviderId.trim()) {
    throw new Error(`LLM auth plugin "${plugin.providerId}" credentialProviderId is required`)
  }
  if (!plugin.label.trim()) {
    throw new Error(`LLM auth plugin "${plugin.providerId}" label is required`)
  }
}

export function registerLLMAuthProviderPlugin(plugin: LLMAuthProviderPlugin): void {
  validatePlugin(plugin)
  if (plugins.has(plugin.providerId)) {
    throw new Error(`LLM auth provider plugin "${plugin.providerId}" is already registered`)
  }
  plugins.set(plugin.providerId, plugin)
}

export function registerLLMAuthProviderPlugins(providerPlugins: LLMAuthProviderPlugin[]): void {
  for (const plugin of providerPlugins) {
    registerLLMAuthProviderPlugin(plugin)
  }
}

export function getLLMAuthProviderPlugin(providerId: string): LLMAuthProviderPlugin | undefined {
  return plugins.get(providerId)
}

export function listLLMAuthProviderPlugins(): LLMAuthProviderPlugin[] {
  return [...plugins.values()]
}

export function clearLLMAuthProviderPlugins(): void {
  plugins.clear()
}
