// The LOCAL door onto the run event stream.
//
// WHAT "THIN CLIENT" HAS TO MEAN HERE, AND WHY A HAPPY-PATH CELL CANNOT SAY IT. D-01 keeps the
// dashboard on the IN-PROCESS door, so a cell that opens `/api/run-stream/:runId` and gets events
// back cannot tell "the local door consumes the contract" apart from "the local door grew its own
// stream". Both serve envelopes. The discriminating measurement is a DIFFERENTIAL: the same
// planted session, driven through the AUTHED door and the LOCAL door over a corpus of requests
// that includes every refusal class, with the two responses compared BYTE FOR BYTE. A second
// spelling in `routes.ts` would have to reproduce the framing, the filter, the repeated-parameter
// join, the two typed 400s, the pre-stream ordering and the heartbeat comment exactly — and the
// first one it got wrong reds a cell naming which.
//
// THE SOURCE CELL AT THE BOTTOM CARRIES ITS OWN KNOWN-POSITIVE CONTROL, deliberately (WINDOWS
// #253). "No SSE frame formatting appears in the handler body" is satisfied for free by an
// extractor that returns nothing, so the SAME predicate is also run over a body where every
// pattern must match. A predicate that cannot see frame formatting where it lives proves nothing
// about not seeing it here.
//
// THAT CONTROL IS THE RUN-SERVICE MODULE, NOT A SECOND HANDLER IN THIS FILE.
// It used to be the retired live-event route — a second SSE spelling that happened to sit beside
// the one under test — and this header went on describing it after 405-07 deleted the route,
// which is the stale-claim failure WINDOWS #253 exists to prevent, one layer up. The control is
// now `run-service/run-service-routes.ts`: the module this handler DELEGATES to, and the one place
// the frames are actually written. See the source cell's own note for why that is the stronger
// control rather than merely the surviving one.
//
// THE PRODUCTION-FRAME CELLS DRIVE `startServer`, not the router alone. The router can only be
// reached with an attach port somebody threaded; the thing that threads it is `server.ts`. A suite
// that only mounted `createRouter` would prove the route works and leave the wiring unmeasured —
// the failure mode WINDOWS' "green that never ran" names.

import { readFile } from 'node:fs/promises'
import {
  createServer,
  get as httpGet,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'

import { createRunEventBus } from '@vostride/agent-qa-runner'
import {
  RUN_SERVICE_CONTRACT_VERSION,
  RunEventEnvelopeSchema,
  RunsLiveUrlResultSchema,
  type RunEventEnvelope,
  type RunsLiveUrlResult,
  type RunServiceReadiness,
  type RunSession,
  type RunStartAcknowledgement,
  CURRENT_BUS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardDatabase } from '../db/database.js'
import {
  createRunServiceRoutes,
  serveRunEventStream,
  type RunServicePorts,
} from '../run-service/run-service-routes.js'
import { createRouter } from '../server/routes.js'
import { startServer } from '../server/server.js'

/**
 * THE CORE, WRAPPED IN A SPY THAT DELEGATES TO IT (not replaced by one).
 *
 * The differential below proves the two doors AGREE; it cannot prove there is ONE implementation,
 * because a private copy of the serving body produces byte-identical output — 402-05 measured
 * exactly that shape for the readiness predicate (its mutation M9), and only a reference-level pin
 * saw it. This is that pin for a function that is CALLED rather than published: `routes.ts` reads
 * `serveRunEventStream` off this module's namespace, so a handler that called a copy — in this
 * file, in a sibling module, anywhere — would leave the spy unfired.
 *
 * `createRunServiceRoutes` is unaffected: its own call binds lexically inside the real module, so
 * the authed side of every differential is the shipped path.
 */
vi.mock('../run-service/run-service-routes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../run-service/run-service-routes.js')>()
  return { ...actual, serveRunEventStream: vi.fn(actual.serveRunEventStream) }
})


/**
 * The announced roster — non-contiguous and not 0-based, on 402-04's own reasoning.
 *
 * With members 0 and 1 a correct filter is indistinguishable from one that returns everything,
 * one that is off by one, and one keyed on array position rather than on the stamped `testIndex`.
 */
const ROSTER = [3, 7, 11] as const

/** An interleaved feed over three concurrent members, with chosen (gappy) seqs. */
const FEED: readonly RunEventEnvelope[] = Object.freeze([
  { seq: 1, ts: 1, runId: 'r_local', type: 'runStarted', payload: { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 3, handles: [...ROSTER] } },
  { seq: 3, ts: 3, runId: 'r_local', type: 'testStarted', payload: { testId: 'a', testIndex: 3, name: 'a' } },
  { seq: 5, ts: 5, runId: 'r_local', type: 'testStarted', payload: { testId: 'b', testIndex: 7, name: 'b' } },
  { seq: 8, ts: 8, runId: 'r_local', type: 'stepStarted', payload: { testIndex: 3, stepIndex: 0, stepText: 'a0' } },
  { seq: 13, ts: 13, runId: 'r_local', type: 'testStarted', payload: { testId: 'c', testIndex: 11, name: 'c' } },
  { seq: 14, ts: 14, runId: 'r_local', type: 'stepStarted', payload: { testIndex: 7, stepIndex: 0, stepText: 'b0' } },
  { seq: 17, ts: 17, runId: 'r_local', type: 'runWarning', payload: { code: 'w', message: 'w' } },
  { seq: 21, ts: 21, runId: 'r_local', type: 'stepStarted', payload: { testIndex: 11, stepIndex: 0, stepText: 'c0' } },
  { seq: 22, ts: 22, runId: 'r_local', type: 'testFinished', payload: { testId: 'a', testIndex: 3, outcome: 'passed' } },
  { seq: 25, ts: 25, runId: 'r_local', type: 'testFinished', payload: { testId: 'b', testIndex: 7, outcome: 'passed' } },
  { seq: 26, ts: 26, runId: 'r_local', type: 'testFinished', payload: { testId: 'c', testIndex: 11, outcome: 'failed' } },
  { seq: 30, ts: 30, runId: 'r_local', type: 'verdict', payload: { verdict: 'failed' } },
  { seq: 31, ts: 31, runId: 'r_local', type: 'runFinished', payload: { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: 31 } },
] as unknown as readonly RunEventEnvelope[])

