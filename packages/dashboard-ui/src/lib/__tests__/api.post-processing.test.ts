// @vitest-environment jsdom

// THE PAGE'S ONLY CHIP PRODUCER.
//
// WHAT THIS FILE BINDS. `fetchPostProcessing` is the one door the chips are ever painted from,
// and `watchPostProcessing` is the thing that decides WHEN to ask it again. D-17 is the law both
// exist to make structural: a pushed chip event is a TRIGGER and never a rendering, so the frame's
// own bytes must not be reachable from `onRead` at all. The bogus-envelope cell below feeds a
// fabricated `analysisCompleted` whose re-read still answers `running` and asserts the caller was
// handed `running` — a client that painted the envelope would answer `done` there.
//
// THE STREAM LIFECYCLE IS THE OTHER HALF, and it is the part a count assertion gets wrong. The
// dedicated stream only ever carries THIS process's own drain, so it is worth opening
// exactly while this process may still turn out to be the drainer — `disposition: 'drained'`, or no
// disposition yet, which in the D-13 flow is where the page ARRIVES (the viewer is moved on the
// `verdict` envelope, before `runFinished` is durable). The open decision is therefore re-evaluated
// on EVERY read, first or poll, and the source is constructed AT MOST ONCE for a watcher's life.
// Each cell below asserts the CONSTRUCTOR COUNT rather than "a source exists", because "opened
// again on the next poll" and "opened once" are indistinguishable from the second reading alone.
//
// EVERY CLOCK IS FAKE. The poll floor is 3 s; a cell that waited on a real one would be a sleep
// whose failure mode reads as a product defect.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostProcessingStatus } from '@vostride/agent-qa-schema'

import {
  POST_PROCESSING_CHIP_EVENTS,
  POST_PROCESSING_POLL_MS,
  fetchPostProcessing,
  isPostProcessingTerminal,
  watchPostProcessing,
  type PostProcessingRead,
} from '@/lib/api'

const RUN_ID = 'run_chip'

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

  /** A frame, exactly as the door writes it: the event name is the type, the data is JSON. */
  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) })
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

interface Answer {
  readonly status: number
  readonly body?: unknown
  readonly throws?: boolean
}

let answers: Answer[]
let urls: string[]
let originalFetch: typeof fetch

/** The LAST answer repeats — a poll asks the same door forever, and a queue that ran dry would 404. */
function nextAnswer(): Answer {
  if (answers.length === 0) throw new Error('no answer queued')
  return answers.length === 1 ? answers[0]! : answers.shift()!
}

function stubFetch(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const answer = nextAnswer()
    if (answer.throws === true) throw new TypeError('Failed to fetch')
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      statusText: `status ${String(answer.status)}`,
      json: async () => answer.body,
    } as unknown as Response
  }) as unknown as typeof fetch
}

function status(analysis: string, curation: string, notification?: unknown): PostProcessingStatus {
  return {
    runId: RUN_ID,
    chips: { analysis, curation },
    ...(notification === undefined ? {} : { notification }),
  } as unknown as PostProcessingStatus
}

/** A 200 body from the read route: the op result verbatim plus what the record said about it. */
function ok(body: Record<string, unknown>): Answer {
  return { status: 200, body }
}

