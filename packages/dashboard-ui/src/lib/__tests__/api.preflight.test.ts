// @vitest-environment jsdom

// The dashboard as a THIN CLIENT of the run contract (Phase 402 plan 08, D-01/D-15 · INVK-03/04).
//
// TWO CLAIMS, AND ONLY ONE OF THEM IS ABOUT A HAPPY PATH.
//
// 1. THE PREFLIGHT IS AT THE CHOKE POINT AND IT BLOCKS. Nine call sites start a run and every one
//    of them funnels through `triggerRun`; gating per page would be nine places to forget. What
//    makes "it preflights" a measurement rather than a description is the NEGATIVE half: on a
//    not-ready answer the trigger POST must never be issued at all. A cell that only asserted the
//    readiness fetch happened would pass under an implementation that fetched readiness, ignored
//    the answer and posted anyway — which is the implementation a racing trigger already is.
//
// 2. THE ATTACH HELPER ADDRESSES ONE MEMBER. The URL is the observable, so `EventSource` is stubbed
//    with a capturing class and the constructed URL asserted — including `handle=0`, which every
//    `if (opts.handle)` spelling silently drops.
//
// WHAT THE GATE READS. The facts that decide whether THIS process can run something are `service`
// and `hostComposed`. 2026-10-01: the readiness answer no longer carries
// `authConfigured` (no run-service credential can be declared); a cell below keeps an older server's
// answer, which still carries it, from being read as unready.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RUN_EVENT_TYPES, RUN_SERVICE_CONTRACT_VERSION } from '@vostride/agent-qa-schema'

import {
  RunNotReadyError,
  openRunStream,
  triggerRun,
} from '@/lib/api'

const READY = {
  service: 'up',
  hostComposed: true,
  contractVersion: RUN_SERVICE_CONTRACT_VERSION,
}

interface FetchCall {
  readonly url: string
  readonly method: string
}

let calls: FetchCall[]
let originalFetch: typeof fetch

/**
 * A fetch double routed by URL: the readiness route answers what the cell chose, the trigger route
 * answers a queued run. Every call is recorded IN ORDER, which is what makes "readiness first" and
 * "the trigger was never issued" both askable of the same log.
 */
function stubFetch(readiness: { status: number; body: unknown } | Error): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.includes('/api/run-readiness')) {
      if (readiness instanceof Error) throw readiness
      return {
        ok: readiness.status >= 200 && readiness.status < 300,
        status: readiness.status,
        statusText: 'x',
        json: async () => readiness.body,
      } as unknown as Response
    }
    return {
      ok: true,
      status: 202,
      statusText: 'Accepted',
      json: async () => ({ runId: 'run_1', status: 'queued' }),
    } as unknown as Response
  }) as unknown as typeof fetch
}

const triggerCalls = (): FetchCall[] => calls.filter((call) => call.url.includes('/api/runs/trigger'))
const readinessCalls = (): FetchCall[] => calls.filter((call) => call.url.includes('/api/run-readiness'))

