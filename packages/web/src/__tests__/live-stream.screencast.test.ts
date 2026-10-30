// A module mock of the browser driver would cover this whole file and leave nothing to measure.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { firefox, webkit } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLiveStreamHub } from '@vostride/agent-qa-runner'
import type { LiveFrame, LiveFrameEndReason } from '@vostride/agent-qa-schema'

import { WebPlatformAdapter } from '../adapter.js'
import { startLiveStreamFixturePage } from './fixtures/live-stream-fixture-page.js'
import type { LiveStreamFixturePage } from './fixtures/live-stream-fixture-page.js'

const BROWSER_INSTALL_INSTRUCTION =
  'a real Chromium is required for the change-driven screencast cells: run '
  + '`pnpm exec playwright install chromium`. This is a RED, not a skip — a cell that skips itself '
  + 'when the browser is absent is green on every machine that cannot run it.'

/**
 * k = 5, and it is not negotiable downward. The loops below spell the literal rather than reading a
 * constant, so what a reader greps for and what the loop runs cannot drift apart; each arm asserts
 * its own count at the end, which is what stops a hand-edited bound from quietly shrinking k.
 */
const EXPECTED_ITERATIONS = 5
/** The positive arm's window and floor. */
const ANIMATED_WINDOW_MS = 3_000
const ANIMATED_MIN_FRAMES = 3
// Bands around the keepalive period: fewer frames is a silent producer, more is a poller.
const STATIC_WINDOW_MS = 6_000
const STATIC_MIN_FRAMES = 2
const STATIC_MAX_FRAMES = 4
const KEEPALIVE_MIN_GAP_MS = 1_800
/** TIMESTAMP-EPOCH-MS: a capture time in epoch ms is within this of the receiver's clock. */
const EPOCH_MS_TOLERANCE_MS = 5_000
// Playwright's default launch timeout equals the cell's budget, so a hung launch would eat it.
const NON_CHROMIUM_LAUNCH_BOUND_MS = 30_000

let page: LiveStreamFixturePage | undefined
let tall: LiveStreamFixturePage | undefined

