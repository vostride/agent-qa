import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'

type MobilePlatform = 'android' | 'ios'
type CloseStatus = 'completed' | 'failed' | 'cancelled' | 'timeout'

interface AppiumInstance {
  acquireLease: Mock
  releaseLease: Mock
  shutdown: Mock
  getUrl: Mock
  leases: Map<string, string>
  releases: Array<{ runId: string; reason: string }>
  stopCalls: number
}

interface RunnerInstance {
  execute: Mock
  kill: Mock
  killAll: Mock
  getHandle: Mock
  getActiveExecutions: Mock
  closeRun: (runId: string, status: CloseStatus) => void
}

const mockState = vi.hoisted(() => ({
  appiumInstances: [] as AppiumInstance[],
  runnerInstances: [] as RunnerInstance[],
  events: [] as string[],
  outputs: new Map<string, string[]>(),
}))

vi.mock('../execution/test-runner.js', () => {
  class MockTestRunner {
    static resolveCliBin = vi.fn(() => '/mock/agent-qa')

    private onProcessClose?: (runId: string, status: CloseStatus) => void

    execute = vi.fn()
    kill = vi.fn((runId: string) => {
      mockState.events.push(`kill:${runId}`)
      return true
    })
    killAll = vi.fn(() => {
      mockState.events.push('killAll')
    })
    getHandle = vi.fn((runId: string) => ({ output: mockState.outputs.get(runId) ?? [] }))
    getActiveExecutions = vi.fn(() => [])
    closeRun = (runId: string, status: CloseStatus): void => {
      this.onProcessClose?.(runId, status)
    }

    constructor(opts: { onProcessClose?: (runId: string, status: CloseStatus) => void }) {
      this.onProcessClose = opts.onProcessClose
      mockState.runnerInstances.push(this as unknown as RunnerInstance)
    }
  }

  return { TestRunner: MockTestRunner }
})

vi.mock('../execution/appium-manager.js', () => {
  class MockAppiumManager {
    leases = new Map<string, string>()
    releases: Array<{ runId: string; reason: string }> = []
    stopCalls = 0
    getUrl = vi.fn(() => 'http://localhost:4723')
    acquireLease = vi.fn(async ({ runId, platform }: { runId: string; platform: MobilePlatform }) => {
      this.leases.set(runId, platform)
      mockState.events.push(`acquire:${runId}:${platform}`)
    })
    releaseLease = vi.fn((runId: string, reason = 'completed') => {
      const existed = this.leases.delete(runId)
      this.releases.push({ runId, reason })
      mockState.events.push(`release:${runId}:${reason}`)
      if (existed && this.leases.size === 0) {
        this.stopCalls++
      }
      return existed
    })
    shutdown = vi.fn(() => {
      mockState.events.push('shutdown')
    })

    constructor() {
      mockState.appiumInstances.push(this as unknown as AppiumInstance)
    }
  }

  return { AppiumManager: MockAppiumManager }
})

vi.mock('@vostride/agent-qa-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-core')>()
  return {
    ...actual,
    createModel: vi.fn().mockResolvedValue({ modelId: 'test-model' }),
    getProviderOptions: vi.fn().mockReturnValue(undefined),
    LLMPlanner: vi.fn().mockImplementation(function () { return { plan: vi.fn() } }),
    LLMVerifier: vi.fn().mockImplementation(function () { return { verify: vi.fn() } }),
  }
})

vi.mock('@vostride/agent-qa-android', () => ({
  AndroidPlatformAdapter: vi.fn().mockImplementation(function () {
    return {
      platform: 'android',
      setup: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn(),
      screenshot: vi.fn(),
      observe: vi.fn(),
      drainConsoleLogs: vi.fn(() => []),
      drainNetworkLogs: vi.fn(() => []),
    }
  }),
}))

import { DashboardDatabase } from '../db/database.js'
import { startServer } from '../server/server.js'

interface QueueResponse {
  runId: string
  status: string
  position: number
}

interface CancelResponse {
  cancelled: boolean
}

let started: Awaited<ReturnType<typeof startServer>> | undefined
let tempDir: string | undefined
let currentDb: DashboardDatabase | undefined

