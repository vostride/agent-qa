// Wave-0 RED scaffold (361-01, Task 2). Pins the SESSION-02 in-memory event-bus
// contract BEFORE any implementation exists — RED strictly on the unresolved import
// of the not-yet-existing `../bus.js` module (right-reason RED). Turns green in Plan 04.
//
// Contract source: 361-CONTEXT.md D-05 (bus is pure logic in packages/runner), D-07
// (event-log write failure ⇒ runWarning + degrade to memory-only), D-08 (subscribe /
// replay-then-live / subscriber-error detach) + spec/v2/runner.md §2.2 (seq gap-free
// from 1, replay from fromSeq default 1, 10,000-event / 16 MB in-memory window,
// ~10 s heartbeat after bus silence).
//
// Runner package convention: `.js`-suffixed relative import specifiers. Fully faked
// ports — no real timers, no fs, no watch mode.
import { describe, expect, it, vi } from 'vitest'

import { createRunEventBus } from '../bus.js'
import type { RunEventBus, ReplayIncompleteError } from '../bus.js'
import type { EventLogPort, RunTimerPort } from '../ports.js'
import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { RunEventEnvelope, RunEventType } from '@vostride/agent-qa-schema'

// ---- Fakes ---------------------------------------------------------------

interface FakeEventLog extends EventLogPort {
  appended: RunEventEnvelope[]
  appendCalls: number
}

function makeFakeEventLog(options: { failFrom?: number; readImpl?: (fromSeq: number) => RunEventEnvelope[] } = {}): FakeEventLog {
  const store: RunEventEnvelope[] = []
  return {
    appendCalls: 0,
    appended: store,
    append(envelope: RunEventEnvelope) {
      this.appendCalls += 1
      if (options.failFrom !== undefined && this.appendCalls >= options.failFrom) {
        throw new Error('disk full')
      }
      store.push(envelope)
    },
    read(fromSeq: number): RunEventEnvelope[] {
      if (options.readImpl) return options.readImpl(fromSeq)
      return store.filter(event => event.seq >= fromSeq)
    },
  }
}

interface FakeTimer extends RunTimerPort {
  fireLatest(): void
  pending: number
}

function makeFakeTimer(): FakeTimer {
  let scheduled: (() => void) | undefined
  return {
    pending: 0,
    schedule(_delayMs: number, fn: () => void): () => void {
      scheduled = fn
      this.pending += 1
      return () => {
        if (scheduled === fn) scheduled = undefined
        this.pending = Math.max(0, this.pending - 1)
      }
    },
    now: () => 1_700_000_000_000,
    fireLatest() {
      scheduled?.()
    },
  }
}

function collect(bus: RunEventBus, fromSeq?: number): RunEventEnvelope[] {
  const received: RunEventEnvelope[] = []
  bus.subscribe(fromSeq, event => received.push(event))
  return received
}

// ---- Seq discipline ------------------------------------------------------

describe('createRunEventBus — seq assignment (spec §2.2)', () => {
  it('assigns seq starting at 1, gap-free monotonic across publishes', () => {
    const bus = createRunEventBus({ runId: 'run-1' })
    const a = bus.publish('runWarning', { code: 'x' })
    const b = bus.publish('runWarning', { code: 'y' })
    const c = bus.publish('runWarning', { code: 'z' })
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect(a.runId).toBe('run-1')
  })
})

// ---- Subscribe / replay-then-live / detach (D-08) ------------------------