// Local to this file so `live-stream-fixture-page.ts` stays a byte-for-byte twin of cli's.
async function startTallAnimatingPage(): Promise<LiveStreamFixturePage> {
  const server = createServer((req, res) => {
    const scroll = Number(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('scroll') ?? 0)
    const body = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>tall ${String(scroll)}</title>
<style>
  html, body { margin: 0; background: #101418; }
  body { height: 4000px; }
  #box { width: 200px; height: 200px; background: #4ade80; position: fixed; top: 80px; left: 0; }
  @keyframes slide { from { transform: translateX(0) } to { transform: translateX(600px) } }
  #box { animation: slide 1.2s linear infinite alternate; }
</style>
</head>
<body><div id="box"></div>
<script>window.addEventListener('load', () => { window.scrollTo(0, ${String(scroll)}) })</script>
</body>
</html>
`
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

beforeAll(async () => {
  page = await startLiveStreamFixturePage()
  tall = await startTallAnimatingPage()
}, 60_000)

afterAll(async () => {
  await page?.close().catch(() => undefined)
  await tall?.close().catch(() => undefined)
  page = undefined
  tall = undefined
})

/** Resolve once `predicate` holds, or give up after `timeoutMs`; the caller asserts on the result. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

const fixture = (): LiveStreamFixturePage => {
  expect(page, 'the fixture page never started').toBeDefined()
  return page as LiveStreamFixturePage
}

/** Bring up a real headless Chromium on the fixture page. A launch failure is reported as one. */
async function adapterOn(url: string): Promise<WebPlatformAdapter> {
  const adapter = new WebPlatformAdapter()
  try {
    await adapter.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
  } catch (error) {
    throw new Error(
      `${BROWSER_INSTALL_INSTRUCTION} underlying error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  await adapter.execute({ type: 'navigate', to: 'url', url })
  return adapter
}

/** Collect frames for `windowMs`, acking each immediately — the change-driven contract's own ack. */
async function collect(
  capability: NonNullable<WebPlatformAdapter['liveStream']>,
  windowMs: number,
): Promise<LiveFrame[]> {
  const frames: LiveFrame[] = []
  await capability.start((frame) => {
    frames.push(frame)
    void capability.ack(frame.id)
  })
  await new Promise((resolve) => setTimeout(resolve, windowMs))
  await capability.stop()
  return frames
}

/**
 * Start, wait for the first frame, then collect every frame that arrives in the `windowMs` after
 * it, acking each. The returned list starts with that first frame, which the window excludes.
 */
async function collectAfterFirst(
  capability: NonNullable<WebPlatformAdapter['liveStream']>,
  windowMs: number,
): Promise<LiveFrame[]> {
  const frames: LiveFrame[] = []
  let firstAt: number | undefined
  let resolveFirst: () => void = () => undefined
  const first = new Promise<void>((resolve) => { resolveFirst = resolve })
  await capability.start((frame) => {
    const now = Date.now()
    if (firstAt === undefined) {
      firstAt = now
      resolveFirst()
    }
    if (now - firstAt <= windowMs) frames.push(frame)
    void capability.ack(frame.id)
  })
  await Promise.race([first, new Promise((resolve) => setTimeout(resolve, 5_000))])
  await new Promise((resolve) => setTimeout(resolve, windowMs))
  await capability.stop()
  return frames
}

/**
 * Withdraw the running screencast the way a dying CDP session does, while the browser stays up:
 * detach the adapter's own session. The session is private and never handed out, so the cell
 * reaches it through a cast; nothing in the product can.
 */
async function detachPrivateScreencastSession(adapter: WebPlatformAdapter): Promise<void> {
  const session = (adapter as unknown as { screencast: { detach(): Promise<void> } | null }).screencast
  expect(session, 'the screencast is running on a private CDP session').not.toBeNull()
  await session?.detach()
}

describe('WebPlatformAdapter.liveStream is CHANGE-DRIVEN, not polled', () => {
  it('POSITIVE ARM: an animating page produces frames, k=5, zero tolerated failures', async () => {
    const adapter = await adapterOn(`${fixture().url}?animate=1`)
    const counts: number[] = []
    try {
      const capability = adapter.liveStream
      expect(capability, 'a live Chromium adapter declares a screencast capability').toBeDefined()
      expect(capability?.kind).toBe('cdp-screencast')

      for (let k = 0; k < 5; k++) {
        const frames = await collect(capability as NonNullable<typeof capability>, ANIMATED_WINDOW_MS)
        counts.push(frames.length)
        expect(
          frames.length,
          `iteration ${String(k)}/5: an animating page produced ${String(frames.length)} frame(s) in `
          + `${String(ANIMATED_WINDOW_MS)} ms. counts so far = [${counts.join(', ')}]`,
        ).toBeGreaterThanOrEqual(ANIMATED_MIN_FRAMES)
        for (const [index, frame] of frames.entries()) {
          expect(
            [frame.bytes[0], frame.bytes[1]],
            `iteration ${String(k)} frame ${String(index)}: every frame is a JPEG (SOI FF D8)`,
          ).toEqual([0xFF, 0xD8])
          expect(frame.metadata.width, 'a frame carries the page\'s own geometry').toBeGreaterThan(0)
          expect(frame.metadata.height).toBeGreaterThan(0)
        }
        // FRAME IDS ARE THE ACK CORRELATION KEY — for the hub's `awaiting` map, for the wire's
        // `frame.id`/`ack.id` pair, and for the embed page's pending header. Two frames sharing an
        // id is not a cosmetic wart: the hub's second `awaiting.set(id, …)` overwrites the first,
        // orphaning its bound timer and dropping the outstanding set, so an ack lands on the wrong
        // frame and one frame is never acked at all.
        const ids = frames.map((frame) => frame.id)
        expect(
          new Set(ids).size,
          `iteration ${String(k)}: frame ids must be DISTINCT — they are the ack correlation key. `
          + `saw ${String(new Set(ids).size)} distinct id(s) across ${String(ids.length)} frames, `
          + `first few = [${ids.slice(0, 5).join(', ')}]`,
        ).toBe(ids.length)
        expect(
          ids,
          `iteration ${String(k)}: and they are monotonic, so a later frame is never mistaken for `
          + 'an earlier one',
        ).toEqual([...ids].sort((left, right) => left - right))
      }
      expect(counts, 'both arms run k=5 — a shrunken loop is a weaker claim, silently')
        .toHaveLength(EXPECTED_ITERATIONS)
    } finally {
      await adapter.cleanup().catch(() => undefined)
    }
  }, 180_000)

  it('STATIC-PAGE-KEEPALIVE: a static page produces a fresh frame every 2 s, never faster, k=5', async () => {
    // RED under a silent screencast (a static page goes quiet after its first paint, so a healthy
    // page reads amber) and RED under `setInterval(page.screenshot)` at 1 s (too many frames, and
    // every gap under the floor).
    const adapter = await adapterOn(fixture().url)
    const counts: number[] = []
    try {
      const capability = adapter.liveStream
      expect(capability).toBeDefined()

      // Let the first paint settle so the window measures a page that is already static.
      await new Promise((resolve) => setTimeout(resolve, 1_000))

      for (let k = 0; k < 5; k++) {
        const frames = await collectAfterFirst(
          capability as NonNullable<typeof capability>,
          STATIC_WINDOW_MS,
        )
        const after = frames.length - 1
        counts.push(after)
        const stamps = frames.map((frame) => frame.metadata.timestamp)
        expect(
          after,
          `iteration ${String(k)}/5: a static page produced ${String(after)} frame(s) in the `
          + `${String(STATIC_WINDOW_MS)} ms after its first frame. counts so far = [${counts.join(', ')}], `
          + `timestamps = [${stamps.join(', ')}]. Fewer than ${String(STATIC_MIN_FRAMES)} is a silent `
          + `producer; more than ${String(STATIC_MAX_FRAMES)} is a poller.`,
        ).toBeGreaterThanOrEqual(STATIC_MIN_FRAMES)
        expect(after, `iteration ${String(k)}/5: counts so far = [${counts.join(', ')}]`)
          .toBeLessThanOrEqual(STATIC_MAX_FRAMES)
        // The gap from the first frame to the second is not bounded: CDP may deliver a second paint
        // right after the first. From the second frame on, only keepalives arrive.
        for (let index = 1; index + 1 < frames.length; index++) {
          const earlier = frames[index]?.metadata.timestamp
          const later = frames[index + 1]?.metadata.timestamp
          expect(earlier, `iteration ${String(k)} frame ${String(index)} carries a capture time`)
            .toBeTypeOf('number')
          expect(later).toBeTypeOf('number')
          expect(
            (later as number) - (earlier as number),
            `iteration ${String(k)}: frames ${String(index)} and ${String(index + 1)} are `
            + `${String((later as number) - (earlier as number))} ms apart; timestamps = `
            + `[${stamps.join(', ')}]. A keepalive fires only after 2 s of quiet.`,
          ).toBeGreaterThanOrEqual(KEEPALIVE_MIN_GAP_MS)
        }
      }
      expect(counts, 'both arms run k=5 — a shrunken loop is a weaker claim, silently')
        .toHaveLength(EXPECTED_ITERATIONS)
    } finally {
      await adapter.cleanup().catch(() => undefined)
    }
  }, 180_000)

  it('TIMESTAMP-EPOCH-MS: every Chromium frame carries its capture time in epoch milliseconds', async () => {
    // CDP's `metadata.timestamp` is `Network.TimeSinceEpoch`: SECONDS. Passed through unconverted it
    // reads as January 1970 to every layer that treats it as epoch ms, and the viewer's dot would
    // compute an age of fifty-odd years on a healthy stream.
    const adapter = await adapterOn(`${fixture().url}?animate=1`)
    try {
      const capability = adapter.liveStream as NonNullable<WebPlatformAdapter['liveStream']>
      const received: { frame: LiveFrame; receivedAt: number }[] = []
      await capability.start((frame) => {
        received.push({ frame, receivedAt: Date.now() })
        void capability.ack(frame.id)
      })
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      await capability.stop()

      expect(received.length, 'an animating page produced frames to measure').toBeGreaterThan(0)
      for (const [index, { frame, receivedAt }] of received.entries()) {
        const stamp = frame.metadata.timestamp
        expect(stamp, `frame ${String(index)} carries a capture time`).toBeTypeOf('number')
        expect(
          Math.abs((stamp as number) - receivedAt),
          `frame ${String(index)}: timestamp ${String(stamp)} against Date.now() ${String(receivedAt)} `
          + 'at receipt. A value near 1.7e9 is CDP seconds passed through unconverted.',
        ).toBeLessThan(EPOCH_MS_TOLERANCE_MS)
      }
    } finally {
      await adapter.cleanup().catch(() => undefined)
    }
  }, 180_000)

  it('THE ACK IS THE THROTTLE: a viewer that never acks stops receiving frames', async () => {
    // The change-driven contract has TWO halves and the arms above measure only one. This is the
    // other: CDP will not produce frame N+1 until N is acked, which is what makes the ack a real
    // backpressure signal rather than a formality — and what makes the hub's ack bound and the
    // proxy's slow-viewer drop mean something. Measured, because "the ack throttles" is exactly the
    // kind of claim that is true of the protocol and false of an implementation that forgot to send
    // one. A screenshot poller has no such half at all: it produces on a timer regardless.
    const adapter = await adapterOn(`${fixture().url}?animate=1`)
    try {
      const capability = adapter.liveStream as NonNullable<WebPlatformAdapter['liveStream']>

      const unacked: LiveFrame[] = []
      await capability.start((frame) => { unacked.push(frame) })
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      await capability.stop()

      const acked: LiveFrame[] = []
      await capability.start((frame) => { acked.push(frame); void capability.ack(frame.id) })
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      await capability.stop()

      expect(
        unacked.length,
        `a viewer that never acks received ${String(unacked.length)} frames in 3 s — the producer `
        + 'is meant to stall on the unacked frame, not keep encoding',
      ).toBeLessThan(10)
      expect(
        acked.length,
        `the same page with acks produced ${String(acked.length)} frames; without them `
        + `${String(unacked.length)}. If those are close, the ack is not the throttle and the `
        + 'backpressure the hub and the frame proxy are built on does not exist.',
      ).toBeGreaterThan(unacked.length * 5)
    } finally {
      await adapter.cleanup().catch(() => undefined)
    }
  }, 180_000)

  it('TAB-FOLLOW: the running screencast follows the page the test acts on, with no end and no re-register', async () => {
    // RED while the screencast stays bound to the page it started on: every frame after the switch
    // still carries page A's scroll offset. Driven through a REAL hub, because "no end, no
    // re-register" is a fact about what a subscriber sees, not about the capability alone.
    const tallUrl = (tall as LiveStreamFixturePage).url
    const adapter = await adapterOn(`${tallUrl}?scroll=0`)
    const hub = createLiveStreamHub()
    const frames: LiveFrame[] = []
    const ends: LiveFrameEndReason[] = []
    try {
      const before = adapter.liveStream
      expect(before?.kind).toBe('cdp-screencast')
      hub.register(0, before)
      const subscription = hub.subscribe(
        0,
        (frame) => { frames.push(frame); subscription?.ack(frame.id) },
        (reason) => { ends.push(reason) },
      )
      expect(subscription, 'the hub accepts a subscriber for the registered handle').toBeDefined()
      const onA = await waitFor(() => frames.some((frame) => frame.metadata.scrollOffsetY === 0), 3_000)
      expect(onA, 'page A (scrolled to 0) streams before the switch').toBe(true)

      const opened = await adapter.execute({ type: 'tab', action: 'new', url: `${tallUrl}?scroll=500` })
      expect(opened.success, `tab new failed: ${String(opened.error)}`).toBe(true)
      const seenAtNew = frames.length
      const onB = await waitFor(
        () => frames.slice(seenAtNew).some((frame) => frame.metadata.scrollOffsetY === 500),
        3_000,
      )
      expect(
        onB,
        'within 3 s of `tab new`, frames come from the new page (scrollOffsetY 500). offsets seen '
        + `after the switch = [${[...new Set(frames.slice(seenAtNew).map((f) => f.metadata.scrollOffsetY))].join(', ')}]`,
      ).toBe(true)

      const switched = await adapter.execute({ type: 'tab', action: 'switch', index: 0 })
      expect(switched.success, `tab switch failed: ${String(switched.error)}`).toBe(true)
      const seenAtSwitch = frames.length
      const backOnA = await waitFor(
        () => frames.slice(seenAtSwitch).some((frame) => frame.metadata.scrollOffsetY === 0),
        3_000,
      )
      expect(backOnA, 'switching back to tab 0 brings page A\'s frames (scrollOffsetY 0) again').toBe(true)

      expect(ends, 'the subscriber was never told its stream ended').toEqual([])
      expect(adapter.liveStream, 'the same capability object before and after the switches').toBe(before)
      expect(hub.capabilityOf(0).kind, 'the handle still declares the screencast').toBe('cdp-screencast')
      const ids = frames.map((frame) => frame.id)
      expect(ids, 'frame ids keep one monotonic sequence across the re-binds')
        .toEqual([...ids].sort((left, right) => left - right))
      subscription?.unsubscribe()
    } finally {
      await hub.close().catch(() => undefined)
      await adapter.cleanup().catch(() => undefined)
    }
  }, 180_000)

  it('WITHDRAWN-FALLS-BACK: a screencast withdrawn under a live browser becomes labelled 1 s snapshots, and stop() ends them', async () => {
    const adapter = await adapterOn(`${fixture().url}?animate=1`)
    try {
      const capability = adapter.liveStream as NonNullable<WebPlatformAdapter['liveStream']>
      const received: { frame: LiveFrame; at: number }[] = []
      await capability.start((frame) => {
        received.push({ frame, at: Date.now() })
        void capability.ack(frame.id)
      })
      const streaming = await waitFor(() => received.length > 0, 3_000)
      expect(streaming, 'the screencast was running before the withdrawal').toBe(true)

      await detachPrivateScreencastSession(adapter)
      const withdrawnAt = Date.now()
      const fellBack = await waitFor(
        () => received.some(({ frame, at }) => at >= withdrawnAt && frame.kind === 'snapshot'),
        4_000,
      )
      expect(
        fellBack,
        'within 4 s of the withdrawal the consumer receives frames labelled `snapshot`. kinds seen '
        + `after it = [${received.filter(({ at }) => at >= withdrawnAt).map(({ frame }) => String(frame.kind)).join(', ')}]`,
      ).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 3_200))
      const snapshots = received.filter(({ frame }) => frame.kind === 'snapshot')
      expect(snapshots.length, 'snapshots keep coming about once a second').toBeGreaterThanOrEqual(3)
      for (let index = 1; index < snapshots.length; index++) {
        const gap = (snapshots[index] as { at: number }).at - (snapshots[index - 1] as { at: number }).at
        expect(gap, `snapshot ${String(index)} arrived ${String(gap)} ms after the one before`)
          .toBeGreaterThanOrEqual(600)
        expect(gap).toBeLessThanOrEqual(1_600)
      }
      const ids = received.map(({ frame }) => frame.id)
      expect(ids, 'the fallback continues the capability\'s one monotonic id sequence')
        .toEqual([...ids].sort((left, right) => left - right))
      expect(new Set(ids).size).toBe(ids.length)
      expect(capability.kind, 'the declared kind stays the screencast; the frames carry the label')
        .toBe('cdp-screencast')

      await capability.stop()
      const atStop = received.length
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      expect(received.length, 'stop() halts the snapshot fallback').toBe(atStop)
    } finally {
      await adapter.cleanup().catch(() => undefined)
    }
  }, 180_000)

  it('WITHDRAWN-FALLS-BACK (re-bind): a tab switch after a withdrawal restores the screencast and stops the snapshots', async () => {
    const adapter = await adapterOn(`${fixture().url}?animate=1`)
    try {
      const capability = adapter.liveStream as NonNullable<WebPlatformAdapter['liveStream']>
      const received: { frame: LiveFrame; at: number }[] = []
      await capability.start((frame) => {
        received.push({ frame, at: Date.now() })
        void capability.ack(frame.id)
      })
      expect(await waitFor(() => received.length > 0, 3_000)).toBe(true)
      await detachPrivateScreencastSession(adapter)
      const withdrawnAt = Date.now()
      expect(
        await waitFor(() => received.some(({ frame, at }) => at >= withdrawnAt && frame.kind === 'snapshot'), 4_000),
        'the fallback is running before the switch',
      ).toBe(true)

      const switched = await adapter.execute({ type: 'tab', action: 'switch', index: 0 })
      expect(switched.success).toBe(true)
      const switchedAt = Date.now()
      expect(
        await waitFor(() => received.some(({ frame, at }) => at >= switchedAt && frame.kind === undefined), 3_000),
        'screencast frames (no snapshot label) resume after the re-bind',
      ).toBe(true)
      const resumedAt = Date.now()
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      const lateSnapshots = received.filter(({ frame, at }) => at > resumedAt && frame.kind === 'snapshot')
      expect(lateSnapshots.length, 'the snapshot fallback stopped once the screencast was back').toBe(0)
      await capability.stop()
    } finally {
      await adapter.cleanup().catch(() => undefined)
    }
  }, 180_000)

  it('WITHDRAWN-FALLS-BACK (cleanup): cleanup() while the snapshot fallback runs stops it', async () => {
    const adapter = await adapterOn(`${fixture().url}?animate=1`)
    const received: LiveFrame[] = []
    try {
      const capability = adapter.liveStream as NonNullable<WebPlatformAdapter['liveStream']>
      await capability.start((frame) => {
        received.push(frame)
        void capability.ack(frame.id)
      })
      expect(await waitFor(() => received.length > 0, 3_000)).toBe(true)
      await detachPrivateScreencastSession(adapter)
      expect(
        await waitFor(() => received.some((frame) => frame.kind === 'snapshot'), 4_000),
        'the fallback is running before cleanup',
      ).toBe(true)
      await adapter.cleanup()
      const atCleanup = received.length
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      expect(received.length, 'no frame after cleanup()').toBe(atCleanup)
    } finally {
      await adapter.cleanup().catch(() => undefined)
    }
  }, 180_000)

  it('the capability getter\'s TWO gates: no page, and each non-chromium browser that launches within the stated bound', async ({ annotate }) => {
    // Gate 1: an adapter that has not been `setup()` has no page, so there is nothing to stream.
    const fresh = new WebPlatformAdapter()
    expect(
      fresh.liveStream,
      'a screencast needs a page; an adapter before setup() has none, and says so by absence',
    ).toBeUndefined()

    // And the positive half of gate 1: after a chromium setup, the capability is there. Measured
    // before any non-chromium launch is tried, so a browser that cannot launch never costs it.
    const chromium = await adapterOn(fixture().url)
    try {
      expect(chromium.liveStream, 'a set-up chromium adapter declares the screencast').toBeDefined()
      expect(chromium.liveStream?.kind).toBe('cdp-screencast')
    } finally {
      await chromium.cleanup().catch(() => undefined)
    }

    // Gate 2: the browser-name gate, measured on a REAL set-up adapter for each non-chromium
    // browser that launches within NON_CHROMIUM_LAUNCH_BOUND_MS. One that does not is reported as
    // unmeasured, with its error's first line, and is NEVER reported as measured.
    for (const [name, launcher] of [['firefox', firefox], ['webkit', webkit]] as const) {
      let unmeasured: string | undefined
      try {
        const probe = await launcher.launch({ headless: true, timeout: NON_CHROMIUM_LAUNCH_BOUND_MS })
        await probe.close()
      } catch (error) {
        unmeasured = (error instanceof Error ? error.message : String(error)).split('\n')[0]
      }
      if (unmeasured !== undefined) {
        const note = `NON-CHROMIUM-GATE ${name} unmeasured: ${unmeasured}`
        await annotate(note)
        continue
      }
      const adapter = new WebPlatformAdapter()
      try {
        await adapter.setup({ platform: 'web', browser: { name, headless: true } })
        expect(
          adapter.liveStream,
          'Page.startScreencast is a CDP call; a non-chromium target declares no stream rather '
          + 'than falling back to screenshots, an honest absence',
        ).toBeUndefined()
      } finally {
        await adapter.cleanup().catch(() => undefined)
      }
      const note = `NON-CHROMIUM-GATE ${name} measured`
      await annotate(note)
    }
  }, 180_000)

  it('cleanup() after start() stops the screencast — no later frames, no unhandled rejection', async () => {
    const rejections: unknown[] = []
    const probe = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', probe)
    const adapter = await adapterOn(`${fixture().url}?animate=1`)
    const frames: LiveFrame[] = []
    try {
      const capability = adapter.liveStream as NonNullable<WebPlatformAdapter['liveStream']>
      await capability.start((frame) => {
        frames.push(frame)
        void capability.ack(frame.id)
      })
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(frames.length, 'the stream was running before cleanup').toBeGreaterThan(0)

      await adapter.cleanup()
      const seenAtCleanup = frames.length
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(
        frames.length,
        'the CDP session is detached with the browser, so no frame can arrive after cleanup',
      ).toBe(seenAtCleanup)
      // Acking after the stream is gone is expected traffic, not an error — and must not become an
      // unhandled rejection, which would take a whole run down long after the live view closed.
      await capability.ack(seenAtCleanup + 999)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(rejections, 'a stopped screencast must not leave a rejection nobody handles').toEqual([])
    } finally {
      process.off('unhandledRejection', probe)
      await adapter.cleanup().catch(() => undefined)
    }
  }, 180_000)
})
