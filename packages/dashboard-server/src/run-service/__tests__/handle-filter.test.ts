// Planted indices 3, 7 and 11 and chosen seqs separate a correct filter from plausible wrong ones.

import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'

import {
  RUN_SERVICE_CONTRACT_VERSION,
  type RunEventEnvelope,
  type RunSession,
  type RunStartAcknowledgement,
  CURRENT_BUS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { createRunServiceRoutes, type RunServicePorts } from '../run-service-routes.js'

/** The announced roster. Non-contiguous and not 0-based, on purpose (see the header). */
const ROSTER = [3, 7, 11] as const

/**
 * A mixed feed over three concurrent members, interleaved.
 *
 * Interleaved rather than blocked per member: a filter that sliced a contiguous RANGE of the
 * stream would reproduce a blocked feed's per-member subset exactly and be wrong about this one.
 *
 * `seq: 18` is a member-scoped envelope with NO `testIndex` — a producer defect, planted to pin
 * the fail-closed posture on the wire: it belongs to the firehose and to no handle at all.
 */
const FEED: readonly RunEventEnvelope[] = Object.freeze([
  { seq: 1, ts: 1, runId: 'r_feed', type: 'runStarted', payload: { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 3, handles: [...ROSTER] } },
  { seq: 2, ts: 2, runId: 'r_feed', type: 'hookStarted', payload: { hookName: 'suite-setup', phase: 'setup', hookExecutionId: 'h0', scope: 'suite' } },
  { seq: 3, ts: 3, runId: 'r_feed', type: 'testStarted', payload: { testId: 'a', testIndex: 3, name: 'a' } },
  { seq: 5, ts: 5, runId: 'r_feed', type: 'testStarted', payload: { testId: 'b', testIndex: 7, name: 'b' } },
  { seq: 8, ts: 8, runId: 'r_feed', type: 'stepStarted', payload: { testIndex: 3, stepIndex: 0, stepText: 'a0' } },
  { seq: 9, ts: 9, runId: 'r_feed', type: 'hookStarted', payload: { hookName: 'before-each', phase: 'setup', hookExecutionId: 'h1', scope: 'test', testIndex: 7 } },
  { seq: 13, ts: 13, runId: 'r_feed', type: 'testStarted', payload: { testId: 'c', testIndex: 11, name: 'c' } },
  { seq: 14, ts: 14, runId: 'r_feed', type: 'stepStarted', payload: { testIndex: 7, stepIndex: 0, stepText: 'b0' } },
  { seq: 17, ts: 17, runId: 'r_feed', type: 'runWarning', payload: { code: 'w', message: 'w' } },
  { seq: 18, ts: 18, runId: 'r_feed', type: 'stepStarted', payload: { stepIndex: 9, stepText: 'orphan' } },
  { seq: 21, ts: 21, runId: 'r_feed', type: 'stepStarted', payload: { testIndex: 11, stepIndex: 0, stepText: 'c0' } },
  { seq: 22, ts: 22, runId: 'r_feed', type: 'testFinished', payload: { testId: 'a', testIndex: 3, outcome: 'passed' } },
  { seq: 23, ts: 23, runId: 'r_feed', type: 'heartbeat', payload: {} },
  { seq: 25, ts: 25, runId: 'r_feed', type: 'testFinished', payload: { testId: 'b', testIndex: 7, outcome: 'passed' } },
  { seq: 26, ts: 26, runId: 'r_feed', type: 'testFinished', payload: { testId: 'c', testIndex: 11, outcome: 'failed' } },
  { seq: 30, ts: 30, runId: 'r_feed', type: 'verdict', payload: { verdict: 'failed' } },
  { seq: 31, ts: 31, runId: 'r_feed', type: 'runFinished', payload: { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: 31 } },
] as unknown as readonly RunEventEnvelope[])

/** The same run, announcing NO roster — a run that cannot answer a per-handle question. */
const ROSTERLESS: readonly RunEventEnvelope[] = Object.freeze([
  { seq: 1, ts: 1, runId: 'r_norost', type: 'runStarted', payload: { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 2 } },
  { seq: 2, ts: 2, runId: 'r_norost', type: 'testStarted', payload: { testId: 'a', testIndex: 0, name: 'a' } },
  { seq: 3, ts: 3, runId: 'r_norost', type: 'runFinished', payload: { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: 3 } },
] as unknown as readonly RunEventEnvelope[])

/** The run-scoped seqs, derived from the classification rather than restated by hand. */
const RUN_SCOPED_SEQS = [1, 2, 17, 23, 30, 31]
/** Per-handle member-scoped seqs, likewise. */
const MEMBER_SEQS: Readonly<Record<number, readonly number[]>> = {
  3: [3, 8, 22],
  7: [5, 9, 14, 25],
  11: [13, 21, 26],
}

function sessionOver(id: string, feed: readonly RunEventEnvelope[]): RunSession {
  return {
    id: id as RunSession['id'],
    status: 'running',
    executionContext: 'local-headless' as RunSession['executionContext'],
    subscribe(_fromSeq, handler) {
      for (const envelope of feed) handler(envelope)
      return () => undefined
    },
    // A planted session with no browser declares no stream and hands out no frame subscription.
    subscribeFrames() { return undefined },
    streamCapabilityOf() { return { kind: 'none' } },
    cancel() { /* nothing to cancel on a planted session */ },
    done: Promise.resolve({ verdict: 'failed' } as never),
  }
}

const ACK: RunStartAcknowledgement = {
  runId: 'r_feed' as RunStartAcknowledgement['runId'],
  scope: 'main' as unknown as RunStartAcknowledgement['scope'],
  executionContext: 'local-headless' as RunStartAcknowledgement['executionContext'],
  buildOrdinal: 0,
  startedAt: 0,
  testCount: 3,
}

function fakePorts(): RunServicePorts {
  return {
    invokeRunStart: async () => ACK,
    attach: (runId) => {
      if (runId === 'r_feed') return sessionOver('r_feed', FEED)
      if (runId === 'r_norost') return sessionOver('r_norost', ROSTERLESS)
      return undefined
    },
    readiness: () => ({
      service: 'up',
      hostComposed: true,
      contractVersion: RUN_SERVICE_CONTRACT_VERSION,
    }),
    // A fixture with no live view answers a mint with 503 by name, never a fabricated token.
    mintLiveUrl: () => Promise.reject(
      Object.assign(new Error('no live-view port is bound on this fixture'), {
        name: 'LiveViewUnavailableError',
      }),
    ),
  }
}

const servers: Server[] = []

async function mount(): Promise<string> {
  const server = createServer(createRunServiceRoutes(fakePorts()))
  servers.push(server)
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new TypeError('no port')
  return `http://127.0.0.1:${String(address.port)}`
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    await new Promise<void>((closed) => server?.close(() => closed()))
  }
})

