// @vitest-environment jsdom

// THE CLIENT HALF OF THE ATTACH CONTRACT (403-04 · INVK-05, D-13/D-15, RESEARCH Pitfall 3).
//
// 403-03 built the door: `Last-Event-ID` (or `?lastEventId=`) resolves to `subscribe(N + 1)`, a
// resume below the bus's replay window answers `410 { error: 'replay_floor', earliestAvailableSeq }`
// as JSON BEFORE any stream head, and a runId this process never started answers
// `404 { error: 'unknown_run' }`. Everything asserted here is that door's shipped wire shape read
// back from the browser side — the spellings are copied from `run-service-routes.ts` and
// `server/routes.ts`, not reconstructed from prose.
//
// WHY `classifyRunStreamClose` EXISTS AT ALL. `EventSource` flattens every one of those typed
// refusals into a bare `error` event with `readyState === CLOSED`. A page that branched on
// `readyState` would have exactly one word for "the run is over", "you resumed too far back" and
// "the network dropped" — and would show `lost` forever for two of the three. So the classifier
// ASKS THE DOOR with a plain `fetch`, and the four answers it can return are the four things a
// person needs told apart.
//
// THE URL IS THE OBSERVABLE. `EventSource` is stubbed with a capturing class and the constructed
// URL asserted as a whole string, not probed with `toContain`. `handle=0` and `lastEventId=0` are
// each their own cell because every truthiness spelling silently drops both — handle 0 is a real
// member and seq 0 is a real resume point ("replay from the very beginning").

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ApiError,
  classifyRunStreamClose,
  fetchLiveUrl,
  openRunStream,
} from '@/lib/api'

class StubEventSource {
  static instances: StubEventSource[] = []
  readonly listeners = new Map<string, Array<(event: Event) => void>>()
  closed = false
  readyState = 0

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
    this.readyState = 2
  }

  emit(type: string, data: unknown, lastEventId = '1'): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data), lastEventId })
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  /** The ONE thing a browser tells a page about a typed refusal: a bare, wordless error. */
  emitError(): void {
    this.readyState = 2
    for (const handler of this.listeners.get('error') ?? []) handler(new Event('error'))
  }
}

interface FetchCall {
  readonly url: string
  readonly accept: string | undefined
  readonly signalled: boolean
}

let fetchCalls: FetchCall[]
let originalFetch: typeof fetch

/** A `Response` double carrying a real `Headers`, because the classifier reads `content-type`. */
function response(init: { status: number; body?: unknown; contentType?: string; bodyThrows?: boolean }): Response {
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    statusText: `status ${String(init.status)}`,
    headers: new Headers(init.contentType === undefined ? {} : { 'content-type': init.contentType }),
    json: async () => {
      if (init.bodyThrows === true) throw new SyntaxError('Unexpected token')
      return init.body
    },
  } as unknown as Response
}

function stubFetch(answer: Response | Error): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {})
    fetchCalls.push({
      url: String(input),
      accept: headers.get('accept') ?? undefined,
      signalled: init?.signal !== undefined,
    })
    if (answer instanceof Error) throw answer
    return answer
  }) as unknown as typeof fetch
}

