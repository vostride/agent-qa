import { type IncomingHttpHeaders, IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DashboardDatabase } from '../db/database.js'
import { createRouter } from '../server/routes.js'
import { clearLLMAuthProviderPlugins } from '@vostride/agent-qa-core'
import { clearProviderRegistry, registerProvider, type ProviderDescriptor } from '@vostride/agent-qa-model'

vi.mock('ai', () => ({
  addToolInputExamplesMiddleware: vi.fn(() => ({})),
  createProviderRegistry: vi.fn(),
  customProvider: vi.fn(),
  extractJsonMiddleware: vi.fn(() => ({})),
  generateText: vi.fn(() => Promise.resolve({ text: 'ok' })),
  parsePartialJson: vi.fn(),
}))

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

interface ProviderMetadata {
  id: string
  label: string
  auth: { kind: string; credentialTypes?: string[]; optional?: boolean }
  needsBaseURL?: boolean
  authModes?: string[]
  subscription?: boolean
  baseURLPlaceholder?: string
  defaultModel?: string
}

function createMockRequest(
  url: string,
  options: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {},
): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = options.method ?? 'GET'
  req.url = url
  req.headers = { host: '127.0.0.1:3470', ...options.headers }

  process.nextTick(() => {
    if (options.body) {
      req.push(Buffer.from(options.body))
    }
    req.push(null)
  })

  return req
}

function createMockDatabase(): DashboardDatabase {
  return {
    getRuns: () => [],
  } as unknown as DashboardDatabase
}

async function invokeRoute(
  url: string,
  options: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {},
): Promise<MockResponse> {
  const router = createRouter({ db: createMockDatabase() })

  return await new Promise((resolve, reject) => {
    const req = createMockRequest(url, options)
    const headers = new Map<string, string>()
    let status = 200
    let body = ''

    const res = {
      writeHead(statusCode: number, head?: Record<string, string>) {
        status = statusCode
        if (head) {
          for (const [key, value] of Object.entries(head)) {
            headers.set(key.toLowerCase(), value)
          }
        }
        return this
      },
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value)
      },
      getHeader(name: string) {
        return headers.get(name.toLowerCase())
      },
      write(chunk: string | Buffer) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk) {
          body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk
        }
        resolve({
          status,
          headers: Object.fromEntries(headers),
          body,
        })
      },
      on() {
        return this
      },
      once() {
        return this
      },
      emit() {
        return false
      },
      removeListener() {
        return this
      },
    } as unknown as ServerResponse

    try {
      router(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

function parseProviders(response: MockResponse): ProviderMetadata[] {
  const payload = JSON.parse(response.body) as { providers: ProviderMetadata[] }
  return payload.providers
}

describe('llm provider metadata route', () => {
  beforeEach(() => {
    clearProviderRegistry()
    clearLLMAuthProviderPlugins()
  })

  afterEach(() => {
    clearProviderRegistry()
    clearLLMAuthProviderPlugins()
    vi.restoreAllMocks()
  })

  it('serves registry-backed built-in non-subscription provider metadata', async () => {
    const res = await invokeRoute('/api/llm/providers')
    const providers = parseProviders(res)
    const providersById = new Map(providers.map(provider => [provider.id, provider]))

    expect(res.status).toBe(200)
    expect(providers.map(provider => provider.id)).toEqual([
      'openai-compatible',
      'anthropic-compatible',
      'gemini',
    ])

    for (const id of ['openai-compatible', 'anthropic-compatible', 'gemini']) {
      const provider = providersById.get(id)

      expect(provider).toMatchObject({
        needsBaseURL: expect.any(Boolean),
        authModes: expect.any(Array),
      })
      expect(provider?.authModes?.length).toBeGreaterThan(0)
    }

    expect(providersById.get('openai-compatible')).toMatchObject({
      auth: { kind: 'api-key', credentialTypes: ['api-key'], optional: true },
      needsBaseURL: true,
      authModes: ['api-key'],
      baseURLPlaceholder: 'https://openrouter.ai/api/v1',
      defaultModel: 'gpt-5.5',
    })
    expect(providersById.get('anthropic-compatible')).toMatchObject({
      auth: { kind: 'api-key', credentialTypes: ['api-key', 'bearer-token'], optional: true },
      needsBaseURL: true,
      authModes: ['api-key', 'bearer-token'],
    })
    expect(providersById.get('gemini')).toMatchObject({
      auth: { kind: 'api-key', credentialTypes: ['api-key'] },
      needsBaseURL: false,
      authModes: ['api-key'],
    })
  })

  it('surfaces a registered non-subscription provider without a route edit', async () => {
    const fakeAdapter: ProviderDescriptor['adapter'] = (_transport, modelId) =>
      ({ provider: 'sixth-provider', modelId }) as ReturnType<ProviderDescriptor['adapter']>

    registerProvider({
      id: 'sixth-provider',
      label: 'Sixth',
      adapter: fakeAdapter,
      needsBaseURL: true,
      authModes: ['api-key'],
      baseURLPlaceholder: 'https://x',
    })

    const res = await invokeRoute('/api/llm/providers')
    const providers = parseProviders(res)

    expect(res.status).toBe(200)
    expect(providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'sixth-provider',
        label: 'Sixth',
        auth: { kind: 'api-key', credentialTypes: ['api-key'] },
        needsBaseURL: true,
        authModes: ['api-key'],
        baseURLPlaceholder: 'https://x',
      }),
    ]))
  })
})
