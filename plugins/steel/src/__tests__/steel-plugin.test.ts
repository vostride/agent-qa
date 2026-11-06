import { afterEach, describe, expect, it } from 'vitest'
import {
  CREATE_ROUTE,
  RELEASE_ROUTE,
  startFakeSteelApi,
  type FakeSteelApi,
} from './fake-steel-api.js'
import { initializeSteel, spawnSteelPlugin, type SpawnedSteel } from './spawned-steel.js'

const API_KEY = 'steel-test-key'
const WEB_SESSION = { platform: 'web', engine: 'chromium', context: 'new' } as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const fakes: FakeSteelApi[] = []
const hosts: SpawnedSteel[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()))
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

async function startApi(input?: Parameters<typeof startFakeSteelApi>[0]) {
  const api = await startFakeSteelApi(input)
  fakes.push(api)
  return api
}

async function steelPlugin(api: FakeSteelApi) {
  const plugin = spawnSteelPlugin()
  hosts.push(plugin)
  const answer = await initializeSteel(plugin, { apiKey: API_KEY, apiUrl: api.url })
  expect(answer.error).toBeUndefined()
  return plugin
}

function acquire(
  plugin: SpawnedSteel,
  settings: Record<string, unknown> = {},
  session: Record<string, unknown> = WEB_SESSION,
) {
  return plugin.call('acquire', { remote: 'steel', settings, session })
}

function createBodies(api: FakeSteelApi) {
  return api.routeCalls(CREATE_ROUTE).map((request) => request.body)
}

describe('creating a Steel session', () => {
  it('sends its own session id, the longest lifetime, a five minute idle timeout and every page-changing feature off', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    expect((await acquire(plugin)).error).toBeUndefined()

    expect(createBodies(api)).toEqual([
      {
        sessionId: expect.stringMatching(UUID),
        timeout: 86_400_000,
        inactivityTimeout: 300_000,
        solveCaptcha: false,
        blockAds: false,
        useProxy: false,
        stealthConfig: { skipFingerprintInjection: true },
      },
    ])
    expect(api.routeCalls(CREATE_ROUTE)[0]?.headers['steel-api-key']).toBe(API_KEY)
  })

  it('answers cdp with the key in the connect url, masks it and the debug url, and links the session viewer', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin)

    const [id] = api.createdIds()
    const url = `wss://connect.example.invalid/?sessionId=${String(id)}&apiKey=${API_KEY}`
    expect(answer.result).toEqual({
      handle: { sessionId: id },
      protocol: 'cdp',
      url,
      mask: [url, `https://debug.example.invalid/sessions/${String(id)}/player`],
      link: `https://app.example.invalid/sessions/${String(id)}`,
    })
    expect(id).toBe((createBodies(api)[0] as { sessionId: string }).sessionId)
  })
})

describe('the Steel settings', () => {
  it('lowers the lifetime and the idle timeout', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    expect((await acquire(plugin, { timeoutMinutes: 60, idleMinutes: 10 })).error).toBeUndefined()

    expect(createBodies(api)[0]).toMatchObject({ timeout: 3_600_000, inactivityTimeout: 600_000 })
  })

  it.each([0, 1441])('refuses timeoutMinutes %i before any create', async (timeoutMinutes) => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin, { timeoutMinutes })

    expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'settings.timeoutMinutes' })
    expect(createBodies(api)).toEqual([])
  })

  it('turns each page-changing feature on when its setting is true', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    const settings = { solveCaptcha: true, blockAds: true, fingerprint: true, proxy: true }
    expect((await acquire(plugin, settings)).error).toBeUndefined()

    expect(createBodies(api)[0]).toMatchObject({
      solveCaptcha: true,
      blockAds: true,
      stealthConfig: { skipFingerprintInjection: false },
      useProxy: true,
    })
  })

  it("sends Steel's proxy object as useProxy", async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    expect((await acquire(plugin, { proxy: { geolocation: 'US' } })).error).toBeUndefined()

    expect(createBodies(api)[0]).toMatchObject({ useProxy: { geolocation: 'US' } })
  })

  it('merges extra last, so it overrides a curated setting and adds its own fields', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    const settings = { blockAds: false, extra: { blockAds: true, headless: true } }
    expect((await acquire(plugin, settings)).error).toBeUndefined()

    expect(createBodies(api)[0]).toMatchObject({ blockAds: true, headless: true })
  })

  it('sends proxyUrl instead of useProxy', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)
    const proxyUrl = 'http://user:password@proxy.example.invalid:8080'

    expect((await acquire(plugin, { proxyUrl })).error).toBeUndefined()

    const [body] = createBodies(api)
    expect(body).toMatchObject({ proxyUrl })
    expect(body).not.toHaveProperty('useProxy')
  })

  it('refuses proxyUrl together with proxy before any create, pointing at proxyUrl', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin, {
      proxyUrl: 'http://proxy.example.invalid:8080',
      proxy: true,
    })

    expect(answer.error?.message).toBe('proxy and proxyUrl both choose a proxy; set one of them.')
    expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'settings.proxyUrl' })
    expect(createBodies(api)).toEqual([])
  })

  it('sends the window size, the region and the extensions it is given', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    const settings = {
      dimensions: { width: 1280, height: 800 },
      region: 'us-east',
      extensions: ['ext-1'],
    }
    expect((await acquire(plugin, settings)).error).toBeUndefined()

    expect(createBodies(api)[0]).toMatchObject({
      dimensions: { width: 1280, height: 800 },
      region: 'us-east',
      extensionIds: ['ext-1'],
    })
  })

  it('loads a profile read-only into a reused context', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin, { profile: 'p-1' }, { ...WEB_SESSION, context: 'reuse' })
    expect(answer.error).toBeUndefined()

    const [body] = createBodies(api)
    expect(body).toMatchObject({ profileId: 'p-1' })
    expect(body).not.toHaveProperty('persistProfile')
  })

  it('refuses a profile for a new context before any create, pointing at profile', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin, { profile: 'p-1' })

    expect(answer.error?.message).toBe(
      'profile loads only into a reused context; set context: reuse on the remote.',
    )
    expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'settings.profile' })
    expect(createBodies(api)).toEqual([])
  })

  it('refuses a session that is not Chromium before any create', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin, {}, { ...WEB_SESSION, engine: 'firefox' })

    expect(answer.error?.message).toBe('Steel runs Chromium web sessions only, not firefox.')
    expect(answer.error?.data?.kind).toBe('refused')
    expect(createBodies(api)).toEqual([])
  })

  it('refuses a recording setting before any create, because Steel has no switch for it', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin, { recording: false })

    expect(answer.error?.data?.kind).toBe('refused')
    expect(answer.error?.message).toContain('recording')
    expect(createBodies(api)).toEqual([])
  })
})

describe('releasing a Steel session', () => {
  it('releases the session by its id, and a second release still succeeds', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)
    const acquired = await acquire(plugin)
    const handle = (acquired.result as { handle: unknown }).handle
    const [id] = api.createdIds()

    expect(await plugin.call('release', { handle })).toMatchObject({ result: {} })
    expect(await plugin.call('release', { handle })).toMatchObject({ result: {} })

    expect(api.releasedIds()).toEqual([id, id])
    expect(api.routeCalls(RELEASE_ROUTE)[0]?.headers['steel-api-key']).toBe(API_KEY)
  })
})
