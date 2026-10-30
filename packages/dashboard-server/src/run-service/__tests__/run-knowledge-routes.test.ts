// An unknown run answers 200 `evidence-incomplete`, not 404, unlike `runs.detail`.

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

// The tokenless caller shape: no scope set or safe-mode flag.
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
    // `runs.knowledge` declares no optional binding, so a wrong id is an unnamed throw, not a 503.
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
  const STORED_STEP = 'Sign in with [secret:PW_KEY] or <SECRET_0>'

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

// Over a real socket, because the arm's place in `routes.ts` and the host wiring sit above it.

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