beforeEach(() => {
  calls = []
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('triggerRun preflights readiness at the ONE choke point', () => {
  it('asks readiness FIRST, then posts the trigger, and returns the trigger response unchanged', async () => {
    stubFetch({ status: 200, body: READY })

    await expect(triggerRun({ file: 'tests/a.yaml' })).resolves.toEqual({
      runId: 'run_1',
      status: 'queued',
    })

    // The ORDER, off the same log — not two independent "was called" assertions.
    expect(calls.map((call) => call.url.replace(/\?.*$/u, ''))).toEqual([
      '/api/run-readiness',
      '/api/runs/trigger',
    ])
    expect(triggerCalls()[0]?.method).toBe('POST')
  })

  // RE-SPELLED 2026-10-01: was 'still threads the confirm scope on the ready path'.
  // The page no longer holds a scope to thread; the claim that survives is the second half — the
  // preflight changes nothing else, so the trigger carries the caller's body as given and no more.
  it('posts the caller body unchanged on the ready path — the preflight changes nothing else', async () => {
    stubFetch({ status: 200, body: READY })

    const body = await new Promise<Record<string, unknown>>((resolve) => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/run-readiness')) {
          return { ok: true, status: 200, json: async () => READY } as unknown as Response
        }
        resolve(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return { ok: true, status: 202, json: async () => ({ runId: 'r', status: 'queued' }) } as unknown as Response
      }) as unknown as typeof fetch
      void triggerRun({ file: 'tests/a.yaml' })
    })

    expect(body).toEqual({ file: 'tests/a.yaml' })
  })

  it('REFUSES to post when the host is not composed, and names the reason', async () => {
    stubFetch({ status: 200, body: { ...READY, hostComposed: false } })

    await expect(triggerRun({ file: 'tests/a.yaml' })).rejects.toBeInstanceOf(RunNotReadyError)
    // The negative half: nothing was started.
    expect(triggerCalls()).toEqual([])
    expect(readinessCalls()).toHaveLength(1)
  })

  it('carries the readiness facts on the rejection, so a page can render WHY', async () => {
    stubFetch({ status: 200, body: { ...READY, hostComposed: false } })

    const error = await triggerRun({ file: 'tests/a.yaml' }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(RunNotReadyError)
    const notReady = error as RunNotReadyError
    expect(notReady.reason).toContain('host')
    expect(notReady.message).toContain(notReady.reason)
    expect(notReady.readiness).toMatchObject({ hostComposed: false })
  })

  // re-spelled from 'PROCEEDS with authConfigured false — the shipped default'. The field is
  // gone from the answer; the claim that survives is that the gate reads only service and
  // hostComposed, so neither the shipped answer nor an older server's extra member stops a run.
  it('PROCEEDS on the shipped answer and on an older answer that still carries authConfigured', async () => {
    stubFetch({ status: 200, body: { ...READY, authConfigured: false } })

    await expect(triggerRun({ file: 'tests/a.yaml' })).resolves.toMatchObject({ runId: 'run_1' })
    expect(triggerCalls()).toHaveLength(1)
  })

  // the contract moved to version 2 for a readiness member and refusal
  // codes the preflight never read, so the gate accepts either version rather than gating on it.
  it('proceeds on a version 2 answer and on a version 1 answer', async () => {
    expect(RUN_SERVICE_CONTRACT_VERSION).toBe(2)
    stubFetch({ status: 200, body: { service: 'up', hostComposed: true, contractVersion: 2 } })
    await expect(triggerRun({ file: 'tests/a.yaml' })).resolves.toMatchObject({ runId: 'run_1' })

    stubFetch({ status: 200, body: { service: 'up', hostComposed: true, authConfigured: false, contractVersion: 1 } })
    await expect(triggerRun({ file: 'tests/a.yaml' })).resolves.toMatchObject({ runId: 'run_1' })
    expect(triggerCalls()).toHaveLength(2)
  })

  it.each([503, 404] as const)('PROCEEDS on %i — a door that answers no readiness never said "not ready"', async (status) => {
    // 503 is the router's "this server was started without a readiness predicate" (a legacy
    // two-argument mount); 404 is a server that predates the route. Neither is a measurement of
    // whether this process can run tests, and dashboards composed that way demonstrably do —
    // `run-confirm-browser.e2e.test.ts` builds one and drives a real run through it. Refusing here
    // would brick a working dashboard for a fact nobody established.
    stubFetch({ status, body: { error: 'This server was started without a run-service readiness predicate' } })

    await expect(triggerRun({ file: 'tests/a.yaml' })).resolves.toMatchObject({ runId: 'run_1' })
    expect(triggerCalls()).toHaveLength(1)
  })

  it('REFUSES on a 500 — a readiness door that broke is not a door that said nothing', async () => {
    // The carve-out above is exactly two statuses wide. A predicate that threw is an answer this
    // build can neither read nor dismiss, and the fail-closed arm is what covers it.
    stubFetch({ status: 500, body: { error: 'readiness exploded' } })

    await expect(triggerRun({ file: 'tests/a.yaml' })).rejects.toBeInstanceOf(RunNotReadyError)
    expect(triggerCalls()).toEqual([])
  })

  it('refuses when the readiness request itself fails — fail closed, never optimistic', async () => {
    stubFetch(new TypeError('Failed to fetch'))

    await expect(triggerRun({ file: 'tests/a.yaml' })).rejects.toBeInstanceOf(RunNotReadyError)
    expect(triggerCalls()).toEqual([])
  })

  it('refuses an unreadable readiness body rather than guessing it meant yes', async () => {
    stubFetch({ status: 200, body: { nonsense: true } })

    await expect(triggerRun({ file: 'tests/a.yaml' })).rejects.toBeInstanceOf(RunNotReadyError)
    expect(triggerCalls()).toEqual([])
  })
})

