import { type IncomingHttpHeaders, IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DashboardDatabase } from '../db/database.js'
import { createRouter } from '../server/routes.js'

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

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response
}

describe('model catalog routes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('serves the static model catalog', async () => {
    const res = await invokeRoute('/api/llm/catalog')
    const payload = JSON.parse(res.body) as { catalog: Record<string, Array<{ id: string }> > }

    expect(res.status).toBe(200)
    expect(Object.keys(payload.catalog).sort()).toEqual([
      'anthropic-compatible',
      'anthropic-subscription',
      'gemini',
      'openai-compatible',
      'openai-subscription',
    ])
    expect(payload.catalog.gemini.length).toBeGreaterThan(0)
  })

  it('merges live openai-compatible models with the static list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'extra-live-model' }] }),
    )

    const res = await invokeRoute('/api/llm/catalog/live', {
      method: 'POST',
      body: JSON.stringify({ baseURL: 'http://127.0.0.1:1234/v1' }),
    })
    const payload = JSON.parse(res.body) as { models: Array<{ id: string }> }
    const ids = payload.models.map(model => model.id)

    expect(res.status).toBe(200)
    expect(ids).toContain('deepseek-chat')
    expect(ids).toContain('extra-live-model')
  })

  it('falls back to the static openai-compatible catalog when live fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('econnrefused'))

    const res = await invokeRoute('/api/llm/catalog/live', {
      method: 'POST',
      body: JSON.stringify({ baseURL: 'http://127.0.0.1:9/v1' }),
    })
    const payload = JSON.parse(res.body) as { models: Array<{ id: string }> }

    expect(res.status).toBe(200)
    expect(payload.models.map(model => model.id)).toContain('deepseek-chat')
  })

  it('rejects raw api keys in the live catalog request body', async () => {
    const res = await invokeRoute('/api/llm/catalog/live', {
      method: 'POST',
      body: JSON.stringify({ baseURL: 'http://x/v1', apiKey: 'sk-leak' }),
    })

    expect(res.status).toBe(400)
  })
})
