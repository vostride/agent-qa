// `GET /api/runs/:id/knowledge` — the Knowledge panel's door (Phase 407 plan 01, D-05/D-06).
//
// WHY A REAL REGISTRY AND NOT A PLANTED HOST for the first four cells. `runs.knowledge` is where
// the `evidence-incomplete` arm is decided, where the input schema refuses an id and where the
// unbound-op refusal is minted; a fixture that answered this route's `invokeFunction` itself would
// be a second implementation of all three, green about a path this product does not ship.
// `@vostride/agent-qa-agent` is a DEV dependency of this package for exactly that reason —
// `validate:arch` walks `src` with `__tests__` excluded and reconciles only runtime
// `dependencies`, so the production edge it forbids stays forbidden.
//
// THE ADAPTER FUNCTION AND THE SOCKET, EACH FOR WHAT ONLY IT CAN SEE. The read's own vocabulary —
// the refusal statuses, the stored body, the cross-site guard — is measured through a recording
// response, which keeps each claim about one thing. Two facts live ABOVE that function and are
// driven over a real socket at the bottom of this file: the arm's POSITION in `routes.ts` (the
// `/api/runs/:id` catch-all below it claims every four-segment GET and answers `Not found`, which
// is RESEARCH Pitfall 2) and the conditional host spread in `server.ts`. A suite that only called
// the adapter would stay green with the arm registered in the wrong place.
//
// THE CENTRAL CLAIM, AND IT IS THE ONE A CARELESS COPY OF `run-detail-routes.ts` WOULD BREAK: an
// unknown run answers 200 `evidence-incomplete`, NOT 404 `unknown_run`. `runs.detail` throws
// `RunNotFoundError` for a run it cannot load; `runs.knowledge` returns (D-06), because a page
// whose evidence has been garbage-collected has a legible state to render and a refusal would make
// that state indistinguishable from a broken read.

import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  ANALYSIS_GET_FUNCTION_ID,
  RUNS_ARTIFACT_FUNCTION_ID,
  RUNS_DETAIL_FUNCTION_ID,
  RUNS_KNOWLEDGE_FUNCTION_ID,
  createFunctionRegistry,
  invokeFunction,
  type FunctionDeps,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import { CURRENT_HANDOFF_SCHEMA_VERSION, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  ScopeKey,
  ServedBrief,
  StepEvidence,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentHost, AgentRegistryHandle } from '../../chat/host.js'
import { DashboardDatabase } from '../../db/database.js'
import { startServer } from '../../server/server.js'
import { readRunKnowledge, serveRunKnowledgeRead } from '../run-knowledge-routes.js'

const servers: Server[] = []
const closers: Array<() => void> = []
const databases: DashboardDatabase[] = []

afterEach(async () => {
  while (closers.length > 0) closers.pop()?.()
  while (servers.length > 0) {
    const server = servers.pop()
    await new Promise<void>((closed) => server?.close(() => closed()))
  }
  while (databases.length > 0) databases.pop()?.close()
})

const RUN_ID = 'r_knowledge-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel'
const SCOPE: ScopeKey = { tier: 'product', key: 'shop' }

// 2026-10-01 (432-21, D-12): the tokenless caller shape — no scope set or safe-mode flag.
const REGISTRY_CALLER: FunctionCaller = {
  surface: 'dashboard',
  origin: 'human',
}

function brief(overrides: Partial<ServedBrief> = {}): ServedBrief {
  return {
    scope: SCOPE,
    asOfBuild: 4,
    budget: 200,
    truncation: '',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: 'digest-knowledge',
    ...overrides,
  }
}

function step(stepIndex: number, stepText: string): StepEvidence {
  return {
    stepIndex,
    stepText,
    cacheStatus: 'miss',
    servedBrief: brief(),
    subActions: [],
    verifierVerdict: { pass: true, reasoning: 'ok' },
  }
}

