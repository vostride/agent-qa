import { describe, it, expect } from 'vitest'
import type { CompletedRunHandoff, LiveFrame, RunEventEnvelope } from '@vostride/agent-qa-schema'
import type { LiveStreamCapability } from '../../platform.js'
import { startRun } from '../shell.js'
import type { MemberTestRunContext, RunConfig } from '../shell.js'
import type { EventLogPort, HandoffStorePort } from '../ports.js'
import type { TestResult } from '../../result.js'
import {
  createLiveStreamHub,
  LIVE_STREAM_ACK_BOUND_MS,
  LIVE_STREAM_STOP_GRACE_MS,
} from '../live-stream-hub.js'
import type { RunTimerPort } from '../ports.js'

/**
 * A MULTI-SLOT fake timer. The `run-shell.test.ts` fake holds ONE pending callback, which is
 * enough for the post-verdict bound but not here: the hub arms an ack bound per in-flight frame AND
 * a stop grace, so a single-slot fake would silently drop whichever was armed first and the cells
 * would be measuring the fake, not the hub. Callbacks are keyed by the delay they were scheduled
 * with, so a cell fires exactly the timer it means (`fire(LIVE_STREAM_STOP_GRACE_MS)`), never "the
 * latest".
 */
interface FakeTimer extends RunTimerPort {
  fire(delayMs: number): number
  pending(delayMs: number): number
}

