// THE PHASE 406 TRACER, SERVER HALF (plan 01, D-04 · DETL-04).
//
// ONE CLAIM, MEASURED END TO END: the floor verdict sentence `analysis.get` composes for a failed
// member reaches a browser through a fourth-door route, with no layer faked.
//
//   handoff   a `CompletedRunHandoff` typed against the schema, planted under `runs.get`
//   op        `analysis.get` — the SHIPPED spec, reached through the SHIPPED `invokeFunction`
//             on a registry composed by the SHIPPED `createFunctionRegistry`
//   floor     `analysis.getArtifact` answers `undefined`, so the op takes its deterministic leg
//             (`resolveRunVerdicts` over the handoff, `templateSentenceParts` for the quote)
//   route     `GET /api/runs/:id/analysis` on a REAL socket, through `startServer`
//
// WHY THE SOCKET AND NOT THE ADAPTER FUNCTION. Two of the things that can break this path live
// ABOVE the route handler, exactly as `run-detail-routes.test.ts` records for its sibling arm: the
// arm's POSITION in `routes.ts` — the `/api/runs/:id` catch-all below it claims every four-segment
// GET and answers `Not found` — and the conditional spread in `server.ts` that threads the host at
// all. A suite that called `serveRunAnalysisRead` directly would be green with the arm registered
// in the wrong place, which is the "green that never ran" failure WINDOWS names.
//
// WHY A REAL REGISTRY AND NOT A PLANTED HOST. The op is where the floor is resolved, where the
// sentence is rendered and where `RunNotFoundError` / `FunctionNotBoundError` are minted; a fixture
// that answered the route's `invokeFunction` itself would be a second implementation of all three.
// `@vostride/agent-qa-agent` is a DEV dependency of this package for exactly that reason —
// `validate:arch` walks `src` with `__tests__` excluded and reconciles only runtime
// `dependencies`, so the production edge it forbids stays forbidden.

import type { Server } from 'node:http'
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
import {
  AnalysisGetOutputSchema,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  type CompletedRunHandoff,
  type FunctionCaller,
  type PerTestOutcome,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentHost, AgentRegistryHandle } from '../chat/host.js'
import { DashboardDatabase } from '../db/database.js'
import { readRunAnalysis } from '../run-service/run-analysis-routes.js'
import { startServer } from '../server/server.js'

const RUN_ID = 'r_tracer-406-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel'
/** The producer text the floor sentence quotes — the one string this file traces end to end. */
const STEP_ERROR = 'Error: element "Submit" not found on the checkout screen'

// 2026-10-01 (432-35, D-12): no `grantedScopes` or `safeMode` on the caller; the registry reads
// neither (432-20).
const REGISTRY_CALLER: FunctionCaller = {
  surface: 'dashboard',
  origin: 'human',
}

/**
 * ONE failed member with ONE captured step, typed against `CompletedRunHandoff`.
 *
 * Hand-built rather than imported: `buildSyntheticHandoff` lives under the agent package's
 * `__tests__`, which nothing outside that package may reach. Typing the literal against the schema
 * is what keeps it honest — a field the handoff grows is a compile error here, not a silent hole.
 *
 * `rootCause` is the deterministic classifier's own `unknown`: producer
 * `deterministic-classifier`, confidence 0, empty evidence arrays. That IS the floor this tracer
 * ships, and 406-10's red-run cell is what later flips the same member to `analyze-run`.
 */