/** The run-scoped seqs of the feed above, and the per-handle member-scoped ones. */
const RUN_SCOPED_SEQS = [1, 17, 30, 31]
const MEMBER_SEQS: Readonly<Record<number, readonly number[]>> = {
  3: [3, 8, 22],
  7: [5, 14, 25],
  11: [13, 21, 26],
}

function sessionOverFeed(id: string): RunSession {
  return {
    id: id as RunSession['id'],
    status: 'running',
    executionContext: 'local-headless' as RunSession['executionContext'],
    // `fromSeq` is HONOURED, which is what a real bus does and what the resume rows below
    // are about. A planted session that ignored it would make every `?lastEventId=` row in the
    // corpus agree on both doors while measuring nothing about the resume point — two doors both
    // replaying from 1 are byte-identical too.
    subscribe(fromSeq, handler) {
      for (const envelope of FEED) {
        if (envelope.seq >= fromSeq) handler(envelope)
      }
      return () => undefined
    },
    // this feed carries EVENTS, not frames. The planted session declares no stream and
    // hands out no frame subscription, which is the honest answer for a fixture with no browser.
    subscribeFrames() { return undefined },
    streamCapabilityOf() { return { kind: 'none' } },
    cancel() { /* nothing to cancel on a planted session */ },
    done: Promise.resolve({ verdict: 'failed' } as never),
  }
}

/**
 * A SECOND planted run, backed by a REAL `createRunEventBus` whose window has evicted seqs 1-5.
 *
 * `windowMaxEvents: 3` over eight publishes retains 6, 7, 8, so `earliestRetainedSeq()` is 6 and
 * `subscribe(n)` for n < 6 raises the bus's OWN `ReplayIncompleteError`. A hand-built `subscribe`
 * that threw a shaped error would pin THIS FILE'S idea of the floor refusal; the whole point of
 * the 410 row is that the number on the wire is the producer's.
 */
const FLOOR_EARLIEST_SEQ = 6

