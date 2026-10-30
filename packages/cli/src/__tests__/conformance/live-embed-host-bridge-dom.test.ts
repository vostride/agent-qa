/// <reference lib="dom" />
// The DOM lib is referenced here because this file's `page.evaluate` callbacks run in a browser.

// Messages are kept by `event.source` identity: the sandboxed embed's origin is `'null'`.

import {
  LIVE_EMBED_HOST_PARAM,
  LIVE_EMBED_NO_STREAM_MESSAGE,
  LIVE_EMBED_REPORT_EVENTS,
  LIVE_EMBED_REPORT_INTERVAL_MS,
  LIVE_EMBED_SESSION_ENDED_MESSAGE,
} from '@vostride/agent-qa-dashboard'
import { createLiveStreamHub } from '@vostride/agent-qa-runner'
import type { LiveStreamCapability } from '@vostride/agent-qa-runner'
import { EditorLiveUrlResultSchema, RunsLiveUrlResultSchema } from '@vostride/agent-qa-schema'
import type { LiveFrame, LiveStreamKind } from '@vostride/agent-qa-schema'
import { chromium } from 'playwright-core'
import type { Browser, Frame, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { plantEditorSubject, plantLiveRun, startLiveViewHarness } from './live-view-fixture.js'
import type { LiveViewHarness, PlantedLiveRun } from './live-view-fixture.js'
import {
  DASHBOARD_ANCHORED_BUILDS,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
} from './spawned-chat.js'

const BROWSER_INSTALL_INSTRUCTION =
  'these cells frame the served embed page in a real Chromium: run '
  + '`pnpm exec playwright install chromium` and re-run. They must not be skipped when the browser '
  + 'is absent.'

/** The keys a report may carry. Anything else is a leak. */
const REPORT_KEYS = new Set(['event', 'kind', 'ts', 'width', 'height', 'reason'])

/** The value the host hint carries in these cells, as the dashboard will set it. */
const HOST_HINT = 'dashboard'

const FRAME_WIDTH = 640
const FRAME_HEIGHT = 400

/** Where a paused page clock stands: an hour past its start, so pausing only moves it forward. */
const PAGE_CLOCK_PAUSED_AT = 3_600_000

interface BridgeFixture {
  readonly harness: LiveViewHarness
  readonly browser: Browser
  /** Real, decodable image bytes, minted by the browser itself in `beforeAll`. */
  readonly jpeg: Uint8Array
  readonly png: Uint8Array
}

let fixture: BridgeFixture | undefined

function held(): BridgeFixture {
  if (fixture === undefined) throw new Error('the embed bridge fixture never came up')
  return fixture
}

beforeAll(async () => {
  // The embed document is rendered by the BUILT dashboard package; a stale dist would certify the
  // previous page.
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

  const shotPage = await browser.newPage()
  await shotPage.setViewportSize({ width: FRAME_WIDTH, height: FRAME_HEIGHT })
  await shotPage.setContent('<body style="background:#123456"><h1>live</h1></body>')
  const jpeg = new Uint8Array(await shotPage.screenshot({ type: 'jpeg', quality: 40 }))
  const png = new Uint8Array(await shotPage.screenshot({ type: 'png' }))
  await shotPage.close()

  const harness = await startLiveViewHarness({ label: 'bridge' })
  fixture = { harness, browser, jpeg, png }
}, 180_000)

afterAll(async () => {
  const open = fixture
  fixture = undefined
  if (open !== undefined) {
    await open.harness.close()
    await open.browser.close()
  }
  cleanupTempRoots()
})

// ---- a streaming run whose frames go through a real hub ----------------------------------------

interface HubRun {
  readonly run: PlantedLiveRun
  /** Whether the hub has started the producer (somebody is watching). */
  started(): boolean
  /** Emit one frame through the hub now, stamped with its capture time. */
  emit(): void
  /** Every capture time the producer emitted, in order. */
  emitted(): readonly number[]
  close(): Promise<void>
}

function plantHubRun(input: {
  readonly runId: string
  readonly kind: LiveStreamKind
  readonly frameBytes: Uint8Array
  /** Absent: frames are emitted only when a cell calls `emit()`. */
  readonly cadenceMs?: number
}): HubRun {
  let deliver: ((frame: LiveFrame) => void) | undefined
  let cadence: ReturnType<typeof setInterval> | undefined
  let frameId = 0
  const emitted: number[] = []

  const emit = (): void => {
    if (deliver === undefined) return
    frameId += 1
    const ts = Date.now()
    emitted.push(ts)
    // No `kind` on the frame: the hub stamps the capability's kind, as it does for a member.
    deliver({
      id: frameId,
      bytes: input.frameBytes,
      metadata: { width: FRAME_WIDTH, height: FRAME_HEIGHT, timestamp: ts },
    })
  }

  const capability: LiveStreamCapability = {
    kind: input.kind,
    start: async (onFrame) => {
      deliver = onFrame
      if (input.cadenceMs !== undefined && cadence === undefined) {
        cadence = setInterval(emit, input.cadenceMs)
        cadence.unref?.()
      }
    },
    ack: async () => {},
    stop: async () => {
      deliver = undefined
      if (cadence !== undefined) clearInterval(cadence)
      cadence = undefined
    },
  }
  const hub = createLiveStreamHub()
  hub.register(0, capability)

  const base = plantLiveRun({
    runId: input.runId,
    heartbeatMs: 10_000,
    capability: { kind: input.kind },
  })
  const run: PlantedLiveRun = {
    ...base,
    session: {
      ...base.session,
      subscribeFrames: (handle, onFrame, onEnd) => hub.subscribe(handle, onFrame, onEnd),
      streamCapabilityOf: (handle) => hub.capabilityOf(handle),
    },
  }
  held().harness.plant(run)

  return {
    run,
    started: () => deliver !== undefined,
    emit,
    emitted: () => [...emitted],
    close: async () => {
      if (cadence !== undefined) clearInterval(cadence)
      cadence = undefined
      await hub.close()
      base.close()
    },
  }
}

// ---- minting ------------------------------------------------------------------------------------

async function mintRunLiveUrl(runId: string): Promise<string> {
  const response = await fetch(
    `${held().harness.origin}/api/runs/${encodeURIComponent(runId)}/live-url`,
  )
  const raw = await response.text()
  expect(response.status, `the run mint door answered ${String(response.status)}`).toBe(200)
  return RunsLiveUrlResultSchema.parse(JSON.parse(raw)).liveUrl
}

async function mintEditorLiveUrl(sessionId: string): Promise<string> {
  const response = await fetch(
    `${held().harness.origin}/api/live-editor/sessions/${encodeURIComponent(sessionId)}/live-url`,
  )
  const raw = await response.text()
  expect(response.status, `the editor mint door answered ${String(response.status)}`).toBe(200)
  return EditorLiveUrlResultSchema.parse(JSON.parse(raw)).liveUrl
}

/** The token a liveUrl carries in its fragment. Never printed. */
function tokenOf(liveUrl: string): string {
  const at = liveUrl.indexOf('#')
  expect(at, 'the liveUrl carries its token in the fragment').toBeGreaterThan(0)
  return liveUrl.slice(at + 1)
}

/** The liveUrl with the host hint in its query, as the dashboard frames it. */
function hinted(liveUrl: string): string {
  const at = liveUrl.indexOf('#')
  return `${liveUrl.slice(0, at)}?${LIVE_EMBED_HOST_PARAM}=${HOST_HINT}${liveUrl.slice(at)}`
}

// ---- the host page ------------------------------------------------------------------------------

interface HostReport {
  /** Which of the host's iframes the message came from, by identity. */
  readonly frame: string
  readonly origin: string
  /** When the host received it, by the host's clock. */
  readonly at: number
  readonly data: Record<string, unknown>
}

interface HostWindow {
  __reports: HostReport[]
  __strangers: number
}

/**
 * A host page that frames each `src` in a sandboxed iframe and keeps only the messages whose
 * `event.source` is one of its own iframes' `contentWindow`. The listener is installed before any
 * iframe exists, so the embed's first report cannot race it.
 */
async function hostPage(
  frames: readonly { readonly name: string; readonly src: string }[],
  options: {
    /** Pause the host's and every embed's clock at `PAGE_CLOCK_PAUSED_AT` before any document. */
    readonly pausedClock?: boolean
  } = {},
): Promise<Page> {
  const page = await held().browser.newPage()
  if (options.pausedClock === true) {
    await page.clock.install({ time: 0 })
    await page.clock.pauseAt(PAGE_CLOCK_PAUSED_AT)
  }
  const attribute = (value: string): string =>
    value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  const size = `width="${String(FRAME_WIDTH)}" height="${String(FRAME_HEIGHT)}"`
  const iframes = frames
    .map((frame) => `<iframe data-host-frame="${attribute(frame.name)}" sandbox="allow-scripts" `
      + `${size} src="${attribute(frame.src)}"></iframe>`)
    .join('\n')
  await page.setContent(`<!DOCTYPE html>
<html><body>
<script>
window.__reports = [];
window.__strangers = 0;
window.addEventListener('message', function (event) {
  var frames = document.querySelectorAll('iframe[data-host-frame]');
  for (var i = 0; i < frames.length; i += 1) {
    if (event.source === frames[i].contentWindow) {
      window.__reports.push({
        frame: frames[i].getAttribute('data-host-frame'),
        origin: event.origin,
        at: Date.now(),
        data: event.data
      });
      return;
    }
  }
  window.__strangers += 1;
});
</script>
${iframes}
</body></html>`)
  return page
}

async function reportsOf(page: Page, frame: string): Promise<HostReport[]> {
  const all = await page.evaluate(() => (window as unknown as HostWindow).__reports)
  return all.filter((report) => report.frame === frame)
}

async function strangersOf(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as HostWindow).__strangers)
}

