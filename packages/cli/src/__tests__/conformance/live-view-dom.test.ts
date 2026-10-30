/// <reference lib="dom" />
// The DOM lib is referenced HERE because this file's `page.evaluate` callbacks are compiled as
// TypeScript and EXECUTED in a browser — `dashboard-dom.test.ts`'s reasoning, unchanged.

// Every claim is about the built bundle in real Chromium; the timing cells run in real time.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { chromium } from 'playwright-core'
import type { Browser, Frame, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DASHBOARD_ANCHORED_BUILDS,
  PACKAGES_ROOT,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  dashboardUiDist,
} from './spawned-chat.js'
import {
  plantLiveRun,
  publishTo,
  readOneStream,
  startLiveViewHarness,
} from './live-view-fixture.js'
import type { LiveViewHarness, PlantedLiveRun } from './live-view-fixture.js'
import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

const BROWSER_INSTALL_INSTRUCTION =
  'these cells drive the BUILT dashboard UI in a real Chromium: run '
  + '`pnpm exec playwright install chromium` and re-run. THEY MUST NOT BE SKIPPED WHEN THE BROWSER '
  + 'IS ABSENT — they are the only cells in this repository that measure the live surface in the '
  + 'medium a person actually sees.'

// One sentinel per payload field, so a leak names its field; each is absent from the page.
const SENTINEL_REASONING = 'SENTINEL-REASONING-7f3a'
const SENTINEL_ACTION = 'SENTINEL-ACTION-9c1e'

// Extracted from source: importing a `.tsx` drags a renderer in, and a copied sentence goes stale.
function publishedSentence(relativePath: string, name: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, 'dashboard-ui', 'src', relativePath), 'utf8')
  const match = new RegExp(`${name}\\s*=\\s*'([^']+)'`, 'u').exec(source)
  if (match === null) throw new Error(`${name} is no longer an exported single-quoted literal in ${relativePath}`)
  return match[1] as string
}

const NO_STREAM_TEXT = publishedSentence('lib/live-preview.ts', 'NO_STREAM_TEXT')
/**
 * Long enough to cover more than one not-yet retry period, so "the sentence did not flicker" is a
 * claim about a window the poll would have fired in twice rather than one lucky sample.
 */
const NO_STREAM_SETTLE_MS = 6_000
const DID_NOT_RUN_NOTE = publishedSentence('lib/run-stream-reducer.ts', 'DID_NOT_RUN_NOTE')

interface DomFixture {
  readonly harness: LiveViewHarness
  readonly browser: Browser
  readonly dom: PlantedLiveRun
  readonly none: PlantedLiveRun
  /** Real, decodable JPEG bytes, minted once by the browser itself in `beforeAll`. */
  readonly jpeg: Uint8Array
}

let fixture: DomFixture | undefined
const plantedRuns: PlantedLiveRun[] = []

function held(): DomFixture {
  if (fixture === undefined) throw new Error('the live-view DOM fixture never came up')
  return fixture
}

/** Every `/api/run-stream/` request one page made — one entry per ATTACH, so a reconnect shows. */
function trackAttaches(page: Page): string[] {
  const attaches: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/run-stream/')) attaches.push(request.url())
  })
  return attaches
}

/** Open a page on the live surface for one run and hand it to the body, closing it afterwards. */
async function onLivePage<T>(runId: string, body: (page: Page, attaches: string[]) => Promise<T>): Promise<T> {
  const page = await held().browser.newPage()
  const attaches = trackAttaches(page)
  try {
    await page.goto(`${held().harness.origin}/runs/${encodeURIComponent(runId)}/live`)
    return await body(page, attaches)
  } finally {
    await page.close()
  }
}

/**
 * The embed document's own frame, as a real `Frame` rather than a `FrameLocator`.
 *
 * THE IFRAME IS CROSS-ORIGIN BY CONSTRUCTION — `sandbox="allow-scripts"` withholds
 * `allow-same-origin`, so the embedded document sits in an opaque origin the parent cannot read.
 * Playwright reaches it through the page's frame list, which is what lets a cell assert on a
 * document the dashboard itself is deliberately unable to see.
 */
async function liveEmbedFrame(page: Page, budgetMs = 30_000): Promise<Frame> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const found = page.frames().find((frame) => frame.url().includes('/live/'))
    if (found !== undefined) return found
    await page.waitForTimeout(100)
  }
  throw new Error(`no embed frame appeared within ${String(budgetMs)}ms; frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`)
}

