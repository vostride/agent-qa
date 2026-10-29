/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordingFixture, zoomFixtureTab, type RecordingFixture } from './recording-dom-fixture.js'
import { populatedRunSpawnEnv, POPULATED_SECRET_ENV_VAR } from './populated-run-fixture.js'
import { cleanupTempRoots, reserveEphemeralPort, spawnDashboard, trackTempRoot } from './spawned-chat.js'

// Real producer + shipped bundle: the run is driven by the shipped runner and the header measured
// here is the one the built dashboard serves. Nothing is mocked, stubbed or skipped, and the
// captures are written only where AGENT_QA_425_CAPTURE_DIR points — never into 424's directory.
type Box = { x: number; y: number; right: number; bottom: number; width: number; height: number }
const overlaps = (a: Box, b: Box) => a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5
const inside = (a: Box, b: Box) => a.x >= b.x - 0.5 && a.right <= b.right + 0.5 && a.y >= b.y - 0.5 && a.bottom <= b.bottom + 0.5

type Item = { key: string; box: Box; clip: Box; contains: number[] }
type Text = { key: string; kind: 'badge' | 'indicator' | 'token' | 'duration' | 'other'; text: string; box: Box; fontSize: number; fontWeight: number }
type Geometry = {
  label: string
  innerWidth: number
  dpr: number
  header: Box
  badge: Box
  actions: Box
  items: Item[]
  texts: Text[]
  chipWords: string[]
  chipsState: string
  skipped: string | null
}

const failures: Record<string, string> = {}
const geometries: Geometry[] = []
let fixture: RecordingFixture | undefined
let reader: Awaited<ReturnType<typeof spawnDashboard>> | undefined
let zoomContext: BrowserContext | undefined
let zoom: { factor: number; beforeWidth: number; afterWidth: number; beforeDpr: number; afterDpr: number } | undefined
let settled = false

const at = (label: string) => geometries.find(geometry => geometry.label === label)
// WINDOWS #480's band: beside the 192px sidebar these pages leave the header 808px and 888px, past
// the old 768px step but too narrow for one row, and the analysis chip painted over the verdict.
const MID_WIDTHS = [1000, 1080]
const MID = MID_WIDTHS.map(width => `${width}x800`)
const LABELS = ['400x800', '1280x800', ...MID, 'zoom2-from-1280x800']
const STACKED = ['400x800', ...MID, 'zoom2-from-1280x800']
const DESKTOP = '1280x800'

async function headerClip(page: Page) {
  return await page.evaluate(() => {
    let header = document.querySelector('[data-verdict-badge]')!.parentElement
    while (header && !header.classList.contains('@container')) header = header.parentElement
    const rect = header!.getBoundingClientRect()
    // A screenshot clip is expressed in the SURFACE's pixels, not the page's. Under real browser
    // zoom one page CSS pixel is `devicePixelRatio` surface pixels, so an unscaled clip would crop
    // the zoomed header to its top-left quadrant — which is what the first 200% capture did.
    const scale = devicePixelRatio
    return { x: (rect.x + scrollX) * scale, y: (rect.y + scrollY) * scale, width: rect.width * scale, height: rect.height * scale }
  })
}

// The 425 capture directory is this plan's own. `capture` in recording-dom-fixture.ts is fixed to
// AGENT_QA_424_CAPTURE_DIR, and writing 425 evidence there would overwrite Phase 424's record.
async function captureHeader(page: Page, name: string) {
  const directory = process.env.AGENT_QA_425_CAPTURE_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  await page.screenshot({ path: join(directory, `${name}.png`), clip: await headerClip(page), animations: 'disabled' })
}

