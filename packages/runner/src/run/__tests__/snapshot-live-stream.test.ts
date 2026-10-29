import { describe, it, expect } from 'vitest'
import type { LiveFrame } from '@vostride/agent-qa-schema'
import type { LiveStreamCapability } from '../../platform.js'
import type { RunTimerPort } from '../ports.js'
import { createLiveStreamHub, LIVE_STREAM_STOP_GRACE_MS } from '../live-stream-hub.js'
import {
  createSnapshotLiveStream,
  imageSizeOf,
  LIVE_SNAPSHOT_INTERVAL_MS,
  liveStreamFor,
} from '../snapshot-live-stream.js'

/**
 * The hub suite's MULTI-SLOT fake timer, keyed by delay so a cell fires exactly the timer it means.
 * `now()` reads a clock the cell can advance, which is what lets TIMESTAMP-AT-RESOLVE tell the
 * capture's start from its resolution.
 */
interface FakeTimer extends RunTimerPort {
  fire(delayMs: number): number
  pending(delayMs: number): number
  advance(ms: number): void
}

function makeFakeTimer(): FakeTimer {
  let nextId = 1
  let clock = 1_700_000_000_000
  const scheduled = new Map<number, { delayMs: number; fn: () => void }>()
  return {
    schedule(delayMs: number, fn: () => void) {
      const id = nextId++
      scheduled.set(id, { delayMs, fn })
      return () => {
        scheduled.delete(id)
      }
    },
    now: () => clock,
    advance(ms: number) {
      clock += ms
    },
    fire(delayMs: number): number {
      const due = [...scheduled.entries()].filter(([, entry]) => entry.delayMs === delayMs)
      for (const [id, entry] of due) {
        scheduled.delete(id)
        entry.fn()
      }
      return due.length
    },
    pending(delayMs: number): number {
      return [...scheduled.values()].filter((entry) => entry.delayMs === delayMs).length
    },
  }
}

/** A capture whose answers the cell hands out one at a time, oldest call first. */
interface HeldCapture {
  capture: () => Promise<Uint8Array | undefined>
  readonly calls: number
  resolveNext(bytes: Uint8Array | undefined): void
  rejectNext(error: Error): void
}

function makeHeldCapture(): HeldCapture {
  const held: Array<{
    resolve: (bytes: Uint8Array | undefined) => void
    reject: (error: Error) => void
  }> = []
  let calls = 0
  return {
    capture() {
      calls += 1
      return new Promise((resolve, reject) => {
        held.push({ resolve, reject })
      })
    },
    get calls() {
      return calls
    },
    resolveNext(bytes) {
      const next = held.shift()
      expect(next, 'a capture is in flight to answer').toBeDefined()
      if (next === undefined) return
      next.resolve(bytes)
    },
    rejectNext(error) {
      const next = held.shift()
      expect(next, 'a capture is in flight to answer').toBeDefined()
      if (next === undefined) return
      next.reject(error)
    },
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** SOI, an APP0, a DHT (C4, which is NOT a frame header) and then SOF0 carrying the size. */
function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46,
    0xff, 0xc4, 0x00, 0x06, 0x00, 0x09, 0x00, 0x09,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ])
}

const BYTES = new Uint8Array([1, 2, 3, 4])

