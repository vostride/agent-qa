import {
  createRemoteRefusalMemory,
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
  RemoteRefusalMemory,
  RemoteSessionRegistry,
} from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { AndroidPlatformAdapter } from '../adapter.js'
import type { AndroidAdapterConfig, AndroidAdapterOptions } from '../types.js'
import { startFakeAppiumServer } from './fixtures/fake-appium-server.js'
import type { FakeAppiumOptions, FakeAppiumServer } from './fixtures/fake-appium-server.js'

const USER = 'stack-user-mark'
const connectionSecrets = new SecretStore({ STACK_USER: USER })
const LINK = 'https://vendor.example.com/sessions/42'

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
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
  // Each call in order: an upload, then an acquire.
  readonly calls: string[]
  readonly release: Mock<() => Promise<void>>
  readonly started: Mock<RemoteLease['started']>
  end(ended: RemoteLeaseEnded): void
}

function fakeLeases(
  answer: RemoteLeaseAnswer,
  options: {
    onRelease?: () => void
    started?: { link?: string; appiumVersion?: string }
    uploads?: false
  } = {},
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
    Promise.resolve(options.started ?? { link: LINK, appiumVersion: '3.5.2' }),
  )
  const source: RemoteLeaseSource = {
    ...(options.uploads === false
      ? {}
      : {
          uploadApp(request: UploadRequest) {
            uploads.push(request)
            calls.push('uploadApp')
            return Promise.resolve({ ref: 'bs://shop-1' })
          },
        }),
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
  extra: Partial<AndroidAdapterConfig> = {},
): AndroidAdapterConfig {
  return {
    platform: 'android',
    targetName: 'shop-android',
    appPackage: 'com.example.shop',
    appState: 'preserve',
    runFacts: { testName: 'checkout' },
    ...extra,
    device: {
      name: 'galaxy-stack',
      platform: 'android',
      model: 'Samsung Galaxy S24',
      os: '14',
      ...(capabilities === undefined ? {} : { capabilities }),
      remote,
    },
  }
}

function adapterFor(
  options: {
    pluginSessions?: RemoteLeaseSource
    refusalMemory?: RemoteRefusalMemory
    sessions?: RemoteSessionRegistry
  } = {},
): AndroidPlatformAdapter {
  const adapterOptions: AndroidAdapterOptions = {
    connectionSecrets,
    secretsFile: '.env.secrets.local',
    ...options,
  }
  const adapter = new AndroidPlatformAdapter(adapterOptions)
  teardowns.push(() => adapter.cleanup())
  return adapter
}

async function refusalOf(
  adapter: AndroidPlatformAdapter,
  config: AndroidAdapterConfig,
): Promise<RemoteRefusalError> {
  const error = await adapter.setup(config).then(
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

describe('an Android device on a plugin remote', () => {
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

    await adapter.setup(deviceOn(remote, { 'appium:autoGrantPermissions': true }))

    expect(leases.requests).toHaveLength(1)
    expect(leases.requests[0]).toMatchObject({
      remote: 'stack',
      plugin: { entry: 'stack', settings: { project: 'shop' } },
      deadlineMs: 30_000,
      testName: 'checkout',
      session: {
        platform: 'android',
        capabilities: {
          platformName: 'Android',
          'appium:automationName': 'UiAutomator2',
          'appium:deviceName': 'Samsung Galaxy S24',
          'appium:platformVersion': '14',
          'appium:newCommandTimeout': 90,
          'appium:appPackage': 'com.example.shop',
          'appium:noReset': true,
          'bstack:options': { buildName: 'remote', userName: '{{secret:STACK_USER}}' },
          'appium:autoGrantPermissions': true,
        },
      },
    })
    expect(newSessionRequests(server)).toHaveLength(1)
    expect(alwaysMatch(server)).toMatchObject({
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:deviceName': 'Samsung Galaxy S24',
      'appium:appPackage': 'com.example.shop',
      'appium:newCommandTimeout': 300,
      'bstack:options': { sessionName: 'x', buildName: 'remote', userName: USER },
      'appium:autoGrantPermissions': true,
    })
  })

  it("tells the plugin the session's id, and records the plugin, its link and its Appium version", async () => {
    const server = await fakeServer()
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
      device: 'galaxy-stack',
      appiumVersion: '3.5.2',
      sessionId,
      plugin: { entry: 'stack', version: '1.0.0', origin: 'path' },
      link: LINK,
    })
  })

  it("records no Appium version when the plugin's started names none, whatever the server's status says", async () => {
    const server = await fakeServer({ status: { version: '2.45.0' } })
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

    const error = await refusalOf(adapter, deviceOn(pluginRemote()))

    expect(error.kind).toBe('refused')
    expect(error.message).toBe(
      `Remote stack (appium ${server.origin}) refused a session for device galaxy-stack: No device.`,
    )
    expect(leases.release).toHaveBeenCalledTimes(1)
    expect(leases.started).not.toHaveBeenCalled()
  })

  it('refuses an answer whose capabilities contradict the device, and releases its lease', async () => {
    const server = await fakeServer()
    const leases = fakeLeases(answerAt(server, { platformName: 'iOS' }))
    const adapter = adapterFor({ pluginSessions: leases.source })

    const error = await refusalOf(adapter, deviceOn(pluginRemote()))

    expect(error.kind).toBe('refused')
    expect(error.message).toBe(
      'Remote stack (plugin stack) sets platformName "iOS" in its capabilities; device galaxy-stack is android.',
    )
    expect(leases.release).toHaveBeenCalledTimes(1)
    expect(server.requests).toHaveLength(0)
  })

  it('refuses a device on a plugin remote when this host started no plugin host', async () => {
    const adapter = adapterFor()

    const error = await refusalOf(adapter, deviceOn(pluginRemote()))

    expect(error.kind).toBe('refused')
    expect(error.message).toBe(
      'Remote stack names plugin entry stack, and this host started no plugin host for it.',
    )
  })

  it('asks the plugin nothing for a remote the run already refused', async () => {
    const leases = fakeLeases({ protocol: 'appium', url: 'http://127.0.0.1:9/wd/hub' })
    const refusalMemory = createRemoteRefusalMemory()
    refusalMemory.remember(
      'stack',
      new RemoteRefusalError('Remote stack: plugin entry stack serves playwright only.', {
        remote: 'stack',
        kind: 'refused',
      }),
    )
    const adapter = adapterFor({ pluginSessions: leases.source, refusalMemory })

    const error = await refusalOf(adapter, deviceOn(pluginRemote()))

    expect(error.message).toBe('Remote stack: plugin entry stack serves playwright only.')
    expect(leases.requests).toHaveLength(0)
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
})

