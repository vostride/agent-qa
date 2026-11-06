import {
  createRemoteSessionRegistry,
  REMOTE_RELEASE_BOUND_MS,
  RemoteRefusalError,
  SecretStore,
} from '@vostride/agent-qa-runner'
import type {
  RemoteLease,
  RemoteLeaseAnswer,
  RemoteLeaseEnded,
  RemoteLeaseRequest,
  RemoteLeaseSource,
  RemotePluginDeviceConfig,
  RemoteSessionRegistry,
} from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { IOSPlatformAdapter } from '../adapter.js'
import { createIOSSession } from '../session.js'
import type { IOSAdapterConfig, IOSAdapterOptions } from '../types.js'

interface FakeAppiumRequest {
  readonly method: string
  readonly path: string
  readonly search: string
  readonly body: unknown
}

interface FakeAppiumServer {
  readonly url: string
  readonly origin: string
  readonly requests: readonly FakeAppiumRequest[]
  sessionsCreated(): readonly string[]
  sessionsDeleted(): readonly string[]
  close(): Promise<void>
}

interface FakeAppiumOptions {
  readonly newSession?: readonly (
    | 'ok'
    | { readonly status: number; readonly json: unknown }
  )[]
  readonly status?: { readonly version?: string }
}

const { startFakeAppiumServer } = (await import(
  new URL('../../../android/src/__tests__/fixtures/fake-appium-server.js', import.meta.url).href
)) as { startFakeAppiumServer: (options?: FakeAppiumOptions) => Promise<FakeAppiumServer> }

const USER = 'stack-user-mark'
const connectionSecrets = new SecretStore({ STACK_USER: USER })
const LINK = 'https://vendor.example.com/sessions/42'
const HUB_VERSION = '2.45.0'

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

async function fakeServer(options: FakeAppiumOptions = {}): Promise<FakeAppiumServer> {
  const server = await startFakeAppiumServer(options)
  teardowns.push(() => server.close())
  return server
}

type UploadRequest = Parameters<NonNullable<RemoteLeaseSource['uploadApp']>>[0]

interface FakeLeases {
  readonly source: RemoteLeaseSource
  readonly requests: RemoteLeaseRequest[]
  readonly uploads: UploadRequest[]
  readonly calls: string[]
  readonly release: Mock<() => Promise<void>>
  readonly started: Mock<RemoteLease['started']>
  end(ended: RemoteLeaseEnded): void
}