describe('createSnapshotLiveStream', () => {
  it('FIRST-CAPTURE-ON-START: start() captures once before any timer fires', async () => {
    const timer = makeFakeTimer()
    const held = makeHeldCapture()
    const stream = createSnapshotLiveStream({ capture: held.capture, timer })
    expect(stream.kind).toBe('snapshot')
    expect(held.calls, 'nothing is captured before start').toBe(0)
    await stream.start(() => {})
    expect(held.calls, 'the first capture does not wait a whole interval').toBe(1)
    expect(timer.pending(LIVE_SNAPSHOT_INTERVAL_MS), 'and the next tick is armed').toBe(1)
  })

  it('TICK-EVERY-1S: three 1s ticks after the first capture make four captures and four frames', async () => {
    const timer = makeFakeTimer()
    const held = makeHeldCapture()
    const frames: LiveFrame[] = []
    const stream = createSnapshotLiveStream({ capture: held.capture, timer })
    await stream.start((frame) => frames.push(frame))
    held.resolveNext(BYTES)
    await settle()
    for (let i = 0; i < 3; i += 1) {
      expect(timer.fire(LIVE_SNAPSHOT_INTERVAL_MS)).toBe(1)
      held.resolveNext(BYTES)
      await settle()
    }
    expect(held.calls).toBe(4)
    expect(frames).toHaveLength(4)
  })

  it('SKIP-WHILE-IN-FLIGHT: a tick during a pending capture is skipped, never queued', async () => {
    const timer = makeFakeTimer()
    const held = makeHeldCapture()
    const frames: LiveFrame[] = []
    const stream = createSnapshotLiveStream({ capture: held.capture, timer })
    await stream.start((frame) => frames.push(frame))
    expect(held.calls).toBe(1)
    timer.fire(LIVE_SNAPSHOT_INTERVAL_MS)
    await settle()
    timer.fire(LIVE_SNAPSHOT_INTERVAL_MS)
    await settle()
    expect(held.calls, 'two ticks landed on an in-flight capture and captured nothing').toBe(1)
    expect(timer.pending(LIVE_SNAPSHOT_INTERVAL_MS), 'exactly one tick is ever armed').toBe(1)
    held.resolveNext(BYTES)
    await settle()
    expect(frames, 'the skipped ticks were not replayed').toHaveLength(1)
    timer.fire(LIVE_SNAPSHOT_INTERVAL_MS)
    await settle()
    expect(held.calls, 'the next tick after it resolved captures again').toBe(2)
  })

  it('UNDEFINED-CAPTURE-EMITS-NOTHING: an undefined or empty capture emits no frame, and the next tick still runs', async () => {
    const timer = makeFakeTimer()
    const held = makeHeldCapture()
    const frames: LiveFrame[] = []
    const stream = createSnapshotLiveStream({ capture: held.capture, timer })
    await stream.start((frame) => frames.push(frame))
    held.resolveNext(undefined)
    await settle()
    timer.fire(LIVE_SNAPSHOT_INTERVAL_MS)
    held.resolveNext(new Uint8Array(0))
    await settle()
    expect(frames).toHaveLength(0)
    timer.fire(LIVE_SNAPSHOT_INTERVAL_MS)
    await settle()
    expect(held.calls, 'the producer kept ticking').toBe(3)
    held.resolveNext(BYTES)
    await settle()
    expect(frames).toHaveLength(1)
  })

  it('CAPTURE-REJECT-EMITS-NOTHING: a rejected capture emits no frame, and the next tick still runs', async () => {
    const timer = makeFakeTimer()
    const held = makeHeldCapture()
    const frames: LiveFrame[] = []
    const stream = createSnapshotLiveStream({ capture: held.capture, timer })
    await stream.start((frame) => frames.push(frame))
    held.rejectNext(new Error('device went away'))
    await settle()
    expect(frames).toHaveLength(0)
    timer.fire(LIVE_SNAPSHOT_INTERVAL_MS)
    await settle()
    expect(held.calls, 'a rejection does not wedge the in-flight flag').toBe(2)
    held.resolveNext(BYTES)
    await settle()
    expect(frames).toHaveLength(1)
  })

  it('STOP-DROPS-LATE-CAPTURE: a capture resolving after stop() emits nothing and arms nothing', async () => {
    const timer = makeFakeTimer()
    const held = makeHeldCapture()
    const frames: LiveFrame[] = []
    const stream = createSnapshotLiveStream({ capture: held.capture, timer })
    await stream.start((frame) => frames.push(frame))
    await stream.stop()
    held.resolveNext(BYTES)
    await settle()
    expect(frames).toHaveLength(0)
    expect(timer.pending(LIVE_SNAPSHOT_INTERVAL_MS)).toBe(0)
    await stream.stop()
    expect(timer.pending(LIVE_SNAPSHOT_INTERVAL_MS), 'stop is idempotent').toBe(0)
  })

  it('IDS-MONOTONIC: frame ids are 1, 2, 3 in emission order, each labelled snapshot', async () => {
    const timer = makeFakeTimer()
    const held = makeHeldCapture()
    const frames: LiveFrame[] = []
    const stream = createSnapshotLiveStream({ capture: held.capture, timer })
    await stream.start((frame) => frames.push(frame))
    held.resolveNext(BYTES)
    await settle()
    for (let i = 0; i < 2; i += 1) {
      timer.fire(LIVE_SNAPSHOT_INTERVAL_MS)
      held.resolveNext(BYTES)
      await settle()
    }
    expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3])
    expect(frames.map((frame) => frame.kind)).toEqual(['snapshot', 'snapshot', 'snapshot'])
  })

  it('TIMESTAMP-AT-RESOLVE: each frame is stamped with the clock when its capture resolved', async () => {
    const timer = makeFakeTimer()
    const held = makeHeldCapture()
    const frames: LiveFrame[] = []
    const stream = createSnapshotLiveStream({ capture: held.capture, timer })
    await stream.start((frame) => frames.push(frame))
    const expected: number[] = []
    timer.advance(300)
    expected.push(timer.now())
    held.resolveNext(BYTES)
    await settle()
    for (const took of [175, 420]) {
      timer.fire(LIVE_SNAPSHOT_INTERVAL_MS)
      timer.advance(took)
      expected.push(timer.now())
      held.resolveNext(BYTES)
      await settle()
    }
    expect(frames.map((frame) => frame.metadata.timestamp)).toEqual(expected)
  })

  it('UNWATCHED-CAPTURES-NOTHING: through the hub, nothing is captured until a viewer subscribes, and the grace stops it', async () => {
    const timer = makeFakeTimer()
    const held = makeHeldCapture()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, createSnapshotLiveStream({ capture: held.capture, timer }))
    await settle()
    timer.fire(LIVE_SNAPSHOT_INTERVAL_MS)
    await settle()
    expect(held.calls, 'a registered but unwatched producer captures nothing').toBe(0)
    expect(hub.capabilityOf(0)).toEqual({ kind: 'snapshot' })

    const frames: LiveFrame[] = []
    const subscription = hub.subscribe(0, (frame) => frames.push(frame))
    await settle()
    expect(held.calls, 'the first viewer starts it').toBe(1)
    held.resolveNext(BYTES)
    await settle()
    expect(frames).toHaveLength(1)
    expect(frames[0].kind).toBe('snapshot')

    subscription?.unsubscribe()
    timer.fire(LIVE_STREAM_STOP_GRACE_MS)
    await settle()
    expect(timer.pending(LIVE_SNAPSHOT_INTERVAL_MS), 'the last viewer leaving stops the ticks').toBe(0)
    timer.fire(LIVE_SNAPSHOT_INTERVAL_MS)
    await settle()
    expect(held.calls).toBe(1)
  })
})

