/// <reference lib="dom" />
// The built dashboard in real Chromium on a first visit: each context states its browser language.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DASHBOARD_ANCHORED_BUILDS,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  dashboardFixtureProject,
  spawnDashboard,
  type SpawnedDashboard,
} from './spawned-chat.js'

const BROWSER_INSTALL_INSTRUCTION =
  'Chromium could not be launched by the pinned playwright-core. Run '
  + '`node node_modules/playwright-core/cli.js install chromium` from packages/cli and re-run; '
  + 'these cells must not be skipped when the browser is absent.'

const PRODUCT_TOUR_COOKIE = 'agent_qa_product_tour_state'
const TOUR_SKIPPED = encodeURIComponent(JSON.stringify({
  schemaVersion: 2, tourVersion: 'foundation-v1', skippedAt: '2026-09-27T00:00:00.000Z',
}))

const RUNS_READY = '[data-tour-id="tour-runs-table"]'
const NAV_RUNS = 'a[data-tour-id="tour-nav-runs"]'
const NAV_CONFIG = 'a[data-tour-id="tour-nav-config"]'

interface FirstVisit {
  readonly page: Page
  readonly lang: string
  readonly runs: string
  readonly config: string
}

describe('the shipped dashboard opens in the browser language on a first visit', () => {
  let dashboard: SpawnedDashboard | undefined
  let browser: Browser | undefined
  const contexts: BrowserContext[] = []
  const pageErrors: string[] = []

  beforeAll(async () => {
    const freshness = buildFreshness(DASHBOARD_ANCHORED_BUILDS)
    expect(freshness, REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })

    const project = dashboardFixtureProject('language')
    const spawned = await spawnDashboard(project.root, project.configPath)
    expect(spawned.ready, `the built dashboard never listened. stdout: ${spawned.stdout().slice(-1200)} stderr: ${spawned.stderr().slice(-1200)}`).toBe(true)
    dashboard = spawned
    try {
      browser = await chromium.launch({ headless: true })
    } catch (error) {
      await spawned.stop()
      throw new Error(`${BROWSER_INSTALL_INSTRUCTION} underlying error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, 180_000)

  afterAll(async () => {
    for (const context of contexts) await context.close()
    await browser?.close()
    await dashboard?.stop()
    cleanupTempRoots()
  })

  async function firstVisit(options: { readonly locale: string }): Promise<FirstVisit> {
    expect(browser && dashboard, 'the shipped dashboard or the browser did not stand up; see beforeAll').toBeTruthy()
    const origin = dashboard!.origin
    const context = await browser!.newContext(options)
    contexts.push(context)
    await context.addCookies([{ name: PRODUCT_TOUR_COOKIE, value: TOUR_SKIPPED, url: origin }])
    const page = await context.newPage()
    page.on('pageerror', (error) => { pageErrors.push(`${options.locale}: ${String(error)}`) })
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
    await page.locator(RUNS_READY).waitFor({ timeout: 30_000 })
    await page.locator(NAV_CONFIG).waitFor({ timeout: 30_000 })
    return {
      page,
      lang: await page.evaluate(() => document.documentElement.lang),
      runs: (await page.locator(NAV_RUNS).textContent())?.trim() ?? '',
      config: (await page.locator(NAV_CONFIG).textContent())?.trim() ?? '',
    }
  }

  it('shows the navigation in German for a browser set to Swiss German', async () => {
    const visit = await firstVisit({ locale: 'de-CH' })
    expect(await visit.page.evaluate(() => navigator.languages)).toEqual(['de-CH'])
    expect(visit.config).toBe('Konfiguration')
    expect(visit.runs).not.toBe('Runs')
    expect(visit.lang).toBe('de')
  }, 60_000)

  it('picks Traditional Chinese for a browser set to Chinese in Taiwan', async () => {
    const visit = await firstVisit({ locale: 'zh-TW' })
    expect(visit.lang).toBe('zh-Hant')
  }, 60_000)

  it('shows the navigation in English for a browser set to Italian', async () => {
    const visit = await firstVisit({ locale: 'it-IT' })
    expect(visit.config).toBe('Config')
    expect(visit.runs).toBe('Runs')
    expect(visit.lang).toBe('en')
  }, 60_000)

  it('logs no page error in any language', () => {
    expect(pageErrors).toEqual([])
  })
})