function makeFakeTimer(): FakeTimer {
  let nextId = 1
  const scheduled = new Map<number, { delayMs: number; fn: () => void }>()
  return {
    schedule(delayMs: number, fn: () => void) {
      const id = nextId++
      scheduled.set(id, { delayMs, fn })
      return () => {
        scheduled.delete(id)
      }
    },
    now: () => 1_700_000_000_000,
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

interface FakeCapability extends LiveStreamCapability {
  readonly calls: string[]
  readonly acked: number[]
  emit(frame: LiveFrame): void
}

function makeFakeCapability(): FakeCapability {
  const calls: string[] = []
  const acked: number[] = []
  let sink: ((frame: LiveFrame) => void) | undefined
  return {
    kind: 'cdp-screencast',
    calls,
    acked,
    async start(onFrame) {
      calls.push('start')
      sink = onFrame
    },
    async ack(frameId) {
      calls.push(`ack:${frameId}`)
      acked.push(frameId)
    },
    async stop() {
      calls.push('stop')
      sink = undefined
    },
    emit(frame) {
      sink?.(frame)
    },
  }
}

function frame(id: number): LiveFrame {
  return { id, bytes: new Uint8Array([id, 0xff, 0xd8]), metadata: { width: 320, height: 240 } }
}

/** Let the hub's internal `start()` promise settle before asserting on `calls`. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createLiveStreamHub (403 D-05/D-07)', () => {
  it('(a) never starts the producer while nobody is watching', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    await settle()
    expect(capability.calls, 'a registered-but-unwatched stream is real work nobody asked for')
      .toEqual([])
    expect(hub.capabilityOf(0)).toEqual({ kind: 'cdp-screencast' })
  })

  it('(b) starts exactly once for the first viewer and never again for later ones', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const first = hub.subscribe(0, () => {})
    await settle()
    expect(capability.calls.filter((c) => c === 'start')).toHaveLength(1)
    const second = hub.subscribe(0, () => {})
    await settle()
    expect(
      capability.calls.filter((c) => c === 'start'),
      'ONE screencast per handle — a per-viewer start is the defect this cell exists for',
    ).toHaveLength(1)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
  })

  it('(c) delivers each frame to every current subscriber with identical id and bytes', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const a: LiveFrame[] = []
    const b: LiveFrame[] = []
    hub.subscribe(0, (f) => a.push(f))
    hub.subscribe(0, (f) => b.push(f))
    await settle()
    capability.emit(frame(7))
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0].id).toBe(7)
    expect(b[0].id).toBe(7)
    expect([...a[0].bytes]).toEqual([...b[0].bytes])
  })

  it('(d) acks the producer exactly once, after every subscriber has acked', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const first = hub.subscribe(0, () => {})
    const second = hub.subscribe(0, () => {})
    await settle()
    capability.emit(frame(1))
    expect(capability.acked).toEqual([])
    first?.ack(1)
    expect(capability.acked, 'one viewer acking is not every viewer acking').toEqual([])
    second?.ack(1)
    expect(capability.acked).toEqual([1])
    first?.ack(1)
    second?.ack(1)
    expect(capability.acked, 'the producer is acked ONCE per frame').toEqual([1])
  })

  it('(e) acks after the bound when one subscriber never acks', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const first = hub.subscribe(0, () => {})
    hub.subscribe(0, () => {})
    await settle()
    capability.emit(frame(4))
    first?.ack(4)
    expect(capability.acked).toEqual([])
    expect(timer.pending(LIVE_STREAM_ACK_BOUND_MS)).toBe(1)
    timer.fire(LIVE_STREAM_ACK_BOUND_MS)
    expect(capability.acked, 'ONE wedged viewer must not freeze the stream for the others')
      .toEqual([4])
  })

  it('(f) stops only after the grace, and a re-subscribe inside it cancels the stop', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const only = hub.subscribe(0, () => {})
    await settle()
    only?.unsubscribe()
    await settle()
    expect(capability.calls, 'the last detach schedules the stop, it does not perform it')
      .not.toContain('stop')
    expect(timer.pending(LIVE_STREAM_STOP_GRACE_MS)).toBe(1)

    // A re-attach inside the grace: no stop, and no SECOND start.
    const reattached = hub.subscribe(0, () => {})
    await settle()
    expect(timer.pending(LIVE_STREAM_STOP_GRACE_MS), 'a re-subscribe CANCELS the pending stop')
      .toBe(0)
    expect(capability.calls.filter((c) => c === 'start')).toHaveLength(1)
    expect(capability.calls).not.toContain('stop')
    reattached?.unsubscribe()
  })

  it('(f2) the grace elapsing with nobody attached stops the producer', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const only = hub.subscribe(0, () => {})
    await settle()
    only?.unsubscribe()
    expect(timer.fire(LIVE_STREAM_STOP_GRACE_MS)).toBe(1)
    await settle()
    expect(capability.calls).toContain('stop')
  })

  it('(g) withdrawing the capability mid-stream stops it, declares none, and TELLS the viewers', async () => {
    // CR-03. Stopping the producer without telling the subscriber set is how a live view freezes:
    // the last frame stays painted and the surface still calls itself live. The end is delivered to
    // every current subscriber, and the assertion is ordered so an absence can never pass for a
    // presence — a frame is proved delivered BEFORE the end is asserted.
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const seen: number[] = []
    const ends: string[] = []
    hub.subscribe(0, (f) => seen.push(f.id), () => ends.push('one'))
    hub.subscribe(0, () => {}, () => ends.push('two'))
    await settle()
    expect(capability.calls).toContain('start')
    capability.emit(frame(4))
    expect(seen, 'the witness: this subscriber was genuinely receiving frames').toEqual([4])
    expect(ends, 'and had not been told anything yet').toEqual([])

    hub.register(0, undefined)
    await settle()
    expect(capability.calls, 'a finished member takes its screencast down with it').toContain('stop')
    expect(ends, 'every viewer of the finished handle is told the stream ended, by name').toEqual(['one', 'two'])
    expect(hub.capabilityOf(0)).toEqual({ kind: 'none' })
    expect(hub.subscribe(0, () => {}), 'a withdrawn handle has nothing to subscribe to')
      .toBeUndefined()

    capability.emit(frame(5))
    expect(seen, 'and no frame reaches a subscriber the hub already said goodbye to').toEqual([4])
  })

  it('(h) close() stops every started stream', async () => {
    const timer = makeFakeTimer()
    const one = makeFakeCapability()
    const two = makeFakeCapability()
    const three = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, one)
    hub.register(1, two)
    hub.register(2, three)
    hub.subscribe(0, () => {})
    hub.subscribe(1, () => {})
    await settle()
    await hub.close()
    expect(one.calls).toContain('stop')
    expect(two.calls).toContain('stop')
    expect(three.calls, 'a stream that never started has nothing to stop').not.toContain('stop')
    expect(hub.capabilityOf(0)).toEqual({ kind: 'none' })
  })

  it('an unregistered handle declares none and cannot be subscribed to', () => {
    const hub = createLiveStreamHub({ timer: makeFakeTimer() })
    expect(hub.capabilityOf(9)).toEqual({ kind: 'none' })
    expect(hub.subscribe(9, () => {})).toBeUndefined()
  })

  it('detaches a subscriber that throws, reports it on the SUBSCRIBER sink, leaves the others attached', async () => {
    // WR-06. The detach is unchanged; where it is REPORTED is the fix. `onWarning` carries facts
    // about the run's producer and the shell wires it to the run's durable event log — a channel a
    // viewer must not be able to write to by closing its tab at the wrong instant.
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const warnings: string[] = []
    const faults: string[] = []
    const hub = createLiveStreamHub({
      timer,
      onWarning: (code) => warnings.push(code),
      onSubscriberFault: (code) => faults.push(code),
    })
    hub.register(0, capability)
    const good: number[] = []
    hub.subscribe(0, () => {
      throw new Error('viewer exploded')
    })
    hub.subscribe(0, (f) => good.push(f.id))
    await settle()
    capability.emit(frame(2))
    expect(faults, 'the fault is reported, by name, on its own sink').toContain('live-stream-subscriber-detached')
    expect(warnings, 'and NOT on the channel the shell wires to the run bus').toEqual([])
    expect(good).toEqual([2])
    capability.emit(frame(3))
    expect(good, 'the throwing viewer is gone and the others carry on').toEqual([2, 3])
  })
})

// ---- 403-02 Task 1: THE N-VIEWER INVARIANT ------------------------------------------------------
//
// WHY A PROPERTY CELL AND NOT MORE EXAMPLES. Everything above is an EXAMPLE: one hand-picked order
// of attach/detach/frame/ack. D-07 and D-16 are not statements about an order — they are statements
// about ANY order ("N viewers attach and detach in any interleaving"), and a suite of hand-picked
// orders certifies exactly the orders somebody thought of. 403-01's own masking blocker was found
// only because that cell was parameterised over binder ORDER and the defect appeared in BOTH
// directions, each with a passing sibling assertion. So the interleaving is a real parameter here.
//
// THE MODEL IS THE SPEC, WRITTEN AS CODE. Every operation updates a tiny reference model — is the
// stream watched, which viewers are attached, which frames are owed by whom — and the cell asserts
// the hub's OBSERVED producer calls against it. A model this thin cannot drift into agreeing with
// the implementation by construction: it is written from D-07's sentence, and it says nothing about
// how the hub is built.

/** mulberry32 — a 32-bit PRNG in five lines. Seeded, so a failing interleaving is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Flush the microtask queue. The hub's start/stop reconciliation is a promise chain, so an
 * assertion made before it drains is an assertion about a half-applied operation. `setImmediate`
 * runs after ALL pending microtasks, which is what "the operation has landed" means here — and it
 * costs microseconds, which is what makes 200 interleavings a cell rather than a coffee break.
 */
const flush = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve) })

type HubOp =
  | { readonly kind: 'subscribe'; readonly viewer: number }
  | { readonly kind: 'unsubscribe'; readonly viewer: number }
  | { readonly kind: 'frame' }
  | { readonly kind: 'ack'; readonly viewer: number }
  | { readonly kind: 'grace' }
  | { readonly kind: 'ackBound' }

function randomOps(next: () => number, viewerCount: number, length: number): HubOp[] {
  const ops: HubOp[] = []
  for (let i = 0; i < length; i++) {
    const roll = next()
    const viewer = Math.floor(next() * viewerCount)
    if (roll < 0.28) ops.push({ kind: 'subscribe', viewer })
    else if (roll < 0.48) ops.push({ kind: 'unsubscribe', viewer })
    else if (roll < 0.72) ops.push({ kind: 'frame' })
    else if (roll < 0.88) ops.push({ kind: 'ack', viewer })
    else if (roll < 0.95) ops.push({ kind: 'grace' })
    else ops.push({ kind: 'ackBound' })
  }
  return ops
}