function floorSession(): RunSession {
  const bus = createRunEventBus({
    runId: 'r_floor',
    windowMaxEvents: 3,
    // A FROZEN CLOCK AND A DEAD SCHEDULER, deliberately. `ts` is stamped from `timer.now()`, so a
    // wall clock makes every envelope's bytes a function of WHEN the fixture was built — and the
    // two-door differential builds one session per door. That is not a difference between the
    // doors, it is a difference between two milliseconds, and it made this row fail intermittently
    // before the clock was pinned. The dead scheduler is the same discipline for the heartbeat: a
    // fixture whose retained window can grow on a timer is a fixture whose floor moves.
    timer: { now: () => 1_700_000_000_000, schedule: () => () => undefined },
  })
  bus.publish('runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 3, handles: [...ROSTER] })
  bus.publish('testStarted', { testId: 'a', testIndex: 3, name: 'a' })
  bus.publish('testStarted', { testId: 'b', testIndex: 7, name: 'b' })
  bus.publish('testStarted', { testId: 'c', testIndex: 11, name: 'c' })
  bus.publish('runWarning', { code: 'w', message: 'w' })
  bus.publish('stepStarted', { testIndex: 3, stepIndex: 0, stepText: 'a0' })
  bus.publish('stepStarted', { testIndex: 7, stepIndex: 0, stepText: 'b0' })
  bus.publish('runFinished', { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: 8 })
  return {
    id: 'r_floor' as RunSession['id'],
    status: 'failed',
    executionContext: 'local-headless' as RunSession['executionContext'],
    subscribe: (fromSeq, handler) => bus.subscribe(fromSeq, handler),
    subscribeFrames() { return undefined },
    streamCapabilityOf() { return { kind: 'none' } },
    cancel() { /* the bus is already closed for this fixture */ },
    done: Promise.resolve({ verdict: 'failed' } as never),
  }
}

/** THE ONE ATTACH PORT both doors are given — the same function object, by construction. */
function attachPort(runId: string): RunSession | undefined {
  if (runId === 'r_local') return sessionOverFeed('r_local')
  if (runId === 'r_floor') return floorSession()
  return undefined
}

/**
 * A MINT WHOSE TOKEN AND EXPIRY ARE FRESH ON EVERY CALL — one instance per door.
 *
 * DELIBERATELY NOT ONE SHARED FUNCTION. Two doors calling one planted mint would answer
 * byte-identical bodies for free, and the `liveUrl` parity row would then be satisfied by the
 * fixture rather than by the doors. `runs.liveurl` mints a fresh HMAC-signed token and a fresh
 * expiry per call, so the honest fixture does too — which is exactly why that row's comparison is
 * relaxed from byte-identity to SHAPE-identity, and why a cell below asserts the two tokens
 * actually differ. A redaction that redacted nothing would be the vacuous half of this row.
 */
function freshMint(seed: string): (runId: string, handle: number) => Promise<RunsLiveUrlResult> {
  let minted = 0
  return async (runId, handle) => {
    minted += 1
    if (attachPort(runId) === undefined) {
      throw Object.assign(new Error(`unknown_run: ${runId}`), { name: 'UnknownRunError' })
    }
    return {
      liveUrl: `http://127.0.0.1:0/live/${runId}#v2.${seed}${'x'.repeat(minted)}`,
      expiresAt: 1_700_000_000_000 + minted,
      handle,
      stream: { kind: 'none' as const },
    }
  }
}

const READINESS: RunServiceReadiness = {
  service: 'up',
  hostComposed: true,
  contractVersion: RUN_SERVICE_CONTRACT_VERSION,
}

const ACK: RunStartAcknowledgement = {
  runId: 'r_local' as RunStartAcknowledgement['runId'],
  scope: 'main' as unknown as RunStartAcknowledgement['scope'],
  executionContext: 'local-headless' as RunStartAcknowledgement['executionContext'],
  buildOrdinal: 0,
  startedAt: 0,
  testCount: 3,
}

function servicePorts(options: { readonly mint?: boolean } = {}): RunServicePorts {
  const mint = options.mint === true ? freshMint('authed-') : undefined
  return {
    // no `verifyBearer` — the run service is tokenless.
    invokeRunStart: async () => ACK,
    attach: attachPort,
    readiness: () => READINESS,
    // 403-03 (D-03, Q3): a fixture that composed no live view HAS no live view, and the honest
    // answer to a mint request is 503 by name. Never a stub that mints — a fabricated token would
    // make every cell downstream of it a claim about this file's idea of a credential. The parity
    // rows opt IN to a fresh-token mint, which is the shape production has.
    mintLiveUrl: mint === undefined
      ? () => Promise.reject(
        Object.assign(new Error('no live-view port is bound on this fixture'), {
          name: 'LiveViewUnavailableError',
        }),
      )
      : async ({ runId, handle }) => mint(runId, handle),
  }
}

function mockDb(): DashboardDatabase {
  return { getRuns: () => [] } as unknown as DashboardDatabase
}

const servers: Server[] = []
const closers: Array<() => void> = []

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void

async function listen(handler: RequestHandler): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    await new Promise<void>((closed) => server?.close(() => closed()))
  }
  while (closers.length > 0) closers.pop()?.()
})

interface Capture {
  readonly status: number
  readonly contentType: string | null
  readonly body: string
}

/** Read a whole response body. The planted feed ends at `runFinished`, so a stream terminates. */
async function read(url: string, headers: Record<string, string> = {}): Promise<Capture> {
  const response = await fetch(url, { headers })
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  }
}

const idsOf = (body: string): number[] =>
  [...body.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]))
const datasOf = (body: string): string[] =>
  [...body.matchAll(/^data: (.+)$/gmu)].map((match) => match[1] ?? '')
const eventsOf = (body: string): string[] =>
  [...body.matchAll(/^event: (.+)$/gmu)].map((match) => match[1] ?? '')

/** Mount the LOCAL door on the exported router, with the attach port threaded in. */
async function localDoor(options: { readonly mint?: boolean } = {}): Promise<string> {
  return listen(createRouter({
    db: mockDb(),
    runServiceAttach: attachPort,
    ...(options.mint === true ? { mintLiveUrl: freshMint('local-') } : {}),
  }))
}

/** Mount the AUTHED door on the same planted attach port. */
async function authedDoor(options: { readonly mint?: boolean } = {}): Promise<string> {
  return listen(createRunServiceRoutes(servicePorts(options)))
}

/**
 * THE DIFFERENTIAL CORPUS — every request class the stream core decides, including the refusals.
 *
 * `[label, query]`, applied to run `r_local` unless the label says otherwise. A second spelling of
 * the stream in `routes.ts` would have to reproduce every one of these byte for byte.
 */
type CorpusRow = readonly [string, string, string, Record<string, string>?]

