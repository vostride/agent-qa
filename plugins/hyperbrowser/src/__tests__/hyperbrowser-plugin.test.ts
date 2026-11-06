import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CREATE_ROUTE,
  STOP_ROUTE,
  startFakeHyperbrowserApi,
  type FakeHyperbrowserApi,
} from './fake-hyperbrowser-api.js'
import {
  initializeHyperbrowser,
  spawnHyperbrowserPlugin,
  type SpawnedHyperbrowser,
} from './spawned-hyperbrowser.js'

const API_KEY = 'hyperbrowser-test-key'
const WEB_SESSION = { platform: 'web', engine: 'chromium', context: 'new' } as const

const fakes: FakeHyperbrowserApi[] = []
const hosts: SpawnedHyperbrowser[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()))
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

async function startApi(input?: Parameters<typeof startFakeHyperbrowserApi>[0]) {
  const api = await startFakeHyperbrowserApi(input)
  fakes.push(api)
  return api
}

async function initialized(options: Record<string, unknown>) {
  const plugin = spawnHyperbrowserPlugin()
  hosts.push(plugin)
  const answer = await initializeHyperbrowser(plugin, options)
  return { plugin, answer }
}

async function hyperbrowserPlugin(api: FakeHyperbrowserApi) {
  const { plugin, answer } = await initialized({ apiKey: API_KEY, apiUrl: api.url })
  expect(answer.error).toBeUndefined()
  return plugin
}

function acquire(
  plugin: SpawnedHyperbrowser,
  settings: Record<string, unknown> = {},
  session: Record<string, unknown> = WEB_SESSION,
) {
  return plugin.call('acquire', { remote: 'hyperbrowser', settings, session })
}

function createBodies(api: FakeHyperbrowserApi) {
  return api.routeCalls(CREATE_ROUTE).map((request) => request.body)
}

describe('creating a Hyperbrowser session', () => {
  it('asks for the longest lifetime with every page-changing feature off and leaves recording to the account', async () => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)

    expect((await acquire(plugin)).error).toBeUndefined()

    const calls = api.routeCalls(CREATE_ROUTE)
    expect(calls.map((request) => request.body)).toEqual([
      {
        timeoutMinutes: 720,
        useStealth: false,
        useProxy: false,
        solveCaptchas: false,
        adblock: false,
        trackers: false,
        annoyances: false,
        acceptCookies: false,
      },
    ])
    expect(calls[0]?.headers['x-api-key']).toBe(API_KEY)
  })

  it('answers cdp with the wsEndpoint as given, masks it, the live url and the token, and links the session page', async () => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)

    const answer = await acquire(plugin)

    const [id] = api.createdIds()
    const token = `${String(id)}-token`
    const url = `wss://connect.example.invalid/?token=${token}`
    expect(answer.result).toEqual({
      handle: { sessionId: id },
      protocol: 'cdp',
      url,
      mask: [url, `https://app.example.invalid/live?token=${token}`, token],
      link: `https://app.example.invalid/sessions/${String(id)}`,
    })
    expect((answer.result as { url: string }).url).not.toContain('keepAlive')
  })
})