async function settle(page: Page) {
  await page.locator('[data-verdict-badge]').waitFor()
  await page.locator('[data-chips-state="chips"]').waitFor()
  await page.locator('[data-run-token-summary]').waitFor()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function measure(page: Page, label: string) {
  await settle(page)
  const geometry = await page.evaluate(() => {
    const box = (element: Element): Box => {
      const r = element.getBoundingClientRect()
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    }
    const badge = document.querySelector('[data-verdict-badge]')!
    let header = badge.parentElement
    while (header && !header.classList.contains('@container')) header = header.parentElement
    if (!header) throw new Error('No @container header block above the verdict badge')
    const rerun = header.querySelector('[aria-label="Re-run"]')!
    let actions: Element | null = rerun
    while (actions && !actions.classList.contains('ml-auto')) actions = actions.parentElement
    if (!actions) throw new Error('No ml-auto actions cluster around the Re-run button')

    const named = (element: Element) => {
      for (const attribute of ['data-verdict-badge', 'data-chip', 'data-chips-state', 'data-run-token-summary', 'data-run-duration']) {
        if (element.hasAttribute(attribute)) return `${attribute}=${element.getAttribute(attribute) || ''}`
      }
      return `${element.tagName.toLowerCase()}[${element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().slice(0, 24)}]`
    }
    const clipOf = (element: Element) => {
      for (let node = element.parentElement; node && node !== header; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.overflowX === 'hidden' || style.overflowY === 'hidden') return box(node)
      }
      return box(header!)
    }
    // querySelectorAll already returns each node once, so the union selector cannot double-count the
    // analysis indicator on the run where 425-09's door turns its root into a <button>.
    const collected = [...header.querySelectorAll('[data-verdict-badge], [data-chip], [data-chips-state="unavailable"], [data-run-token-summary], [data-run-duration], button, a')]
      .filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    const items = collected.map(element => ({
      key: named(element), box: box(element), clip: clipOf(element),
      contains: collected.flatMap((other, index) => other !== element && element.contains(other) ? [index] : []),
    }))

    const texts = [...header.querySelectorAll('*')]
      .filter(element => [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim()))
      .filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      .map(element => {
        const style = getComputedStyle(element)
        const kind = element.hasAttribute('data-verdict-badge') ? 'badge'
          : element.closest('[data-run-token-summary]') ? 'token'
          : element.closest('[data-run-duration]') ? 'duration'
          : element.closest('[data-chip], [data-chips-state]') ? 'indicator'
          : 'other'
        return { key: named(element), kind, text: (element.textContent ?? '').trim().slice(0, 48),
          box: box(element), fontSize: parseFloat(style.fontSize), fontWeight: Number(style.fontWeight) }
      })

    const chips = header.querySelector('[data-chips-state]')
    return {
      innerWidth, dpr: devicePixelRatio, header: box(header), badge: box(badge), actions: box(actions), items, texts,
      chipWords: [...header.querySelectorAll('[data-chip]')].map(chip => (chip.textContent ?? '').trim()),
      chipsState: chips?.getAttribute('data-chips-state') ?? 'absent',
      skipped: chips?.getAttribute('data-postprocessing-skipped') ?? null,
    }
  })
  geometries.push({ label, ...geometry } as unknown as Geometry)
}