interface Capture {
  readonly status: number
  readonly contentType: string | null
  readonly body: string
}

/** Read a whole SSE body. The planted feed ends at `runFinished`, so this terminates. */
async function read(url: string): Promise<Capture> {
  const response = await fetch(url)
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

describe('?handle=N serves member N plus every run-scoped envelope, and nothing else', () => {
  it('includes handle 7\'s own events AND every run-scoped one', async () => {
    const origin = await mount()
    const stream = await read(`${origin}/run/r_feed/events?handle=7`)

    expect(stream.status).toBe(200)
    expect(stream.contentType).toContain('text/event-stream')
    expect(idsOf(stream.body)).toEqual([...RUN_SCOPED_SEQS, ...MEMBER_SEQS[7]!].sort((a, b) => a - b))
  })

  it('EXCLUDES every other member\'s events from the same capture', async () => {
    // The other half. An inclusion-only assertion passes under a filter that returns the whole
    // firehose, which is the single most likely wrong implementation.
    const origin = await mount()
    const stream = await read(`${origin}/run/r_feed/events?handle=7`)
    const seqs = new Set(idsOf(stream.body))

    for (const foreign of [...MEMBER_SEQS[3]!, ...MEMBER_SEQS[11]!]) {
      expect(seqs.has(foreign), `seq ${String(foreign)} must not reach handle 7`).toBe(false)
    }
    // …and the orphaned member-scoped envelope reaches no handle at all (fail closed).
    expect(seqs.has(18)).toBe(false)
  })

  it('is not off by one and is not keyed on array position', async () => {
    const origin = await mount()
    // Handle 0 is not in the roster at all, and array positions 0/1/2 are NOT the identities.
    const three = await read(`${origin}/run/r_feed/events?handle=3`)
    const eleven = await read(`${origin}/run/r_feed/events?handle=11`)

    expect(idsOf(three.body))
      .toEqual([...RUN_SCOPED_SEQS, ...MEMBER_SEQS[3]!].sort((a, b) => a - b))
    expect(idsOf(eleven.body))
      .toEqual([...RUN_SCOPED_SEQS, ...MEMBER_SEQS[11]!].sort((a, b) => a - b))
    // Off by one: handle 3 must not carry member 7's or member 11's slices, and vice versa.
    expect(new Set(idsOf(three.body)).has(5)).toBe(false)
    expect(new Set(idsOf(eleven.body)).has(14)).toBe(false)
  })

  it('gives the three handles PAIRWISE DISJOINT member sets and IDENTICAL run-scoped sets', async () => {
    const origin = await mount()
    const captures = await Promise.all(
      ROSTER.map(async (handle) => idsOf((await read(`${origin}/run/r_feed/events?handle=${String(handle)}`)).body)),
    )
    const runScoped = new Set(RUN_SCOPED_SEQS)
    const memberSets = captures.map((seqs) => new Set(seqs.filter((seq) => !runScoped.has(seq))))

    for (const seqs of captures) {
      expect(seqs.filter((seq) => runScoped.has(seq))).toEqual(RUN_SCOPED_SEQS)
    }
    for (let i = 0; i < memberSets.length; i += 1) {
      for (let j = i + 1; j < memberSets.length; j += 1) {
        const overlap = [...memberSets[i]!].filter((seq) => memberSets[j]!.has(seq))
        expect(overlap, `handles ${String(ROSTER[i])} and ${String(ROSTER[j])} overlap`).toEqual([])
      }
    }
    // Non-vacuity: disjointness is trivially true of three empty sets.
    expect(memberSets.map((set) => set.size)).toEqual([3, 4, 3])
  })

  it('serves the surviving envelopes VERBATIM at their OWN seqs — the filter adds no field', async () => {
    const origin = await mount()
    const stream = await read(`${origin}/run/r_feed/events?handle=11`)
    const expected = FEED.filter((envelope) =>
      RUN_SCOPED_SEQS.includes(envelope.seq) || MEMBER_SEQS[11]!.includes(envelope.seq))

    expect(datasOf(stream.body)).toEqual(expected.map((envelope) => JSON.stringify(envelope)))
    // The framing claim, still sharp under a filter: a stream-local counter would emit 1..6 here.
    expect(idsOf(stream.body)).toEqual(expected.map((envelope) => envelope.seq))
    expect(idsOf(stream.body)).not.toEqual([1, 2, 3, 4, 5, 6])
    expect([...stream.body.matchAll(/^event: (.+)$/gmu)].map((m) => m[1]))
      .toEqual(expected.map((envelope) => envelope.type))
  })

  it('with NO handle parameter serves the full firehose, framing unchanged', async () => {
    const origin = await mount()
    const stream = await read(`${origin}/run/r_feed/events`)

    expect(stream.status).toBe(200)
    expect(idsOf(stream.body)).toEqual(FEED.map((envelope) => envelope.seq))
    expect(datasOf(stream.body)).toEqual(FEED.map((envelope) => JSON.stringify(envelope)))
    expect(stream.body).toMatch(/^:ok\n\n/u)
  })

  it('ignores an unrelated query parameter — only `handle` filters', async () => {
    const origin = await mount()
    const stream = await read(`${origin}/run/r_feed/events?since=7&format=json`)
    expect(idsOf(stream.body)).toEqual(FEED.map((envelope) => envelope.seq))
  })
})

describe('an invalid or unknown handle is refused BEFORE any stream header', () => {
  const refusals: readonly [string, string][] = [
    ['notanumber', 'invalid_handle'],
    ['-1', 'invalid_handle'],
    ['1.5', 'invalid_handle'],
    ['', 'invalid_handle'],
    [' 7', 'invalid_handle'],
    ['0x7', 'invalid_handle'],
    ['1e1', 'invalid_handle'],
    ['+7', 'invalid_handle'],
    ['07', 'invalid_handle'],
    // Syntactically fine, but no member of this run answers to it.
    ['0', 'unknown_handle'],
    ['1', 'unknown_handle'],
    ['4', 'unknown_handle'],
    ['12', 'unknown_handle'],
  ]

  for (const [raw, code] of refusals) {
    it(`refuses ?handle=${JSON.stringify(raw)} with a typed 400 ${code} and a JSON body`, async () => {
      const origin = await mount()
      const response = await fetch(
        `${origin}/run/r_feed/events?handle=${encodeURIComponent(raw)}`,
      )
      expect(response.status).toBe(400)
      // The whole point of validating before `writeHead`: a response that has already written
      // `200 text/event-stream` cannot be told it failed.
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.headers.get('content-type')).not.toContain('text/event-stream')
      expect(await response.json()).toEqual({ error: code })
    })
  }

  it('refuses a handle on a run that announced NO roster, rather than guessing', async () => {
    const origin = await mount()
    const response = await fetch(`${origin}/run/r_norost/events?handle=0`)
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: 'unknown_handle' })
  })

  it('still serves that run\'s firehose when no handle is asked for', async () => {
    const origin = await mount()
    const stream = await read(`${origin}/run/r_norost/events`)
    expect(stream.status).toBe(200)
    expect(idsOf(stream.body)).toEqual([1, 2, 3])
  })

  it('refuses a MALFORMED handle before it looks the run up at all', async () => {
    // The order is deliberate and it is the disclosure-minimal one: a malformed parameter is a
    // fact about the caller's own input, so answering it first means the refusal cannot be used
    // as a run-existence oracle. A well-formed handle on a nonexistent run still gets `unknown_run`
    // (the cell below), because that answer needs the run looked up.
    const origin = await mount()
    const malformed = await fetch(`${origin}/run/r_absent/events?handle=notanumber`)
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'invalid_handle' })
  })

  it('refuses an unknown RUN when the handle itself parses', async () => {
    const origin = await mount()
    const response = await fetch(`${origin}/run/r_absent/events?handle=7`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown_run' })
  })

  it('refuses a cross-site handle request with 403, never a handle code', async () => {
    const origin = await mount()
    const response = await fetch(`${origin}/run/r_feed/events?handle=7`, {
      headers: { Origin: 'https://evil.example' },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'cross_site_refused' })
  })
})

describe('there is exactly ONE spelling of run-scoped-ness', () => {
  it('imports the schema predicate and re-derives nothing locally', async () => {
    // A supplement to the behavioural cells: the router must not grow its own classification copy.
    const source = await readFile(
      new URL('../run-service-routes.ts', import.meta.url),
      'utf8',
    )
    const body = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n')
    expect(body).toContain('passesHandleFilter(')
    expect(body).toContain('@vostride/agent-qa-schema')
    // No second classification table, and no hand-rolled run-scoped list.
    expect(body).not.toMatch(/RUN_EVENT_SCOPE\s*[:=]\s*\{/u)
    expect(body).not.toMatch(/'runFinished'\s*,\s*'heartbeat'/u)
    expect(body).not.toMatch(/payload\.testIndex/u)
  })
})
