import { afterEach, describe, expect, it } from 'vitest'
import { browserStackFailureKind } from '../browserstack-api.js'
import {
  APP_SESSION_ROUTE,
  MARK_ROUTE,
  startFakeBrowserStackApi,
  type FakeBrowserStackApi,
  type FakeBrowserStackApiInput,
} from './fake-browserstack-api.js'
import {
  ACCESS_KEY,
  initializePlugin,
  loopbackOptions,
  RUN_ID,
  startPluginProcess,
  TEST_NAME,
  USERNAME,
  type PluginProcess,
  type RpcAnswer,
} from './plugin-process.js'

const SESSION_ID = 'a1b2c3d4e5f6'
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${ACCESS_KEY}`).toString('base64')}`

interface DeviceResult {
  handle: Record<string, unknown>
  protocol: string
  url: string
  capabilities: { 'bstack:options': Record<string, unknown> }
  mask: string[]
}

const fakes: FakeBrowserStackApi[] = []
const plugins: PluginProcess[] = []

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.close()))
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

async function browserStack(input?: FakeBrowserStackApiInput) {
  const api = await startFakeBrowserStackApi(input)
  fakes.push(api)
  const plugin = startPluginProcess()
  plugins.push(plugin)
  expect((await initializePlugin(plugin, loopbackOptions(api.url))).error).toBeUndefined()
  return { api, plugin }
}

async function acquireDevice(
  plugin: PluginProcess,
  input: {
    platform?: 'android' | 'ios'
    settings?: Record<string, unknown>
    capabilities?: Record<string, unknown>
  } = {},
): Promise<DeviceResult> {
  const answer = await plugin.call('acquire', {
    remote: 'browserstack-devices',
    settings: input.settings ?? {},
    session: {
      platform: input.platform ?? 'android',
      capabilities: input.capabilities ?? { 'appium:deviceName': 'Google Pixel 9' },
    },
    run: { testName: TEST_NAME },
  })
  expect(answer.error).toBeUndefined()
  return answer.result as DeviceResult
}

function resultOf(answer: RpcAnswer): Record<string, unknown> {
  expect(answer.error).toBeUndefined()
  return answer.result as Record<string, unknown>
}

describe('a BrowserStack device acquire', () => {
  it("answers the hub with bstack:options carrying the credentials, Appium 3.5.2, the project, the run id and the test's name", async () => {
    const { api, plugin } = await browserStack()

    const answer = await acquireDevice(plugin)

    expect(answer.protocol).toBe('appium')
    expect(answer.url).toBe(`${api.url}/wd/hub`)
    expect(answer.capabilities).toEqual({
      'bstack:options': {
        userName: USERNAME,
        accessKey: ACCESS_KEY,
        appiumVersion: '3.5.2',
        projectName: 'agent-qa',
        buildName: RUN_ID,
        sessionName: TEST_NAME,
      },
    })
    expect(answer.mask).toEqual([])
    expect(answer.handle).toMatchObject({ kind: 'device', platform: 'android', name: TEST_NAME })
    expect(new URL(answer.url).username).toBe('')
  })

  it('answers an iOS device the same way', async () => {
    const { plugin } = await browserStack()

    const answer = await acquireDevice(plugin, { platform: 'ios' })

    expect(answer.handle).toMatchObject({ kind: 'device', platform: 'ios' })
    expect(answer.capabilities['bstack:options']).toMatchObject({ appiumVersion: '3.5.2' })
  })

  it('lets settings override the Appium version, the project and the build, with extra merged last', async () => {
    const { plugin } = await browserStack()

    const answer = await acquireDevice(plugin, {
      settings: {
        appiumVersion: '2.19.0',
        project: 'shop',
        build: 'nightly',
        extra: { idleTimeout: 300, projectName: 'shop-devices' },
      },
    })

    expect(answer.capabilities['bstack:options']).toEqual({
      userName: USERNAME,
      accessKey: ACCESS_KEY,
      appiumVersion: '2.19.0',
      projectName: 'shop-devices',
      buildName: 'nightly',
      sessionName: TEST_NAME,
      idleTimeout: 300,
    })
  })

  it("asks for the device's own Appium version over the setting and the default", async () => {
    const { plugin } = await browserStack()

    const answer = await acquireDevice(plugin, {
      settings: { appiumVersion: '2.19.0' },
      capabilities: { 'bstack:options': { appiumVersion: '3.3.0' } },
    })

    expect(answer.capabilities['bstack:options']).toMatchObject({ appiumVersion: '3.3.0' })
  })

  it('refuses an Appium version setting that is not a string, at its path', async () => {
    const { plugin } = await browserStack()

    const answer = await plugin.call('acquire', {
      remote: 'browserstack-devices',
      settings: { appiumVersion: 3 },
      session: { platform: 'android', capabilities: {} },
    })

    expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'settings.appiumVersion' })
  })
})