beforeEach(() => {
  fetchCalls = []
  originalFetch = globalThis.fetch
  StubEventSource.instances = []
  vi.stubGlobal('EventSource', StubEventSource)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// openRunStream: resume + onError
// ---------------------------------------------------------------------------

describe('openRunStream carries the resume point the door reads', () => {
  it('composes BOTH parameters, handle first: ?handle=0&lastEventId=8', () => {
    openRunStream('run_42', { handle: 0, lastEventId: 8 })
    expect(StubEventSource.instances[0]!.url).toBe('/api/run-stream/run_42?handle=0&lastEventId=8')
  })

  it('sends lastEventId=0 — seq 0 is "replay from the very beginning", not "no resume point"', () => {
    openRunStream('run_42', { lastEventId: 0 })
    expect(StubEventSource.instances[0]!.url).toBe('/api/run-stream/run_42?lastEventId=0')
  })

  it('sends handle=0 alone when no resume point was given', () => {
    openRunStream('run_42', { handle: 0 })
    expect(StubEventSource.instances[0]!.url).toBe('/api/run-stream/run_42?handle=0')
  })

  it('sends lastEventId alone when no handle was given', () => {
    openRunStream('run_42', { lastEventId: 8 })
    expect(StubEventSource.instances[0]!.url).toBe('/api/run-stream/run_42?lastEventId=8')
  })

  it('composes NO query at all for a bare attach — the door must see an absent parameter, not an empty one', () => {
    openRunStream('run_42', {})
    expect(StubEventSource.instances[0]!.url).toBe('/api/run-stream/run_42')
  })

  it('still encodes the run id with a resume point present', () => {
    openRunStream('run/../evil', { lastEventId: 3 })
    expect(StubEventSource.instances[0]!.url).toBe('/api/run-stream/run%2F..%2Fevil?lastEventId=3')
  })

  it('surfaces the source\'s error event through onError, with the source itself', () => {
    // The page needs the source to read `readyState` off it — that is what tells a retry from a
    // final close before the classifier is even asked.
    const seen: Array<{ type: string; sameSource: boolean; readyState: number }> = []
    const source = openRunStream('run_42', {
      onError: (event, errored) => seen.push({
        type: event.type,
        sameSource: errored === (source as unknown),
        readyState: (errored as unknown as StubEventSource).readyState,
      }),
    })
    StubEventSource.instances[0]!.emitError()
    expect(seen).toEqual([{ type: 'error', sameSource: true, readyState: 2 }])
  })

  it('does not require onError — a caller that omits it still attaches and streams', () => {
    openRunStream('run_42', { lastEventId: 1 })
    expect(() => StubEventSource.instances[0]!.emitError()).not.toThrow()
  })

  it('keeps delivering every envelope and still closes at runFinished with a resume point set', () => {
    const seen: unknown[] = []
    let finished: unknown
    openRunStream('run_42', {
      lastEventId: 4,
      onEvent: (envelope) => seen.push(envelope),
      onFinished: (envelope) => { finished = envelope },
    })
    const source = StubEventSource.instances[0]!
    source.emit('stepStarted', { seq: 5, ts: 5, runId: 'run_42', type: 'stepStarted', payload: {} })
    source.emit('runFinished', { seq: 6, ts: 6, runId: 'run_42', type: 'runFinished', payload: {} })

    expect(seen).toHaveLength(2)
    expect(finished).toMatchObject({ seq: 6, type: 'runFinished' })
    expect(source.closed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// fetchLiveUrl
// ---------------------------------------------------------------------------

describe('fetchLiveUrl mints through the local door', () => {
  const MINT = {
    liveUrl: 'http://127.0.0.1:3470/live/run_42#t=abc',
    expiresAt: 1_700_000_000,
    handle: 0,
    stream: { kind: 'cdp-screencast' },
  }

  it('GETs the live-url route for the DEFAULT handle 0 without being told to', () => {
    stubFetch(response({ status: 200, body: MINT }))
    void fetchLiveUrl('run_42')
    expect(fetchCalls[0]?.url).toBe('/api/runs/run_42/live-url?handle=0')
  })

  it('addresses a named handle', async () => {
    stubFetch(response({ status: 200, body: MINT }))
    await expect(fetchLiveUrl('run_42', 3)).resolves.toEqual(MINT)
    expect(fetchCalls[0]?.url).toBe('/api/runs/run_42/live-url?handle=3')
  })

  it('returns the door\'s body VERBATIM — the mint is the function layer\'s contract, not a second shape', () => {
    stubFetch(response({ status: 200, body: MINT }))
    return expect(fetchLiveUrl('run_42', 0)).resolves.toEqual(MINT)
  })

  it('encodes the run id', () => {
    stubFetch(response({ status: 200, body: MINT }))
    void fetchLiveUrl('run/../evil')
    expect(fetchCalls[0]?.url).toBe('/api/runs/run%2F..%2Fevil/live-url?handle=0')
  })

  it.each([
    [404, 'unknown_run'],
    [503, 'live_view_unavailable'],
    [500, 'live_url_mint_failed'],
    [400, 'invalid_handle'],
  ] as const)('throws ApiError carrying the door\'s own word on %i %s', async (status, word) => {
    stubFetch(response({ status, body: { error: word } }))
    await expect(fetchLiveUrl('run_42')).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ApiError)) return false
      if (err.status !== status) return false
      // The WORD, not a paraphrase: the page routes on it and 408's embed parses it.
      return err.message === word
    })
  })
})

// ---------------------------------------------------------------------------
// classifyRunStreamClose — Pitfall 3
// ---------------------------------------------------------------------------

describe('classifyRunStreamClose asks the door why the source closed', () => {
  it('reads a 410 replay_floor and carries the floor the door advertised', async () => {
    stubFetch(response({ status: 410, body: { error: 'replay_floor', earliestAvailableSeq: 40 } }))
    await expect(classifyRunStreamClose('run_42', { lastEventId: 3 }))
      .resolves.toEqual({ kind: 'replay_floor', earliestAvailableSeq: 40 })
  })

  it('carries a floor of zero — an absent floor and a floor at zero are different facts', async () => {
    stubFetch(response({ status: 410, body: { error: 'replay_floor', earliestAvailableSeq: 0 } }))
    await expect(classifyRunStreamClose('run_42', {}))
      .resolves.toEqual({ kind: 'replay_floor', earliestAvailableSeq: 0 })
  })

  it('degrades a 410 whose body carries no usable floor to `lost` rather than inventing one', async () => {
    // A recovery point the page then subtracts one from had better be a number the door SENT.
    stubFetch(response({ status: 410, body: { error: 'replay_floor' } }))
    await expect(classifyRunStreamClose('run_42', {})).resolves.toEqual({ kind: 'lost' })
  })

  it('reads a 404 unknown_run — the run is over and durable truth is elsewhere', async () => {
    stubFetch(response({ status: 404, body: { error: 'unknown_run' } }))
    await expect(classifyRunStreamClose('run_42', {})).resolves.toEqual({ kind: 'unknown_run' })
  })

  it('answers `reattach` when the door is willing to stream again', async () => {
    stubFetch(response({ status: 200, contentType: 'text/event-stream' }))
    await expect(classifyRunStreamClose('run_42', { handle: 0, lastEventId: 8 }))
      .resolves.toEqual({ kind: 'reattach' })
  })

  it('tolerates the charset the door actually sends on its stream head', async () => {
    stubFetch(response({ status: 200, contentType: 'text/event-stream; charset=utf-8' }))
    await expect(classifyRunStreamClose('run_42', {})).resolves.toEqual({ kind: 'reattach' })
  })

  it('does NOT answer `reattach` for a 200 that is not a stream', async () => {
    // A dev proxy, a captive portal or a rewritten route can answer 200 text/html. Treating that
    // as "the stream is fine" would loop a page forever against a door that is not there.
    stubFetch(response({ status: 200, contentType: 'text/html', body: {} }))
    await expect(classifyRunStreamClose('run_42', {})).resolves.toEqual({ kind: 'lost' })
  })

  it('answers `lost` on a network failure and NEVER throws — this runs from an error handler', async () => {
    stubFetch(new TypeError('Failed to fetch'))
    await expect(classifyRunStreamClose('run_42', {})).resolves.toEqual({ kind: 'lost' })
  })

  it('answers `lost` on an unmodelled status', async () => {
    stubFetch(response({ status: 503, body: { error: 'live_view_unavailable' } }))
    await expect(classifyRunStreamClose('run_42', {})).resolves.toEqual({ kind: 'lost' })
  })

  it('answers `lost` when the refusal body is not JSON at all', async () => {
    stubFetch(response({ status: 404, bodyThrows: true }))
    await expect(classifyRunStreamClose('run_42', {})).resolves.toEqual({ kind: 'lost' })
  })

  it('answers `lost` for a 404 whose word is not the door\'s — a route that 404s is not a run that ended', async () => {
    stubFetch(response({ status: 404, body: { error: 'unknown_route' } }))
    await expect(classifyRunStreamClose('run_42', {})).resolves.toEqual({ kind: 'lost' })
  })

  it('asks THE SAME URL openRunStream opened, with an Accept the door answers JSON to', async () => {
    // The whole classification depends on asking the door the same question the source asked. A
    // different handle or a different resume point is a different question with a different answer.
    stubFetch(response({ status: 410, body: { error: 'replay_floor', earliestAvailableSeq: 9 } }))
    await classifyRunStreamClose('run_42', { handle: 0, lastEventId: 8 })

    openRunStream('run_42', { handle: 0, lastEventId: 8 })
    expect(fetchCalls[0]?.url).toBe(StubEventSource.instances[0]!.url)
    // ABSOLUTE, beside the differential: a comparison of two things built by one helper cannot
    // see a defect they share, so the expected string is also written out here.
    expect(fetchCalls[0]?.url).toBe('/api/run-stream/run_42?handle=0&lastEventId=8')
    expect(fetchCalls[0]?.accept).toBe('application/json')
  })

  it('passes an abort signal, so a reattach probe does not leave a stream body hanging', async () => {
    stubFetch(response({ status: 200, contentType: 'text/event-stream' }))
    await classifyRunStreamClose('run_42', {})
    expect(fetchCalls[0]?.signalled).toBe(true)
  })

  it('takes no options at all — the bare-attach probe is the common case after a close', async () => {
    stubFetch(response({ status: 404, body: { error: 'unknown_run' } }))
    await expect(classifyRunStreamClose('run_42')).resolves.toEqual({ kind: 'unknown_run' })
    expect(fetchCalls[0]?.url).toBe('/api/run-stream/run_42')
  })
})

// ---------------------------------------------------------------------------
// The end-to-end shape a page in 403-05 composes
// ---------------------------------------------------------------------------

describe('the recovery the refusal advertises is the one this client takes', () => {
  it('re-attaches at earliestAvailableSeq - 1, the subtraction most likely to go wrong', async () => {
    stubFetch(response({ status: 410, body: { error: 'replay_floor', earliestAvailableSeq: 40 } }))
    const reason = await classifyRunStreamClose('run_42', { handle: 2, lastEventId: 3 })
    expect(reason).toEqual({ kind: 'replay_floor', earliestAvailableSeq: 40 })

    // The page's own arithmetic, written here so a change to it reds a cell rather than a viewer.
    const resumeAt = reason.kind === 'replay_floor' ? reason.earliestAvailableSeq - 1 : undefined
    expect(resumeAt).toBe(39)

    openRunStream('run_42', { handle: 2, lastEventId: resumeAt })
    expect(StubEventSource.instances[0]!.url).toBe('/api/run-stream/run_42?handle=2&lastEventId=39')
  })
})
