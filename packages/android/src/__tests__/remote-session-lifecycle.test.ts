import {
  createRemoteSessionRegistry,
  REMOTE_RELEASE_BOUND_MS,
  SecretStore,
} from '@vostride/agent-qa-runner'
import type {
  ActionsFor,
  RemoteDeviceConfig,
  RemoteSessionRegistry,
} from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it } from 'vitest'

import { AndroidPlatformAdapter } from '../adapter.js'
import type { AndroidAdapterConfig, AndroidAdapterOptions } from '../types.js'
import { startFakeAppiumServer } from './fixtures/fake-appium-server.js'
import type { FakeAppiumOptions, FakeAppiumServer } from './fixtures/fake-appium-server.js'

const PATH_MARK = 'path-token-mark'
const connectionSecrets = new SecretStore({})
const QUIET_HEARTBEAT_MS = 60_000

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

async function fakeServer(options: FakeAppiumOptions = {}): Promise<FakeAppiumServer> {
  const server = await startFakeAppiumServer({ basePath: `/wd/hub/${PATH_MARK}`, ...options })
  teardowns.push(() => server.close())
  return server
}

function farmAt(server: FakeAppiumServer): RemoteDeviceConfig {
  return {
    name: 'farm',
    protocol: 'appium',
    url: `${server.origin}/wd/hub/${PATH_MARK}`,
    connectTimeoutMs: 30_000,
  }
}

function deviceOn(
  remote: RemoteDeviceConfig | undefined,
  appiumUrl?: string,
): AndroidAdapterConfig {
  return {
    platform: 'android',
    targetName: 'shop-android',
    appPackage: 'com.example.shop',
    appState: 'preserve',
    ...(appiumUrl !== undefined ? { appiumUrl } : {}),
    device: {
      name: 'galaxy-farm',
      platform: 'android',
      model: 'Samsung Galaxy S24',
      ...(remote !== undefined ? { remote } : {}),
    },
  }
}

async function opened(
  server: FakeAppiumServer,
  timing: NonNullable<AndroidAdapterOptions['timing']>,
  sessions?: RemoteSessionRegistry,
): Promise<AndroidPlatformAdapter> {
  const adapter = new AndroidPlatformAdapter({
    connectionSecrets,
    timing,
    ...(sessions !== undefined ? { sessions } : {}),
  })
  teardowns.push(() => adapter.cleanup())
  await adapter.setup(deviceOn(farmAt(server)))
  return adapter
}

function label(server: FakeAppiumServer): string {
  return `farm (appium ${server.origin})`
}

function lostSentence(server: FakeAppiumServer): string {
  return `Remote ${label(server)} did not answer a command for device galaxy-farm within 2m.`
}

const TAP = { type: 'tapCoordinate', x: 100, y: 200 } as ActionsFor<'android'>
const BACK = { type: 'pressBack' } as ActionsFor<'android'>

function sent(server: FakeAppiumServer, method: string, suffix: string): number {
  return server.requests.filter(
    (request) => request.method === method && request.path.endsWith(suffix),
  ).length
}

function beatsAfter(server: FakeAppiumServer, index: number): number {
  return server.requests
    .slice(index)
    .filter((request) => request.method === 'GET' && request.path.endsWith('/timeouts')).length
}