function failedMember(): PerTestOutcome {
  return {
    testId: 't_checkout_0',
    testName: 'Checkout submits the order',
    filePath: 'tests/checkout.yaml',
    testIndex: 0,
    outcome: 'failed',
    steps: [{
      stepIndex: 0,
      stepText: 'click the Submit button',
      cacheStatus: 'miss',
      servedBrief: {
        scope: { tier: 'product', key: 'tracer-406' },
        asOfBuild: 1,
        budget: 0,
        truncation: 'none',
        channel1: [],
        channel2: [],
        channel3: [],
        briefDigest: 'tracer-406-brief-digest',
      },
      subActions: [{
        plan: 'click Submit',
        plannedAction: { type: 'click', ref: 'e1' },
        stateBefore: {
          platform: 'web',
          tree: '',
          elements: [],
          refMap: {},
          url: '/checkout',
          timestamp: 1,
          metadata: {
            coordSpace: 'viewport',
            viewportWidth: 1280,
            viewportHeight: 720,
            scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 },
            captureMode: 'textOnly',
          },
        },
        result: { success: false, error: STEP_ERROR },
      }],
      verifierVerdict: { pass: false, reasoning: 'the order never submitted' },
    }],
    rootCause: {
      class: 'unknown',
      producer: 'deterministic-classifier',
      confidence: 0,
      evidence: {
        citedSteps: [],
        citedAnchors: [],
        citedArtifacts: [],
        rationale: 'no deterministic signal matched',
      },
      memoryMisdirectionRuledOut: true,
      perTest: 0,
    },
  } as unknown as PerTestOutcome
}

function handoff(): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: RUN_ID,
    scope: { tier: 'product', key: 'tracer-406' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    startedAt: 1,
    endedAt: 2,
    tests: [failedMember()],
  } as unknown as CompletedRunHandoff
}

/**
 * The four REQUIRED ports plus the two this tracer binds.
 *
 * `analysis: { getArtifact: () => undefined }` is THE FLOOR LEG, spelled deliberately: the port is
 * bound (so the op does not refuse `FunctionNotBoundError`) and there is no `analysis.json` on
 * disk, which is the state every run is in before 406-02/406-07 make `analyze-run` succeed on red.
 */