const RUNNING_BODY = { status: status('running', 'pending'), failures: {} }
const TERMINAL_BODY = {
  status: status('complete', 'complete', {
    schemaVersion: 2,
    runId: RUN_ID,
    outcome: 'complete',
    verdictSummary: { total: 1, byClass: {} },
    stages: { analysis: { status: 'complete' }, curation: { status: 'complete', curated: 2, deprecated: 1 } },
  }),
  disposition: 'drained',
  failures: {},
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  answers = []
  urls = []
  originalFetch = globalThis.fetch
  StubEventSource.instances = []
  vi.stubGlobal('EventSource', StubEventSource)
  stubFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// fetchPostProcessing — the read, and the refusals it must not throw on
// ---------------------------------------------------------------------------

describe('fetchPostProcessing answers the route and never throws', () => {
  it('carries the route body through verbatim: status, disposition and per-stage failures', async () => {
    answers = [ok({
      status: status('failed', 'pending'),
      disposition: 'drained',
      failures: { analysis: { error: 'analysis stage blew up', willRetry: true } },
    })]
    const read = await fetchPostProcessing(RUN_ID)
    expect(read).toEqual({
      kind: 'read',
      status: status('failed', 'pending'),
      disposition: 'drained',
      failures: { analysis: { error: 'analysis stage blew up', willRetry: true } },
    })
  })

  it('keeps `failures` ABSENT when the route omitted it — absent is not the same claim as empty', async () => {
    answers = [ok({ status: status('pending', 'pending') })]
    const read = await fetchPostProcessing(RUN_ID)
    expect(read).toEqual({ kind: 'read', status: status('pending', 'pending') })
    expect(Object.keys(read)).not.toContain('failures')
  })

  it('answers `unavailable` naming the refusal AND its reason on a named 503', async () => {
    answers = [{ status: 503, body: { error: 'function_not_bound', reason: 'runs.postprocessing is not bound' } }]
    expect(await fetchPostProcessing(RUN_ID)).toEqual({
      kind: 'unavailable',
      error: 'function_not_bound',
      reason: 'runs.postprocessing is not bound',
    })
  })

  it('answers `unavailable` with the NAME alone when the refusal withheld its message', async () => {
    answers = [{ status: 500, body: { error: 'post_processing_unavailable', reason: 'SomeInternalError' } }]
    const read = await fetchPostProcessing(RUN_ID)
    expect(read).toEqual({
      kind: 'unavailable',
      error: 'post_processing_unavailable',
      reason: 'SomeInternalError',
    })
  })

  it('answers `route_unreachable` rather than rejecting when the door is not there at all', async () => {
    answers = [{ status: 0, throws: true }]
    expect(await fetchPostProcessing(RUN_ID)).toEqual({ kind: 'unavailable', error: 'route_unreachable' })
  })

  it('addresses the read door with the id encoded, and asks nothing else', async () => {
    answers = [ok({ status: status('pending', 'pending'), failures: {} })]
    await fetchPostProcessing('a/b')
    expect(urls).toEqual(['/api/runs/a%2Fb/post-processing'])
  })
})

// ---------------------------------------------------------------------------
// isPostProcessingTerminal — the server's rule, not a second one
// ---------------------------------------------------------------------------

describe('isPostProcessingTerminal mirrors the door', () => {
  it('a notification row is terminal whatever the chips still say', () => {
    expect(isPostProcessingTerminal(status('pending', 'running', { schemaVersion: 2 }))).toBe(true)
  })

  it('both chips settled is terminal; a single unsettled chip is not', () => {
    expect(isPostProcessingTerminal(status('complete', 'failed'))).toBe(true)
    expect(isPostProcessingTerminal(status('complete', 'running'))).toBe(false)
    expect(isPostProcessingTerminal(status('pending', 'pending'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// watchPostProcessing — the stream lifecycle and the poll floor
// ---------------------------------------------------------------------------

describe('watchPostProcessing reads once and decides both channels from that read', () => {
  it('hands the first read to `onRead` before any clock has moved', async () => {
    answers = [ok(RUNNING_BODY)]
    const reads: PostProcessingRead[] = []
    const dispose = watchPostProcessing(RUN_ID, { onRead: (read) => reads.push(read) })
    await settle()
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({ kind: 'read', status: status('running', 'pending') })
    dispose()
  })

  it('a first read that is already TERMINAL opens nothing and schedules nothing (the return visit)', async () => {
    answers = [ok(TERMINAL_BODY)]
    const dispose = watchPostProcessing(RUN_ID, { onRead: () => {} })
    await settle()
    expect(StubEventSource.instances).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(POST_PROCESSING_POLL_MS * 4)
    expect(urls).toHaveLength(1)
    dispose()
  })

  it('a first read with NO disposition opens exactly one source on the dedicated stream door', async () => {
    answers = [ok(RUNNING_BODY)]
    const dispose = watchPostProcessing(RUN_ID, { onRead: () => {} })
    await settle()
    expect(StubEventSource.instances.map((s) => s.url)).toEqual([
      `/api/runs/${RUN_ID}/post-processing/stream`,
    ])
    dispose()
  })

  it('listens for the six chip names AND the snapshot frame, and nothing else', async () => {
    answers = [ok(RUNNING_BODY)]
    const dispose = watchPostProcessing(RUN_ID, { onRead: () => {} })
    await settle()
    const listened = [...StubEventSource.instances[0]!.listeners.keys()].sort()
    expect(POST_PROCESSING_CHIP_EVENTS).toHaveLength(6)
    expect(listened).toEqual([...POST_PROCESSING_CHIP_EVENTS, 'snapshot'].sort())
    dispose()
  })

  it('no disposition then a poll saying `drained`: ONE source, constructed on the first read only', async () => {
    answers = [ok(RUNNING_BODY), ok({ ...RUNNING_BODY, disposition: 'drained' })]
    const dispose = watchPostProcessing(RUN_ID, { onRead: () => {} })
    await settle()
    expect(StubEventSource.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(POST_PROCESSING_POLL_MS)
    expect(StubEventSource.instances).toHaveLength(1)
    dispose()
  })

  it('no disposition then a poll saying `handedOff`: closed once, and never re-opened on later polls', async () => {
    answers = [ok(RUNNING_BODY), ok({ ...RUNNING_BODY, disposition: 'handedOff' })]
    const dispose = watchPostProcessing(RUN_ID, { onRead: () => {} })
    await settle()
    expect(StubEventSource.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(POST_PROCESSING_POLL_MS)
    expect(StubEventSource.instances[0]!.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(POST_PROCESSING_POLL_MS * 3)
    expect(StubEventSource.instances).toHaveLength(1)
    dispose()
  })

  it('a first read saying `drained` — the page opened after runFinished — opens exactly one', async () => {
    answers = [ok({ ...RUNNING_BODY, disposition: 'drained' })]
    const dispose = watchPostProcessing(RUN_ID, { onRead: () => {} })
    await settle()
    expect(StubEventSource.instances).toHaveLength(1)
    dispose()
  })

  it('a first read saying `handedOff` opens NO source, ever — this process is not the drainer', async () => {
    answers = [ok({ ...RUNNING_BODY, disposition: 'handedOff' })]
    const dispose = watchPostProcessing(RUN_ID, { onRead: () => {} })
    await settle()
    await vi.advanceTimersByTimeAsync(POST_PROCESSING_POLL_MS * 4)
    expect(StubEventSource.instances).toHaveLength(0)
    dispose()
  })

  it('a first read saying `detached` opens NO source, ever — nothing here will pump that chain', async () => {
    answers = [ok({ ...RUNNING_BODY, disposition: 'detached' })]
    const dispose = watchPostProcessing(RUN_ID, { onRead: () => {} })
    await settle()
    await vi.advanceTimersByTimeAsync(POST_PROCESSING_POLL_MS * 4)
    expect(StubEventSource.instances).toHaveLength(0)
    dispose()
  })

  it('polls the read door at POST_PROCESSING_POLL_MS while any chip is non-terminal', async () => {
    answers = [ok(RUNNING_BODY)]
    const dispose = watchPostProcessing(RUN_ID, { onRead: () => {} })
    await settle()
    expect(urls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(POST_PROCESSING_POLL_MS)
    expect(urls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(POST_PROCESSING_POLL_MS)
    expect(urls).toHaveLength(3)
    dispose()
  })

  it('a frame is a TRIGGER: a fabricated envelope changes no chip — the re-read does', async () => {
    answers = [ok(RUNNING_BODY)]
    const reads: PostProcessingRead[] = []
    const dispose = watchPostProcessing(RUN_ID, { onRead: (read) => reads.push(read) })
    await settle()
    StubEventSource.instances[0]!.emit('analysisCompleted', {
      runId: RUN_ID,
      seq: 9,
      type: 'analysisCompleted',
      payload: { stage: 'analysis', status: 'complete' },
    })
    await settle()
    expect(urls).toHaveLength(2)
    expect(reads).toHaveLength(2)
    expect(reads[1]).toMatchObject({ kind: 'read', status: status('running', 'pending') })
    dispose()
  })

  it('a snapshot frame triggers a re-read too — the frame body is never the paint source', async () => {
    answers = [ok(RUNNING_BODY)]
    const reads: PostProcessingRead[] = []
    const dispose = watchPostProcessing(RUN_ID, { onRead: (read) => reads.push(read) })
    await settle()
    StubEventSource.instances[0]!.emit('snapshot', { status: status('complete', 'complete') })
    await settle()
    expect(reads[1]).toMatchObject({ status: status('running', 'pending') })
    dispose()
  })

  it('frames arriving during an in-flight read COALESCE into exactly one follow-up read', async () => {
    answers = [ok(RUNNING_BODY)]
    const dispose = watchPostProcessing(RUN_ID, { onRead: () => {} })
    await settle()
    const source = StubEventSource.instances[0]!
    const before = urls.length
    source.emit('analysisStarted', {})
    source.emit('analysisCompleted', {})
    source.emit('curationStarted', {})
    await settle()
    await settle()
    // EXACTLY TWO, and the number is the claim: the first frame starts a read, the second and
    // third land while it is in flight and fold into ONE follow-up. Three reads would be fan-out;
    // one would mean a tick arriving mid-read was silently dropped.
    expect(urls.length - before).toBe(2)
    dispose()
  })

  it('the first TERMINAL read closes the source and stops the poll — both channels, one decision', async () => {
    answers = [ok(RUNNING_BODY), ok(TERMINAL_BODY)]
    const dispose = watchPostProcessing(RUN_ID, { onRead: () => {} })
    await settle()
    await vi.advanceTimersByTimeAsync(POST_PROCESSING_POLL_MS)
    expect(StubEventSource.instances[0]!.closed).toBe(true)
    const after = urls.length
    await vi.advanceTimersByTimeAsync(POST_PROCESSING_POLL_MS * 5)
    expect(urls).toHaveLength(after)
    dispose()
  })

  it('an `unavailable` read retries at the poll cadence and opens no stream', async () => {
    answers = [{ status: 503, body: { error: 'agent_host_unavailable' } }]
    const reads: PostProcessingRead[] = []
    const dispose = watchPostProcessing(RUN_ID, { onRead: (read) => reads.push(read) })
    await settle()
    expect(reads[0]).toEqual({ kind: 'unavailable', error: 'agent_host_unavailable' })
    expect(StubEventSource.instances).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(POST_PROCESSING_POLL_MS)
    expect(urls).toHaveLength(2)
    expect(StubEventSource.instances).toHaveLength(0)
    dispose()
  })

  it('the disposer closes the source, clears the interval and suppresses every later `onRead`', async () => {
    answers = [ok(RUNNING_BODY)]
    const reads: PostProcessingRead[] = []
    const dispose = watchPostProcessing(RUN_ID, { onRead: (read) => reads.push(read) })
    await settle()
    const source = StubEventSource.instances[0]!
    dispose()
    expect(source.closed).toBe(true)
    const after = urls.length
    source.emit('curationCompleted', {})
    await vi.advanceTimersByTimeAsync(POST_PROCESSING_POLL_MS * 4)
    expect(urls).toHaveLength(after)
    expect(reads).toHaveLength(1)
  })
})
