import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CREATE_ROUTE,
  RELEASE_ROUTE,
  SESSION_ROUTE,
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

async function initialized(options: Record<string, unknown>) {
  const plugin = spawnSteelPlugin()
  hosts.push(plugin)
  const answer = await initializeSteel(plugin, options)
  return { plugin, answer }
}

async function steelPlugin(
  api: FakeSteelApi,
  options: Record<string, unknown> = { apiKey: API_KEY },
) {
  const { plugin, answer } = await initialized({ ...options, apiUrl: api.url })
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

  it('refuses extra.sessionId before any create, because the plugin releases by its own id', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin, { extra: { sessionId: 'mine' } })

    expect(answer.error?.message).toBe(
      'extra cannot set sessionId; the plugin chooses it to release the session.',
    )
    expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'settings.extra.sessionId' })
    expect(createBodies(api)).toEqual([])
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

describe('Steel failures', () => {
  it.each([422, 400])(
    'a %i to the create names settings.timeoutMinutes and carries no handle',
    async (status) => {
      const api = await startApi({ create: [{ status, json: { message: 'timeout too long' } }] })
      const plugin = await steelPlugin(api)

      const answer = await acquire(plugin)

      expect(answer.error?.message).toBe(
        `Steel answered ${String(status)} to POST /v1/sessions: timeout too long; if your Steel plan caps sessions below 1440 minutes, set settings.timeoutMinutes to the cap`,
      )
      expect(answer.error?.data?.kind).toBe('refused')
      expect(answer.error?.data).not.toHaveProperty('handle')
    },
  )

  it('a 400 with no reason still names settings.timeoutMinutes', async () => {
    const api = await startApi({ create: [{ status: 400, json: {} }] })
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin)

    expect(answer.error?.message).toBe(
      'Steel answered 400 to POST /v1/sessions; if your Steel plan caps sessions below 1440 minutes, set settings.timeoutMinutes to the cap',
    )
  })

  it('a 422 whose reason is about another field does not name settings.timeoutMinutes', async () => {
    const api = await startApi({
      create: [{ status: 422, json: { message: 'unknown profile id p-1' } }],
    })
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin)

    expect(answer.error?.message).toBe(
      'Steel answered 422 to POST /v1/sessions: unknown profile id p-1',
    )
  })

  it('a 422 does not name settings.timeoutMinutes when no plan caps the lifetime asked for', async () => {
    const api = await startApi({ create: [{ status: 422, json: { message: 'timeout too long' } }] })
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin, { timeoutMinutes: 15 })

    expect(answer.error?.message).toBe('Steel answered 422 to POST /v1/sessions: timeout too long')
  })

  it.each([
    [401, 'auth'],
    [403, 'refused'],
  ])('a %i to the create fails as %s and carries no handle', async (status, kind) => {
    const api = await startApi({ create: [{ status, json: { message: 'no' } }] })
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin)

    expect(answer.error?.message).toBe(`Steel answered ${String(status)} to POST /v1/sessions: no`)
    expect(answer.error?.data?.kind).toBe(kind)
    expect(answer.error?.data).not.toHaveProperty('handle')
    expect(answer.error?.message).not.toContain(API_KEY)
  })

  it.each([400, 401, 403, 422, 429])(
    'a %i to the create sends Steel no release, not even at shutdown',
    async (status) => {
      const api = await startApi({ create: [{ status, json: { message: 'no' } }] })
      const plugin = await steelPlugin(api)

      expect((await acquire(plugin)).error?.data).not.toHaveProperty('handle')
      expect((await plugin.call('shutdown')).error).toBeUndefined()

      expect(api.routeCalls(RELEASE_ROUTE)).toEqual([])
      expect(api.routeCalls(SESSION_ROUTE)).toEqual([])
    },
  )

  it('a 500 to the create fails as refused, keeps the session id and releases it at shutdown', async () => {
    const api = await startApi({ create: [{ status: 500, json: { message: 'no' } }] })
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin)

    const [body] = createBodies(api) as [{ sessionId: string }]
    expect(answer.error?.message).toBe('Steel answered 500 to POST /v1/sessions: no')
    expect(answer.error?.data).toMatchObject({
      kind: 'refused',
      handle: { sessionId: body.sessionId },
    })
    expect((await plugin.call('shutdown')).error).toBeUndefined()
    expect(api.releasedIds()).toEqual([body.sessionId])
  })

  it('a 429 to the create fails as capacity with the wait Steel asked for', async () => {
    const api = await startApi({
      create: [{ status: 429, headers: { 'retry-after': '3' }, json: { message: 'busy' } }],
    })
    const plugin = await steelPlugin(api)

    const answer = await acquire(plugin)

    expect(answer.error?.data?.kind).toBe('capacity')
    expect(answer.error?.message).toMatch(/, retry after 3 s$/)
    expect(answer.error?.message).not.toContain(API_KEY)
    expect(answer.error?.message).not.toContain('\n')
  })

  it('fails as unreachable, keeping the session id, without naming the key when nothing answers', async () => {
    const api = await startApi()
    const url = api.url
    await api.close()
    const { plugin } = await initialized({ apiKey: API_KEY, apiUrl: url })

    const answer = await acquire(plugin)

    expect(answer.error?.data?.kind).toBe('unreachable')
    expect(answer.error?.data?.handle).toEqual({ sessionId: expect.stringMatching(UUID) })
    expect(answer.error?.message).not.toContain(API_KEY)
    expect(plugin.stderr()).not.toContain(API_KEY)
  })

  it('names a granted lifetime below the one asked for on stderr', async () => {
    const api = await startApi({ grantedTimeoutMs: 900_000 })
    const plugin = await steelPlugin(api)

    expect((await acquire(plugin)).error).toBeUndefined()

    expect(plugin.stderr()).toContain(
      'Steel granted a 15-minute session; 1440 minutes were asked for',
    )
    expect(plugin.stderr()).not.toContain(API_KEY)
  })

  it('compares the granted lifetime with the timeout extra sent', async () => {
    const api = await startApi({ grantedTimeoutMs: 900_000 })
    const plugin = await steelPlugin(api)

    expect((await acquire(plugin, { extra: { timeout: 1_800_000 } })).error).toBeUndefined()

    expect(plugin.stderr()).toContain('Steel granted a 15-minute session; 30 minutes were asked for')
  })

  it('writes nothing about the lifetime when Steel grants the timeout extra sent', async () => {
    const api = await startApi({ grantedTimeoutMs: 900_000 })
    const plugin = await steelPlugin(api)

    expect((await acquire(plugin, { extra: { timeout: 900_000 } })).error).toBeUndefined()

    expect(plugin.stderr()).not.toContain('Steel granted')
  })

  it('writes nothing about the lifetime when Steel grants the one asked for', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api)

    expect((await acquire(plugin)).error).toBeUndefined()

    expect(plugin.stderr()).not.toContain('Steel granted')
  })
})

