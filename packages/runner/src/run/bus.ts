// The in-memory run event bus — the one no-analog component of the phase, hand-rolled
// per spec §2.2. Pure runner logic: gap-free `seq` from 1 (single sequencer),
// a 10,000-event / 16 MB windowed replay, `subscribe(fromSeq)` replay-then-live,
// per-subscriber detach-on-error, degrade-to-memory on event-log write failure, and a
// ~10 s heartbeat after bus silence. ALL I/O crosses to runner-local behind the injected
// `EventLogPort` / `RunTimerPort` seams — no `node:*`, storage-neutral (validate:arch).
//
// Verdict independence: telemetry/persistence failures degrade with a single
// `runWarning` and NEVER gate the run or its verdict. Subscriber isolation: a
// throwing handler is caught, detached, and announced; other subscribers are untouched.

import type {
  RunEventEnvelope,
  RunEventType,
  RunEventPayload,
} from '@vostride/agent-qa-schema'
import type { EventLogPort, RunTimerPort } from './ports.js'

/** ~10 s after bus silence (the v1 heartbeat cadence, spec §2.2). */
const DEFAULT_HEARTBEAT_MS = 10_000
/** In-memory replay window retention caps (spec §2.2). */
const DEFAULT_WINDOW_MAX_EVENTS = 10_000
const DEFAULT_WINDOW_MAX_BYTES = 16 * 1024 * 1024

/**
 * Thrown by `subscribe(fromSeq, …)` when the requested range is neither in the in-memory
 * window nor recoverable from the (possibly degraded) event log (D-07 — report incomplete,
 * never silently serve a truncated stream). `earliestAvailableSeq` is the lowest seq the bus
 * can still replay (the SSE `Last-Event-ID` re-subscribe floor in M5).
 */
export class ReplayIncompleteError extends Error {
  readonly earliestAvailableSeq: number
  constructor(requestedSeq: number, earliestAvailableSeq: number) {
    super(
      `ReplayIncomplete: events before seq ${earliestAvailableSeq} are no longer available ` +
        `(replay requested from seq ${requestedSeq})`,
    )
    this.name = 'ReplayIncompleteError'
    this.earliestAvailableSeq = earliestAvailableSeq
  }
}

/** A live/replay subscriber. Synchronous — replay-then-live per-subscriber order is total. */
type RunEventHandler = (event: RunEventEnvelope) => void

/**
 * The bus surface. `publish` stamps `seq`/`ts` and returns the sealed envelope (the shell reads
 * `.seq` for `runFinished.finalSeq`); `subscribe` replays then goes live; `close` stops the
 * heartbeat (publish-after-close is a programming error).
 */
export interface RunEventBus {
  publish(type: RunEventType, payload: RunEventPayload | Record<string, unknown>): RunEventEnvelope
  subscribe(fromSeq: number | undefined, handler: RunEventHandler): () => void
  readonly currentSeq: number
  close(): void
}

export interface CreateRunEventBusOptions {
  runId: string
  eventLog?: EventLogPort
  timer?: RunTimerPort
  heartbeatMs?: number
  windowMaxEvents?: number
  windowMaxBytes?: number
}

/** Default timer: wraps global setTimeout/clearTimeout, unref'd so it never keeps the process alive. */
function defaultTimer(): RunTimerPort {
  return {
    schedule(delayMs: number, fn: () => void): () => void {
      const handle = setTimeout(fn, delayMs) as unknown as { unref?: () => void }
      handle.unref?.()
      return () => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
    },
    now: () => Date.now(),
  }
}

