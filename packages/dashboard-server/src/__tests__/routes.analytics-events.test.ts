import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildAnalyticsEvent,
  captureAnalytics,
  resolveAnalyticsStandardProperties,
} from '@vostride/agent-qa-core'

const {
  mockBuildAnalyticsEvent,
  mockCaptureAnalytics,
  mockResolveAnalyticsStandardProperties,
} = vi.hoisted(() => ({
  mockBuildAnalyticsEvent: vi.fn(),
  mockCaptureAnalytics: vi.fn(),
  mockResolveAnalyticsStandardProperties: vi.fn(),
}))

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  return {
    ...actual,
    buildAnalyticsEvent: mockBuildAnalyticsEvent,
    captureAnalytics: mockCaptureAnalytics,
    resolveAnalyticsStandardProperties: mockResolveAnalyticsStandardProperties,
  }
})

await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
const buildAnalyticsEventMock = vi.mocked(buildAnalyticsEvent)
const captureAnalyticsMock = vi.mocked(captureAnalytics)
const resolveAnalyticsStandardPropertiesMock = vi.mocked(resolveAnalyticsStandardProperties)
type ConfigManagerInstance = InstanceType<typeof import('../config/index.js').ConfigManager>

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

let ConfigManager: typeof import('../config/index.js').ConfigManager
let createRouter: typeof import('../server/routes.js').createRouter
let router: ReturnType<typeof import('../server/routes.js').createRouter>
let tempDirs: string[] = []

