import {
  createRemoteRefusalMemory,
  RemoteRefusalError,
  SecretRedactor,
  SecretStore,
} from '@vostride/agent-qa-runner'
import type {
  PlatformConfig,
  RemoteDeviceConfig,
  RemoteFailureKind,
  RemoteRefusalMemory,
} from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AndroidPlatformAdapter } from '../adapter.js'
import type { AndroidAdapterConfig } from '../types.js'
import { startFakeAppiumServer } from './fixtures/fake-appium-server.js'
import type { FakeAppiumOptions, FakeAppiumServer } from './fixtures/fake-appium-server.js'

const TOKEN = 'farm-token-mark'
const PASSWORD = 'farm-password-mark'
const SECRETS_FILE = '.env.secrets.local'
const USER_MARK = 'farm-user-mark'
const KEY_MARK = 'farm-key-mark'
const PATH_MARK = 'path-token-mark'
const QUERY_MARK = 'query-secret-mark'
const BODY_MARK = 'response-body-mark'
const LEAK_MARKS = [TOKEN, USER_MARK, KEY_MARK, PATH_MARK, QUERY_MARK, BODY_MARK]
const connectionSecrets = new SecretStore({
  FARM_TOKEN: TOKEN,
  FARM_PASSWORD: PASSWORD,
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
  const server = await startFakeAppiumServer(options)
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
    url: server.url,
    headers: { 'x-farm-token': '{{secret:FARM_TOKEN}}' },
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
  } = { model: 'Samsung Galaxy S24', os: '14' },
  extra: Partial<AndroidAdapterConfig> = {},
): AndroidAdapterConfig {
  return {
    platform: 'android',
    targetName: 'shop-android',
    appPackage: 'com.example.shop',
    appState: 'preserve',
    ...extra,
    device: { name: 'galaxy-farm', platform: 'android', ...device, remote },
  }
}

function adapterFor(refusalMemory?: RemoteRefusalMemory): AndroidPlatformAdapter {
  const adapter = new AndroidPlatformAdapter({
    connectionSecrets,
    secretsFile: SECRETS_FILE,
    mask,
    ...(refusalMemory !== undefined ? { refusalMemory } : {}),
  })
  teardowns.push(() => adapter.cleanup())
  return adapter
}

function newSessionRequests(server: FakeAppiumServer) {
  return server.requests.filter(
    (request) => request.method === 'POST' && request.path.endsWith('/session'),
  )
}

