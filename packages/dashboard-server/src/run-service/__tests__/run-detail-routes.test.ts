// THE PHASE 405 TRACER (plan 01, D-01/D-02/D-03/D-14 · DETL-01/DETL-03).
//
// ONE CLAIM, MEASURED END TO END: a decision-screenshot `ArtifactRef` the runner mints reaches a
// browser as a sha, through every layer this phase touches and with no layer faked.
//
//   producer   `projectSubActionRecorded` — the SHIPPED schema fold, called here directly
//   subscriber `createDashboardRunIngest` — the SHIPPED arms, over a real `DashboardDatabase`
//   storage    the v2 `run_sub_actions` row, in a real (in-memory) SQLite file
//   port       `createDashboardRunDetailReader` — the SHIPPED adapter
//   op         `runs.detail` — the SHIPPED spec, reached through the SHIPPED `invokeFunction`
//              on a registry composed by the SHIPPED `createFunctionRegistry`
//   route      `GET /api/runs/:id/detail` on a REAL socket, through `startServer`
//
// WHY THE SOCKET AND NOT THE ADAPTER FUNCTION. Two of the things that can break this path live
// ABOVE the route handler: the arm's POSITION in `routes.ts` — the `/api/runs/:id` catch-all
// below it claims every four-segment GET and answers `Not found`, which is RESEARCH Pitfall 2 —
// and the conditional spread in `server.ts` that threads the host at all. A suite that called
// `serveRunDetailRead` directly would be green with the arm registered in the wrong place, which
// is the "green that never ran" failure WINDOWS names.
//
// WHY A REAL REGISTRY AND NOT A PLANTED HOST. The op is where the token sum is computed, where
// `RunNotFoundError` is minted and where the `runDetail` binding is checked; a fixture that
// answered the route's `invokeFunction` itself would be a second implementation of all three,
// green about a path this product does not ship. `@vostride/agent-qa-agent` is a DEV dependency
// of this package for exactly this reason — `validate:arch` walks `src` with `__tests__` excluded
// and reconciles only runtime `dependencies`, so the production edge it forbids stays forbidden
// (see `run-detail-reader.ts`: the reader declares its own structural port type and imports
// nothing from the agent package).

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ANALYSIS_GET_FUNCTION_ID,
  RUNS_ARTIFACT_FUNCTION_ID,
  RUNS_DETAIL_FUNCTION_ID,
  RUNS_EVIDENCE_FUNCTION_ID,
  RUNS_KNOWLEDGE_FUNCTION_ID,
  RUNS_MARK_FUNCTION_ID,
  RUNS_MARK_PREVIEW_FUNCTION_ID,
  RUNS_MARKS_HISTORY_FUNCTION_ID,
  createFunctionRegistry,
  invokeFunction,
  type FunctionDeps,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
// 405-05: the SHIPPED evidence-blob binding and the SHIPPED store that wrote the blob. Both are
// DEV-only edges here, on the `@vostride/agent-qa-agent` reasoning at the top of this file —
// `validate:arch` walks `src` with `__tests__` excluded and reconciles only runtime
// `dependencies`, so the production edges these packages forbid stay forbidden. The point of
// driving them is that a reader written in this file would be a second containment rule.
import { createEvidenceBlobReader } from '@vostride/agent-qa-agent-local'
import { FsEvidenceArtifactStore, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  MARK_RECEIPT_SCHEMA_VERSION,
  RunsMarkPreviewResultSchema,
  RunsMarksHistoryResultSchema,
  projectSubActionRecorded,
  type FeedbackReadsPort,
  type MarkReceipt,
  type RunsMarkInput,
  type RunsMarkPreviewResult,
  type Action,
  type ArtifactRef,
  type FunctionCaller,
  type RecordedActionResult,
  type RunEventEnvelope,
  type RunEventType,
  type ScreenState,
  type SubActionEvidence,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentHost, AgentRegistryHandle } from '../../chat/host.js'
import { DashboardDatabase } from '../../db/database.js'
import { createDashboardRunIngest } from '../../reporter/dashboard-subscriber.js'
import { startServer } from '../../server/server.js'
import { serveRunDetailRead } from '../run-detail-routes.js'
import { createRunServiceRoutes, type RunServicePorts } from '../run-service-routes.js'
import { createDashboardRunDetailReader } from '../run-detail-reader.js'

/** A 64-hex sha, the shape `FsEvidenceArtifactStore` content-addresses a blob under. */
const DECISION_SHA = 'a'.repeat(63) + '7'
// 2026-10-01 (432-21, D-12): the run service is tokenless, so its fixture headers carry nothing, and
// what it refuses before dispatch is a cross-site request.
const TOKENLESS_HEADERS: Record<string, string> = {}
const CROSS_SITE_HEADERS: Record<string, string> = { Origin: 'https://evil.example' }
const RUN_ID = 'r_tracer-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
const BRIEF_DIGEST = 'brief-digest-405-tracer'

let seq = 0
function ev(type: RunEventType, payload: Record<string, unknown> = {}): RunEventEnvelope {
  seq += 1
  return { seq, ts: seq, runId: 'run-bus-405', type, payload } as RunEventEnvelope
}

function makeScreenState(url: string): ScreenState {
  return {
    platform: 'web',
    tree: 'root',
    elements: [],
    refMap: {},
    url,
    timestamp: 1_700_000_000_000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 1280,
      viewportHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 2000 },
    },
  }
}

const DECISION_REF: ArtifactRef = {
  id: `decision-screenshot:${DECISION_SHA}`,
  sha: DECISION_SHA,
}

/**
 * The evidence the runner hands the fold — carrying the decision screenshot ref and NOTHING in
 * `artifactRefs`, which is the shipped producer's actual shape (RESEARCH D1: no runner code sets
 * `artifactRefs`, and the decision screenshot was the field that got voided).
 */
function makeSubActionEvidence(): SubActionEvidence {
  return {
    plan: 'Click the Save button',
    plannedAction: { type: 'click', ref: 'e2' } as unknown as Action,
    stateBefore: makeScreenState('https://example.test/before'),
    stateAfter: makeScreenState('https://example.test/after'),
    result: { success: true } as RecordedActionResult,
    decisionScreenshotRef: DECISION_REF,
  }
}

// 2026-10-01 (432-21, D-12): the tokenless caller shape — no scope set or safe-mode flag.
const REGISTRY_CALLER: FunctionCaller = {
  surface: 'dashboard',
  origin: 'human',
}

/**
 * The four REQUIRED ports, minimal by construction. None of them is reached by `runs.detail` —
 * they exist because `FunctionDeps` is non-partial on the read ports, which is itself the
 * contract 387 states: a composition that omits one fails to typecheck.
 */
function depsWith(
  runDetail: FunctionDeps['runDetail'],
  evidenceBlobs?: FunctionDeps['evidenceBlobs'],
  feedbackReads?: FeedbackReadsPort,
  secretMask?: FunctionDeps['secretMask'],
): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: (input: { recordId: string }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId: input.recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: 'agent-qa.config.yaml',
        entries: [],
      }),
    },
    ...(runDetail === undefined ? {} : { runDetail }),
    ...(evidenceBlobs === undefined ? {} : { evidenceBlobs }),
    ...(feedbackReads === undefined ? {} : { feedbackReads }),
    ...(secretMask === undefined ? {} : { secretMask }),
  } as unknown as FunctionDeps
}