function createMockDatabase() {
  return {
    getRuns() {
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
  req.headers = options.headers ?? {}

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

async function createConfigWorkspace(configContent: string): Promise<{
  configManager: ConfigManagerInstance
  configPath: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-analytics-route-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(configPath, configContent, 'utf-8')
  return {
    configManager: new ConfigManager(configPath),
    configPath,
  }
}

function routeBody(body: unknown): { method: 'POST'; body: string; headers: IncomingHttpHeaders } {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function createAnalyticsBridge() {
  return {
    buildAnalyticsEvent: buildAnalyticsEventMock,
    captureAnalytics: captureAnalyticsMock,
    resolveAnalyticsStandardProperties: resolveAnalyticsStandardPropertiesMock,
  }
}

beforeEach(async () => {
  ;({ ConfigManager } = await import('../config/index.js'))
  ;({ createRouter } = await import('../server/routes.js'))
  buildAnalyticsEventMock.mockImplementation((input) => ({
    name: input.name as never,
    properties: {
      ...(input.properties ?? {}),
      $process_person_profile: false,
    },
  }))
  captureAnalyticsMock.mockResolvedValue(undefined)
  resolveAnalyticsStandardPropertiesMock.mockResolvedValue({
    surface: 'dashboard-ui',
    runtime_context: 'user',
    agent_qa_version: '0.1.0',
  })
  router = createRouter({ db: createMockDatabase() as any, analyticsBridge: createAnalyticsBridge() })
})

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
  vi.clearAllMocks()
})

describe('dashboard analytics bridge route', () => {
  it('accepts dashboard product events and delegates capture through shared core analytics', async () => {
    const response = await invokeRoute('/api/analytics/events', routeBody({
      name: 'agent-qa.dashboard.opened',
      properties: {
        route: 'phase244-route-secret',
        url: 'https://phase244-secret.example',
        query: '?token=secret',
        entity_id: 'e_secret',
        entity_name: 'phase244-entity-name',
      },
    }))

    expect(response.status).toBe(202)
    expect(JSON.parse(response.body)).toEqual({ accepted: true })

    await vi.waitFor(() => expect(captureAnalyticsMock).toHaveBeenCalledTimes(1))
    expect(resolveAnalyticsStandardPropertiesMock).toHaveBeenCalledWith({ surface: 'dashboard-ui' })
    expect(buildAnalyticsEventMock).toHaveBeenCalledWith({
      name: 'agent-qa.dashboard.opened',
      properties: expect.objectContaining({
        surface: 'dashboard-ui',
        runtime_context: 'user',
        agent_qa_version: '0.1.0',
      }),
    })

    const buildInput = buildAnalyticsEventMock.mock.calls[0][0]
    expect(buildInput.properties).not.toHaveProperty('route')
    expect(buildInput.properties).not.toHaveProperty('url')
    expect(buildInput.properties).not.toHaveProperty('query')
    expect(buildInput.properties).not.toHaveProperty('entity_id')
    expect(buildInput.properties).not.toHaveProperty('entity_name')
    expect(captureAnalyticsMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent-qa.dashboard.opened' }),
      { config: {} },
    )
  })

  it('skips all analytics work when analytics privacy is enabled and still accepts the event', async () => {
    const { configManager, configPath } = await createConfigWorkspace([
      'workspace: {}',
      'services: {}',
      'registry: {}',
      'use: {}',
      'analytics:',
      '  privacy: true',
      '',
    ].join('\n'))
    const readConfigSpy = vi.spyOn(configManager, 'read')
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
      analyticsBridge: createAnalyticsBridge(),
    })

    const response = await invokeRoute('/api/analytics/events', routeBody({
      name: 'agent-qa.dashboard.opened',
      properties: {},
    }))

    expect(response.status).toBe(202)
    await vi.waitFor(() => expect(readConfigSpy).toHaveBeenCalled())
    expect(resolveAnalyticsStandardPropertiesMock).not.toHaveBeenCalled()
    expect(buildAnalyticsEventMock).not.toHaveBeenCalled()
    expect(captureAnalyticsMock).not.toHaveBeenCalled()
  })

  it('captures analytics when config omits analytics privacy', async () => {
    const { configManager, configPath } = await createConfigWorkspace([
      'workspace: {}',
      'services: {}',
      'registry: {}',
      'use: {}',
      '',
    ].join('\n'))
    const readConfigSpy = vi.spyOn(configManager, 'read')
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
      analyticsBridge: createAnalyticsBridge(),
    })

    const response = await invokeRoute('/api/analytics/events', routeBody({
      name: 'agent-qa.dashboard.opened',
      properties: {},
    }))

    expect(response.status).toBe(202)
    await vi.waitFor(() => expect(readConfigSpy).toHaveBeenCalled())
    await vi.waitFor(() => expect(captureAnalyticsMock).toHaveBeenCalledTimes(1))
    expect(resolveAnalyticsStandardPropertiesMock).toHaveBeenCalledWith({ surface: 'dashboard-ui' })
    expect(buildAnalyticsEventMock).toHaveBeenCalledWith({
      name: 'agent-qa.dashboard.opened',
      properties: expect.objectContaining({
        surface: 'dashboard-ui',
        runtime_context: 'user',
        agent_qa_version: '0.1.0',
      }),
    })
    expect(captureAnalyticsMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent-qa.dashboard.opened' }),
      { config: {} },
    )
  })

  it('fails closed for telemetry when analytics config cannot be read and still accepts the event', async () => {
    const readConfigMock = vi.fn().mockRejectedValue(new Error('phase244 config read failed'))
    router = createRouter({
      db: createMockDatabase() as any,
      configManager: { read: readConfigMock } as unknown as ConfigManagerInstance,
      analyticsBridge: createAnalyticsBridge(),
    })

    const response = await invokeRoute('/api/analytics/events', routeBody({
      name: 'agent-qa.dashboard.opened',
      properties: {},
    }))

    expect(response.status).toBe(202)
    await vi.waitFor(() => expect(readConfigMock).toHaveBeenCalled())
    expect(resolveAnalyticsStandardPropertiesMock).not.toHaveBeenCalled()
    expect(buildAnalyticsEventMock).not.toHaveBeenCalled()
    expect(captureAnalyticsMock).not.toHaveBeenCalled()
  })

  it('does not surface shared capture failures as dashboard HTTP errors', async () => {
    captureAnalyticsMock.mockRejectedValueOnce(new Error('phase244 capture failed'))

    const response = await invokeRoute('/api/analytics/events', routeBody({
      name: 'agent-qa.dashboard.opened',
      properties: {},
    }))

    expect(response.status).toBe(202)
    expect(JSON.parse(response.body)).toEqual({ accepted: true })
    await vi.waitFor(() => expect(captureAnalyticsMock).toHaveBeenCalledTimes(1))
  })

  it.each([
    [{ properties: {} }, 'missing name'],
    [{ name: 42, properties: {} }, 'non-string name'],
    [{ name: 'agent-qa.dashboard.opened', properties: [] }, 'array properties'],
    [{ name: 'agent-qa.dashboard.route.viewed', properties: {} }, 'route event'],
  ])('rejects invalid analytics payloads: %s', async (body, _caseName) => {
    const response = await invokeRoute('/api/analytics/events', routeBody(body))

    expect(response.status).toBe(400)
    expect(JSON.parse(response.body)).toEqual({ error: 'Invalid analytics event' })
    expect(captureAnalyticsMock).not.toHaveBeenCalled()
  })
})
