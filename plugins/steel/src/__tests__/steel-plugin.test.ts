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

function acquire(plugin: SpawnedSteel, settings: Record<string, unknown> = {}) {
  return plugin.call('acquire', { remote: 'steel', settings, session: WEB_SESSION })
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