function composeRegistry(
  runDetail: FunctionDeps['runDetail'],
  evidenceBlobs?: FunctionDeps['evidenceBlobs'],
  feedbackReads?: FeedbackReadsPort,
  secretMask?: FunctionDeps['secretMask'],
): FunctionRegistry {
  return createFunctionRegistry({
    deps: depsWith(runDetail, evidenceBlobs, feedbackReads, secretMask),
  })
}

/**
 * A host whose `invokeFunction` IS the shipped dispatcher over the shipped registry.
 *
 * The op id is supplied as DATA, exactly as the production composition supplies it — this package
 * may not import the agent package outside a test, so a route that spelled the id itself would be
 * a name nothing type-checks against the spec that answers to it.
 */
function hostOver(registry: FunctionRegistry): AgentHost {
  return {
    registry: registry as unknown as AgentRegistryHandle,
    caller: REGISTRY_CALLER,
    runsPostProcessingFunctionId: 'test:planted-post-processing-op',
    runsEventsFunctionId: 'test:planted-events-op',
    runsDetailFunctionId: RUNS_DETAIL_FUNCTION_ID,
    runsEvidenceFunctionId: RUNS_EVIDENCE_FUNCTION_ID,
    runsArtifactFunctionId: RUNS_ARTIFACT_FUNCTION_ID,
    analysisGetFunctionId: ANALYSIS_GET_FUNCTION_ID,
    // 407-01 (D-05): the sixth dispatched id, widened here so every AgentHost literal in the
    // workspace still satisfies the interface.
    runsKnowledgeFunctionId: RUNS_KNOWLEDGE_FUNCTION_ID,
    runsMarkFunctionId: RUNS_MARK_FUNCTION_ID,
    runsMarksHistoryFunctionId: RUNS_MARKS_HISTORY_FUNCTION_ID,
    runsMarkPreviewFunctionId: RUNS_MARK_PREVIEW_FUNCTION_ID,
    invokeFunction: (
      handle: AgentRegistryHandle,
      functionId: string,
      input: unknown,
      caller: FunctionCaller,
    ): Promise<unknown> =>
      invokeFunction(handle as unknown as FunctionRegistry, functionId, input, caller),
  } as unknown as AgentHost
}

const servers: Server[] = []
const closers: Array<() => void> = []
const databases: DashboardDatabase[] = []
const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true })
  while (closers.length > 0) closers.pop()?.()
  while (servers.length > 0) {
    const server = servers.pop()
    await new Promise<void>((closed) => server?.close(() => closed()))
  }
  while (databases.length > 0) databases.pop()?.close()
  seq = 0
})

interface Answer {
  readonly status: number
  readonly body: unknown
  readonly raw: string
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
  return { status: response.status, body, raw }
}

/**
 * Drive a whole run through the SHIPPED subscriber into a real v2 database, then serve it.
 *
 * `withHost: false` composes the server with no `agentHost` at all — the 503 leg.
 */
async function serveOneRun(options: { withHost?: boolean } = {}): Promise<number> {
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  databases.push(db)

  const ingest = createDashboardRunIngest({
    db,
    sourceSnapshot: { kind: 'test', testId: 't_tracer', name: 'Tracer Test', filePath: 'tests/tracer.yaml', loadStatus: 'loaded' },
    runId: RUN_ID,
    now: () => '2026-08-27T00:00:00.000Z',
  })

  // THE SHIPPED FOLD, called with an identity mask exactly as the pre-masking CLI calls it. The
  // payload below is the one the bus would carry — this cell never hand-builds it.
  const subActionPayload = projectSubActionRecorded(
    makeSubActionEvidence(),
    { testIndex: 0, stepIndex: 0, subActionIndex: 0 },
    (text) => text,
  )

  ingest.handler(ev('runStarted', { memberTestCount: 1 }))
  ingest.handler(ev('testStarted', { testId: 't_tracer', testIndex: 0, name: 'Tracer Test', filePath: 'tests/tracer.yaml', totalSteps: 1 }))
  ingest.handler(ev('stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'Save the record' }))
  ingest.handler(ev('subActionRecorded', subActionPayload as unknown as Record<string, unknown>))
  ingest.handler(ev('stepFinalized', {
    testIndex: 0,
    stepIndex: 0,
    cacheStatus: 'miss',
    verifierVerdict: { pass: true, reasoning: 'record saved' },
    selfHealOccurred: false,
    briefDigest: BRIEF_DIGEST,
    status: 'passed',
    durationMs: 120,
  }))
  ingest.handler(ev('testFinished', { testId: 't_tracer', testIndex: 0, outcome: 'passed', durationMs: 400 }))
  ingest.handler(ev('verdict', { verdict: 'passed' }))
  ingest.handler(ev('runFinished', { aggregateVerdict: 'passed', disposition: 'drained', finalSeq: seq }))
  await ingest.finalize()

  const registry = composeRegistry(createDashboardRunDetailReader(db))
  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    ...(options.withHost === false ? {} : { agentHost: hostOver(registry) }),
  })
  closers.push(started.close)
  return (started.server.address() as AddressInfo).port
}