describe('the N-viewer invariant (403-02 · D-07/D-16 · LIVE-01)', () => {
  it('(i) 200 seeded interleavings over up to 6 viewers: one start and one stop per watched interval', async () => {
    // COVERAGE COUNTERS, asserted at the bottom. 200 green iterations prove nothing if every one of
    // them was a single viewer attaching once: a property cell whose generator never reaches the
    // interesting shapes is green at rest. These count the shapes the claim is ABOUT.
    let iterationsWithConcurrentViewers = 0
    let iterationsWithTwoIntervals = 0
    let framesSharedByTwoOrMore = 0

    for (let seed = 1; seed <= 200; seed++) {
      const next = mulberry32(seed)
      const viewerCount = 1 + Math.floor(next() * 6)
      const ops = randomOps(next, viewerCount, 14)

      const timer = makeFakeTimer()
      const capability = makeFakeCapability()
      const hub = createLiveStreamHub({ timer })
      hub.register(0, capability)

      // --- the reference model, written from D-07's sentence ---
      const attached = new Map<number, ReturnType<typeof hub.subscribe>>()
      const seenBy = new Map<number, number[]>()
      /** What the MODEL says each viewer must have seen — the frames emitted while it watched. */
      const expectedSeenBy = new Map<number, number[]>()
      /** frameId -> the viewers that still owe an ack. */
      const inFlight = new Map<number, Set<number>>()
      const expectedAcked: number[] = []
      let watched = false
      let expectedStarts = 0
      let expectedStops = 0
      let nextFrameId = 1
      let peakConcurrent = 0

      /** The grace elapsing with nobody attached ENDS the watched interval (D-07). */
      const endInterval = (): void => {
        watched = false
        expectedStops += 1
        // A stop drops every frame still in flight WITHOUT acking it — there is no producer left
        // to ack to. (The hub clears its ack bounds on the same reasoning.)
        inFlight.clear()
      }

      for (const op of ops) {
        if (op.kind === 'subscribe') {
          if (!attached.has(op.viewer)) {
            const viewer = op.viewer
            const subscription = hub.subscribe(0, (received) => {
              const log = seenBy.get(viewer) ?? []
              log.push(received.id)
              seenBy.set(viewer, log)
            })
            expect(subscription, `seed ${String(seed)}: a registered handle must be subscribable`)
              .toBeDefined()
            attached.set(viewer, subscription)
            peakConcurrent = Math.max(peakConcurrent, attached.size)
            if (!watched) { watched = true; expectedStarts += 1 }
          }
        } else if (op.kind === 'unsubscribe') {
          const subscription = attached.get(op.viewer)
          if (subscription !== undefined) {
            attached.delete(op.viewer)
            subscription.unsubscribe()
            // A detach counts as an ack for everything this viewer still owed.
            for (const [frameId, owing] of [...inFlight]) {
              if (!owing.delete(op.viewer)) continue
              if (owing.size === 0) { expectedAcked.push(frameId); inFlight.delete(frameId) }
            }
          }
        } else if (op.kind === 'frame') {
          const frameId = nextFrameId++
          capability.emit(frame(frameId))
          if (watched) {
            // EVERY viewer attached AT EMIT TIME sees this frame, and they all see the same id.
            const receivers = [...attached.keys()]
            for (const viewer of receivers) {
              const log = expectedSeenBy.get(viewer) ?? []
              log.push(frameId)
              expectedSeenBy.set(viewer, log)
            }
            if (receivers.length >= 2) framesSharedByTwoOrMore += 1
            if (receivers.length === 0) expectedAcked.push(frameId)
            else inFlight.set(frameId, new Set(receivers))
          }
        } else if (op.kind === 'ack') {
          const subscription = attached.get(op.viewer)
          if (subscription !== undefined) {
            const owed = [...inFlight.entries()].find(([, owing]) => owing.has(op.viewer))
            if (owed !== undefined) {
              const [frameId, owing] = owed
              subscription.ack(frameId)
              owing.delete(op.viewer)
              if (owing.size === 0) { expectedAcked.push(frameId); inFlight.delete(frameId) }
            }
          }
        } else if (op.kind === 'grace') {
          const fired = timer.fire(LIVE_STREAM_STOP_GRACE_MS)
          if (fired > 0 && attached.size === 0 && watched) endInterval()
        } else {
          const fired = timer.fire(LIVE_STREAM_ACK_BOUND_MS)
          if (fired > 0) {
            for (const [frameId] of [...inFlight]) expectedAcked.push(frameId)
            inFlight.clear()
          }
        }
        await flush()
      }

      // Settle: everyone leaves, the ack bound and the grace both elapse.
      for (const [viewer, subscription] of [...attached]) {
        attached.delete(viewer)
        subscription?.unsubscribe()
        for (const [frameId, owing] of [...inFlight]) {
          if (!owing.delete(viewer)) continue
          if (owing.size === 0) { expectedAcked.push(frameId); inFlight.delete(frameId) }
        }
      }
      await flush()
      if (timer.fire(LIVE_STREAM_ACK_BOUND_MS) > 0) {
        for (const [frameId] of [...inFlight]) expectedAcked.push(frameId)
        inFlight.clear()
      }
      await flush()
      if (timer.fire(LIVE_STREAM_STOP_GRACE_MS) > 0 && watched) endInterval()
      await flush()

      if (peakConcurrent >= 2) iterationsWithConcurrentViewers += 1
      if (expectedStarts >= 2) iterationsWithTwoIntervals += 1

      const label = `seed ${String(seed)} · viewers ${String(viewerCount)} · ${ops.map((o) => o.kind).join(',')}`
      expect(
        capability.calls.filter((call) => call === 'start').length,
        `${label}: ONE Page.startScreencast per watched interval — a per-viewer start is the defect`,
      ).toBe(expectedStarts)
      expect(
        capability.calls.filter((call) => call === 'stop').length,
        `${label}: ONE stop per watched interval, after the grace`,
      ).toBe(expectedStops)
      expect(capability.acked, `${label}: the producer is acked exactly once per delivered frame`)
        .toEqual(expectedAcked)
      // THE FAN-OUT: every viewer that was attached for a frame saw it, with the same id, in the
      // same order — "one stream, N viewers" in its observable form. A per-viewer screencast would
      // give each of them an independent id sequence and satisfy every count above.
      const viewers = [...new Set([...seenBy.keys(), ...expectedSeenBy.keys()])].sort()
      for (const viewer of viewers) {
        expect(
          seenBy.get(viewer) ?? [],
          `${label}: viewer ${String(viewer)} did not observe the stream's own frame sequence`,
        ).toEqual(expectedSeenBy.get(viewer) ?? [])
      }
    }

    // THE ANTI-VACUITY GUARD. If the generator stopped producing concurrent viewers, re-attachments
    // or shared frames, the 200 iterations above would still be green while measuring nothing that
    // D-07 is about.
    expect(iterationsWithConcurrentViewers, 'the generator never put two viewers on one handle')
      .toBeGreaterThan(20)
    expect(iterationsWithTwoIntervals, 'the generator never closed and re-opened a watched interval')
      .toBeGreaterThan(5)
    expect(framesSharedByTwoOrMore, 'no frame was ever fanned out to two viewers at once')
      .toBeGreaterThan(20)
  }, 60_000)


  it('(j) two handles: two starts, two stops, and frames never cross handles', async () => {
    const timer = makeFakeTimer()
    const zero = makeFakeCapability()
    const one = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, zero)
    hub.register(1, one)
    const seenZero: number[] = []
    const seenOne: number[] = []
    const a = hub.subscribe(0, (f) => seenZero.push(f.id))
    const b = hub.subscribe(0, (f) => seenZero.push(f.id))
    const c = hub.subscribe(1, (f) => seenOne.push(f.id))
    await flush()
    expect(zero.calls.filter((call) => call === 'start')).toHaveLength(1)
    expect(one.calls.filter((call) => call === 'start')).toHaveLength(1)

    zero.emit(frame(11))
    one.emit(frame(22))
    expect(seenZero, 'handle 0 sees handle 0 frames, twice — once per viewer').toEqual([11, 11])
    expect(seenOne, 'a handle-1 viewer must never see a handle-0 frame').toEqual([22])

    a?.unsubscribe(); b?.unsubscribe(); c?.unsubscribe()
    await flush()
    expect(timer.fire(LIVE_STREAM_STOP_GRACE_MS)).toBe(2)
    await flush()
    expect(zero.calls.filter((call) => call === 'stop')).toHaveLength(1)
    expect(one.calls.filter((call) => call === 'stop')).toHaveLength(1)
  })

  it('(k) a stop that lands while the START is still in flight leaves the hub honest', async () => {
    // THE RACE THE INVARIANT FOUND. `subscribe` kicks the producer off and returns before the
    // adapter's `start()` promise settles; a detach plus an elapsed grace inside that window asks
    // for a stop while the start is mid-air. If the two are not serialised, the start's own
    // continuation flips the hub's "running" bit back on AFTER the stop landed — and every viewer
    // that attaches later gets a hub that believes a stopped screencast is running, i.e. a live
    // view that is permanently blank with nothing anywhere reporting an error.
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)

    const first = hub.subscribe(0, () => {})
    first?.unsubscribe()
    expect(timer.fire(LIVE_STREAM_STOP_GRACE_MS)).toBe(1)
    await flush()
    // An interval that opens and closes before the producer was ever asked is ELIDED — the
    // reconciler sees `desired === running === false` and makes no call at all. That is D-07 in its
    // strongest form (a screencast nobody watched is never started), and the one thing it must
    // never be is HALF applied: a start with no stop leaves a screencast running for nobody.
    expect(
      capability.calls.filter((call) => call === 'start').length,
      'at most one start for an interval that closed before the producer was asked',
    ).toBeLessThanOrEqual(1)
    expect(
      capability.calls.filter((call) => call === 'stop').length,
      'a start that happened must have been stopped — never a screencast left running for nobody',
    ).toBe(capability.calls.filter((call) => call === 'start').length)

    const seen: number[] = []
    const second = hub.subscribe(0, (f) => seen.push(f.id))
    await flush()
    expect(
      capability.calls.filter((call) => call === 'start').length,
      'the NEXT viewer opens a new watched interval — a hub that thinks the stopped producer is '
      + 'still running never restarts it and serves a blank preview forever',
    ).toBeGreaterThanOrEqual(1)
    expect(
      capability.calls[capability.calls.length - 1],
      'and the producer is left RUNNING for that viewer, not stopped',
    ).toBe('start')
    capability.emit(frame(5))
    expect(seen, 'and that viewer actually receives frames').toEqual([5])
    second?.unsubscribe()
  })

  it('(l) when the LAST viewer is detached by throwing, the producer does not keep running for nobody', async () => {
    // D-07's zero-cost claim has a back door: a viewer removed by `deliver`'s throw path never
    // calls `unsubscribe`, so nothing schedules the stop. An unwatched screencast is exactly the
    // work D-07 exists to refuse.
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const warnings: string[] = []
    const faults: string[] = []
    const hub = createLiveStreamHub({
      timer,
      onWarning: (code) => warnings.push(code),
      onSubscriberFault: (code) => faults.push(code),
    })
    hub.register(0, capability)
    hub.subscribe(0, () => { throw new Error('the only viewer exploded') })
    await flush()
    capability.emit(frame(1))
    expect(faults, 'the witness: the throw path really was taken').toContain('live-stream-subscriber-detached')
    expect(warnings, 'off the run channel (WR-06)').toEqual([])
    expect(
      timer.pending(LIVE_STREAM_STOP_GRACE_MS),
      'the throw path emptied the subscriber set, so the stop must be scheduled like any other '
      + 'last detach — otherwise the browser encodes JPEGs for nobody until the run ends',
    ).toBe(1)
    expect(timer.fire(LIVE_STREAM_STOP_GRACE_MS)).toBe(1)
    await flush()
    expect(capability.calls).toContain('stop')
  })

  it('(m) a throwing viewer counts as ACKED for the frame it threw on', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    hub.subscribe(0, () => { throw new Error('viewer exploded') })
    const good = hub.subscribe(0, () => {})
    await flush()
    capability.emit(frame(9))
    expect(capability.acked, 'the survivor has not acked yet').toEqual([])
    good?.ack(9)
    expect(
      capability.acked,
      'a detached viewer cannot ack, so it must not be counted as owing one — otherwise the '
      + 'producer waits out the whole ack bound on every frame',
    ).toEqual([9])
    expect(timer.pending(LIVE_STREAM_ACK_BOUND_MS), 'and the bound timer is cancelled, not left armed')
      .toBe(0)
  })

  it('(n) the ack bound is cancelled the moment the last viewer acks — never a second ack', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const a = hub.subscribe(0, () => {})
    const b = hub.subscribe(0, () => {})
    const c = hub.subscribe(0, () => {})
    await flush()
    capability.emit(frame(3))
    expect(timer.pending(LIVE_STREAM_ACK_BOUND_MS)).toBe(1)
    a?.ack(3); b?.ack(3)
    expect(capability.acked).toEqual([])
    c?.ack(3)
    expect(capability.acked, 'the third ack completes the quorum immediately').toEqual([3])
    expect(timer.pending(LIVE_STREAM_ACK_BOUND_MS), 'the bound timer is cancelled by the quorum')
      .toBe(0)
    expect(timer.fire(LIVE_STREAM_ACK_BOUND_MS)).toBe(0)
    expect(capability.acked, 'and no second ack can arrive from a timer nobody cancelled')
      .toEqual([3])
  })

  it('(o) close() while a grace timer is pending stops once, clears it, and refuses later subscribers', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const only = hub.subscribe(0, () => {})
    await flush()
    only?.unsubscribe()
    expect(timer.pending(LIVE_STREAM_STOP_GRACE_MS)).toBe(1)
    await hub.close()
    expect(capability.calls.filter((call) => call === 'stop'), 'exactly one stop, not two')
      .toHaveLength(1)
    expect(
      timer.pending(LIVE_STREAM_STOP_GRACE_MS),
      'a grace timer left armed past close() is a callback holding a closed hub',
    ).toBe(0)
    expect(hub.subscribe(0, () => {}), 'a closed hub hands out no subscriptions').toBeUndefined()
    expect(timer.fire(LIVE_STREAM_STOP_GRACE_MS)).toBe(0)
    expect(capability.calls.filter((call) => call === 'stop')).toHaveLength(1)
  })

  it('(p) register() twice for one handle replaces the capability and stops the started one', async () => {
    const timer = makeFakeTimer()
    const first = makeFakeCapability()
    const second = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, first)
    const seen: number[] = []
    const ends: string[] = []
    hub.subscribe(0, (f) => seen.push(f.id), () => ends.push('end'))
    await flush()
    expect(first.calls).toContain('start')
    first.emit(frame(1))
    expect(seen, 'the witness: the first stream really was delivering to this viewer').toEqual([1])

    hub.register(0, second)
    await flush()
    expect(first.calls, 'the replaced capability is stopped — a re-registered handle leaves no '
      + 'orphan screencast running in the browser').toContain('stop')
    expect(ends, 'and the viewers of the REPLACED stream are told it ended (CR-03) — a re-register '
      + 'drops their subscription just as surely as a withdraw does').toEqual(['end'])
    expect(second.calls, 'and the replacement is not started until somebody watches it').toEqual([])
    expect(hub.capabilityOf(0)).toEqual({ kind: 'cdp-screencast' })

    const viewer = hub.subscribe(0, () => {})
    await flush()
    expect(second.calls.filter((call) => call === 'start')).toHaveLength(1)
    viewer?.unsubscribe()
  })

  it('(r) a viewer that acks FROM INSIDE its own frame callback acks the producer immediately', async () => {
    // THE FASTEST POSSIBLE CONSUMER, and the one the hub was silently punishing. Acking from the
    // delivery callback is the natural in-process pattern — it is what the LIVE-03 bus-silence
    // cell does and what any consumer that does not need to decode first would do. The hub used to
    // record a frame's ack ledger AFTER walking its subscribers, so an ack raised during that walk
    // found no ledger and was dropped: every frame then waited out the FULL ack bound before the
    // producer was told, capping a live view at 1000/LIVE_STREAM_ACK_BOUND_MS frames per second no
    // matter how fast the browser or the viewer was. Invisible to every cell whose viewer acks
    // later, which is why 403-01's eight cells and the tracer's browser page all missed it.
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const seen: number[] = []
    const subscription = hub.subscribe(0, (received) => {
      seen.push(received.id)
      subscription?.ack(received.id)
    })
    await flush()
    capability.emit(frame(1))
    capability.emit(frame(2))
    expect(seen, 'the frames were delivered').toEqual([1, 2])
    expect(
      capability.acked,
      'the producer is acked as the frames are consumed — not `LIVE_STREAM_ACK_BOUND_MS` later by '
      + 'a timer that exists for WEDGED viewers, which is what a dropped in-callback ack degrades to',
    ).toEqual([1, 2])
    expect(
      timer.pending(LIVE_STREAM_ACK_BOUND_MS),
      'and no bound timer is left armed for a frame that is already settled',
    ).toBe(0)
  })

  it('(s) a burst delivered synchronously inside start() is acked frame for frame', async () => {
    // The shape a fake producer takes and the shape a real one can take on a fast page: every frame
    // of the burst arrives before the hub's own `start()` promise has settled.
    const timer = makeFakeTimer()
    const acked: number[] = []
    const burst: LiveStreamCapability = {
      kind: 'cdp-screencast',
      start: async (onFrame) => {
        for (let id = 1; id <= 50; id++) {
          onFrame({ id, bytes: new Uint8Array([0xff, 0xd8, id]), metadata: { width: 8, height: 8 } })
        }
      },
      ack: async (frameId) => { acked.push(frameId) },
      stop: async () => {},
    }
    const hub = createLiveStreamHub({ timer })
    hub.register(0, burst)
    const seen: number[] = []
    const subscription = hub.subscribe(0, (received) => {
      seen.push(received.id)
      subscription?.ack(received.id)
    })
    await flush()
    expect(seen).toHaveLength(50)
    expect(acked, 'all fifty acked, in order, with no timer involved').toEqual(seen)
    expect(timer.pending(LIVE_STREAM_ACK_BOUND_MS)).toBe(0)
  })

  it('(q) registering the SAME capability object again is a no-op, not a restart', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    hub.subscribe(0, () => {})
    await flush()
    hub.register(0, capability)
    await flush()
    expect(capability.calls.filter((call) => call === 'start')).toHaveLength(1)
    expect(capability.calls, 'an idempotent re-register must not tear a live stream down')
      .not.toContain('stop')
  })
})

