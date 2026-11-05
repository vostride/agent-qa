import {
  createRemoteRefusalMemory,
  createRemoteSessionRegistry,
  REMOTE_RELEASE_BOUND_MS,
  RemoteRefusalError,
  SecretRedactor,
  SecretStore,
} from '@vostride/agent-qa-runner'
import type {
  ActionsFor,
  PlatformConfig,
  RemoteDeviceConfig,
  RemoteFailureKind,
  RemoteRefusalMemory,
  RemoteSessionRegistry,
} from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IOSPlatformAdapter } from '../adapter.js'
import type { IOSAdapterConfig, IOSAdapterOptions } from '../types.js'

interface FakeAppiumRequest {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
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

type NewSessionScript =
  | 'ok'
  | 'hold'
  | { readonly status: number; readonly json: unknown }
  | { readonly status: number; readonly text: string }

interface FakeAppiumOptions {
  readonly basePath?: string
  readonly requireHeader?: readonly [string, string]
  readonly newSession?: readonly NewSessionScript[]
  readonly status?: { readonly version?: string } | 'fail'
  readonly hold?: RegExp
  readonly execute?: Readonly<Record<string, unknown>>
  readonly releaseActions?: 'ok' | 'unknown command'
}

const { startFakeAppiumServer } = (await import(
  new URL('../../../android/src/__tests__/fixtures/fake-appium-server.js', import.meta.url).href
)) as { startFakeAppiumServer: (options?: FakeAppiumOptions) => Promise<FakeAppiumServer> }

const TOKEN = 'farm-token-mark'
const SECRETS_FILE = '.env.secrets.local'
const USER_MARK = 'farm-user-mark'
const KEY_MARK = 'farm-key-mark'
const PATH_MARK = 'path-token-mark'
const QUERY_MARK = 'query-secret-mark'
const LEAK_MARKS = [TOKEN, USER_MARK, KEY_MARK, PATH_MARK, QUERY_MARK]
const QUIET_HEARTBEAT_MS = 60_000
const connectionSecrets = new SecretStore({
  FARM_TOKEN: TOKEN,
  FARM_USER: USER_MARK,
  FARM_KEY: KEY_MARK,
})
const redactor = new SecretRedactor(connectionSecrets)
const mask = (text: string): string => redactor.redactString(text)

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

async function fakeServer(options: FakeAppiumOptions = {}): Promise<FakeAppiumServer> {
  const server = await startFakeAppiumServer({ basePath: `/wd/hub/${PATH_MARK}`, ...options })
  teardowns.push(() => server.close())
  return server
}

function farmAt(
  server: FakeAppiumServer,
  extra: Partial<RemoteDeviceConfig> = {},
): RemoteDeviceConfig {
  return {
    name: 'farm',
    protocol: 'appium',
    url: `${server.origin}/wd/hub/${PATH_MARK}?token=${QUERY_MARK}`,
    headers: { 'x-farm-token': '{{secret:FARM_TOKEN}}' },
    basicAuth: { user: '{{secret:FARM_USER}}', password: '{{secret:FARM_KEY}}' },
    connectTimeoutMs: 30_000,
    ...extra,
  }
}

function deviceOn(
  remote: RemoteDeviceConfig,
  device: {
    name?: string
    model?: string
    os?: string
    id?: string
    capabilities?: Record<string, unknown>
  } = { model: 'iPhone 16', os: '18.2' },
  extra: Partial<IOSAdapterConfig> = {},
): IOSAdapterConfig {
  return {
    platform: 'ios',
    targetName: 'shop-ios',
    bundleId: 'com.example.shop',
    appState: 'preserve',
    ...extra,
    device: { name: 'iphone-farm', platform: 'ios', ...device, remote, match: {} },
  }
}

function adapterFor(
  options: Omit<IOSAdapterOptions, 'connectionSecrets' | 'secretsFile' | 'mask'> = {},
): IOSPlatformAdapter {
  const adapter = new IOSPlatformAdapter({
    connectionSecrets,
    secretsFile: SECRETS_FILE,
    mask,
    timing: { heartbeatIntervalMs: QUIET_HEARTBEAT_MS },
    ...options,
  })
  teardowns.push(() => adapter.cleanup())
  return adapter
}

async function opened(
  server: FakeAppiumServer,
  timing: NonNullable<IOSAdapterOptions['timing']>,
  sessions?: RemoteSessionRegistry,
): Promise<IOSPlatformAdapter> {
  const adapter = adapterFor({ timing, ...(sessions !== undefined ? { sessions } : {}) })
  await adapter.setup(deviceOn(farmAt(server)))
  return adapter
}

async function refusalOf(
  config: PlatformConfig,
  refusalMemory?: RemoteRefusalMemory,
): Promise<RemoteRefusalError> {
  const adapter = adapterFor(refusalMemory !== undefined ? { refusalMemory } : {})
  try {
    await adapter.setup(config)
  } catch (error) {
    return error as RemoteRefusalError
  }
  throw new Error('setup opened a session the remote should refuse')
}

function expectRefusal(
  error: RemoteRefusalError,
  kind: RemoteFailureKind | undefined,
  sentence: string,
): void {
  expect(error).toBeInstanceOf(RemoteRefusalError)
  expect(error.kind).toBe(kind)
  expect(error.message).toBe(sentence)
  expect('cause' in error).toBe(false)
  const carried = [
    error.message,
    error.stack ?? '',
    String(error),
    ...Object.getOwnPropertyNames(error).map((key) =>
      String((error as unknown as Record<string, unknown>)[key]),
    ),
  ].join('\n')
  for (const mark of LEAK_MARKS) expect(carried).not.toContain(mark)
  expect(carried).not.toContain('/wd/hub')
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

function label(server: FakeAppiumServer): string {
  return `farm (appium ${server.origin})`
}

function sent(server: FakeAppiumServer, method: string, suffix: string): number {
  return server.requests.filter(
    (request) => request.method === method && request.path.endsWith(suffix),
  ).length
}

const TAP = { type: 'tapCoordinate', x: 100, y: 200, coordSpace: 'viewport' } as ActionsFor<'ios'>

describe('a remote iOS device', () => {
  it('asks for the model as deviceName and os as platformVersion, with no simulator defaults', async () => {
    const server = await fakeServer()

    await adapterFor().setup(deviceOn(farmAt(server)))

    const capabilities = alwaysMatch(server)
    expect(capabilities).toMatchObject({
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:deviceName': 'iPhone 16',
      'appium:platformVersion': '18.2',
      'appium:newCommandTimeout': 90,
      'appium:settings[snapshotMaxDepth]': 62,
      'appium:bundleId': 'com.example.shop',
      'appium:noReset': true,
    })
    expect(capabilities).not.toHaveProperty('appium:showIOSLog')
    expect(capabilities).not.toHaveProperty('appium:udid')
  })

  it('sends no deviceName at all when the device has no model', async () => {
    const server = await fakeServer()

    await adapterFor().setup(deviceOn(farmAt(server), {}))

    const capabilities = alwaysMatch(server)
    expect(capabilities).not.toHaveProperty('appium:deviceName')
    expect(capabilities).not.toHaveProperty('appium:platformVersion')
    expect(capabilities).not.toHaveProperty('appium:showIOSLog')
  })

  it('sends the device id as appium:udid', async () => {
    const server = await fakeServer()

    await adapterFor().setup(
      deviceOn(farmAt(server), { model: 'iPhone 16', id: '00008120-001A2B3C4D5E6F70' }),
    )

    expect(alwaysMatch(server)['appium:udid']).toBe('00008120-001A2B3C4D5E6F70')
  })

  it('opens at the remote path with the resolved header on every request', async () => {
    const server = await fakeServer({ requireHeader: ['x-farm-token', TOKEN] })
    const adapter = adapterFor()

    await adapter.setup(deviceOn(farmAt(server)))
    await adapter.cleanup()

    expect(server.sessionsCreated()).toHaveLength(1)
    expect(server.requests.length).toBeGreaterThan(1)
    for (const request of server.requests) {
      expect(request.path.startsWith(`/wd/hub/${PATH_MARK}/`)).toBe(true)
      expect(request.headers['x-farm-token']).toBe(TOKEN)
    }
  })

  it("sends the target's app.ref as appium:app, and the device's own appium:app over it", async () => {
    const server = await fakeServer()
    await adapterFor().setup(deviceOn(farmAt(server), undefined, { appRef: 'shop-latest' }))
    expect(alwaysMatch(server)['appium:app']).toBe('shop-latest')

    const other = await fakeServer()
    await adapterFor().setup(
      deviceOn(
        farmAt(other),
        { model: 'iPhone 16', capabilities: { 'appium:app': 'farm://shop-build-7' } },
        { appRef: 'shop-latest' },
      ),
    )
    expect(alwaysMatch(other)['appium:app']).toBe('farm://shop-build-7')
  })

  it("merges what agent-qa derives, then the remote's capabilities, then the device's", async () => {
    const server = await fakeServer()
    const remote = farmAt(server, {
      capabilities: { 'farm:options': { region: 'eu', build: 'nightly' } },
    })

    await adapterFor().setup(
      deviceOn(remote, {
        model: 'iPhone 16',
        capabilities: {
          'farm:options': { build: 'release' },
          'appium:newCommandTimeout': null,
        },
      }),
    )

    expect(alwaysMatch(server)).toMatchObject({
      'appium:deviceName': 'iPhone 16',
      'farm:options': { region: 'eu', build: 'release' },
    })
    expect(alwaysMatch(server)).not.toHaveProperty('appium:newCommandTimeout')
  })

  it('keeps a browser session on WebDriver classic and sends no app ids', async () => {
    const server = await fakeServer()

    await adapterFor().setup(
      deviceOn(farmAt(server), {
        model: 'iPhone 16',
        capabilities: { browserName: 'Safari' },
      }),
    )

    expect(alwaysMatch(server)).toMatchObject({
      browserName: 'Safari',
      'wdio:enforceWebDriverClassic': true,
    })
    expect(alwaysMatch(server)).not.toHaveProperty('appium:bundleId')
    expect(alwaysMatch(server)).not.toHaveProperty('appium:noReset')
  })
})

describe("a remote iOS device's refused session", () => {
  it('names the secrets to check when the server refuses the credentials, after one request', async () => {
    const server = await fakeServer({
      newSession: [
        {
          status: 401,
          json: {
            value: { error: 'session not created', message: `bad key ${KEY_MARK}`, stacktrace: '' },
          },
        },
      ],
    })

    const error = await refusalOf(deviceOn(farmAt(server)))

    expectRefusal(
      error,
      'auth',
      `Remote ${label(server)} refused the credentials for device iphone-farm. Check FARM_TOKEN, FARM_USER and FARM_KEY in ${SECRETS_FILE}.`,
    )
    expect(newSessionRequests(server)).toHaveLength(1)
  })

  it("follows a refused session with the server's first line, masked", async () => {
    const server = await fakeServer({
      newSession: [
        {
          status: 500,
          json: {
            value: {
              error: 'session not created',
              message: `No device matches appium:deviceName "iPhone 17" for ${TOKEN}\nmore`,
            },
          },
        },
      ],
    })

    const error = await refusalOf(deviceOn(farmAt(server)))

    expectRefusal(
      error,
      'refused',
      `Remote ${label(server)} refused a session for device iphone-farm: No device matches appium:deviceName "iPhone 17" for [secret:FARM_TOKEN].`,
    )
    expect(newSessionRequests(server)).toHaveLength(1)
  })

  it('is not asked again in the run once it refused the credentials', async () => {
    const server = await fakeServer({
      newSession: [
        { status: 401, json: { value: { error: 'session not created', message: 'no' } } },
      ],
    })
    const memory = createRemoteRefusalMemory()
    const first = await refusalOf(deviceOn(farmAt(server)), memory)
    const sentBefore = server.requests.length

    const second = await refusalOf(
      deviceOn(farmAt(server), { name: 'ipad-farm', model: 'iPad Air' }),
      memory,
    )

    expect(server.requests).toHaveLength(sentBefore)
    expect(second.message).toBe(first.message)
  })

  it('is refused before any request while WDIO_LOG_LEVEL turns on WebdriverIO logging', async () => {
    const server = await fakeServer()
    vi.stubEnv('WDIO_LOG_LEVEL', 'debug')

    const error = await refusalOf(deviceOn(farmAt(server)))

    expectRefusal(
      error,
      undefined,
      "WDIO_LOG_LEVEL turns on WebdriverIO's own logging, which would print remote farm's address and requests. Unset WDIO_LOG_LEVEL to run device iphone-farm.",
    )
    expect(server.requests).toHaveLength(0)
  })

  it('refuses a target with only app.path before any request', async () => {
    const server = await fakeServer()

    const error = await refusalOf(
      deviceOn(farmAt(server), undefined, { appPath: 'builds/shop.app' }),
    )

    expectRefusal(
      error,
      undefined,
      'Device iphone-farm runs on remote farm, and target shop-ios has only app.path. Set app.ref to the app the server installs.',
    )
    expect(server.requests).toHaveLength(0)
  })
})

describe("a remote iOS session's life", () => {
  it('ends the test as lost when a command goes unanswered past the command bound, sent once', async () => {
    const server = await fakeServer({ hold: /^POST .*\/actions$/ })
    const adapter = await opened(server, {
      commandBoundMs: 400,
      heartbeatIntervalMs: QUIET_HEARTBEAT_MS,
    })

    const result = await adapter.execute(TAP)

    const lost = `Remote ${label(server)} did not answer a command for device iphone-farm within 2m.`
    expect(result.success).toBe(false)
    expect(sent(server, 'POST', '/actions')).toBe(1)
    expect(adapter.isBrowserDisconnected).toBe(true)
    expect(adapter.disconnectSummary).toBe(lost)
    expect(adapter.placeEvidence).toMatchObject({ failureKind: 'lost' })

    const before = server.requests.length
    expect(await adapter.execute(TAP)).toEqual({ success: false, error: lost })
    await expect(adapter.observe()).rejects.toThrow(lost)
    expect(server.requests).toHaveLength(before)
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
    expect((await fetch(`${server.origin}/wd/hub/${PATH_MARK}/status`)).ok).toBe(true)

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
      device: 'iphone-farm',
      appiumVersion: '3.4.2',
      sessionId,
      deviceType: 'unknown',
      heartbeat: { sent: 0, failed: 0, suspect: false },
    })
  })

  it("names the remote by its label in a failed command's error, never its path", async () => {
    const server = await fakeServer({
      execute: {
        'mobile: pressButton': { status: 500, error: 'unknown error', message: 'button refused' },
      },
    })
    const adapter = await opened(server, { heartbeatIntervalMs: QUIET_HEARTBEAT_MS })

    const result = await adapter.execute({
      type: 'pressButton',
      button: 'home',
    } as ActionsFor<'ios'>)

    expect(result.success).toBe(false)
    expect(result.error).toContain('button refused')
    expect(result.error).not.toContain(PATH_MARK)
    expect(adapter.isBrowserDisconnected).toBe(false)
  })

  it('ends the test as ended when the server ends the session, and deletes nothing', async () => {
    const server = await fakeServer({
      execute: {
        'mobile: pressButton': {
          status: 404,
          error: 'invalid session id',
          message: 'A session is either terminated or not started',
        },
      },
    })
    const adapter = await opened(server, { heartbeatIntervalMs: QUIET_HEARTBEAT_MS })

    const result = await adapter.execute({
      type: 'pressButton',
      button: 'home',
    } as ActionsFor<'ios'>)

    expect(result.success).toBe(false)
    expect(adapter.disconnectSummary).toBe(
      `Remote ${label(server)} ended the session for device iphone-farm while this test ran.`,
    )
    await adapter.cleanup()
    expect(server.sessionsDeleted()).toEqual([])
  })
})