describe('GET /api/runs/:id/detail', () => {
  it('serves the decision-screenshot artifactRefs sha the producer minted, whole', async () => {
    const port = await serveOneRun()
    const answer = await get(port, `/api/runs/${RUN_ID}/detail`)

    expect(answer.status, answer.raw).toBe(200)
    const body = answer.body as {
      runId: string
      members: Array<{ testIndex: number; attempts: number; outcome?: string; name?: string }>
      steps: Array<{ briefDigest: string; cacheStatus: string; status?: string; stepText?: string; tokenUsage?: unknown }>
      subActions: Array<{ artifactRefs?: Array<{ id: string; sha: string }>; screenStateHash: string; screenStateHashAfter?: string; plan: string }>
      tokens: { measuredSteps: number; unmeasuredSteps: number; totalTokens?: number }
    }

    // THE TRACER'S ONE CLAIM. The sha the fixture minted, read off the wire, unchanged.
    expect(body.subActions).toHaveLength(1)
    expect(body.subActions[0].artifactRefs?.[0].sha, 'the minted sha round-trips whole')
      .toBe(DECISION_SHA)
    expect(body.subActions[0].artifactRefs?.[0].id).toBe(`decision-screenshot:${DECISION_SHA}`)
    expect(body.subActions[0].artifactRefs?.[0].sha).toMatch(/^[0-9a-f]{64}$/)

    // The rest of the payload came through the same rows, unre-interpreted.
    expect(body.runId).toBe(RUN_ID)
    expect(body.steps).toHaveLength(1)
    expect(body.steps[0].briefDigest, 'the served brief digest travels, never the brief').toBe(BRIEF_DIGEST)
    expect(body.steps[0].cacheStatus).toBe('miss')
    expect(body.steps[0].status, "the payload's own word").toBe('passed')
    expect(body.steps[0].stepText).toBe('Save the record')
    expect(body.subActions[0].plan).toBe('Click the Save button')
    // D-02/RESEARCH D2: screen CONTEXT on this bus is the hash pair and nothing else.
    expect(body.subActions[0].screenStateHash).toMatch(/^[0-9a-f]{64}$/)
    expect(body.subActions[0].screenStateHashAfter).toMatch(/^[0-9a-f]{64}$/)
    expect(body.subActions[0].screenStateHashAfter).not.toBe(body.subActions[0].screenStateHash)

    // D-01/D-18: the member row exists, keyed by the handle, with its identity and its outcome.
    expect(body.members).toHaveLength(1)
    expect(body.members[0].testIndex).toBe(0)
    expect(body.members[0].name).toBe('Tracer Test')
    expect(body.members[0].outcome).toBe('passed')
    expect(body.members[0].attempts).toBe(1)

    // D-06 — ABSENT IS NOT ZERO. Nothing on this bus carries `tokenUsage` yet (405-04 lands the
    // producer), so the honest answer names how many steps went unmeasured and offers NO total.
    expect(body.tokens.measuredSteps).toBe(0)
    expect(body.tokens.unmeasuredSteps).toBe(1)
    expect(Object.keys(body.tokens), 'no totalTokens key at all — a zero would be a lie')
      .toEqual(['measuredSteps', 'unmeasuredSteps'])
    expect(body.steps[0].tokenUsage).toBeUndefined()
  })

  it('answers 404 unknown_run for a run nothing recorded — the op mints the refusal', async () => {
    const port = await serveOneRun()
    const answer = await get(port, '/api/runs/r_absent-run-nobody-ever-started/detail')
    expect(answer.status, answer.raw).toBe(404)
    expect(answer.body).toEqual({ error: 'unknown_run' })
  })

  it('answers 503 with no agent host — an unbound door says so, it does not read SQLite', async () => {
    const port = await serveOneRun({ withHost: false })
    const answer = await get(port, `/api/runs/${RUN_ID}/detail`)
    expect(answer.status, answer.raw).toBe(503)
    expect(answer.body).toEqual({ error: 'agent_host_unavailable' })
  })

  it('answers 503 agent_host_unavailable when the composition binds no runDetail port', async () => {
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    databases.push(db)
    const started = await startServer({
      declaredSecretMask: (text) => text,
      db,
      port: 0,
      agentHost: hostOver(composeRegistry(undefined)),
    })
    closers.push(started.close)
    const port = (started.server.address() as AddressInfo).port

    const answer = await get(port, `/api/runs/${RUN_ID}/detail`)
    // The op refuses BY NAME through `FunctionNotBoundError`; the door maps it to 503 and forwards
    // the operator-actionable message rather than answering an empty run.
    expect(answer.status, answer.raw).toBe(503)
    expect((answer.body as { error: string }).error).toBe('agent_host_unavailable')
  })

  it('refuses a run id the op\'s own input schema rejects, before any dispatch', async () => {
    const port = await serveOneRun()
    // `..` is exactly the segment `slugBranch` would REWRITE, which `runIdSchema` refuses instead.
    const answer = await get(port, '/api/runs/..%2Fescape/detail')
    expect(answer.status, answer.raw).toBe(400)
    expect(answer.body).toEqual({ error: 'invalid_run_id' })
  })
})