/** A capturing EventSource: the constructed URL is the observable this suite asserts on. */
class StubEventSource {
  static instances: StubEventSource[] = []
  readonly listeners = new Map<string, Array<(event: Event) => void>>()
  closed = false

  constructor(readonly url: string) {
    StubEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: (event: Event) => void): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(handler)
    this.listeners.set(type, existing)
  }

  close(): void {
    this.closed = true
  }

  /** Deliver one frame the way the browser would: named event, JSON data, `lastEventId` = seq. */
  emit(type: string, data: unknown, lastEventId = '1'): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data), lastEventId })
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

describe('openRunStream attaches to the local run-stream route, per handle', () => {
  beforeEach(() => {
    StubEventSource.instances = []
    vi.stubGlobal('EventSource', StubEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('with no handle opens the run-stream URL and adds NO handle parameter', () => {
    openRunStream('run_42', {})
    const source = StubEventSource.instances[0]!
    expect(source.url).toBe('/api/run-stream/run_42')
    expect(source.url).not.toContain('handle')
  })

  it('with a handle appends it', () => {
    openRunStream('run_42', { handle: 2 })
    expect(StubEventSource.instances[0]!.url).toBe('/api/run-stream/run_42?handle=2')
  })

  it('appends handle 0 — the member every `if (handle)` spelling silently drops', () => {
    openRunStream('run_42', { handle: 0 })
    expect(StubEventSource.instances[0]!.url).toBe('/api/run-stream/run_42?handle=0')
  })

  it('encodes the run id', () => {
    openRunStream('run/../evil', {})
    expect(StubEventSource.instances[0]!.url).toBe('/api/run-stream/run%2F..%2Fevil')
  })

  it('listens for EVERY event type the bus declares — enumerated from the schema, not restated', () => {
    openRunStream('run_42', {})
    const registered = [...StubEventSource.instances[0]!.listeners.keys()].sort()
    expect(registered).toEqual([...RUN_EVENT_TYPES].sort())
  })

  it('delivers the parsed envelope to onEvent, whatever the type', () => {
    const seen: unknown[] = []
    openRunStream('run_42', { handle: 7, onEvent: (envelope) => seen.push(envelope) })
    const source = StubEventSource.instances[0]!

    source.emit('testStarted', { seq: 5, ts: 5, runId: 'run_42', type: 'testStarted', payload: { testIndex: 7 } })
    source.emit('runWarning', { seq: 6, ts: 6, runId: 'run_42', type: 'runWarning', payload: { code: 'w' } })

    expect(seen).toEqual([
      { seq: 5, ts: 5, runId: 'run_42', type: 'testStarted', payload: { testIndex: 7 } },
      { seq: 6, ts: 6, runId: 'run_42', type: 'runWarning', payload: { code: 'w' } },
    ])
  })

  it('closes the source at runFinished — the run log is complete and the bus closed behind it', () => {
    openRunStream('run_42', {})
    const source = StubEventSource.instances[0]!
    expect(source.closed).toBe(false)

    source.emit('runFinished', { seq: 9, ts: 9, runId: 'run_42', type: 'runFinished', payload: {} })
    expect(source.closed).toBe(true)
  })

  it('returns the source so a caller can detach', () => {
    const source = openRunStream('run_42', {})
    expect(source).toBe(StubEventSource.instances[0] as unknown)
  })
})