const CORPUS: readonly CorpusRow[] = Object.freeze([
  ['the firehose', 'r_local', ''],
  ['handle 3', 'r_local', '?handle=3'],
  ['handle 7', 'r_local', '?handle=7'],
  ['handle 11', 'r_local', '?handle=11'],
  ['an unrelated parameter does not filter', 'r_local', '?since=7&format=json'],
  ['a malformed handle', 'r_local', '?handle=notanumber'],
  ['a zero-padded handle', 'r_local', '?handle=07'],
  ['a negative handle', 'r_local', '?handle=-1'],
  ['an empty handle', 'r_local', '?handle='],
  ['a REPEATED handle parameter', 'r_local', '?handle=1&handle=2'],
  ['a well-formed handle no member answers to', 'r_local', '?handle=4'],
  ['an unknown run', 'r_nope', ''],
  ['an unknown run WITH a handle', 'r_nope', '?handle=3'],
  // ---- 403-03: the resume point, on both doors -----------------------
  ['resume after 8', 'r_local', '?lastEventId=8'],
  ['resume after 8 on handle 7', 'r_local', '?handle=7&lastEventId=8'],
  ['resume via the HEADER', 'r_local', '', { 'Last-Event-ID': '8' }],
  ['the header WINS over the query', 'r_local', '?lastEventId=3', { 'Last-Event-ID': '8' }],
  ['resume at the exact last seq', 'r_local', '?lastEventId=31'],
  ['resume past the last seq', 'r_local', '?lastEventId=99'],
  ['a malformed lastEventId', 'r_local', '?lastEventId=abc'],
  ['a negative lastEventId', 'r_local', '?lastEventId=-1'],
  ['a zero-padded lastEventId', 'r_local', '?lastEventId=07'],
  ['a fractional lastEventId', 'r_local', '?lastEventId=1.5'],
  ['an empty lastEventId', 'r_local', '?lastEventId='],
  ['a REPEATED lastEventId', 'r_local', '?lastEventId=1&lastEventId=7'],
  ['a MALFORMED header beside a valid query', 'r_local', '?lastEventId=8', { 'Last-Event-ID': 'abc' }],
  // ---- the floor, off a REAL bus whose window evicted seqs 1-5 --------------------------------
  ['the floor run, whole', 'r_floor', ''],
  ['resume BELOW the floor', 'r_floor', '?lastEventId=2'],
  ['resume AT the floor', 'r_floor', '?lastEventId=5'],
  ['a handle on a deep resume past seq 1\'s eviction', 'r_floor', '?handle=7&lastEventId=5'],
  ['a handle on a resume the floor refuses', 'r_floor', '?handle=7&lastEventId=2'],
] as const)

describe('the local run-stream door serves the SAME stream core the authed door serves', () => {
  // The row rides as ONE argument so `it.each`'s tuple widening cannot turn the optional header
  // map into `string | Record<…> | undefined`; the label is repeated for the test name only.
  it.each(CORPUS.map((row) => [row[0], row] as const))(
    '%s answers byte-identically on both doors',
    async (_label, [, runId, query, headers]) => {
    const local = await localDoor()
    const authed = await authedDoor()

    const fromLocal = await read(`${local}/api/run-stream/${runId}${query}`, { ...headers })
    const fromAuthed = await read(`${authed}/run/${runId}/events${query}`, { ...headers })

    expect(fromLocal.status).toBe(fromAuthed.status)
    expect(fromLocal.contentType).toBe(fromAuthed.contentType)
    expect(fromLocal.body).toBe(fromAuthed.body)
    },
  )

  it('the corpus is NOT vacuous — it spans streams and refusals, and the bodies are non-empty', async () => {
    // A differential over a corpus that produced one status, or empty bodies on both sides, would
    // be satisfied by two doors that both answered nothing. This cell is what stops that reading.
    const local = await localDoor()
    const captures = await Promise.all(
      CORPUS.map(async ([, runId, query, headers]) =>
        read(`${local}/api/run-stream/${runId}${query}`, { ...headers })),
    )
    expect(new Set(captures.map((capture) => capture.status))).toEqual(new Set([200, 400, 404, 410]))
    // The 200 with an EMPTY body is a legal answer now (a resume past the end writes the preamble
    // and closes), so the non-emptiness claim is made over the rows that carry something.
    expect(captures.every((capture) => capture.body.length > 0)).toBe(true)
    expect(captures.filter((capture) => capture.status === 200).length).toBeGreaterThanOrEqual(8)
    expect(CORPUS.length).toBeGreaterThanOrEqual(30)
  })

  it('the resume rows carry the SEQS the resume point implies, not the whole feed', async () => {
    // THE ANTI-VACUITY HALF OF THE PARITY ROWS. Two doors that both ignored `lastEventId` are
    // byte-identical, so the differential alone cannot see a resume that never happened. These are
    // the absolute expectations the corpus rows are compared against.
    const local = await localDoor()
    const expectations: readonly (readonly [string, Record<string, string>, number[]])[] = [
      ['?lastEventId=8', {}, [13, 14, 17, 21, 22, 25, 26, 30, 31]],
      ['?handle=7&lastEventId=8', {}, [14, 17, 25, 30, 31]],
      ['', { 'Last-Event-ID': '8' }, [13, 14, 17, 21, 22, 25, 26, 30, 31]],
      ['?lastEventId=3', { 'Last-Event-ID': '8' }, [13, 14, 17, 21, 22, 25, 26, 30, 31]],
      ['?lastEventId=30', {}, [31]],
      ['?lastEventId=31', {}, []],
      ['?lastEventId=99', {}, []],
    ]
    for (const [query, headers, ids] of expectations) {
      const stream = await read(`${local}/api/run-stream/r_local${query}`, headers)
      expect(stream.status, `${query} ${JSON.stringify(headers)}`).toBe(200)
      expect(idsOf(stream.body), `${query} ${JSON.stringify(headers)}`).toEqual(ids)
    }
    // And the firehose still carries everything, so the expectations above are narrowings of a
    // stream that demonstrably had more in it.
    expect(idsOf((await read(`${local}/api/run-stream/r_local`)).body))
      .toEqual(FEED.map((envelope) => envelope.seq))
  })

  it('the floor row answers the PRODUCER\'s number, and the recovery it advertises is reachable', async () => {
    // THE TWO-SIDED HALF. A refusal whose advertised recovery point cannot be reached is worse
    // than no refusal: it tells the caller to do something that fails the same way. Both doors are
    // driven through the WHOLE recovery, not just the refusal.
    for (const [label, origin, path, headers] of [
      ['local', await localDoor(), '/api/run-stream/r_floor', {}],
      ['authed', await authedDoor(), '/run/r_floor/events', {}],
    ] as const) {
      const refused = await read(`${origin}${path}?lastEventId=2`, { ...headers })
      expect(refused.status, label).toBe(410)
      expect(refused.contentType, label).toContain('application/json')
      expect(refused.contentType, label).not.toContain('text/event-stream')
      expect(JSON.parse(refused.body), label)
        .toEqual({ error: 'replay_floor', earliestAvailableSeq: FLOOR_EARLIEST_SEQ })
      const floor = (JSON.parse(refused.body) as { earliestAvailableSeq: number })
        .earliestAvailableSeq
      expect(floor, label).toBe(FLOOR_EARLIEST_SEQ)

      const recovered = await read(
        `${origin}${path}?lastEventId=${String(floor - 1)}`,
        { ...headers },
      )
      expect(recovered.status, `${label}: the advertised recovery point must be reachable`).toBe(200)
      expect(idsOf(recovered.body), label).toEqual([6, 7, 8])
      // …and the deep-resume handle filter still filters: seq 6 is member 3's.
      const filtered = await read(
        `${origin}${path}?handle=7&lastEventId=${String(floor - 1)}`,
        { ...headers },
      )
      expect(idsOf(filtered.body), `${label}: the filter survives a deep resume`).toEqual([7, 8])
    }
  })
})

