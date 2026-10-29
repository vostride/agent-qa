// `GET /api/runs/:id/post-processing` — chip truth and posture, read through the injected host
//
// WHY EVERY CELL DRIVES `startServer` AND NOT THE ROUTE FUNCTION. The claim this route makes is
// not "a function returns a body" — it is "the browser can reach chip truth, and only ever as the
// op's own bytes". Two of the three things that could break that live above the route: the arm's
// POSITION in `routes.ts` (the `/api/runs/:id` catch-all below it answers `Not found` for anything
// that is not exactly four segments — the live-url arm's header records that measurement) and the
// conditional spread in `server.ts` that threads the host at all. A suite that called
// `servePostProcessingRead` directly would be green with the arm registered after the catch-all,
// which is the "green that never ran" failure WINDOWS names.
//
// THE PLANTED HOST RECORDS ITS CALLS, and that recording is the D-17 claim in its structural form:
// this package holds no store, opens no `agent-jobs.db` and derives no chip. Every fact on the wire
// must have arrived through `invokeFunction(registry, <an id the composition supplied>, input,
// caller)`. The ids the fixture plants are DELIBERATELY NOT the real op ids — a route that spelled
// the real op id itself would answer the fixture's calls for an id nobody supplied, and
// this file would still be green. It is not, because the fixture would never be asked.

import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type {
  PostProcessingStatus,
  RunEventEnvelope,
} from '@vostride/agent-qa-schema'
import {
  CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
  CURRENT_BUS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '../db/database.js'
import type { AgentHost, AgentRegistryHandle } from '../chat/host.js'
import { createPostProcessingRelay } from '../execution/post-processing-relay.js'
import { isPostProcessingTerminal } from '../run-service/post-processing-routes.js'
import { startServer } from '../server/server.js'

/**
 * The ids the composition supplies, INVENTED HERE rather than copied from the agent package.
 *
 * Two reasons and both are load-bearing. `packages/dashboard-server` may not import
 * `@vostride/agent-qa-agent` (validate:arch), so the real constants are unreachable from this
 * file — and more importantly, an id nobody could have guessed is what makes "the route dispatches
 * the id it was HANDED" measurable. A route carrying its own literal would dispatch
 * the real op id, the fixture would answer no such id, and the cells below would red.
 */
const PP_ID = 'test:planted-post-processing-op'
const EVENTS_ID = 'test:planted-events-op'

const RUN_ID = 'r_pp_read'

const REGISTRY: AgentRegistryHandle = { planted: 'registry' } as AgentRegistryHandle
const CALLER = { id: 'planted-caller', grantedScopes: ['read'] } as unknown as AgentHost['caller']

interface RecordedCall {
  readonly registry: AgentRegistryHandle
  readonly functionId: string
  readonly input: unknown
  readonly caller: unknown
}

interface PlantOptions {
  /** What the post-processing op answers, or the error it throws. */
  readonly status?: PostProcessingStatus | (() => never)
  /** What the events op replays, or the error it throws. */
  readonly events?: readonly RunEventEnvelope[] | (() => never)
}

interface PlantedHost {
  readonly host: AgentHost
  readonly calls: RecordedCall[]
}

function plantHost(options: PlantOptions): PlantedHost {
  const calls: RecordedCall[] = []
  const host: AgentHost = {
    registry: REGISTRY,
    caller: CALLER,
    runsPostProcessingFunctionId: PP_ID,
    runsEventsFunctionId: EVENTS_ID,
    // the seam carries a fourth op id. This fixture dispatches only the two above, so
    // this one is NAMED and never reached — the SHAPE is what has to be complete.
    runsDetailFunctionId: 'test:planted-run-detail-op',
    runsEvidenceFunctionId: 'test:planted-run-evidence-op',
    // a fifth. Same posture — named so the SHAPE is complete, never reached from here.
    runsArtifactFunctionId: 'test:planted-run-artifact-op',
    // a sixth. Same posture — named so the SHAPE is complete, never reached from here.
    analysisGetFunctionId: 'test:planted-analysis-get-op',
    // the sixth dispatched id, widened here so every AgentHost literal in the
    // workspace still satisfies the interface.
    runsKnowledgeFunctionId: 'test:planted-run-knowledge-op',
    runsMarkFunctionId: 'test:planted-run-mark-op',
    runsMarksHistoryFunctionId: 'test:planted-run-marks-history-op',
    runsMarkPreviewFunctionId: 'test:planted-run-mark-preview-op',
    invokeFunction: (registry, functionId, input, caller): Promise<unknown> => {
      calls.push({ registry, functionId, input, caller })
      if (functionId === PP_ID) {
        const scripted = options.status
        if (scripted === undefined) throw new Error('this fixture plants no post-processing answer')
        if (typeof scripted === 'function') scripted()
        return Promise.resolve(scripted)
      }
      if (functionId === EVENTS_ID) {
        const scripted = options.events
        if (scripted === undefined) throw new Error('this fixture plants no events answer')
        if (typeof scripted === 'function') scripted()
        // The op's own shape: a stream result is an async iterable of envelopes, ACQUIRED inside
        // the invocation (so a refusal is a throw, not a stream that dies mid-delivery).
        const replay = async function* (): AsyncGenerator<RunEventEnvelope> {
          for (const one of scripted as readonly RunEventEnvelope[]) yield one
        }
        return Promise.resolve(replay())
      }
      throw new Error(`the fixture was asked for an id it does not plant: ${functionId}`)
    },
  }
  return { host, calls }
}

const chips = (
  analysis: PostProcessingStatus['chips']['analysis'],
  curation: PostProcessingStatus['chips']['curation'],
  runId = RUN_ID,
): PostProcessingStatus => ({ runId, chips: { analysis, curation } })

const envelope = (
  seq: number,
  type: RunEventEnvelope['type'],
  payload: RunEventEnvelope['payload'],
  runId = RUN_ID,
): RunEventEnvelope => ({ seq, ts: seq * 10, runId, type, payload })

const servers: Server[] = []
const closers: Array<() => void> = []

afterEach(async () => {
  while (closers.length > 0) closers.pop()?.()
  while (servers.length > 0) {
    const server = servers.pop()
    await new Promise<void>((closed) => server?.close(() => closed()))
  }
})

interface Answer {
  readonly status: number
  readonly contentType: string | null
  readonly body: unknown
  readonly raw: string
}

async function serveWith(options: PlantOptions & { readonly withHost?: boolean }): Promise<{
  readonly port: number
  readonly calls: RecordedCall[]
}> {
  const planted = plantHost(options)
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    ...(options.withHost === false ? {} : { agentHost: planted.host }),
    postProcessingRelay: createPostProcessingRelay(),
  })
  closers.push(started.close)
  return { port: (started.server.address() as AddressInfo).port, calls: planted.calls }
}