describe('the Hyperbrowser settings', () => {
  it('lowers the lifetime', async () => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)

    expect((await acquire(plugin, { timeoutMinutes: 30 })).error).toBeUndefined()

    expect(createBodies(api)[0]).toMatchObject({ timeoutMinutes: 30 })
  })

  it.each([0, 721])('refuses timeoutMinutes %i before any create', async (timeoutMinutes) => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)

    const answer = await acquire(plugin, { timeoutMinutes })

    expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'settings.timeoutMinutes' })
    expect(createBodies(api)).toEqual([])
  })

  it.each([false, true])('sends recording %s as enableWebRecording', async (recording) => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)

    expect((await acquire(plugin, { recording })).error).toBeUndefined()

    expect(createBodies(api)[0]).toMatchObject({ enableWebRecording: recording })
  })

  it('turns each page-changing feature on when its setting is true', async () => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)

    const settings = {
      stealth: true,
      solveCaptchas: true,
      adblock: true,
      trackers: true,
      annoyances: true,
      acceptCookies: true,
      proxy: true,
    }
    expect((await acquire(plugin, settings)).error).toBeUndefined()

    const [body] = createBodies(api)
    expect(body).toMatchObject({
      useStealth: true,
      solveCaptchas: true,
      adblock: true,
      trackers: true,
      annoyances: true,
      acceptCookies: true,
      useProxy: true,
    })
    expect(body).not.toHaveProperty('proxyCountry')
  })

  it('sends a proxy location as useProxy with the fields it is given', async () => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)

    const settings = { proxy: { country: 'DE', city: 'berlin' } }
    expect((await acquire(plugin, settings)).error).toBeUndefined()

    const [body] = createBodies(api)
    expect(body).toMatchObject({ useProxy: true, proxyCountry: 'DE', proxyCity: 'berlin' })
    expect(body).not.toHaveProperty('proxyState')
  })

  it('merges extra last, so it overrides a curated setting and adds its own fields', async () => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)

    const settings = { adblock: false, extra: { adblock: true, useUltraStealth: true } }
    expect((await acquire(plugin, settings)).error).toBeUndefined()

    expect(createBodies(api)[0]).toMatchObject({ adblock: true, useUltraStealth: true })
  })

  it('sends the screen, the region and the extensions it is given', async () => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)

    const settings = {
      screen: { width: 1440, height: 900 },
      region: 'europe-west',
      extensions: ['e-1'],
    }
    expect((await acquire(plugin, settings)).error).toBeUndefined()

    expect(createBodies(api)[0]).toMatchObject({
      screen: { width: 1440, height: 900 },
      region: 'europe-west',
      extensionIds: ['e-1'],
    })
  })

  it('loads a profile read-only into a reused context', async () => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)

    const answer = await acquire(plugin, { profile: 'p-1' }, { ...WEB_SESSION, context: 'reuse' })
    expect(answer.error).toBeUndefined()

    expect(createBodies(api)[0]).toMatchObject({ profile: { id: 'p-1', persistChanges: false } })
  })

  it('refuses a profile for a new context before any create, pointing at profile', async () => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)

    const answer = await acquire(plugin, { profile: 'p-1' })

    expect(answer.error?.message).toBe(
      'profile loads only into a reused context; set context: reuse on the remote.',
    )
    expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'settings.profile' })
    expect(createBodies(api)).toEqual([])
  })

  it('refuses a session that is not Chromium before any create', async () => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)

    const answer = await acquire(plugin, {}, { ...WEB_SESSION, engine: 'firefox' })

    expect(answer.error?.message).toBe('Hyperbrowser runs Chromium web sessions only, not firefox.')
    expect(answer.error?.data?.kind).toBe('refused')
    expect(createBodies(api)).toEqual([])
  })
})

describe('stopping a Hyperbrowser session', () => {
  it('stops the session by its id, and a second stop still succeeds', async () => {
    const api = await startApi()
    const plugin = await hyperbrowserPlugin(api)
    const acquired = await acquire(plugin)
    const handle = (acquired.result as { handle: unknown }).handle
    const [id] = api.createdIds()

    expect(await plugin.call('release', { handle })).toMatchObject({ result: {} })
    expect(await plugin.call('release', { handle })).toMatchObject({ result: {} })

    expect(api.stoppedIds()).toEqual([id, id])
    expect(api.routeCalls(STOP_ROUTE)[0]?.headers['x-api-key']).toBe(API_KEY)
  })
})