/**
 * THE ONE ROW WHERE BYTE-IDENTITY IS RELAXED TO SHAPE-IDENTITY, and why.
 *
 * Every other row compares BYTES because every other answer is a function of the request and the
 * run. A mint is not: `runs.liveurl` produces a fresh HMAC-signed token and a fresh expiry on every
 * call, so two doors minting the same credential for the same run answer DIFFERENT bytes and must.
 * Redacting those two fields to their shapes is what leaves the comparison a claim about the door
 * rather than about the clock.
 *
 * WHAT IS NOT RELAXED: the status, the content type, `handle` and `stream` are compared byte for
 * byte, and the cell below asserts the two tokens actually DIFFER — a redaction that redacted
 * nothing would make this row pass for the wrong reason.
 */
function liveUrlShapeOf(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (typeof parsed.liveUrl !== 'string') return raw
  const [base = '', fragment = ''] = parsed.liveUrl.split('#')
  const version = fragment.split('.')[0] ?? ''
  return JSON.stringify({
    ...parsed,
    liveUrl: `<origin>${new URL(base).pathname}#${version}.<token>`,
    expiresAt: typeof parsed.expiresAt === 'number' ? '<number>' : parsed.expiresAt,
  })
}

const tokenOf = (raw: string): string =>
  ((JSON.parse(raw) as { liveUrl?: string }).liveUrl ?? '').split('#')[1] ?? ''

const LIVE_URL_CORPUS: readonly (readonly [string, string, string])[] = Object.freeze([
  ['the default handle', 'r_local', ''],
  ['an explicit handle', 'r_local', '?handle=7'],
  ['a malformed handle', 'r_local', '?handle=notanumber'],
  ['a REPEATED handle', 'r_local', '?handle=1&handle=2'],
  ['an unknown run', 'r_nope', ''],
] as const)

describe('both doors mint the SAME liveUrl — shape-identically, and refuse identically', () => {
  it.each(LIVE_URL_CORPUS)('%s answers identically on both doors', async (_label, runId, query) => {
    const local = await localDoor({ mint: true })
    const authed = await authedDoor({ mint: true })

    const fromLocal = await read(`${local}/api/runs/${runId}/live-url${query}`)
    const fromAuthed = await read(`${authed}/run/${runId}/live-url${query}`)

    expect(fromLocal.status).toBe(fromAuthed.status)
    expect(fromLocal.contentType).toBe(fromAuthed.contentType)
    expect(liveUrlShapeOf(fromLocal.body)).toBe(liveUrlShapeOf(fromAuthed.body))
  })

  it('the relaxation is LOAD-BEARING — the two doors really did mint different tokens', async () => {
    const local = await localDoor({ mint: true })
    const authed = await authedDoor({ mint: true })
    const fromLocal = await read(`${local}/api/runs/r_local/live-url`)
    const fromAuthed = await read(`${authed}/run/r_local/live-url`)

    expect(fromLocal.body, 'a byte comparison here would be satisfied by a fixture, not a door')
      .not.toBe(fromAuthed.body)
    expect(tokenOf(fromLocal.body).length).toBeGreaterThan(0)
    expect(tokenOf(fromAuthed.body)).not.toBe(tokenOf(fromLocal.body))
    // What IS byte-identical: everything a mint does not freshly generate.
    for (const body of [fromLocal.body, fromAuthed.body]) {
      const parsed = RunsLiveUrlResultSchema.parse(JSON.parse(body))
      expect(parsed.handle).toBe(0)
      expect(parsed.stream).toEqual({ kind: 'none' })
    }
  })

  // RE-SPELLED 2026-10-01 from 'the local door needs NO credential and the
  // authed door needs one — the only difference'. Neither door needs a credential now; both refuse a
  // cross-site mint with the same same-site guard, and both mint for a local caller.
  it('neither door needs a credential, and both refuse a cross-site mint the same way', async () => {
    const authed = await authedDoor({ mint: true })
    expect((await read(`${authed}/run/r_local/live-url`)).status).toBe(200)
    const refused = await read(`${authed}/run/r_local/live-url`, { Origin: 'https://evil.example' })
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body)).toEqual({ error: 'cross_site_refused' })

    const local = await localDoor({ mint: true })
    expect((await read(`${local}/api/runs/r_local/live-url`)).status).toBe(200)
    const localRefused = await read(`${local}/api/runs/r_local/live-url`, { Origin: 'https://evil.example' })
    expect(localRefused.status).toBe(403)
    expect(JSON.parse(localRefused.body)).toEqual({ error: 'cross_site_refused' })
  })

  it('the liveUrl corpus is not vacuous — it spans a mint, two refusals and an unknown run', async () => {
    const local = await localDoor({ mint: true })
    const captures = await Promise.all(
      LIVE_URL_CORPUS.map(async ([, runId, query]) =>
        read(`${local}/api/runs/${runId}/live-url${query}`)),
    )
    expect(new Set(captures.map((capture) => capture.status))).toEqual(new Set([200, 400, 404]))
    expect(captures.every((capture) => capture.body.length > 0)).toBe(true)
  })
})

