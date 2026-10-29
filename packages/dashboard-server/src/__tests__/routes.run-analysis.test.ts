// A real socket and registry: the arm's place in `routes.ts` and the host wiring can both break it.

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

const REGISTRY_CALLER: FunctionCaller = {
  surface: 'dashboard',
  origin: 'human',
}

// Hand-built as the agent package's handoff builder is test-only; typing it catches new fields.
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

// An `analysis` port answering `undefined` is bound, so the op takes its deterministic floor leg.
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
    // This package may not import agent outside tests, so the route takes the id as data.
    analysisGetFunctionId: ANALYSIS_GET_FUNCTION_ID,
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
    // Parsed with the op's own schema, so a body reshaped on the way out fails here.
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
