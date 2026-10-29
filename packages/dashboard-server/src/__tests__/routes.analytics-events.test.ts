// A 404 from the real router, not a mock, proves the analytics route stays gone.

import { readFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server')

let createRouter: typeof import('../server/routes.js').createRouter
let router: ReturnType<typeof import('../server/routes.js').createRouter>

function createMockDatabase() {
  return {
    getRuns() {
      return []
    },
    getFlakyTests() {
      return []
    },
    close() {},
  }
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

async function invokeRoute(
  url: string,
  options: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {},
): Promise<MockResponse> {
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
    } as unknown as ServerResponse

    try {
      router(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

function routeBody(body: unknown): { method: 'POST'; body: string; headers: IncomingHttpHeaders } {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

beforeEach(async () => {
  ;({ createRouter } = await import('../server/routes.js'))
  router = createRouter({ db: createMockDatabase() as never })
})

describe('the dropped dashboard analytics bridge route', () => {
  it('has no ingest endpoint: a v33 dashboard product event is refused, not accepted', async () => {
    const response = await invokeRoute('/api/analytics/events', routeBody({
      name: 'agent-qa.dashboard.opened',
      properties: {},
    }))

    expect(response.status).toBe(404)
  })

  it('refuses every one of the three v33 event names, not just the first', async () => {
    for (const name of [
      'agent-qa.dashboard.opened',
      'agent-qa.dashboard.live_mode.started',
      'agent-qa.dashboard.entity.created',
    ]) {
      const response = await invokeRoute('/api/analytics/events', routeBody({ name, properties: {} }))

      expect(response.status).toBe(404)
    }
  })

  it('leaves the read-only analytics reporting routes alone — only the ingest route dropped', async () => {
    // `/api/analytics/tests|suites|breakdowns` are the dashboard's own run-history reporting and
    // have nothing to do with product telemetry. Pinned so "delete the analytics routes" cannot be
    // read as a licence to take these with them.
    const response = await invokeRoute('/api/analytics/tests')

    expect(response.status).not.toBe(404)
  })

  it('keeps the capture vocabulary out of the dashboard server source', async () => {
    for (const file of ['routes.ts', 'server.ts']) {
      const source = await readFile(join(SERVER_DIR, file), 'utf8')

      expect(source).not.toMatch(/\bcaptureAnalytics\b/u)
      expect(source).not.toMatch(/\bbuildAnalyticsEvent\b/u)
      expect(source).not.toMatch(/\bresolveAnalyticsStandardProperties\b/u)
      expect(source).not.toMatch(/\banalyticsBridge\b/u)
      expect(source).not.toMatch(/agent-qa\.dashboard\./u)
    }
  })
})