afterEach(async () => {
  if (started) {
    started.close()
    started = undefined
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
  currentDb = undefined
  mockState.appiumInstances.length = 0
  mockState.runnerInstances.length = 0
  mockState.events.length = 0
  mockState.outputs.clear()
  vi.clearAllMocks()
})

const MOBILE_CONFIG = `
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  agentRules: agent-rules.md
  envFile: .env
  secretsFile: .secrets.local
concurrency: 2
use:
  mobile:
    appState: preserve
registry:
  targets:
    release-android-wikipedia:
      platform: android
      appPackage: org.wikipedia.alpha
  devices:
    release-android-emu:
      platform: android
      transport: local
      match: {}
`

function createConfigPath(content = MOBILE_CONFIG): { configPath: string; workspacePaths: ReturnType<typeof resolveWorkspacePaths> } {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-qa-appium-ownership-'))
  const configPath = join(tempDir, 'agent-qa.config.yaml')
  writeFileSync(join(tempDir, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(tempDir, 'agent-rules.md'), '')
  writeFileSync(join(tempDir, '.env'), '')
  writeFileSync(join(tempDir, '.secrets.local'), '')
  writeFileSync(configPath, content)
  return {
    configPath,
    workspacePaths: resolveWorkspacePaths({
      config: parseYaml(content),
      configPath,
    }),
  }
}

async function startDashboard(opts: { configContent?: string; llm?: boolean } = {}): Promise<number> {
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  currentDb = db
  const { configPath, workspacePaths } = createConfigPath(opts.configContent)
  started = await startServer({
    db,
    port: 0,
    configPath,
    workspacePaths,
    llmConfig: opts.llm
      ? {
          provider: 'anthropic-compatible',
          model: 'claude-sonnet-4-20250514',
          baseURL: 'https://anthropic-proxy.example/messages',
        }
      : undefined,
  })
  return getPort(started.server)
}

function getPort(server: Server): number {
  const address = server.address() as AddressInfo | null
  if (!address) throw new Error('server did not expose an address')
  return address.port
}

async function postJson<T>(port: number, path: string, body: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${response.status}: ${text}`)
  }
  return (text ? JSON.parse(text) : {}) as T
}

async function deleteJson<T>(port: number, path: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'DELETE',
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${response.status}: ${text}`)
  }
  return (text ? JSON.parse(text) : {}) as T
}

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('Timed out waiting for assertion')
}

function currentAppium(): AppiumInstance {
  expect(mockState.appiumInstances).toHaveLength(1)
  return mockState.appiumInstances[0]
}

function currentRunner(): RunnerInstance {
  expect(mockState.runnerInstances).toHaveLength(1)
  return mockState.runnerInstances[0]
}