describe('started for a BrowserStack device session', () => {
  it('reads the App Automate session and returns its dashboard link and the Appium version it asked for', async () => {
    const { api, plugin } = await browserStack()
    const { handle } = await acquireDevice(plugin)

    const started = resultOf(await plugin.call('started', { handle, sessionId: SESSION_ID }))

    expect(started).toEqual({ link: api.dashboardLink(SESSION_ID), appiumVersion: '3.5.2' })
    const reads = api.routeCalls(APP_SESSION_ROUTE)
    expect(reads.map((request) => request.path)).toEqual([
      `/app-automate/sessions/${SESSION_ID}.json`,
    ])
    expect(reads[0]?.headers.authorization).toBe(BASIC)
  })

  it('never returns the shareable public link', async () => {
    const { api, plugin } = await browserStack()
    const { handle } = await acquireDevice(plugin)

    const started = resultOf(await plugin.call('started', { handle, sessionId: SESSION_ID }))

    expect(JSON.stringify(started)).not.toContain(api.publicLink(SESSION_ID))
    expect(JSON.stringify(started)).not.toContain('public')
  })

  it("returns the device's own Appium version when it asked for that one", async () => {
    const { plugin } = await browserStack()
    const { handle } = await acquireDevice(plugin, {
      capabilities: { 'bstack:options': { appiumVersion: '3.3.0' } },
    })

    const started = resultOf(await plugin.call('started', { handle, sessionId: SESSION_ID }))

    expect(started.appiumVersion).toBe('3.3.0')
  })

  it('returns the Appium version and no link when the session cannot be read, with one stderr line', async () => {
    const { api, plugin } = await browserStack({
      routes: { [APP_SESSION_ROUTE]: [{ status: 500, json: { error: 'internal error' } }] },
    })
    const { handle } = await acquireDevice(plugin)

    const started = resultOf(await plugin.call('started', { handle, sessionId: SESSION_ID }))

    expect(started).toEqual({ appiumVersion: '3.5.2' })
    expect(api.routeCalls(APP_SESSION_ROUTE)).toHaveLength(1)
    const lines = plugin.stderr().trim().split('\n')
    expect(lines).toEqual([
      `BrowserStack: could not read App Automate session ${SESSION_ID}: BrowserStack answered 500 to GET /app-automate/sessions/{id}.json: internal error`,
    ])
    expect(plugin.stderr()).not.toContain(ACCESS_KEY)
  })

  it('reads nothing without a session id', async () => {
    const { api, plugin } = await browserStack()
    const { handle } = await acquireDevice(plugin)

    const started = resultOf(await plugin.call('started', { handle }))

    expect(started).toEqual({ appiumVersion: '3.5.2' })
    expect(api.routeCalls(APP_SESSION_ROUTE)).toEqual([])
  })
})