describe('a failed Steel release', () => {
  const handle = { sessionId: 'session-1' }

  it('succeeds when Steel no longer reports the session live', async () => {
    const api = await startApi({
      release: [{ status: 500, json: { message: 'try later' } }],
      session: [{ status: 200, json: { id: 'session-1', status: 'released' } }],
    })
    const plugin = await steelPlugin(api)

    expect(await plugin.call('release', { handle })).toMatchObject({ result: {} })

    expect(api.routeCalls(SESSION_ROUTE).map((request) => request.params.id)).toEqual(['session-1'])
  })

  it('succeeds when Steel no longer has the session', async () => {
    const api = await startApi({
      release: [{ status: 500, json: { message: 'try later' } }],
      session: [{ status: 404, json: { message: 'session not found' } }],
    })
    const plugin = await steelPlugin(api)

    expect(await plugin.call('release', { handle })).toMatchObject({ result: {} })
  })

  it('fails with the release answer when the session is still live', async () => {
    const api = await startApi({
      release: [{ status: 500, json: { message: 'try later' } }],
      session: [{ status: 200, json: { id: 'session-1', status: 'live' } }],
    })
    const plugin = await steelPlugin(api)

    const answer = await plugin.call('release', { handle })

    expect(answer.error?.message).toBe(
      'Steel answered 500 to POST /v1/sessions/{id}/release: try later',
    )
    expect(answer.error?.data?.kind).toBe('refused')
  })
})

describe('a self-hosted Steel without an API key', () => {
  it('sends no key header and puts no key in the connect url', async () => {
    const api = await startApi()
    const plugin = await steelPlugin(api, {})

    const answer = await acquire(plugin)

    expect(answer.error).toBeUndefined()
    expect(api.routeCalls(CREATE_ROUTE)[0]?.headers).not.toHaveProperty('steel-api-key')
    const { url } = answer.result as { url: string }
    expect(new URL(url).searchParams.has('apiKey')).toBe(false)
  })

  it('declares apiKey a credential it does not require', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../dist/options.schema.json', import.meta.url), 'utf8'),
    ) as { properties: { apiKey: { credential?: boolean } }; required?: string[] }

    expect(schema.properties.apiKey.credential).toBe(true)
    expect(schema.required ?? []).not.toContain('apiKey')
  })
})

describe('the Steel apiUrl', () => {
  it.each(['http://steel.example.com', 'https://user:secret@api.steel.dev'])(
    'refuses %s at initialize, pointing at apiUrl',
    async (apiUrl) => {
      const { answer } = await initialized({ apiKey: API_KEY, apiUrl })

      expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'apiUrl' })
      expect(answer.error?.message).toBe(
        'apiUrl must use https:// with no user or password, unless it points at this machine.',
      )
    },
  )

  it.each(['https://api.steel.dev', 'http://127.0.0.1:9'])('accepts %s', async (apiUrl) => {
    const { answer } = await initialized({ apiKey: API_KEY, apiUrl })

    expect(answer.error).toBeUndefined()
  })
})