export function createRunEventBus(opts: CreateRunEventBusOptions): RunEventBus {
  const { runId, eventLog } = opts
  const timer = opts.timer ?? defaultTimer()
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const windowMaxEvents = opts.windowMaxEvents ?? DEFAULT_WINDOW_MAX_EVENTS
  const windowMaxBytes = opts.windowMaxBytes ?? DEFAULT_WINDOW_MAX_BYTES

  let nextSeq = 1
  let logDegraded = false
  let closed = false
  const subscribers = new Set<RunEventHandler>()
  const window: { e: RunEventEnvelope; size: number }[] = []
  let windowBytes = 0
  let heartbeatCancel: (() => void) | undefined

  // Serialized-envelope length as the byte proxy (the §2.2 discretion note's accounting choice).
  const byteSize = (envelope: RunEventEnvelope): number => JSON.stringify(envelope).length

  const earliestRetainedSeq = (): number => (window.length > 0 ? window[0].e.seq : nextSeq)

  function retain(envelope: RunEventEnvelope): void {
    const size = byteSize(envelope)
    window.push({ e: envelope, size })
    windowBytes += size
    // Evict oldest until within both caps; always keep the just-published event for live delivery.
    while (window.length > 1 && (window.length > windowMaxEvents || windowBytes > windowMaxBytes)) {
      const evicted = window.shift()
      if (evicted) windowBytes -= evicted.size
    }
  }

  function appendToLog(envelope: RunEventEnvelope): void {
    if (!eventLog || logDegraded) return
    try {
      eventLog.append(envelope)
    } catch {
      // First failure only: flip the degrade flag BEFORE the warning so its own publish
      // never re-enters the append path, and never attempt append again.
      logDegraded = true
      publish('runWarning', {
        code: 'event-log-write-failed',
        message: 'event log append failed; degraded to memory-only',
      })
    }
  }

  function deliver(envelope: RunEventEnvelope): void {
    // Snapshot so a mid-delivery detach (or a nested detach-warning publish) can't disturb the walk.
    for (const handler of [...subscribers]) {
      if (!subscribers.has(handler)) continue
      try {
        handler(envelope)
      } catch {
        subscribers.delete(handler)
        publish('runWarning', {
          code: 'subscriber-detached',
          message: 'subscriber threw during delivery and was detached',
        })
      }
    }
  }

  function armHeartbeat(): void {
    if (closed) return
    heartbeatCancel?.()
    heartbeatCancel = timer.schedule(heartbeatMs, () => {
      heartbeatCancel = undefined
      if (closed) return
      publish('heartbeat', {}) // empty payload; re-arms via the publish path below
    })
  }

  function publish(
    type: RunEventType,
    payload: RunEventPayload | Record<string, unknown>,
  ): RunEventEnvelope {
    if (closed) throw new Error('RunEventBus.publish called after close()')
    const envelope: RunEventEnvelope = {
      seq: nextSeq++,
      ts: timer.now(),
      runId,
      type,
      payload: payload as RunEventPayload,
    }
    retain(envelope)
    appendToLog(envelope)
    deliver(envelope)
    armHeartbeat()
    return envelope
  }

  function collectReplay(from: number): RunEventEnvelope[] {
    const earliest = earliestRetainedSeq()
    const result: RunEventEnvelope[] = []
    if (from < earliest) {
      const expected = earliest - from
      let older: RunEventEnvelope[] = []
      if (eventLog && !logDegraded) {
        older = eventLog.read(from).filter(e => e.seq >= from && e.seq < earliest)
      }
      if (older.length < expected) {
        // Neither the window (evicted) nor the log (absent/degraded/truncated) can supply
        // the requested prefix — report incomplete rather than serve a gap.
        throw new ReplayIncompleteError(from, earliest)
      }
      older.sort((a, b) => a.seq - b.seq)
      result.push(...older)
    }
    const liveFrom = Math.max(from, earliest)
    for (const { e } of window) {
      if (e.seq >= liveFrom) result.push(e)
    }
    return result
  }

  function subscribe(fromSeq: number | undefined, handler: RunEventHandler): () => void {
    const from = fromSeq ?? 1
    const replay = collectReplay(from) // throws ReplayIncompleteError out of subscribe
    let detached = false
    for (const envelope of replay) {
      try {
        handler(envelope)
      } catch {
        detached = true
        break
      }
    }
    if (detached) {
      publish('runWarning', {
        code: 'subscriber-detached',
        message: 'subscriber threw during replay and was detached',
      })
      return () => {}
    }
    subscribers.add(handler)
    return () => {
      subscribers.delete(handler)
    }
  }

  function close(): void {
    closed = true
    heartbeatCancel?.()
    heartbeatCancel = undefined
  }

  return {
    publish,
    subscribe,
    get currentSeq() {
      return nextSeq - 1
    },
    close,
  }
}