// ---- 428-01: CAPTURE TIME AND KIND ON THE FRAME (D-15, PXH-LIVE-03) -----------------------------
//
// A frame's time is its CAPTURE time in integer epoch milliseconds. The producer stamps it; the hub
// fills it from its own clock only when the producer did not, and never overwrites one it was given.

describe('the hub stamps capture time and producer kind on a copy (428-01 · D-15)', () => {
  it('(t) TS-STAMPED-WHEN-ABSENT: an unstamped frame reaches the subscriber at timer.now(), the producer object untouched', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const seen: LiveFrame[] = []
    hub.subscribe(0, (f) => seen.push(f))
    await settle()
    const produced = frame(3)
    capability.emit(produced)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.metadata.timestamp, 'the hub clock, in epoch ms').toBe(timer.now())
    expect(seen[0]?.id, 'the ack ledger keys on the unchanged id').toBe(3)
    expect(produced.metadata.timestamp, 'the producer\'s frame is never mutated').toBeUndefined()
    expect(produced.kind).toBeUndefined()
  })

  it('(u) TS-KEPT-WHEN-PRESENT: a producer-supplied capture time is never overwritten', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const seen: LiveFrame[] = []
    hub.subscribe(0, (f) => seen.push(f))
    await settle()
    capability.emit({ ...frame(5), metadata: { width: 320, height: 240, timestamp: 42 } })
    expect(seen[0]?.metadata.timestamp).toBe(42)
  })

  it('(v) KIND-STAMPED-FROM-CAPABILITY: an unkinded frame takes the capability\'s kind; a kinded one keeps its own', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const seen: LiveFrame[] = []
    const subscription = hub.subscribe(0, (f) => seen.push(f))
    await settle()
    capability.emit(frame(6))
    capability.emit({ ...frame(7), kind: 'mjpeg' })
    expect(seen.map((f) => f.kind)).toEqual(['cdp-screencast', 'mjpeg'])
    subscription?.ack(6)
    subscription?.ack(7)
    expect(capability.acked, 'the stamped copy is acked by the producer\'s own id').toEqual([6, 7])
  })
})

