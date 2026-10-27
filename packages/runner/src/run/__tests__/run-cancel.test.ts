// Plan 361-13 (SESSION-04 live-cancel blocker). The real-async-abort regression lock: the exact
// gap the synchronous-fake `abortableExecutor` unit suite missed. `run-shell.test.ts`'s
// `abortableExecutor` resolves the INSTANT its abortSignal fires, so the shell's `await
// config.executor(...)` always returns and `done` always settles — that is why the unit suite was
// green while a LIVE Ctrl+C hung. Here the active member is wedged on a promise that NEVER settles
// and IGNORES `ctx.abortSignal` entirely (modelling the planner's `Bad Request → retry-without-
// image` LLM window), so `done` cannot settle unless the shell RACES the executor against the
// member-abort. RED against the pre-fix shell (the bounded `resolvesWithin` race yields TIMED_OUT);
// GREEN after Task 2 laces the executor-vs-abort race into the member loop.
//
// Runner package convention: `.js`-suffixed relative import specifiers. Fully-faked executor +
// ports — no real fs, providers, or timers (except the short REAL-timer bound in `resolvesWithin`).
import { afterEach, describe, expect, it, vi } from 'vitest'

import { startRun } from '../shell.js'
import type {
  MemberTestExecutor,
  MemberTestRunContext,
  RunConfig,
  RunMemberDescriptor,
} from '../shell.js'
import type { EventLogPort, HandoffStorePort } from '../ports.js'
import type { TestResult } from '../../result.js'
import type { CompletedRunHandoff, RunEventEnvelope, RunSession } from '@vostride/agent-qa-schema'

// ---- Fakes (mirroring run-shell.test.ts conventions) ---------------------

interface FakeHandoffStore extends HandoffStorePort {
  saved: CompletedRunHandoff[]
  saveCalls: number
}

function makeFakeHandoffStore(): FakeHandoffStore {
  const saved: CompletedRunHandoff[] = []
  return {
    saved,
    saveCalls: 0,
    async save(handoff: CompletedRunHandoff) {
      this.saveCalls += 1
      saved.push(handoff)
    },
  }
}

function makeFakeEventLog(): EventLogPort {
  const store: RunEventEnvelope[] = []
  return {
    append(envelope: RunEventEnvelope) {
      store.push(envelope)
    },
    read(fromSeq: number) {
      return store.filter(event => event.seq >= fromSeq)
    },
  }
}

// The executor that reproduces the live wedge: the active member records its testId then returns a
// promise that NEVER resolves, NEVER rejects, and IGNORES ctx.abortSignal entirely (no abort
// listener). This is the member the planner leaves stuck in the retry-without-image window after
// runController.abort() — the shell must not trust it to settle.
function pendingWedgedExecutor(calls: string[]): MemberTestExecutor {
  return (member: RunMemberDescriptor, ctx: MemberTestRunContext) => {
    calls.push(member.testId)
    void ctx
    return new Promise<TestResult>(() => {
      /* never settles, never observes abort */
    })
  }
}

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: 'run-cancel-1' as RunConfig['runId'],
    scope: { tier: 'suite', key: 'checkout' },
    executionContext: 'local-headless',
    buildOrdinal: 7,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: [
      { testId: 'a', name: 'test a', filePath: 'a.test.ts' },
      { testId: 'b', name: 'test b', filePath: 'b.test.ts' },
    ],
    executor: pendingWedgedExecutor([]),
    ports: { handoffStore: makeFakeHandoffStore(), eventLog: makeFakeEventLog() },
    ...overrides,
  }
}

function drain(session: RunSession): RunEventEnvelope[] {
  const received: RunEventEnvelope[] = []
  ;(session as unknown as {
    subscribe(fromSeq: number, handler: (e: RunEventEnvelope) => void): () => void
  }).subscribe(1, event => received.push(event))
  return received
}

