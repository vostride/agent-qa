// CDP waits for each ack, so after `ackBoundMs` the hub acks for a stuck viewer.

import type {
  LiveFrame,
  LiveFrameEndReason,
  LiveFrameSubscription,
  LiveStreamDeclaration,
} from '@vostride/agent-qa-schema'
import type { LiveStreamCapability } from '../platform.js'
import type { RunTimerPort } from './ports.js'

/** How long a handle's stream keeps running after its LAST viewer detaches. */
export const LIVE_STREAM_STOP_GRACE_MS = 2_000
/** How long the hub waits for every subscriber to ack a frame before acking on their behalf. */
export const LIVE_STREAM_ACK_BOUND_MS = 250

// Unref'd, so a pending grace never holds the process open; shared with the snapshot producer.
export function defaultLiveStreamTimer(): RunTimerPort {
  return {
    schedule(delayMs: number, fn: () => void): () => void {
      const handle = setTimeout(fn, delayMs) as unknown as { unref?: () => void }
      handle.unref?.()
      return () => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
    },
    now: () => Date.now(),
  }
}

export interface CreateLiveStreamHubOptions {
  timer?: RunTimerPort
  graceMs?: number
  ackBoundMs?: number
  /**
   * Facts about the RUN's producer. The shell wires this to the run's durable event log, so what
   * lands here is replayed to every later reader of the run.
   */
  onWarning?: (code: string, message: string) => void
  // A viewer's fault goes here, apart from `onWarning`, so the run record never depends on viewers.
  onSubscriberFault?: (code: string, message: string) => void
}

/**
 * The run's frame fan-out. `register` is the PRODUCER side (the member executor hands its adapter's
 * capability in, and hands `undefined` in when the member finishes); `subscribe`/`capabilityOf` are
 * the CONSUMER side the `RunSession` exposes.
 */
export interface LiveStreamHub {
  // `fallback` starts when `capability` fails to start; the failure is still recorded.
  register(
    handle: number,
    capability: LiveStreamCapability | undefined,
    fallback?: LiveStreamCapability,
  ): void
  subscribe(
    handle: number,
    onFrame: (frame: LiveFrame) => void,
    onEnd?: (reason: LiveFrameEndReason) => void,
  ): LiveFrameSubscription | undefined
  capabilityOf(handle: number): LiveStreamDeclaration
  close(): Promise<void>
}

interface Subscriber {
  onFrame: (frame: LiveFrame) => void
  // Called once when the stream ends; a silent drop would leave a frozen frame that looks live.
  onEnd?: (reason: LiveFrameEndReason) => void
}

// `desired` and `running` stay apart, or a stop during an in-flight start leaves a dead stream.
interface StreamState {
  /** The DECLARED producer. `capabilityOf` answers its kind whichever producer is running. */
  capability: LiveStreamCapability
  /** Started in the primary's place when the primary's `start` rejects. */
  fallback?: LiveStreamCapability
  /**
   * The producer this watched interval is actually using: acks, stops and the frame kind stamp
   * route here. Reset to the primary on every stop, so the next interval tries the primary first.
   */
  active: LiveStreamCapability
  subscribers: Set<Subscriber>
  /** What the subscriber set asks for. True on first attach; false when the grace elapses empty. */
  desired: boolean
  /** What the producer is actually doing, as the reconciler last left it. */
  running: boolean
  /** A reconcile pass is already queued; it will observe any later `desired` flip by itself. */
  reconciling: boolean
  /** Serialises every producer call, so a start and a stop can never be in flight together. */
  chain: Promise<void>
  pendingStop?: () => void
  /** frameId → the subscribers that have not yet acked it, plus its bound-timer cancel. */
  awaiting: Map<number, { outstanding: Set<Subscriber>; cancel: () => void }>
  // Evicted and told; a release from an old subscription must not arm a fresh grace.
  dead: boolean
}

const NONE: LiveStreamDeclaration = { kind: 'none' }

