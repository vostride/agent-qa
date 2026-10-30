/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, type BrowserContext, type Locator, type Page, type Worker } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordingFixture, zoomFixtureTab, type RecordingFixture } from './recording-dom-fixture.js'
import { cleanupTempRoots, trackTempRoot } from './spawned-chat.js'

// Below 768 CSS px the sidebar is an off-canvas sheet that must still open, in real Chromium.

type Box = { x: number; y: number; right: number; bottom: number; width: number; height: number }
type Placement = { box: Box | null; inViewport: boolean; hit: boolean; top?: string }
type Observation = {
  url: string
  innerWidth: number
  dpr: number
  controls: number
  control: Placement
  tabStop: number | null
  ring: { outline: string; boxShadow: string; visible: boolean } | null
  links: Record<string, Placement & { count: number }>
  afterEnter: { dialogs: number; active: string; pathname: string } | null
  sheetClosed: boolean | null
  focusReturned: boolean | null
  landed?: { pathname: string; dialogs: number; centre: string; pageVisible: boolean }
}

const TOP_LEVEL = ['Runs', 'Tests', 'Hooks', 'Suites', 'Insights', 'Config'] as const
const CONTROL_NAME = /navigation/i
const PRODUCT_TOUR_COOKIE = 'agent_qa_product_tour_state'
const TOUR_SKIPPED = encodeURIComponent(JSON.stringify({
  schemaVersion: 2, tourVersion: 'foundation-v1', skippedAt: '2026-10-04T00:00:00.000Z',
}))
const TESTS_READY = '[data-tour-id="tour-tests-table"]'

// app.tsx's `insights` route sets `handle: { hideHeader: true }`; it is the header-hidden page this
// file names. Run detail (`runs/:id`) hides the header too.
const HEADER_HIDDEN_ROUTE = '/insights'
const PAGES: Array<{ name: string; path: (runId: string) => string; ready: string }> = [
  { name: '/runs', path: () => '/runs', ready: '[data-tour-id="tour-runs-table"]' },
  { name: 'run detail', path: runId => `/runs/${encodeURIComponent(runId)}`, ready: '[data-verdict-badge]' },
  { name: '/tests', path: () => '/tests', ready: TESTS_READY },
  { name: 'Config > Models', path: () => '/config/models', ready: '[data-config-page]' },
  { name: `${HEADER_HIDDEN_ROUTE} (header hidden)`, path: () => HEADER_HIDDEN_ROUTE, ready: '[data-insights-page-root]' },
]
const NARROW = ['400x800', '390x844', 'zoom2-from-1280x800'] as const
const WIDE = '1280x800'

const failures: Record<string, string> = {}
const observations = new Map<string, Observation>()
const wide = new Map<string, { controls: number; links: Record<string, Placement & { count: number }> }>()
let fixture: RecordingFixture | undefined
let zoomContext: BrowserContext | undefined
const contexts: BrowserContext[] = []
const key = (page: string, view: string) => `${page} @ ${view}`