describe('the local door CALLS the exported core — one implementation, not two that agree', () => {
  it('reaches serveRunEventStream itself, with the raw handle and the injected attach port', async () => {
    const core = vi.mocked(serveRunEventStream)
    core.mockClear()

    const origin = await localDoor()
    const stream = await read(`${origin}/api/run-stream/r_local?handle=7`)
    expect(stream.status).toBe(200)

    expect(core).toHaveBeenCalledTimes(1)
    const deps = core.mock.calls[0]![2]
    expect(deps.runId).toBe('r_local')
    // The RAW parameter, unparsed — the core owns the parse, and a handler that pre-parsed it
    // would be the second spelling this cell exists to refuse.
    expect(deps.handleParam).toBe('7')
    // ONE SESSION REGISTRY, TWO DOORS — by reference, not by equality.
    expect(deps.attach).toBe(attachPort)
  })

  it('hands the PRODUCTION frame\'s local door the very port `runService.attach` carries', async () => {
    const core = vi.mocked(serveRunEventStream)
    core.mockClear()

    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const ports = servicePorts()
    const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, runService: ports })
    closers.push(started.close)
    const port = (started.server.address() as AddressInfo).port

    await getThroughServer(port, '/api/run-stream/r_local')

    expect(core).toHaveBeenCalledTimes(1)
    expect(core.mock.calls[0]![2].attach).toBe(ports.attach)
  })
})

describe('the local door serves the frozen envelope vocabulary', () => {
  it('serves id=seq, event=type and data=the envelope, parseable under the schema', async () => {
    const origin = await localDoor()
    const stream = await read(`${origin}/api/run-stream/r_local`)

    expect(stream.status).toBe(200)
    expect(stream.contentType).toContain('text/event-stream')
    expect(stream.body).toMatch(/^:ok\n\n/u)
    expect(idsOf(stream.body)).toEqual(FEED.map((envelope) => envelope.seq))
    expect(eventsOf(stream.body)).toEqual(FEED.map((envelope) => envelope.type))
    expect(datasOf(stream.body)).toEqual(FEED.map((envelope) => JSON.stringify(envelope)))
    // The framing claim is sharp only against gappy seqs: a stream-local counter emits 1..13 here.
    expect(idsOf(stream.body)).not.toEqual(FEED.map((_envelope, index) => index + 1))
    for (const data of datasOf(stream.body)) {
      expect(RunEventEnvelopeSchema.safeParse(JSON.parse(data)).success).toBe(true)
    }
  })

  it('requires no token on the local surface — it is the loopback API behind the bind guard', async () => {
    const origin = await localDoor()
    const stream = await read(`${origin}/api/run-stream/r_local`)
    expect(stream.status).toBe(200)
  })
})

describe('the local door applies the same handle filter', () => {
  it.each([3, 7, 11] as const)('handle %i carries its OWN member events and every run-scoped one', async (handle) => {
    const origin = await localDoor()
    const stream = await read(`${origin}/api/run-stream/r_local?handle=${String(handle)}`)

    expect(idsOf(stream.body))
      .toEqual([...RUN_SCOPED_SEQS, ...MEMBER_SEQS[handle]!].sort((a, b) => a - b))
  })

  it('EXCLUDES every other member — the half an inclusion-only cell cannot see', async () => {
    const origin = await localDoor()
    const stream = await read(`${origin}/api/run-stream/r_local?handle=7`)
    const seqs = new Set(idsOf(stream.body))

    for (const foreign of [...MEMBER_SEQS[3]!, ...MEMBER_SEQS[11]!]) {
      expect(seqs.has(foreign), `seq ${String(foreign)} must not reach handle 7`).toBe(false)
    }
  })

  it('gives the three handles pairwise-disjoint, non-empty member sets', async () => {
    const origin = await localDoor()
    const captures = await Promise.all(
      ROSTER.map(async (handle) => idsOf((await read(`${origin}/api/run-stream/r_local?handle=${String(handle)}`)).body)),
    )
    const runScoped = new Set(RUN_SCOPED_SEQS)
    const memberSets = captures.map((seqs) => new Set(seqs.filter((seq) => !runScoped.has(seq))))
    for (let i = 0; i < memberSets.length; i += 1) {
      for (let j = i + 1; j < memberSets.length; j += 1) {
        expect([...memberSets[i]!].filter((seq) => memberSets[j]!.has(seq))).toEqual([])
      }
    }
    expect(memberSets.map((set) => set.size)).toEqual([3, 3, 3])
  })

  it.each([
    ['notanumber', 'invalid_handle'],
    ['07', 'invalid_handle'],
    ['-1', 'invalid_handle'],
    ['1.5', 'invalid_handle'],
    ['', 'invalid_handle'],
    ['4', 'unknown_handle'],
    ['0', 'unknown_handle'],
  ] as const)('refuses ?handle=%s with a typed 400 %s BEFORE any stream header', async (raw, code) => {
    const origin = await localDoor()
    const response = await fetch(`${origin}/api/run-stream/r_local?handle=${encodeURIComponent(raw)}`)

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('content-type')).not.toContain('text/event-stream')
    expect(await response.json()).toEqual({ error: code })
  })

  it('refuses a REPEATED handle parameter rather than silently answering the first', async () => {
    // `url.searchParams.get('handle')` would return "1" here. The authed door joins the values so
    // a request that says two different things is not a request that said the first one — and the
    // local door must not be the place that spelling drifts.
    const origin = await localDoor()
    const response = await fetch(`${origin}/api/run-stream/r_local?handle=1&handle=2`)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_handle' })
  })

  it('refuses an unknown run with a typed 404 pre-stream', async () => {
    const origin = await localDoor()
    const response = await fetch(`${origin}/api/run-stream/r_nope`)
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: 'unknown_run' })
  })
})