beforeAll(async () => {
  // FIRST, AND BEFORE ANYTHING IS SERVED. `uiDir` points at `dashboard-ui/dist`; a stale bundle
  // passes every cell below while certifying the previous revision.
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

  // REAL, DECODABLE JPEG BYTES, produced by the browser itself. A literal or a hand-built buffer
  // would fail `createImageBitmap` in the embed page and `data-embed-frames` would stay at 0 while
  // the socket looked perfectly healthy — a red that reads like a transport defect and is a
  // fixture defect.
  const shotPage = await browser.newPage()
  await shotPage.setViewportSize({ width: 640, height: 400 })
  await shotPage.setContent('<body style="background:#123456"><h1>live</h1></body>')
  const shot = await shotPage.screenshot({ type: 'jpeg', quality: 40 })
  await shotPage.close()
  const jpeg = new Uint8Array(shot)

  const harness = await startLiveViewHarness({ label: 'dom', uiDir: dashboardUiDist() })

  const dom = plantLiveRun({
    runId: 'r_dom',
    heartbeatMs: 10_000,
    capability: { kind: 'cdp-screencast' },
    frameBytes: jpeg,
    frameWidth: 640,
    frameHeight: 400,
  })
  const none = plantLiveRun({ runId: 'r_none', heartbeatMs: 10_000, capability: { kind: 'none' } })
  plantedRuns.push(dom, none)
  harness.plant(dom)
  harness.plant(none)

  publishTo(dom, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] })
  publishTo(dom, 'testStarted', { testId: 't0', testIndex: 0, name: 'the surface member', totalSteps: 2 })
  publishTo(none, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] })
  publishTo(none, 'testStarted', { testId: 't0', testIndex: 0, name: 'the browserless member', totalSteps: 1 })

  fixture = { harness, browser, dom, none, jpeg }
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

/**
 * The pane's current state word, read WITHOUT Playwright's implicit element wait.
 *
 * `locator.getAttribute()` waits up to its own timeout for the element to exist, which would turn
 * "the pane says nothing yet" into a thirty-second stall inside a poll. `evaluate` answers with
 * whatever the document holds at this instant, which is what a reading is.
 */
async function previewWord(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector('[data-preview-state]')?.getAttribute('data-preview-state') ?? null,
  )
}

/** Poll until the pane leaves `loading` (its transient first render, once `minting`), then report what it settled on. */
async function settledPreviewWord(page: Page, budgetMs = 20_000): Promise<string | null> {
  const deadline = Date.now() + budgetMs
  let seen = await previewWord(page)
  while (Date.now() < deadline) {
    seen = await previewWord(page)
    if (seen !== null && seen !== 'loading') return seen
    await page.waitForTimeout(100)
  }
  return seen
}

/**
 * Poll until the pane reads `want`, and report the word it ENDED ON either way.
 *
 * A bare `waitFor` would throw on the word it did not reach, which loses the reading the RED
 * baseline is made of — "the pane was at `no-stream` before the latch AND still at `no-stream`
 * after it" is two facts, and a cell that dies on the first one can only ever report one.
 */
async function previewWordUntil(page: Page, want: string, budgetMs: number): Promise<string | null> {
  const deadline = Date.now() + budgetMs
  let seen = await previewWord(page)
  while (Date.now() < deadline) {
    seen = await previewWord(page)
    if (seen === want) return seen
    await page.waitForTimeout(150)
  }
  return seen
}

// What the shipped mint door answers at this instant, so a red is the pane and not the fixture.
async function mintStreamKind(runId: string, handle = 0): Promise<string> {
  const response = await fetch(
    `${held().harness.origin}/api/runs/${encodeURIComponent(runId)}/live-url?handle=${String(handle)}`,
  )
  const raw = await response.text()
  if (!response.ok) return `HTTP ${String(response.status)} ${raw.trim()}`
  const parsed = JSON.parse(raw) as { stream?: { kind?: string } }
  return parsed.stream?.kind ?? 'absent'
}

interface EmbedReading {
  /** The attribute's own value, read out of the embed document. */
  state: string | null
  /** How many frames that document says it PAINTED. */
  frames: number
  /**
   * The same `live` fact asked a SECOND, differently-shaped way: how many nodes the document's own
   * selector engine matches for `[data-embed-state="live"]`. An attribute read and a selector match
   * fail differently, and a claim carried by one spelling alone is a claim about that spelling.
   */
  liveNodes: number
}

/** The embed document's own state and painted-frame count, or an honest absence when there is none. */
async function embedReading(page: Page, budgetMs: number): Promise<EmbedReading> {
  const deadline = Date.now() + budgetMs
  let reading: EmbedReading = { state: null, frames: 0, liveNodes: 0 }
  for (;;) {
    const frame = page.frames().find((one) => one.url().includes('/live/'))
    if (frame !== undefined) {
      const attributes = await frame.evaluate(() => {
        const node = document.querySelector('[data-embed-state]')
        return {
          state: node?.getAttribute('data-embed-state') ?? null,
          frames: Number(node?.getAttribute('data-embed-frames') ?? '0'),
        }
      }).catch(() => ({ state: null, frames: 0 }))
      const liveNodes = await frame.locator('[data-embed-state="live"]').count().catch(() => 0)
      reading = { ...attributes, liveNodes }
      if (reading.state === 'live' && reading.frames >= 1 && reading.liveNodes >= 1) return reading
    }
    if (Date.now() > deadline) return reading
    await page.waitForTimeout(150)
  }
}