describe('run header layout on the shipped bundle (425-10)', () => {
  beforeAll(async () => {
    try {
      fixture = await recordingFixture('header-layout')
      const origin = fixture.dashboard.origin
      // Let the post-run tail reach a terminal answer so the indicator words stop moving between
      // geometries. A chain that was skipped never leaves `pending`, so the loop is bounded and
      // its outcome is recorded rather than thrown — the geometry does not depend on it.
      for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
        const response = await fetch(`${origin}/api/runs/${encodeURIComponent(fixture.drive.runId)}/post-processing`)
        const body = await response.json() as { status?: { chips?: Record<string, string>; skipped?: unknown } }
        if (body.status?.skipped || ['analysis', 'curation'].every(key => ['complete', 'failed'].includes(body.status?.chips?.[key] ?? ''))) {
          settled = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      await fixture.dashboard.stop()
      const env = populatedRunSpawnEnv()
      // A cold reader without the planted credential environment: the fixture's synthetic values
      // stay masked, so the captures carry nothing this repository did not invent.
      delete env[POPULATED_SECRET_ENV_VAR]
      const port = await reserveEphemeralPort()
      reader = await spawnDashboard(fixture.project.root, fixture.project.configPath, port, 60_000, env)
      if (!reader.ready) throw new Error(reader.stderr())
      const url = `${reader.origin}/runs/${encodeURIComponent(fixture.drive.runId)}`

      const context = await fixture.browser.newContext({ viewport: { width: 400, height: 800 } })
      const page = await context.newPage()
      await page.goto(url)
      await measure(page, '400x800')
      await captureHeader(page, 'header-400')
      // SC2's visual half: the indicator states must read without colour. The measured half is
      // Plan 01's STAGE-INDICATOR-COLOUR-FREE cell; this is the picture beside it.
      const grayscale = await page.addStyleTag({ content: 'html { filter: grayscale(1) }' })
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await captureHeader(page, 'header-grayscale-400')
      await grayscale.evaluate(element => { (element as Element).remove() })

      await page.setViewportSize({ width: 1280, height: 800 })
      await measure(page, '1280x800')
      await captureHeader(page, 'header-1280')
      for (const width of MID_WIDTHS) {
        await page.setViewportSize({ width, height: 800 })
        await measure(page, `${width}x800`)
        await captureHeader(page, `header-${width}`)
      }
      await context.close()

      // Density and real browser zoom are separate checks. The temporary MV3 extension exists only
      // in an isolated test profile and uses Chrome's own setZoom/getZoom APIs.
      // https://playwright.dev/docs/chrome-extensions
      // https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom
      const zoomRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-425-zoom-')))
      const extension = join(zoomRoot, 'extension')
      mkdirSync(extension)
      writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3,
        name: 'Local header zoom probe', version: '1.0',
        host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' } }))
      writeFileSync(join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {})')
      zoomContext = await chromium.launchPersistentContext(join(zoomRoot, 'profile'), {
        channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      })
      const worker = zoomContext.serviceWorkers()[0] ?? await zoomContext.waitForEvent('serviceworker')
      const zoomPage = await zoomContext.newPage()
      await zoomPage.goto(url)
      const before = await zoomPage.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }))
      const factor = await zoomFixtureTab(worker, url, 2)
      await zoomPage.waitForFunction(dpr => devicePixelRatio >= dpr * 1.99, before.dpr)
      const after = await zoomPage.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }))
      zoom = { factor, beforeWidth: before.width, afterWidth: after.width, beforeDpr: before.dpr, afterDpr: after.dpr }
      await measure(zoomPage, 'zoom2-from-1280x800')
      await captureHeader(zoomPage, 'header-browser-200-percent')
      await zoomContext.close()
      zoomContext = undefined

      if (process.env.AGENT_QA_425_CAPTURE_DIR) {
        writeFileSync(join(process.env.AGENT_QA_425_CAPTURE_DIR, 'header-observation.json'),
          JSON.stringify({ runId: fixture.drive.runId, settled, zoom, geometries }, null, 2))
      }
    } catch (error) { failures.drive = String(error) }
  }, 360_000)

  afterAll(async () => { await zoomContext?.close(); await reader?.stop(); await fixture?.close(); cleanupTempRoots() })

  // WR-06: the precondition the poll above computes, asserted before any geometry reads it.
  it('HEADER-FIXTURE-SETTLED', () => {
    expect(settled,
      'the post-run chain never reached a terminal answer inside the 30s budget, so the 400px geometry, '
      + 'the grayscale capture, the 1280px geometry and the zoom geometry were each measured against '
      + 'indicator words that were still changing width — every claim below is about a different header. '
      + JSON.stringify(failures)).toBe(true)
  })

  it('HEADER-NO-OVERLAP', () => {
    expect(geometries.map(geometry => geometry.label), JSON.stringify(failures)).toEqual(LABELS)
    for (const geometry of geometries) {
      const where = `${geometry.label} innerWidth=${geometry.innerWidth} dpr=${geometry.dpr}`
      expect(geometry.items.length, where).toBeGreaterThan(4)
      for (const [index, item] of geometry.items.entries()) {
        expect(inside(item.box, item.clip), `${where}: ${item.key} ${JSON.stringify(item.box)} escapes its clip ${JSON.stringify(item.clip)}`).toBe(true)
        expect(inside(item.box, geometry.header), `${where}: ${item.key} ${JSON.stringify(item.box)} escapes the header ${JSON.stringify(geometry.header)}`).toBe(true)
        for (const [other, candidate] of geometry.items.entries()) {
          if (other <= index || item.contains.includes(other) || candidate.contains.includes(index)) continue
          expect(overlaps(item.box, candidate.box),
            `${where}: ${item.key} ${JSON.stringify(item.box)} overlaps ${candidate.key} ${JSON.stringify(candidate.box)}`).toBe(false)
        }
      }
    }
  })

  it('BADGE-DOMINANT-GEOMETRY', () => {
    expect(geometries.length, JSON.stringify(failures)).toBe(LABELS.length)
    for (const geometry of geometries) {
      const where = `${geometry.label} innerWidth=${geometry.innerWidth}`
      const badge = geometry.texts.find(text => text.kind === 'badge')
      expect(badge, `${where}: no text-bearing verdict badge`).toBeDefined()
      expect(badge!.fontSize, `${where}: badge font-size`).toBe(14)
      expect(badge!.fontWeight, `${where}: badge font-weight`).toBe(500)
      for (const text of geometry.texts) {
        if (text === badge) continue
        expect(badge!.box.height >= text.box.height - 0.5,
          `${where}: badge height ${badge!.box.height} is not at least ${text.key} height ${text.box.height}`).toBe(true)
        if (text.kind === 'indicator' || text.kind === 'token' || text.kind === 'duration') {
          expect(text.fontSize, `${where}: ${text.kind} ${text.key} font-size`).toBe(12)
        }
      }
      // D-02's subordination is only a claim if the subordinate set is actually on the page.
      for (const kind of ['indicator', 'token', 'duration'] as const) {
        expect(geometry.texts.some(text => text.kind === kind), `${where}: no ${kind} text measured`).toBe(true)
      }
    }
  })

  it('HEADER-STACKS-WHERE-WIDTH-RUNS-OUT', () => {
    expect(geometries.length, JSON.stringify(failures)).toBe(LABELS.length)
    expect(zoom?.factor, JSON.stringify(failures)).toBe(2)
    expect(zoom!.afterWidth).toBe(zoom!.beforeWidth / 2)
    expect(zoom!.afterDpr).toBe(zoom!.beforeDpr * 2)
    for (const label of STACKED) {
      const geometry = at(label)!
      expect(geometry.actions.y >= geometry.badge.bottom - 0.5,
        `${label} innerWidth=${geometry.innerWidth}: actions top ${geometry.actions.y} is not below badge bottom ${geometry.badge.bottom}`).toBe(true)
    }
    const desktop = at(DESKTOP)!
    expect(desktop.actions.y < desktop.badge.bottom - 0.5 && desktop.badge.y < desktop.actions.bottom - 0.5,
      `${DESKTOP} innerWidth=${desktop.innerWidth}: badge ${JSON.stringify(desktop.badge)} and actions ${JSON.stringify(desktop.actions)} do not share a row`).toBe(true)
  })
})