function depsWith(options: { readonly withAnalysis: boolean }): FunctionDeps {
  const document = handoff()
  return {
    runs: {
      list: () => Promise.resolve([document]),
      get: (runId: unknown) =>
        Promise.resolve(String(runId) === RUN_ID ? document : undefined),
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
    ...(options.withAnalysis ? { analysis: { getArtifact: () => undefined } } : {}),
  } as unknown as FunctionDeps
}

function composeRegistry(options: { readonly withAnalysis: boolean }): FunctionRegistry {
  return createFunctionRegistry({
    deps: depsWith(options),
    // 2026-10-01 (432-35, D-12): no `resolveExecutionContext` registry option; the registry reads
    // no context (432-20).
  })
}

/** A host whose `invokeFunction` IS the shipped dispatcher over the shipped registry. */
function hostOver(registry: FunctionRegistry): AgentHost {
  return {
    registry: registry as unknown as AgentRegistryHandle,
    caller: REGISTRY_CALLER,
    runsPostProcessingFunctionId: 'test:planted-post-processing-op',
    runsEventsFunctionId: 'test:planted-events-op',
    runsDetailFunctionId: RUNS_DETAIL_FUNCTION_ID,
    runsArtifactFunctionId: RUNS_ARTIFACT_FUNCTION_ID,
    // THE ID AS DATA (D-04). This package may not import the agent package outside a test, so a
    // route that spelled `'analysis.get'` itself would be a name nothing type-checks against the
    // spec that answers to it.
    analysisGetFunctionId: ANALYSIS_GET_FUNCTION_ID,
    // 407-01 (D-05): the sixth dispatched id, widened here so every AgentHost literal in the
    // workspace still satisfies the interface.
    runsKnowledgeFunctionId: RUNS_KNOWLEDGE_FUNCTION_ID,
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

afterEach(async () => {
  while (closers.length > 0) closers.pop()?.()
  while (servers.length > 0) {
    const server = servers.pop()
    await new Promise<void>((closed) => server?.close(() => closed()))
  }
  while (databases.length > 0) databases.pop()?.close()
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

/** Serve the fixture. `withHost: false` composes the server with no `agentHost` — the 503 leg. */
async function serve(
  options: { readonly withHost?: boolean; readonly withAnalysis?: boolean } = {},
): Promise<number> {
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  databases.push(db)
  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    ...(options.withHost === false
      ? {}
      : { agentHost: hostOver(composeRegistry({ withAnalysis: options.withAnalysis !== false })) }),
  })
  closers.push(started.close)
  return (started.server.address() as AddressInfo).port
}

describe('GET /api/runs/:id/analysis', () => {
  it('serves the floor verdict the op composed, quoting the step error the handoff recorded', async () => {
    const port = await serve()
    const answer = await get(port, `/api/runs/${RUN_ID}/analysis`)

    expect(answer.status, answer.raw).toBe(200)
    // THE OP'S OWN CONTRACT, not this file's idea of one. A body that parsed here but not under
    // the schema would mean the adapter reshaped something on the way out, which D-04 forbids.
    const parsed = AnalysisGetOutputSchema.safeParse(answer.body)
    expect(parsed.success, `the body must parse under AnalysisGetOutputSchema: ${answer.raw}`)
      .toBe(true)
    if (!parsed.success) return
    const body = parsed.data

    expect(body.runId).toBe(RUN_ID)
    expect(body.verdicts, 'one failed member, one verdict').toHaveLength(1)
    expect(body.verdicts[0]?.perTest, 'the member HANDLE is the join key, never testId').toBe(0)
    expect(body.verdicts[0]?.producer, 'the floor is the deterministic classifier until 406-02')
      .toBe('deterministic-classifier')
    expect(body.verdicts[0]?.confidence).toBe(0)
    expect(body.verdicts[0]?.testId).toBe('t_checkout_0')

    // THE TRACER'S ONE CLAIM. The producer's own recorded error text, quoted verbatim inside the
    // renderer's grounding segment, on the wire.
    expect(body.sentences, 'one sentence per verdict').toHaveLength(1)
    expect(body.sentences[0]?.perTest).toBe(0)
    expect(body.sentences[0]?.sentence, 'the grounding quote names the step it came from')
      .toContain('observed (step 0)')
    expect(body.sentences[0]?.sentence, 'the recorded error text travels whole')
      .toContain(STEP_ERROR)
  })

  it('is answered by the analysis arm and NOT by the /api/runs/:id catch-all', async () => {
    const port = await serve()
    const answer = await get(port, `/api/runs/${RUN_ID}/analysis`)
    // The catch-all claims every four-segment GET under the prefix and answers `Not found` for
    // anything that is not exactly a run id. Registered BELOW it, this route would never run.
    expect(answer.raw, 'the catch-all\'s body must not be what answered').not.toContain('Not found')
    expect(answer.status).toBe(200)
  })

  it('answers 404 unknown_run for a run nothing recorded, and never echoes the id', async () => {
    const port = await serve()
    const missing = 'r_absent-run-nobody-ever-started'
    const answer = await get(port, `/api/runs/${missing}/analysis`)
    expect(answer.status, answer.raw).toBe(404)
    expect(answer.body).toEqual({ error: 'unknown_run' })
    expect(answer.raw, 'a refusal that quotes untrusted input is a reflection this door does not offer')
      .not.toContain(missing)
  })

  it('answers 503 agent_host_unavailable with no agent host composed', async () => {
    const port = await serve({ withHost: false })
    const answer = await get(port, `/api/runs/${RUN_ID}/analysis`)
    expect(answer.status, answer.raw).toBe(503)
    expect(answer.body).toEqual({ error: 'agent_host_unavailable' })
  })

  it('refuses a run id the op\'s own input schema rejects, before any dispatch', async () => {
    const port = await serve()
    // `..` is exactly the segment `slugBranch` would REWRITE, which `runIdSchema` refuses instead.
    const answer = await get(port, '/api/runs/..%2Fescape/analysis')
    expect(answer.status, answer.raw).toBe(400)
    expect(answer.body).toEqual({ error: 'invalid_run_id' })
  })

  it('maps a thrown FunctionNotBoundError to 503 — a composition with no analysis port says so', async () => {
    // Measured through `readRunAnalysis` directly: the claim is about the refusal CLASSIFICATION,
    // and the socket cells above already pin that the arm reaches this function at all.
    const outcome = await readRunAnalysis(
      hostOver(composeRegistry({ withAnalysis: false })),
      RUN_ID,
    )
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.status).toBe(503)
    expect(outcome.body.error).toBe('agent_host_unavailable')
  })
})