/** A real PNG head — the magic bytes plus an IHDR-shaped tail, so the sniff is not a one-byte win. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

// 2026-10-14 (441-16, D-06): the production host binds its declared mask; without one runs.evidence
// answers masking-unavailable, so the doors would never reach the recorded evidence.
const declaredMask: NonNullable<FunctionDeps['secretMask']> = (text) => text

async function serveEvidence() {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-423-http-evidence-'))
  roots.push(root)
  const document = {
    schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION as typeof RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
    kind: 'console' as const,
    records: [{ level: 'error', text: '<SECRET_0>', timestamp: 1 }] }
  const ref = new FsEvidenceArtifactStore({ root, runId: RUN_ID }).persistEvidenceDocument(document)
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  databases.push(db)
  db.insertRun({ id: RUN_ID, name: 'Evidence', status: 'passed', duration: 1,
    startedAt: new Date(0).toISOString(), endedAt: new Date(1).toISOString() })
  db.insertRunStep({ runId: RUN_ID, testIndex: 0, stepIndex: 0, cacheStatus: 'miss',
    verifierVerdict: null, selfHealOccurred: false, briefDigest: '', evidence: {
      console: { kind: 'console', state: 'present', ref: ref as never, counts: { total: 1, errors: 1, warnings: 0 } },
      network: { kind: 'network', state: 'absent', reason: 'empty' },
      a11y: { kind: 'a11y', state: 'absent', reason: 'unsupported' },
      variables: { kind: 'variables', state: 'absent', reason: 'not-captured' },
    } })
  const registry = composeRegistry(createDashboardRunDetailReader(db), createEvidenceBlobReader({ agentQaRoot: root }),
    undefined, declaredMask)
  const seen: string[] = []
  const baseHost = hostOver(registry)
  const host: AgentHost = { ...baseHost,
    invokeFunction: (...args) => { seen.push(args[1]); return baseHost.invokeFunction(...args) },
  }
  const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, agentHost: host })
  closers.push(started.close)
  const remote = createServer(createRunServiceRoutes({ agentHost: host } as unknown as RunServicePorts))
  servers.push(remote)
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  return { seen, registry, ref, document,
    local: `http://127.0.0.1:${(started.server.address() as AddressInfo).port}/api/runs/${RUN_ID}`,
    remote: `http://127.0.0.1:${(remote.address() as AddressInfo).port}/run/${RUN_ID}`,
    headers: TOKENLESS_HEADERS,
  }
}

describe('typed evidence HTTP doors', () => {
  const query = '?kind=console&testIndex=0&stepIndex=0'
  it('HTTP-EVIDENCE-HUMAN reaches the recorded evidence through the public operation', async () => {
    const f = await serveEvidence()
    const response = await fetch(`${f.local}/evidence${query}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ outcome: 'ready', evidence: { ref: f.ref }, document: { kind: 'console' } })
    expect(f.seen).toEqual([RUNS_EVIDENCE_FUNCTION_ID])
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
  // RE-SPELLED 2026-10-01 (432-21, D-12/D-13) from 'HTTP-EVIDENCE-MACHINE authenticates before
  // dispatch and never restores': the run service asks for no bearer, so the guard that answers
  // before dispatch is the same-site check; the never-restores claim is unchanged.
  it('HTTP-EVIDENCE-MACHINE guards before dispatch and never restores', async () => {
    const f = await serveEvidence()
    expect((await fetch(`${f.remote}/evidence${query}`, { headers: CROSS_SITE_HEADERS })).status).toBe(403)
    expect(f.seen).toEqual([])
    const response = await fetch(`${f.remote}/evidence${query}`, { headers: f.headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ outcome: 'ready', document: { kind: 'console' } })
    expect(f.seen).toEqual([RUNS_EVIDENCE_FUNCTION_ID])
  })
  it('CROSS-SITE-REFUSED refuses before invocation or restoration', async () => {
    const f = await serveEvidence()
    const response = await fetch(`${f.local}/evidence${query}`, { headers: {
      Origin: 'https://foreign.test', 'Sec-Fetch-Site': 'cross-site',
    } })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'cross_site_refused' })
    expect(f.seen).toEqual([])
  })
  it.each(['testIndex=0&stepIndex=0', 'kind=console&testIndex=&stepIndex=0',
    'kind=console&testIndex=1e0&stepIndex=0', 'kind=console&testIndex=-1&stepIndex=0',
    'kind=console&testIndex=0&stepIndex=0&stepIndex=1',
    'kind=console&testIndex=0&stepIndex=0&extra=synthetic-private',
    'kind=console&testIndex=0&stepIndex=0&subActionIndex=0',
    'kind=aria&testIndex=0&stepIndex=0&subActionIndex=1.5',
  ])('HTTP-EVIDENCE-QUERY refuses ambiguous or invalid address %s', async query => {
    const f = await serveEvidence()
    for (const [origin, headers] of [[f.local, {}], [f.remote, f.headers]] as const) {
      const response = await fetch(`${origin}/evidence?${query}`, { headers })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_evidence_input' })
    }
    expect(f.seen).toEqual([])
  })
  it('RAW-SHA-BYTE-IDENTITY/ETAG/304 preserves the stored JSON on both raw doors and runs.artifact', async () => {
    const f = await serveEvidence()
    const bytes = Buffer.from(JSON.stringify(f.document))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.ref.sha)
    for (const [origin, headers] of [[f.local, {}], [f.remote, f.headers]] as const) {
      const url = `${origin}/artifacts/${f.ref.sha}`
      const response = await fetch(url, { headers })
      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true)
      expect(response.headers.get('etag')).toBe(`"${f.ref.sha}"`)
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      const cached = await fetch(url, { headers: { ...headers, 'If-None-Match': `"${f.ref.sha}"` } })
      expect(cached.status).toBe(304)
      expect(await cached.text()).toBe('')
      expect(cached.headers.get('etag')).toBe(`"${f.ref.sha}"`)
    }
    const result = await invokeFunction(f.registry, RUNS_ARTIFACT_FUNCTION_ID,
      { runId: RUN_ID, sha: f.ref.sha }, REGISTRY_CALLER) as { bytesBase64: string }
    expect(Buffer.from(result.bytesBase64, 'base64').equals(bytes)).toBe(true)
  })
})
// ---- 423-21 (D-18): the two feedback reads on both HTTP doors ---------------------------------
//
// The routes format nothing: the registry's own ops answer through a file-backed read port, so the
// HTTP bodies are compared with a direct invocation of the same registry. The real ledger host
// lives in the CLI, whose mark-preview-history suite drives these same routes over its real stores.
// 2026-09-30, 432-09: the first mark applied a knowledge fix, and its changed record is joined.

const FEEDBACK_NOTE_SECRET = 'synthetic-423-21-note-token'
const FIRST_MARK = 'mark_0123456789ab'
const SECOND_MARK = 'mark_0123456789ac'

function feedbackReceipts(): MarkReceipt[] {
  const base = { schemaVersion: MARK_RECEIPT_SCHEMA_VERSION as typeof MARK_RECEIPT_SCHEMA_VERSION, runId: RUN_ID as MarkReceipt['runId'], testIndex: 0, runSlug: slugBranch(RUN_ID),
    origin: 'user' as const, evidence: { confirmed: 0, overturned: 0 } }
  return [
    { ...base, markId: FIRST_MARK, kind: 'false-fail', ordinal: 1, markedAt: 1, note: `note ${FEEDBACK_NOTE_SECRET}`,
      disposition: { kind: 'applied', fix: 'fact', change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: ['mem_423_21'] } } },
    { ...base, markId: SECOND_MARK, kind: 'confirmed-bug', ordinal: 2, markedAt: 2, supersedes: FIRST_MARK,
      disposition: { kind: 'confirmed-bug', confirmedRecords: 0 } },
  ]
}

const servedRecord = (content: string) => ({ recordId: 'mem_423_21', served: true,
  recordContent: { content, summary: 'checkout timing', kind: 'fact' as const,
    applicability: { product: 'shop', scope: 'shop', anchors: [], openedAtOrdinal: 1 }, currentStatus: 'active' as const,
    currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: [], lastEventOrdinal: 1 } },
  evidence: { kind: 'effects' as const, effects: [{ direction: 'confirm' as const }] } })

function feedbackPreview(runId: string): RunsMarkPreviewResult {
  return RunsMarkPreviewResultSchema.parse({
    kind: 'consequences', runId, prospective: true, markKind: 'false-fail', member: { testIndex: 0 },
    resolvedStep: { stepIndex: 0, reason: 'failing-step' }, latest: { kind: 'supersedes', markId: SECOND_MARK, ordinal: 2 },
    basis: { ledgerOrdinal: 2, priorMarkOrdinal: 2 },
    knowledge: { servedRecordIds: ['mem_423_21'], appendsEvidence: true,
      records: [servedRecord(`timed out near ${FEEDBACK_NOTE_SECRET}`)], evidence: { confirmed: 1, overturned: 0 } },
    draft: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
  })
}

/** A read port over files under `root`: it opens, parses and returns; it never creates or writes. */
function fileFeedbackReads(root: string, calls: string[], options: { withPreview?: boolean } = {}): FeedbackReadsPort {
  const runDir = (runId: string) => join(root, 'runs', slugBranch(runId))
  return {
    history: async (runId) => {
      calls.push('history')
      if (!existsSync(runDir(runId))) return { kind: 'run-not-found' }
      const receipts = JSON.parse(readFileSync(join(runDir(runId), 'marks.json'), 'utf8')) as MarkReceipt[]
      return { kind: 'history', entries: receipts.map(receipt => receipt.disposition.kind === 'applied'
        ? { receipt, changedRecords: [{ recordId: 'mem_423_21', contentAbsence: { reason: 'not-bound' as const } }] } : { receipt }) }
    },
    ...(options.withPreview === false ? {} : {
      preview: async (input: RunsMarkInput) => {
        calls.push('preview')
        if (!existsSync(runDir(input.runId))) return { kind: 'run-not-found', runId: input.runId }
        return JSON.parse(readFileSync(join(runDir(input.runId), 'preview.json'), 'utf8')) as RunsMarkPreviewResult
      },
    }),
  }
}

function pathMap(root: string): [string, string][] {
  const walk = (path: string): [string, string][] => lstatSync(path).isDirectory()
    ? [[path, 'dir'], ...readdirSync(path).sort().flatMap(name => walk(join(path, name)))]
    : [[path, createHash('sha256').update(readFileSync(path)).digest('hex')]]
  return walk(root)
}