// ---- 428-04: EVERY END SAYS WHY, AND close() EVICTS LIKE THE OTHER TWO SITES (D-14, #277) -------
//
// `withdrawn`: this member finished or was replaced, and its subject goes on. `closed`: the whole
// subject is over. A consumer that cannot tell the two apart either ends a whole view when one
// member finishes, or holds a frozen frame when the run ends.

describe('every end names its reason and close() evicts (428-04 · D-14 · #277)', () => {
  it('CLOSE-EVICTS-AND-TELLS: close() ends every subscriber once with closed, stops once, refuses later subscribers', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const ends: string[] = []
    hub.subscribe(0, () => {}, (reason) => ends.push(`one:${reason}`))
    hub.subscribe(0, () => {}, (reason) => ends.push(`two:${reason}`))
    await flush()
    expect(capability.calls, 'the witness: the stream really was running').toContain('start')

    await hub.close()
    expect(ends, 'each viewer is told, once, that the whole subject is over').toEqual([
      'one:closed',
      'two:closed',
    ])
    expect(capability.calls.filter((call) => call === 'stop')).toHaveLength(1)
    expect(hub.subscribe(0, () => {}), 'an evicted handle hands out nothing').toBeUndefined()
  })

  it('RELEASE-AFTER-CLOSE-ARMS-NOTHING: a subscription released after close() arms no grace timer', async () => {
    const timer = makeFakeTimer()
    const capability = makeFakeCapability()
    const hub = createLiveStreamHub({ timer })
    hub.register(0, capability)
    const held = hub.subscribe(0, () => {})
    await flush()
    await hub.close()
    held?.unsubscribe()
    expect(
      timer.pending(LIVE_STREAM_STOP_GRACE_MS),
      'a grace armed on an evicted state is a callback holding a closed hub (#277)',
    ).toBe(0)
    expect(capability.calls.filter((call) => call === 'stop')).toHaveLength(1)
  })

  it('WITHDRAW-SAYS-WITHDRAWN: a withdrawal and a replacement both end their subscribers with withdrawn', async () => {
    const timer = makeFakeTimer()
    const hub = createLiveStreamHub({ timer })
    const ends: string[] = []

    hub.register(0, makeFakeCapability())
    hub.subscribe(0, () => {}, (reason) => ends.push(`withdraw:${reason}`))
    hub.register(1, makeFakeCapability())
    hub.subscribe(1, () => {}, (reason) => ends.push(`replace:${reason}`))
    await flush()

    hub.register(0, undefined)
    hub.register(1, makeFakeCapability())
    await flush()
    expect(ends).toEqual(['withdraw:withdrawn', 'replace:withdrawn'])
  })
})

