import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
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
      message: 'Sign in to "OpenAI subscription" for the "planner" config: agent-qa auth login --config planner',
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
      message: 'Save a Gemini API key for the "planner" config: agent-qa auth set --config planner --type api-key',
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
      message: 'Sign in to "OpenAI subscription" for the "planner" config: agent-qa auth login --config planner',
    })
    expect(anthropicResult).toEqual({
      kind: 'missing',
      credentialKey: 'planner',
      provider: 'anthropic-subscription',
      required: true,
      message: 'Sign in to "Anthropic subscription" for the "planner" config: agent-qa auth login --config planner',
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
      message: 'Sign in to "Anthropic subscription" for the "planner" config: agent-qa auth login --config planner',
    })
    expect(openAIResult).toEqual({
      kind: 'missing',
      credentialKey: 'planner',
      provider: 'openai-subscription',
      required: true,
      message: 'Sign in to "OpenAI subscription" for the "planner" config: agent-qa auth login --config planner',
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

describe('a missing credential names the auth command to run', () => {
  let tempDir: string
  let authPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-auth-messages-'))
    authPath = join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    clearLLMAuthProviderPlugins()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('a subscription config with no sign-in is told to run auth login with its name', async () => {
    const withoutPlugin = await resolveLLMAuth('claude-code', {
      provider: 'anthropic-subscription',
      model: 'claude-sonnet',
    }, authPath)

    expect(withoutPlugin.kind).toBe('missing')
    if (withoutPlugin.kind !== 'missing') throw new Error('Expected missing result')
    expect(withoutPlugin.message).toContain('npm install -D @vostride/agent-qa-subscription-auth')
    expect(withoutPlugin.message).toContain('plugins.auth')

    registerLLMAuthProviderPlugin({
      providerId: 'anthropic-subscription',
      credentialProviderId: 'anthropic-subscription',
      label: 'Anthropic subscription',
      modelAdapter: 'anthropic-messages',
      dashboardAuth: { mode: 'manual-code' },
      createAuthFetch: () => globalThis.fetch,
    })

    const result = await resolveLLMAuth('claude-code', {
      provider: 'anthropic-subscription',
      model: 'claude-sonnet',
    }, authPath)

    expect(result.kind).toBe('missing')
    if (result.kind !== 'missing') throw new Error('Expected missing result')
    expect(result.message).toContain('agent-qa auth login --config claude-code')
    expect(result.message).toContain('Anthropic subscription')
  })

  it('an API-key config with no key is told to run auth set with its name', async () => {
    const unusable = { type: 'session', provider: 'any', key: 'sk-unusable-not-a-key' }
    await writeAuth('compat', unusable as unknown as AuthCredential, authPath)
    await writeAuth('claude-compat', unusable as unknown as AuthCredential, authPath)

    const gemini = await resolveLLMAuth('gemini-key', {
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
    }, authPath)
    const openAI = await resolveLLMAuth('compat', {
      provider: 'openai-compatible',
      model: 'chat-compatible',
      baseURL: 'https://remote.example/v1',
    }, authPath)
    const anthropic = await resolveLLMAuth('claude-compat', {
      provider: 'anthropic-compatible',
      model: 'claude-compatible',
      baseURL: 'https://remote.example/messages',
    }, authPath)

    const messages = [gemini, openAI, anthropic].map((result) => {
      expect(result.kind).toBe('missing')
      if (result.kind !== 'missing') throw new Error('Expected missing result')
      return result.message
    })
    expect(messages[0]).toContain('agent-qa auth set --config gemini-key --type api-key')
    expect(messages[0]).toContain('Gemini API key')
    expect(messages[1]).toContain('agent-qa auth set --config compat --type api-key')
    expect(messages[2]).toContain('agent-qa auth set --config claude-compat --type api-key')
    expect(messages[2]).toContain('--type bearer-token')
    for (const text of messages) expect(text).not.toContain('sk-unusable-not-a-key')
  })
})

describe('a compatible config on a public API host needs a key', () => {
  let tempDir: string
  let authPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-public-api-key-'))
    authPath = join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    clearLLMAuthProviderPlugins()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('a compatible config with no key on api.anthropic.com or api.openai.com resolves as missing and names auth set', async () => {
    const anthropicConfig = {
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-6',
      baseURL: 'https://api.anthropic.com/v1',
    }
    const anthropic = await resolveLLMAuth('default', anthropicConfig, authPath)
    expect(anthropic.kind).toBe('missing')
    if (anthropic.kind !== 'missing') throw new Error('Expected missing result')
    expect(anthropic.message).toContain('agent-qa auth set --config default --type api-key')
    expect(anthropic.message).toContain('--type bearer-token')

    const openAI = await resolveLLMAuth('compat', {
      provider: 'openai-compatible',
      model: 'gpt-5.2',
      baseURL: 'https://api.openai.com/v1',
    }, authPath)
    expect(openAI.kind).toBe('missing')
    if (openAI.kind !== 'missing') throw new Error('Expected missing result')
    expect(openAI.message).toContain('agent-qa auth set --config compat --type api-key')

    const [first, second] = await Promise.all([
      resolveLLMAuth('default', anthropicConfig, authPath),
      resolveLLMAuth('default', anthropicConfig, authPath),
    ])
    expect(first).toEqual(second)
    expect(first).toEqual(anthropic)
    expect(existsSync(authPath)).toBe(false)
  })

  it('a compatible config with no key on a local or self-hosted server stays credential optional', async () => {
    const hosts = [
      'http://127.0.0.1:11434/v1',
      'http://localhost:8080/v1',
      'https://llm.internal.example/v1',
    ]
    const results: unknown[] = []
    for (const baseURL of hosts) {
      for (const provider of ['openai-compatible', 'anthropic-compatible'] as const) {
        const config = { provider, model: 'local-model', baseURL }
        results.push(await resolveLLMAuth('local', config, authPath))
      }
    }
    expect(results).toHaveLength(6)
    for (const result of results) {
      expect(result).toMatchObject({ kind: 'unauthenticated', credentialKey: 'local', optional: true })
    }
  })

  it('the public host is matched on the parsed hostname, ignoring case', async () => {
    const resolveFor = (provider: 'openai-compatible' | 'anthropic-compatible', baseURL: string) =>
      resolveLLMAuth('default', { provider, model: 'any-model', baseURL }, authPath)

    const upperCase = await resolveFor('anthropic-compatible', 'HTTPS://API.ANTHROPIC.COM/v1')
    const explicitPort = await resolveFor('openai-compatible', 'https://Api.OpenAI.com:443/v1')
    expect(upperCase.kind).toBe('missing')
    expect(explicitPort.kind).toBe('missing')

    const lookAlikes = [
      await resolveFor('anthropic-compatible', 'https://api.anthropic.com.evil.example/v1'),
      await resolveFor('anthropic-compatible', 'https://evil.example/api.anthropic.com/v1'),
      await resolveFor('openai-compatible', 'https://evil.example/v1?u=https://api.openai.com'),
      await resolveFor('openai-compatible', 'not a url'),
    ]
    expect(lookAlikes.map(result => result.kind)).toEqual([
      'unauthenticated',
      'unauthenticated',
      'unauthenticated',
      'unauthenticated',
    ])
  })
})