function fakeLeases(
  answer: RemoteLeaseAnswer,
  options: { onRelease?: () => void; started?: { link?: string; appiumVersion?: string } } = {},
): FakeLeases {
  const requests: RemoteLeaseRequest[] = []
  const uploads: UploadRequest[] = []
  const calls: string[] = []
  const listeners = new Set<(ended: RemoteLeaseEnded) => void>()
  const release = vi.fn<() => Promise<void>>(() => {
    options.onRelease?.()
    return Promise.resolve()
  })
  const started = vi.fn<RemoteLease['started']>(() =>
    Promise.resolve(options.started ?? { link: LINK, appiumVersion: '3.2.0' }),
  )
  const source: RemoteLeaseSource = {
    uploadApp(request: UploadRequest) {
      uploads.push(request)
      calls.push('uploadApp')
      return Promise.resolve({ ref: 'bs://shop-ios-1' })
    },
    acquire(request) {
      requests.push(request)
      calls.push('acquire')
      return Promise.resolve({
        connection: answer,
        plugin: {
          entry: 'stack',
          path: './tools/stack',
          version: '1.0.0',
          protocol: 1,
          origin: 'path',
        },
        started,
        end: () => Promise.resolve(),
        release,
        onEnded(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      })
    },
  }
  const end = (ended: RemoteLeaseEnded) => {
    for (const listener of [...listeners]) listener(ended)
  }
  return { source, requests, uploads, calls, release, started, end }
}

function answerAt(
  server: FakeAppiumServer,
  capabilities: Record<string, unknown> = { 'bstack:options': { sessionName: 'x' } },
): RemoteLeaseAnswer {
  return { protocol: 'appium', url: server.url, capabilities }
}

function pluginRemote(extra: Partial<RemotePluginDeviceConfig> = {}): RemotePluginDeviceConfig {
  return {
    name: 'stack',
    plugin: { entry: 'stack', settings: { project: 'shop' } },
    connectTimeoutMs: 30_000,
    uploadTimeoutMs: 600_000,
    ...extra,
  }
}

function deviceOn(
  remote: RemotePluginDeviceConfig,
  capabilities?: Record<string, unknown>,
  extra: Partial<IOSAdapterConfig> = {},
): IOSAdapterConfig {
  return {
    platform: 'ios',
    targetName: 'shop-ios',
    bundleId: 'com.example.shop',
    appState: 'preserve',
    runFacts: { testName: 'checkout' },
    ...extra,
    device: {
      name: 'iphone-stack',
      platform: 'ios',
      model: 'iPhone 15',
      os: '17',
      ...(capabilities === undefined ? {} : { capabilities }),
      remote,
    },
  }
}

function adapterFor(
  options: { pluginSessions?: RemoteLeaseSource; sessions?: RemoteSessionRegistry } = {},
): IOSPlatformAdapter {
  const adapterOptions: IOSAdapterOptions = {
    connectionSecrets,
    secretsFile: '.env.secrets.local',
    timing: { heartbeatIntervalMs: 60_000 },
    ...options,
  }
  const adapter = new IOSPlatformAdapter(adapterOptions)
  teardowns.push(() => adapter.cleanup())
  return adapter
}

async function refusalOf(work: Promise<unknown>): Promise<RemoteRefusalError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(RemoteRefusalError)
  return error as RemoteRefusalError
}

function newSessionRequests(server: FakeAppiumServer) {
  return server.requests.filter(
    (request) => request.method === 'POST' && request.path.endsWith('/session'),
  )
}

function alwaysMatch(server: FakeAppiumServer): Record<string, unknown> {
  const [request] = newSessionRequests(server)
  const body = request?.body as { capabilities?: { alwaysMatch?: Record<string, unknown> } }
  return body.capabilities?.alwaysMatch ?? {}
}

