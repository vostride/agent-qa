import { afterEach, describe, expect, it } from 'vitest'
import {
  CREATE_ROUTE,
  LIST_ROUTE,
  startFakeSteelApi,
  type FakeSteelApi,
  type FakeSteelApiInput,
} from './fake-steel-api.js'
import { initializeSteel, spawnSteelPlugin, type SpawnedSteel } from './spawned-steel.js'

const API_KEY = 'steel-test-key'

const fakes: FakeSteelApi[] = []
const plugins: SpawnedSteel[] = []

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.close()))
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

async function checkWith(input: FakeSteelApiInput = {}, apiKey: string | null = API_KEY) {
  const api = await startFakeSteelApi(input)
  fakes.push(api)
  const plugin = spawnSteelPlugin()
  plugins.push(plugin)
  const initialized = await initializeSteel(plugin, {
    apiUrl: api.url,
    ...(apiKey === null ? {} : { apiKey }),
  })
  expect(initialized.error).toBeUndefined()
  const answer = await plugin.call('check', { remotes: [{ name: 'steel', settings: {} }] })
  expect(answer.error).toBeUndefined()
  return { api, result: answer.result as { state: string; lines: string[] } }
}

describe('checking a Steel account', () => {
  it('lists sessions with the key and opens none', async () => {
    const { api, result } = await checkWith()

    expect(result).toEqual({ state: 'ok', lines: ['the API key was accepted'] })
    expect(api.routeCalls(LIST_ROUTE)).toHaveLength(1)
    expect(api.routeCalls(LIST_ROUTE)[0]?.headers['steel-api-key']).toBe(API_KEY)
    expect(api.routeCalls(CREATE_ROUTE)).toEqual([])
    expect(api.requests.every((request) => request.method === 'GET')).toBe(true)
  })

  it('warns when Steel refuses the key', async () => {
    const { api, result } = await checkWith({ list: [{ status: 401, json: { message: 'no' } }] })

    expect(result).toEqual({ state: 'warn', lines: ['the API key was refused'] })
    expect(api.routeCalls(CREATE_ROUTE)).toEqual([])
  })

  it('warns with the failure line when Steel answers another error', async () => {
    const { result } = await checkWith({ list: [{ status: 500, json: { message: 'down' } }] })

    expect(result.state).toBe('warn')
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toMatch(/^Steel answered 500 to GET \/v1\/sessions/)
    expect(result.lines[0]).not.toContain(API_KEY)
  })

  it('says Steel answered without a key when none is set, and sends none', async () => {
    const { api, result } = await checkWith({}, null)

    expect(result).toEqual({ state: 'ok', lines: ['Steel answered without an API key'] })
    expect(api.routeCalls(LIST_ROUTE)[0]?.headers).not.toHaveProperty('steel-api-key')
    expect(api.requests.every((request) => request.method === 'GET')).toBe(true)
  })

  it('asks for an API key when Steel refuses a request that carried none', async () => {
    const { result } = await checkWith({ list: [{ status: 401, json: { message: 'no' } }] }, null)

    expect(result).toEqual({
      state: 'warn',
      lines: ['Steel asked for an API key; set options.apiKey'],
    })
  })

  it('warns without naming the key when Steel cannot be reached', async () => {
    const api = await startFakeSteelApi()
    const url = api.url
    await api.close()
    const plugin = spawnSteelPlugin()
    plugins.push(plugin)
    await initializeSteel(plugin, { apiKey: API_KEY, apiUrl: url })

    const answer = await plugin.call('check', { remotes: [{ name: 'steel', settings: {} }] })
    const result = answer.result as { state: string; lines: string[] }

    expect(result.state).toBe('warn')
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toMatch(/^Steel could not be reached at /)
    expect(result.lines[0]).not.toContain(API_KEY)
  })
})
