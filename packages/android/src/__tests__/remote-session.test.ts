import { SecretStore } from '@vostride/agent-qa-runner'
import type { PlatformConfig, RemoteDeviceConfig } from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it } from 'vitest'

import { AndroidPlatformAdapter } from '../adapter.js'
import { startFakeAppiumServer } from './fixtures/fake-appium-server.js'
import type { FakeAppiumOptions, FakeAppiumServer } from './fixtures/fake-appium-server.js'

const TOKEN = 'farm-token-mark'
const PASSWORD = 'farm-password-mark'
const SECRETS_FILE = '.env.secrets.local'
const connectionSecrets = new SecretStore({ FARM_TOKEN: TOKEN, FARM_PASSWORD: PASSWORD })

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
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
  device: { model?: string; os?: string } = { model: 'Samsung Galaxy S24', os: '14' },
): PlatformConfig {
  return {
    platform: 'android',
    appPackage: 'com.example.shop',
    appState: 'preserve',
    device: { name: 'galaxy-farm', platform: 'android', ...device, remote, match: {} },
  }
}

function adapterFor(): AndroidPlatformAdapter {
  const adapter = new AndroidPlatformAdapter({ connectionSecrets, secretsFile: SECRETS_FILE })
  teardowns.push(() => adapter.cleanup())
  return adapter
}

function newSessionRequests(server: FakeAppiumServer) {
  return server.requests.filter(
    (request) => request.method === 'POST' && request.path === '/wd/hub/session',
  )
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

  it('asks for a refused new session once and fails setup', async () => {
    const server = await fakeServer({
      newSession: [
        {
          status: 500,
          json: {
            value: { error: 'session not created', message: 'No device matches', stacktrace: '' },
          },
        },
      ],
    })
    const adapter = adapterFor()

    await expect(adapter.setup(deviceOn(farmAt(server)))).rejects.toThrow()

    expect(newSessionRequests(server)).toHaveLength(1)
    expect(server.sessionsCreated()).toHaveLength(0)
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
