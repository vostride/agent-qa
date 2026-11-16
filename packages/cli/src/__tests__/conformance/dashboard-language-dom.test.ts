/// <reference lib="dom" />
// The built dashboard in real Chromium: each context states its browser language, and the
// Config page's language block switches the dashboard in place and in every open tab.

import { readFileSync } from 'node:fs'

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
const CONFIG_READY = '[data-config-page][data-config-state="ready"]'
const NAV_RUNS = 'a[data-tour-id="tour-nav-runs"]'
const NAV_CONFIG = 'a[data-tour-id="tour-nav-config"]'
const LANGUAGE_SELECT = '[data-language-select]'
const LANGUAGE_LABEL = '[data-language-block] label'
const STORAGE_KEY = 'agent-qa.language'
const READ_METHODS = new Set(['GET', 'HEAD'])

interface FirstVisit {
  readonly page: Page
  readonly lang: string
  readonly runs: string
  readonly config: string
}

type Locale = { readonly locale: string }

describe('the shipped dashboard follows the browser language and the Config page switch', () => {
  let dashboard: SpawnedDashboard | undefined
  let browser: Browser | undefined
  let configPath: string | undefined
  const contexts: BrowserContext[] = []
  const pageErrors: string[] = []

  beforeAll(async () => {
    const freshness = buildFreshness(DASHBOARD_ANCHORED_BUILDS)
    expect(freshness, REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })

    const project = dashboardFixtureProject('language')
    configPath = project.configPath
    const spawned = await spawnDashboard(project.root, project.configPath)
    expect(spawned.ready, `the built dashboard never listened. stdout: ${spawned.stdout().slice(-1200)} stderr: ${spawned.stderr().slice(-1200)}`).toBe(true)
    dashboard = spawned
    try {
      browser = await chromium.launch({ headless: true, args: ['--lang=en-US'] })
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

  function origin(): string {
    expect(browser && dashboard, 'the shipped dashboard or the browser did not stand up; see beforeAll').toBeTruthy()
    return dashboard!.origin
  }

  async function newContext(options: Locale): Promise<BrowserContext> {
    const context = await browser!.newContext(options)
    contexts.push(context)
    await context.addCookies([{ name: PRODUCT_TOUR_COOKIE, value: TOUR_SKIPPED, url: origin() }])
    return context
  }

  async function newPage(context: BrowserContext, label: string): Promise<Page> {
    const page = await context.newPage()
    page.on('pageerror', (error) => { pageErrors.push(`${label}: ${String(error)}`) })
    return page
  }

  async function openRuns(page: Page) {
    await page.goto(`${origin()}/`, { waitUntil: 'domcontentloaded' })
    await page.locator(RUNS_READY).waitFor({ timeout: 30_000 })
    await page.locator(NAV_CONFIG).waitFor({ timeout: 30_000 })
  }

  async function openConfig(page: Page) {
    await page.goto(`${origin()}/config`, { waitUntil: 'domcontentloaded' })
    await page.locator(CONFIG_READY).waitFor({ timeout: 30_000 })
    await page.locator(LANGUAGE_SELECT).waitFor({ timeout: 30_000 })
  }

  async function chooseLanguage(page: Page, name: string) {
    await page.locator(LANGUAGE_SELECT).click()
    await page.getByRole('option', { name, exact: true }).click()
  }

  async function chooseBrowserEntry(page: Page) {
    await page.locator(LANGUAGE_SELECT).click()
    await page.getByRole('option').first().click()
  }

  async function langBecomes(page: Page, lang: string) {
    await page.waitForFunction((expected) => document.documentElement.lang === expected, lang, { timeout: 15_000 })
  }

  async function mark(page: Page) {
    await page.evaluate(() => { (window as { languageMarker?: string }).languageMarker = 'kept' })
  }

  async function marked(page: Page): Promise<boolean> {
    return page.evaluate(() => (window as { languageMarker?: string }).languageMarker === 'kept')
  }

  async function text(page: Page, selector: string): Promise<string> {
    return (await page.locator(selector).textContent())?.trim() ?? ''
  }

  async function savedChoice(page: Page): Promise<string | null> {
    return page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
  }

  async function firstVisit(options: Locale): Promise<FirstVisit> {
    const context = await newContext(options)
    const page = await newPage(context, options.locale)
    await openRuns(page)
    return {
      page,
      lang: await page.evaluate(() => document.documentElement.lang),
      runs: await text(page, NAV_RUNS),
      config: await text(page, NAV_CONFIG),
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

  it('applies a chosen language at once without reloading the page', async () => {
    const context = await newContext({ locale: 'en-US' })
    const page = await newPage(context, 'switch')
    await openConfig(page)
    expect(await text(page, NAV_CONFIG)).toBe('Config')
    await mark(page)

    await chooseLanguage(page, 'Deutsch')
    await langBecomes(page, 'de')

    expect(await text(page, NAV_CONFIG)).toBe('Konfiguration')
    expect(await text(page, LANGUAGE_LABEL)).toBe('Sprache')
    expect(await marked(page)).toBe(true)
  }, 60_000)

  it('carries the choice to a second tab of the same browser', async () => {
    const context = await newContext({ locale: 'en-US' })
    const config = await newPage(context, 'first tab')
    const runs = await newPage(context, 'second tab')
    await openConfig(config)
    await openRuns(runs)
    expect(await text(runs, NAV_CONFIG)).toBe('Config')
    await mark(runs)

    await chooseLanguage(config, 'Deutsch')
    await langBecomes(runs, 'de')

    expect(await text(runs, NAV_CONFIG)).toBe('Konfiguration')
    expect(await marked(runs)).toBe(true)
  }, 60_000)

  it('keeps the choice in the browser and writes nothing to the config file', async () => {
    const context = await newContext({ locale: 'en-US' })
    const page = await newPage(context, 'nothing written')
    const methods: string[] = []
    page.on('request', (request) => { methods.push(`${request.method()} ${new URL(request.url()).pathname}`) })
    const before = readFileSync(configPath!)
    await openConfig(page)

    await chooseLanguage(page, 'Deutsch')
    await langBecomes(page, 'de')

    expect(readFileSync(configPath!).equals(before)).toBe(true)
    expect(methods.length).toBeGreaterThan(0)
    expect(methods.filter((entry) => !READ_METHODS.has(entry.split(' ')[0]!))).toEqual([])
    expect(await savedChoice(page)).toBe('de')
  }, 60_000)

  it('opens the next visit in the saved language', async () => {
    const context = await newContext({ locale: 'en-US' })
    const page = await newPage(context, 'saved choice')
    await openConfig(page)
    await chooseLanguage(page, 'Deutsch')
    await langBecomes(page, 'de')

    const next = await newPage(context, 'next visit')
    await openRuns(next)

    expect(await next.evaluate(() => document.documentElement.lang)).toBe('de')
    expect(await text(next, NAV_CONFIG)).toBe('Konfiguration')
  }, 60_000)

  it('removes the saved choice and follows the browser when the first entry is chosen', async () => {
    const context = await newContext({ locale: 'en-US' })
    const page = await newPage(context, 'follow the browser')
    await openConfig(page)
    await chooseLanguage(page, 'Deutsch')
    await langBecomes(page, 'de')

    await chooseBrowserEntry(page)
    await langBecomes(page, 'en')

    expect(await savedChoice(page)).toBeNull()
    expect(await text(page, NAV_CONFIG)).toBe('Config')
  }, 60_000)

  it('names the language a Swiss German browser resolves to in the first entry', async () => {
    const context = await newContext({ locale: 'de-CH' })
    const page = await newPage(context, 'browser entry')
    await openConfig(page)
    expect(await savedChoice(page)).toBeNull()

    await page.locator(LANGUAGE_SELECT).click()

    expect(await page.getByRole('option').first().textContent()).toContain('Deutsch')
  }, 60_000)

  it('logs no page error in any language', () => {
    expect(pageErrors).toEqual([])
  })
})