async function get(port: number, path: string): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`)
  const raw = await response.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    body = undefined
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body,
    raw,
  }
}

describe('the read route joins the op result with the run record', () => {
  it('answers the op result VERBATIM, with the disposition and the last per-stage failure', async () => {
    const status = chips('failed', 'complete')
    const { port, calls } = await serveWith({
      status,
      events: [
        envelope(1, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION } as RunEventEnvelope['payload']),
        envelope(2, 'analysisFailed', { runId: RUN_ID, error: 'first attempt', willRetry: true }),
        envelope(3, 'runFinished', { aggregateVerdict: 'failed', disposition: 'drained', finalSeq: 3 }),
        envelope(4, 'analysisFailed', { runId: RUN_ID, error: 'the last word', willRetry: false }),
      ],
    })

    const answer = await get(port, `/api/runs/${RUN_ID}/post-processing`)
    expect(answer.status, answer.raw).toBe(200)
    expect(answer.contentType, 'the read route is JSON').toContain('application/json')
    expect(answer.body, 'the op result travels whole; the record joins beside it').toEqual({
      status,
      disposition: 'drained',
      failures: { analysis: { error: 'the last word', willRetry: false } },
    })

    // every fact above arrived through the injected door, under the host's own caller.
    expect(calls.map((call) => call.functionId), 'both ops, by the SUPPLIED ids').toEqual([PP_ID, EVENTS_ID])
    expect(calls[0]?.input, 'the post-processing input is the strict one-field shape').toEqual({ runId: RUN_ID })
    expect(calls[1]?.input, 'the events input names the run and nothing else').toEqual({ runId: RUN_ID })
    for (const call of calls) {
      expect(call.registry, 'the host registry, handed straight back').toBe(REGISTRY)
      expect(call.caller, "the host's own caller — the scope gate is the function layer's").toBe(CALLER)
    }
  })

  it('carries NO `failures` entry for a failed stage the record never wrote an envelope for', async () => {
    // The daemon drained this chain, or a later process did: nothing appended a chip line to this
    // run's log. The chip says `failed` because the DURABLE ROW says so, and the route composes no
    // prose to go with it — 404-03 decided the row carries no failure text, and inventing one here
    // would be this file answering a question the record declined to.
    const status = chips('failed', 'failed')
    const { port } = await serveWith({
      status,
      events: [
        envelope(1, 'runFinished', { aggregateVerdict: 'passed', disposition: 'handedOff', finalSeq: 1 }),
      ],
    })

    const answer = await get(port, `/api/runs/${RUN_ID}/post-processing`)
    expect(answer.status, answer.raw).toBe(200)
    expect(answer.body).toEqual({ status, disposition: 'handedOff', failures: {} })
  })

  it('reads BOTH stages independently, each from its own last envelope', async () => {
    const status = chips('failed', 'failed')
    const { port } = await serveWith({
      status,
      events: [
        envelope(1, 'curationFailed', { runId: RUN_ID, error: 'curation once' }),
        envelope(2, 'analysisFailed', { runId: RUN_ID, error: 'analysis once' }),
        envelope(3, 'curationFailed', { runId: RUN_ID, error: 'curation twice', willRetry: true }),
        envelope(4, 'runFinished', { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: 4 }),
      ],
    })

    const answer = await get(port, `/api/runs/${RUN_ID}/post-processing`)
    expect(answer.status, answer.raw).toBe(200)
    expect(answer.body).toEqual({
      status,
      disposition: 'detached',
      failures: {
        analysis: { error: 'analysis once' },
        curation: { error: 'curation twice', willRetry: true },
      },
    })
  })

  it('leaves disposition AND failures absent when the events read refuses, with the status intact', async () => {
    // The record is one of two sources and the weaker one: a run whose log fell out of the replay
    // window still has durable chip truth, and a route that 500ed on the log would hide it.
    const status = chips('running', 'pending')
    const { port } = await serveWith({
      status,
      events: () => {
        throw Object.assign(new Error('events before seq 40 are no longer available'), {
          name: 'StreamReplayFloorError',
        })
      },
    })

    const answer = await get(port, `/api/runs/${RUN_ID}/post-processing`)
    expect(answer.status, answer.raw).toBe(200)
    expect(answer.body, 'absent fields, never invented ones').toEqual({ status })
  })

  it('answers an all-pending chain for a run nothing has queued — the op own law, not an error', async () => {
    const status = chips('pending', 'pending', 'r_never_ran')
    const { port } = await serveWith({ status, events: [] })

    const answer = await get(port, '/api/runs/r_never_ran/post-processing')
    expect(answer.status, answer.raw).toBe(200)
    expect(answer.body).toEqual({ status, failures: {} })
  })
})

describe('every refusal is NAMED — never an all-pending body', () => {
  it('400 invalid_run_id for an id the op input schema refuses', async () => {
    const { port, calls } = await serveWith({ status: chips('pending', 'pending'), events: [] })

    // `a/b` percent-encoded is exactly what `runIdSchema` refuses: an id the path layer would
    // have to REWRITE before it could name the run's own directory. It has to arrive ENCODED —
    // a literal `..` segment is normalised away by the URL parser before any router sees it, so
    // the refusal a raw traversal attempt gets is a 404 from somewhere else entirely.
    const answer = await get(port, `/api/runs/${encodeURIComponent('a/b')}/post-processing`)
    expect(answer.status, answer.raw).toBe(400)
    expect(answer.body).toEqual({ error: 'invalid_run_id' })
    expect(calls, 'refused before the door is dispatched at all').toEqual([])
  })

  it('503 function_not_bound when the composition bound no such op', async () => {
    const { port } = await serveWith({
      status: () => {
        throw Object.assign(new Error('runs.postprocessing is declared but not bound in this composition'), {
          name: 'FunctionNotBoundError',
        })
      },
    })

    const answer = await get(port, `/api/runs/${RUN_ID}/post-processing`)
    expect(answer.status, answer.raw).toBe(503)
    expect(answer.body).toMatchObject({ error: 'function_not_bound' })
    expect((answer.body as { reason?: unknown }).reason, 'the refusal says which').toContain('not bound')
  })

  it('503 job_store_schema_version when the queue database is stamped by another build', async () => {
    const { port } = await serveWith({
      status: () => {
        throw Object.assign(new Error('the agent job store is stamped at schema version 9'), {
          name: 'JobStoreSchemaVersionError',
        })
      },
    })

    const answer = await get(port, `/api/runs/${RUN_ID}/post-processing`)
    expect(answer.status, answer.raw).toBe(503)
    expect(answer.body).toMatchObject({ error: 'job_store_schema_version' })
  })

  it('500 post_processing_unavailable carrying the error NAME and no message', async () => {
    // The name is a classification a client can branch on; the message is prose from anywhere
    // inside the store and is not this route's to forward (T-404-01's discipline, applied to a
    // refusal rather than to a chip).
    const { port } = await serveWith({
      status: () => {
        throw Object.assign(new Error('/Users/somebody/.agent-qa/agent-jobs.db is locked'), {
          name: 'SqliteBusyError',
        })
      },
    })

    const answer = await get(port, `/api/runs/${RUN_ID}/post-processing`)
    expect(answer.status, answer.raw).toBe(500)
    expect(answer.body).toEqual({ error: 'post_processing_unavailable', reason: 'SqliteBusyError' })
    expect(answer.raw, 'no store path reaches the browser').not.toContain('agent-jobs.db')
  })

  it('503 agent_host_unavailable when this server was started without a host', async () => {
    const { port } = await serveWith({ status: chips('pending', 'pending'), withHost: false })

    const answer = await get(port, `/api/runs/${RUN_ID}/post-processing`)
    expect(answer.status, answer.raw).toBe(503)
    expect(answer.body).toEqual({ error: 'agent_host_unavailable' })
  })
})

describe('the arm sits ABOVE the /api/runs/:id catch-all', () => {
  it('is not answered by the four-segment run reader below it', async () => {
    // Measured rather than assumed: the live-url arm's own header records that its first tracer run
    // answered 404 from precisely that catch-all. `/api/runs/<id>/post-processing` is four segments
    // too, so the catch-all would try `db.getRun('<id>')` and answer `Run not found`.
    const { port } = await serveWith({ status: chips('complete', 'complete'), events: [] })

    const answer = await get(port, `/api/runs/${RUN_ID}/post-processing`)
    expect(answer.status, answer.raw).toBe(200)
    expect(answer.raw, 'the catch-all never saw this path').not.toContain('Run not found')
  })
})

describe('isPostProcessingTerminal', () => {
  it('is true once BOTH chips settled, in either settled word', () => {
    expect(isPostProcessingTerminal(chips('complete', 'complete'))).toBe(true)
    expect(isPostProcessingTerminal(chips('failed', 'complete'))).toBe(true)
    expect(isPostProcessingTerminal(chips('complete', 'failed'))).toBe(true)
    expect(isPostProcessingTerminal(chips('failed', 'failed'))).toBe(true)
  })

  it('is false while either chip is still in flight', () => {
    expect(isPostProcessingTerminal(chips('pending', 'pending'))).toBe(false)
    expect(isPostProcessingTerminal(chips('running', 'pending'))).toBe(false)
    expect(isPostProcessingTerminal(chips('complete', 'running'))).toBe(false)
    expect(isPostProcessingTerminal(chips('running', 'complete'))).toBe(false)
  })

  it('is true the moment the chain wrote its one row, whatever the chips say', () => {
    // The notification is the chain's terminal receipt. A projection that disagreed with it would
    // be a chain that ended twice.
    const withRow: PostProcessingStatus = {
      ...chips('pending', 'pending'),
      notification: {
        schemaVersion: CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
        runId: RUN_ID,
        outcome: 'complete',
        verdictSummary: { total: 0, byClass: {} },
        stages: { analysis: { status: 'complete' }, curation: { status: 'complete' } },
      },
    }
    expect(isPostProcessingTerminal(withRow)).toBe(true)
  })
})
