import { afterEach, describe, expect, it } from 'vitest'
import {
  LIMITS_ROUTE,
  LIST_ROUTE,
  POOL_ROUTE,
  startFakeKernelApi,
  type FakeKernelApi,
  type FakeKernelApiInput,
} from './fake-kernel-api.js'
import { initializeKernel, spawnKernelPlugin, type SpawnedKernel } from './spawned-kernel.js'

const API_KEY = 'kernel-test-key'

const fakes: FakeKernelApi[] = []
const plugins: SpawnedKernel[] = []

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.close()))
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

async function checkWith(
  input: FakeKernelApiInput,
  remotes: { name: string; settings: Record<string, unknown> }[] = [
    { name: 'kernel', settings: {} },
  ],
) {
  const api = await startFakeKernelApi(input)
  fakes.push(api)
  const plugin = spawnKernelPlugin()
  plugins.push(plugin)
  const initialized = await initializeKernel(plugin, { apiKey: API_KEY, apiUrl: api.url })
  expect(initialized.error).toBeUndefined()
  const answer = await plugin.call('check', { remotes })
  expect(answer.error).toBeUndefined()
  return { api, result: answer.result as { state: string; lines: string[] } }
}

describe('checking a Kernel account', () => {
  it('proves the key, reads free sessions and finds each pool, creating no browser', async () => {
    const { api, result } = await checkWith({ pools: ['warm'] }, [
      { name: 'kernel', settings: {} },
      { name: 'kernel-warm', settings: { pool: 'warm' } },
    ])

    expect(result).toEqual({
      state: 'ok',
      lines: ['the API key was accepted', '3 of 5 concurrent sessions free', 'pool warm found'],
    })
    expect(api.routeCalls(LIST_ROUTE).map((request) => request.query)).toEqual([{ limit: '1' }])
    expect(api.routeCalls(LIMITS_ROUTE)).toHaveLength(1)
    expect(api.routeCalls(POOL_ROUTE).map((request) => request.params.pool)).toEqual(['warm'])
    expect(api.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'GET'])
    expect(
      api.requests.every((request) => request.headers.authorization === `Bearer ${API_KEY}`),
    ).toBe(true)
  })

  it('stays ok when the key cannot read the organization limits', async () => {
    const { result } = await checkWith({ limits: [{ status: 403, json: { message: 'no' } }] })

    expect(result).toEqual({
      state: 'ok',
      lines: ['the API key was accepted', 'organization limits not readable with this key'],
    })
  })

  it('warns when Kernel refuses the key, and reads nothing more', async () => {
    const { api, result } = await checkWith({ list: [{ status: 401, json: { message: 'no' } }] })

    expect(result).toEqual({ state: 'warn', lines: ['the API key was refused'] })
    expect(api.routeCalls(LIMITS_ROUTE)).toEqual([])
  })

  it('warns when a remote names a pool Kernel does not have', async () => {
    const { result } = await checkWith({ pools: ['warm'] }, [
      { name: 'kernel-warm', settings: { pool: 'warm' } },
      { name: 'kernel-cold', settings: { pool: 'cold' } },
    ])

    expect(result.state).toBe('warn')
    expect(result.lines).toContain('pool warm found')
    expect(result.lines).toContain('pool cold not found')
  })

  it('looks a pool up once when two remotes share it', async () => {
    const { api } = await checkWith({ pools: ['warm'] }, [
      { name: 'one', settings: { pool: 'warm' } },
      { name: 'two', settings: { pool: 'warm' } },
    ])

    expect(api.routeCalls(POOL_ROUTE)).toHaveLength(1)
  })

  it('warns without naming the key when Kernel cannot be reached', async () => {
    const api = await startFakeKernelApi()
    const url = api.url
    await api.close()
    const plugin = spawnKernelPlugin()
    plugins.push(plugin)
    await initializeKernel(plugin, { apiKey: API_KEY, apiUrl: url })

    const answer = await plugin.call('check', { remotes: [{ name: 'kernel', settings: {} }] })
    const result = answer.result as { state: string; lines: string[] }

    expect(result.state).toBe('warn')
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toMatch(/^Kernel could not be reached at /)
    expect(result.lines[0]).not.toContain(API_KEY)
  })
})
