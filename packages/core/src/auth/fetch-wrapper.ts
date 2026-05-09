import type { AuthProvider, OAuthTokens, TokenRefreshFn } from './types.js'

export interface CreateAuthFetchOptions {
  provider: AuthProvider
  getTokens: () => Promise<OAuthTokens>
  refreshTokens: TokenRefreshFn
  onTokensRefreshed: (tokens: OAuthTokens) => Promise<void>
  headerTransform?: (headers: Headers, tokens: OAuthTokens) => void
  urlTransform?: (url: string) => string
}

export function createAuthFetch(options: CreateAuthFetchOptions): typeof globalThis.fetch {
  const { provider, getTokens, refreshTokens, onTokensRefreshed, headerTransform, urlTransform } =
    options

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let tokens = await getTokens()

    if (tokens.expires < Date.now()) {
      tokens = await refreshTokens(provider, tokens.refresh)
      await onTokensRefreshed(tokens)
    }

    // Build headers without creating a Request (avoids Node duplex stream issue)
    const headers = new Headers()
    if (input instanceof Request) {
      input.headers.forEach((value, key) => { headers.set(key, value) })
    }
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => { headers.set(key, value) })
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          if (value !== undefined) headers.set(key, String(value))
        }
      } else {
        for (const [key, value] of Object.entries(init.headers)) {
          if (value !== undefined) headers.set(key, String(value))
        }
      }
    }

    // Strip existing auth headers
    headers.delete('authorization')
    headers.delete('x-api-key')

    // Inject Bearer token
    headers.set('Authorization', `Bearer ${tokens.access}`)

    if (headerTransform) {
      headerTransform(headers, tokens)
    }

    // Extract URL
    let url: string
    if (typeof input === 'string') url = input
    else if (input instanceof URL) url = input.toString()
    else url = input.url

    if (urlTransform) {
      url = urlTransform(url)
    }

    const response = await globalThis.fetch(url, {
      ...init,
      headers,
    })

    if (!response.ok) {
      const respBody = await response.text()
      return new Response(respBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    return response
  }
}
