// The run service router's FRAMING and REFUSAL mechanics.
//
// THE FRAME, STATED, AND ITS LIMIT. These cells mount `createRunServiceRoutes` on a bare
// `createServer` with FAKE ports. That is deliberately NOT the production composition — the
// process-level claims (the mount arm, the ordering against the host's wildcard `OPTIONS`
// preflight and its SPA fallback, a real run's envelopes on a real socket) belong to
// `packages/cli/src/__tests__/run-service-door.e2e.test.ts`, which drives `startServer` itself and
// would be the wrong place to make the claims below.
//
// WHY THESE CELLS EXIST AT ALL, GIVEN THAT E2E. Measured, not assumed: the e2e's "SSE `id` equals
// the envelope `seq`" assertion is VACUOUS on a real run, and a mutation proved it — a real run's
// seqs are 1, 2, 3 … from 1, so a router that framed a local counter instead of the seq produces
// byte-identical output and the e2e stays green. The claim only has teeth against a stream whose
// seqs are neither contiguous nor 1-based, and choosing the seqs requires a fake bus. That is the
// whole reason for the fake here: not to avoid the cost of a real run, but to reach a claim a real
// run cannot state.

import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'

import type { IncomingMessage } from 'node:http'

import { createRunEventBus } from '@vostride/agent-qa-runner'
import {
  RUN_SERVICE_CONTRACT_VERSION,
  RunServiceErrorBodySchema,
  RunServiceReadinessSchema,
  RunServiceReplayFloorBodySchema,
  type RunEventEnvelope,
  type RunServiceErrorCode,
  type RunsLiveUrlResult,
  type RunSession,
  type RunStartAcknowledgement,
  CURRENT_BUS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import {
  RUN_SERVICE_ANALYSIS_TEMPLATE,
  RUN_SERVICE_ROUTE_TABLE,
  createRunServiceRoutes,
  lastEventIdParamOf,
  replayFloorOf,
  resumePointOf,
  ownsRunServicePath,
  RUN_SERVICE_LIVE_URL_TEMPLATE,
  type MintLiveUrlInput,
  type RunServicePorts,
} from '../run-service-routes.js'

// no declared token — the door is tokenless. What it refuses at the
// door is a cross-site request, spelled by these two header sets (each trips one rung of the shared
// same-site guard: a foreign `Origin`, and a cross-site fetch-metadata header).
const CROSS_SITE = { Origin: 'https://evil.example' } as const
const CROSS_SITE_FETCH = { 'Sec-Fetch-Site': 'cross-site' } as const

/**
 * A session whose seqs are CHOSEN — non-contiguous and not starting at 1.
 *
 * 7, 11, 12 rather than 1, 2, 3: a router framing `++counter` would emit 1, 2, 3 and a router
 * framing the envelope's own `seq` emits 7, 11, 12. Contiguous 1-based seqs make the two
 * indistinguishable, which is exactly the coincidence that made the end-to-end assertion vacuous.
 */
const PLANTED_ENVELOPES: readonly RunEventEnvelope[] = Object.freeze([
  { seq: 7, ts: 1, runId: 'r_planted', type: 'runStarted', payload: { a: 1 } },
  { seq: 11, ts: 2, runId: 'r_planted', type: 'verdict', payload: { verdict: 'failed' } },
  { seq: 12, ts: 3, runId: 'r_planted', type: 'runFinished', payload: { aggregateVerdict: 'failed' } },
] as unknown as readonly RunEventEnvelope[])

function plantedSession(options: { readonly throwOnSubscribe?: boolean } = {}): RunSession {
  return {
    id: 'r_planted' as RunSession['id'],
    status: 'running',
    executionContext: 'local-headless' as RunSession['executionContext'],
    subscribe(fromSeq, handler) {
      if (options.throwOnSubscribe === true) {
        throw new Error(`ReplayIncomplete: events before seq 1 are no longer available (${fromSeq})`)
      }
      for (const envelope of PLANTED_ENVELOPES) handler(envelope)
      return () => undefined
    },
    // a planted session with no browser declares no stream and hands out no frame
    // subscription — the honest absent declaration, not a stub a viewer would wait on forever.
    subscribeFrames() { return undefined },
    streamCapabilityOf() { return { kind: 'none' } },
    cancel() { /* nothing to cancel on a planted session */ },
    done: Promise.resolve({ verdict: 'failed' } as never),
  }
}

const ACK: RunStartAcknowledgement = {
  runId: 'r_planted' as RunStartAcknowledgement['runId'],
  scope: 'main' as unknown as RunStartAcknowledgement['scope'],
  executionContext: 'local-headless' as RunStartAcknowledgement['executionContext'],
  buildOrdinal: 0,
  startedAt: 0,
  testCount: 1,
}

function fakePorts(overrides: Partial<RunServicePorts> = {}): RunServicePorts {
  return {
    invokeRunStart: async () => ACK,
    attach: (runId) => runId === 'r_planted' ? plantedSession() : undefined,
    readiness: () => ({
      service: 'up',
      hostComposed: true,
      contractVersion: RUN_SERVICE_CONTRACT_VERSION,
    }),
    // The DEFAULT is the honest absence, not a stub that mints: a fixture that composed no live
    // view has no live view, and 503 by name is what such a host owes a caller.
    mintLiveUrl: () => Promise.reject(
      Object.assign(new Error('no live-view port is bound on this fixture'), {
        name: 'LiveViewUnavailableError',
      }),
    ),
    ...overrides,
  }
}

const servers: Server[] = []

async function mount(ports: RunServicePorts = fakePorts()): Promise<string> {
  const server = createServer(createRunServiceRoutes(ports))
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

/** Read the whole SSE body — the planted stream ends at `runFinished`, so this terminates. */
async function readStream(url: string, headers: Record<string, string>): Promise<{
  readonly status: number
  readonly contentType: string | null
  readonly body: string
}> {
  const response = await fetch(url, { headers })
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  }
}

describe('the wire IS the bus envelope', () => {
  it('frames the envelope SEQ as the SSE id, not a stream-local counter', async () => {
    const origin = await mount()
    const stream = await readStream(
      `${origin}/run/r_planted/events`,
      {},
    )
    expect(stream.status).toBe(200)
    expect(stream.contentType).toContain('text/event-stream')

    const ids = [...stream.body.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]))
    // THE DISCRIMINATING ASSERTION. A counter emits 1, 2, 3; the envelope's own seq emits these.
    expect(ids).toEqual([7, 11, 12])
    expect(ids).not.toEqual([1, 2, 3])
  })

  it('frames the envelope TYPE as the SSE event name', async () => {
    const origin = await mount()
    const stream = await readStream(
      `${origin}/run/r_planted/events`,
      {},
    )
    const events = [...stream.body.matchAll(/^event: (.+)$/gmu)].map((match) => match[1])
    expect(events).toEqual(['runStarted', 'verdict', 'runFinished'])
  })

  it('serves each envelope VERBATIM — no projection, no rename, no added field', async () => {
    const origin = await mount()
    const stream = await readStream(
      `${origin}/run/r_planted/events`,
      {},
    )
    const datas = [...stream.body.matchAll(/^data: (.+)$/gmu)].map((match) => match[1]!)
    // Byte equality against the envelope's own serialisation. A second event vocabulary — a
    // renamed field, a dropped one, an added `handle` — reds here whatever it is called.
    expect(datas).toEqual(PLANTED_ENVELOPES.map((envelope) => JSON.stringify(envelope)))
  })

  it('opens with the `:ok` preamble and writes no cross-origin grant', async () => {
    const origin = await mount()
    const response = await fetch(`${origin}/run/r_planted/events`)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.text()).toMatch(/^:ok\n\n/u)
  })
})