function done(session: RunSession): Promise<{ verdict: string; handoff: CompletedRunHandoff }> {
  return (session as unknown as {
    done: Promise<{ verdict: string; handoff: CompletedRunHandoff }>
  }).done
}

function cancel(session: RunSession): void {
  ;(session as unknown as { cancel(): void }).cancel()
}

// A distinct sentinel so a genuinely-settled `done` (even one that resolves to a falsy-ish shape)
// can never be confused with the bounded-wait timeout.
const TIMED_OUT = Symbol('TIMED_OUT')

// Bounded wait: resolve with the promise's value, or the TIMED_OUT sentinel if it does not settle
// within `ms`, raced against a SHORT REAL-timer sleep. Keeps RED fast — the pre-fix shell never
// settles `done`, so the race yields TIMED_OUT immediately rather than a slow whole-test timeout.
function resolvesWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>(resolve => {
      setTimeout(() => resolve(TIMED_OUT), ms)
    }),
  ])
}

// ---- The regression lock -------------------------------------------------

describe('run-level cancel on a member wedged on a truly-pending promise', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('1. session.cancel() mid-wedged-member settles done to cancelled without waiting on the member (D-03)', async () => {
    const calls: string[] = []
    const session = startRun(baseConfig({ executor: pendingWedgedExecutor(calls) }))
    drain(session)
    cancel(session)

    const settled = await resolvesWithin(done(session), 200)
    expect(settled).not.toBe(TIMED_OUT)
    expect((settled as { verdict: string }).verdict).toBe('cancelled')
    // The second member never starts once the run is cancelled.
    expect(calls).toEqual(['a'])
  })

  it('3. terminal invariants hold on the cancel path: verdict once < runFinished last/detached (SESSION-02 / D-07)', async () => {
    const session = startRun(baseConfig({ executor: pendingWedgedExecutor([]) }))
    const events = drain(session)
    cancel(session)

    const settled = await resolvesWithin(done(session), 200)
    expect(settled).not.toBe(TIMED_OUT)

    const verdicts = events.filter(e => e.type === 'verdict')
    const finishes = events.filter(e => e.type === 'runFinished')
    expect(verdicts).toHaveLength(1)
    expect(finishes).toHaveLength(1)
    const verdictIdx = events.findIndex(e => e.type === 'verdict')
    const finishIdx = events.findIndex(e => e.type === 'runFinished')
    expect(verdictIdx).toBeLessThan(finishIdx)
    expect(finishIdx).toBe(events.length - 1)
    const finishPayload = finishes[0].payload as { disposition: string; finalSeq: number }
    expect(finishPayload.disposition).toBe('detached')
    expect(finishPayload.finalSeq).toBe(finishes[0].seq)
  })

  it('4. exactly one handoff on the cancel path; the wedged member is a cancelled entry (D-17)', async () => {
    const store = makeFakeHandoffStore()
    const session = startRun(
      baseConfig({
        executor: pendingWedgedExecutor([]),
        ports: { handoffStore: store, eventLog: makeFakeEventLog() },
      }),
    )
    drain(session)
    cancel(session)

    const settled = await resolvesWithin(done(session), 200)
    expect(settled).not.toBe(TIMED_OUT)
    const { handoff } = settled as { handoff: CompletedRunHandoff }

    expect(store.saveCalls).toBe(1)
    expect(store.saved[0]).toBe(handoff)
    const wedged = handoff.tests.find(t => t.testId === 'a')
    expect(wedged).toBeDefined()
    expect(wedged?.outcome).toBe('cancelled')
    expect(wedged?.steps).toEqual([])
  })

  it('5. the bus heartbeat interval is cleared after the cancel path so the event loop can drain', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const session = startRun(baseConfig({ executor: pendingWedgedExecutor(calls) }))
      drain(session)
      cancel(session)

      // Advance the fake clock so any queued microtasks + the bounded race settle; the shell's
      // terminal sequence must run bus.close(), clearing the (default-clock) heartbeat interval.
      await vi.advanceTimersByTimeAsync(250)
      await done(session)

      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