describe('subscribe — replay-then-live, per-subscriber order', () => {
  it('replays retained events in seq order, then delivers live', () => {
    const bus = createRunEventBus({ runId: 'run-1' })
    bus.publish('runWarning', { code: 'a' })
    bus.publish('runWarning', { code: 'b' })

    const received = collect(bus, 1)
    expect(received.map(e => e.seq)).toEqual([1, 2])

    bus.publish('runWarning', { code: 'c' })
    expect(received.map(e => e.seq)).toEqual([1, 2, 3])
  })

  it('fromSeq defaults to 1', () => {
    const bus = createRunEventBus({ runId: 'run-1' })
    bus.publish('runWarning', { code: 'a' })
    bus.publish('runWarning', { code: 'b' })
    const received = collect(bus)
    expect(received.map(e => e.seq)).toEqual([1, 2])
  })

  it('the returned unsubscribe detaches the subscriber', () => {
    const bus = createRunEventBus({ runId: 'run-1' })
    const received: RunEventEnvelope[] = []
    const unsubscribe = bus.subscribe(1, event => received.push(event))
    bus.publish('runWarning', { code: 'a' })
    unsubscribe()
    bus.publish('runWarning', { code: 'b' })
    expect(received.map(e => e.seq)).toEqual([1])
  })

  it('a throwing handler is caught, that subscriber detached, a subscriber-detached runWarning published, others unaffected', () => {
    const bus = createRunEventBus({ runId: 'run-1' })
    const good: RunEventEnvelope[] = []
    bus.subscribe(1, event => good.push(event))
    let thrownOnce = false
    bus.subscribe(1, () => {
      if (!thrownOnce) {
        thrownOnce = true
        throw new Error('handler boom')
      }
    })

    expect(() => bus.publish('testStarted', { testId: 't', testIndex: 0 })).not.toThrow()

    const warning = good.find(e => e.type === 'runWarning')
    expect(warning).toBeDefined()
    expect((warning?.payload as { code: string }).code).toBe('subscriber-detached')
    // The good subscriber keeps receiving live events after the sibling detaches.
    const before = good.length
    bus.publish('testFinished', { testId: 't', testIndex: 0, outcome: 'passed' })
    expect(good.length).toBeGreaterThan(before)
  })
})

// ---- Event-log append + degrade-to-memory (D-06/D-07) --------------------

describe('event-log append + degrade', () => {
  it('appends every publish to the injected EventLogPort', () => {
    const log = makeFakeEventLog()
    const bus = createRunEventBus({ runId: 'run-1', eventLog: log })
    bus.publish('runWarning', { code: 'a' })
    bus.publish('runWarning', { code: 'b' })
    expect(log.appended.map(e => e.seq)).toEqual([1, 2])
  })

  it('the FIRST append failure publishes runWarning event-log-write-failed exactly once, then stops appending', () => {
    const log = makeFakeEventLog({ failFrom: 2 })
    const bus = createRunEventBus({ runId: 'run-1', eventLog: log })
    const warnings: RunEventEnvelope[] = []
    bus.subscribe(1, event => {
      if (event.type === 'runWarning' && (event.payload as { code: string }).code === 'event-log-write-failed') {
        warnings.push(event)
      }
    })

    bus.publish('runWarning', { code: 'a' }) // append #1 ok
    bus.publish('runWarning', { code: 'b' }) // append #2 throws -> degrade
    bus.publish('runWarning', { code: 'c' }) // no further append attempts

    expect(warnings).toHaveLength(1)
    // No append is attempted after degrade (call count frozen at the failing attempt).
    expect(log.appendCalls).toBe(2)
    // The bus keeps serving live + in-window replay from memory after degrade.
    const received = collect(bus, 1)
    expect(received.length).toBeGreaterThanOrEqual(3)
  })
})

// ---- Window eviction + deep replay (spec §2.2 retention caps) -------------

