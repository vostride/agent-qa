import { afterEach, describe, expect, it } from 'vitest'
import { BROWSERSTACK_PLAYWRIGHT_VERSIONS } from '../playwright-versions.js'
import {
  BUILD_SESSIONS_ROUTE,
  BUILDS_ROUTE,
  buildIdOf,
  startFakeBrowserStackApi,
  WEB_MARK_ROUTE,
  WEB_SESSION_ROUTE,
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

const LISTED = `${BROWSERSTACK_PLAYWRIGHT_VERSIONS[BROWSERSTACK_PLAYWRIGHT_VERSIONS.length - 1]}.0`
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${ACCESS_KEY}`).toString('base64')}`
const UNMARKED = `BrowserStack: no single web session matched build ${RUN_ID} and name ${TEST_NAME}; it stays unmarked.`

interface WebHandle {
  kind: string
  startedAt: string
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
  expect((await initializePlugin(plugin, loopbackOptions(api.url), LISTED)).error).toBeUndefined()
  const answer = await plugin.call('acquire', {
    remote: 'browserstack',
    settings: {},
    session: { platform: 'web', engine: 'chromium', context: 'new' },
    run: { testName: TEST_NAME },
  })
  expect(answer.error).toBeUndefined()
  const { handle } = answer.result as { handle: WebHandle }
  return { api, plugin, handle }
}

function after(handle: WebHandle, ms: number): string {
  return new Date(Date.parse(handle.startedAt) + ms).toISOString()
}

function matching(hashedId: string, createdAt?: string) {
  return { build: RUN_ID, name: TEST_NAME, hashedId, ...(createdAt ? { createdAt } : {}) }
}

function resultOf(answer: RpcAnswer): Record<string, unknown> {
  expect(answer.error).toBeUndefined()
  return answer.result as Record<string, unknown>
}

function stderrLines(plugin: PluginProcess): string[] {
  return plugin.stderr().trim().split('\n')
}

describe('started for a BrowserStack web session', () => {
  it("finds the one running session with the run's build and the test's name and returns its dashboard link", async () => {
    const { api, plugin, handle } = await browserStack()
    api.addWebSession(matching('w-one', after(handle, 1_000)))

    const started = resultOf(await plugin.call('started', { handle }))

    expect(started).toEqual({ link: api.webDashboardLink('w-one') })
    expect(api.routeCalls(BUILDS_ROUTE).map((request) => request.query)).toEqual([
      { limit: '100', status: 'running' },
    ])
    expect(api.routeCalls(BUILD_SESSIONS_ROUTE).map((request) => request.path)).toEqual([
      `/automate/builds/${buildIdOf(RUN_ID)}/sessions.json`,
    ])
    expect(api.routeCalls(BUILD_SESSIONS_ROUTE)[0]?.query).toEqual({
      limit: '100',
      status: 'running',
    })
    expect(api.routeCalls(WEB_SESSION_ROUTE).map((request) => request.path)).toEqual([
      '/automate/sessions/w-one.json',
    ])
    expect(api.routeCalls(BUILDS_ROUTE)[0]?.headers.authorization).toBe(BASIC)
    expect(plugin.stderr()).toBe('')
  })

  it('never returns the shareable public link', async () => {
    const { api, plugin, handle } = await browserStack()
    api.addWebSession(matching('w-one', after(handle, 1_000)))

    const started = resultOf(await plugin.call('started', { handle }))

    expect(JSON.stringify(started)).not.toContain(api.webPublicLink('w-one'))
    expect(JSON.stringify(started)).not.toContain('public')
  })

  it('ignores sessions with another name and builds with another name', async () => {
    const { api, plugin, handle } = await browserStack()
    const createdAt = after(handle, 1_000)
    api.addWebSession({ build: RUN_ID, name: 'another test', hashedId: 'w-other', createdAt })
    api.addWebSession({ build: 'run-6', name: TEST_NAME, hashedId: 'w-old-run', createdAt })
    api.addWebSession(matching('w-one', createdAt))

    const started = resultOf(await plugin.call('started', { handle }))

    expect(started).toEqual({ link: api.webDashboardLink('w-one') })
    expect(api.routeCalls(WEB_SESSION_ROUTE).map((request) => request.path)).toEqual([
      '/automate/sessions/w-one.json',
    ])
  })

  it('returns no link when two running sessions match, with one stderr line', async () => {
    const { api, plugin, handle } = await browserStack()
    api.addWebSession(matching('w-a', after(handle, 1_000)))
    api.addWebSession(matching('w-b', after(handle, 2_000)))

    const started = resultOf(await plugin.call('started', { handle }))

    expect(started).toEqual({})
    expect(stderrLines(plugin)).toEqual([UNMARKED])
  })

  it('returns no link when no running session matches, with one stderr line', async () => {
    const { plugin, handle } = await browserStack()

    const started = resultOf(await plugin.call('started', { handle }))

    expect(started).toEqual({})
    expect(stderrLines(plugin)).toEqual([UNMARKED])
  })

  it('does not count a session with the same name that started a minute before the acquire', async () => {
    const { api, plugin, handle } = await browserStack()
    api.addWebSession(matching('w-earlier', after(handle, -60_000)))
    api.addWebSession(matching('w-one', after(handle, 1_000)))

    const started = resultOf(await plugin.call('started', { handle }))

    expect(started).toEqual({ link: api.webDashboardLink('w-one') })
  })

  it('links nothing when the only same-name session started a minute before the acquire', async () => {
    const { api, plugin, handle } = await browserStack()
    api.addWebSession(matching('w-earlier', after(handle, -60_000)))

    const started = resultOf(await plugin.call('started', { handle }))

    expect(started).toEqual({})
    expect(stderrLines(plugin)).toEqual([UNMARKED])
  })

  it('counts a session whose start is a few seconds before the acquire, for clock skew', async () => {
    const { api, plugin, handle } = await browserStack()
    api.addWebSession(matching('w-one', after(handle, -3_000)))

    const started = resultOf(await plugin.call('started', { handle }))

    expect(started).toEqual({ link: api.webDashboardLink('w-one') })
  })

  it('does not count a session whose details carry no start time', async () => {
    const { api, plugin, handle } = await browserStack()
    api.addWebSession(matching('w-undated'))

    const started = resultOf(await plugin.call('started', { handle }))

    expect(started).toEqual({})
    expect(stderrLines(plugin)).toEqual([UNMARKED])
  })

  it('returns no link when the builds cannot be read, with one stderr line without the access key', async () => {
    const { api, plugin, handle } = await browserStack({
      routes: { [BUILDS_ROUTE]: [{ status: 500, json: { error: 'internal error' } }] },
    })

    const started = resultOf(await plugin.call('started', { handle }))

    expect(started).toEqual({})
    expect(api.routeCalls(BUILDS_ROUTE)).toHaveLength(1)
    expect(stderrLines(plugin)).toEqual([
      `BrowserStack: could not look up the web session for build ${RUN_ID} and name ${TEST_NAME}: BrowserStack answered 500 to GET /automate/builds.json: internal error; it stays unmarked.`,
    ])
    expect(plugin.stderr()).not.toContain(ACCESS_KEY)
  })
})

describe('end for a BrowserStack web session', () => {
  async function startedWeb(sessions: 1 | 2 = 1) {
    const context = await browserStack()
    const { api, plugin, handle } = context
    for (const hashedId of ['w-one', 'w-two'].slice(0, sessions)) {
      api.addWebSession(matching(hashedId, after(handle, 1_000)))
    }
    resultOf(await plugin.call('started', { handle }))
    return context
  }

  it('marks a passed test passed', async () => {
    const { api, plugin, handle } = await startedWeb()

    resultOf(await plugin.call('end', { handle, outcome: 'passed' }))

    expect(api.webMarks()).toEqual([{ sessionId: 'w-one', body: { status: 'passed', reason: '' } }])
    expect(api.routeCalls(WEB_MARK_ROUTE)[0]?.headers.authorization).toBe(BASIC)
  })

  it('marks a failed test failed with its reason', async () => {
    const { api, plugin, handle } = await startedWeb()

    resultOf(
      await plugin.call('end', { handle, outcome: 'failed', reason: 'the cart was empty' }),
    )

    expect(api.webMarks()).toEqual([
      { sessionId: 'w-one', body: { status: 'failed', reason: 'the cart was empty' } },
    ])
  })

  it('cuts the reason to 255 characters', async () => {
    const { api, plugin, handle } = await startedWeb()

    resultOf(await plugin.call('end', { handle, outcome: 'error', reason: 'x'.repeat(400) }))

    expect(api.webMarks()).toEqual([
      { sessionId: 'w-one', body: { status: 'failed', reason: 'x'.repeat(255) } },
    ])
  })

  it('leaves a cancelled test unmarked', async () => {
    const { api, plugin, handle } = await startedWeb()

    resultOf(await plugin.call('end', { handle, outcome: 'cancelled' }))

    expect(api.routeCalls(WEB_MARK_ROUTE)).toEqual([])
  })

  it('marks nothing when two sessions matched', async () => {
    const { api, plugin, handle } = await startedWeb(2)

    resultOf(await plugin.call('end', { handle, outcome: 'passed' }))

    expect(api.routeCalls(WEB_MARK_ROUTE)).toEqual([])
  })

  it('marks nothing when no session matched', async () => {
    const { api, plugin, handle } = await browserStack()
    resultOf(await plugin.call('started', { handle }))

    resultOf(await plugin.call('end', { handle, outcome: 'failed', reason: 'the cart was empty' }))

    expect(api.routeCalls(WEB_MARK_ROUTE)).toEqual([])
  })

  it('answers end when the mark fails, and writes one stderr line without the access key', async () => {
    const context = await browserStack({
      routes: { [WEB_MARK_ROUTE]: [{ status: 401, json: { message: 'Unauthorized' } }] },
    })
    const { api, plugin, handle } = context
    api.addWebSession(matching('w-one', after(handle, 1_000)))
    resultOf(await plugin.call('started', { handle }))

    expect((await plugin.call('end', { handle, outcome: 'passed' })).error).toBeUndefined()

    expect(api.routeCalls(WEB_MARK_ROUTE)).toHaveLength(1)
    expect(stderrLines(plugin)).toEqual([
      'BrowserStack: could not mark Automate session w-one passed: BrowserStack answered 401 to PUT /automate/sessions/{id}.json: Unauthorized',
    ])
    expect(plugin.stderr()).not.toContain(ACCESS_KEY)
  })

  it('forgets the session when its handle is released', async () => {
    const { api, plugin, handle } = await startedWeb()

    resultOf(await plugin.call('release', { handle }))
    resultOf(await plugin.call('end', { handle, outcome: 'passed' }))

    expect(api.routeCalls(WEB_MARK_ROUTE)).toEqual([])
  })
})
