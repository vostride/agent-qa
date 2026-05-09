import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { startServer as startServerType } from '../server/server.js'

const { mockCaptureAnalytics, mockResolveAnalyticsStandardProperties } = vi.hoisted(() => ({
  mockCaptureAnalytics: vi.fn(),
  mockResolveAnalyticsStandardProperties: vi.fn(async () => ({
    surface: 'dashboard-server',
    runtime_context: 'user',
    agent_qa_version: '0.1.0',
  })),
}))

vi.mock('@vostride/agent-qa-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-core')>()
  return {
    ...actual,
    captureAnalytics: mockCaptureAnalytics,
    resolveAnalyticsStandardProperties: mockResolveAnalyticsStandardProperties,
  }
})

vi.mock('../execution/test-runner.js', () => {
  class MockTestRunner {
    static resolveCliBin = vi.fn(() => '/mock/agent-qa')
    execute = vi.fn()
    kill = vi.fn()
    killAll = vi.fn()
    getHandle = vi.fn(() => ({ output: [] }))
  }

  return { TestRunner: MockTestRunner }
})

vi.mock('../execution/appium-manager.js', () => {
  class MockAppiumManager {
    acquireLease = vi.fn()
    releaseLease = vi.fn()
    shutdown = vi.fn()
    getUrl = vi.fn(() => 'http://localhost:4723')
  }

  return { AppiumManager: MockAppiumManager }
})

const startedServers: Array<Awaited<ReturnType<typeof startServerType>>> = []
const tempDirs: string[] = []

afterEach(() => {
  vi.clearAllMocks()
  for (const started of startedServers.splice(0)) {
    started.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-mcp-server-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  writeFileSync(configPath, content)
  return configPath
}

describe('dashboard MCP startup', () => {
  it('starts a local MCP HTTP endpoint by default', async () => {
    const { DashboardDatabase, startServer } = await import('../index.js')
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const configPath = createConfig('services: {}\n')

    const started = await startServer({ db, port: 0, configPath })
    startedServers.push(started)

    expect(started.mcp).toMatchObject({
      enabled: true,
      transport: 'http',
      host: '127.0.0.1',
      path: '/mcp',
    })
    expect(started.mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(mockCaptureAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'agent-qa.mcp.server.lifecycle',
        properties: expect.objectContaining({
          surface: 'dashboard-server',
          mcp_server_state: 'started',
          mcp_transport: 'http',
          mcp_host_kind: 'loopback',
          mcp_path_kind: 'default',
          $process_person_profile: false,
        }),
      }),
      expect.objectContaining({ config: expect.any(Object) }),
    )
    const serialized = JSON.stringify(mockCaptureAnalytics.mock.calls.map(([event]) => event.properties))
    expect(serialized).not.toContain(started.mcp.url)
    expect(serialized).not.toContain(configPath)

    const response = await fetch(started.mcp.url!, { method: 'OPTIONS' })
    expect(response.status).toBe(204)
  })

  it('respects services.mcp.enabled false', async () => {
    const { DashboardDatabase, startServer } = await import('../index.js')
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const configPath = createConfig('services:\n  mcp:\n    enabled: false\n    path: /phase245-config-secret\n')

    const started = await startServer({ db, port: 0, configPath })
    startedServers.push(started)

    expect(started.mcp).toEqual({
      enabled: false,
      transport: 'http',
    })
    expect(mockCaptureAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'agent-qa.mcp.server.lifecycle',
        properties: expect.objectContaining({
          surface: 'dashboard-server',
          mcp_server_state: 'disabled',
          mcp_transport: 'http',
          $process_person_profile: false,
        }),
      }),
      expect.objectContaining({ config: expect.any(Object) }),
    )
    const serialized = JSON.stringify(mockCaptureAnalytics.mock.calls.map(([event]) => event.properties))
    expect(serialized).not.toContain('phase245-config-secret')
    expect(serialized).not.toContain(configPath)
  })

  it('skips lifecycle analytics when privacy is enabled', async () => {
    const { DashboardDatabase, startServer } = await import('../index.js')
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const configPath = createConfig('analytics:\n  privacy: true\nservices: {}\n')

    const started = await startServer({ db, port: 0, configPath })
    startedServers.push(started)

    expect(started.mcp.enabled).toBe(true)
    expect(mockCaptureAnalytics).not.toHaveBeenCalled()
    expect(mockResolveAnalyticsStandardProperties).not.toHaveBeenCalled()
  })

  it('continues startup when lifecycle analytics capture rejects', async () => {
    mockCaptureAnalytics.mockRejectedValueOnce(new Error('phase245 analytics failure'))
    const { DashboardDatabase, startServer } = await import('../index.js')
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const configPath = createConfig('services: {}\n')

    const started = await startServer({ db, port: 0, configPath })
    startedServers.push(started)

    expect(started.mcp.enabled).toBe(true)
    expect(mockCaptureAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'agent-qa.mcp.server.lifecycle',
        properties: expect.objectContaining({
          mcp_server_state: 'started',
          mcp_transport: 'http',
        }),
      }),
      expect.objectContaining({ config: expect.any(Object) }),
    )
    expect(JSON.stringify(mockCaptureAnalytics.mock.calls.map(([event]) => event.properties)))
      .not.toContain('phase245 analytics failure')
  })
})