// ---- 428-04: A FAILED START HANDS OVER TO THE SNAPSHOT FALLBACK (D-12) ---------------------------
//
// Only the hub can both record the failure on the run's durable log AND switch producers, so the
// fallback seat lives here. The failure is still written before the switch: a fallback that hid the
// primary's failure would make a degraded preview indistinguishable from a healthy one.

/** A primary whose `start` rejects `failures` times, then behaves like the plain fake. */
function makeRejectingCapability(failures = Number.POSITIVE_INFINITY): FakeCapability {
  const base = makeFakeCapability()
  let remaining = failures
  return {
    ...base,
    async start(onFrame) {
      if (remaining > 0) {
        remaining -= 1
        base.calls.push('start')
        throw new Error('screencast refused')
      }
      await base.start(onFrame)
    },
  }
}

function makeSnapshotCapability(): FakeCapability {
  return { ...makeFakeCapability(), kind: 'snapshot' }
}

describe('a failed primary start hands over to its snapshot fallback (428-04 · D-12)', () => {
  it('START-FAILURE-FALLS-BACK: the failure is recorded, the fallback starts, and its frames arrive labelled snapshot', async () => {
    const timer = makeFakeTimer()
    const warnings: string[] = []
    const hub = createLiveStreamHub({ timer, onWarning: (code) => warnings.push(code) })
    const primary = makeRejectingCapability()
    const fallback = makeSnapshotCapability()
    hub.register(0, primary, fallback)
    const seen: LiveFrame[] = []
    hub.subscribe(0, (f) => seen.push(f))
    await flush()

    expect(warnings, 'the primary\'s failure is still on the run\'s record').toEqual([
      'live-stream-start-failed',
    ])
    expect(primary.calls).toEqual(['start'])
    expect(fallback.calls, 'and the fallback took over').toEqual(['start'])
    fallback.emit(frame(8))
    expect(seen.map((f) => [f.id, f.kind])).toEqual([[8, 'snapshot']])
  })

  it('FALLBACK-ACK-ROUTES-TO-ACTIVE: acks and the graced stop reach the fallback, never the primary', async () => {
    const timer = makeFakeTimer()
    const hub = createLiveStreamHub({ timer })
    const primary = makeRejectingCapability()
    const fallback = makeSnapshotCapability()
    hub.register(0, primary, fallback)
    const subscription = hub.subscribe(0, () => {})
    await flush()
    fallback.emit(frame(8))
    subscription?.ack(8)
    expect(fallback.acked).toEqual([8])
    expect(primary.acked).toEqual([])

    subscription?.unsubscribe()
    expect(timer.fire(LIVE_STREAM_STOP_GRACE_MS)).toBe(1)
    await flush()
    expect(fallback.calls, 'the fallback only runs while someone watches').toContain('stop')
    expect(primary.calls).not.toContain('stop')
  })

  it('CAPABILITY-OF-DECLARED-UNDER-FALLBACK: capabilityOf keeps answering the declared kind while the fallback runs', async () => {
    const timer = makeFakeTimer()
    const hub = createLiveStreamHub({ timer })
    const primary = makeRejectingCapability()
    const fallback = makeSnapshotCapability()
    hub.register(0, primary, fallback)
    hub.subscribe(0, () => {})
    await flush()
    expect(fallback.calls, 'the witness: the fallback is the running producer').toEqual(['start'])
    expect(hub.capabilityOf(0), 'the ready message\'s painter decision does not move').toEqual({
      kind: 'cdp-screencast',
    })
  })

  it('a later watched interval tries the primary first again', async () => {
    const timer = makeFakeTimer()
    const hub = createLiveStreamHub({ timer })
    const primary = makeRejectingCapability(1)
    const fallback = makeSnapshotCapability()
    hub.register(0, primary, fallback)
    const first = hub.subscribe(0, () => {})
    await flush()
    expect(fallback.calls).toEqual(['start'])
    first?.unsubscribe()
    expect(timer.fire(LIVE_STREAM_STOP_GRACE_MS)).toBe(1)
    await flush()

    const seen: LiveFrame[] = []
    hub.subscribe(0, (f) => seen.push(f))
    await flush()
    expect(primary.calls.filter((call) => call === 'start')).toHaveLength(2)
    expect(fallback.calls.filter((call) => call === 'start'), 'the recovered primary needs no fallback')
      .toHaveLength(1)
    primary.emit(frame(9))
    expect(seen.map((f) => [f.id, f.kind])).toEqual([[9, 'cdp-screencast']])
  })

  it('a fallback that also fails to start is recorded a second time, naming the fallback, and delivers nothing', async () => {
    const timer = makeFakeTimer()
    const warnings: [string, string][] = []
    const hub = createLiveStreamHub({ timer, onWarning: (code, message) => warnings.push([code, message]) })
    const primary = makeRejectingCapability()
    const fallback: FakeCapability = { ...makeRejectingCapability(), kind: 'snapshot' }
    hub.register(0, primary, fallback)
    hub.subscribe(0, () => {})
    await flush()
    expect(warnings.map(([code]) => code)).toEqual([
      'live-stream-start-failed',
      'live-stream-start-failed',
    ])
    expect(warnings[1]?.[1]).toContain('fallback')
    expect(fallback.calls).toEqual(['start'])
  })

  it('NO-FALLBACK-STAYS-DOWN: without a fallback a rejecting start records the warning and delivers nothing', async () => {
    const timer = makeFakeTimer()
    const warnings: string[] = []
    const hub = createLiveStreamHub({ timer, onWarning: (code) => warnings.push(code) })
    const primary = makeRejectingCapability()
    hub.register(0, primary)
    const seen: LiveFrame[] = []
    hub.subscribe(0, (f) => seen.push(f))
    await flush()
    expect(warnings).toEqual(['live-stream-start-failed'])
    expect(primary.calls).toEqual(['start'])
    primary.emit(frame(1))
    expect(seen).toEqual([])
  })
})