describe('in-memory window eviction + deep replay (spec §2.2)', () => {
  it('deep replay (fromSeq older than the window) reads from the event log', () => {
    const log = makeFakeEventLog()
    const bus = createRunEventBus({ runId: 'run-1', eventLog: log, windowMaxEvents: 3 })
    for (let i = 0; i < 5; i += 1) bus.publish('runWarning', { code: `c${i}` })
    // Memory retains only the last 3 (seq 3,4,5); seq 1,2 served from the log.
    const received = collect(bus, 1)
    expect(received.map(e => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('evicts beyond windowMaxEvents — subscribe below the retained floor without a log throws ReplayIncompleteError', () => {
    const bus = createRunEventBus({ runId: 'run-1', windowMaxEvents: 3 })
    for (let i = 0; i < 5; i += 1) bus.publish('runWarning', { code: `c${i}` })
    let thrown: unknown
    try {
      bus.subscribe(1, () => {})
    } catch (error) {
      thrown = error
    }
    expect((thrown as ReplayIncompleteError).name).toBe('ReplayIncompleteError')
    expect((thrown as ReplayIncompleteError).earliestAvailableSeq).toBe(3)
    // Subscribing from the retained floor still works.
    expect(() => bus.subscribe(3, () => {})).not.toThrow()
  })

  it('evicts beyond windowMaxBytes (serialized-envelope length accounting)', () => {
    // Two envelopes' worth of bytes — older seqs evicted by the byte cap.
    const oneEnvelopeBytes = JSON.stringify({ seq: 1, ts: 1, runId: 'run-1', type: 'runWarning', payload: { code: 'c0' } }).length
    const bus = createRunEventBus({ runId: 'run-1', windowMaxBytes: oneEnvelopeBytes * 2 })
    for (let i = 0; i < 5; i += 1) bus.publish('runWarning', { code: `c${i}` })
    let thrown: unknown
    try {
      bus.subscribe(1, () => {})
    } catch (error) {
      thrown = error
    }
    expect((thrown as ReplayIncompleteError).name).toBe('ReplayIncompleteError')
    expect((thrown as ReplayIncompleteError).earliestAvailableSeq).toBeGreaterThan(1)
  })

  it('a degraded log that cannot supply the requested range throws ReplayIncompleteError carrying earliestAvailableSeq', () => {
    // Log is degraded: it can only supply seq >= 4 (the early appends were lost).
    const log = makeFakeEventLog({ readImpl: fromSeq => (fromSeq >= 4 ? [] : []) })
    const bus = createRunEventBus({ runId: 'run-1', eventLog: log, windowMaxEvents: 3 })
    for (let i = 0; i < 6; i += 1) bus.publish('runWarning', { code: `c${i}` })
    // seq 1,2,3 are neither in memory (evicted) nor recoverable from the degraded log.
    expect(() => bus.subscribe(1, () => {})).toThrow(/ReplayIncomplete/)
  })
})

// ---- Heartbeat (spec §2.2 liveness) --------------------------------------

describe('heartbeat via injected RunTimerPort (spec §2.2)', () => {
  it('publishes a heartbeat after bus silence and stops after runFinished/close', () => {
    const timer = makeFakeTimer()
    const bus = createRunEventBus({ runId: 'run-1', timer })
    const received = collect(bus, 1)

    bus.publish('runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION })
    timer.fireLatest() // simulate ~10 s of silence
    expect(received.some(e => e.type === 'heartbeat')).toBe(true)

    // After the terminal runFinished (or close), no further heartbeat is scheduled.
    bus.publish('runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: 99 })
    bus.close()
    const heartbeatsBefore = received.filter(e => e.type === 'heartbeat').length
    timer.fireLatest()
    const heartbeatsAfter = received.filter(e => e.type === 'heartbeat').length
    expect(heartbeatsAfter).toBe(heartbeatsBefore)
  })

  it('does not require real timers (RunTimerPort fully injected)', () => {
    const timer = makeFakeTimer()
    const spy = vi.spyOn(timer, 'schedule')
    const bus = createRunEventBus({ runId: 'run-1', timer })
    bus.publish('runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION })
    expect(spy).toHaveBeenCalled()
    bus.close()
  })
})

// Keep the RunEventType symbol referenced so the contract import is load-bearing.
const _sampleType: RunEventType = 'heartbeat'
void _sampleType
