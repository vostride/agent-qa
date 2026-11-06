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

async function hyperbrowserPlugin(api: FakeHyperbrowserApi) {
  const plugin = spawnHyperbrowserPlugin()
  hosts.push(plugin)
  const answer = await initializeHyperbrowser(plugin, { apiKey: API_KEY, apiUrl: api.url })
  expect(answer.error).toBeUndefined()
  return plugin
}

function acquire(plugin: SpawnedHyperbrowser, settings: Record<string, unknown> = {}) {
  return plugin.call('acquire', { remote: 'hyperbrowser', settings, session: WEB_SESSION })
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