export function createLiveStreamHub(opts: CreateLiveStreamHubOptions = {}): LiveStreamHub {
  const timer = opts.timer ?? defaultLiveStreamTimer()
  const graceMs = opts.graceMs ?? LIVE_STREAM_STOP_GRACE_MS
  const ackBoundMs = opts.ackBoundMs ?? LIVE_STREAM_ACK_BOUND_MS
  const onWarning = opts.onWarning
  const onSubscriberFault = opts.onSubscriberFault
  const streams = new Map<number, StreamState>()
  let closed = false

  const warn = (code: string, message: string): void => {
    try {
      onWarning?.(code, message)
    } catch {
      /* a warning sink that throws must never take the stream down */
    }
  }

  // The subscriber-fault sink; never `warn`.
  const reportSubscriberFault = (code: string, message: string): void => {
    try {
      onSubscriberFault?.(code, message)
    } catch {
      /* a fault sink that throws must never take the stream down either */
    }
  }

  const describe = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  /** Ack a frame to the producer exactly once, then forget it. */
  function settleFrame(state: StreamState, frameId: number): void {
    const entry = state.awaiting.get(frameId)
    if (!entry) return
    state.awaiting.delete(frameId)
    entry.cancel()
    void state.active.ack(frameId).catch(() => {
      // Acking a frame after the stream stopped is expected, not an error.
    })
  }

  /**
   * THE ONE PLACE `start` AND `stop` ARE CALLED. Queued on the state's own chain and looping until
   * `desired === running`, so a flip that arrives mid-await is picked up by the pass already in
   * flight rather than racing it.
   */
  function reconcile(state: StreamState): void {
    if (state.reconciling) return
    state.reconciling = true
    const onFrame = (frame: LiveFrame): void => {
      deliver(state, frame)
    }
    state.chain = state.chain.then(async () => {
      try {
        while (state.desired !== state.running) {
          if (state.desired) {
            state.running = true
            try {
              await state.capability.start(onFrame)
            } catch (error: unknown) {
              // Recorded before any switch: a fallback must never hide the primary's failure.
              warn('live-stream-start-failed', `live stream failed to start: ${describe(error)}`)
              const fallback = state.fallback
              if (fallback === undefined) {
                state.running = false
                break
              }
              // Active before the start, so a burst delivered inside `start()` is already stamped
              // and acked as the fallback's.
              state.active = fallback
              try {
                await fallback.start(onFrame)
              } catch (fallbackError: unknown) {
                state.active = state.capability
                state.running = false
                warn(
                  'live-stream-start-failed',
                  `live stream fallback (${fallback.kind}) failed to start: ${describe(fallbackError)}`,
                )
                break
              }
            }
          } else {
            state.running = false
            try {
              await state.active.stop()
            } catch (error: unknown) {
              warn('live-stream-stop-failed', `live stream failed to stop: ${describe(error)}`)
            }
            state.active = state.capability
          }
        }
      } finally {
        state.reconciling = false
      }
    })
  }

  /** Cancel a pending grace, if one is armed. Idempotent. */
  function cancelGrace(state: StreamState): void {
    const cancel = state.pendingStop
    state.pendingStop = undefined
    cancel?.()
  }

  /** End the watched interval NOW: drop the in-flight acks and ask the producer to stop. */
  function stopStream(state: StreamState): void {
    cancelGrace(state)
    for (const [, entry] of state.awaiting) entry.cancel()
    state.awaiting.clear()
    state.desired = false
    reconcile(state)
  }

  // Clear the set first, so a subscriber re-entering through `release()` finds nothing to remove.
  function endStream(state: StreamState, reason: LiveFrameEndReason): void {
    state.dead = true
    const leaving = [...state.subscribers]
    state.subscribers.clear()
    for (const subscriber of leaving) {
      try {
        subscriber.onEnd?.(reason)
      } catch {
        /* a viewer that throws on the way out is gone anyway — and it is not the run's business */
      }
    }
  }

  function scheduleStop(state: StreamState): void {
    if (state.dead) return
    cancelGrace(state)
    state.pendingStop = timer.schedule(graceMs, () => {
      state.pendingStop = undefined
      if (state.subscribers.size > 0) return
      stopStream(state)
    })
  }

  function deliver(state: StreamState, produced: LiveFrame): void {
    // The producer's time and kind win; the id is kept because the ack ledger keys on it.
    const frame: LiveFrame = {
      ...produced,
      metadata:
        produced.metadata.timestamp === undefined
          ? { ...produced.metadata, timestamp: timer.now() }
          : produced.metadata,
      kind: produced.kind ?? state.active.kind,
    }

    // Snapshot so a mid-delivery detach (or a subscriber that unsubscribes from its own callback)
    // cannot disturb the walk — the `bus.ts:125-139` shape.
    const receivers = [...state.subscribers]

    // THE ACK LEDGER IS OPENED BEFORE THE FIRST DELIVERY, and the order is the mechanism.
    //
    // Acking from inside the frame callback is the FASTEST and most natural consumer pattern — an
    // in-process reader that does not have to decode first has no reason to defer. Opening the
    // ledger after the walk meant such an ack found no entry and was silently dropped, so the
    // producer was told only when the ack BOUND fired: a live view capped at
    // `1000 / ackBoundMs` frames per second for the quickest viewer in the system, by a timer whose
    // entire purpose is WEDGED viewers. Invisible to any cell whose viewer acks a tick later, which
    // is why a browser page acking after `createImageBitmap` never showed it.
    const outstanding = new Set<Subscriber>(receivers)
    const cancel = timer.schedule(ackBoundMs, () => {
      // THE ACK BOUND: one wedged viewer must not freeze the stream for the others.
      settleFrame(state, frame.id)
    })
    state.awaiting.set(frame.id, { outstanding, cancel })

    let detached = false
    for (const subscriber of receivers) {
      if (!state.subscribers.has(subscriber)) {
        // Detached between the snapshot and its turn: it owes nothing for this frame.
        outstanding.delete(subscriber)
        continue
      }
      try {
        subscriber.onFrame(frame)
      } catch {
        state.subscribers.delete(subscriber)
        detached = true
        // A viewer closing its tab must not write a row into the run's transcript.
        reportSubscriberFault(
          'live-stream-subscriber-detached',
          'live-frame subscriber threw during delivery and was detached',
        )
      }
      // A subscriber that threw — or that unsubscribed from its own callback — cannot ack, so it
      // must not be counted as owing one. Otherwise the producer waits out the bound every frame.
      if (!state.subscribers.has(subscriber)) outstanding.delete(subscriber)
    }
    // Everyone acked in-callback, or nobody was left to ack: either way, tell the producer now
    // rather than stalling on an empty set. A no-op when an in-callback ack already settled it.
    if (outstanding.size === 0) settleFrame(state, frame.id)

    // A thrown-out viewer never unsubscribes, so schedule the stop here.
    if (detached && state.subscribers.size === 0) scheduleStop(state)
  }

  return {
    register(handle, capability, fallback): void {
      const existing = streams.get(handle)
      if (capability === undefined) {
        // Tell whoever is watching, or a viewer holds a frozen last frame labelled live.
        streams.delete(handle)
        if (existing) {
          stopStream(existing)
          endStream(existing, 'withdrawn')
        }
        return
      }
      if (existing && existing.capability === capability) return
      if (existing) {
        // A REPLACEMENT drops the old stream's subscribers just as surely as a withdrawal does:
        // they hold a subscription to a state that is about to be unreachable, and nothing will
        // ever deliver to them again. Same end, same name.
        stopStream(existing)
        endStream(existing, 'withdrawn')
      }
      streams.set(handle, {
        capability,
        ...(fallback === undefined ? {} : { fallback }),
        active: capability,
        subscribers: new Set<Subscriber>(),
        desired: false,
        running: false,
        reconciling: false,
        chain: Promise.resolve(),
        awaiting: new Map(),
        dead: false,
      })
    },

    subscribe(handle, onFrame, onEnd): LiveFrameSubscription | undefined {
      if (closed) return undefined
      const state = streams.get(handle)
      if (!state) return undefined
      const subscriber: Subscriber = onEnd === undefined ? { onFrame } : { onFrame, onEnd }
      state.subscribers.add(subscriber)
      // A re-subscribe inside the grace window CANCELS the stop; the producer never restarted.
      cancelGrace(state)
      state.desired = true
      reconcile(state)
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        state.subscribers.delete(subscriber)
        // An unsubscribe counts as acked for every frame this viewer still owed.
        for (const [frameId, entry] of [...state.awaiting]) {
          if (!entry.outstanding.delete(subscriber)) continue
          if (entry.outstanding.size === 0) settleFrame(state, frameId)
        }
        if (state.subscribers.size === 0) scheduleStop(state)
      }
      return {
        ack(frameId: number): void {
          const entry = state.awaiting.get(frameId)
          if (!entry) return
          entry.outstanding.delete(subscriber)
          if (entry.outstanding.size === 0) settleFrame(state, frameId)
        },
        unsubscribe: release,
      }
    },

    capabilityOf(handle): LiveStreamDeclaration {
      const state = streams.get(handle)
      if (!state) return NONE
      return { kind: state.capability.kind }
    },

    async close(): Promise<void> {
      // Evicts like the other eviction sites, so a release held past `close()` arms no grace.
      closed = true
      const pending: Promise<void>[] = []
      for (const [, state] of streams) {
        stopStream(state)
        endStream(state, 'closed')
        pending.push(state.chain)
      }
      streams.clear()
      await Promise.all(pending)
    },
  }
}
