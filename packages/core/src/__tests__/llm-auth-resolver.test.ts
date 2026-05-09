import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readAuth, writeAuth } from '../auth/store.js'
import { resolveLLMAuth } from '../auth/resolver.js'
import type { AuthCredential, OAuthTokens } from '../auth/types.js'
import { clearLLMAuthProviderPlugins, registerLLMAuthProviderPlugin } from '../auth/plugin-registry.js'

const OPENAI_REFRESH_URL = 'https://plugin.example/openai/refresh'
const OPENAI_API_URL = 'https://plugin.example/openai/responses'
const ANTHROPIC_REFRESH_URL = 'https://plugin.example/anthropic/refresh'
const ANTHROPIC_API_URL = 'https://plugin.example/anthropic/messages'

function createTestAuthFetch(
  getTokens: () => Promise<OAuthTokens>,
  onRefreshed: (tokens: OAuthTokens) => Promise<void>,
  options: { refreshUrl: string; apiUrl: string },
): typeof globalThis.fetch {
  return async (_input, init) => {
    const tokens = await getTokens()
    if (tokens.expires < Date.now()) {
      await globalThis.fetch(options.refreshUrl, { method: 'POST' })
      await onRefreshed({
        access: `refreshed-${tokens.access}`,
        refresh: `refreshed-${tokens.refresh}`,
        expires: Date.now() + 3600000,
      })
    }
    return globalThis.fetch(options.apiUrl, init)
  }
}