describe('imageSizeOf', () => {
  it('IMAGE-SIZE-PNG: reads the IHDR width and height, and a snapshot frame carries them', async () => {
    const header = pngHeader(800, 600)
    expect(imageSizeOf(header)).toEqual({ width: 800, height: 600 })

    const timer = makeFakeTimer()
    const frames: LiveFrame[] = []
    const stream = createSnapshotLiveStream({ capture: async () => header, timer })
    await stream.start((frame) => frames.push(frame))
    await settle()
    expect(frames).toHaveLength(1)
    expect(frames[0].metadata.width).toBe(800)
    expect(frames[0].metadata.height).toBe(600)
  })

  it('IMAGE-SIZE-JPEG: reads height then width from the first SOF segment, skipping DHT', () => {
    expect(imageSizeOf(jpegHeader(640, 480))).toEqual({ width: 640, height: 480 })
  })

  it('IMAGE-SIZE-UNKNOWN-ZERO: anything it cannot read answers 0 by 0', () => {
    expect(imageSizeOf(new Uint8Array([7, 8, 9]))).toEqual({ width: 0, height: 0 })
    expect(imageSizeOf(pngHeader(800, 600).subarray(0, 20))).toEqual({ width: 0, height: 0 })
    expect(imageSizeOf(jpegHeader(640, 480).subarray(0, 24))).toEqual({ width: 0, height: 0 })
  })
})

