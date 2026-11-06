import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CREATE_ROUTE,
  DELETE_ROUTE,
  POOL_ACQUIRE_ROUTE,
  POOL_RELEASE_ROUTE,
  startFakeKernelApi,
  type FakeKernelApi,
  type FakeKernelApiInput,
} from './fake-kernel-api.js'
import { initializeKernel, spawnKernelPlugin, type SpawnedKernel } from './spawned-kernel.js'

const API_KEY = 'kernel-test-key'
const NEW_CONTEXT = { platform: 'web', engine: 'chromium', context: 'new' } as const
const REUSED_CONTEXT = { platform: 'web', engine: 'chromium', context: 'reuse' } as const

const fakes: FakeKernelApi[] = []
const plugins: SpawnedKernel[] = []

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.close()))
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

async function kernelWith(input: FakeKernelApiInput = {}) {
  const api = await startFakeKernelApi(input)
  fakes.push(api)
  const plugin = spawnKernelPlugin()
  plugins.push(plugin)
  const answer = await initializeKernel(plugin, { apiKey: API_KEY, apiUrl: api.url })
  expect(answer.error).toBeUndefined()
  return { api, plugin }
}

function acquireParams(
  settings: Record<string, unknown>,
  session: typeof NEW_CONTEXT | typeof REUSED_CONTEXT = NEW_CONTEXT,
) {
  return { remote: 'kernel', settings, session }
}

function progressMessages(plugin: SpawnedKernel) {
  return plugin
    .notifications()
    .filter((notification) => notification.method === '$/progress')
    .map((notification) => notification.params)
}

describe('acquiring from a Kernel pool', () => {
  it('waits through each 204 with one progress notification, then answers the pooled browser', async () => {
    const { api, plugin } = await kernelWith({ poolAcquire: [{ status: 204 }, { status: 204 }] })

    const { id, answer } = plugin.request('acquire', acquireParams({ pool: 'warm' }))

    expect((await answer).result).toEqual({
      handle: { sessionId: 'warm-browser-1', pool: 'warm', reuse: true },
      protocol: 'cdp',
      url: 'wss://cdp.example.invalid/warm-browser-1?jwt=warm-browser-1-jwt',
      mask: ['wss://cdp.example.invalid/warm-browser-1?jwt=warm-browser-1-jwt'],
    })
    expect(progressMessages(plugin)).toEqual([
      { id, message: 'waiting for pool warm' },
      { id, message: 'waiting for pool warm' },
    ])
    expect(api.routeCalls(POOL_ACQUIRE_ROUTE)).toHaveLength(3)
    expect(api.routeCalls(POOL_ACQUIRE_ROUTE)[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(api.routeCalls(CREATE_ROUTE)).toEqual([])
  })

  it('waits a second between pool acquires that Kernel answers 204 at once', async () => {
    const { api, plugin } = await kernelWith({ poolEmpty: true })

    const { id, answer } = plugin.request('acquire', acquireParams({ pool: 'warm' }))
    await delay(1_500)
    const polled = api.routeCalls(POOL_ACQUIRE_ROUTE).length
    plugin.notify('$/cancel', { id })
    await answer

    expect(polled).toBeGreaterThanOrEqual(1)
    expect(polled).toBeLessThanOrEqual(2)
    expect(progressMessages(plugin).length).toBeLessThanOrEqual(2)
  })

  it('stops polling on a cancel and answers it with no handle', async () => {
    const { api, plugin } = await kernelWith({ poolEmpty: true })

    const waiting = plugin.nextNotification()
    const { id, answer } = plugin.request('acquire', acquireParams({ pool: 'warm' }))
    await waiting
    plugin.notify('$/cancel', { id })
    const cancelled = await answer
    const polled = api.routeCalls(POOL_ACQUIRE_ROUTE).length
    await delay(250)

    expect(cancelled.error?.code).toBe(-32800)
    expect(cancelled.error?.data?.handle).toBeUndefined()
    expect(api.routeCalls(POOL_ACQUIRE_ROUTE)).toHaveLength(polled)
  })

  it('sends extra last into the acquire body', async () => {
    const { api, plugin } = await kernelWith()

    await plugin.call('acquire', acquireParams({ pool: 'warm', extra: { tags: { team: 'qa' } } }))

    expect(api.routeCalls(POOL_ACQUIRE_ROUTE).map((request) => request.body)).toEqual([
      { tags: { team: 'qa' } },
    ])
  })

  it('refuses a create-only setting on a remote with a pool, naming its path', async () => {
    const { api, plugin } = await kernelWith()

    const answer = await plugin.call('acquire', acquireParams({ pool: 'warm', region: 'eu-west' }))

    expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'settings.region' })
    expect(api.requests).toEqual([])
  })
})

describe('releasing to a Kernel pool', () => {
  async function releasedReuse(session: typeof NEW_CONTEXT | typeof REUSED_CONTEXT) {
    const { api, plugin } = await kernelWith()
    const acquired = await plugin.call('acquire', acquireParams({ pool: 'warm' }, session))
    const handle = (acquired.result as { handle: unknown }).handle

    const released = await plugin.call('release', { handle })

    expect(released).toMatchObject({ result: {} })
    expect(api.routeCalls(DELETE_ROUTE)).toEqual([])
    return api.routeCalls(POOL_RELEASE_ROUTE).map((request) => ({
      pool: request.params.pool,
      body: request.body,
    }))
  }

  it('returns the browser for reuse after a test in a new context', async () => {
    expect(await releasedReuse(NEW_CONTEXT)).toEqual([
      { pool: 'warm', body: { session_id: 'warm-browser-1', reuse: true } },
    ])
  })

  it('discards the browser after a test that reused its context', async () => {
    expect(await releasedReuse(REUSED_CONTEXT)).toEqual([
      { pool: 'warm', body: { session_id: 'warm-browser-1', reuse: false } },
    ])
  })

  it('treats a browser the pool no longer has as released', async () => {
    const { plugin } = await kernelWith({ poolRelease: [{ status: 404, json: { message: 'no' } }] })

    const released = await plugin.call('release', {
      handle: { sessionId: 'gone', pool: 'warm', reuse: true },
    })

    expect(released).toMatchObject({ result: {} })
  })
})

describe('Kernel profiles', () => {
  it('refuses a profile without a reused context, naming settings.profile', async () => {
    const { api, plugin } = await kernelWith()

    const answer = await plugin.call('acquire', acquireParams({ profile: 'shop' }))

    expect(answer.error?.message).toBe(
      'profile loads only into a reused context; set context: reuse on the remote.',
    )
    expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'settings.profile' })
    expect(api.requests).toEqual([])
  })

  it('loads a named profile without saving changes back', async () => {
    const { api, plugin } = await kernelWith()

    await plugin.call('acquire', acquireParams({ profile: 'shop' }, REUSED_CONTEXT))

    expect(api.routeCalls(CREATE_ROUTE).map((request) => request.body)).toEqual([
      { headless: true, timeout_seconds: 60, profile: { name: 'shop', save_changes: false } },
    ])
  })

  it('loads a profile given by id, and sends it with a pool acquire too', async () => {
    const { api, plugin } = await kernelWith()

    await plugin.call(
      'acquire',
      acquireParams({ pool: 'warm', profile: { id: 'prof-1' } }, REUSED_CONTEXT),
    )

    expect(api.routeCalls(POOL_ACQUIRE_ROUTE).map((request) => request.body)).toEqual([
      { profile: { id: 'prof-1', save_changes: false } },
    ])
  })
})
