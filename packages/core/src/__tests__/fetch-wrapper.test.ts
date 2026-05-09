import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAuthFetch } from '../auth/fetch-wrapper.js'
import type { OAuthTokens, AuthProvider } from '../auth/types.js'

describe('createAuthFetch', () => {
  const validTokens: OAuthTokens = {
    access: 'access-token-123',
    refresh: 'refresh-token-456',
    expires: Date.now() + 3600000,
  }

  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('injects Authorization Bearer header', async () => {
    const authFetch = createAuthFetch({
      provider: 'anthropic-subscription',
      getTokens: async () => validTokens,
      refreshTokens: vi.fn(),
      onTokensRefreshed: vi.fn(),
    })

    await authFetch('https://api.example.com/v1/messages')

    expect(globalThis.fetch).toHaveBeenCalledOnce()
    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const headers = new Headers(opts.headers)
    expect(headers.get('Authorization')).toBe('Bearer access-token-123')
  })

  it('strips existing auth headers', async () => {
    const authFetch = createAuthFetch({
      provider: 'anthropic-subscription',
      getTokens: async () => validTokens,
      refreshTokens: vi.fn(),
      onTokensRefreshed: vi.fn(),
    })

    await authFetch('https://api.example.com/v1/messages', {
      headers: {
        'x-api-key': 'old-key',
        Authorization: 'Basic old-auth',
      },
    })

    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const headers = new Headers(opts.headers)
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('Authorization')).toBe('Bearer access-token-123')
  })

  it('refreshes expired tokens before request', async () => {
    const expiredTokens: OAuthTokens = {
      access: 'expired-access',
      refresh: 'refresh-token',
      expires: Date.now() - 1000,
    }
    const newTokens: OAuthTokens = {
      access: 'new-access',
      refresh: 'new-refresh',
      expires: Date.now() + 3600000,
    }

    const refreshTokens = vi.fn().mockResolvedValue(newTokens)
    const onTokensRefreshed = vi.fn()

    const authFetch = createAuthFetch({
      provider: 'anthropic-subscription',
      getTokens: async () => expiredTokens,
      refreshTokens,
      onTokensRefreshed,
    })

    await authFetch('https://api.example.com/v1/messages')

    expect(refreshTokens).toHaveBeenCalledWith('anthropic-subscription', 'refresh-token')
    expect(onTokensRefreshed).toHaveBeenCalledWith(newTokens)

    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const headers = new Headers(opts.headers)
    expect(headers.get('Authorization')).toBe('Bearer new-access')
  })

  it('calls headerTransform with headers and tokens', async () => {
    const headerTransform = vi.fn((headers: Headers, tokens: OAuthTokens) => {
      headers.set('x-account-id', tokens.accountId ?? 'none')
    })

    const tokensWithAccount: OAuthTokens = {
      ...validTokens,
      accountId: 'acct-789',
    }

    const authFetch = createAuthFetch({
      provider: 'anthropic-subscription',
      getTokens: async () => tokensWithAccount,
      refreshTokens: vi.fn(),
      onTokensRefreshed: vi.fn(),
      headerTransform,
    })

    await authFetch('https://api.example.com/v1/messages')

    expect(headerTransform).toHaveBeenCalledOnce()
    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const headers = new Headers(opts.headers)
    expect(headers.get('x-account-id')).toBe('acct-789')
  })

  it('applies urlTransform to the request URL', async () => {
    const authFetch = createAuthFetch({
      provider: 'anthropic-subscription',
      getTokens: async () => validTokens,
      refreshTokens: vi.fn(),
      onTokensRefreshed: vi.fn(),
      urlTransform: (url) => url.replace('api.anthropic.com', 'subscription.anthropic.com'),
    })

    await authFetch('https://api.anthropic.com/v1/messages')

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://subscription.anthropic.com/v1/messages')
  })

  it('does not refresh when tokens are still valid', async () => {
    const refreshTokens = vi.fn()

    const authFetch = createAuthFetch({
      provider: 'anthropic-subscription',
      getTokens: async () => validTokens,
      refreshTokens,
      onTokensRefreshed: vi.fn(),
    })

    await authFetch('https://api.example.com/v1/messages')

    expect(refreshTokens).not.toHaveBeenCalled()
  })

  it('preserves request method and body', async () => {
    const authFetch = createAuthFetch({
      provider: 'anthropic-subscription',
      getTokens: async () => validTokens,
      refreshTokens: vi.fn(),
      onTokensRefreshed: vi.fn(),
    })

    await authFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello' }),
    })

    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(opts.method).toBe('POST')
  })
})