async function placement(locator: Locator): Promise<Placement> {
  if (await locator.count() === 0) return { box: null, inViewport: false, hit: false }
  return await locator.first().evaluate(element => {
    const r = element.getBoundingClientRect()
    const box = { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    const inViewport = r.width > 0 && r.height > 0 && r.x >= -0.5 && r.y >= -0.5
      && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5
    const top = inViewport ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null
    const hit = top !== null && (top === element || element.contains(top))
    const describe = (node: Element | null) => node
      ? `${node.tagName.toLowerCase()}${node.getAttribute('data-slot') ? `[data-slot=${node.getAttribute('data-slot')}]` : ''}[${(node.textContent ?? '').trim().slice(0, 32)}]`
      : 'none'
    return { box, inViewport, hit, ...(hit ? {} : { top: describe(top) }) }
  })
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function sheetLinks(page: Page) {
  const sheet = page.locator('[role="dialog"]')
  const links: Record<string, Placement & { count: number }> = {}
  for (const name of TOP_LEVEL) {
    const link = sheet.getByRole('link', { name, exact: true })
    links[name] = { count: await link.count(), ...await placement(link) }
  }
  return links
}

async function waitForSheet(page: Page) {
  // The sheet slides in over 500ms; read the links once every one of them has stopped inside the viewport.
  const deadline = Date.now() + 5_000
  let links = await sheetLinks(page)
  while (Date.now() < deadline && !Object.values(links).every(link => link.inViewport && link.hit)) {
    await page.waitForTimeout(100)
    links = await sheetLinks(page)
  }
  return links
}

async function focusRing(control: Locator) {
  const read = () => control.evaluate(element => {
    const style = getComputedStyle(element)
    const transparent = (color: string) => color === 'transparent' || /,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color)
    const shadows = style.boxShadow === 'none' ? [] : style.boxShadow.split(/,(?![^(]*\))/).map(part => part.trim())
    const shadowVisible = shadows.some(shadow => {
      const color = shadow.match(/^(?:[a-z]+\([^)]*\)|#[0-9a-f]+|[a-z]+)/i)?.[0] ?? ''
      const lengths = shadow.slice(color.length).trim().split(/\s+/).map(value => parseFloat(value))
      return !transparent(color) && ((lengths[2] ?? 0) > 0 || (lengths[3] ?? 0) > 0)
    })
    const outlineVisible = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && !transparent(style.outlineColor)
    return {
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
      boxShadow: style.boxShadow,
      visible: shadowVisible || outlineVisible,
    }
  })
  // Buttons transition their ring in; read it once it has landed, or after a bounded wait.
  const deadline = Date.now() + 2_000
  let ring = await read()
  while (!ring.visible && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    ring = await read()
  }
  return ring
}

async function observeNarrow(page: Page, url: string, pageName: string, view: string, zoom?: { worker: Worker; dpr: number }) {
  await page.goto(url)
  if (zoom) {
    await zoomFixtureTab(zoom.worker, url, 2)
    await page.waitForFunction(dpr => devicePixelRatio >= dpr * 1.99, zoom.dpr)
  }
  await page.locator(PAGES.find(entry => entry.name === pageName)!.ready).first().waitFor({ timeout: 30_000 })
  await settle(page)
  const control = page.getByRole('button', { name: CONTROL_NAME })
  const observation: Observation = {
    url, innerWidth: await page.evaluate(() => innerWidth), dpr: await page.evaluate(() => devicePixelRatio),
    controls: await control.count(), control: await placement(control),
    tabStop: null, ring: null, links: {}, afterEnter: null, sheetClosed: null, focusReturned: null,
  }

  // A page may have moved focus on load (Config focuses its active tab), and Chrome starts Tab from
  // wherever focus last was. A non-tabbable anchor at the start of <body> puts the start at the top.
  await page.evaluate(() => {
    const start = document.createElement('div')
    start.tabIndex = -1
    start.setAttribute('data-narrow-nav-start', '')
    document.body.prepend(start)
    start.focus()
    scrollTo(0, 0)
  })
  if (observation.controls > 0) {
    for (let stop = 1; stop <= 5; stop += 1) {
      await page.keyboard.press('Tab')
      if (await control.first().evaluate(element => element === document.activeElement)) {
        observation.tabStop = stop
        break
      }
    }
  }
  await page.evaluate(() => document.querySelector('[data-narrow-nav-start]')?.remove())
  if (observation.tabStop !== null) {
    observation.ring = await focusRing(control.first())
    await page.keyboard.press('Enter')
    observation.links = await waitForSheet(page)
    observation.afterEnter = await page.evaluate(() => ({
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      active: `${document.activeElement?.tagName.toLowerCase()}[${document.activeElement?.getAttribute('aria-label') ?? (document.activeElement?.textContent ?? '').trim().slice(0, 32)}]`,
      pathname: location.pathname,
    }))
    await page.keyboard.press('Escape')
    observation.sheetClosed = await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 3_000 })
      .then(() => true, () => false)
    observation.focusReturned = await page.waitForFunction(() => /navigation/i.test(
      document.activeElement?.getAttribute('aria-label') ?? '') && document.activeElement?.tagName === 'BUTTON',
    undefined, { timeout: 2_000 }).then(() => true, () => false)
  } else {
    observation.links = await sheetLinks(page)
  }

  if (pageName === '/runs' && observation.controls > 0) {
    // The pointer path: a touch tap on the 390 phone viewport, a mouse click elsewhere.
    if (view === '390x844') await control.first().tap()
    else await control.first().click()
    await waitForSheet(page)
    const tests = page.locator('[role="dialog"]').getByRole('link', { name: 'Tests', exact: true })
    if (view === '390x844') await tests.tap()
    else await tests.click()
    const pathname = await page.waitForURL(address => address.pathname === '/tests', { timeout: 10_000 })
      .then(() => '/tests', () => new URL(page.url()).pathname)
    await page.locator(TESTS_READY).first().waitFor({ timeout: 30_000 }).catch(() => undefined)
    await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 3_000 }).catch(() => undefined)
    // The page is usable once nothing sits over it: the viewport's centre belongs to the layout's inset.
    observation.landed = { pathname, ...await page.evaluate(() => {
      const centre = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
      return {
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        centre: centre ? `${centre.tagName.toLowerCase()}[data-slot=${centre.closest('[data-slot]')?.getAttribute('data-slot') ?? ''}]` : 'none',
        pageVisible: centre?.closest('[data-slot="sidebar-inset"]') !== null && centre !== null,
      }
    }) }
  }
  observations.set(key(pageName, view), observation)
}