describe('Hyperbrowser failures', () => {
  it.each([
    [401, 'auth'],
    [500, 'refused'],
  ])('a %i to the create fails as %s with no handle', async (status, kind) => {
    const api = await startApi({ create: [{ status, json: { message: 'no' } }] })
    const plugin = await hyperbrowserPlugin(api)

    const answer = await acquire(plugin)

    expect(answer.error?.message).toBe(
      `Hyperbrowser answered ${String(status)} to POST /api/session: no`,
    )
    expect(answer.error?.data?.kind).toBe(kind)
    expect(answer.error?.data).not.toHaveProperty('handle')
    expect(answer.error?.message).not.toContain(API_KEY)
    expect(answer.error?.message).not.toContain('\n')
  })

  it("a 403 to the create fails as refused with Hyperbrowser's reason", async () => {
    const api = await startApi({
      create: [{ status: 403, json: { error: 'Proxy usage requires a paid plan' } }],
    })
    const plugin = await hyperbrowserPlugin(api)

    const answer = await acquire(plugin, { proxy: true })

    expect(answer.error?.message).toBe(
      'Hyperbrowser answered 403 to POST /api/session: Proxy usage requires a paid plan',
    )
    expect(answer.error?.data?.kind).toBe('refused')
    expect(answer.error?.message).not.toContain(API_KEY)
  })

  it('a 429 to the create fails as capacity with the wait Hyperbrowser asked for', async () => {
    const api = await startApi({
      create: [{ status: 429, headers: { 'retry-after': '5' }, json: { message: 'busy' } }],
    })
    const plugin = await hyperbrowserPlugin(api)

    const answer = await acquire(plugin)

    expect(answer.error?.data?.kind).toBe('capacity')
    expect(answer.error?.message).toMatch(/, retry after 5 s$/)
    expect(answer.error?.message).not.toContain(API_KEY)
    expect(answer.error?.message).not.toContain('\n')
  })

  it('fails as unreachable without naming the key when nothing answers', async () => {
    const api = await startApi()
    const url = api.url
    await api.close()
    const { plugin } = await initialized({ apiKey: API_KEY, apiUrl: url })

    const answer = await acquire(plugin)

    expect(answer.error?.data?.kind).toBe('unreachable')
    expect(answer.error?.message).not.toContain(API_KEY)
    expect(answer.error?.message).not.toContain('\n')
    expect(plugin.stderr()).not.toContain(API_KEY)
  })

  it('refuses an answer without a wsEndpoint, keeping its id as the handle so it is stopped', async () => {
    const api = await startApi({ create: [{ status: 200, json: { id: 'h-9', status: 'active' } }] })
    const plugin = await hyperbrowserPlugin(api)

    const answer = await acquire(plugin)

    expect(answer.error?.message).toBe(
      'Hyperbrowser answered a session without a usable wsEndpoint.',
    )
    expect(answer.error?.data).toMatchObject({ kind: 'refused', handle: { sessionId: 'h-9' } })
  })

  it('refuses an answer without an id, with no handle to stop', async () => {
    const api = await startApi({
      create: [{ status: 200, json: { wsEndpoint: 'wss://connect.example.invalid/' } }],
    })
    const plugin = await hyperbrowserPlugin(api)

    const answer = await acquire(plugin)

    expect(answer.error?.message).toBe('Hyperbrowser answered a session without an id.')
    expect(answer.error?.data?.kind).toBe('refused')
    expect(answer.error?.data).not.toHaveProperty('handle')
  })
})

describe('the Hyperbrowser options', () => {
  it('declares apiKey a required credential', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../dist/options.schema.json', import.meta.url), 'utf8'),
    ) as { properties: { apiKey: { credential?: boolean } }; required?: string[] }

    expect(schema.properties.apiKey.credential).toBe(true)
    expect(schema.required ?? []).toContain('apiKey')
  })

  it.each(['http://hb.example.com', 'https://user:secret@api.hyperbrowser.ai'])(
    'refuses apiUrl %s at initialize, pointing at apiUrl',
    async (apiUrl) => {
      const { answer } = await initialized({ apiKey: API_KEY, apiUrl })

      expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'apiUrl' })
      expect(answer.error?.message).toBe(
        'apiUrl must use https:// with no user or password, unless it points at this machine.',
      )
      expect(answer.error?.message).not.toContain(API_KEY)
    },
  )

  it.each(['https://api.hyperbrowser.ai', 'http://127.0.0.1:9'])(
    'accepts apiUrl %s',
    async (apiUrl) => {
      const { answer } = await initialized({ apiKey: API_KEY, apiUrl })

      expect(answer.error).toBeUndefined()
    },
  )
})