describe('resolveLLMAuth', () => {
  let tempDir: string
  let authPath: string
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-llm-auth-test-'))
    authPath = join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    clearLLMAuthProviderPlugins()
    await rm(tempDir, { recursive: true, force: true })
  })

  function registerSubscriptionPlugins(): void {
    registerLLMAuthProviderPlugin({
      providerId: 'openai-subscription',
      credentialProviderId: 'openai-subscription-oauth',
      label: 'OpenAI subscription',
      modelAdapter: 'openai-responses',
      dashboardAuth: { mode: 'browser-poll' },
      createAuthFetch: ({ getTokens, onRefreshed }) => createTestAuthFetch(getTokens, onRefreshed, {
        refreshUrl: OPENAI_REFRESH_URL,
        apiUrl: OPENAI_API_URL,
      }),
    })
    registerLLMAuthProviderPlugin({
      providerId: 'anthropic-subscription',
      credentialProviderId: 'anthropic-subscription',
      label: 'Anthropic subscription',
      modelAdapter: 'anthropic-messages',
      dashboardAuth: { mode: 'manual-code' },
      createAuthFetch: ({ getTokens, onRefreshed }) => createTestAuthFetch(getTokens, onRefreshed, {
        refreshUrl: ANTHROPIC_REFRESH_URL,
        apiUrl: ANTHROPIC_API_URL,
      }),
    })
  }

  async function writeDecoyCredentials(): Promise<void> {
    const decoy: AuthCredential = { type: 'api', provider: 'decoy', key: 'sk-decoy' }
    await writeAuth('openai-compatible', decoy, authPath)
    await writeAuth('anthropic-compatible', decoy, authPath)
    await writeAuth('gemini', decoy, authPath)
    await writeAuth('google', decoy, authPath)
    await writeAuth('ANTHROPIC_API_KEY', decoy, authPath)
    await writeAuth('OPENAI_API_KEY', decoy, authPath)
    await writeAuth('remote.example', decoy, authPath)
  }

  it('resolves api-key credentials from the named config only', async () => {
    await writeDecoyCredentials()
    await writeAuth('planner', { type: 'api', provider: 'openai-compatible', key: 'sk-planner' }, authPath)

    const result = await resolveLLMAuth('planner', {
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      baseURL: 'https://remote.example/api/v1',
    }, authPath)

    expect(result).toEqual({
      kind: 'api-key',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      apiKey: 'sk-planner',
    })
  })

  it('does not reuse api-key credentials saved for a different provider', async () => {
    registerSubscriptionPlugins()
    await writeAuth('planner', { type: 'api', provider: 'gemini', key: 'gemini-key' }, authPath)

    const compatibleResult = await resolveLLMAuth('planner', {
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      baseURL: 'https://remote.example/api/v1',
    }, authPath)
    const subscriptionResult = await resolveLLMAuth('planner', {
      provider: 'openai-subscription',
      model: 'gpt-5',
    }, authPath)

    expect(compatibleResult).toEqual({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })
    expect(subscriptionResult).toEqual({
      kind: 'missing',
      credentialKey: 'planner',
      provider: 'openai-subscription',
      required: true,
      message: 'Authenticate "OpenAI subscription" for this config before testing.',
    })
  })

  it('resolves bearer-token credentials only for anthropic-compatible configs', async () => {
    await writeAuth('planner', {
      type: 'bearer',
      provider: 'anthropic-compatible',
      token: 'bearer-planner',
    }, authPath)

    const anthropicResult = await resolveLLMAuth('planner', {
      provider: 'anthropic-compatible',
      model: 'claude-compatible',
      baseURL: 'https://remote.example/messages',
    }, authPath)
    const openAIResult = await resolveLLMAuth('planner', {
      provider: 'openai-compatible',
      model: 'chat-compatible',
      baseURL: 'https://remote.example/v1',
    }, authPath)

    expect(anthropicResult).toEqual({
      kind: 'bearer-token',
      credentialKey: 'planner',
      provider: 'anthropic-compatible',
      token: 'bearer-planner',
    })
    expect(openAIResult).toEqual({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })
  })

  it('does not reuse bearer credentials saved for a different provider', async () => {
    await writeAuth('planner', {
      type: 'bearer',
      provider: 'openai-compatible',
      token: 'bearer-planner',
    }, authPath)

    const result = await resolveLLMAuth('planner', {
      provider: 'anthropic-compatible',
      model: 'claude-compatible',
      baseURL: 'https://remote.example/messages',
    }, authPath)

    expect(result).toEqual({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'anthropic-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })
  })

  it('allows unauthenticated compatible configs without provider fallback', async () => {
    await writeDecoyCredentials()

    const result = await resolveLLMAuth('planner', {
      provider: 'anthropic-compatible',
      model: 'local-claude',
      baseURL: 'http://127.0.0.1:11434',
    }, authPath)

    expect(result).toEqual({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'anthropic-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })
  })

  it('returns missing for gemini without a named config credential', async () => {
    await writeDecoyCredentials()

    const result = await resolveLLMAuth('planner', {
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    }, authPath)

    expect(result).toEqual({
      kind: 'missing',
      credentialKey: 'planner',
      provider: 'gemini',
      required: true,
      message: 'Save a Gemini API key for this config before testing.',
    })
  })

  it('returns missing for subscription configs without named OAuth credentials', async () => {
    registerSubscriptionPlugins()
    const oauthDecoy: AuthCredential = {
      type: 'oauth',
      provider: 'openai-subscription-oauth',
      tokens: { access: 'acc', refresh: 'ref', expires: Date.now() + 3600000 },
    }
    await writeAuth('openai-subscription', oauthDecoy, authPath)
    await writeAuth('anthropic-subscription', {
      ...oauthDecoy,
      provider: 'anthropic-subscription',
    }, authPath)

    const openAIResult = await resolveLLMAuth('planner', {
      provider: 'openai-subscription',
      model: 'gpt-5',
    }, authPath)
    const anthropicResult = await resolveLLMAuth('planner', {
      provider: 'anthropic-subscription',
      model: 'claude-sonnet',
    }, authPath)

    expect(openAIResult).toEqual({
      kind: 'missing',
      credentialKey: 'planner',
      provider: 'openai-subscription',
      required: true,
      message: 'Authenticate "OpenAI subscription" for this config before testing.',
    })
    expect(anthropicResult).toEqual({
      kind: 'missing',
      credentialKey: 'planner',
      provider: 'anthropic-subscription',
      required: true,
      message: 'Authenticate "Anthropic subscription" for this config before testing.',
    })
  })

  it('does not reuse OAuth credentials across subscription providers', async () => {
    registerSubscriptionPlugins()
    await writeAuth('planner', {
      type: 'oauth',
      provider: 'openai-subscription-oauth',
      tokens: { access: 'openai-access', refresh: 'openai-refresh', expires: Date.now() + 3600000 },
    }, authPath)

    const anthropicResult = await resolveLLMAuth('planner', {
      provider: 'anthropic-subscription',
      model: 'claude-sonnet',
    }, authPath)

    await writeAuth('planner', {
      type: 'oauth',
      provider: 'anthropic-subscription',
      tokens: { access: 'anthropic-access', refresh: 'anthropic-refresh', expires: Date.now() + 3600000 },
    }, authPath)

    const openAIResult = await resolveLLMAuth('planner', {
      provider: 'openai-subscription',
      model: 'gpt-5',
    }, authPath)

    expect(anthropicResult).toEqual({
      kind: 'missing',
      credentialKey: 'planner',
      provider: 'anthropic-subscription',
      required: true,
      message: 'Authenticate "Anthropic subscription" for this config before testing.',
    })
    expect(openAIResult).toEqual({
      kind: 'missing',
      credentialKey: 'planner',
      provider: 'openai-subscription',
      required: true,
      message: 'Authenticate "OpenAI subscription" for this config before testing.',
    })
  })

  it('rejects stale auth fetch token reads after the config credential changes provider', async () => {
    registerSubscriptionPlugins()
    await writeAuth('planner', {
      type: 'oauth',
      provider: 'openai-subscription-oauth',
      tokens: { access: 'openai-access', refresh: 'openai-refresh', expires: Date.now() + 3600000 },
    }, authPath)

    const result = await resolveLLMAuth('planner', {
      provider: 'openai-subscription',
      model: 'gpt-5',
    }, authPath)

    if (result.kind !== 'auth-fetch') throw new Error('Expected auth-fetch result')

    await writeAuth('planner', {
      type: 'oauth',
      provider: 'anthropic-subscription',
      tokens: { access: 'anthropic-access', refresh: 'anthropic-refresh', expires: Date.now() + 3600000 },
    }, authPath)

    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))

    await expect(result.fetch('https://api.openai.com/v1/responses')).rejects.toThrow(
      'Expected openai-subscription-oauth OAuth credential for planner',
    )
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects stale auth fetch refresh writes after the config credential changes provider', async () => {
    registerSubscriptionPlugins()
    await writeAuth('planner', {
      type: 'oauth',
      provider: 'openai-subscription-oauth',
      tokens: { access: 'expired-openai-access', refresh: 'openai-refresh', expires: 1 },
    }, authPath)

    const result = await resolveLLMAuth('planner', {
      provider: 'openai-subscription',
      model: 'gpt-5',
    }, authPath)

    if (result.kind !== 'auth-fetch') throw new Error('Expected auth-fetch result')

    let refreshRequestStarted: (() => void) | undefined
    const refreshStarted = new Promise<void>((resolve) => {
      refreshRequestStarted = resolve
    })

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === OPENAI_REFRESH_URL) {
        refreshRequestStarted?.()
        await writeAuth('planner', {
          type: 'oauth',
          provider: 'anthropic-subscription',
          tokens: { access: 'anthropic-access', refresh: 'anthropic-refresh', expires: Date.now() + 3600000 },
        }, authPath)
        return new Response(JSON.stringify({
          access_token: 'refreshed-openai-access',
          refresh_token: 'refreshed-openai-refresh',
          expires_in: 3600,
        }), { status: 200 })
      }
      return new Response('ok', { status: 200 })
    })

    await expect(result.fetch('https://api.openai.com/v1/responses')).rejects.toThrow(
      'Expected openai-subscription-oauth OAuth credential for planner',
    )
    await refreshStarted

    const store = await readAuth(authPath)
    expect(store.planner).toMatchObject({
      type: 'oauth',
      provider: 'anthropic-subscription',
      tokens: { access: 'anthropic-access' },
    })
  })

  it('resolves openai subscription OAuth credentials through an auth fetch and refreshes the same config key', async () => {
    registerSubscriptionPlugins()
    await writeAuth('openai-subscription-oauth', {
      type: 'oauth',
      provider: 'openai-subscription-oauth',
      tokens: { access: 'decoy-access', refresh: 'decoy-refresh', expires: 1 },
    }, authPath)
    await writeAuth('planner', {
      type: 'oauth',
      provider: 'openai-subscription-oauth',
      tokens: { access: 'expired-access', refresh: 'expired-refresh', expires: 1 },
    }, authPath)

    const result = await resolveLLMAuth('planner', {
      provider: 'openai-subscription',
      model: 'gpt-5',
    }, authPath)

    expect(result).toMatchObject({
      kind: 'auth-fetch',
      credentialKey: 'planner',
      provider: 'openai-subscription',
      expires: 1,
    })
    if (result.kind !== 'auth-fetch') throw new Error('Expected auth-fetch result')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'refreshed-openai-access',
        refresh_token: 'refreshed-openai-refresh',
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    await result.fetch('https://api.openai.com/v1/responses')

    const store = await readAuth(authPath)
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      OPENAI_REFRESH_URL,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      OPENAI_API_URL,
      undefined,
    )
    expect(store.planner).toMatchObject({
      type: 'oauth',
      provider: 'openai-subscription-oauth',
      tokens: {
        access: 'refreshed-expired-access',
        refresh: 'refreshed-expired-refresh',
      },
    })
    expect(store['openai-subscription-oauth']).toMatchObject({
      type: 'oauth',
      tokens: { access: 'decoy-access' },
    })
  })

  it('resolves anthropic subscription OAuth credentials through an auth fetch and refreshes the same config key', async () => {
    registerSubscriptionPlugins()
    await writeAuth('anthropic-subscription', {
      type: 'oauth',
      provider: 'anthropic-subscription',
      tokens: { access: 'decoy-access', refresh: 'decoy-refresh', expires: 1 },
    }, authPath)
    await writeAuth('planner', {
      type: 'oauth',
      provider: 'anthropic-subscription',
      tokens: { access: 'expired-access', refresh: 'expired-refresh', expires: 1 },
    }, authPath)

    const result = await resolveLLMAuth('planner', {
      provider: 'anthropic-subscription',
      model: 'claude-sonnet',
    }, authPath)

    expect(result).toMatchObject({
      kind: 'auth-fetch',
      credentialKey: 'planner',
      provider: 'anthropic-subscription',
      expires: 1,
    })
    if (result.kind !== 'auth-fetch') throw new Error('Expected auth-fetch result')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'refreshed-anthropic-access',
        refresh_token: 'refreshed-anthropic-refresh',
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    await result.fetch('https://api.anthropic.com/v1/messages')

    const store = await readAuth(authPath)
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      ANTHROPIC_REFRESH_URL,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      ANTHROPIC_API_URL,
      undefined,
    )
    expect(store.planner).toMatchObject({
      type: 'oauth',
      provider: 'anthropic-subscription',
      tokens: {
        access: 'refreshed-expired-access',
        refresh: 'refreshed-expired-refresh',
      },
    })
    expect(store['anthropic-subscription']).toMatchObject({
      type: 'oauth',
      tokens: { access: 'decoy-access' },
    })
  })

  it('does not read provider, env, or host fallback credential keys', async () => {
    await writeDecoyCredentials()

    const result = await resolveLLMAuth('planner', {
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      baseURL: 'https://remote.example/api/v1',
    }, authPath)

    expect(result).toEqual({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })
  })
})