describe('a visible navigation control below 768 CSS px on the shipped bundle', () => {
  beforeAll(async () => {
    try {
      fixture = await recordingFixture('narrow-navigation')
      const origin = fixture.dashboard.origin
      const runId = fixture.drive.runId
      const cookie = { name: PRODUCT_TOUR_COOKIE, value: TOUR_SKIPPED, url: origin }
      const errors: string[] = []

      for (const [view, options] of [
        ['400x800', { viewport: { width: 400, height: 800 } }],
        ['390x844', { viewport: { width: 390, height: 844 }, hasTouch: true }],
      ] as const) {
        const context = await fixture.browser.newContext(options)
        contexts.push(context)
        await context.addCookies([cookie])
        const page = await context.newPage()
        page.on('pageerror', error => errors.push(`${view}: ${String(error)}`))
        for (const entry of PAGES) {
          try {
            await observeNarrow(page, `${origin}${entry.path(runId)}`, entry.name, view)
          } catch (error) { failures[key(entry.name, view)] = String(error) }
        }
        await context.close()
      }

      // Real browser zoom: an MV3 extension calls `tabs.setZoom` on a 1280x800 tab, so 640 CSS px.
      const zoomRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-nav-zoom-')))
      const extension = join(zoomRoot, 'extension')
      mkdirSync(extension)
      writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3,
        name: 'Local navigation zoom probe', version: '1.0',
        host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' } }))
      writeFileSync(join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {})')
      zoomContext = await chromium.launchPersistentContext(join(zoomRoot, 'profile'), {
        channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      })
      await zoomContext.addCookies([cookie])
      const worker = zoomContext.serviceWorkers()[0] ?? await zoomContext.waitForEvent('serviceworker')
      const zoomPage = await zoomContext.newPage()
      zoomPage.on('pageerror', error => errors.push(`zoom: ${String(error)}`))
      await zoomPage.goto(`${origin}/runs`)
      const dpr = await zoomPage.evaluate(() => devicePixelRatio)
      for (const entry of PAGES) {
        try {
          await observeNarrow(zoomPage, `${origin}${entry.path(runId)}`, entry.name, 'zoom2-from-1280x800', { worker, dpr })
        } catch (error) { failures[key(entry.name, 'zoom2-from-1280x800')] = String(error) }
      }
      await zoomContext.close()
      zoomContext = undefined

      const desktop = await fixture.browser.newContext({ viewport: { width: 1280, height: 800 } })
      contexts.push(desktop)
      await desktop.addCookies([cookie])
      const page = await desktop.newPage()
      page.on('pageerror', error => errors.push(`${WIDE}: ${String(error)}`))
      for (const entry of PAGES) {
        try {
          await page.goto(`${origin}${entry.path(runId)}`)
          await page.locator(entry.ready).first().waitFor({ timeout: 30_000 })
          await settle(page)
          const sidebar = page.locator('[data-slot="sidebar"]')
          const links: Record<string, Placement & { count: number }> = {}
          for (const name of TOP_LEVEL) {
            const link = sidebar.getByRole('link', { name, exact: true })
            links[name] = { count: await link.count(), ...await placement(link) }
          }
          wide.set(entry.name, { controls: await page.getByRole('button', { name: CONTROL_NAME }).count(), links })
        } catch (error) { failures[key(entry.name, WIDE)] = String(error) }
      }
      await desktop.close()
      if (errors.length) failures.pageErrors = errors.join('\n')
    } catch (error) { failures.drive = String(error) }
  }, 600_000)

  afterAll(async () => {
    await zoomContext?.close().catch(() => undefined)
    for (const context of contexts) await context.close().catch(() => undefined)
    await fixture?.close()
    cleanupTempRoots()
  })

  it('the fixture drove a run and every page mounted without an uncaught error', () => {
    expect(failures, JSON.stringify(failures)).toEqual({})
    expect(observations.size).toBe(PAGES.length * NARROW.length)
  })

  for (const view of NARROW) {
    for (const entry of PAGES) {
      const name = `${entry.name} at ${view}`
      const read = () => {
        const observation = observations.get(key(entry.name, view))
        expect(observation, `${name} was never observed: ${JSON.stringify(failures)}`).toBeDefined()
        return observation!
      }

      it(`${name} shows a visible navigation control`, () => {
        const observation = read()
        const where = `${name} innerWidth=${observation.innerWidth} dpr=${observation.dpr}`
        expect(observation.innerWidth, `${where}: not below the 768 CSS px breakpoint`).toBeLessThan(768)
        expect(observation.controls, `${where}: no button named for navigation`).toBeGreaterThan(0)
        expect(observation.control.inViewport, `${where}: control box ${JSON.stringify(observation.control.box)} is not inside the viewport`).toBe(true)
        expect(observation.control.hit, `${where}: something covers the control's centre`).toBe(true)
      })

      it(`${name} the keyboard reaches it`, () => {
        const observation = read()
        expect(observation.tabStop, `${name}: Tab did not reach the control within 5 stops`).not.toBeNull()
        expect(observation.tabStop!).toBeLessThanOrEqual(5)
        expect(observation.ring?.visible, `${name}: no visible focus ring ${JSON.stringify(observation.ring)}`).toBe(true)
      })

      it(`${name} pressing it shows all six top-level links`, () => {
        const observation = read()
        for (const link of TOP_LEVEL) {
          const seen = observation.links[link]
          expect(seen?.count, `${name}: no ${link} link in the open navigation ${JSON.stringify(observation.links)} after Enter ${JSON.stringify(observation.afterEnter)}`).toBeGreaterThan(0)
          expect(seen!.inViewport, `${name}: ${link} ${JSON.stringify(seen!.box)} is not inside the viewport`).toBe(true)
          expect(seen!.hit, `${name}: ${link} ${JSON.stringify(seen!.box)} is covered at its centre by ${seen!.top}`).toBe(true)
        }
        if (entry.name === '/runs') {
          expect(observation.landed, `${name}: the pointer path was never taken`).toBeDefined()
          expect(observation.landed!.pathname, `${name}: clicking Tests did not land on /tests`).toBe('/tests')
          expect(observation.landed!.dialogs, `${name}: the navigation stayed open over the Tests page`).toBe(0)
          expect(observation.landed!.pageVisible, `${name}: the Tests page is covered after navigating by ${observation.landed!.centre}`).toBe(true)
        }
      })

      it(`${name} Escape closes it and returns focus`, () => {
        const observation = read()
        expect(observation.sheetClosed, `${name}: the navigation sheet did not close on Escape`).toBe(true)
        expect(observation.focusReturned, `${name}: focus did not return to the control`).toBe(true)
      })
    }
  }

  it(`no navigation control at 1280`, () => {
    expect(wide.size, JSON.stringify(failures)).toBe(PAGES.length)
    for (const [page, seen] of wide) expect(seen.controls, `${page} at ${WIDE}`).toBe(0)
  })

  it(`the six sidebar links are visible at 1280 without it`, () => {
    expect(wide.size, JSON.stringify(failures)).toBe(PAGES.length)
    for (const [page, seen] of wide) {
      for (const link of TOP_LEVEL) {
        expect(seen.links[link]?.count, `${page} at ${WIDE}: no ${link} sidebar link`).toBeGreaterThan(0)
        expect(seen.links[link]!.inViewport && seen.links[link]!.hit,
          `${page} at ${WIDE}: ${link} ${JSON.stringify(seen.links[link])} is not visible`).toBe(true)
      }
    }
  })
})