function makeScreencast(kind: LiveStreamCapability['kind']): LiveStreamCapability {
  return {
    kind,
    async start() {},
    async ack() {},
    async stop() {},
  }
}

function makeScreenshotSpy(): { screenshot: () => Promise<Buffer | undefined>; calls: () => number } {
  let calls = 0
  return {
    screenshot: async () => {
      calls += 1
      return Buffer.from(pngHeader(320, 240))
    },
    calls: () => calls,
  }
}

describe('liveStreamFor', () => {
  it('LIVE-STREAM-FOR-SELECTION: a continuous stream with a screenshot() gets a snapshot fallback over it', async () => {
    const timer = makeFakeTimer()
    const screencast = makeScreencast('cdp-screencast')
    const shots = makeScreenshotSpy()
    const registration = liveStreamFor({ liveStream: screencast, screenshot: shots.screenshot }, { timer })
    expect(registration?.capability).toBe(screencast)
    expect(registration?.fallback?.kind).toBe('snapshot')
    const frames: LiveFrame[] = []
    await registration?.fallback?.start((frame) => frames.push(frame))
    await settle()
    expect(shots.calls(), 'the fallback captures through screenshot()').toBe(1)
    expect(frames.map((frame) => frame.metadata.width)).toEqual([320])
    await registration?.fallback?.stop()
  })

  it('LIVE-STREAM-FOR-SELECTION: no continuous stream but a screenshot() gets a snapshot producer and no fallback', async () => {
    const timer = makeFakeTimer()
    const shots = makeScreenshotSpy()
    const registration = liveStreamFor({ screenshot: shots.screenshot }, { timer })
    expect(registration?.capability.kind).toBe('snapshot')
    expect(registration !== undefined && 'fallback' in registration).toBe(false)
    await registration?.capability.start(() => {})
    await settle()
    expect(shots.calls()).toBe(1)
    await registration?.capability.stop()
  })

  it("LIVE-STREAM-FOR-SELECTION: an adapter's own snapshot stream is used as-is, and its screenshot() is never wrapped", async () => {
    const timer = makeFakeTimer()
    const own = makeScreencast('snapshot')
    const shots = makeScreenshotSpy()
    const registration = liveStreamFor({ liveStream: own, screenshot: shots.screenshot }, { timer })
    expect(registration?.capability).toBe(own)
    expect(registration !== undefined && 'fallback' in registration).toBe(false)
    await registration?.capability.start(() => {})
    timer.fire(LIVE_SNAPSHOT_INTERVAL_MS)
    await settle()
    expect(shots.calls(), 'the context-switching screenshot() is never reached').toBe(0)
    expect(timer.pending(LIVE_SNAPSHOT_INTERVAL_MS), 'nothing liveStreamFor built is ticking').toBe(0)
  })

  it('LIVE-STREAM-FOR-SELECTION: an adapter with neither, or no adapter, gets nothing', () => {
    expect(liveStreamFor({})).toBeUndefined()
    expect(liveStreamFor(undefined)).toBeUndefined()
  })
})