async function until(check: () => boolean, withinMs: number): Promise<void> {
  const deadline = Date.now() + withinMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('the condition did not hold in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("a remote Android session's life", () => {
  it('ends the test as lost when a command goes unanswered past the command bound, sent once', async () => {
    const server = await fakeServer({ hold: /^POST .*\/actions$/ })
    const adapter = await opened(server, {
      commandBoundMs: 400,
      heartbeatIntervalMs: QUIET_HEARTBEAT_MS,
    })

    const started = Date.now()
    const result = await adapter.execute(TAP)
    const took = Date.now() - started

    expect(result.success).toBe(false)
    expect(took).toBeGreaterThanOrEqual(350)
    expect(took).toBeLessThan(3_000)
    expect(sent(server, 'POST', '/actions')).toBe(1)
    expect(adapter.isBrowserDisconnected).toBe(true)
    expect(adapter.disconnectSummary).toBe(lostSentence(server))
    expect(adapter.placeEvidence).toMatchObject({ failureKind: 'lost' })

    const before = server.requests.length
    const next = await adapter.execute(BACK)
    expect(next).toEqual({ success: false, error: lostSentence(server) })
    await expect(adapter.observe()).rejects.toThrow(lostSentence(server))
    expect(server.requests).toHaveLength(before)
  })

  it('gives a command the command bound when the connect timeout is shorter', async () => {
    const server = await fakeServer({ slow: { pattern: /^POST .*\/actions$/, ms: 600 } })
    const adapter = new AndroidPlatformAdapter({
      connectionSecrets,
      timing: { commandBoundMs: 5_000, heartbeatIntervalMs: QUIET_HEARTBEAT_MS },
    })
    teardowns.push(() => adapter.cleanup())
    await adapter.setup(deviceOn({ ...farmAt(server), connectTimeoutMs: 200 }))

    const result = await adapter.execute(TAP)

    expect(result.success).toBe(true)
    expect(adapter.isBrowserDisconnected).toBe(false)
    expect(sent(server, 'POST', '/actions')).toBe(1)
  })

  it('ends the test as lost when a heartbeat goes unanswered past the command bound', async () => {
    const server = await fakeServer({ hold: /^GET .*\/timeouts$/ })
    const adapter = await opened(server, { commandBoundMs: 400, heartbeatIntervalMs: 50 })

    await until(() => adapter.isBrowserDisconnected, 3_000)

    expect(adapter.disconnectSummary).toBe(lostSentence(server))
    expect(sent(server, 'GET', '/timeouts')).toBe(1)
  })

  it('beats between actions and never during one', async () => {
    const server = await fakeServer({ hold: /^POST .*\/actions$/ })
    const adapter = await opened(server, { commandBoundMs: 600, heartbeatIntervalMs: 40 })

    const first = await adapter.execute(BACK)
    expect(first.success).toBe(true)
    const between = server.requests.length
    await until(() => beatsAfter(server, between) >= 2, 2_000)

    const held = adapter.execute(TAP)
    await until(() => sent(server, 'POST', '/actions') === 1, 2_000)
    const heldAt = server.requests.length
    await held

    expect(beatsAfter(server, heldAt)).toBe(0)
    expect(adapter.placeEvidence).toMatchObject({ heartbeat: { failed: 0 } })
  })

  it('is released by the session registry within the release bound, and the server keeps running', async () => {
    const server = await fakeServer()
    const sessions = createRemoteSessionRegistry()
    const adapter = await opened(server, { heartbeatIntervalMs: QUIET_HEARTBEAT_MS }, sessions)
    const [sessionId] = server.sessionsCreated()

    const started = Date.now()
    await sessions.releaseAll(REMOTE_RELEASE_BOUND_MS)

    expect(Date.now() - started).toBeLessThan(REMOTE_RELEASE_BOUND_MS)
    expect(server.sessionsDeleted()).toEqual([sessionId])
    expect((await fetch(`${server.url}/status`)).ok).toBe(true)

    await adapter.cleanup()
    expect(server.sessionsDeleted()).toEqual([sessionId])
  })

  it("records the remote, the Appium version and the session id in the place's evidence", async () => {
    const server = await fakeServer()
    const adapter = await opened(server, { heartbeatIntervalMs: QUIET_HEARTBEAT_MS })
    const [sessionId] = server.sessionsCreated()

    expect(adapter.placeEvidence).toEqual({
      place: 'remote',
      name: 'farm',
      protocol: 'appium',
      origin: server.origin,
      device: 'galaxy-farm',
      appiumVersion: '3.4.2',
      sessionId,
      heartbeat: { sent: 0, failed: 0, suspect: false },
    })
  })

  it('runs without an Appium version when the server has no status', async () => {
    const server = await fakeServer({ status: 'fail' })
    const adapter = await opened(server, { heartbeatIntervalMs: QUIET_HEARTBEAT_MS })

    expect(adapter.placeEvidence).not.toHaveProperty('appiumVersion')
    expect(adapter.isBrowserDisconnected).toBe(false)
  })

  it("names the remote by its label in a failed command's error, never its path or session id", async () => {
    const server = await fakeServer({
      sessionIdStyle: 'mixed',
      execute: {
        'mobile: pressKey': { status: 500, error: 'unknown error', message: 'key refused' },
      },
    })
    const adapter = await opened(server, { heartbeatIntervalMs: QUIET_HEARTBEAT_MS })
    const [sessionId] = server.sessionsCreated()

    const result = await adapter.execute(BACK)

    expect(result.success).toBe(false)
    expect(result.error).toContain(label(server))
    expect(result.error).toContain('key refused')
    expect(result.error).not.toContain(PATH_MARK)
    expect(result.error).not.toContain(String(sessionId))
    expect(adapter.isBrowserDisconnected).toBe(false)
  })

  it('counts a tap as done when the server does not know the release', async () => {
    const server = await fakeServer({ releaseActions: 'unknown command' })
    const adapter = await opened(server, { heartbeatIntervalMs: QUIET_HEARTBEAT_MS })

    const result = await adapter.execute(TAP)

    expect(result.success).toBe(true)
    expect(sent(server, 'POST', '/actions')).toBe(1)
    expect(sent(server, 'DELETE', '/actions')).toBe(1)
    expect(adapter.isBrowserDisconnected).toBe(false)
  })

  it('ends the test as lost when the release goes unanswered', async () => {
    const server = await fakeServer({ hold: /^DELETE .*\/actions$/ })
    const adapter = await opened(server, {
      commandBoundMs: 400,
      heartbeatIntervalMs: QUIET_HEARTBEAT_MS,
    })

    const result = await adapter.execute(TAP)

    expect(result.success).toBe(false)
    expect(adapter.disconnectSummary).toBe(lostSentence(server))
    expect(sent(server, 'DELETE', '/actions')).toBe(1)
  })

  it('ends the test as ended when the server ends the session, and deletes nothing', async () => {
    const server = await fakeServer({
      execute: {
        'mobile: pressKey': {
          status: 404,
          error: 'invalid session id',
          message: 'A session is either terminated or not started',
        },
      },
    })
    const adapter = await opened(server, { heartbeatIntervalMs: QUIET_HEARTBEAT_MS })

    const result = await adapter.execute(BACK)

    expect(result.success).toBe(false)
    expect(adapter.isBrowserDisconnected).toBe(true)
    expect(adapter.disconnectSummary).toBe(
      `Remote ${label(server)} ended the session for device galaxy-farm while this test ran.`,
    )
    expect(adapter.placeEvidence).toMatchObject({ failureKind: 'ended' })
    await adapter.cleanup()
    expect(server.sessionsDeleted()).toEqual([])
  })

  it('records a device here as here and sends it no heartbeat', async () => {
    const server = await fakeServer()
    const adapter = new AndroidPlatformAdapter({ timing: { heartbeatIntervalMs: 20 } })
    teardowns.push(() => adapter.cleanup())

    await adapter.setup(deviceOn(undefined, server.url))
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(adapter.placeEvidence).toEqual({ place: 'here' })
    expect(sent(server, 'GET', '/timeouts')).toBe(0)
    expect(adapter.isBrowserDisconnected).toBe(false)
    expect(adapter.disconnectSummary).toBeUndefined()
  })
})