async function serveFeedbackReads(options: { withPreview?: boolean; unbound?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-423-21-feedback-http-'))
  roots.push(root)
  mkdirSync(join(root, 'runs', slugBranch(RUN_ID)), { recursive: true })
  writeFileSync(join(root, 'runs', slugBranch(RUN_ID), 'marks.json'), JSON.stringify(feedbackReceipts()))
  writeFileSync(join(root, 'runs', slugBranch(RUN_ID), 'preview.json'), JSON.stringify(feedbackPreview(RUN_ID)))
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  databases.push(db)
  const portCalls: string[] = []
  const registry = composeRegistry(createDashboardRunDetailReader(db), undefined,
    options.unbound === true ? undefined : fileFeedbackReads(root, portCalls, options),
    (text) => text.replaceAll(FEEDBACK_NOTE_SECRET, '[secret:FEEDBACK_441]'))
  const seen: string[] = []
  const baseHost = hostOver(registry)
  const host: AgentHost = { ...baseHost,
    invokeFunction: (...args) => { seen.push(args[1]); return baseHost.invokeFunction(...args) },
  }
  const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, agentHost: host })
  closers.push(started.close)
  const remote = createServer(createRunServiceRoutes({ agentHost: host } as unknown as RunServicePorts))
  servers.push(remote)
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  return { root, db, registry, seen, portCalls,
    local: `http://127.0.0.1:${(started.server.address() as AddressInfo).port}/api/runs`,
    remote: `http://127.0.0.1:${(remote.address() as AddressInfo).port}/run`,
    headers: TOKENLESS_HEADERS,
  }
}

/** The same routes on a real socket, with a host that answers one planted body for every op. */
async function servePlantedHost(body: unknown) {
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  databases.push(db)
  const host = { ...hostOver(composeRegistry(undefined)),
    invokeFunction: () => Promise.resolve(body),
  } as AgentHost
  const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, agentHost: host })
  closers.push(started.close)
  const remote = createServer(createRunServiceRoutes({ agentHost: host } as unknown as RunServicePorts))
  servers.push(remote)
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  return {
    local: `http://127.0.0.1:${(started.server.address() as AddressInfo).port}/api/runs/${RUN_ID}`,
    remote: `http://127.0.0.1:${(remote.address() as AddressInfo).port}/run/${RUN_ID}`,
    headers: TOKENLESS_HEADERS,
  }
}