// The url carries a path token and a query mark; basicAuth and a header carry declared secrets.
function leakyFarmAt(
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

async function leakyServer(options: FakeAppiumOptions = {}): Promise<FakeAppiumServer> {
  return fakeServer({ basePath: `/wd/hub/${PATH_MARK}`, ...options })
}

async function refusalOf(
  config: PlatformConfig,
  refusalMemory?: RemoteRefusalMemory,
): Promise<RemoteRefusalError> {
  const adapter = adapterFor(refusalMemory)
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

function labelOf(server: FakeAppiumServer): string {
  return `farm (appium ${server.origin})`
}

function alwaysMatch(server: FakeAppiumServer): Record<string, unknown> {
  const [request] = newSessionRequests(server)
  const body = request?.body as { capabilities?: { alwaysMatch?: Record<string, unknown> } }
  return body.capabilities?.alwaysMatch ?? {}
}

describe('a remote Android device', () => {
  it('opens its session at the remote path with the resolved header on every request and no Authorization', async () => {
    const server = await fakeServer({ requireHeader: ['x-farm-token', TOKEN] })
    const adapter = adapterFor()

    await adapter.setup(deviceOn(farmAt(server)))
    await adapter.cleanup()

    expect(server.sessionsCreated()).toHaveLength(1)
    expect(server.requests.length).toBeGreaterThan(1)
    for (const request of server.requests) {
      expect(request.path.startsWith('/wd/hub/')).toBe(true)
      expect(request.headers['x-farm-token']).toBe(TOKEN)
      expect(request.headers.authorization).toBeUndefined()
    }
  })

  it('sends basicAuth as a Basic Authorization header on every request', async () => {
    const server = await fakeServer()
    const adapter = adapterFor()
    const remote = farmAt(server, {
      headers: {},
      basicAuth: { user: 'agent', password: '{{secret:FARM_PASSWORD}}' },
    })

    await adapter.setup(deviceOn(remote))
    await adapter.cleanup()

    const basic = `Basic ${Buffer.from(`agent:${PASSWORD}`, 'utf8').toString('base64')}`
    expect(server.requests.length).toBeGreaterThan(1)
    for (const request of server.requests) expect(request.headers.authorization).toBe(basic)
  })

  it('asks for the model as deviceName and os as platformVersion, with none of the local-only capabilities', async () => {
    const server = await fakeServer()
    const adapter = adapterFor()

    await adapter.setup(deviceOn(farmAt(server)))

    const capabilities = alwaysMatch(server)
    expect(capabilities).toMatchObject({
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:deviceName': 'Samsung Galaxy S24',
      'appium:platformVersion': '14',
      'appium:newCommandTimeout': 90,
      'appium:appPackage': 'com.example.shop',
      'appium:noReset': true,
    })
    expect(capabilities).not.toHaveProperty('appium:udid')
    expect(capabilities).not.toHaveProperty('appium:avd')
    expect(capabilities).not.toHaveProperty('appium:chromedriverAutodownload')
  })

  it('sends no deviceName when the device has no model', async () => {
    const server = await fakeServer()
    const adapter = adapterFor()

    await adapter.setup(deviceOn(farmAt(server), {}))

    const capabilities = alwaysMatch(server)
    expect(capabilities).not.toHaveProperty('appium:deviceName')
    expect(capabilities).not.toHaveProperty('appium:platformVersion')
  })

  it('keeps every later request on the remote when the session reply asks to connect elsewhere', async () => {
    const decoy = await fakeServer()
    const server = await fakeServer({
      sessionCapabilities: {
        'appium:directConnectProtocol': 'http',
        'appium:directConnectHost': '127.0.0.1',
        'appium:directConnectPort': Number(new URL(decoy.origin).port),
        'appium:directConnectPath': '/wd/hub',
      },
    })
    const adapter = adapterFor()

    await adapter.setup(deviceOn(farmAt(server)))
    await adapter.cleanup()

    expect(decoy.requests).toHaveLength(0)
    const [sessionId] = server.sessionsCreated()
    expect(server.sessionsDeleted()).toEqual([sessionId])
    const onSession = server.requests.filter((request) =>
      request.path.includes(`/session/${String(sessionId)}`),
    )
    expect(onSession.length).toBeGreaterThan(1)
  })

  it('deletes its session on cleanup and leaves the server running', async () => {
    const server = await fakeServer()
    const adapter = adapterFor()

    await adapter.setup(deviceOn(farmAt(server)))
    const [sessionId] = server.sessionsCreated()
    await adapter.cleanup()

    expect(
      server.requests.some(
        (request) => request.method === 'DELETE' && request.path === `/wd/hub/session/${sessionId}`,
      ),
    ).toBe(true)
    const status = await fetch(`${server.url}/status`)
    expect(status.ok).toBe(true)
  })
})

describe("a remote Android device's refused session", () => {
  it('names the secrets to check when the server refuses the credentials', async () => {
    const server = await leakyServer({
      newSession: [
        {
          status: 401,
          json: {
            value: { error: 'session not created', message: `bad key ${KEY_MARK}`, stacktrace: '' },
          },
        },
      ],
    })

    const error = await refusalOf(deviceOn(leakyFarmAt(server)))

    expectRefusal(
      error,
      'auth',
      `Remote ${labelOf(server)} refused the credentials for device galaxy-farm. Check FARM_TOKEN, FARM_USER and FARM_KEY in ${SECRETS_FILE}.`,
    )
    expect(newSessionRequests(server)).toHaveLength(1)
  })

  it('says the remote has no free device when it answers 429', async () => {
    const server = await leakyServer({
      newSession: [
        {
          status: 429,
          json: { value: { error: 'unknown error', message: `busy ${BODY_MARK}`, stacktrace: '' } },
        },
      ],
    })

    const error = await refusalOf(deviceOn(leakyFarmAt(server)))

    expectRefusal(
      error,
      'capacity',
      `Remote ${labelOf(server)} has no free device for galaxy-farm. Lower use.workers or raise the service's limit.`,
    )
    expect(newSessionRequests(server)).toHaveLength(1)
  })

  it("follows a refused session with the server's first line, masked and shown by origin", async () => {
    const server = await leakyServer()
    const reason =
      `No device matches appium:deviceName "Samsung Galaxy S25" for ${TOKEN} at ` +
      `${server.origin}/wd/hub/${PATH_MARK}/session?token=${QUERY_MARK}\n${BODY_MARK}`
    const refusing = await leakyServer({
      newSession: [
        { status: 500, json: { value: { error: 'session not created', message: reason } } },
      ],
    })

    const error = await refusalOf(deviceOn(leakyFarmAt(refusing)))

    expectRefusal(
      error,
      'refused',
      `Remote ${labelOf(refusing)} refused a session for device galaxy-farm: No device matches appium:deviceName "Samsung Galaxy S25" for [secret:FARM_TOKEN] at ${server.origin}.`,
    )
    expect(newSessionRequests(refusing)).toHaveLength(1)
  })

  it('shows the first line of a refusal that is not JSON', async () => {
    const server = await leakyServer({
      newSession: [{ status: 401, text: `Unauthorized: unknown farm user\n${BODY_MARK}` }],
    })

    const error = await refusalOf(deviceOn(leakyFarmAt(server)))

    expectRefusal(
      error,
      'refused',
      `Remote ${labelOf(server)} refused a session for device galaxy-farm: Unauthorized: unknown farm user.`,
    )
    expect(newSessionRequests(server)).toHaveLength(1)
  })

  it('says the remote did not answer when nothing listens on its port', async () => {
    const closed = await startFakeAppiumServer({ basePath: `/wd/hub/${PATH_MARK}` })
    await closed.close()

    const error = await refusalOf(deviceOn(leakyFarmAt(closed)))

    expectRefusal(
      error,
      'unreachable',
      `Remote ${labelOf(closed)} did not answer for device galaxy-farm. Check its url and that the server is running.`,
    )
  })

  it('names the connect timeout when the new session is never answered', async () => {
    const server = await leakyServer({ newSession: ['hold'] })

    const error = await refusalOf(deviceOn(leakyFarmAt(server, { connectTimeoutMs: 500 })))

    expectRefusal(
      error,
      'timeout',
      `Remote ${labelOf(server)} did not open a session for device galaxy-farm within 500ms. Raise its connectTimeout or check the service.`,
    )
    expect(newSessionRequests(server)).toHaveLength(1)
  })

  it('is not asked again in the run once it refused the credentials', async () => {
    const server = await leakyServer({
      newSession: [
        { status: 401, json: { value: { error: 'session not created', message: 'no' } } },
      ],
    })
    const memory = createRemoteRefusalMemory()
    const first = await refusalOf(deviceOn(leakyFarmAt(server)), memory)
    const sent = server.requests.length

    const second = await refusalOf(
      deviceOn(leakyFarmAt(server), { name: 'pixel-farm', model: 'Pixel 9' }),
      memory,
    )

    expect(server.requests).toHaveLength(sent)
    expect(second.message).toBe(first.message)
    expect(second.kind).toBe('auth')
  })

  it('remembers a refused session for that device only', async () => {
    const server = await leakyServer({
      newSession: [
        { status: 500, json: { value: { error: 'session not created', message: 'no match' } } },
      ],
    })
    const memory = createRemoteRefusalMemory()
    await refusalOf(deviceOn(leakyFarmAt(server)), memory)

    const again = await refusalOf(deviceOn(leakyFarmAt(server)), memory)
    expect(again.kind).toBe('refused')
    expect(newSessionRequests(server)).toHaveLength(1)

    const other = adapterFor(memory)
    await other.setup(deviceOn(leakyFarmAt(server), { name: 'pixel-farm', model: 'Pixel 9' }))
    expect(newSessionRequests(server)).toHaveLength(2)
    expect(server.sessionsCreated()).toHaveLength(1)
  })

  it('is refused before any request while WDIO_LOG_LEVEL turns on WebdriverIO logging', async () => {
    const server = await leakyServer()
    vi.stubEnv('WDIO_LOG_LEVEL', 'info')

    const error = await refusalOf(deviceOn(leakyFarmAt(server)))

    expectRefusal(
      error,
      undefined,
      "WDIO_LOG_LEVEL turns on WebdriverIO's own logging, which would print remote farm's address and requests. Unset WDIO_LOG_LEVEL to run device galaxy-farm.",
    )
    expect(server.requests).toHaveLength(0)
  })

  it('is refused before any request while NODE_DEBUG names undici', async () => {
    const server = await leakyServer()
    vi.stubEnv('NODE_DEBUG', 'undici')

    const error = await refusalOf(deviceOn(leakyFarmAt(server)))

    expectRefusal(
      error,
      undefined,
      "NODE_DEBUG names undici, which prints remote farm's request paths. Remove undici and fetch from NODE_DEBUG to run device galaxy-farm.",
    )
    expect(server.requests).toHaveLength(0)
  })
})

describe("a remote Android device's capabilities and app", () => {
  it("sends the target's app.ref as appium:app", async () => {
    const server = await fakeServer()

    await adapterFor().setup(
      deviceOn(farmAt(server), undefined, { appRef: 'shop-latest', appPath: 'builds/shop.apk' }),
    )

    expect(alwaysMatch(server)['appium:app']).toBe('shop-latest')
  })

  it("lets the device's appium:app win over the target's app.ref", async () => {
    const server = await fakeServer()

    await adapterFor().setup(
      deviceOn(
        farmAt(server),
        { model: 'Samsung Galaxy S24', capabilities: { 'appium:app': 'farm://shop-build-7' } },
        { appRef: 'shop-latest' },
      ),
    )

    expect(alwaysMatch(server)['appium:app']).toBe('farm://shop-build-7')
  })

  it('refuses a target with only app.path before any request', async () => {
    const server = await fakeServer()

    const error = await refusalOf(
      deviceOn(farmAt(server), undefined, { appPath: 'builds/shop.apk' }),
    )

    expectRefusal(
      error,
      undefined,
      'Device galaxy-farm runs on remote farm, and target shop-android has only app.path. Set app.ref to the app the server installs.',
    )
    expect(server.requests).toHaveLength(0)
  })

  it("merges what agent-qa derives, then the remote's capabilities, then the device's", async () => {
    const server = await fakeServer()
    const remote = farmAt(server, {
      capabilities: {
        'appium:automationName': 'Espresso',
        'farm:options': { region: 'eu', build: 'nightly' },
      },
    })

    await adapterFor().setup(
      deviceOn(remote, {
        model: 'Samsung Galaxy S24',
        id: 'R58M41ABCDE',
        capabilities: { 'farm:options': { build: 'release' } },
      }),
    )

    expect(alwaysMatch(server)).toMatchObject({
      platformName: 'Android',
      'appium:automationName': 'Espresso',
      'appium:deviceName': 'Samsung Galaxy S24',
      'appium:udid': 'R58M41ABCDE',
      'farm:options': { region: 'eu', build: 'release' },
    })
  })

  it('removes a derived capability the device sets to null', async () => {
    const server = await fakeServer()

    await adapterFor().setup(
      deviceOn(farmAt(server), {
        model: 'Samsung Galaxy S24',
        capabilities: { 'appium:newCommandTimeout': null },
      }),
    )

    expect(alwaysMatch(server)).not.toHaveProperty('appium:newCommandTimeout')
  })

  it('keeps the session on WebDriver classic in browser mode', async () => {
    const server = await fakeServer()

    await adapterFor().setup(deviceOn(farmAt(server), undefined, { browserName: 'chrome' }))

    expect(alwaysMatch(server)).toMatchObject({
      browserName: 'chrome',
      'appium:autoWebview': true,
      'wdio:enforceWebDriverClassic': true,
    })
    expect(alwaysMatch(server)).not.toHaveProperty('appium:appPackage')
  })

  it.each([
    ['device', { model: 'Samsung Galaxy S24', capabilities: { browserName: 'chrome' } }, {}],
    ['remote', { model: 'Samsung Galaxy S24' }, { capabilities: { browserName: 'chrome' } }],
  ] as const)(
    "runs in browser mode on WebDriver classic when the %s's capabilities name a browser",
    async (_place, device, remoteExtra) => {
      const server = await fakeServer()

      await adapterFor().setup(
        deviceOn(farmAt(server, remoteExtra), device, { appPath: 'builds/shop.apk' }),
      )

      const capabilities = alwaysMatch(server)
      expect(capabilities).toMatchObject({
        browserName: 'chrome',
        'appium:autoWebview': true,
        'wdio:enforceWebDriverClassic': true,
      })
      expect(capabilities).not.toHaveProperty('appium:app')
      expect(capabilities).not.toHaveProperty('appium:appPackage')
      expect(capabilities).not.toHaveProperty('appium:noReset')
      expect(capabilities).not.toHaveProperty('webSocketUrl')
    },
  )

  it('resolves a secret in the capabilities for the server and never shows it in a refusal', async () => {
    const server = await fakeServer({
      newSession: [
        {
          status: 500,
          json: { value: { error: 'session not created', message: `key ${KEY_MARK} expired` } },
        },
      ],
    })
    const config = deviceOn(farmAt(server), {
      model: 'Samsung Galaxy S24',
      capabilities: { 'farm:options': { accessKey: '{{secret:FARM_KEY}}' } },
    })

    const error = await refusalOf(config)

    expect(alwaysMatch(server)['farm:options']).toEqual({ accessKey: KEY_MARK })
    expectRefusal(
      error,
      'refused',
      `Remote ${labelOf(server)} refused a session for device galaxy-farm: key [secret:FARM_KEY] expired.`,
    )
  })

  it('refuses a capability secret the secrets file does not declare', async () => {
    const server = await fakeServer()

    const error = await refusalOf(
      deviceOn(farmAt(server), {
        model: 'Samsung Galaxy S24',
        capabilities: { 'farm:options': { accessKey: '{{secret:FARM_OTHER_KEY}}' } },
      }),
    )

    expectRefusal(
      error,
      undefined,
      `Device galaxy-farm on remote ${labelOf(server)} needs FARM_OTHER_KEY, which ${SECRETS_FILE} does not declare. Add it there.`,
    )
    expect(server.requests).toHaveLength(0)
  })
})

describe("a device here's capability secrets", () => {
  function deviceHere(server: FakeAppiumServer, password: string): AndroidAdapterConfig {
    return {
      platform: 'android',
      targetName: 'shop-android',
      appPackage: 'com.example.shop',
      appState: 'preserve',
      appiumUrl: server.url,
      device: {
        name: 'keyed-phone',
        platform: 'android',
        model: 'Pixel 9',
        capabilities: { 'appium:keystorePassword': password },
      },
    }
  }

  it('resolves a secret reference for its own Appium', async () => {
    const server = await fakeServer()

    await adapterFor().setup(deviceHere(server, '{{secret:FARM_KEY}}'))

    expect(alwaysMatch(server)['appium:keystorePassword']).toBe(KEY_MARK)
  })

  it('refuses a secret the secrets file does not declare before any request', async () => {
    const server = await fakeServer()

    const error = await refusalOf(deviceHere(server, '{{secret:KEYSTORE_PASSWORD}}'))

    expectRefusal(
      error,
      undefined,
      `Device keyed-phone needs KEYSTORE_PASSWORD, which ${SECRETS_FILE} does not declare. Add it there.`,
    )
    expect(server.requests).toHaveLength(0)
  })
})