/** GET through `node:http` so the whole shipped `startServer` frame is in the path. */
function getThroughServer(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const request = httpGet({ host: '127.0.0.1', port, path, headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        contentType: response.headers['content-type'] ?? null,
        body,
      }))
    })
    request.on('error', reject)
  })
}

describe('the PRODUCTION frame threads the attach port (server.ts, not the router alone)', () => {
  it('serves the local run-stream through the shipped startServer when the service is mounted', async () => {
    // A REAL database rather than the router cells' stub: this frame is the shipped one, and the
    // claim is about what `startServer` wires, so nothing in it should be a lookalike.
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, runService: servicePorts() })
    closers.push(started.close)
    const port = (started.server.address() as AddressInfo).port

    const stream = await getThroughServer(port, '/api/run-stream/r_local?handle=7')
    expect(stream.status).toBe(200)
    expect(stream.contentType).toContain('text/event-stream')
    expect(idsOf(stream.body))
      .toEqual([...RUN_SCOPED_SEQS, ...MEMBER_SEQS[7]!].sort((a, b) => a - b))
  })

  it('THE ATTACH-ONLY ARM: streams with runServiceAttach alone and NO runService mounted', async () => {
    // WINDOWS #264, at the production frame. The zero-token dashboard declares no run-service
    // credential, so `runService` is absent — and it still executes runs, so its local door must
    // still stream them. `runServiceAttach` is a FIRST-CLASS `startServer` option rather than a
    // derivation off `runService` precisely so this composition exists; that is the whole content
    // of the fix, and it is only measurable at the frame that threads it.
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, runServiceAttach: attachPort })
    closers.push(started.close)
    const port = (started.server.address() as AddressInfo).port

    const stream = await getThroughServer(port, '/api/run-stream/r_local?handle=7')
    expect(stream.status).toBe(200)
    expect(stream.contentType).toContain('text/event-stream')
    expect(idsOf(stream.body))
      .toEqual([...RUN_SCOPED_SEQS, ...MEMBER_SEQS[7]!].sort((a, b) => a - b))
  })

  it('honours Last-Event-ID through the SHIPPED frame, not just through the router', async () => {
    // The header has to survive `node:http`'s own header folding and the server's routing before
    // it reaches the core. A router-only cell cannot see a frame that dropped it.
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, runServiceAttach: attachPort })
    closers.push(started.close)
    const port = (started.server.address() as AddressInfo).port

    const stream = await getThroughServer(port, '/api/run-stream/r_local', {
      'Last-Event-ID': '22',
    })
    expect(stream.status).toBe(200)
    expect(idsOf(stream.body)).toEqual([25, 26, 30, 31])
  })

  it('replays to the end and CLOSES on a run whose feed is already over', async () => {
    // The socket ending is the claim — `getThroughServer` resolves on `end`, so a frame that held
    // the connection open would hang this cell rather than fail it, which is why the resume-past-
    // the-end row below is driven here too.
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, runServiceAttach: attachPort })
    closers.push(started.close)
    const port = (started.server.address() as AddressInfo).port

    const tail = await getThroughServer(port, '/api/run-stream/r_local?lastEventId=30')
    expect(tail.status).toBe(200)
    expect(idsOf(tail.body)).toEqual([31])
    expect(eventsOf(tail.body)).toEqual(['runFinished'])

    const past = await getThroughServer(port, '/api/run-stream/r_local?lastEventId=31')
    expect(past.status).toBe(200)
    expect(idsOf(past.body)).toEqual([])
    expect(past.body).toMatch(/^:ok\n\n/u)
  })

  it('refuses the floor with 410 through the shipped frame', async () => {
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, runServiceAttach: attachPort })
    closers.push(started.close)
    const port = (started.server.address() as AddressInfo).port

    const refused = await getThroughServer(port, '/api/run-stream/r_floor?lastEventId=2')
    expect(refused.status).toBe(410)
    expect(refused.contentType).toContain('application/json')
    expect(JSON.parse(refused.body))
      .toEqual({ error: 'replay_floor', earliestAvailableSeq: FLOOR_EARLIEST_SEQ })
  })

  it('answers 404 unknown_run for a run this process never started', async () => {
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, runServiceAttach: attachPort })
    closers.push(started.close)
    const port = (started.server.address() as AddressInfo).port

    const answer = await getThroughServer(port, '/api/run-stream/r_nope')
    expect(answer.status).toBe(404)
    expect(JSON.parse(answer.body)).toEqual({ error: 'unknown_run' })
  })

  it('answers 503 BY NAME with NEITHER port supplied — the frame still refuses honestly', async () => {
    // A `startServer` with no run service AND no attach port has nothing to stream from, and 503
    // is the honest word for that. The shipped command never reaches this composition — it threads
    // `runServiceAttach` on both token arms — but the frame's own answer is still a contract.
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0 })
    closers.push(started.close)
    const port = (started.server.address() as AddressInfo).port

    const answer = await getThroughServer(port, '/api/run-stream/r_local')
    expect(answer.status).toBe(503)
    expect(answer.contentType).toContain('application/json')
    expect(answer.body).not.toContain('text/event-stream')
    expect(JSON.parse(answer.body)).toMatchObject({ error: expect.stringContaining('run service') })
  })

  it('the LEGACY bare-router mount answers the same 503 — the case the option did not remove', async () => {
    // `createRouter({ db })` with no attach port is the mount a host that has not learned about
    // the option produces. It keeps its 503, so the #264 fix widened what CAN stream without
    // changing what an unwired mount says.
    const origin = await listen(createRouter({ db: mockDb() }))
    const answer = await read(`${origin}/api/run-stream/r_local`)
    expect(answer.status).toBe(503)
    expect(answer.contentType).toContain('application/json')
    expect(JSON.parse(answer.body)).toMatchObject({ error: expect.stringContaining('run service') })
  })
})