const previewInput = (runId: string = RUN_ID): RunsMarkInput =>
  ({ runId: runId as RunsMarkInput['runId'], kind: 'false-fail', note: `preview ${FEEDBACK_NOTE_SECRET}` })

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('feedback reads on both HTTP doors', () => {
  it('HTTP-MARKS-HISTORY: both doors answer runs.marks.history exactly as the registry does, guarded and masked', async () => {
    const f = await serveFeedbackReads()
    const expected = await invokeFunction(f.registry, RUNS_MARKS_HISTORY_FUNCTION_ID, { runId: RUN_ID }, REGISTRY_CALLER)
    expect(JSON.stringify(expected)).not.toContain(FEEDBACK_NOTE_SECRET)
    expect(RunsMarksHistoryResultSchema.parse(expected)).toMatchObject({ kind: 'history', entries: [
      { markId: FIRST_MARK, active: false, supersededBy: SECOND_MARK,
        changedRecords: [{ recordId: 'mem_423_21', contentAbsence: { reason: 'not-bound' } }] },
      { markId: SECOND_MARK, active: true, supersedes: FIRST_MARK },
    ] })
    f.seen.length = 0

    const local = await fetch(`${f.local}/${RUN_ID}/marks`)
    expect(local.status).toBe(200)
    expect(local.headers.get('access-control-allow-origin')).toBeNull()
    expect(await local.json()).toEqual(expected)
    expect(f.seen).toEqual([RUNS_MARKS_HISTORY_FUNCTION_ID])

    f.seen.length = 0
    expect((await fetch(`${f.remote}/${RUN_ID}/marks`, { headers: CROSS_SITE_HEADERS })).status).toBe(403)
    expect(f.seen).toEqual([])
    const remote = await fetch(`${f.remote}/${RUN_ID}/marks`, { headers: f.headers })
    expect(remote.status).toBe(200)
    expect(await remote.json()).toEqual(expected)
    expect(f.seen).toEqual([RUNS_MARKS_HISTORY_FUNCTION_ID])

    // Typed outcomes are results, not transport errors, on both doors.
    const unknownRun = 'r_no-such-run-was-ever-marked-here-at-all'
    const missing = await invokeFunction(f.registry, RUNS_MARKS_HISTORY_FUNCTION_ID, { runId: unknownRun }, REGISTRY_CALLER)
    for (const [origin, headers] of [[f.local, {}], [f.remote, f.headers]] as const) {
      const answer = await fetch(`${origin}/${unknownRun}/marks`, { headers })
      expect(answer.status).toBe(200)
      expect(await answer.json()).toEqual(missing)
    }

    f.seen.length = 0
    const crossSite = await fetch(`${f.local}/${RUN_ID}/marks`, { headers: { Origin: 'https://foreign.test', 'Sec-Fetch-Site': 'cross-site' } })
    expect(crossSite.status).toBe(403)
    expect(await crossSite.json()).toEqual({ error: 'cross_site_refused' })
    for (const [origin, headers] of [[f.local, {}], [f.remote, f.headers]] as const) {
      const extra = await fetch(`${origin}/${RUN_ID}/marks?runId=${RUN_ID}`, { headers })
      expect(extra.status).toBe(400)
      expect(await extra.json()).toEqual({ error: 'invalid_marks_input' })
      const invalid = await fetch(`${origin}/..%2Fescape/marks`, { headers })
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: 'invalid_run_id' })
    }
    expect(f.seen, 'refusals precede dispatch').toEqual([])

    const unbound = await serveFeedbackReads({ unbound: true })
    for (const [origin, headers] of [[unbound.local, {}], [unbound.remote, unbound.headers]] as const) {
      const answer = await fetch(`${origin}/${RUN_ID}/marks`, { headers })
      expect(answer.status).toBe(503)
      expect((await answer.json() as { error: string }).error).toBe('agent_host_unavailable')
    }

    // 441-15 (D-07): both doors answer a stored marker and an old placeholder as they are.
    const history = RunsMarksHistoryResultSchema.parse(expected)
    if (history.kind !== 'history') throw new Error('expected a history result')
    const withNote = (note: string) => ({ ...history, entries: history.entries.map((entry, index) => index === 0 ? { ...entry, note } : entry) })
    const stored = withNote('note [secret:PW_441] and <SECRET_1>')
    const planted = await servePlantedHost(stored)
    const human = await fetch(`${planted.local}/marks`)
    expect(human.status).toBe(200)
    expect(await human.text()).toBe(JSON.stringify(stored))
    const machine = await fetch(`${planted.remote}/marks`, { headers: planted.headers })
    expect(await machine.text()).toBe(JSON.stringify(stored))
  })

  it('HTTP-MARK-PREVIEW: both doors POST the exact runs.mark input to runs.mark.preview and answer as the registry does', async () => {
    const f = await serveFeedbackReads()
    const expected = await invokeFunction(f.registry, RUNS_MARK_PREVIEW_FUNCTION_ID, previewInput(), REGISTRY_CALLER)
    expect(JSON.stringify(expected)).not.toContain(FEEDBACK_NOTE_SECRET)
    expect(RunsMarkPreviewResultSchema.parse(expected)).toMatchObject({ kind: 'consequences', prospective: true })
    f.seen.length = 0
    f.portCalls.length = 0

    const local = await postJson(`${f.local}/${RUN_ID}/mark-preview`, previewInput())
    expect(local.status).toBe(200)
    expect(local.headers.get('access-control-allow-origin')).toBeNull()
    expect(await local.json()).toEqual(expected)
    expect(f.seen[0]).toBe(RUNS_MARK_PREVIEW_FUNCTION_ID)
    expect(f.seen).not.toContain(RUNS_MARK_FUNCTION_ID)

    f.seen.length = 0
    expect((await postJson(`${f.remote}/${RUN_ID}/mark-preview`, previewInput(), CROSS_SITE_HEADERS)).status).toBe(403)
    expect(f.seen).toEqual([])
    const remote = await postJson(`${f.remote}/${RUN_ID}/mark-preview`, previewInput(), f.headers)
    expect(remote.status).toBe(200)
    expect(await remote.json()).toEqual(expected)
    expect(f.seen).toEqual([RUNS_MARK_PREVIEW_FUNCTION_ID])
    expect(f.portCalls).toEqual(['preview', 'preview'])

    f.seen.length = 0
    const crossSite = await postJson(`${f.local}/${RUN_ID}/mark-preview`, previewInput(),
      { Origin: 'https://foreign.test', 'Sec-Fetch-Site': 'cross-site' })
    expect(crossSite.status).toBe(403)
    expect(await crossSite.json()).toEqual({ error: 'cross_site_refused' })
    const otherRun = 'r_another-run-the-url-does-not-name-at-all-here'
    const { runId: _omitted, ...withoutRunId } = previewInput()
    const refusals: Array<[unknown, string]> = [
      [previewInput(otherRun), 'run_id_mismatch'],
      [withoutRunId, 'invalid_mark_preview_input'],
      [{ ...previewInput(), confirmScope: 'scope-1' }, 'invalid_mark_preview_input'],
      [{ ...previewInput(), basis: { ledgerOrdinal: 2 } }, 'invalid_mark_preview_input'],
      [{ ...previewInput(), kind: 'not-a-mark' }, 'invalid_mark_preview_input'],
      [[previewInput()], 'invalid_mark_preview_input'],
      ['{"runId":', 'invalid_mark_preview_input'],
    ]
    for (const [origin, headers] of [[f.local, {}], [f.remote, f.headers]] as const) {
      for (const [body, error] of refusals) {
        const answer = await postJson(`${origin}/${RUN_ID}/mark-preview`, body, headers)
        expect(answer.status, JSON.stringify(body)).toBe(400)
        expect(await answer.json()).toEqual({ error })
      }
      expect((await fetch(`${origin}/${RUN_ID}/mark-preview`, { headers })).status, 'preview is POST only').not.toBe(200)
    }
    expect(f.seen, 'refusals precede dispatch').toEqual([])

    // Typed refusals are the op's own outcomes and travel as results.
    const unknownRun = 'r_no-such-run-was-ever-marked-here-at-all'
    const missing = await invokeFunction(f.registry, RUNS_MARK_PREVIEW_FUNCTION_ID, previewInput(unknownRun), REGISTRY_CALLER)
    for (const [origin, headers] of [[f.local, {}], [f.remote, f.headers]] as const) {
      const answer = await postJson(`${origin}/${unknownRun}/mark-preview`, previewInput(unknownRun), headers)
      expect(answer.status).toBe(200)
      expect(await answer.json()).toEqual(missing)
    }

    const historyOnly = await serveFeedbackReads({ withPreview: false })
    for (const [origin, headers] of [[historyOnly.local, {}], [historyOnly.remote, historyOnly.headers]] as const) {
      const answer = await postJson(`${origin}/${RUN_ID}/mark-preview`, previewInput(), headers)
      expect(answer.status).toBe(503)
      expect(await answer.json()).toMatchObject({ error: 'agent_host_unavailable' })
    }

    // 441-15 (D-07): both doors answer a stored marker and an old placeholder as they are.
    const consequences = feedbackPreview(RUN_ID) as Extract<RunsMarkPreviewResult, { kind: 'consequences' }>
    const stored = RunsMarkPreviewResultSchema.parse({ ...consequences, knowledge: { ...consequences.knowledge,
      records: [servedRecord('near [secret:PW_441] and <SECRET_1>')] } })
    const planted = await servePlantedHost(stored)
    const human = await postJson(`${planted.local}/mark-preview`, previewInput())
    expect(human.status).toBe(200)
    expect(await human.text()).toBe(JSON.stringify(stored))
    const machine = await postJson(`${planted.remote}/mark-preview`, previewInput(), planted.headers)
    expect(await machine.text()).toBe(JSON.stringify(stored))
  })

  it('FEEDBACK-HTTP-WRITES-NOTHING: every feedback HTTP leg leaves the read store and the dashboard rows unchanged', async () => {
    const f = await serveFeedbackReads()
    const before = pathMap(f.root)
    const rowsBefore = JSON.stringify(f.db.readRunDetailRows(RUN_ID))
    for (const [origin, headers] of [[f.local, {}], [f.remote, f.headers]] as const) {
      expect((await fetch(`${origin}/${RUN_ID}/marks`, { headers })).status).toBe(200)
      expect((await postJson(`${origin}/${RUN_ID}/mark-preview`, previewInput(), headers)).status).toBe(200)
      expect((await postJson(`${origin}/${RUN_ID}/mark-preview`, previewInput('r_another-run-the-url-does-not-name-at-all-here'), headers)).status).toBe(400)
      expect((await fetch(`${origin}/r_no-such-run-was-ever-marked-here-at-all/marks`, { headers })).status).toBe(200)
      expect((await postJson(`${origin}/r_no-such-run-was-ever-marked-here-at-all/mark-preview`,
        previewInput('r_no-such-run-was-ever-marked-here-at-all'), headers)).status).toBe(200)
    }
    expect(pathMap(f.root)).toEqual(before)
    expect(existsSync(join(f.root, 'runs', slugBranch('r_no-such-run-was-ever-marked-here-at-all')))).toBe(false)
    expect(JSON.stringify(f.db.readRunDetailRows(RUN_ID))).toBe(rowsBefore)
    expect([...f.seen].sort()).toEqual([
      RUNS_MARK_PREVIEW_FUNCTION_ID, RUNS_MARK_PREVIEW_FUNCTION_ID, RUNS_MARK_PREVIEW_FUNCTION_ID, RUNS_MARK_PREVIEW_FUNCTION_ID,
      RUNS_MARKS_HISTORY_FUNCTION_ID, RUNS_MARKS_HISTORY_FUNCTION_ID, RUNS_MARKS_HISTORY_FUNCTION_ID, RUNS_MARKS_HISTORY_FUNCTION_ID,
    ])
    expect(f.seen).not.toContain(RUNS_MARK_FUNCTION_ID)
    expect(f.portCalls.sort()).toEqual(['history', 'history', 'history', 'history', 'preview', 'preview', 'preview', 'preview'])
  })
})