/** A report predicate: at least `count` reports of this event. */
function seenEvent(event: string, count = 1): (reports: readonly HostReport[]) => boolean {
  return (reports) => reports.filter((report) => report.data.event === event).length >= count
}

function eventsNamed(reports: readonly HostReport[], event: string): HostReport[] {
  return reports.filter((report) => report.data.event === event)
}

async function waitForReports(
  page: Page,
  frame: string,
  what: string,
  predicate: (reports: readonly HostReport[]) => boolean,
  budgetMs = 20_000,
): Promise<HostReport[]> {
  const deadline = Date.now() + budgetMs
  let reports = await reportsOf(page, frame)
  while (Date.now() < deadline) {
    reports = await reportsOf(page, frame)
    if (predicate(reports)) return reports
    await page.waitForTimeout(100)
  }
  // Events only, so a failure message can never print a payload.
  throw new Error(`${what} never happened within ${String(budgetMs)}ms; events seen: `
    + JSON.stringify(reports.map((report) => report.data.event)))
}

/** The embed document inside one of the host's iframes, as a Playwright frame. */
async function embedFrame(page: Page, name: string): Promise<Frame> {
  const element = await page.$(`iframe[data-host-frame="${name}"]`)
  const frame = await element?.contentFrame()
  if (frame === undefined || frame === null) {
    throw new Error(`the host has no embed frame named ${name}`)
  }
  return frame
}