describe('end for a BrowserStack device session', () => {
  async function startedDevice(input?: FakeBrowserStackApiInput) {
    const context = await browserStack(input)
    const { handle } = await acquireDevice(context.plugin)
    resultOf(await context.plugin.call('started', { handle, sessionId: SESSION_ID }))
    return { ...context, handle }
  }

  it('marks a passed test passed', async () => {
    const { api, plugin, handle } = await startedDevice()

    resultOf(await plugin.call('end', { handle, outcome: 'passed' }))

    expect(api.marks()).toEqual([{ sessionId: SESSION_ID, body: { status: 'passed' } }])
    expect(api.routeCalls(MARK_ROUTE)[0]?.headers.authorization).toBe(BASIC)
  })

  it('marks a failed test failed with its reason', async () => {
    const { api, plugin, handle } = await startedDevice()

    resultOf(
      await plugin.call('end', { handle, outcome: 'failed', reason: 'the cart was empty' }),
    )

    expect(api.marks()).toEqual([
      { sessionId: SESSION_ID, body: { status: 'failed', reason: 'the cart was empty' } },
    ])
  })

  it("marks agent-qa's own error failed with agent-qa's sentence", async () => {
    const { api, plugin, handle } = await startedDevice()
    const sentence = 'agent-qa could not reach the device after it started.'

    resultOf(await plugin.call('end', { handle, outcome: 'error', reason: sentence }))

    expect(api.marks()).toEqual([
      { sessionId: SESSION_ID, body: { status: 'failed', reason: sentence } },
    ])
  })

  it('cuts the reason to 255 characters', async () => {
    const { api, plugin, handle } = await startedDevice()

    resultOf(await plugin.call('end', { handle, outcome: 'failed', reason: 'x'.repeat(400) }))

    expect(api.marks()).toEqual([
      { sessionId: SESSION_ID, body: { status: 'failed', reason: 'x'.repeat(255) } },
    ])
  })

  it('leaves a cancelled test unmarked', async () => {
    const { api, plugin, handle } = await startedDevice()

    resultOf(await plugin.call('end', { handle, outcome: 'cancelled' }))

    expect(api.routeCalls(MARK_ROUTE)).toEqual([])
  })

  it('marks nothing for a session that never started', async () => {
    const { api, plugin } = await browserStack()
    const { handle } = await acquireDevice(plugin)

    resultOf(await plugin.call('end', { handle, outcome: 'passed' }))

    expect(api.routeCalls(MARK_ROUTE)).toEqual([])
  })

  it('answers end when the mark fails, and writes one stderr line without the access key', async () => {
    const { api, plugin, handle } = await startedDevice({
      routes: { [MARK_ROUTE]: [{ status: 401, json: { message: 'Unauthorized' } }] },
    })

    expect((await plugin.call('end', { handle, outcome: 'passed' })).error).toBeUndefined()

    expect(api.routeCalls(MARK_ROUTE)).toHaveLength(1)
    expect(plugin.stderr().trim().split('\n')).toEqual([
      `BrowserStack: could not mark App Automate session ${SESSION_ID} passed: BrowserStack answered 401 to PUT /app-automate/sessions/{id}.json: Unauthorized`,
    ])
    expect(plugin.stderr()).not.toContain(ACCESS_KEY)
  })

  it('forgets the session when its handle is released', async () => {
    const { api, plugin, handle } = await startedDevice()

    resultOf(await plugin.call('release', { handle }))
    resultOf(await plugin.call('end', { handle, outcome: 'passed' }))

    expect(api.routeCalls(MARK_ROUTE)).toEqual([])
  })
})

describe('BrowserStack failure kinds', () => {
  it('reads 401 as auth, 429 as capacity, no answer as unreachable and anything else as refused', () => {
    expect(browserStackFailureKind(401)).toBe('auth')
    expect(browserStackFailureKind(429)).toBe('capacity')
    expect(browserStackFailureKind(undefined)).toBe('unreachable')
    expect(browserStackFailureKind(500)).toBe('refused')
    expect(browserStackFailureKind(403)).toBe('refused')
  })
})
