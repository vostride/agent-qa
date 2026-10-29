/// <reference lib="dom" />
// The DOM lib is referenced here because this file's `page.evaluate` callbacks run in a browser.

// THE LIVE PREVIEW'S STATUS ON THE SHIPPED PAGE (428 SC2/SC3, D-02/D-13/D-15/D-16 · PXH-LIVE-02/03).
//
// jsdom proved the status's contract in `live-preview.test.tsx`: one dot, its name, its tooltip,
// the snapshot label, the reduced-motion rule. jsdom computes no animation and lays nothing out, so
// every claim here is made again on the BUILT dashboard-ui bundle, served by the production
// `startServer` and driven by a real headless Chromium: one green dot and nothing on the live page
// animating (owner decision 2026-09-26 (5), G-428-5), a dot floating alone at the preview's top-right,
// outside the chrome and clear of the picture (owner decision 2026-09-26 (6)), amber when frames
// stop while the bus keeps heartbeating, and the literal snapshot label when the frames are
// snapshots.
//
// THE RUN IS PLANTED AND THE SERVER IS NOT (see `live-view-fixture.ts`). Every word a cell expects
// is read out of `lib/live-preview.ts`, so a copy change that forgets these cells turns them red.
//
// A BROWSER THAT CANNOT LAUNCH IS A RED, NEVER A SKIP. Captures go only where
// AGENT_QA_428_CAPTURE_DIR points.

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DASHBOARD_ANCHORED_BUILDS,
  PACKAGES_ROOT,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  dashboardUiDist,
} from './spawned-chat.js'
import { plantLiveRun, publishTo, startLiveViewHarness } from './live-view-fixture.js'
import type { LiveViewHarness, PlantLiveRunInput, PlantedLiveRun } from './live-view-fixture.js'
import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

const BROWSER_INSTALL_INSTRUCTION =
  'these cells drive the BUILT dashboard UI in a real Chromium: run '
  + '`pnpm exec playwright install chromium` and re-run. They must not be skipped when the browser '
  + 'is absent.'

const CAPTURE_DIR_ENV = 'AGENT_QA_428_CAPTURE_DIR'
const DESKTOP = { width: 1280, height: 800 }
const NARROW = { width: 400, height: 800 }

/** A published sentence, read out of the dashboard-ui source that publishes it. */
function publishedSentence(relativePath: string, name: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, 'dashboard-ui', 'src', relativePath), 'utf8')
  const match = new RegExp(`${name}\\s*=\\s*'([^']+)'`, 'u').exec(source)
  if (match === null) throw new Error(`${name} is no longer an exported single-quoted literal in ${relativePath}`)
  return match[1] as string
}

/** One member of a published `{ key: '...' }` table, read the same way. */
function publishedMember(relativePath: string, table: string, key: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, 'dashboard-ui', 'src', relativePath), 'utf8')
  const body = new RegExp(`${table}\\s*=\\s*\\{([^}]*)\\}`, 'u').exec(source)
  if (body === null) throw new Error(`${table} is no longer an exported object literal in ${relativePath}`)
  const match = new RegExp(`(?:^|[\\s,{])'?${key}'?\\s*:\\s*'([^']+)'`, 'u').exec(body[1] as string)
  if (match === null) throw new Error(`${table}.${key} is no longer a single-quoted literal in ${relativePath}`)
  return match[1] as string
}

const SNAPSHOT_PREVIEW_LABEL = publishedSentence('lib/live-preview.ts', 'SNAPSHOT_PREVIEW_LABEL')
const PREVIEW_DELAYED_TEXT = publishedSentence('lib/live-preview.ts', 'PREVIEW_DELAYED_TEXT')
const GREEN_NAME = publishedMember('lib/live-preview.ts', 'LIVE_DOT_NAMES', 'green')
const GREEN_MEANING = publishedMember('lib/live-preview.ts', 'LIVE_DOT_MEANINGS', 'green')
const AMBER_NAME = publishedMember('lib/live-preview.ts', 'LIVE_DOT_NAMES', 'amber')