describe('the app an Android device on a plugin remote installs', () => {
  const APP_PATH = '/builds/shop-android/shop.apk'

  it("uploads a target's app.path through the plugin before the acquire, and sends the ref as appium:app, never the path", async () => {
    const server = await fakeServer()
    const leases = fakeLeases(answerAt(server))
    const adapter = adapterFor({ pluginSessions: leases.source })

    await adapter.setup(deviceOn(pluginRemote(), undefined, { appPath: APP_PATH }))

    expect(leases.calls).toEqual(['uploadApp', 'acquire'])
    expect(leases.uploads).toEqual([
      {
        remote: 'stack',
        plugin: { entry: 'stack', settings: { project: 'shop' } },
        platform: 'android',
        path: APP_PATH,
        deadlineMs: 600_000,
      },
    ])
    expect(alwaysMatch(server)['appium:app']).toBe('bs://shop-1')
    expect(JSON.stringify(server.requests)).not.toContain(APP_PATH)
    expect(JSON.stringify(leases.requests)).not.toContain(APP_PATH)
  })

  it('sends a set app.ref and uploads nothing', async () => {
    const server = await fakeServer()
    const leases = fakeLeases(answerAt(server))
    const adapter = adapterFor({ pluginSessions: leases.source })

    await adapter.setup(
      deviceOn(pluginRemote(), undefined, {
        appPath: APP_PATH,
        appRef: 'https://builds.example.com/shop.apk',
      }),
    )

    expect(leases.uploads).toHaveLength(0)
    expect(alwaysMatch(server)['appium:app']).toBe('https://builds.example.com/shop.apk')
  })

  it('uploads nothing when the capabilities already name the app', async () => {
    const server = await fakeServer()
    const leases = fakeLeases(answerAt(server))
    const adapter = adapterFor({ pluginSessions: leases.source })

    await adapter.setup(
      deviceOn(pluginRemote(), { 'appium:app': 'bs://kept' }, { appPath: APP_PATH }),
    )

    expect(leases.uploads).toHaveLength(0)
    expect(alwaysMatch(server)['appium:app']).toBe('bs://kept')
  })

  it('refuses an app.path alone when its plugin uploads no apps, before any acquire', async () => {
    const leases = fakeLeases(
      { protocol: 'appium', url: 'http://127.0.0.1:9/wd/hub' },
      { uploads: false },
    )
    const adapter = adapterFor({ pluginSessions: leases.source })

    const error = await refusalOf(
      adapter,
      deviceOn(pluginRemote(), undefined, { appPath: APP_PATH }),
    )

    expect(error.kind).toBe('refused')
    expect(error.message).toBe(
      'Remote stack: plugin entry stack uploads no apps; set app.ref on the target to an app the service already has.',
    )
    expect(leases.requests).toHaveLength(0)
  })
})