describe('the stream head is never written before the answer is settled', () => {
  it('answers a typed JSON 404 for an unknown run', async () => {
    const origin = await mount()
    const response = await fetch(`${origin}/run/r_absent/events`)
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: 'unknown_run' })
  })

  it('answers a typed JSON 500 when the replay cannot be served', async () => {
    // `subscribe` THROWS (`ReplayIncompleteError` is the real one). A router that had already
    // written `200 text/event-stream` could only hang up; this one has not, so it can say so.
    const origin = await mount(fakePorts({
      attach: () => plantedSession({ throwOnSubscribe: true }),
    }))
    const response = await fetch(`${origin}/run/r_planted/events`)
    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: 'replay_unavailable' })
  })
})

// RE-SPELLED 2026-10-01: the rung above the route table is the same-site guard,
// not the bearer verdict. The claims — identical refusal on every route, declared or not, and the run
// starter never consulted — are unchanged; the refusal is `cross_site_refused` at 403.
describe('the verdict stands above the route table', () => {
  it('refuses every declared route and an undeclared one identically', async () => {
    const origin = await mount()
    const probes = [
      { method: 'POST', path: '/run' },
      { method: 'GET', path: '/run/r_planted/events' },
      { method: 'GET', path: '/run/anything/else' },
      { method: 'DELETE', path: '/run' },
    ]
    for (const probe of probes) {
      const response = await fetch(`${origin}${probe.path}`, { method: probe.method, headers: CROSS_SITE })
      expect(response.status, `${probe.method} ${probe.path}`).toBe(403)
      expect(await response.json()).toEqual({ error: 'cross_site_refused' })
    }
  })

  it('never consults the run starter for a refused request', async () => {
    let started = 0
    const origin = await mount(fakePorts({
      invokeRunStart: async () => { started += 1; return ACK },
    }))
    await fetch(`${origin}/run`, { method: 'POST', body: '{}', headers: CROSS_SITE })
    await fetch(`${origin}/run`, {
      method: 'POST',
      headers: { ...CROSS_SITE_FETCH, 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(started).toBe(0)
  })
})

// ---- Task 2: `/ok` — authed, shallow-but-honest readiness -----------------------------

// RE-SPELLED 2026-10-01 from 'refuses a request with no token' and 'refuses a
// wrong token with a body shape-identical to the missing-token refusal': `/ok` is still behind the
// door's one guard, which is now the same-site check; both of its rungs answer one body shape.
describe('GET /ok is a service route like every other one', () => {
  it('refuses a cross-site request', async () => {
    const origin = await mount()
    const response = await fetch(`${origin}/ok`, { headers: CROSS_SITE })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'cross_site_refused' })
  })

  it('refuses a cross-site fetch-metadata request with a body shape-identical to the Origin refusal', async () => {
    const origin = await mount()
    const viaFetchSite = await fetch(`${origin}/ok`, { headers: CROSS_SITE_FETCH })
    expect(viaFetchSite.status).toBe(403)
    const fetchSiteBody = await viaFetchSite.json() as Record<string, unknown>
    const originBody = await (await fetch(`${origin}/ok`, { headers: CROSS_SITE })).json() as Record<string, unknown>
    // Nothing differs — no hint of which rung answered.
    expect(fetchSiteBody).toEqual(originBody)
    expect(fetchSiteBody).toEqual({ error: 'cross_site_refused' })
  })

  // RE-TITLED 2026-10-03 (quick-261003-tsr, IN-30): was '…to a valid token'; no credential exists.
  it('reports MEASURED facts and the contract version to an admitted caller', async () => {
    const origin = await mount()
    const response = await fetch(`${origin}/ok`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = RunServiceReadinessSchema.parse(await response.json())
    // a local caller with no token is served; 432-22 removed `authConfigured`.
    expect(body).toEqual({
      service: 'up',
      hostComposed: true,
      contractVersion: RUN_SERVICE_CONTRACT_VERSION,
    })
    // It never claims a run will succeed: there is no `ready`, no verdict prediction, and no
    // knowledge/embedder rung — those are 407's `doctor`.
    expect(Object.keys(body).sort()).toEqual(
      ['contractVersion', 'hostComposed', 'service'],
    )
  })

  it('reports an UNCOMPOSED host honestly rather than refusing', async () => {
    const origin = await mount(fakePorts({
      readiness: () => ({
        service: 'up',
        hostComposed: false,
        contractVersion: RUN_SERVICE_CONTRACT_VERSION,
      }),
    }))
    const response = await fetch(`${origin}/ok`)
    expect(response.status).toBe(200)
    expect((await response.json() as { hostComposed: boolean }).hostComposed).toBe(false)
  })
})

describe('the refusal-shape census walks the module\'s OWN route table', () => {
  /**
   * Every row, driven — and the ENUMERATION is the point.
   *
   * The corpus is read off `RUN_SERVICE_ROUTE_TABLE` rather than written out here, so a route
   * added tomorrow is covered the day it lands and cannot escape this cell by nobody noticing it.
   * A hardcoded list of three paths would be a claim about three paths.
   */
  // `:sha` joins `:runId` as a template parameter. Substituted rather than left literal
  // so the probe drives the row's real shape — a path still carrying `:sha` would match the
  // pattern by accident and the census would be testing a coincidence.
  const probePathFor = (row: { readonly path: string }): string =>
    row.path.replace(':runId', 'r_planted').replace(':sha', 'a'.repeat(64))

  it('covers every declared route, and the table is not empty', async () => {
    // Non-vacuity first: a census over an empty table passes by finding nothing to drive.
    // six. The two READ rows joined the table, which is exactly what
    // "mounts behind the same authed door" has to mean mechanically — a row outside this array is
    // unreachable, and a row inside it is driven unauthenticated by the two cells below.
    // seven. The analysis row joined the table, and joining it here is what makes
    // "the failure view is served on both doors" mechanical rather than a claim — the census cells
    // below drive it unauthenticated the day it lands.
    expect(RUN_SERVICE_ROUTE_TABLE.length).toBeGreaterThanOrEqual(7)
    const handlers = RUN_SERVICE_ROUTE_TABLE.map((row) => row.handler).sort()
    // the two feedback reads joined the table, so the census drives them unauthenticated too.
    expect(handlers).toEqual(['analysis', 'artifact', 'detail', 'events', 'evidence', 'liveUrl', 'markPreview', 'marks', 'ok', 'start'])
  })

  // RE-SPELLED 2026-10-01 from 'refuses a MISSING token on every row with one
  // body shape' and 'refuses an INVALID token on every row with the same body shape'. The census
  // still walks the module's own table; what every row refuses is a cross-site request, on either
  // rung of the same-site guard, with one body shape.
  it('refuses a cross-site Origin on every row with one body shape', async () => {
    const origin = await mount()
    const bodies: Record<string, unknown>[] = []
    for (const row of RUN_SERVICE_ROUTE_TABLE) {
      const response = await fetch(`${origin}${probePathFor(row)}`, { method: row.method, headers: CROSS_SITE })
      expect(response.status, `${row.method} ${row.path}`).toBe(403)
      bodies.push(await response.json() as Record<string, unknown>)
    }
    for (const body of bodies) {
      expect(body).toEqual({ error: 'cross_site_refused' })
    }
  })

  it('refuses a cross-site fetch-metadata request on every row with the same body shape', async () => {
    const origin = await mount()
    for (const row of RUN_SERVICE_ROUTE_TABLE) {
      const response = await fetch(`${origin}${probePathFor(row)}`, {
        method: row.method,
        headers: CROSS_SITE_FETCH,
      })
      expect(response.status, `${row.method} ${row.path}`).toBe(403)
      const body = await response.json() as Record<string, unknown>
      expect(Object.keys(body), `${row.method} ${row.path}`).toEqual(['error'])
      expect(body).toEqual({ error: 'cross_site_refused' })
    }
  })
})

// ---- 405-05: the two READ rows reach the adapters, behind the verdict --------
//
// WHAT THESE CELLS CLAIM AND WHAT THEY LEAVE TO OTHERS. The projection's shape, the header set and
// every refusal word are measured over a REAL registry and a REAL store in
// `run-detail-routes.test.ts`; re-asserting them here would be a second description of one
// implementation. What only this file can measure is that the two rows are reachable AT ALL from
// this door's dispatch — that the verdict passed, the pattern matched, the params were decoded and
// the adapter ran — and that an uncomposed host says so in the local door's own word.
describe('the READ rows dispatch through the injected host', () => {
  /**
   * A host whose `invokeFunction` refuses by NAME, exactly as an unbound composition's would —
   * and which RECORDS the op id it was handed, so a row's dispatch can be measured rather than
   * inferred from the status code it produced.
   */
  function hostRefusing(name: string, seen: string[] = []): RunServicePorts['agentHost'] {
    return {
      registry: {},
      caller: {} as never,
      runsPostProcessingFunctionId: 'test:planted-post-processing-op',
      runsEventsFunctionId: 'test:planted-events-op',
      runsDetailFunctionId: 'test:planted-run-detail-op',
      runsArtifactFunctionId: 'test:planted-run-artifact-op',
      // a sixth. This fixture DOES reach it — the analysis row's cell below asserts
      // the id the dispatch handed `invokeFunction`.
      analysisGetFunctionId: 'test:planted-analysis-get-op',
      // the sixth dispatched id, widened here so every AgentHost literal in the
      // workspace still satisfies the interface.
      runsKnowledgeFunctionId: 'test:planted-run-knowledge-op',
      invokeFunction: (_registry: unknown, functionId: string) => {
        seen.push(functionId)
        return Promise.reject(Object.assign(new Error('planted'), { name }))
      },
    } as unknown as NonNullable<RunServicePorts['agentHost']>
  }

  // RE-TITLED 2026-10-03 (quick-261003-tsr, IN-30): was '… — a valid token, an unknown run, …'.
  it('reaches the run-detail adapter — an admitted caller, an unknown run, the op\'s own word', async () => {
    const origin = await mount(fakePorts({ agentHost: hostRefusing('RunNotFoundError') }))
    const response = await fetch(`${origin}/run/r_planted/detail`)
    // 404 `unknown_run` PROVES THE WHOLE CHAIN: the guard passed (a refused one is 403), the
    // pattern matched (an unmatched one is 404 `unknown_route`), the param decoded, and the
    // adapter classified the op's refusal. A door that never reached the op could not say this.
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown_run' })
  })

  it('reaches the ANALYSIS adapter through analysisGetFunctionId', async () => {
    const seen: string[] = []
    const origin = await mount(fakePorts({ agentHost: hostRefusing('RunNotFoundError', seen) }))
    const response = await fetch(`${origin}${RUN_SERVICE_ANALYSIS_TEMPLATE.replace(':runId', 'r_planted')}`)
    // THE ID IS THE CLAIM. A 404 alone would be satisfied by a dispatch that reached the DETAIL
    // adapter; what makes this row its own is the op it asked the host for.
    expect(seen, 'the analysis row dispatches the analysis op, not its sibling')
      .toEqual(['test:planted-analysis-get-op'])
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown_run' })
  })

  it('reaches the artifact adapter, and tells its two 404s apart on this door too', async () => {
    const absent = await mount(fakePorts({ agentHost: hostRefusing('EvidenceBlobAbsentError') }))
    const response = await fetch(`${absent}/run/r_planted/artifacts/${'a'.repeat(64)}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'blob_absent' })
  })

  it('refuses a malformed sha at the CONTRACT, before the op is reached', async () => {
    // The host would refuse by name if it were reached; a 400 proves it was not.
    const origin = await mount(fakePorts({ agentHost: hostRefusing('RunNotFoundError') }))
    const response = await fetch(`${origin}/run/r_planted/artifacts/${'z'.repeat(64)}`)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'malformed_sha' })
  })

  it('says agent_host_unavailable — the LOCAL door\'s word — when no host is composed', async () => {
    const origin = await mount()
    for (const path of ['/run/r_planted/detail', '/run/r_planted/analysis', `/run/r_planted/artifacts/${'a'.repeat(64)}`]) {
      const response = await fetch(`${origin}${path}`)
      expect(response.status, path).toBe(503)
      expect(await response.json(), path).toEqual({ error: 'agent_host_unavailable' })
    }
  })

  // RE-SPELLED 2026-10-01 from 'refuses BOTH rows unauthenticated, before any
  // host is consulted'. No row asks for a credential; a cross-site read is what is refused, and still
  // before any host is consulted.
  it('refuses BOTH rows cross-site, before any host is consulted', async () => {
    // The row-level restatement of the census above, kept here because these two rows are the
    // first on this door that would otherwise have reached a capability: a permissive arm here
    // would serve one run's whole projection, or its screenshots, to a page on another origin.
    const origin = await mount(fakePorts({ agentHost: hostRefusing('RunNotFoundError') }))
    for (const path of ['/run/r_planted/detail', '/run/r_planted/analysis', `/run/r_planted/artifacts/${'a'.repeat(64)}`]) {
      const response = await fetch(`${origin}${path}`, { headers: CROSS_SITE })
      expect(response.status, path).toBe(403)
      expect(await response.json(), path).toEqual({ error: 'cross_site_refused' })
    }
  })
})

describe('the readiness predicate has ONE declaration site, and it is not here', () => {
  it('this module computes no readiness fact of its own — it calls the port', async () => {
    const source = await readFile(
      new URL('../run-service-routes.ts', import.meta.url),
      'utf8',
    )
    // A SOURCE ASSERTION, because the claim is about where a rule LIVES rather than about what a
    // response contains: a second copy of these three facts would agree with the first on the day
    // it was written and drift on some later one, and a response-shape cell cannot see the
    // difference. The composition owns `createRunServiceReadiness`; this module owns the route.
    expect(source).toContain('ports.readiness()')
    for (const spelling of ['hostComposed:', "service: 'up'"]) {
      expect(source, spelling).not.toContain(spelling)
    }
    // And it never spells the version either — the constant is schema's, read by the composition.
    expect(source).not.toContain('contractVersion:')
  })
})

// ---- 403-03: the resume point, the typed floor, the roster on resume ----
//
// WHAT A DOOR-LEVEL CELL CAN SAY THAT A PARSER CELL CANNOT. `resumePointOf` is a pure function and
// its table is below, but the claim INVK-05 makes is about what crosses the socket: that a caller
// carrying `Last-Event-ID: N` is served `subscribe(N + 1)` and never re-sent an id it already has.
// A parser that answered `{ kind: 'after', seq: N }` into a serving body that ignored it would pass
// every unit cell in this file, so these cells drive the door.
//
// THE FLOOR SESSION IS A REAL BUS, NEVER A HAND-BUILT `subscribe` THAT THROWS. What the 410 arm
// reports is the bus's OWN `earliestAvailableSeq`, so a fixture that minted the error itself would
// be pinning this file's idea of the error shape rather than the producer's.

const RESUMABLE_SEQS = PLANTED_ENVELOPES.map((envelope) => envelope.seq)

/** The planted session, but honouring `fromSeq` — which is what a real bus does. */
function resumableSession(): RunSession {
  return {
    ...plantedSession(),
    subscribe(fromSeq, handler) {
      for (const envelope of PLANTED_ENVELOPES) {
        if (envelope.seq >= fromSeq) handler(envelope)
      }
      return () => undefined
    },
  }
}

/**
 * A REAL `createRunEventBus` with a 3-event window fed 8 envelopes, so seqs 1-5 are evicted.
 *
 * `windowMaxEvents: 3` retains 6, 7, 8 — `earliestRetainedSeq()` is therefore 6, and with no event
 * log behind it `subscribe(n)` for n < 6 raises the bus's own `ReplayIncompleteError`. The
 * heartbeat is pushed past any test's lifetime so the retained window is exactly what was published.
 */
const FLOOR_EARLIEST_SEQ = 6
const FLOOR_ROSTER = [3, 7, 11] as const

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
  bus.publish('runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 3, handles: [...FLOOR_ROSTER] })
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

function resumePorts(): RunServicePorts {
  return fakePorts({
    attach: (runId) => {
      if (runId === 'r_planted') return resumableSession()
      if (runId === 'r_floor') return floorSession()
      return undefined
    },
  })
}

const idsOfStream = (body: string): number[] =>
  [...body.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]))

describe('the door honours Last-Event-ID and ?lastEventId=', () => {
  it('replays from subscribe(N + 1): no id at or below the resume point is ever re-sent', async () => {
    const origin = await mount(resumePorts())
    const stream = await readStream(`${origin}/run/r_planted/events?lastEventId=7`, {
      })
    expect(stream.status).toBe(200)
    expect(idsOfStream(stream.body)).toEqual([11, 12])
    expect(idsOfStream(stream.body)).not.toEqual(RESUMABLE_SEQS)
  })

  it('honours the HEADER as well as the query, and the header decides when they disagree', async () => {
    const origin = await mount(resumePorts())
    const viaHeader = await readStream(`${origin}/run/r_planted/events`, {
      'Last-Event-ID': '7',
    })
    expect(idsOfStream(viaHeader.body)).toEqual([11, 12])

    // The browser's own automatic reconnect carries the fresher value, so it wins.
    const disagreeing = await readStream(`${origin}/run/r_planted/events?lastEventId=0`, {
      'Last-Event-ID': '7',
    })
    expect(idsOfStream(disagreeing.body)).toEqual([11, 12])
  })

  it.each([
    'abc',
    '-1',
    '07',
    '1.5',
    '1e3',
    '',
  ])('refuses ?lastEventId=%s with a typed 400 invalid_last_event_id BEFORE any head', async (raw) => {
    const origin = await mount(resumePorts())
    const response = await fetch(
      `${origin}/run/r_planted/events?lastEventId=${encodeURIComponent(raw)}`,
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('content-type')).not.toContain('text/event-stream')
    expect(await response.json()).toEqual({ error: 'invalid_last_event_id' })
  })

  it('refuses a REPEATED lastEventId rather than silently answering the first', async () => {
    const origin = await mount(resumePorts())
    const response = await fetch(`${origin}/run/r_planted/events?lastEventId=1&lastEventId=7`)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_last_event_id' })
  })
})

describe('the replay floor is a TYPED refusal carrying the recovery point', () => {
  it('answers 410 replay_floor with the bus\'s own earliestAvailableSeq, before any head', async () => {
    const origin = await mount(resumePorts())
    const response = await fetch(`${origin}/run/r_floor/events?lastEventId=2`)
    expect(response.status).toBe(410)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('content-type')).not.toContain('text/event-stream')
    expect(await response.json())
      .toEqual({ error: 'replay_floor', earliestAvailableSeq: FLOOR_EARLIEST_SEQ })
  })

  it('THE RECOVERY IS REACHABLE — a client following the refusal re-attaches and is served', async () => {
    // THE TWO-SIDED HALF. A refusal whose advertised recovery point cannot be reached is worse
    // than no refusal at all: it tells the caller to do something that fails the same way. So this
    // cell reads the floor OUT of the refusal body and re-requests with it, exactly as a thin
    // client would — `lastEventId = earliestAvailableSeq - 1`, because the caller names the last
    // envelope it has ALREADY observed and the floor names the first one still available.
    const origin = await mount(resumePorts())
    const refused = await fetch(`${origin}/run/r_floor/events?lastEventId=2`)
    const floor = (await refused.json() as { earliestAvailableSeq: number }).earliestAvailableSeq

    const recovered = await readStream(
      `${origin}/run/r_floor/events?lastEventId=${String(floor - 1)}`,
      {},
    )
    expect(recovered.status).toBe(200)
    expect(idsOfStream(recovered.body)[0]).toBe(floor)
    expect(idsOfStream(recovered.body)).toEqual([6, 7, 8])
  })

  it('serves a resume AT the floor rather than refusing it — the boundary is inclusive', async () => {
    const origin = await mount(resumePorts())
    const stream = await readStream(`${origin}/run/r_floor/events?lastEventId=5`, {
      })
    expect(stream.status).toBe(200)
    expect(idsOfStream(stream.body)).toEqual([6, 7, 8])
  })

  it('keeps 500 replay_unavailable for a throw that is NOT the floor', async () => {
    const origin = await mount(fakePorts({
      attach: () => plantedSession({ throwOnSubscribe: true }),
    }))
    const response = await fetch(`${origin}/run/r_planted/events`)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'replay_unavailable' })
  })
})

describe('the handle filter survives a DEEP resume', () => {
  it('serves handle 7 on a resume past the roster announcement instead of refusing it', async () => {
    // `runStarted` carries the roster and it is seq 1. On `subscribe(6, …)` it is not delivered, so
    // a door that derives the roster from the first envelope it sees would answer `unknown_handle`
    // for EVERY deep resume on a member stream — the defect this cell exists for.
    const origin = await mount(resumePorts())
    const stream = await readStream(`${origin}/run/r_floor/events?handle=7&lastEventId=5`, {
      })
    expect(stream.status).toBe(200)
    // seq 6 is member 3's step and must NOT reach handle 7; 7 is member 7's; 8 is run-scoped.
    expect(idsOfStream(stream.body)).toEqual([7, 8])
  })

  it('still refuses a handle no member of the run answers to on a deep resume', async () => {
    const origin = await mount(resumePorts())
    const response = await fetch(`${origin}/run/r_planted/events?handle=4&lastEventId=7`)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'unknown_handle' })
  })
})

describe('a resume that lands past the end closes rather than hanging', () => {
  it('answers 200 with zero data frames and ENDS when the resume point is the final seq', async () => {
    const origin = await mount(resumePorts())
    const response = await fetch(`${origin}/run/r_planted/events?lastEventId=12`, {
      signal: AbortSignal.timeout(5_000),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(idsOfStream(body)).toEqual([])
    expect(body).toMatch(/^:ok\n\n/u)
  })
})

// ---- The two readers, as pure functions ---------------------------------------------------------

/** A request object carrying only what these two readers look at. */
function requestWith(url: string, headers: Record<string, string | string[]> = {}): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage
}

describe('lastEventIdParamOf reads the RAW query, like handleParamOf', () => {
  it.each([
    ['no query at all', '/run/r/events', null],
    ['a query with no lastEventId', '/run/r/events?handle=7', null],
    ['a plain value', '/run/r/events?lastEventId=8', '8'],
    ['a value beside other parameters', '/run/r/events?handle=7&lastEventId=8&x=1', '8'],
    ['an EMPTY value — present, and it did not parse', '/run/r/events?lastEventId=', ''],
    ['a REPEATED parameter, JOINED so it cannot parse', '/run/r/events?lastEventId=1&lastEventId=7', '1,7'],
    ['a percent-encoded value, decoded by the parser', '/run/r/events?lastEventId=%38', '8'],
  ] as const)('%s', (_label, url, expected) => {
    expect(lastEventIdParamOf(requestWith(url))).toBe(expected)
  })

  it('never answers a repeated parameter with one of its values — the drift this reader refuses', () => {
    // `new URL(...).searchParams.get('lastEventId')` answers '1' here, which is a resume point the
    // caller did not unambiguously ask for. A wrong resume point is a gap or a duplicate.
    const raw = lastEventIdParamOf(requestWith('/run/r/events?lastEventId=1&lastEventId=7'))
    expect(raw).not.toBe('1')
    expect(raw).not.toBe('7')
    expect(resumePointOf(undefined, raw)).toEqual({ kind: 'invalid' })
  })
})

describe('resumePointOf — the whole input table, and the header decides', () => {
  it.each([
    ['both absent is the beginning', undefined, null, { kind: 'start' }],
    ['a null header with no parameter', null, null, { kind: 'start' }],
    ['zero is a real resume point — the caller observed nothing', undefined, '0', { kind: 'after', seq: 0 }],
    ['a plain value from the query', undefined, '8', { kind: 'after', seq: 8 }],
    ['a plain value from the header', '8', null, { kind: 'after', seq: 8 }],
    ['a large but safe integer', undefined, '9007199254740991', { kind: 'after', seq: 9007199254740991 }],
    ['past the safe-integer bound', undefined, '9007199254740993', { kind: 'invalid' }],
    ['an empty parameter', undefined, '', { kind: 'invalid' }],
    ['an EMPTY HEADER — present, and it did not parse', '', null, { kind: 'invalid' }],
    ['a non-numeric value', undefined, 'abc', { kind: 'invalid' }],
    ['a negative value', undefined, '-1', { kind: 'invalid' }],
    ['a zero-padded value', undefined, '07', { kind: 'invalid' }],
    ['a fractional value', undefined, '1.5', { kind: 'invalid' }],
    ['an exponent', undefined, '1e3', { kind: 'invalid' }],
    ['hex', undefined, '0x8', { kind: 'invalid' }],
    ['padded whitespace', undefined, ' 8 ', { kind: 'invalid' }],
    ['negative zero', undefined, '-0', { kind: 'invalid' }],
    ['a joined repeated parameter', undefined, '1,7', { kind: 'invalid' }],
    ['a joined repeated header', ['1', '7'], null, { kind: 'invalid' }],
    ['the header wins over the query', '8', '3', { kind: 'after', seq: 8 }],
    ['the header wins even when the query is fresher', '3', '8', { kind: 'after', seq: 3 }],
    ['a MALFORMED header wins over a valid query — it is present, and it did not parse', 'abc', '8', { kind: 'invalid' }],
  ] as const)('%s', (_label, header, param, expected) => {
    expect(resumePointOf(header, param)).toEqual(expected)
  })
})

describe('replayFloorOf reads the floor STRUCTURALLY, and refuses a lookalike', () => {
  it('reads a real bus ReplayIncompleteError without naming its class', () => {
    const bus = createRunEventBus({ runId: 'r_probe', windowMaxEvents: 1, heartbeatMs: 3_600_000 })
    bus.publish('runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 0 })
    bus.publish('runWarning', { code: 'w', message: 'w' })
    let caught: unknown
    try { bus.subscribe(1, () => undefined) } catch (error) { caught = error }
    expect(replayFloorOf(caught)).toBe(2)
  })

  it.each([
    ['a plain Error', new Error('boom')],
    ['null', null],
    ['a string', 'ReplayIncompleteError'],
    ['the right name with no floor', Object.assign(new Error('x'), { name: 'ReplayIncompleteError' })],
    ['the right name with a non-numeric floor', Object.assign(new Error('x'), { name: 'ReplayIncompleteError', earliestAvailableSeq: '6' })],
    ['the right name with a fractional floor', Object.assign(new Error('x'), { name: 'ReplayIncompleteError', earliestAvailableSeq: 6.5 })],
    ['the right name with a negative floor', Object.assign(new Error('x'), { name: 'ReplayIncompleteError', earliestAvailableSeq: -1 })],
    ['a numeric floor under the WRONG name', Object.assign(new Error('x'), { earliestAvailableSeq: 6 })],
  ] as const)('answers undefined for %s — a 410 with no reachable recovery point is worse than none', (_label, error) => {
    expect(replayFloorOf(error)).toBeUndefined()
  })
})

// ---- The refusal codes, each driven out of the shipped door -----------------------------------
//
// Each probe drives one refusal out of the shipped door and checks its status and its body.

interface CodeProbe {
  readonly code: RunServiceErrorCode
  /** Drive the door and return the observed status and parsed body. */
  drive: () => Promise<{ readonly status: number; readonly body: Record<string, unknown> }>
  /** The status this refusal carries. */
  readonly status: number
  /** `true` for the one body deliberately wider than one key (`replay_floor`). */
  readonly wide?: true
}

async function refusalAt(
  path: string,
  init: RequestInit & { readonly ports?: RunServicePorts } = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const { ports, ...requestInit } = init
  const origin = await mount(ports ?? resumePorts())
  const response = await fetch(`${origin}${path}`, requestInit)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

// a local caller sends no credential, so the admitted header set is empty.
// The three bearer codes left the closed set with the bearer, and `cross_site_refused` joined it.
const authed: Record<string, string> = {}

const CODE_PROBES: readonly CodeProbe[] = Object.freeze([
  {
    code: 'cross_site_refused',
    status: 403,
    drive: () => refusalAt('/ok', { headers: CROSS_SITE }),
  },
  {
    code: 'unknown_route',
    status: 404,
    drive: () => refusalAt('/run/r_planted/nope', { headers: authed }),
  },
  {
    code: 'refused_request_field',
    status: 400,
    drive: () => refusalAt('/run', {
      method: 'POST',
      headers: { ...authed, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'r_mine' }),
    }),
  },
  {
    code: 'invalid_request_body',
    status: 400,
    drive: () => refusalAt('/run', {
      method: 'POST',
      headers: { ...authed, 'Content-Type': 'application/json' },
      body: '{not json',
    }),
  },
  {
    code: 'run_start_failed',
    status: 500,
    drive: () => refusalAt('/run', {
      method: 'POST',
      headers: { ...authed, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      ports: fakePorts({ invokeRunStart: () => { throw new Error('the host is gone') } }),
    }),
  },
  {
    code: 'unknown_run',
    status: 404,
    drive: () => refusalAt('/run/r_nope/events', { headers: authed }),
  },
  {
    code: 'invalid_handle',
    status: 400,
    drive: () => refusalAt('/run/r_planted/events?handle=notanumber', { headers: authed }),
  },
  {
    code: 'unknown_handle',
    status: 400,
    drive: () => refusalAt('/run/r_planted/events?handle=4', { headers: authed }),
  },
  {
    code: 'invalid_last_event_id',
    status: 400,
    drive: () => refusalAt('/run/r_planted/events?lastEventId=abc', { headers: authed }),
  },
  {
    code: 'replay_floor',
    status: 410,
    wide: true,
    drive: () => refusalAt('/run/r_floor/events?lastEventId=2', { headers: authed }),
  },
  {
    code: 'replay_unavailable',
    status: 500,
    drive: () => refusalAt('/run/r_planted/events', {
      headers: authed,
      ports: fakePorts({ attach: () => plantedSession({ throwOnSubscribe: true }) }),
    }),
  },
  {
    code: 'live_view_unavailable',
    status: 503,
    drive: () => refusalAt('/run/r_planted/live-url', {
      headers: authed,
      ports: fakePorts({
        mintLiveUrl: () => Promise.reject(
          Object.assign(new Error('no live-view port is bound on this host'), {
            name: 'LiveViewUnavailableError',
          }),
        ),
      }),
    }),
  },
  {
    code: 'live_url_mint_failed',
    status: 500,
    drive: () => refusalAt('/run/r_planted/live-url', {
      headers: authed,
      ports: fakePorts({ mintLiveUrl: () => Promise.reject(new Error('the registry is gone')) }),
    }),
  },
  {
    code: 'unsupported_media_type',
    status: 415,
    drive: () => refusalAt('/run', {
      method: 'POST',
      headers: { ...authed },
      body: JSON.stringify({}),
    }),
  },
] as const)

describe('each refusal code is driven out of the shipped door', () => {
  it.each(CODE_PROBES.map((probe) => [probe.code, probe] as const))(
    '%s is DRIVEN out of the shipped door, at its declared status',
    async (code, probe) => {
      const observed = await probe.drive()
      expect(observed.status, `${code} must be answered with ${String(probe.status)}`)
        .toBe(probe.status)
      expect(observed.body.error).toBe(code)
      if (probe.wide !== true) {
        // THE ONE-KEY LAW, re-measured per code rather than asserted once: a refusal that grew a
        // second key would be a fingerprinting surface, and the one that legitimately carries one
        // is declared here by name rather than discovered.
        expect(Object.keys(observed.body), `${code} carries exactly one key`).toEqual(['error'])
        expect(RunServiceErrorBodySchema.parse(observed.body)).toEqual({ error: code })
      }
    },
  )

  it('the one WIDE body is exactly the one this door declares', () => {
    expect(CODE_PROBES.filter((probe) => probe.wide === true).map((probe) => probe.code))
      .toEqual(['replay_floor'])
  })

  it('the replay_floor body satisfies its published schema', async () => {
    const observed = await refusalAt('/run/r_floor/events?lastEventId=2', { headers: authed })
    expect(RunServiceReplayFloorBodySchema.safeParse(observed.body).success).toBe(true)
    expect(RunServiceReplayFloorBodySchema.parse(observed.body).earliestAvailableSeq)
      .toBe(FLOOR_EARLIEST_SEQ)
  })
})

// ---- 403-03 Task 2 (D-03, Q3): the authed door MINTS ---------------------------------------------
//
// THE REMOTE DOOR MINTS THROUGH THE SAME OP AS THE LOCAL ONE, with the bearer's trust scope. What
// these cells can say is what the DOOR does with the port: the verdict above it, the raw handle
// reader, the refusal mapping by error NAME, and that the result crosses verbatim. That the port
// dispatches `runs.liveurl` rather than shaping a URL itself is the composition's claim, pinned in
// `adapters.ts` against the shipped route table.

const MINTED: RunsLiveUrlResult = Object.freeze({
  liveUrl: 'http://localhost:1234/live/r_planted#v2.zz-403-03-planted-token',
  expiresAt: 1_700_000_000_000,
  handle: 0,
  stream: { kind: 'none' as const },
})

/** Every mint this door asked for, so a cell can read WHAT the arm passed the port. */
function recordingMintPorts(
  mint?: (input: MintLiveUrlInput) => Promise<RunsLiveUrlResult>,
): { readonly ports: RunServicePorts; readonly seen: MintLiveUrlInput[] } {
  const seen: MintLiveUrlInput[] = []
  const ports = fakePorts({
    attach: (runId) => runId === 'r_planted' ? resumableSession() : undefined,
    mintLiveUrl: async (input) => {
      seen.push(input)
      if (mint) return mint(input)
      return { ...MINTED, handle: input.handle }
    },
  })
  return { ports, seen }
}

describe('the authed door mints a liveUrl', () => {
  it('answers the mint result VERBATIM, with no second shaping of what a liveUrl is', async () => {
    const { ports } = recordingMintPorts()
    const origin = await mount(ports)
    const response = await fetch(`${origin}/run/r_planted/live-url`, { headers: authed })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual(MINTED)
  })

  // RE-SPELLED 2026-10-01 from 'carries the BEARER'S trust scope to the port — never
  // a scope of the door's own'. No bearer and no trust scope exist; the port is handed the subject
  // the caller named and nothing about who the caller is, and the composition supplies the one
  // caller the mint runs under.
  it('hands the port the requested subject and no caller-supplied scope', async () => {
    const { ports, seen } = recordingMintPorts()
    const origin = await mount(ports)
    await fetch(`${origin}/run/r_planted/live-url?handle=7`, { headers: authed })
    expect(seen).toEqual([{ runId: 'r_planted', handle: 7 }])
  })

  it('defaults the handle to 0 when none is asked for', async () => {
    const { ports, seen } = recordingMintPorts()
    const origin = await mount(ports)
    await fetch(`${origin}/run/r_planted/live-url`, { headers: authed })
    expect(seen[0]?.handle).toBe(0)
  })

  it.each(['notanumber', '07', '-1', '1.5', ''] as const)(
    'refuses ?handle=%s with 400 invalid_handle and never reaches the port',
    async (raw) => {
      const { ports, seen } = recordingMintPorts()
      const origin = await mount(ports)
      const response = await fetch(
        `${origin}/run/r_planted/live-url?handle=${encodeURIComponent(raw)}`,
        { headers: authed },
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_handle' })
      expect(seen).toEqual([])
    },
  )

  it('refuses a REPEATED handle rather than minting for the first', async () => {
    const { ports, seen } = recordingMintPorts()
    const origin = await mount(ports)
    const response = await fetch(`${origin}/run/r_planted/live-url?handle=1&handle=2`, {
      headers: authed,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_handle' })
    expect(seen).toEqual([])
  })

  it.each([
    ['UnknownRunError', 404, 'unknown_run'],
    ['LiveViewUnavailableError', 503, 'live_view_unavailable'],
    ['SomethingElseEntirely', 500, 'live_url_mint_failed'],
  ] as const)(
    'maps a %s rejection to %i %s — by error NAME, never by matching a message',
    async (name, status, code) => {
      const { ports } = recordingMintPorts(() => Promise.reject(
        Object.assign(new Error('a message that will be rewritten one day'), { name }),
      ))
      const origin = await mount(ports)
      const response = await fetch(`${origin}/run/r_planted/live-url`, { headers: authed })
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error: code })
    },
  )

  // RE-SPELLED 2026-10-01 from '… — no credential, no mint': the guard every route
  // is under is the same-site check, and a refused mint still never reaches the port.
  it('is under the SAME verdict as every other route — cross-site, no mint', async () => {
    const { ports, seen } = recordingMintPorts()
    const origin = await mount(ports)
    const response = await fetch(`${origin}/run/r_planted/live-url`, { headers: CROSS_SITE })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'cross_site_refused' })
    expect(seen, 'the port must not be reached for a refused request').toEqual([])
  })

  it('the route is in the shipped table, so the census and the mount both see it', () => {
    const row = RUN_SERVICE_ROUTE_TABLE.find((entry) => entry.handler === 'liveUrl')
    expect(row).toBeDefined()
    expect(row?.method).toBe('GET')
    expect(row?.path).toBe(RUN_SERVICE_LIVE_URL_TEMPLATE)
    expect(RUN_SERVICE_LIVE_URL_TEMPLATE).toBe('/run/:runId/live-url')
    expect(ownsRunServicePath('/run/r_planted/live-url')).toBe(true)
  })
})