/**
 * ---- THE SOURCE CELL, WITH ITS KNOWN-POSITIVE CONTROL ----------------------------------------
 *
 * The extractor brace-matches the handler block containing a given needle out of `routes.ts`. The
 * predicate then asks whether SSE frame formatting appears inside that block. Run over the local
 * run-stream handler the answer must be NO — and the SAME predicate is run over a body where the
 * answer must be YES, because an extractor that returned nothing (or a predicate that could not
 * see frame formatting) would satisfy the first assertion for free.
 *
 * THE CONTROL MOVED, AND MOVED TOWARDS THE THING IT IS ABOUT. It used
 * to be the RETIRED live-event handler in this same file — a second SSE spelling that happened to
 * contain the framing. (Its route name is deliberately not spelled anywhere in this file: the D-21
 * grep-clean inventory scans every package's `src` tree and counts a comment as a hit, so prose
 * naming a retired route would be the reappearance the inventory exists to forbid.) It is gone, and
 * the honest control is the module the run-stream handler DELEGATES to: `run-service-routes.ts`,
 * where every one of these patterns has to appear because that is where the frames are actually
 * written. A control inside the file under test could only ever prove the extractor worked; this
 * one proves the framing exists somewhere and that `routes.ts` is not the somewhere.
 */
const FRAME_FORMATTING: readonly (readonly [string, RegExp])[] = Object.freeze([
  ['the event-stream content type', /text\/event-stream/u],
  ['an id frame', /id: \$\{/u],
  ['an event frame', /\\nevent: \$\{/u],
  ['the stream preamble', /:ok\\n\\n/u],
  ['a heartbeat timer', /setInterval/u],
] as const)

function handlerBlockAt(source: string, needle: string): string {
  const at = source.indexOf(needle)
  if (at < 0) throw new Error(`routes.ts has no handler mentioning ${needle}`)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  throw new Error(`unbalanced handler block for ${needle}`)
}

describe('routes.ts delegates the stream rather than re-spelling it', () => {
  it('has NO frame formatting in the run-stream handler, and the control proves the predicate sees it elsewhere', async () => {
    const source = await readFile(new URL('../server/routes.ts', import.meta.url), 'utf8')

    const control = await readFile(
      new URL('../run-service/run-service-routes.ts', import.meta.url),
      'utf8',
    )
    const matchedInControl = FRAME_FORMATTING.filter(([, pattern]) => pattern.test(control))
    // THE CONTROL FIRST. If this fails the cell below means nothing at all.
    expect(control.length).toBeGreaterThan(200)
    expect(matchedInControl.map(([name]) => name)).toEqual(FRAME_FORMATTING.map(([name]) => name))

    const local = handlerBlockAt(source, "'/api/run-stream/'")
    expect(local.length).toBeGreaterThan(50)
    for (const [name, pattern] of FRAME_FORMATTING) {
      expect(pattern.test(local), `the run-stream handler must not carry ${name}`).toBe(false)
    }
    // …and what it does instead: it calls the one exported core.
    expect(local).toContain('serveRunEventStream(')
  })

  it('imports the stream core and the handle-parameter reader from the run-service module', async () => {
    const source = await readFile(new URL('../server/routes.ts', import.meta.url), 'utf8')
    const body = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n')

    expect(body).toMatch(/import\s*\{[^}]*serveRunEventStream[^}]*\}\s*from\s*'\.\.\/run-service\/run-service-routes\.js'/su)
    // The repeated-parameter join is the core's, not a second reading of the query here.
    expect(body).not.toMatch(/searchParams\.get\('handle'\)/u)
  })
})
