import { afterEach, describe, expect, it } from 'vitest'
import { BROWSERSTACK_PLAYWRIGHT_VERSIONS } from '../playwright-versions.js'
import {
  APP_AUTOMATE_PLAN_ROUTE,
  AUTOMATE_PLAN_ROUTE,
  startFakeBrowserStackApi,
  type FakeBrowserStackApi,
  type FakeBrowserStackApiInput,
} from './fake-browserstack-api.js'
import {
  ACCESS_KEY,
  initializePlugin,
  loopbackOptions,
  startPluginProcess,
  USERNAME,
  type PluginProcess,
} from './plugin-process.js'

const LISTED = `${BROWSERSTACK_PLAYWRIGHT_VERSIONS[BROWSERSTACK_PLAYWRIGHT_VERSIONS.length - 1]}.0`
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${ACCESS_KEY}`).toString('base64')}`
const AUTOMATE_LINE = 'Automate: 1 of 5 parallel sessions running, 0 queued'
const APP_AUTOMATE_LINE = 'App Automate: 0 of 2 parallel sessions running, 0 queued'

const fakes: FakeBrowserStackApi[] = []
const plugins: PluginProcess[] = []

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.close()))
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

async function checkWith(input: FakeBrowserStackApiInput = {}, playwrightVersion = LISTED) {
  const api = await startFakeBrowserStackApi(input)
  fakes.push(api)
  const plugin = startPluginProcess()
  plugins.push(plugin)
  const initialized = await initializePlugin(plugin, loopbackOptions(api.url), playwrightVersion)
  expect(initialized.error).toBeUndefined()
  const answer = await plugin.call('check', {
    remotes: [{ name: 'browserstack', settings: {} }],
  })
  expect(answer.error).toBeUndefined()
  return { api, plugin, result: answer.result as { state: string; lines: string[] } }
}

describe('checking a BrowserStack account', () => {
  it('reads both plans and reports running, allowed and queued sessions, opening no session', async () => {
    const { api, result } = await checkWith()

    expect(result).toEqual({ state: 'ok', lines: [AUTOMATE_LINE, APP_AUTOMATE_LINE] })
    expect(api.requests.map((request) => `${request.method} ${request.path}`).sort()).toEqual([
      'GET /app-automate/plan.json',
      'GET /automate/plan.json',
    ])
    expect(api.requests.every((request) => request.headers.authorization === BASIC)).toBe(true)
  })

  it("warns when BrowserStack does not list agent-qa's Playwright version", async () => {
    const { result } = await checkWith({}, '1.64.1')

    expect(result).toEqual({
      state: 'warn',
      lines: [
        AUTOMATE_LINE,
        APP_AUTOMATE_LINE,
        'BrowserStack lists Playwright 1.59 to 1.63, not 1.64; web tests on BrowserStack are refused until it does.',
      ],
    })
  })

  it("warns when agent-qa's Playwright version is unknown", async () => {
    const { result } = await checkWith({}, 'unknown')

    expect(result.state).toBe('warn')
    expect(result.lines).toContain(
      "BrowserStack lists Playwright 1.59 to 1.63, and agent-qa's Playwright version is unknown; web tests on BrowserStack are refused until it is known.",
    )
  })

  it("warns that the credentials were refused when Automate's plan answers 401", async () => {
    const { plugin, result } = await checkWith({
      routes: { [AUTOMATE_PLAN_ROUTE]: [{ status: 401, json: { message: 'Unauthorized' } }] },
    })

    expect(result).toEqual({ state: 'warn', lines: ['the username or access key was refused'] })
    expect(plugin.stderr()).not.toContain(ACCESS_KEY)
  })

  it("warns that the credentials were refused when App Automate's plan answers 401", async () => {
    const { result } = await checkWith({
      routes: { [APP_AUTOMATE_PLAN_ROUTE]: [{ status: 401, json: { message: 'Unauthorized' } }] },
    })

    expect(result).toEqual({ state: 'warn', lines: ['the username or access key was refused'] })
  })

  it('warns that App Automate is not on the account when its plan answers 404, beside Automate', async () => {
    const { result } = await checkWith({
      routes: { [APP_AUTOMATE_PLAN_ROUTE]: [{ status: 404, json: { message: 'Not found' } }] },
    })

    expect(result).toEqual({
      state: 'warn',
      lines: [AUTOMATE_LINE, 'App Automate is not on this account'],
    })
  })

  it('warns that Automate is not on the account when its plan answers 404, beside App Automate', async () => {
    const { result } = await checkWith({
      routes: { [AUTOMATE_PLAN_ROUTE]: [{ status: 404, json: { message: 'Not found' } }] },
    })

    expect(result).toEqual({
      state: 'warn',
      lines: ['Automate is not on this account', APP_AUTOMATE_LINE],
    })
  })

  it('warns with the vendor reason when a plan cannot be read', async () => {
    const { result } = await checkWith({
      routes: { [AUTOMATE_PLAN_ROUTE]: [{ status: 500, json: { error: 'internal error' } }] },
    })

    expect(result).toEqual({
      state: 'warn',
      lines: [
        'Automate plan not readable: BrowserStack answered 500 to GET /automate/plan.json: internal error',
        APP_AUTOMATE_LINE,
      ],
    })
  })

  it('warns when a plan answers another shape', async () => {
    const { result } = await checkWith({
      routes: { [APP_AUTOMATE_PLAN_ROUTE]: [{ status: 200, json: { plan: 'unknown' } }] },
    })

    expect(result).toEqual({
      state: 'warn',
      lines: [AUTOMATE_LINE, 'App Automate plan not readable: BrowserStack answered another shape'],
    })
  })
})