describe('dashboard Appium ownership', () => {
  it('keeps shared Appium alive until both overlapping Android and iOS runs complete', async () => {
    const port = await startDashboard()
    const android = await postJson<QueueResponse>(port, '/api/queue/enqueue', {
      name: 'Android',
      platform: 'android',
      parallel: true,
    })
    const ios = await postJson<QueueResponse>(port, '/api/queue/enqueue', {
      name: 'iOS',
      platform: 'ios',
      parallel: true,
    })

    const appium = currentAppium()
    const runner = currentRunner()
    await waitFor(() => expect(runner.execute).toHaveBeenCalledTimes(2))

    expect(appium.acquireLease).toHaveBeenCalledWith({ runId: android.runId, platform: 'android' })
    expect(appium.acquireLease).toHaveBeenCalledWith({ runId: ios.runId, platform: 'ios' })

    const executeCalls = runner.execute.mock.calls as Array<[{ env?: Record<string, string> }]>
    expect(executeCalls.map(([opts]) => opts.env?.AGENT_QA_APPIUM_URL)).toEqual([
      'http://localhost:4723',
      'http://localhost:4723',
    ])

    runner.closeRun(android.runId, 'completed')
    expect(appium.releaseLease).toHaveBeenCalledWith(android.runId, 'completed')
    expect(appium.leases.size).toBe(1)
    expect(appium.leases.has(ios.runId)).toBe(true)
    expect(appium.stopCalls).toBe(0)

    runner.closeRun(ios.runId, 'completed')
    expect(appium.releaseLease).toHaveBeenCalledWith(ios.runId, 'completed')
    expect(appium.leases.size).toBe(0)
    expect(appium.stopCalls).toBe(1)
  })

  it('releases only the cancelled mobile run lease through the process-close path', async () => {
    const port = await startDashboard()
    const android = await postJson<QueueResponse>(port, '/api/queue/enqueue', {
      name: 'Android',
      platform: 'android',
      parallel: true,
    })

    const appium = currentAppium()
    const runner = currentRunner()
    await waitFor(() => expect(runner.execute).toHaveBeenCalledTimes(1))

    const cancel = await postJson<CancelResponse>(port, `/api/runs/${android.runId}/cancel`, {})
    expect(cancel.cancelled).toBe(true)
    expect(runner.kill).toHaveBeenCalledWith(android.runId)

    runner.closeRun(android.runId, 'cancelled')
    expect(appium.releaseLease).toHaveBeenCalledWith(android.runId, 'cancelled')
    expect(appium.releases).toEqual([{ runId: android.runId, reason: 'cancelled' }])
    expect(appium.leases.size).toBe(0)
    expect(appium.stopCalls).toBe(1)
    const artifact = currentDb!.getRunArtifact(android.runId)
    expect(artifact?.finalizedAt).toBeTruthy()
    expect(artifact?.payload.errors?.[0]).toMatchObject({ code: 'cancelled' })
  })

  it('fails a timed-out run even when all persisted steps passed', async () => {
    const port = await startDashboard()
    const run = await postJson<QueueResponse>(port, '/api/queue/enqueue', {
      name: 'Passed steps then hang',
      platform: 'web',
    })

    const runner = currentRunner()
    await waitFor(() => expect(runner.execute).toHaveBeenCalledTimes(1))
    currentDb!.insertStep({
      runId: run.runId,
      name: 'Step already passed',
      status: 'passed',
      duration: 25,
      stepOrder: 0,
    })

    runner.closeRun(run.runId, 'timeout')

    const stored = currentDb!.getRun(run.runId)
    expect(stored?.status).toBe('failed')
    expect(stored?.failureSummary).toBe('Test timed out -- process was killed')
    const artifact = currentDb!.getRunArtifact(run.runId)
    expect(artifact?.finalizedAt).toBeTruthy()
    expect(artifact?.payload.runtime).toMatchObject({
      processStatus: 'timeout',
      finalStatus: 'failed',
    })
  })

  it('fails an incomplete exit even when the child process reports completed', async () => {
    const port = await startDashboard()
    const run = await postJson<QueueResponse>(port, '/api/queue/enqueue', {
      name: 'Exit zero no completion',
      platform: 'web',
    })

    const runner = currentRunner()
    await waitFor(() => expect(runner.execute).toHaveBeenCalledTimes(1))

    runner.closeRun(run.runId, 'completed')

    const stored = currentDb!.getRun(run.runId)
    expect(stored?.status).toBe('failed')
    expect(stored?.failureSummary).toBe('Process exited before test completed')
    const artifact = currentDb!.getRunArtifact(run.runId)
    expect(artifact?.payload.runtime).toMatchObject({
      processStatus: 'completed',
      finalStatus: 'failed',
    })
  })

  it('persists framework stderr as a failed process close', async () => {
    const port = await startDashboard()
    const run = await postJson<QueueResponse>(port, '/api/queue/enqueue', {
      name: 'Framework error',
      platform: 'web',
    })

    const runner = currentRunner()
    await waitFor(() => expect(runner.execute).toHaveBeenCalledTimes(1))
    mockState.outputs.set(run.runId, [
      'debug line',
      'Framework error: provider rejected request',
    ])

    runner.closeRun(run.runId, 'failed')

    const stored = currentDb!.getRun(run.runId)
    expect(stored?.status).toBe('failed')
    expect(stored?.failureSummary).toBe('Framework error: provider rejected request')
    expect(stored?.errorLog).toContain('provider rejected request')
  })

  it('releases a cancelled mobile lease once and starts the next queued mobile job', async () => {
    const port = await startDashboard()
    const first = await postJson<QueueResponse>(port, '/api/queue/enqueue', {
      name: 'Android 1',
      platform: 'android',
      parallel: true,
    })
    const second = await postJson<QueueResponse>(port, '/api/queue/enqueue', {
      name: 'Android 2',
      platform: 'android',
      parallel: true,
    })

    const appium = currentAppium()
    const runner = currentRunner()
    await waitFor(() => expect(runner.execute).toHaveBeenCalledTimes(1))
    expect(appium.acquireLease).toHaveBeenCalledWith({ runId: first.runId, platform: 'android' })
    expect(currentDb!.getRun(second.runId)?.status).toBe('pending')

    const cancel = await postJson<CancelResponse>(port, `/api/runs/${first.runId}/cancel`, {})
    expect(cancel.cancelled).toBe(true)
    runner.closeRun(first.runId, 'cancelled')

    await waitFor(() => expect(runner.execute).toHaveBeenCalledTimes(2))
    expect(appium.releases).toEqual([{ runId: first.runId, reason: 'cancelled' }])
    expect(appium.acquireLease).toHaveBeenCalledWith({ runId: second.runId, platform: 'android' })
    expect(currentDb!.getRun(second.runId)?.status).toBe('running')
  })

  it('shares Appium ownership between queued and live mobile sessions', async () => {
    const port = await startDashboard({ configContent: MOBILE_CONFIG, llm: true })
    const queued = await postJson<QueueResponse>(port, '/api/queue/enqueue', {
      name: 'Queued Android',
      platform: 'android',
      parallel: true,
    })

    const appium = currentAppium()
    const runner = currentRunner()
    await waitFor(() => expect(runner.execute).toHaveBeenCalledTimes(1))

    const live = await postJson<{ sessionId: string }>(port, '/api/live-editor/sessions', {
      platform: 'android',
      targetName: 'release-android-wikipedia',
      useDeviceName: 'release-android-emu',
    })

    expect(appium.acquireLease).toHaveBeenCalledWith({ runId: queued.runId, platform: 'android' })
    expect(appium.acquireLease).toHaveBeenCalledWith({ runId: live.sessionId, platform: 'android' })
    expect(appium.leases.size).toBe(2)

    await deleteJson<{ ok: boolean }>(port, `/api/live-editor/sessions/${live.sessionId}`)

    expect(appium.releaseLease).toHaveBeenCalledWith(live.sessionId, 'session-cleanup')
    expect(appium.leases.has(queued.runId)).toBe(true)
    expect(appium.stopCalls).toBe(0)

    runner.closeRun(queued.runId, 'completed')
    expect(appium.releaseLease).toHaveBeenCalledWith(queued.runId, 'completed')
    expect(appium.stopCalls).toBe(1)
  })

  it('kills test processes before releasing leases and shutting Appium down on server close', async () => {
    const port = await startDashboard()
    const android = await postJson<QueueResponse>(port, '/api/queue/enqueue', {
      name: 'Android',
      platform: 'android',
      parallel: true,
    })

    const appium = currentAppium()
    const runner = currentRunner()
    await waitFor(() => expect(runner.execute).toHaveBeenCalledTimes(1))

    started!.close()
    started = undefined

    expect(runner.killAll).toHaveBeenCalledOnce()
    expect(appium.releaseLease).toHaveBeenCalledWith(android.runId, 'server-close')
    expect(appium.shutdown).toHaveBeenCalledOnce()

    const killAllIndex = mockState.events.indexOf('killAll')
    const releaseIndex = mockState.events.indexOf(`release:${android.runId}:server-close`)
    const shutdownIndex = mockState.events.indexOf('shutdown')
    expect(killAllIndex).toBeGreaterThanOrEqual(0)
    expect(releaseIndex).toBeGreaterThan(killAllIndex)
    expect(shutdownIndex).toBeGreaterThan(releaseIndex)
  })
})