// ---- THE SEAM, THROUGH THE REAL RUN --------------------------------------------------------
//
// The hub cells above drive the hub directly and the frame-proxy cells drive a PLANTED
// `RunSession`. Between the two sits `shell.ts`, which builds the real session and forwards
// `subscribeFrames`'s arguments to the hub — and nothing else in either suite reads it. A dropped
// third argument there would leave both suites green while no viewer of a real run was ever told
// its member finished: the shape WINDOWS calls "green that never ran". So this cell drives
// `startRun` end to end.

describe('shell.ts threads the end-of-stream notification onto the real RunSession seam (CR-03)', () => {
  it('a member settling delivers onEnd to that handle\'s frame subscribers, run still going', async () => {
    let push: ((frame: LiveFrame) => void) | undefined
    const capability: LiveStreamCapability = {
      kind: 'cdp-screencast',
      async start(onFrame) { push = onFrame },
      async ack() { /* the ack path is cell (d)'s subject */ },
      async stop() { push = undefined },
    }
    let markRegistered: () => void = () => {}
    const registered = new Promise<void>((resolve) => { markRegistered = resolve })
    let settleMemberA: () => void = () => {}
    const memberAHeld = new Promise<void>((resolve) => { settleMemberA = resolve })
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })

    const log: RunEventEnvelope[] = []
    const config: RunConfig = {
      runId: 'run-cr-03-seam' as RunConfig['runId'],
      scope: { tier: 'suite', key: 'live-view' },
      executionContext: 'local-headless',
      buildOrdinal: 1,
      configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
      members: [
        { testId: 'a', name: 'the watched member', filePath: 'a.test.ts' },
        { testId: 'b', name: 'the member that keeps the run alive', filePath: 'b.test.ts' },
      ],
      executor: async (member, ctx: MemberTestRunContext): Promise<TestResult> => {
        if (ctx.testIndex === 0) {
          ctx.registerLiveStream?.(capability)
          markRegistered()
          // Held so the cell can watch a LIVE member: the withdrawal below must be the thing the
          // subscriber is told about, not a member that had already settled before it attached.
          await memberAHeld
        } else {
          // The SECOND member keeps the run going, which is what makes this CR-03 and not the
          // already-covered `runFinished` path: the handle ends while the RUN does not.
          await held
        }
        return { name: member.name, filePath: member.filePath, status: 'passed', steps: [], duration: 1 }
      },
      ports: {
        handoffStore: { async save(_handoff: CompletedRunHandoff) { /* not this cell's subject */ } } as HandoffStorePort,
        eventLog: { append(envelope) { log.push(envelope) }, read(fromSeq) { return log.filter((e) => e.seq >= fromSeq) } } as EventLogPort,
      },
    }

    const session = startRun(config)
    await registered
    const seen: number[] = []
    let ends = 0
    const subscription = session.subscribeFrames(0, (f) => { seen.push(f.id) }, () => { ends += 1 })
    expect(subscription, 'the live handle is subscribable').toBeDefined()
    for (let tick = 0; tick < 20 && push === undefined; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    // THE WITNESS FIRST. A frame really crossed the seam to this subscriber, and it had been told
    // nothing — so the absence asserted next is an absence and not a stream that never started.
    push?.({ id: 1, bytes: new Uint8Array([0xff, 0xd8, 0xff]), metadata: { width: 320, height: 240 } })
    subscription?.ack(1)
    expect(seen, 'the witness: a real run delivered a real frame to this subscriber').toEqual([1])
    expect(ends, 'and nothing had been declared over yet').toBe(0)

    // Member 0 settles. `shell.ts` withdraws its declaration at the one convergence site.
    settleMemberA()
    for (let tick = 0; tick < 50 && ends === 0; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(ends, 'a settled member tells its viewers, through the real session seam').toBe(1)
    expect(session.streamCapabilityOf(0), 'and reads `none` from then on').toEqual({ kind: 'none' })

    release()
    await session.done
  })
})