/** Bytes that WANT to be a document. The sniffer has no arm that can grant it (T-405-15). */
const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
)

interface ServedArtifact {
  readonly port: number
  readonly sha: string
  readonly root: string
}

/**
 * Write ONE blob through the shipped store, bind the shipped reader over the same root, serve it.
 *
 * THE STORE MINTS THE SHA, THIS FILE NEVER DOES. `persistDecisionScreenshot` content-addresses the
 * bytes and returns the ref; using its sha is what makes the round trip a claim about the content
 * address rather than about two hex strings that happen to match.
 */
async function serveOneArtifact(
  options: { readonly bytes: Uint8Array; readonly withHost?: boolean },
): Promise<ServedArtifact> {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-405-05-'))
  roots.push(root)
  const ref = new FsEvidenceArtifactStore({ root, runId: RUN_ID })
    .persistDecisionScreenshot(options.bytes)

  const db = new DashboardDatabase({ dbPath: ':memory:' })
  databases.push(db)
  const registry = composeRegistry(
    createDashboardRunDetailReader(db),
    createEvidenceBlobReader({ agentQaRoot: root }),
  )
  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    ...(options.withHost === false ? {} : { agentHost: hostOver(registry) }),
  })
  closers.push(started.close)
  return { port: (started.server.address() as AddressInfo).port, sha: ref.sha, root }
}

// ---- 405-05 (D-12/D-13/D-15 · DETL-03): the ref RESOLVES — a sha becomes immutable bytes -------
//
// THE SECOND HALF OF THE TRACER'S CLAIM. The cells above prove a minted `ArtifactRef` reaches a
// browser as a sha; these prove that sha resolves to the exact bytes the runner wrote, with the
// headers a content address earns. Nothing here is faked below the route: the blob is written by
// the SHIPPED `FsEvidenceArtifactStore` under a real temp root, read back by the SHIPPED
// `createEvidenceBlobReader`, served by the SHIPPED op through the SHIPPED registry, over a real
// socket — so the arm's POSITION in `routes.ts` (above the `/api/runs/:id` catch-all, which claims
// every four-segment GET) is inside the claim rather than assumed.
//
// AND THE REFUSALS ARE THE POINT AS MUCH AS THE BYTES. `getBlob` answers `undefined` for a
// malformed sha and for an absent file alike; a door that could not tell those apart would render
// one grey error for a bad link, a GC'd screenshot and a traversal attempt.

describe('GET /api/runs/:runId/artifacts/:sha — the ref resolves', () => {
  it('serves the exact bytes under a content address, immutably and with nosniff', async () => {
    const served = await serveOneArtifact({ bytes: PNG_BYTES })
    const response = await fetch(
      `http://127.0.0.1:${String(served.port)}/api/runs/${RUN_ID}/artifacts/${served.sha}`,
    )

    expect(response.status).toBe(200)
    // THE BYTES, WHOLE. Not a length, not a hash of what came back — the array itself.
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES)

    // D-12's header set, each one load-bearing and each one asserted rather than sampled.
    expect(response.headers.get('etag'), 'the content address IS the validator').toBe(`"${served.sha}"`)
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('x-content-type-options'), 'T-405-15').toBe('nosniff')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
  })

  it('answers 304 for a matching If-None-Match, with no body at all', async () => {
    const served = await serveOneArtifact({ bytes: PNG_BYTES })
    const response = await fetch(
      `http://127.0.0.1:${String(served.port)}/api/runs/${RUN_ID}/artifacts/${served.sha}`,
      { headers: { 'If-None-Match': `"${served.sha}"` } },
    )
    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
    // The validator still travels, so a cache that revalidates keeps the same entry.
    expect(response.headers.get('etag')).toBe(`"${served.sha}"`)
  })

  it('refuses a malformed sha with a fixed body that never echoes the request', async () => {
    const served = await serveOneArtifact({ bytes: PNG_BYTES })
    const base = `http://127.0.0.1:${String(served.port)}/api/runs/${RUN_ID}/artifacts`

    // 64 characters and not hex: long enough to look like a sha, refused by the CONTRACT.
    const notHex = 'z'.repeat(64)
    const nonHexAnswer = await fetch(`${base}/${notHex}`)
    expect(nonHexAnswer.status).toBe(400)
    const nonHexBody = await nonHexAnswer.text()
    expect(JSON.parse(nonHexBody)).toEqual({ error: 'malformed_sha' })
    expect(nonHexBody, 'the refusal never quotes the caller\'s own bytes').not.toContain(notHex)

    // A traversal-shaped sha is refused by the SAME regex, before any path could be assembled.
    const traversal = await fetch(`${base}/${encodeURIComponent('../../etc/passwd')}`)
    expect(traversal.status).toBe(400)
    expect(await traversal.json()).toEqual({ error: 'malformed_sha' })

    // An UPPERCASE 64-hex sha names a file the store cannot have written, and is refused as
    // malformed rather than reported as an honest miss.
    const upper = await fetch(`${base}/${served.sha.toUpperCase()}`)
    expect(upper.status).toBe(400)
    expect(await upper.json()).toEqual({ error: 'malformed_sha' })
  })

  it('tells an unknown RUN from an absent BLOB — two 404s, two words', async () => {
    const served = await serveOneArtifact({ bytes: PNG_BYTES })
    const origin = `http://127.0.0.1:${String(served.port)}`

    // A well-formed sha under a run this root has no directory for.
    const unknownRun = await fetch(
      `${origin}/api/runs/r_no-such-run-was-ever-started-here-at-all/artifacts/${served.sha}`,
    )
    expect(unknownRun.status).toBe(404)
    expect(await unknownRun.json()).toEqual({ error: 'unknown_run' })

    // A well-formed sha under a run that DOES exist and holds no such blob.
    const absentSha = 'b'.repeat(64)
    const blobAbsent = await fetch(`${origin}/api/runs/${RUN_ID}/artifacts/${absentSha}`)
    expect(blobAbsent.status).toBe(404)
    const absentBody = await blobAbsent.text()
    expect(JSON.parse(absentBody)).toEqual({ error: 'blob_absent' })
    expect(absentBody, 'no refusal on this door echoes the requested sha').not.toContain(absentSha)
  })

  it('answers 503 with no agent host — an unbound door says so, it opens no store', async () => {
    const served = await serveOneArtifact({ bytes: PNG_BYTES, withHost: false })
    const response = await fetch(
      `http://127.0.0.1:${String(served.port)}/api/runs/${RUN_ID}/artifacts/${served.sha}`,
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'agent_host_unavailable' })
  })

  it('refuses a run id the op\'s own input schema rejects, touching no filesystem', async () => {
    const served = await serveOneArtifact({ bytes: PNG_BYTES })
    const response = await fetch(
      `http://127.0.0.1:${String(served.port)}/api/runs/%2e%2e%2fescape/artifacts/${served.sha}`,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_run_id' })

    // AND THE ROOT IS UNTOUCHED. The refusal happens at the contract, so nothing under the runs
    // root was created, read or walked on the way to it — which is the claim a status code alone
    // cannot make.
    expect(readdirSync(join(served.root, 'runs')).sort()).toEqual([slugBranch(RUN_ID)])
  })

  it('serves a JPEG as image/jpeg and an unrecognised blob as an opaque download', async () => {
    const jpeg = await serveOneArtifact({ bytes: JPEG_BYTES })
    const jpegAnswer = await fetch(
      `http://127.0.0.1:${String(jpeg.port)}/api/runs/${RUN_ID}/artifacts/${jpeg.sha}`,
    )
    expect(jpegAnswer.headers.get('content-type')).toBe('image/jpeg')

    // An SVG document is bytes like any other, and it must NEVER be typed as one a browser
    // renders — `nosniff` plus `application/octet-stream` is a download, not a script.
    const svg = await serveOneArtifact({ bytes: SVG_BYTES })
    const svgAnswer = await fetch(
      `http://127.0.0.1:${String(svg.port)}/api/runs/${RUN_ID}/artifacts/${svg.sha}`,
    )
    expect(svgAnswer.headers.get('content-type')).toBe('application/octet-stream')
    expect(svgAnswer.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await svgAnswer.arrayBuffer())).toEqual(SVG_BYTES)
  })
})