describe('an iOS device on a plugin remote', () => {
  it('asks the plugin for a device with the derived, remote and device capabilities as written, then opens its session on the answer', async () => {
    const server = await fakeServer()
    const leases = fakeLeases(
      answerAt(server, {
        'bstack:options': { sessionName: 'x', buildName: 'answer' },
        'appium:newCommandTimeout': 300,
      }),
    )
    const adapter = adapterFor({ pluginSessions: leases.source })
    const remote = pluginRemote({
      capabilities: {
        'bstack:options': { buildName: 'remote', userName: '{{secret:STACK_USER}}' },
      },
    })

    await adapter.setup(deviceOn(remote, { 'appium:autoAcceptAlerts': true }))

    expect(leases.requests).toHaveLength(1)
    expect(leases.requests[0]).toMatchObject({
      remote: 'stack',
      plugin: { entry: 'stack', settings: { project: 'shop' } },
      deadlineMs: 30_000,
      testName: 'checkout',
      session: {
        platform: 'ios',
        capabilities: {
          platformName: 'iOS',
          'appium:automationName': 'XCUITest',
          'appium:deviceName': 'iPhone 15',
          'appium:platformVersion': '17',
          'appium:newCommandTimeout': 90,
          'appium:bundleId': 'com.example.shop',
          'appium:noReset': true,
          'bstack:options': { buildName: 'remote', userName: '{{secret:STACK_USER}}' },
          'appium:autoAcceptAlerts': true,
        },
      },
    })
    expect(newSessionRequests(server)).toHaveLength(1)
    expect(alwaysMatch(server)).toMatchObject({
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:deviceName': 'iPhone 15',
      'appium:bundleId': 'com.example.shop',
      'appium:newCommandTimeout': 300,
      'bstack:options': { sessionName: 'x', buildName: 'remote', userName: USER },
      'appium:autoAcceptAlerts': true,
    })
  })

  it("sends the answer url's query on every request to the answered server", async () => {
    const server = await fakeServer()
    const leases = fakeLeases({ ...answerAt(server), url: `${server.url}?token=t%2F1&region=eu` })
    const adapter = adapterFor({ pluginSessions: leases.source })

    await adapter.setup(deviceOn(pluginRemote()))
    await adapter.cleanup()

    expect(server.requests.length).toBeGreaterThan(1)
    for (const request of server.requests) {
      expect(new URLSearchParams(request.search).get('token')).toBe('t/1')
      expect(new URLSearchParams(request.search).get('region')).toBe('eu')
    }
  })

  it("tells the plugin the session's id, and records the plugin, its link and the Appium version its started answer names", async () => {
    const server = await fakeServer({ status: { version: HUB_VERSION } })
    const leases = fakeLeases(answerAt(server))
    const adapter = adapterFor({ pluginSessions: leases.source })

    await adapter.setup(deviceOn(pluginRemote()))

    const [sessionId] = server.sessionsCreated()
    expect(leases.started).toHaveBeenCalledWith({ sessionId })
    expect(adapter.remoteLink).toBe(LINK)
    expect(adapter.remoteLease).toBeDefined()
    expect(adapter.placeEvidence).toMatchObject({
      place: 'remote',
      name: 'stack',
      protocol: 'appium',
      origin: server.origin,
      device: 'iphone-stack',
      appiumVersion: '3.2.0',
      sessionId,
      plugin: { entry: 'stack', version: '1.0.0', origin: 'path' },
      link: LINK,
    })
    expect(JSON.stringify(adapter.placeEvidence)).not.toContain(HUB_VERSION)
  })

  it("records no Appium version when the plugin's started names none, whatever the server's status says", async () => {
    const server = await fakeServer({ status: { version: HUB_VERSION } })
    const leases = fakeLeases(answerAt(server), { started: {} })
    const adapter = adapterFor({ pluginSessions: leases.source })

    await adapter.setup(deviceOn(pluginRemote()))

    expect(adapter.placeEvidence).not.toHaveProperty('appiumVersion')
    expect(adapter.placeEvidence).not.toHaveProperty('link')
    expect(server.requests.some((request) => request.path.endsWith('/status'))).toBe(false)
  })

  it('deletes its session on cleanup before it gives the device back to the plugin', async () => {
    const server = await fakeServer()
    let deletedAtRelease: number | undefined
    const leases = fakeLeases(answerAt(server), {
      onRelease: () => {
        deletedAtRelease = server.sessionsDeleted().length
      },
    })
    const adapter = adapterFor({ pluginSessions: leases.source })
    await adapter.setup(deviceOn(pluginRemote()))

    await adapter.cleanup()

    expect(server.sessionsDeleted()).toEqual(server.sessionsCreated())
    expect(leases.release).toHaveBeenCalledTimes(1)
    expect(deletedAtRelease).toBe(1)
    expect(adapter.remoteLease).toBeUndefined()
  })

  it('on a signal deletes the session, then releases the lease', async () => {
    const server = await fakeServer()
    let deletedAtRelease: number | undefined
    const leases = fakeLeases(answerAt(server), {
      onRelease: () => {
        deletedAtRelease = server.sessionsDeleted().length
      },
    })
    const sessions = createRemoteSessionRegistry()
    const adapter = adapterFor({ pluginSessions: leases.source, sessions })
    await adapter.setup(deviceOn(pluginRemote()))

    await sessions.releaseAll(REMOTE_RELEASE_BOUND_MS)

    expect(deletedAtRelease).toBe(1)
    expect(leases.release).toHaveBeenCalledTimes(1)
  })

  it('releases the lease when the answered server refuses the new session', async () => {
    const server = await fakeServer({
      newSession: [
        {
          status: 500,
          json: {
            value: { error: 'session not created', message: 'No device', stacktrace: '' },
          },
        },
      ],
    })
    const leases = fakeLeases(answerAt(server))
    const adapter = adapterFor({ pluginSessions: leases.source })

    const error = await refusalOf(adapter.setup(deviceOn(pluginRemote())))

    expect(error.kind).toBe('refused')
    expect(error.message).toBe(
      `Remote stack (appium ${server.origin}) refused a session for device iphone-stack: No device.`,
    )
    expect(leases.release).toHaveBeenCalledTimes(1)
    expect(leases.started).not.toHaveBeenCalled()
  })

  it('refuses an answer whose capabilities contradict the device, and releases its lease', async () => {
    const server = await fakeServer()
    const leases = fakeLeases(answerAt(server, { platformName: 'Android' }))
    const adapter = adapterFor({ pluginSessions: leases.source })

    const error = await refusalOf(adapter.setup(deviceOn(pluginRemote())))

    expect(error.kind).toBe('refused')
    expect(error.message).toBe(
      'Remote stack (plugin stack) sets platformName "Android" in its capabilities; device iphone-stack is ios.',
    )
    expect(leases.release).toHaveBeenCalledTimes(1)
    expect(server.requests).toHaveLength(0)
  })

  it('refuses a device on a plugin remote when this host started no plugin host', async () => {
    const adapter = adapterFor()

    const error = await refusalOf(adapter.setup(deviceOn(pluginRemote())))

    expect(error.kind).toBe('refused')
    expect(error.message).toBe(
      'Remote stack names plugin entry stack, and this host started no plugin host for it.',
    )
  })

  it("fails the test with the plugin's line when its lease ends under it", async () => {
    const server = await fakeServer()
    const leases = fakeLeases(answerAt(server))
    const adapter = adapterFor({ pluginSessions: leases.source })
    await adapter.setup(deviceOn(pluginRemote()))

    leases.end({ kind: 'lost', message: 'Remote stack: plugin entry stack stopped unexpectedly.' })

    expect(adapter.isBrowserDisconnected).toBe(true)
    expect(adapter.disconnectSummary).toBe('Remote stack: plugin entry stack stopped unexpectedly.')
    expect(adapter.placeEvidence).toMatchObject({ failureKind: 'lost' })
  })

  it("uploads a target's app.path through the plugin before the acquire, and sends the ref as appium:app, never the path", async () => {
    const appPath = '/builds/shop-ios/Shop.app.zip'
    const server = await fakeServer()
    const leases = fakeLeases(answerAt(server))
    const adapter = adapterFor({ pluginSessions: leases.source })

    await adapter.setup(deviceOn(pluginRemote(), undefined, { appPath }))

    expect(leases.calls).toEqual(['uploadApp', 'acquire'])
    expect(leases.uploads).toEqual([
      {
        remote: 'stack',
        plugin: { entry: 'stack', settings: { project: 'shop' } },
        platform: 'ios',
        path: appPath,
        deadlineMs: 600_000,
      },
    ])
    expect(alwaysMatch(server)['appium:app']).toBe('bs://shop-ios-1')
    expect(JSON.stringify(server.requests)).not.toContain(appPath)
    expect(JSON.stringify(leases.requests)).not.toContain(appPath)
  })

  it('is refused by the session factory, which cannot hand back a lease', async () => {
    const server = await fakeServer()

    const error = await refusalOf(createIOSSession(deviceOn(pluginRemote())))

    expect(error.message).toBe(
      'Device iphone-stack is on remote stack, a plugin remote; its session opens through the iOS adapter, which leases it.',
    )
    expect(server.requests).toHaveLength(0)
  })
})