/** SC3: the freshness window (5 s) plus the corner's 1 s clock and one 500 ms report, with margin. */
const STALL_TO_AMBER_BUDGET_MS = 7_000
const RESUME_TO_GREEN_BUDGET_MS = 3_000
const STALL_HEARTBEAT_MS = 1_000

const DOT_RUN = 'r_428_dot'
const SNAPSHOT_RUN = 'r_428_snapshot'
const FALLBACK_RUN = 'r_428_fallback'

interface PreviewFixture {
  readonly harness: LiveViewHarness
  readonly browser: Browser
  readonly jpeg: Uint8Array
  readonly png: Uint8Array
}

let fixture: PreviewFixture | undefined
const plantedRuns: PlantedLiveRun[] = []

function held(): PreviewFixture {
  if (fixture === undefined) throw new Error('the 428 live preview fixture never came up')
  return fixture
}

/** Plant a one-member run whose member has started a step, so the page has a running row. */
function plantStreamingRun(input: PlantLiveRunInput): PlantedLiveRun {
  const run = plantLiveRun(input)
  plantedRuns.push(run)
  held().harness.plant(run)
  publishTo(run, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] })
  publishTo(run, 'testStarted', { testId: 't0', testIndex: 0, name: 'the preview member', totalSteps: 2 })
  publishTo(run, 'stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'open the page' })
  return run
}