/** The harness's own source — cell (0) asserts the frame these cells run behind, where it exists. */
const HARNESS_SOURCE = join(
  PACKAGES_ROOT, 'cli', 'src', '__tests__', 'conformance', 'live-view-fixture.ts',
)

describe('the built live surface, in a real browser', () => {
  it('(0) THE FRAME: these cells run behind the production server, not a router in a fixture', () => {
    // A CELL CANNOT SEE ITS OWN FRAME BEHAVIOURALLY, which is the tracer's Pitfall-10 argument in
    // a different key. Every assertion below would read identically against a bare router mounted
    // in this file — and a process-level truth proven on a router is not proven. So the frame is
    // asserted where it exists: in the harness's source, by name, with every anchor required
    // present so the cell cannot pass by matching nothing.
    const source = readFileSync(HARNESS_SOURCE, 'utf8')
    for (const anchor of [
      'startServer(',
      'uiDir',
      'runServiceAttach',
      'composeDashboardDoor(',
      'composeLiveView(',
      'mintLiveUrlThrough(',
      'createRunEventBus(',
      'createRunServiceSessionRegistry(',
    ]) {
      expect(source.includes(anchor), `${anchor} must be how the harness composes this surface`).toBe(true)
    }
    // AND THE BUNDLE IS THE SHIPPED ONE. `uiDir` resolves to `dashboard-ui/dist`, whose freshness
    // `beforeAll` already refused to proceed without.
    expect(dashboardUiDist().endsWith(join('dashboard-ui', 'dist'))).toBe(true)
  })

  it('(1) is exactly two panes, and neither of them is an image', async () => {
    await onLivePage('r_dom', async (page) => {
      await page.locator('[data-live-pane="steps"]').waitFor({ state: 'attached', timeout: 20_000 })
      expect(
        await page.locator('[data-live-pane]').count(),
        'two panes and nothing else — a third pane would be a removed surface coming back',
      ).toBe(2)
      expect(await page.locator('[data-live-pane="steps"]').isVisible()).toBe(true)
      expect(await page.locator('[data-live-pane="preview"]').isVisible()).toBe(true)
      // NO STILLS ANYWHERE. The retired preview polled per-step screenshots and painted them as
      // though they were the browser; an `img` in either pane is that approach returning.
      expect(await page.locator('[data-live-pane] img').count()).toBe(0)
    })
  }, 60_000)

  it('(2) a payload carrying a half-finished thought reaches the row and NOT the document', async () => {
    const f = held()
    publishTo(f.dom, 'stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'open the page' })
    publishTo(f.dom, 'subActionRecorded', {
      testIndex: 0,
      stepIndex: 0,
      subActionIndex: 0,
      // Every refused field carries a sentinel; the reducer reads only its coordinates from it.
      plan: SENTINEL_REASONING,
      plannedAction: { type: SENTINEL_ACTION, to: SENTINEL_REASONING },
      grounding: { rationale: SENTINEL_REASONING },
      result: { ok: true, detail: SENTINEL_REASONING },
      screenStateHash: SENTINEL_REASONING,
    })

    // THE NON-VACUITY CONTROL, AND IT COMES FIRST. The absence below is only a claim about the
    // PAGE if the sentinel actually crossed the wire to it. The door serves the envelope's own
    // JSON verbatim, so the sentinel is in the bytes the browser was handed — which is what makes
    // "it is not in the document" a fact about what the page does with a payload rather than a
    // fact about a payload it never received.
    const served = await readOneStream(
      `${held().harness.origin}/api/run-stream/r_dom`,
      (body) => body.includes('event: subActionRecorded'),
    )
    expect(served, 'the door served the forbidden fields — the page is what drops them')
      .toContain(SENTINEL_REASONING)

    await onLivePage('r_dom', async (page) => {
      await page.locator('[data-step-status="running"]').waitFor({ state: 'attached', timeout: 20_000 })
      await page.locator('[data-step-ticks="1"]').waitFor({ state: 'attached', timeout: 20_000 })

      // On the serialised document: a `title=` leak passes a visible-text assertion.
      const html = await page.evaluate(() => document.documentElement.outerHTML)
      expect(html.length, 'the positive control — a document was actually read').toBeGreaterThan(500)
      expect(html, 'the half-finished reasoning is not reachable while the step runs')
        .not.toContain(SENTINEL_REASONING)
      expect(html, 'nor is the action that has not been taken yet').not.toContain(SENTINEL_ACTION)

      // The tick reaches the running row as `data-step-ticks`, proving the page got the envelope.
      expect(await page.locator('[data-step-status="running"][data-step-ticks="1"]').count()).toBe(1)
      expect(await page.locator('[data-step-motion]').count()).toBe(0)
      expect(await page.locator('[data-step-ticks' + '-label]').count()).toBe(0)

      // Nothing in the steps pane can be clicked to open the absent thing.
      expect(
        await page.locator('[data-live-pane="steps"] a, [data-live-pane="steps"] button, '
          + '[data-live-pane="steps"] [role="button"], [data-live-pane="steps"] [onclick]').count(),
        'the step list is inert: everything a click could open is provisional until the step ends',
      ).toBe(0)
    })
  }, 90_000)

  it('(3) the preview pane embeds a minted liveUrl and the embed PAINTS', async () => {
    const f = held()
    const ackedBefore = f.dom.ackedFrameIds().length
    await onLivePage('r_dom', async (page) => {
      // `embedded` with frames reads `live`; the aspect box holds the picture alone.
      await page.locator('[data-preview-state="live"]').waitFor({ state: 'attached', timeout: 40_000 })
      const embed = page.locator('[data-preview-frame] [data-live-embed]')
      await embed.waitFor({ state: 'attached', timeout: 10_000 })
      // The sandbox is the reason the token may ride the fragment at all.
      expect(await embed.getAttribute('sandbox')).toBe('allow-scripts')

      const frame = await liveEmbedFrame(page)
      await frame.locator('[data-embed-state="live"]').waitFor({ state: 'attached', timeout: 40_000 })
      await frame.waitForFunction(
        () => Number(document.querySelector('[data-embed-state]')?.getAttribute('data-embed-frames') ?? '0') >= 2,
        undefined,
        { timeout: 30_000 },
      )
      const width = await frame.locator('[data-embed-canvas]')
        .evaluate((node) => (node as HTMLCanvasElement).width)
      expect(width, 'a painted canvas carries the frame\'s own geometry').toBe(640)
    })

    // THE ACK IS THE FLOW CONTROL, so a painting viewer must have acked. Without it the producer
    // would never be asked for frame N+1 and `data-embed-frames` could not have reached 2.
    const acked = f.dom.ackedFrameIds()
    expect(acked.length, 'the embed acked every frame it painted').toBeGreaterThan(ackedBefore)
    for (const id of acked) expect(f.dom.deliveredFrameIds()).toContain(id)
  }, 120_000)

  it('(4) a handle that declares `none` gets a sentence, never a frame that never arrives', async () => {
    // `none` before the member's first step is a not-yet, after it a declared absence.
    await onLivePage('r_none', async (page) => {
      await page.locator('[data-preview-state="waiting"]').waitFor({ state: 'attached', timeout: 40_000 })
      expect(
        await page.locator('[data-live-embed]').count(),
        'nothing is embedded over a stream that does not exist yet either',
      ).toBe(0)
      // The steps pane keeps working, which is the other half of the sentence's promise.
      expect(await page.locator('[data-live-pane="steps"]').isVisible()).toBe(true)
    })

    // THE DECLARED HALF, ON ITS OWN RUN. `r_none` cannot be used for it: cell (7) reads that run's
    // `did not run` note, which the reducer emits only for a member that never saw a `stepStarted`
    // — publishing one here to move the pane would silently delete the subject of a sibling cell.
    const started = plantLiveRun({ runId: 'r_none_started', heartbeatMs: 10_000, capability: { kind: 'none' } })
    plantedRuns.push(started)
    held().harness.plant(started)
    publishTo(started, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] })
    publishTo(started, 'testStarted', { testId: 't0', testIndex: 0, name: 'the browserless member', totalSteps: 1 })
    publishTo(started, 'stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'open the page' })

    await onLivePage('r_none_started', async (page) => {
      await page.locator('[data-preview-state="no-stream"]').waitFor({ state: 'attached', timeout: 40_000 })
      expect(await page.locator('[data-preview-state="no-stream"]').textContent()).toContain(NO_STREAM_TEXT)
      expect(
        await page.locator('[data-live-embed]').count(),
        'a declared absence embeds nothing — an iframe here would spin forever over no stream',
      ).toBe(0)
      // AND IT STAYS THE SENTENCE. A retry firing from `no-stream` would show as a flicker back
      // through the motion element, which is exactly what this settle window would catch.
      await page.waitForTimeout(NO_STREAM_SETTLE_MS)
      expect(
        await previewWord(page),
        'the no-stream sentence is terminal for the rest of the run — never a flicker',
      ).toBe('no-stream')
    })
  }, 120_000)

  // The page renders no `[data-liveness]`; a positive control shows it heard the bus.
  it('(5a) k=5 — 11 s of heartbeat-only traffic renders no liveness element', async () => {
    const f = held()
    const arms: { arm: number; liveness: number; activityWords: boolean; rows: number; attaches: number }[] = []
    for (let k = 0; k < 5; k += 1) {
      // A FRESH PAGE PER ARM, so each arm is an independent attach over an independent socket
      // rather than five readings of one page's single subscription.
      const reading = await onLivePage('r_dom', async (page, attaches) => {
        await page.locator('[data-live-pane="steps"] li').first().waitFor({ state: 'attached', timeout: 20_000 })
        // NOTHING IS PUBLISHED HERE. The only traffic in this window is the bus's own 10 s
        // heartbeat and the transport's 15 s comment.
        await page.waitForTimeout(11_000)
        return {
          liveness: await page.locator('[data-liveness]').count(),
          activityWords: await page.evaluate(() => /last activity|no activity yet/iu.test(document.body.textContent ?? '')),
          rows: await page.locator('[data-live-pane="steps"] li').count(),
          attaches: attaches.length,
        }
      })
      arms.push({ arm: k + 1, ...reading })
    }
    for (const arm of arms) {
      const context = `arm ${String(arm.arm)} of 5: ${JSON.stringify(arms)}`
      expect(arm.liveness, context).toBe(0)
      expect(arm.activityWords, context).toBe(false)
      expect(arm.rows, `${context} — the page folded the run's envelopes`).toBeGreaterThan(0)
      expect(arm.attaches, `${context} — one continuous socket, not a reconnect loop`).toBe(1)
    }
    expect(f.dom.cancelCalls(), 'watching a run never cancels it').toBe(0)
  }, 180_000)

  it('(5b) k=2 — an OPEN socket that has heard nothing for 21 s renders no liveness element', async () => {
    const arms: {
      arm: number
      liveness: number
      activityWords: boolean
      attaches: number
      rowsAfterPublish: number
      livenessAfterPublish: number
    }[] = []
    for (let k = 0; k < 2; k += 1) {
      // A FRESH RUN PER ARM, ON A 60 s HEARTBEAT, so the window is genuinely silent.
      const quiet = plantLiveRun({
        runId: `r_quiet_${String(k)}`,
        heartbeatMs: 60_000,
        capability: { kind: 'cdp-screencast' },
      })
      plantedRuns.push(quiet)
      held().harness.plant(quiet)
      publishTo(quiet, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] })

      const reading = await onLivePage(quiet.runId, async (page, attaches) => {
        await page.locator('[data-live-pane="steps"]').waitFor({ state: 'attached', timeout: 20_000 })
        await page.waitForTimeout(21_000)
        const silent = {
          liveness: await page.locator('[data-liveness]').count(),
          activityWords: await page.evaluate(() => /last activity|no activity yet/iu.test(document.body.textContent ?? '')),
          attaches: attaches.length,
        }
        // One envelope into the same socket reaches the rows with the attach count unchanged.
        publishTo(quiet, 'testStarted', {
          testId: 't0', testIndex: 0, name: 'the quiet member', totalSteps: 1, stepTexts: ['open the quiet page'],
        })
        await page.locator('[data-live-pane="steps"] li').first().waitFor({ state: 'attached', timeout: 20_000 })
        expect(attaches.length, 'the socket was never re-opened — it was open all along').toBe(silent.attaches)
        return {
          ...silent,
          rowsAfterPublish: await page.locator('[data-live-pane="steps"] li').count(),
          livenessAfterPublish: await page.locator('[data-liveness]').count(),
        }
      })
      arms.push({ arm: k + 1, ...reading })
      expect(quiet.cancelCalls(), 'a viewer that stopped hearing anything did not end the run').toBe(0)
      expect(quiet.isDone(), 'and the run is still going').toBe(false)
    }
    for (const arm of arms) {
      const context = `arm ${String(arm.arm)} of 2: ${JSON.stringify(arms)}`
      expect(arm.liveness, context).toBe(0)
      expect(arm.activityWords, context).toBe(false)
      expect(arm.attaches, `${context} — ONE attach, so the socket never closed`).toBe(1)
      expect(arm.rowsAfterPublish, `${context} — and the next envelope reaches the rows`).toBe(1)
      expect(arm.livenessAfterPublish, context).toBe(0)
    }
  }, 180_000)

  it('(5c) a dropped socket that comes back renders no liveness element either side of the drop', async () => {
    const f = held()
    const reading = await onLivePage('r_dom', async (page, attaches) => {
      await page.locator('[data-live-pane="steps"] li').first().waitFor({ state: 'attached', timeout: 40_000 })
      const before = await page.locator('[data-liveness]').count()

      // THE SERVER DROPS THE SOCKET. Not a client-side close and not a doubled error: the Node
      // server ends every open connection, which is what a restarted dashboard or a dropped
      // network link looks like from the page's side.
      const attachesBeforeDrop = attaches.length
      f.harness.server.closeAllConnections()

      // AND IT COMES BACK: the browser (or the page's classified reattach) opens the stream again.
      const deadline = Date.now() + 60_000
      while (attaches.length <= attachesBeforeDrop && Date.now() < deadline) {
        await page.waitForTimeout(150)
      }
      await page.waitForTimeout(2_000)
      return {
        before,
        reattached: attaches.length > attachesBeforeDrop,
        after: await page.locator('[data-liveness]').count(),
        activityWords: await page.evaluate(() => /last activity|no activity yet|reconnecting/iu.test(
          document.querySelector('[data-tour-id="tour-live-run-status"]')?.parentElement?.textContent ?? '',
        )),
        rows: await page.locator('[data-live-pane="steps"] li').count(),
      }
    })
    expect(reading, JSON.stringify(reading)).toEqual({
      before: 0,
      reattached: true,
      after: 0,
      activityWords: false,
      rows: reading.rows,
    })
    expect(reading.rows, 'the rows survive the drop').toBeGreaterThan(0)
    expect(f.dom.cancelCalls()).toBe(0)
  }, 180_000)

  // `runFinished` alone, with no verdict: the band is what a viewer gets when there is no answer.
  it('(6) a run that ends with NO verdict bands honestly, and goes nowhere', async () => {
    const f = held()
    await onLivePage('r_dom', async (page, attaches) => {
      await page.locator('[data-live-pane="steps"]').waitFor({ state: 'attached', timeout: 20_000 })
      // The page has attached and folded the run once its rows are on screen.
      await page.locator('[data-live-pane="steps"] li').first().waitFor({ state: 'attached', timeout: 40_000 })

      publishTo(f.dom, 'stepFinalized', { testIndex: 0, stepIndex: 0, status: 'passed', durationMs: 1200 })
      publishTo(f.dom, 'testFinished', { testId: 't0', testIndex: 0, outcome: 'passed', durationMs: 1400 })
      // NO `verdict` PUBLISH. That absence is the whole cell — see the note above.
      publishTo(f.dom, 'runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: f.dom.bus.currentSeq + 1 })
      f.dom.finish('passed')

      await page.locator('[data-terminal-state]').waitFor({ state: 'attached', timeout: 30_000 })
      await page.locator('[data-preview-state="run-ended"]').waitFor({ state: 'attached', timeout: 30_000 })
      const previewState = await page.locator('[data-preview-state]').getAttribute('data-preview-state')
      expect(previewState, 'a run this page has watched END has nothing left to embed').toBe('run-ended')
      expect(await page.locator('[data-live-pane]').count(), 'two panes, to the last frame').toBe(2)
      // No liveness element at the end either.
      expect(
        await page.locator('[data-liveness]').count(),
        'no liveness element on the live page',
      ).toBe(0)
      // The embed comes down with the run: a token minted now would outlive the thing it addresses.
      // (The plan text expected `data-embed-state="ended"` INSIDE a surviving iframe; the shipped
      // pane unmounts the frame at `ended`, so the honest assertion is that there is no iframe.)
      expect(await page.locator('[data-live-embed]').count()).toBe(0)
      expect(await page.locator('[data-run-detail-link]').count()).toBe(1)
      expect(
        page.url().endsWith('/live'),
        'with no verdict there is no answer to move the viewer to — the band says the run '
        + 'ended and the link offers the durable record, which is a person\'s decision to take',
      ).toBe(true)

      // NO RECONNECT LOOP against a run the door has finished with. A page that kept re-opening
      // the stream would hammer a door that has already given its final answer.
      const settled = attaches.length
      await page.waitForTimeout(5_000)
      expect(attaches.length, `attaches: ${JSON.stringify(attaches)}`).toBe(settled)
    })
    expect(f.dom.cancelCalls(), 'no viewer ever cancelled this run').toBe(0)
  }, 150_000)

  // The `did not run` rows are asserted before the verdict, which moves the page away.
  it('(7) a member that never started a step says so — and THEN the verdict moves the viewer', async () => {
    const f = held()
    publishTo(f.none, 'testFinished', { testId: 't0', testIndex: 0, outcome: 'skipped', durationMs: 5 })

    await onLivePage('r_none', async (page) => {
      await page.locator('[data-member-note]').waitFor({ state: 'attached', timeout: 30_000 })
      expect(await page.locator('[data-member-note]').textContent()).toBe(DID_NOT_RUN_NOTE)
      // A single-member run has no member header, so the note is the pane's sentence.
      expect(await page.locator('[data-member-note]').evaluate((node) => node.tagName)).toBe('P')
      expect(await page.locator('[data-member-outcome]').count()).toBe(0)
      expect(
        await page.locator('[data-terminal-state]').count(),
        'nothing has ended yet, so nothing claims it has',
      ).toBe(0)

      publishTo(f.none, 'verdict', { verdict: 'failed' })
      await page.waitForURL(/\/runs\/[^/]+$/u, { timeout: 30_000 })
      expect(page.url().endsWith('/runs/r_none'), `landed on ${page.url()}`).toBe(true)

      publishTo(f.none, 'runFinished', { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: f.none.bus.currentSeq + 1 })
      f.none.finish('failed')
    })
    expect(f.none.cancelCalls()).toBe(0)
  }, 90_000)

  it('(8) the pane re-mints and embeds under production ordering', async () => {
    // `latchCapability` fires the browser-up event, so the pane must re-mint after an early `none`.
    const arms: Record<string, unknown>[] = []

    for (let k = 0; k < 5; k += 1) {
      // ARM 1 — `none` AT ATTACH. A fresh run per arm: the latch is one-way, so a run reused
      // across arms would only ever be `none` once.
      const run = plantLiveRun({
        runId: `r_gap1_none_${String(k)}`,
        heartbeatMs: 10_000,
        capability: { kind: 'none' },
        frameBytes: held().jpeg,
        frameWidth: 640,
        frameHeight: 400,
      })
      plantedRuns.push(run)
      held().harness.plant(run)
      // The roster is real and the member has NOT started a step — which is the whole
      // discriminator: "the browser is not up yet", not "this target declares no stream".
      publishTo(run, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] })
      publishTo(run, 'testStarted', { testId: 't0', testIndex: 0, name: 'the not-yet member', totalSteps: 2 })

      const reading = await onLivePage(run.runId, async (page) => {
        // (a) THE NOT-YET STATE, and no iframe over a stream that does not exist yet.
        const atAttach = await settledPreviewWord(page, 25_000)
        const embedsAtAttach = await page.locator('[data-live-embed]').count()
        const framedAtAttach = await page.locator('[data-preview-frame] [data-live-embed]').count()

        // (b) ONLY NOW does the member's browser come up. The CELL decides this instant.
        run.latchCapability({ kind: 'cdp-screencast' })
        const control = await mintStreamKind(run.runId)

        // (c) The pane must find its way back on its own.
        const afterLatch = await previewWordUntil(page, 'live', 25_000)
        const embed = await embedReading(page, 25_000)

        // (d) The watched member starting must not UNDO a live embed. Published only after the
        // embed was observed, so no `none` answer can ever meet `sawStepStarted === true`.
        publishTo(run, 'stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'open the page' })
        await page.waitForTimeout(3_000)
        const afterStepStarted = await previewWord(page)

        const framedAfterLatch = await page.locator('[data-preview-frame] [data-live-embed]').count()
        return { atAttach, embedsAtAttach, framedAtAttach, control, afterLatch, framedAfterLatch, embed, afterStepStarted }
      })
      arms.push({ arm: k + 1, ...reading })
    }

    for (const arm of arms) {
      const context = `arm ${String(arm.arm)} of 5: ${JSON.stringify(arm)}`
      expect(arm.control, `${context} — the NON-VACUITY CONTROL: the door really did answer `
        + 'cdp-screencast at the moment the pane\'s next retry would have asked. Without this, a red '
        + 'below could be the fixture failing to latch rather than the pane failing to re-mint.')
        .toBe('cdp-screencast')
      expect(arm.atAttach, `${context} — a member whose browser is not up yet is NOT a declared absence`)
        .toBe('waiting')
      expect(arm.embedsAtAttach, `${context} — nothing is embedded over a stream that does not exist yet`).toBe(0)
      expect(arm.framedAtAttach, context).toBe(0)
      expect(arm.afterLatch, `${context} — SC-1: the pane re-mints while the run is live`).toBe('live')
      expect(arm.framedAfterLatch, `${context} — the embed sits inside the aspect box`).toBe(1)
      const embed = arm.embed as EmbedReading
      expect(embed.state, `${context} — and the embed PAINTS`).toBe('live')
      expect(embed.frames, context).toBeGreaterThanOrEqual(1)
      expect(embed.liveNodes, `${context} — the same fact through the document's own selector`)
        .toBeGreaterThanOrEqual(1)
      expect(arm.afterStepStarted, `${context} — the member starting does not undo a live embed`)
        .toBe('live')
    }
  }, 600_000)

  it('(8b) the `unknown_run`-at-attach arm, behind the production page', async () => {
    // The page attaches its run stream too, and both doors refuse an unplanted run.
    const arms: Record<string, unknown>[] = []

    for (let k = 0; k < 5; k += 1) {
      const run = plantLiveRun({
        runId: `r_gap1_unknown_${String(k)}`,
        heartbeatMs: 10_000,
        capability: { kind: 'cdp-screencast' },
        frameBytes: held().jpeg,
        frameWidth: 640,
        frameHeight: 400,
      })
      plantedRuns.push(run)
      // DELIBERATELY NOT PLANTED YET — that is arm 2's whole subject.

      const reading = await onLivePage(run.runId, async (page) => {
        const beforePlant = await settledPreviewWord(page, 20_000)
        const controlBefore = await mintStreamKind(run.runId)
        const runOverBefore = await page.locator('[data-run-over]').count()

        held().harness.plant(run)
        publishTo(run, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] })
        const controlAfter = await mintStreamKind(run.runId)

        const afterPlant = await previewWordUntil(page, 'live', 20_000)
        const runOverAfter = await page.locator('[data-run-over]').count()
        return { beforePlant, controlBefore, runOverBefore, controlAfter, afterPlant, runOverAfter }
      })
      arms.push({ arm: k + 1, ...reading })
    }

    for (const arm of arms) {
      const context = `arm ${String(arm.arm)} of 5: ${JSON.stringify(arm)}`
      expect(arm.controlBefore, `${context} — the control: the mint door really did refuse by name`)
        .toContain('unknown_run')
      expect(arm.controlAfter, `${context} — and really does answer once the session is published`)
        .toBe('cdp-screencast')
      expect(arm.afterPlant, `${context} — ARM 2`).toBe('live')
    }
  }, 600_000)
  // ---- The verdict navigation ----
  it('(9) the verdict MOVES the viewer to run detail, the badge paints, and Back does not return to a dead live page', async () => {
    const f = held()
    const run = plantLiveRun({ runId: 'r_nav', heartbeatMs: 10_000, capability: { kind: 'none' } })
    plantedRuns.push(run)
    f.harness.plant(run)

    // The row stays `running` across the navigation, so no-bounce meets the race's losing side.
    f.harness.insertRunRow({ runId: 'r_nav', name: 'the navigating run', status: 'running' })
    publishTo(run, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] })
    publishTo(run, 'testStarted', { testId: 't0', testIndex: 0, name: 'the navigating member', totalSteps: 1 })

    const page = await f.browser.newPage()
    const navigations: string[] = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url())
    })
    try {
      // THE VIEWER CAME FROM SOMEWHERE. `replace` is only a claim you can measure if there is a
      // prior entry for Back to return to; a page opened cold has nothing behind it and `goBack()`
      // would be a no-op that passes either way.
      await page.goto(`${f.harness.origin}/runs`)
      await page.goto(`${f.harness.origin}/runs/r_nav/live`)
      await page.locator('[data-live-pane="steps"]').waitFor({ state: 'attached', timeout: 30_000 })
      expect(page.url().endsWith('/live'), `started on ${page.url()}`).toBe(true)

      publishTo(run, 'stepFinalized', { testIndex: 0, stepIndex: 0, status: 'passed', durationMs: 1200 })
      publishTo(run, 'testFinished', { testId: 't0', testIndex: 0, outcome: 'passed', durationMs: 1400 })
      publishTo(run, 'verdict', { verdict: 'passed' })

      await page.waitForURL(/\/runs\/[^/]+$/u, { timeout: 10_000 })
      expect(page.url().endsWith('/runs/r_nav'), `landed on ${page.url()}`).toBe(true)

      // AND IT STAYS. The row still says `running`; a page that read it as "this belongs on the
      // live surface" would already have bounced by now. Two seconds is eight catch-up periods.
      await page.waitForTimeout(2_000)
      expect(
        page.url().endsWith('/runs/r_nav'),
        `the viewer was bounced back to a live surface while the durable row caught up — `
        + `url ${page.url()}, navigations ${JSON.stringify(navigations)}`,
      ).toBe(true)

      // NOW THE ROW CATCHES UP, as the subscriber's `updateRun` does in production. The header
      // badge must FOLLOW it — that is what the bounded re-fetch is for, and a page that only read
      // the row once would sit on `running` under a finished run forever.
      f.harness.setRunStatus('r_nav', 'passed')
      await page.locator('[data-verdict-badge="passed"]').waitFor({ state: 'attached', timeout: 3_000 })

      // THE `replace` HALF. Back returns to the list the viewer came from — never to a live page
      // whose socket the door has already closed, which would immediately move them forward again.
      await page.goBack()
      await page.waitForURL(/\/runs$/u, { timeout: 10_000 })
      expect(
        page.url().endsWith('/runs'),
        `Back landed on ${page.url()}; navigations ${JSON.stringify(navigations)}`,
      ).toBe(true)
      expect(
        navigations.some((url) => url.includes('/live')),
        'the control: this page really was on a live surface at some point; navigations '
          + JSON.stringify(navigations),
      ).toBe(true)
    } finally {
      await page.close()
    }
    expect(run.cancelCalls(), 'navigating away is not owning the run').toBe(0)
  }, 150_000)
})