/** One recorded run, shaped exactly as the handoff store answers with. */
function recordedRun(stepText = 'Sign in as the demo user'): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: RUN_ID,
    scope: SCOPE,
    buildOrdinal: 4,
    executionContext: 'local',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite-a', testConfigDigest: 'test-a' },
    startedAt: 1,
    endedAt: 2,
    tests: [{
      testId: 't_knowledge',
      testName: 'Knowledge Test',
      filePath: 'tests/knowledge.yaml',
      testIndex: 0,
      outcome: 'passed',
      steps: [step(0, stepText)],
    }],
  } as unknown as CompletedRunHandoff
}

function depsOver(document: CompletedRunHandoff | undefined): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve(document === undefined ? [] : [document]),
      get: () => Promise.resolve(document),
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
  } as unknown as FunctionDeps
}

function composeRegistry(document: CompletedRunHandoff | undefined): FunctionRegistry {
  return createFunctionRegistry({
    deps: { ...depsOver(document), secretMask: (text: string) => text },
  })
}

/**
 * A host over the SHIPPED registry and the SHIPPED `invokeFunction`.
 *
 * `knowledgeFunctionId` is a parameter so the "registry does not bind the op" cell can point the
 * host at a name no spec answers to — which is what a composition that forgot to pass the id
 * actually looks like from this route's side.
 */
function hostOver(
  registry: FunctionRegistry,
  options: { knowledgeFunctionId?: string } = {},
): AgentHost {
  return {
    registry: registry as unknown as AgentRegistryHandle,
    caller: REGISTRY_CALLER,
    runsPostProcessingFunctionId: 'test:planted-post-processing-op',
    runsEventsFunctionId: 'test:planted-events-op',
    runsDetailFunctionId: RUNS_DETAIL_FUNCTION_ID,
    runsArtifactFunctionId: RUNS_ARTIFACT_FUNCTION_ID,
    analysisGetFunctionId: ANALYSIS_GET_FUNCTION_ID,
    runsKnowledgeFunctionId: options.knowledgeFunctionId ?? RUNS_KNOWLEDGE_FUNCTION_ID,
    invokeFunction: (
      handle: AgentRegistryHandle,
      functionId: string,
      input: unknown,
      caller: FunctionCaller,
    ): Promise<unknown> =>
      invokeFunction(handle as unknown as FunctionRegistry, functionId, input, caller),
  } as unknown as AgentHost
}

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

/** A loopback request, which is what the human arm's same-site guard admits. */
const LOOPBACK = { headers: { host: '127.0.0.1:3470' } } as never

describe('GET /api/runs/:id/knowledge — the read', () => {
  it('answers 200 with a ready projection for a recorded run', async () => {
    const outcome = await readRunKnowledge(hostOver(composeRegistry(recordedRun())), RUN_ID)

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.body.kind).toBe('ready')
    expect(outcome.body.runId).toBe(RUN_ID)
    if (outcome.body.kind !== 'ready') return
    expect(outcome.body.steps).toHaveLength(1)
  })

  it('answers 200 evidence-incomplete for an unknown run — the op RETURNS, it does not throw', async () => {
    // THE CELL THIS FILE EXISTS FOR. `runs.detail` would raise `RunNotFoundError` here and this
    // door would classify it 404 `unknown_run`; `runs.knowledge` does not, because the page has a
    // state to render for a pruned handoff and a refusal would hide it behind a grey error.
    const outcome = await readRunKnowledge(hostOver(composeRegistry(undefined)), RUN_ID)

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.body).toEqual({ kind: 'evidence-incomplete', runId: RUN_ID })
  })

  it('refuses an id the op schema rejects with 400, and never reaches a dispatch', async () => {
    let dispatched = 0
    const host = {
      ...hostOver(composeRegistry(recordedRun())),
      invokeFunction: (): Promise<unknown> => {
        dispatched += 1
        return Promise.resolve(undefined)
      },
    } as unknown as AgentHost

    // A traversal segment: exactly the sort of id the path layer would have to REWRITE, which is
    // what `runIdSchema` exists to refuse before an untrusted string reaches the function layer.
    const outcome = await readRunKnowledge(host, '../../etc/passwd')

    expect(outcome).toEqual({
      kind: 'refused',
      status: 400,
      body: { error: 'invalid_run_id' },
    })
    expect(dispatched).toBe(0)
  })

  it('classifies a dispatch to a name no spec answers to as 500 read_failed, BY NAME', async () => {
    // THE 503 `agent_host_unavailable` LEG DOES NOT EXIST FOR THIS OP THROUGH A DEP GAP, and that
    // absence is the design rather than a hole in this suite. `runs.detail` and `analysis.get`
    // reach that leg because they declare an optional binding dep and refuse `FunctionNotBoundError`
    // where it is missing; `runs.knowledge` declares none — its substrate is the REQUIRED runs port
    // — so there is no composition that lists it and then cannot run it (407 D-05). What remains
    // reachable is a composition that passed the WRONG id, and the honest answer to that is an
    // unclassified throw travelling as a NAME rather than as a message that might quote a path.
    //
    // The 503 this door really can answer is the ROUTER's, when no agent host is composed at all —
    // driven over a real socket in the arm cells below.
    const outcome = await readRunKnowledge(
      hostOver(composeRegistry(recordedRun()), { knowledgeFunctionId: 'runs.notregistered' }),
      RUN_ID,
    )

    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.status).toBe(500)
    expect(outcome.body.error).toBe('read_failed')
    expect(outcome.body.reason).toBe('UnknownFunctionError')
  })
})