interface EmbedReading {
  readonly state: string | null
  readonly frames: number
  readonly host: string | null
  readonly messageDisplay: string | null
  readonly messageText: string | null
}

async function readEmbed(frame: Frame): Promise<EmbedReading> {
  return frame.evaluate(() => {
    const root = document.querySelector('[data-embed-state]')
    const message = document.querySelector('[data-embed-message]')
    return {
      state: root?.getAttribute('data-embed-state') ?? null,
      frames: Number(root?.getAttribute('data-embed-frames') ?? '0'),
      host: root?.getAttribute('data-embed-host') ?? null,
      messageDisplay: message === null ? null : getComputedStyle(message).display,
      messageText: message?.textContent ?? null,
    }
  })
}

async function embedUntil(
  frame: Frame,
  what: string,
  predicate: (reading: EmbedReading) => boolean,
  budgetMs = 20_000,
): Promise<EmbedReading> {
  const deadline = Date.now() + budgetMs
  let reading = await readEmbed(frame)
  while (Date.now() < deadline) {
    reading = await readEmbed(frame)
    if (predicate(reading)) return reading
    await new Promise((tick) => setTimeout(tick, 100))
  }
  throw new Error(`${what} never happened within ${String(budgetMs)}ms; last reading: `
    + `state=${String(reading.state)} frames=${String(reading.frames)} `
    + `host=${String(reading.host)}`)
}

const sleep = async (ms: number): Promise<void> => new Promise((tick) => setTimeout(tick, ms))