describe('the artifact arm reads no store of its own', () => {
  it('routes.ts names the evidence store nowhere — the bytes cross the function layer', async () => {
    const source = await readFile(new URL('../../server/routes.ts', import.meta.url), 'utf8')
    // A SOURCE ASSERTION, because the claim is about where a capability LIVES rather than about
    // what a response contains: a route that constructed the store would serve byte-identical
    // bytes and be invisible to every response-shape cell in this file — while being a private
    // store read no roster row covers and no audit sink sees.
    expect(source).not.toContain('FsEvidenceArtifactStore')
    expect(source).toContain('serveRunArtifact')
  })
})

/** A `ServerResponse` stand-in that records the one write the adapter makes. */
function recordingResponse(): {
  res: ServerResponse
  status: () => number
  raw: () => string
  done: Promise<void>
} {
  let status = 0
  let raw = ''
  let settle: () => void = () => undefined
  const done = new Promise<void>((resolve) => { settle = resolve })
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code: number): void { status = code },
    end(body?: string): void {
      raw = body ?? ''
      ;(res as { writableEnded: boolean }).writableEnded = true
      settle()
    },
    destroy(): void { settle() },
  } as unknown as ServerResponse
  return { res, status: () => status, raw: () => raw, done }
}

/** A host whose every op answers one planted body. */
function plantedHost(body: unknown): AgentHost {
  return {
    registry: {} as unknown as AgentRegistryHandle,
    caller: REGISTRY_CALLER,
    runsPostProcessingFunctionId: 'test:planted-post-processing-op',
    runsEventsFunctionId: 'test:planted-events-op',
    runsDetailFunctionId: RUNS_DETAIL_FUNCTION_ID,
    runsArtifactFunctionId: RUNS_ARTIFACT_FUNCTION_ID,
    analysisGetFunctionId: ANALYSIS_GET_FUNCTION_ID,
    runsKnowledgeFunctionId: RUNS_KNOWLEDGE_FUNCTION_ID,
    invokeFunction: () => Promise.resolve(body),
  } as unknown as AgentHost
}

/** A projection shaped like the real one, with stored text in every string channel the page reads. */
function storedProjection(text: string): Record<string, unknown> {
  return {
    runId: RUN_ID,
    members: [{ testIndex: 0, attempts: 1, failureSummary: `failed near ${text}` }],
    steps: [{ stepIndex: 0, stepText: `Navigate to ${text}`, error: `timeout on ${text}` }],
    subActions: [{ subActionIndex: 0, plan: `Type ${text}`, plannedAction: `{"value":"${text}"}` }],
    tokens: { measuredSteps: 0, unmeasuredSteps: 1 },
  }
}

describe('serveRunDetailRead', () => {
  it('serves the stored projection unchanged', async () => {
    const projection = storedProjection('<SECRET_0>')
    const recorder = recordingResponse()

    serveRunDetailRead(
      { headers: { host: '127.0.0.1:3470' } } as never,
      recorder.res,
      { runId: RUN_ID, host: plantedHost(projection) },
    )
    await recorder.done

    expect(recorder.status()).toBe(200)
    expect(recorder.raw()).toBe(JSON.stringify(projection))
  })

  it('serves the same projection at a non-loopback Host, because its door decides who may call', async () => {
    const projection = storedProjection('<SECRET_0>')
    const recorder = recordingResponse()

    serveRunDetailRead(
      { headers: { host: 'runs.example.com' } } as never,
      recorder.res,
      { runId: RUN_ID, host: plantedHost(projection) },
    )
    await recorder.done

    expect(recorder.status()).toBe(200)
    expect(recorder.raw()).toBe(JSON.stringify(projection))
  })
})

// ---- 441-15 (D-07): the dashboard shows what was stored and restores nothing ----------------------

async function serveBothDoors(body: unknown) {
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  databases.push(db)
  const host = plantedHost(body)
  const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, agentHost: host })
  closers.push(started.close)
  const remote = createServer(createRunServiceRoutes({ agentHost: host } as unknown as RunServicePorts))
  servers.push(remote)
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  return {
    local: `http://127.0.0.1:${(started.server.address() as AddressInfo).port}/api/runs/${RUN_ID}`,
    remote: `http://127.0.0.1:${(remote.address() as AddressInfo).port}/run/${RUN_ID}`,
  }
}

describe('stored markers on display', () => {
  it('the human door serves a stored marker unchanged', async () => {
    const projection = storedProjection('[secret:PW_441]')
    const doors = await serveBothDoors(projection)

    for (const url of [`${doors.local}/detail`, `${doors.remote}/detail`]) {
      const response = await fetch(url, { headers: TOKENLESS_HEADERS })
      expect(response.status, url).toBe(200)
      expect(await response.text(), url).toBe(JSON.stringify(projection))
    }
  })

  it('no dashboard route restores or rewrites stored text', async () => {
    const body = storedProjection('<SECRET_0> beside [secret:PW_441]')
    const doors = await serveBothDoors(body)

    for (const url of [
      `${doors.local}/detail`,
      `${doors.local}/analysis`,
      `${doors.local}/knowledge`,
      `${doors.remote}/detail`,
      `${doors.remote}/analysis`,
    ]) {
      const response = await fetch(url, { headers: TOKENLESS_HEADERS })
      expect(response.status, url).toBe(200)
      expect(await response.text(), url).toBe(JSON.stringify(body))
    }
  })
})