describe('serveRunKnowledgeRead', () => {
  const STORED_STEP = 'Sign in with [secret:PW_441] or <SECRET_0>'

  it("serves a step's stored text unchanged", async () => {
    const registry = composeRegistry(recordedRun(STORED_STEP))
    const recorder = recordingResponse()

    serveRunKnowledgeRead(LOOPBACK, recorder.res, {
      runId: RUN_ID,
      host: hostOver(registry),
    })
    await recorder.done

    expect(recorder.status()).toBe(200)
    expect(recorder.raw()).toContain(STORED_STEP)
  })

  it('serves the same stored text at a non-loopback Host', async () => {
    const registry = composeRegistry(recordedRun(STORED_STEP))
    const recorder = recordingResponse()

    serveRunKnowledgeRead(
      { headers: { host: 'runs.example.com' } } as never,
      recorder.res,
      { runId: RUN_ID, host: hostOver(registry) },
    )
    await recorder.done

    expect(recorder.status()).toBe(200)
    expect(recorder.raw()).toContain(STORED_STEP)
  })
})

// ---- The ARM, over a real socket ---------------------------------------------------------------
//
// WHY A SOCKET FOR THESE TWO. Both things they measure live ABOVE the adapter function: the arm's
// POSITION in `routes.ts` — the `/api/runs/:id` catch-all below it claims every four-segment GET
// and answers `Not found`, which is RESEARCH Pitfall 2 — and the conditional spread in `server.ts`
// that threads the host at all. A suite that only called `serveRunKnowledgeRead` would stay green
// with the arm registered in the wrong place, which is the "green that never ran" failure mode.

describe('the /knowledge arm in routes.ts', () => {
  it('is reached at all — it sits ABOVE the /api/runs/:id catch-all', async () => {
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    databases.push(db)
    const started = await startServer({
      declaredSecretMask: (text) => text,
      db,
      port: 0,
      agentHost: hostOver(composeRegistry(recordedRun())),
    })
    closers.push(started.close)
    const port = (started.server.address() as AddressInfo).port

    const response = await fetch(`http://127.0.0.1:${String(port)}/api/runs/${RUN_ID}/knowledge`)
    const body = await response.json() as { kind: string; runId: string }

    // A `Not found` here would mean the catch-all claimed the path first.
    expect(response.status).toBe(200)
    expect(body.kind).toBe('ready')
    expect(body.runId).toBe(RUN_ID)
  })

  it('answers 503 agent_host_unavailable with no agent host — it opens no database instead', async () => {
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    databases.push(db)
    const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0 })
    closers.push(started.close)
    const port = (started.server.address() as AddressInfo).port

    const response = await fetch(`http://127.0.0.1:${String(port)}/api/runs/${RUN_ID}/knowledge`)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'agent_host_unavailable' })
  })
})