describe('the embed reports to its host, and the host hint', () => {
  it('EMBED-REPORTS-READY-AND-FRAMES: ready with the declared kind, then frames with ts, kind and size, from origin null', async () => {
    const stream = plantHubRun({
      runId: 'r-bridge-frames',
      kind: 'cdp-screencast',
      frameBytes: held().jpeg,
      cadenceMs: 200,
    })
    const liveUrl = await mintRunLiveUrl('r-bridge-frames')
    const page = await hostPage([{ name: 'dashboard', src: hinted(liveUrl) }])
    try {
      const reports = await waitForReports(
        page,
        'dashboard',
        'a ready report and two frame reports',
        seenEvent('frame', 2),
      )
      expect(reports[0]?.data, 'the first report is ready, naming the declared kind')
        .toEqual({ event: 'ready', kind: 'cdp-screencast' })

      for (const report of eventsNamed(reports, 'frame')) {
        expect(typeof report.data.ts, 'a frame report carries its capture time').toBe('number')
        expect(stream.emitted(), 'and it is a time the producer stamped').toContain(report.data.ts)
        expect(report.data.kind, 'the kind the hub stamped').toBe('cdp-screencast')
        expect(report.data.width).toBe(FRAME_WIDTH)
        expect(report.data.height).toBe(FRAME_HEIGHT)
      }
      for (const report of reports) {
        expect(report.origin, 'an opaque-origin embed posts as "null"; identity is the check')
          .toBe('null')
      }
      expect(await strangersOf(page), 'nothing but the host\'s own iframe posted').toBe(0)
    } finally {
      await page.close()
      await stream.close()
    }
  }, 60_000)

  it('EMBED-REPORT-CARRIES-NO-TOKEN: no report holds the token, a token version prefix or the run id, and every key is closed-set', async () => {
    const runId = 'run-bridge-4c1d'
    const stream = plantHubRun({
      runId,
      kind: 'cdp-screencast',
      frameBytes: held().jpeg,
      cadenceMs: 200,
    })
    const liveUrl = await mintRunLiveUrl(runId)
    const token = tokenOf(liveUrl)
    // A signature with its last character changed is refused by name, so a refused report is
    // inspected too.
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
    const page = await hostPage([
      { name: 'dashboard', src: hinted(liveUrl) },
      { name: 'tampered', src: hinted(`${liveUrl.slice(0, liveUrl.indexOf('#'))}#${tampered}`) },
    ])
    try {
      await waitForReports(page, 'dashboard', 'ready and two frame reports', seenEvent('frame', 2))
      stream.run.finish()
      await waitForReports(page, 'dashboard', 'an ended report', seenEvent('ended'))
      await waitForReports(page, 'tampered', 'a refused report', seenEvent('refused'))

      const reports = [...await reportsOf(page, 'dashboard'), ...await reportsOf(page, 'tampered')]
      const events = new Set<unknown>()
      for (const report of reports) {
        const json = JSON.stringify(report.data)
        expect(json.includes(token), 'a report carries the live token').toBe(false)
        expect(json.includes(tampered), 'a report carries the presented token').toBe(false)
        expect(json.includes('v2.'), 'a report carries a token version prefix').toBe(false)
        expect(json.includes(runId), 'a report carries the run id').toBe(false)
        for (const key of Object.keys(report.data)) {
          expect(REPORT_KEYS.has(key), `report key ${key} is outside the closed set`).toBe(true)
        }
        expect(LIVE_EMBED_REPORT_EVENTS as readonly unknown[]).toContain(report.data.event)
        events.add(report.data.event)
      }
      // Non-vacuity: four of the five facts were inspected, not just the first one.
      expect([...events].sort()).toEqual(['ended', 'frame', 'ready', 'refused'])
      const ended = reports.find((report) => report.data.event === 'ended')
      expect(ended?.data).toEqual({ event: 'ended', reason: 'runFinished' })
      const refused = reports.find((report) => report.data.event === 'refused')
      expect(refused?.data).toEqual({ event: 'refused', reason: 'bad_signature' })
    } finally {
      await page.close()
      await stream.close()
    }
  }, 60_000)

  it('EMBED-THROTTLES-FRAME-REPORTS: 20 frames a second for 2 s yield at most 5 reports, the last one the newest frame', async () => {
    const stream = plantHubRun({
      runId: 'r-bridge-throttle',
      kind: 'cdp-screencast',
      frameBytes: held().jpeg,
    })
    const liveUrl = await mintRunLiveUrl('r-bridge-throttle')
    const page = await hostPage([{ name: 'dashboard', src: hinted(liveUrl) }], {
      pausedClock: true,
    })
    try {
      await waitForReports(page, 'dashboard', 'ready', seenEvent('ready'))
      const startedBy = Date.now() + 10_000
      while (!stream.started() && Date.now() < startedBy) await sleep(25)
      expect(stream.started(), 'the hub started the producer for the watching embed').toBe(true)

      const frame = await embedFrame(page, 'dashboard')
      expect(await frame.evaluate(() => Date.now()), 'the embed runs on the paused page clock')
        .toBe(PAGE_CLOCK_PAUSED_AT)

      // 40 frames, 50 ms apart on the page clock. Each is painted while the clock stands still, so
      // the embed sees 20 per second for 2 s however long a frame takes to arrive.
      for (let index = 0; index < 40; index += 1) {
        stream.emit()
        await embedUntil(frame, `frame ${String(index + 1)} painted`, (reading) =>
          reading.frames >= index + 1)
        await page.clock.runFor(50)
      }
      const emitted = stream.emitted()
      expect(emitted.length).toBe(40)

      // Past one full interval, so a trailing report has flushed.
      await page.clock.runFor(LIVE_EMBED_REPORT_INTERVAL_MS * 3)
      // Messages from one window arrive in order, so this one lands after every report so far.
      await frame.evaluate(() => {
        window.parent.postMessage({ event: 'barrier' }, '*')
      })
      const reports = await waitForReports(page, 'dashboard', 'the barrier', seenEvent('barrier'))

      const frameReports = eventsNamed(reports, 'frame')
      const reading = await readEmbed(frame)
      expect(reading.frames, 'every frame painted, so the last emitted is the newest painted')
        .toBe(emitted.length)
      const interval = String(LIVE_EMBED_REPORT_INTERVAL_MS)
      expect(frameReports.length, `one report per ${interval} ms at most`)
        .toBeLessThanOrEqual(5)
      expect(frameReports.length, 'the throttle still reports, it does not go silent')
        .toBeGreaterThanOrEqual(3)
      expect(frameReports.at(-1)?.data.ts, 'the trailing report carries the newest frame')
        .toBe(emitted.at(-1))
      const gaps = frameReports
        .slice(1)
        .map((report, index) => report.at - (frameReports[index]?.at ?? 0))
      expect(Math.min(...gaps), 'reports are spaced by the interval').toBeGreaterThanOrEqual(
        LIVE_EMBED_REPORT_INTERVAL_MS - 100,
      )
    } finally {
      await page.close()
      await stream.close()
    }
  }, 60_000)

  it('EMBED-HOST-HINT-HIDES-TEXT: the hinted embed hides its text, the unhinted one shows it, and a re-mint is a hashchange', async () => {
    const run = plantLiveRun({
      runId: 'r-bridge-none',
      heartbeatMs: 10_000,
      capability: { kind: 'none' },
    })
    held().harness.plant(run)
    const liveUrl = await mintRunLiveUrl('r-bridge-none')
    const page = await hostPage([
      { name: 'dashboard', src: hinted(liveUrl) },
      // The MCP App wrapper's posture: the liveUrl exactly as minted, no hint.
      { name: 'wrapper', src: liveUrl },
    ])
    try {
      const hintedFrame = await embedFrame(page, 'dashboard')
      const plainFrame = await embedFrame(page, 'wrapper')
      const noStream = (reading: EmbedReading): boolean => reading.state === 'no-stream'
      const hintedReading = await embedUntil(hintedFrame, 'the hinted embed: no-stream', noStream)
      const plainReading = await embedUntil(plainFrame, 'the plain embed: no-stream', noStream)

      expect(hintedReading.host, 'the hint lands on main as data-embed-host').toBe(HOST_HINT)
      expect(hintedReading.messageDisplay, 'the host speaks for the page, so its text is hidden')
        .toBe('none')
      expect(hintedReading.messageText, 'the page still knows its state')
        .toBe(LIVE_EMBED_NO_STREAM_MESSAGE)
      expect(plainReading.host, 'no hint, no attribute').toBeNull()
      expect(plainReading.messageDisplay, 'a host with no chrome keeps the page\'s own words')
        .not.toBe('none')
      expect(plainReading.messageText).toBe(LIVE_EMBED_NO_STREAM_MESSAGE)

      // A silent re-mint changes only the fragment behind the hint: the same document renews in
      // place, and the hint survives it.
      await hintedFrame.evaluate(() => {
        (window as unknown as { __sameDocument?: string }).__sameDocument = 'yes'
      })
      const renewed = await mintRunLiveUrl('r-bridge-none')
      const renewedToken = tokenOf(renewed)
      expect(renewedToken === tokenOf(liveUrl), 'the re-mint produced a new token').toBe(false)
      await page.evaluate((src) => {
        const element = document.querySelector('iframe[data-host-frame="dashboard"]')
        if (element instanceof HTMLIFrameElement) element.src = src
      }, hinted(renewed))
      const deadline = Date.now() + 10_000
      let fragmentMoved = false
      while (!fragmentMoved && Date.now() < deadline) {
        fragmentMoved = await hintedFrame.evaluate(
          (expected) => location.hash === `#${expected}`,
          renewedToken,
        ).catch(() => false)
        if (!fragmentMoved) await sleep(100)
      }
      expect(fragmentMoved, 'the embed saw the new fragment').toBe(true)
      expect(
        await hintedFrame.evaluate(
          () => (window as unknown as { __sameDocument?: string }).__sameDocument,
        ),
        'the same document, not a reload',
      ).toBe('yes')
      expect((await readEmbed(hintedFrame)).host, 'the hint survives the re-mint').toBe(HOST_HINT)
    } finally {
      await page.close()
      run.close()
    }
  }, 60_000)

  it('EMBED-PAINTS-SNAPSHOT-KIND: a snapshot run with PNG frames paints live and reports kind snapshot', async () => {
    const stream = plantHubRun({ runId: 'r-bridge-snap', kind: 'snapshot', frameBytes: held().png })
    const liveUrl = await mintRunLiveUrl('r-bridge-snap')
    const page = await hostPage([{ name: 'dashboard', src: hinted(liveUrl) }])
    try {
      await waitForReports(page, 'dashboard', 'ready', seenEvent('ready'))
      const frame = await embedFrame(page, 'dashboard')
      // Before any frame: the declared snapshot kind is a painter, so the page waits for a frame
      // rather than saying it cannot show this stream.
      const waiting = await readEmbed(frame)
      expect(waiting.state, 'the snapshot kind takes the painting arm, not the no-stream one')
        .toBe('connecting')
      expect(waiting.messageText).toBe('waiting for the first frame…')

      const startedBy = Date.now() + 10_000
      while (!stream.started() && Date.now() < startedBy) await sleep(25)
      for (let index = 0; index < 3; index += 1) {
        stream.emit()
        await sleep(100)
      }
      const reading = await embedUntil(frame, 'the snapshot embed painting live', (seen) =>
        seen.state === 'live' && seen.frames > 0)
      expect(reading.frames, 'PNG snapshot bytes were painted').toBeGreaterThan(0)

      const reports = await waitForReports(page, 'dashboard', 'a frame report', seenEvent('frame'))
      expect(reports[0]?.data, 'ready names the declared snapshot kind')
        .toEqual({ event: 'ready', kind: 'snapshot' })
      const frameReport = reports.find((report) => report.data.event === 'frame')
      expect(frameReport?.data.kind, 'the frame report names the snapshot kind').toBe('snapshot')
    } finally {
      await page.close()
      await stream.close()
    }
  }, 60_000)

  it('EMBED-SESSION-ENDED: an editor session minted through the editor door, then ended, is named session-ended', async () => {
    const editor = plantEditorSubject(held().harness, {
      sessionId: 'ed-bridge',
      kind: 'cdp-screencast',
      frameBytes: held().jpeg,
    })
    let page: Page | undefined
    try {
      const liveUrl = await mintEditorLiveUrl('ed-bridge')
      page = await hostPage([{ name: 'dashboard', src: hinted(liveUrl) }])
      const open = page
      const frame = await embedFrame(open, 'dashboard')
      await embedUntil(frame, 'the editor embed painting live', (seen) =>
        seen.state === 'live' && seen.frames > 0)

      await editor.end()
      const reading = await embedUntil(frame, 'the session-ended state', (seen) =>
        seen.state === 'session-ended')
      expect(reading.messageText, 'the page names the ended session in its own words')
        .toBe(LIVE_EMBED_SESSION_ENDED_MESSAGE)
      const reports = await waitForReports(open, 'dashboard', 'an ended report', seenEvent('ended'))
      expect(eventsNamed(reports, 'ended').map((report) => report.data))
        .toEqual([{ event: 'ended', reason: 'sessionEnded' }])
      expect(
        reports.some((report) => report.data.event === 'lost'),
        'a named end is not a lost connection',
      ).toBe(false)
    } finally {
      await page?.close()
      await editor.close()
    }
  }, 60_000)
})
