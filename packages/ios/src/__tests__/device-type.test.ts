import { SecretStore } from '@vostride/agent-qa-runner'
import type { ActionsFor, RemoteDeviceConfig } from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it } from 'vitest'

import { IOSPlatformAdapter } from '../adapter.js'
import type { IOSAdapterConfig } from '../types.js'

interface FakeAppiumRequest {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

interface FakeAppiumServer {
  readonly url: string
  readonly origin: string
  readonly requests: readonly FakeAppiumRequest[]
  close(): Promise<void>
}

interface FakeAppiumOptions {
  readonly execute?: Readonly<Record<string, unknown>>
  readonly releaseActions?: 'ok' | 'unknown command'
}

const { startFakeAppiumServer } = (await import(
  new URL('../../../android/src/__tests__/fixtures/fake-appium-server.js', import.meta.url).href
)) as { startFakeAppiumServer: (options?: FakeAppiumOptions) => Promise<FakeAppiumServer> }

const SIMULATOR = { 'mobile: deviceInfo': { isSimulator: true, model: 'iPhone' } }
const REAL_DEVICE = {
  'mobile: deviceInfo': { isSimulator: false, lockdownInfo: { ProductType: 'iPhone17,3' } },
}
const APP_DATA_NOTE =
  'App data was not cleared: device iphone-farm is a real iPhone, and target shop-ios has no app.ref to reinstall from.'

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

async function fakeServer(options: FakeAppiumOptions = {}): Promise<FakeAppiumServer> {
  const server = await startFakeAppiumServer(options)
  teardowns.push(() => server.close())
  return server
}

function adapterFor(): IOSPlatformAdapter {
  const adapter = new IOSPlatformAdapter({
    connectionSecrets: new SecretStore({}),
    timing: { heartbeatIntervalMs: 60_000 },
  })
  teardowns.push(() => adapter.cleanup())
  return adapter
}

function here(server: FakeAppiumServer): IOSAdapterConfig {
  return {
    platform: 'ios',
    targetName: 'shop-ios',
    bundleId: 'com.example.shop',
    appiumUrl: server.url,
    device: { name: 'iphone-here', platform: 'ios' },
  }
}

function onFarm(
  server: FakeAppiumServer,
  extra: Partial<IOSAdapterConfig> = {},
): IOSAdapterConfig {
  const remote: RemoteDeviceConfig = {
    name: 'farm',
    protocol: 'appium',
    url: server.url,
    connectTimeoutMs: 30_000,
  }
  return {
    platform: 'ios',
    targetName: 'shop-ios',
    bundleId: 'com.example.shop',
    appState: 'reset',
    ...extra,
    device: { name: 'iphone-farm', platform: 'ios', model: 'iPhone 16', remote },
  }
}

function executed(server: FakeAppiumServer, script: string): number {
  return server.requests.filter(
    (request) =>
      request.method === 'POST' &&
      request.path.endsWith('/execute/sync') &&
      (request.body as { script?: unknown } | undefined)?.script === script,
  ).length
}

function sent(server: FakeAppiumServer, method: string, suffix: string): number {
  return server.requests.filter(
    (request) => request.method === method && request.path.endsWith(suffix),
  ).length
}

function act(action: Record<string, unknown>): ActionsFor<'ios'> {
  return action as unknown as ActionsFor<'ios'>
}

describe("an iOS session's device type", () => {
  it('is a simulator when deviceInfo says so, asked once, and listApps is never requested', async () => {
    const server = await fakeServer({ execute: SIMULATOR })
    const adapter = adapterFor()

    await adapter.setup(here(server))
    const opened = await adapter.execute(act({ type: 'openApp', appName: 'Shop' }))
    await adapter.execute(act({ type: 'openApp', appName: 'Shop' }))

    expect(adapter.placeEvidence).toEqual({ place: 'here', deviceType: 'simulator' })
    expect(opened.success).toBe(false)
    expect(opened.error).toContain('openApp {bundleId}')
    expect(executed(server, 'mobile: deviceInfo')).toBe(1)
    expect(executed(server, 'mobile: listApps')).toBe(0)
  })

  it('is a real device when deviceInfo carries lockdownInfo, and listApps finds apps by name', async () => {
    const server = await fakeServer({
      execute: {
        ...REAL_DEVICE,
        'mobile: listApps': { 'com.example.shop': { CFBundleName: 'Shop' } },
      },
    })
    const adapter = adapterFor()

    await adapter.setup(onFarm(server, { appState: 'preserve' }))
    const opened = await adapter.execute(act({ type: 'openApp', appName: 'Shop' }))

    expect(adapter.placeEvidence).toMatchObject({ place: 'remote', deviceType: 'real device' })
    expect(opened).toMatchObject({ success: true, metadata: { openApp: { resolvedId: 'com.example.shop' } } })
    expect(executed(server, 'mobile: listApps')).toBe(1)
  })

  it('is unknown when deviceInfo fails, and the session still runs', async () => {
    const server = await fakeServer({
      execute: {
        'mobile: deviceInfo': { status: 500, error: 'unknown error', message: 'no device info' },
      },
    })
    const adapter = adapterFor()

    await adapter.setup(here(server))

    expect(adapter.placeEvidence).toEqual({ place: 'here', deviceType: 'unknown' })
    expect((await adapter.execute(act({ type: 'pressButton', button: 'home' }))).success).toBe(true)
  })
})

describe('what an iOS device type cannot do', () => {
  it('refuses a volume button on a simulator before sending it', async () => {
    const server = await fakeServer({ execute: SIMULATOR })
    const adapter = adapterFor()
    await adapter.setup(here(server))

    const result = await adapter.execute(act({ type: 'pressButton', button: 'volumeUp' }))

    expect(result).toEqual({
      success: false,
      error: 'pressButton "volumeUp" is not supported on this iOS simulator.',
    })
    expect(executed(server, 'mobile: pressButton')).toBe(0)
  })

  it('reports a simulator-only command a real device refuses', async () => {
    const server = await fakeServer({
      execute: {
        ...REAL_DEVICE,
        'mobile: shake': {
          status: 500,
          error: 'unknown error',
          message: 'Shaking the device can only be performed on Simulator',
        },
      },
    })
    const adapter = adapterFor()
    await adapter.setup(onFarm(server, { appState: 'preserve' }))

    const result = await adapter.execute(act({ type: 'executeScript', command: 'mobile: shake' }))

    expect(result).toEqual({
      success: false,
      error: 'executeScript "mobile: shake" is not supported on this iOS real device.',
    })
    expect(adapter.isBrowserDisconnected).toBe(false)
  })

  it('reports a command the server does not know on the device type the probe found', async () => {
    const server = await fakeServer({
      execute: {
        ...SIMULATOR,
        'mobile: startPerfRecord': {
          status: 404,
          error: 'unknown method',
          message: 'Method has not yet been implemented',
        },
      },
    })
    const adapter = adapterFor()
    await adapter.setup(here(server))

    const result = await adapter.execute(
      act({ type: 'executeScript', command: 'mobile: startPerfRecord' }),
    )

    expect(result).toEqual({
      success: false,
      error: 'executeScript "mobile: startPerfRecord" is not supported on this iOS simulator.',
    })
  })

  it('counts a tap as done when the server does not know the release', async () => {
    const server = await fakeServer({ execute: SIMULATOR, releaseActions: 'unknown command' })
    const adapter = adapterFor()
    await adapter.setup(onFarm(server, { appState: 'preserve' }))

    const result = await adapter.execute(
      act({ type: 'tapCoordinate', x: 100, y: 200, coordSpace: 'viewport' }),
    )

    expect(result.success).toBe(true)
    expect(sent(server, 'POST', '/actions')).toBe(1)
    expect(sent(server, 'DELETE', '/actions')).toBe(1)
    expect(adapter.isBrowserDisconnected).toBe(false)
  })
})

describe('app data on a real iPhone with appState reset', () => {
  it('runs the test and notes that the app data was not cleared when nothing reinstalls the app', async () => {
    const server = await fakeServer({ execute: REAL_DEVICE })
    const adapter = adapterFor()

    await adapter.setup(onFarm(server))
    const result = await adapter.execute(act({ type: 'pressButton', button: 'home' }))

    expect(result.success).toBe(true)
    expect(adapter.placeEvidence).toMatchObject({
      deviceType: 'real device',
      notes: [APP_DATA_NOTE],
    })
  })

  it('adds no note when the app state is preserved', async () => {
    const server = await fakeServer({ execute: REAL_DEVICE })
    const adapter = adapterFor()

    await adapter.setup(onFarm(server, { appState: 'preserve' }))

    expect(adapter.placeEvidence).not.toHaveProperty('notes')
  })

  it('adds no note when the target has an app.ref to reinstall from', async () => {
    const server = await fakeServer({ execute: REAL_DEVICE })
    const adapter = adapterFor()

    await adapter.setup(onFarm(server, { appRef: 'shop-latest' }))

    expect(adapter.placeEvidence).not.toHaveProperty('notes')
  })

  it('adds no note on a simulator', async () => {
    const server = await fakeServer({ execute: SIMULATOR })
    const adapter = adapterFor()

    await adapter.setup(onFarm(server))

    expect(adapter.placeEvidence).toMatchObject({ deviceType: 'simulator' })
    expect(adapter.placeEvidence).not.toHaveProperty('notes')
  })
})