beforeAll(async () => {
  expect(buildFreshness(DASHBOARD_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
    .toEqual({ missing: [], stale: [] })

  let browser: Browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    throw new Error(
      `${BROWSER_INSTALL_INSTRUCTION} underlying error: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // Real, decodable bytes from the browser itself: a literal would paint nothing.
  const shotPage = await browser.newPage()
  await shotPage.setViewportSize({ width: 640, height: 400 })
  await shotPage.setContent('<body style="background:#123456"><h1>live</h1></body>')
  const jpeg = new Uint8Array(await shotPage.screenshot({ type: 'jpeg', quality: 40 }))
  const png = new Uint8Array(await shotPage.screenshot({ type: 'png' }))
  await shotPage.close()

  const harness = await startLiveViewHarness({ label: '428-23-preview', uiDir: dashboardUiDist() })
  fixture = { harness, browser, jpeg, png }

  plantStreamingRun({
    runId: DOT_RUN,
    heartbeatMs: 10_000,
    capability: { kind: 'cdp-screencast' },
    frameBytes: jpeg,
  })
  plantStreamingRun({
    runId: SNAPSHOT_RUN,
    heartbeatMs: 10_000,
    capability: { kind: 'snapshot' },
    frameBytes: png,
    frameKind: 'snapshot',
  })
  // The hub's fallback seat (428-04): a screencast is declared, and the frames that arrive are
  // snapshots. The label must follow the frames, not the declaration.
  plantStreamingRun({
    runId: FALLBACK_RUN,
    heartbeatMs: 10_000,
    capability: { kind: 'cdp-screencast' },
    frameBytes: png,
    frameKind: 'snapshot',
  })
}, 180_000)

afterAll(async () => {
  const open = fixture
  fixture = undefined
  if (open !== undefined) {
    await open.harness.close()
    await open.browser.close()
  }
  for (const run of plantedRuns) run.close()
  plantedRuns.length = 0
  cleanupTempRoots()
})

/** Open the live page for one run in a fresh context, and close it afterwards. */
async function onLivePage<T>(
  runId: string,
  body: (page: Page) => Promise<T>,
  viewport: { width: number; height: number } = DESKTOP,
): Promise<T> {
  const context = await held().browser.newContext({ viewport })
  try {
    const page = await context.newPage()
    await page.goto(`${held().harness.origin}/runs/${encodeURIComponent(runId)}/live`)
    return await body(page)
  } finally {
    await context.close()
  }
}

async function waitForGreen(page: Page): Promise<void> {
  await page.locator('[data-preview-state="live"]').waitFor({ state: 'attached', timeout: 40_000 })
  await page.locator('[data-live-dot="green"]').waitFor({ state: 'attached', timeout: 10_000 })
}

/** The corner's reading at this instant, without Playwright's implicit waits. */
async function cornerReading(page: Page): Promise<{ state: string | null; dot: string | null; words: string | null; label: string | null }> {
  return page.evaluate(() => ({
    state: document.querySelector('[data-preview-state]')?.getAttribute('data-preview-state') ?? null,
    dot: document.querySelector('[data-live-dot]')?.getAttribute('data-live-dot') ?? null,
    words: document.querySelector('[data-preview-words]')?.textContent ?? null,
    label: document.querySelector('[data-snapshot-label]')?.textContent ?? null,
  }))
}

// Since 2026-09-26 (428-34, G-428-4) a capture is the whole preview, chrome and picture, because
// the status sits in the chrome above the picture; it was the picture's box alone.
async function capture(page: Page, name: string): Promise<void> {
  const directory = process.env[CAPTURE_DIR_ENV]
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  await page.locator('[data-live-preview]').first()
    .screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' })
}

/** How many frames the embed document says it painted, or -1 while there is no embed document. */
async function embedFramesPainted(page: Page): Promise<number> {
  const frame = page.frames().find((one) => one.url().includes('/live/'))
  if (frame === undefined) return -1
  return frame.evaluate(() =>
    Number(document.querySelector('[data-embed-state]')?.getAttribute('data-embed-frames') ?? '-1'),
  ).catch(() => -1)
}

/** The positive control for the stillness cells: a running row and an embed that has painted. */
async function waitForRunningRowAndPaint(page: Page): Promise<number> {
  await page.locator('[data-live-pane="steps"] li[data-step-status="running"]').first()
    .waitFor({ state: 'attached', timeout: 20_000 })
  const deadline = Date.now() + 20_000
  let painted = await embedFramesPainted(page)
  while (painted <= 0 && Date.now() < deadline) {
    await page.waitForTimeout(100)
    painted = await embedFramesPainted(page)
  }
  return painted
}

interface Box { x: number; y: number; width: number; height: number }

interface StatusGeometry {
  section: Box
  area: Box
  frame: Box
  dot: Box
  chrome: Box | null
  dotInCorner: boolean
  dotInChrome: boolean
  dotInFrame: boolean
}

/** The preview container, the preview area, its chrome row, the picture's box and the dot, read in one pass. */
async function statusGeometry(page: Page): Promise<StatusGeometry> {
  const reading = await page.evaluate(() => {
    const box = (node: Element | null) => {
      if (node === null) return null
      const rect = node.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const chrome = document.querySelector('[data-live-preview] [data-preview-chrome]')
    const corner = document.querySelector('[data-live-preview] [data-preview-dot-corner]')
    const frame = document.querySelector('[data-preview-frame]')
    const dot = document.querySelector('[data-live-dot]')
    return {
      section: box(document.querySelector('[data-live-preview]')),
      area: box(corner?.parentElement ?? null),
      frame: box(frame),
      dot: box(dot),
      chrome: box(chrome),
      dotInCorner: corner !== null && dot !== null && corner.contains(dot),
      dotInChrome: chrome !== null && dot !== null && chrome.contains(dot),
      dotInFrame: frame !== null && dot !== null && frame.contains(dot),
    }
  })
  const { section, area, frame, dot } = reading
  if (section === null || area === null || frame === null || dot === null) {
    throw new Error(`no box: ${JSON.stringify(reading)}`)
  }
  return { ...reading, section, area, frame, dot }
}

/** Owner decision 2026-09-26 (6): alone at the preview area's top-right, no chrome row, never over the picture. */
function expectDotTopRightOfContainer(geometry: StatusGeometry, label: string): void {
  const { section, area, frame, dot } = geometry
  const context = `${label}: ${JSON.stringify(geometry)}`
  expect(frame.width, `${context} — the picture has a size`).toBeGreaterThan(40)
  expect(geometry.chrome, `${context} — a bare live frame renders no chrome row`).toBeNull()
  expect(geometry.dotInCorner, `${context} — the dot is in its own corner`).toBe(true)
  expect(geometry.dotInChrome, `${context} — the dot is not in the chrome`).toBe(false)
  expect(geometry.dotInFrame, `${context} — the dot is not in the picture's box`).toBe(false)
  const right = area.x + area.width - (dot.x + dot.width)
  expect(right, `${context} — right edge of the preview area`).toBeLessThanOrEqual(24)
  expect(right, context).toBeGreaterThanOrEqual(0)
  expect(dot.x + dot.width, `${context} — inside the container`).toBeLessThanOrEqual(section.x + section.width)
  expect(dot.y - area.y, `${context} — top of the preview area`).toBeLessThanOrEqual(24)
  expect(dot.y - area.y, context).toBeGreaterThanOrEqual(0)
  expect(dot.y, `${context} — inside the container`).toBeGreaterThanOrEqual(section.y)
  const intersects = dot.x < frame.x + frame.width && frame.x < dot.x + dot.width
    && dot.y < frame.y + frame.height && frame.y < dot.y + dot.height
  expect(intersects, `${context} — the dot's box meets the picture's box`).toBe(false)
}

describe('the live preview corner on the shipped bundle (428-23 Task 1)', () => {
  // The dot is plain and the running glyph is still: the cell reads every element of both panes,
  // and their pseudo-elements, and expects no animation at all.
  it('NO-ANIMATION-ON-LIVE-PAGE: one green dot, and nothing in either live pane animates', async () => {
    await onLivePage(DOT_RUN, async (page) => {
      await waitForGreen(page)
      const painted = await waitForRunningRowAndPaint(page)
      const census = await page.evaluate(() => {
        const panes = [...document.querySelectorAll('[data-live-pane]')]
        const animated: { pane: string | null; node: string; pseudo: string; name: string }[] = []
        let inspected = 0
        for (const pane of panes) {
          for (const node of [pane, ...pane.querySelectorAll('*')]) {
            for (const pseudo of ['', '::before', '::after']) {
              inspected += 1
              const name = getComputedStyle(node, pseudo === '' ? null : pseudo).animationName
              if (name !== 'none') {
                animated.push({
                  pane: pane.getAttribute('data-live-pane'),
                  node: `${node.tagName}.${node.getAttribute('class') ?? ''}`,
                  pseudo,
                  name,
                })
              }
            }
          }
        }
        return {
          panes: panes.map((pane) => pane.getAttribute('data-live-pane')).sort(),
          inspected,
          animated,
          dots: [...document.querySelectorAll('[data-live-dot]')].map((dot) => dot.getAttribute('data-live-dot')),
          runningRows: document.querySelectorAll('[data-live-pane="steps"] li[data-step-status="running"]').length,
          embeds: document.querySelectorAll('[data-live-pane="preview"] [data-live-embed]').length,
        }
      })
      const context = JSON.stringify({ ...census, painted })

      expect(census.panes, context).toEqual(['preview', 'steps'])
      expect(census.dots, context).toEqual(['green'])
      expect(census.runningRows, `${context} — the control: a running row is on the page`).toBeGreaterThanOrEqual(1)
      expect(census.embeds, `${context} — the control: the embed is on the page`).toBe(1)
      expect(painted, `${context} — the control: the embed painted a frame`).toBeGreaterThan(0)
      expect(census.animated, context).toEqual([])
    })
  }, 120_000)

  it('DOT-NAME-AND-FOCUSABLE-TOOLTIP: the dot is a named button, Tab reaches it, and focus shows its meaning', async () => {
    await onLivePage(DOT_RUN, async (page) => {
      await waitForGreen(page)
      const named = page.getByRole('button', { name: GREEN_NAME })
      expect(await named.count()).toBe(1)
      expect(await named.getAttribute('data-live-dot')).toBe('green')

      const walked: string[] = []
      let focused = false
      for (let press = 0; press < 80 && !focused; press += 1) {
        await page.keyboard.press('Tab')
        const active = await page.evaluate(() => {
          const node = document.activeElement
          return {
            dot: node?.hasAttribute('data-live-dot') ?? false,
            name: node === null ? 'null' : `${node.tagName}${node.getAttribute('aria-label') === null ? '' : `[${node.getAttribute('aria-label') ?? ''}]`}`,
          }
        })
        walked.push(active.name)
        focused = active.dot
      }
      expect(focused, `Tab never reached the dot; focus walked ${JSON.stringify(walked)}`).toBe(true)

      const tooltip = page.locator('[data-slot="tooltip-content"]:not([data-state="closed"])')
      await tooltip.first().waitFor({ state: 'visible', timeout: 5_000 })
      expect(await tooltip.first().textContent()).toContain(GREEN_MEANING)
    })
  }, 120_000)

  // RE-SPELLED 2026-09-26 (428-34, owner decision 2026-09-26 (4), G-428-4). This cell was
  // CORNER-ON-PICTURE, "the dot sits inside the picture's box, in its top-right quarter". The owner
  // saw the dot cover the tested page's own header and asked for it "at the top left of the browser
  // container", so the dot is measured against the preview container and its chrome, clear of the
  // picture, at both widths.
  //
  // RE-SPELLED 2026-09-26 (owner decision 2026-09-26 (6)). Was "DOT-TOP-LEFT-OF-CONTAINER: the dot
  // is in the chrome at the container's top-left, ...". The dot left the chrome row for its own
  // corner at the preview area's top-right, and a bare live frame renders no chrome row at all.
  it('DOT-TOP-RIGHT-OF-CONTAINER: the dot floats alone at the preview\'s top-right with no chrome row, and its box never meets the picture\'s', async () => {
    await onLivePage(DOT_RUN, async (page) => {
      await waitForGreen(page)
      const geometry = await statusGeometry(page)
      expectDotTopRightOfContainer(geometry, '1280')
      await capture(page, '428-corner-healthy-1280')
    })
    await onLivePage(DOT_RUN, async (page) => {
      await waitForGreen(page)
      const geometry = await statusGeometry(page)
      expectDotTopRightOfContainer(geometry, '400')
      await capture(page, '428-corner-healthy-400')
    }, NARROW)
  }, 120_000)

  it('STALL-TURNS-AMBER-WHILE-HEARTBEAT-CONTINUES: frames stop, the bus heartbeats, the dot goes amber', async () => {
    const run = plantStreamingRun({
      runId: 'r_428_stall',
      heartbeatMs: STALL_HEARTBEAT_MS,
      capability: { kind: 'cdp-screencast' },
      frameBytes: held().jpeg,
    })
    await onLivePage(run.runId, async (page) => {
      await waitForGreen(page)

      const beatsBefore = run.heartbeatsSeen()
      const framesBefore = run.deliveredFrameIds().length
      const stalledAt = Date.now()
      run.stall()
      let amber = await cornerReading(page)
      while (Date.now() - stalledAt < STALL_TO_AMBER_BUDGET_MS) {
        amber = await cornerReading(page)
        if (amber.dot === 'amber' && amber.words === PREVIEW_DELAYED_TEXT) break
        await page.waitForTimeout(100)
      }
      const amberAfterMs = Date.now() - stalledAt
      const beatsDuring = run.heartbeatsSeen() - beatsBefore
      const framesDuring = run.deliveredFrameIds().length - framesBefore
      const context = JSON.stringify({ amber, amberAfterMs, beatsDuring, framesDuring })

      expect(amber.dot, context).toBe('amber')
      expect(amber.state, context).toBe('delayed')
      expect(amber.words, context).toBe(PREVIEW_DELAYED_TEXT)
      expect(await page.getByRole('button', { name: AMBER_NAME }).count(), context).toBe(1)
      expect(beatsDuring, `${context} — the bus kept heartbeating through the stall`).toBeGreaterThan(0)
      expect(framesDuring, `${context} — no frame was produced while stalled`).toBe(0)
      await capture(page, '428-corner-delayed-1280')

      const resumedAt = Date.now()
      run.resume()
      let green = await cornerReading(page)
      while (Date.now() - resumedAt < RESUME_TO_GREEN_BUDGET_MS) {
        green = await cornerReading(page)
        if (green.dot === 'green') break
        await page.waitForTimeout(100)
      }
      const greenAfterMs = Date.now() - resumedAt
      const resumed = JSON.stringify({ green, greenAfterMs })
      expect(green.dot, resumed).toBe('green')
      expect(green.state, resumed).toBe('live')
    })
  }, 120_000)

  it('SNAPSHOT-LABEL-ON-SNAPSHOT-FRAMES: snapshot frames carry the literal label beside the dot', async () => {
    expect(SNAPSHOT_PREVIEW_LABEL).toBe('Snapshot preview · updates every 1s')
    await onLivePage(SNAPSHOT_RUN, async (page) => {
      await waitForGreen(page)
      const label = page.locator('[data-preview-corner] [data-snapshot-label]')
      await label.waitFor({ state: 'attached', timeout: 10_000 })
      expect(await label.textContent()).toBe(SNAPSHOT_PREVIEW_LABEL)
      await capture(page, '428-corner-snapshot-1280')
    })
    await onLivePage(SNAPSHOT_RUN, async (page) => {
      await waitForGreen(page)
      const label = page.locator('[data-preview-corner] [data-snapshot-label]')
      await label.waitFor({ state: 'attached', timeout: 10_000 })
      expect(await label.textContent()).toBe(SNAPSHOT_PREVIEW_LABEL)
      await capture(page, '428-corner-snapshot-400')
    }, NARROW)
  }, 120_000)

  it('SNAPSHOT-LABEL-ON-FALLBACK-FRAMES: a declared screencast whose frames are snapshots is labelled', async () => {
    await onLivePage(FALLBACK_RUN, async (page) => {
      await waitForGreen(page)
      let reading = await cornerReading(page)
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && reading.label === null) {
        await page.waitForTimeout(100)
        reading = await cornerReading(page)
      }
      expect(reading.label, JSON.stringify(reading)).toBe(SNAPSHOT_PREVIEW_LABEL)
    })
  }, 120_000)

  it('NO-LABEL-ON-SCREENCAST: screencast frames show the green dot and no snapshot label', async () => {
    await onLivePage(DOT_RUN, async (page) => {
      await waitForGreen(page)
      const readings: Awaited<ReturnType<typeof cornerReading>>[] = []
      for (let sample = 0; sample < 10; sample += 1) {
        readings.push(await cornerReading(page))
        await page.waitForTimeout(200)
      }
      const context = JSON.stringify(readings)
      for (const reading of readings) {
        expect(reading.dot, context).toBe('green')
        expect(reading.label, context).toBeNull()
      }
      expect(await page.locator('[data-snapshot-label]').count(), context).toBe(0)
    })
  }, 120_000)

  // RE-SPELLED 2026-09-26 (428-32, owner decision 2026-09-26 (5), G-428-5). This cell was
  // REDUCED-MOTION-DOT-STILL, "under prefers-reduced-motion the green dot does not animate", whose
  // control was that the same dot pulsed without the preference. Both readings are now still, for
  // the dot and for the running glyph.
  it('DOT-STILL-UNDER-ANY-MOTION-PREFERENCE: the green dot and the running glyph are still with and without reduced motion', async () => {
    await onLivePage(DOT_RUN, async (page) => {
      await waitForGreen(page)
      await waitForRunningRowAndPaint(page)
      const read = async (): Promise<{ reduce: boolean; dot: string; glyph: string }> => ({
        reduce: await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
        dot: await page.locator('[data-live-dot="green"] [data-live-dot-mark]')
          .evaluate((node) => getComputedStyle(node).animationName),
        glyph: await page.locator('[data-live-pane="steps"] li[data-step-status="running"] svg').first()
          .evaluate((node) => getComputedStyle(node).animationName),
      })
      const before = await read()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const after = await read()
      const context = JSON.stringify({ before, after })
      expect(before, context).toEqual({ reduce: false, dot: 'none', glyph: 'none' })
      expect(after, context).toEqual({ reduce: true, dot: 'none', glyph: 'none' })
    })
  }, 120_000)
})
