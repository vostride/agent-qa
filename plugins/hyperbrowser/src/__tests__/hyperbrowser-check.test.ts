import { afterEach, describe, expect, it } from 'vitest'
import {
  CREATE_ROUTE,
  LIST_ROUTE,
  startFakeHyperbrowserApi,
  type FakeHyperbrowserApi,
  type FakeHyperbrowserApiInput,
} from './fake-hyperbrowser-api.js'
import {
  initializeHyperbrowser,
  spawnHyperbrowserPlugin,
  type SpawnedHyperbrowser,
} from './spawned-hyperbrowser.js'

const API_KEY = 'hyperbrowser-test-key'

const fakes: FakeHyperbrowserApi[] = []
const plugins: SpawnedHyperbrowser[] = []

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.close()))
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

async function checkWith(input: FakeHyperbrowserApiInput = {}) {
  const api = await startFakeHyperbrowserApi(input)
  fakes.push(api)
  const plugin = spawnHyperbrowserPlugin()
  plugins.push(plugin)
  const initialized = await initializeHyperbrowser(plugin, { apiKey: API_KEY, apiUrl: api.url })
  expect(initialized.error).toBeUndefined()
  const answer = await plugin.call('check', { remotes: [{ name: 'hyperbrowser', settings: {} }] })
  expect(answer.error).toBeUndefined()
  return { api, result: answer.result as { state: string; lines: string[] } }
}

function expectOnlyReads(api: FakeHyperbrowserApi) {
  expect(api.routeCalls(CREATE_ROUTE)).toEqual([])
  expect(api.requests.every((request) => request.method === 'GET')).toBe(true)
}

describe('checking a Hyperbrowser account', () => {
  it('reads the active sessions with the key, counts them and opens none', async () => {
    const { api, result } = await checkWith({
      list: [{ status: 200, json: { sessions: [{}, {}], totalCount: 2, page: 1, pageSize: 20 } }],
    })

    expect(result).toEqual({
      state: 'ok',
      lines: ['the API key was accepted', '2 active sessions'],
    })
    expect(api.routeCalls(LIST_ROUTE)).toHaveLength(1)
    expect(api.routeCalls(LIST_ROUTE)[0]?.headers['x-api-key']).toBe(API_KEY)
    expect(api.routeCalls(LIST_ROUTE)[0]?.query).toEqual({ status: 'active', page: '1' })
    expectOnlyReads(api)
  })

  it('counts a single active session in the singular', async () => {
    const { result } = await checkWith({
      list: [{ status: 200, json: { sessions: [{}], totalCount: 1, page: 1, pageSize: 20 } }],
    })

    expect(result).toEqual({ state: 'ok', lines: ['the API key was accepted', '1 active session'] })
  })

  it('leaves the count out when Hyperbrowser answers without one', async () => {
    const { api, result } = await checkWith({
      list: [{ status: 200, json: { sessions: [] } }],
    })

    expect(result).toEqual({ state: 'ok', lines: ['the API key was accepted'] })
    expectOnlyReads(api)
  })

  it('warns when Hyperbrowser refuses the key', async () => {
    const { api, result } = await checkWith({
      list: [{ status: 401, json: { message: 'Invalid API key' } }],
    })

    expect(result).toEqual({ state: 'warn', lines: ['the API key was refused'] })
    expectOnlyReads(api)
  })

  it('warns with the failure line when Hyperbrowser answers another error', async () => {
    const { api, result } = await checkWith({
      list: [{ status: 500, json: { error: 'down' } }],
    })

    expect(result.state).toBe('warn')
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toMatch(/^Hyperbrowser answered 500 to GET \/api\/sessions/)
    expect(result.lines[0]).not.toContain(API_KEY)
    expectOnlyReads(api)
  })

  it('warns without naming the key when Hyperbrowser cannot be reached', async () => {
    const api = await startFakeHyperbrowserApi()
    const url = api.url
    await api.close()
    const plugin = spawnHyperbrowserPlugin()
    plugins.push(plugin)
    await initializeHyperbrowser(plugin, { apiKey: API_KEY, apiUrl: url })

    const answer = await plugin.call('check', { remotes: [{ name: 'hyperbrowser', settings: {} }] })
    const result = answer.result as { state: string; lines: string[] }

    expect(result.state).toBe('warn')
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toMatch(/^Hyperbrowser could not be reached at /)
    expect(result.lines[0]).not.toContain(API_KEY)
  })
})