describe('shell.ts forwards a SUBSCRIBER fault to the host port, off the run bus (403-13 · WR-06)', () => {
  it('a subscriber that throws is reported on ports.onSubscriberFault, detached, and the runWarning count is unchanged', async () => {
    let push: ((frame: LiveFrame) => void) | undefined
    const capability: LiveStreamCapability = {
      kind: 'cdp-screencast',
      async start(onFrame) { push = onFrame },
      async ack() { /* not this cell's subject */ },
      async stop() { push = undefined },
    }
    let markRegistered: () => void = () => {}
    const registered = new Promise<void>((resolve) => { markRegistered = resolve })
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })

    const log: RunEventEnvelope[] = []
    const faults: [string, string][] = []
    const config: RunConfig = {
      runId: 'run-403-13-subscriber-fault' as RunConfig['runId'],
      scope: { tier: 'suite', key: 'live-view' },
      executionContext: 'local-headless',
      buildOrdinal: 1,
      configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
      members: [{ testId: 'a', name: 'the watched member', filePath: 'a.test.ts' }],
      executor: async (member, ctx: MemberTestRunContext): Promise<TestResult> => {
        ctx.registerLiveStream?.(capability)
        markRegistered()
        await held
        return { name: member.name, filePath: member.filePath, status: 'passed', steps: [], duration: 1 }
      },
      ports: {
        handoffStore: { async save(_handoff: CompletedRunHandoff) { /* not this cell's subject */ } } as HandoffStorePort,
        eventLog: { append(envelope) { log.push(envelope) }, read(fromSeq) { return log.filter((e) => e.seq >= fromSeq) } } as EventLogPort,
        onSubscriberFault: (code, message) => { faults.push([code, message]) },
      },
    }

    const session = startRun(config)
    await registered
    let throwerCalls = 0
    const thrower = session.subscribeFrames(0, () => {
      throwerCalls += 1
      throw new Error('viewer exploded inside onFrame')
    })
    const good: number[] = []
    const witness = session.subscribeFrames(0, (f) => { good.push(f.id) })
    expect(thrower, 'the live handle is subscribable').toBeDefined()
    expect(witness).toBeDefined()
    for (let tick = 0; tick < 20 && push === undefined; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    const runWarningsBefore = log.filter((e) => e.type === 'runWarning').length
    push?.({ id: 1, bytes: new Uint8Array([0xff, 0xd8, 0xff]), metadata: { width: 320, height: 240 } })
    witness?.ack(1)
    expect(good, 'the witness: a real run delivered the faulting frame').toEqual([1])
    expect(throwerCalls, 'the thrower really was invoked once').toBe(1)

    // (a) the fault reached the HOST port, by name, with the hub's own message.
    expect(faults, 'the fault reaches ports.onSubscriberFault').toEqual([
      ['live-stream-subscriber-detached', 'live-frame subscriber threw during delivery and was detached'],
    ])
    // (b) two-sided: the durable log gained ZERO runWarning envelopes from the faulting delivery.
    const runWarningsAfter = log.filter((e) => e.type === 'runWarning').length
    expect(runWarningsAfter, `runWarning count before=${runWarningsBefore} after=${runWarningsAfter}`).toBe(runWarningsBefore)

    // The detach behaviour 403-09 verified is unchanged: the thrower is gone, the witness carries on.
    push?.({ id: 2, bytes: new Uint8Array([0xff, 0xd8, 0xff]), metadata: { width: 320, height: 240 } })
    witness?.ack(2)
    expect(throwerCalls, 'the throwing subscriber was detached and is not called again').toBe(1)
    expect(good).toEqual([1, 2])

    release()
    await session.done
  })
})
