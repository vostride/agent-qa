// Every enrolled surface shows `[secret:<name>]`, never the value; a walked surface must enrol.

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'

import { createMaskingMiddleware } from '@vostride/agent-qa-safety'
import type { ProviderRequestParams } from '@vostride/agent-qa-safety'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { debugLoggingMiddleware } from '@vostride/agent-qa-model'
// The shipped subscriber, database, detail adapter and routers, not a door of this file's own.
import {
  DashboardDatabase,
  createDashboardRunDetailReader,
  createDashboardRunIngest,
  createRouter,
  createRunServiceRoutes,
} from '@vostride/agent-qa-dashboard'
import type { AgentHost } from '@vostride/agent-qa-dashboard'
// The shipped registry and dispatcher, because `runs.detail` computes the projection and the error.
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
import { createEvidenceBlobReader } from '@vostride/agent-qa-agent-local'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createEntitiesCommand } from '../commands/entities.js'
import * as localAgentHost from '../composition/local-agent-host.js'
import { createKnowledgeCommand } from '../commands/knowledge.js'
import { renderClauseResults } from '../commands/result-render.js'
import { removeTempRoots } from './temp-roots.js'
import {
  ARTIFACT_FILE,
  EVENTS_FILE,
  FsEventLog,
  FsEvidenceArtifactStore,
  FsHandoffStore,
  FsRunArtifactStore,
  HANDOFF_FILE,
  RUNS_SUBDIR,
  slugBranch,
} from '@vostride/agent-qa-runner-local'
import {
  computeCacheKey,
  relevantEnvDigest,
  RUN_ARTIFACT_SCHEMA_VERSION,
  RUN_SERVICE_CONTRACT_VERSION,
  CURRENT_BUS_SCHEMA_VERSION,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CacheableStepInput,
  ClauseResult,
  CompletedRunHandoff,
  PerTestOutcome,
  RedactedEnvVar,
  RiskActionDescriptor,
  RunArtifactStageInput,
  RunEventEnvelope,
  RunEventType,
  RunFinishedPayload,
  RunId,
  RunStartedPayload,
  ScopeKey,
  ServedBrief,
  StepEvidence,
  StepFinalizedPayload,
  StepStartedPayload,
  TestFinishedPayload,
  TestStartedPayload,
} from '@vostride/agent-qa-schema'

import { createJunitReporter, createWireReporter } from '../reporters/index.js'

// Counts host compositions, so the refusal cells can show none happened.
const hostCompositions = vi.hoisted(() => ({ count: 0 }))
vi.mock('../composition/local-agent-host.js', async (importOriginal) => {
  const actual = await importOriginal<typeof localAgentHost>()
  return {
    ...actual,
    composeCliLocalAgent: (...args: Parameters<typeof actual.composeCliLocalAgent>) => {
      hostCompositions.count += 1
      return actual.composeCliLocalAgent(...args)
    },
  }
})

const MARKER = /\[secret:ROLLCALL_\w+\]/

// The sentinel originals, of deliberately different shapes, each declared under its own name.
const SECRETS = {
  step: 'sk-live-URL-000aaa111', // rides a rendered step line
  error: 'sk-live-STEP-222bbb333', // rides a step error / cache input / egress / debug body
  hook: 'hook-pw-444ccc555', // rides a hook variable value + hook stdout
  summary: 'sk-live-SUM-666ddd777', // rides a failureSummary + handoff evidence + artifact snapshot
  confirm: 'sk-live-ASK-888eee999', // the legacy confirm sentinel
  // Rides a chat clause result, the op-result payload a masked configuration read can carry.
  opResult: 'sk-live-OPR-000fff111',
} as const

const SECRET_NAMES: Record<keyof typeof SECRETS, string> = {
  step: 'ROLLCALL_STEP',
  error: 'ROLLCALL_ERROR',
  hook: 'ROLLCALL_HOOK',
  summary: 'ROLLCALL_SUMMARY',
  confirm: 'ROLLCALL_CONFIRM',
  opResult: 'ROLLCALL_OP_RESULT',
}

function markerOf(key: keyof typeof SECRETS): string {
  return `[secret:${SECRET_NAMES[key]}]`
}

const RUN_ID = 'rollcall-run'
const SCOPE: ScopeKey = { tier: 'suite', key: 'auth' }

interface RollCallFixture {
  // The one declared mask every surface below derives from.
  redactor: SecretRedactor
  envelopes: RunEventEnvelope[]
  handoff: CompletedRunHandoff
  artifactStage: RunArtifactStageInput
  cacheInput: CacheableStepInput
  egressParams: ProviderRequestParams
  debugResponseBody: string
  confirmActionName: string
  /** One clause result, with its payload masked as the function layer returns it. */
  clauseResults: ClauseResult[]
}

// One redactor declares every sentinel; the egress request carries the raw value to be masked.
function buildRollCallFixture(): RollCallFixture {
  const declared = (Object.keys(SECRETS) as (keyof typeof SECRETS)[])
    .map((key) => [SECRET_NAMES[key], SECRETS[key]] as const)
  const redactor = new SecretRedactor(new SecretStore(declared))
  const mask = (text: string): string => redactor.redactString(text)

  // --- one envelope stream --------------------------------------------------------------------
  let seq = 0
  const env = <P>(type: RunEventType, payload: P): RunEventEnvelope =>
    ({ seq: seq++, ts: 1_000 + seq, runId: RUN_ID, type, payload }) as RunEventEnvelope

  const runStarted: RunStartedPayload = {
    busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
    scope: { tier: 'suite', key: 'auth-suite' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'aaaa', testConfigDigest: 'bbbb' },
    memberTestCount: 2,
  }

  const test0Started: TestStartedPayload = {
    testId: 't0',
    testIndex: 0,
    name: 'Login test',
    filePath: 'tests/login.yaml',
    suiteId: 'suite-1',
    suiteName: 'Auth',
    suiteIndex: 0,
    suiteTotal: 1,
    totalSteps: 2,
    // Authored step texts ride the envelope stream, masked at the producer like `stepText`.
    stepTexts: [mask(`Navigate to ${SECRETS.step}`), 'Submit credentials'],
  }

  const okStep: StepFinalizedPayload = {
    testIndex: 0,
    stepIndex: 0,
    cacheStatus: 'miss',
    verifierVerdict: { pass: true, reasoning: 'ok' },
    selfHealOccurred: false,
    briefDigest: 'digest',
    status: 'passed',
    durationMs: 1_200,
  }

  const failedStep: StepFinalizedPayload = {
    testIndex: 0,
    stepIndex: 1,
    cacheStatus: 'miss',
    verifierVerdict: { pass: false, reasoning: 'timeout' },
    selfHealOccurred: false,
    briefDigest: 'digest',
    status: 'failed',
    durationMs: 800,
    error: mask(`Timeout waiting for token ${SECRETS.error}`),
  }

  const hookFinished = {
    hookName: 'seed-db',
    phase: 'setup',
    hookExecutionId: 'h1',
    scope: 'test',
    status: 'passed',
    durationMs: 300,
    stdout: mask(`seeded with ${SECRETS.hook}`),
    stderr: '',
    variables: { TOKEN: mask(SECRETS.hook), REGION: 'us-east-1' },
    kind: 'hook',
  }

  const test0Finished: TestFinishedPayload = { testId: 't0', testIndex: 0, outcome: 'failed', durationMs: 2_000 }

  const test1Started: TestStartedPayload = {
    testId: 't1',
    testIndex: 1,
    name: 'Checkout test',
    filePath: 'tests/checkout.yaml',
    suiteId: 'suite-1',
    suiteName: 'Auth',
    suiteIndex: 0,
    suiteTotal: 1,
    totalSteps: 1,
  }

  const test1FailedStep: StepFinalizedPayload = {
    testIndex: 1,
    stepIndex: 0,
    cacheStatus: 'miss',
    verifierVerdict: { pass: false, reasoning: 'assertion failed' },
    selfHealOccurred: false,
    briefDigest: 'digest',
    status: 'failed',
    durationMs: 1_200,
    error: mask('Element not found'),
  }

  const test1Finished: TestFinishedPayload = {
    testId: 't1',
    testIndex: 1,
    outcome: 'failed',
    durationMs: 1_500,
    failureSummary: mask(`Checkout failed near ${SECRETS.summary}`),
  }

  const runFinished: RunFinishedPayload = { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: 0 }

  const envelopes: RunEventEnvelope[] = [
    env('runStarted', runStarted),
    env('testStarted', test0Started),
    // step 0 carries the sentinel in its VISIBLE step text (console step-line surface)
    env('stepStarted', { testIndex: 0, stepIndex: 0, stepText: mask(`Navigate to ${SECRETS.step}`) } satisfies StepStartedPayload),
    env('stepFinalized', okStep),
    env('stepStarted', { testIndex: 0, stepIndex: 1, stepText: 'Submit credentials' } satisfies StepStartedPayload),
    env('stepFinalized', failedStep),
    env('hookStarted', { hookName: 'seed-db', phase: 'setup', hookExecutionId: 'h1', scope: 'test' }),
    env('hookFinished', hookFinished),
    env('testFinished', test0Finished),
    env('testStarted', test1Started),
    env('stepStarted', { testIndex: 1, stepIndex: 0, stepText: 'Add to cart' } satisfies StepStartedPayload),
    env('stepFinalized', test1FailedStep),
    env('testFinished', test1Finished),
    env('verdict', { verdict: 'failed' }),
    env('runFinished', { ...runFinished, finalSeq: seq }),
  ]

  // --- one completed-run handoff carrying masked step evidence --------------------------------
  const servedBrief: ServedBrief = {
    scope: SCOPE,
    asOfBuild: 1,
    budget: 4_096,
    truncation: 'none',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: 'brief-digest-deadbeef',
  }
  const maskedStep: StepEvidence = {
    stepIndex: 0,
    stepText: mask(`Save the record ${SECRETS.summary}`),
    cacheStatus: 'miss',
    servedBrief,
    subActions: [],
    verifierVerdict: { pass: false, reasoning: mask(`failed near ${SECRETS.summary}`) },
  }
  const outcome: PerTestOutcome = {
    testId: 't1',
    testName: 'Test one',
    filePath: 't1.spec.yaml',
    testIndex: 1,
    outcome: 'failed',
    steps: [maskedStep],
  }
  const handoff: CompletedRunHandoff = {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: RUN_ID as unknown as RunId,
    scope: SCOPE,
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_010_000,
    tests: [outcome],
  }

  // --- one run artifact snapshot (config + terminal error) ------------------------------------
  const artifactStage: RunArtifactStageInput = {
    schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    config: { rawConfigContent: mask(`base_url: https://app.test\n# token ${SECRETS.summary}`) },
    errors: [{ code: 'RUN_FAILED', message: mask(`boom ${SECRETS.error}`), phase: 'run' }],
  }

  // --- one cache-key input (356 floor: masked step text + value-free env digest) --------------
  const envVars: RedactedEnvVar[] = [{ name: 'API_KEY', present: true, kind: 'string', lengthBucket: 4 }]
  const cacheInput: CacheableStepInput = {
    platform: 'web',
    suiteConfigDigest: 'suite-digest',
    testConfigDigest: 'test-digest',
    stepText: mask(`call API with ${SECRETS.error}`),
    stepIndex: 0,
    testIndex: 0,
    relevantEnvDigest: relevantEnvDigest(envVars, 'salt'),
    screenIdentityHash: 'screen-hash',
  }

  // --- one provider-egress request carrying the RAW secret (the hook masks it) ----------------
  const egressParams = {
    prompt: [{ role: 'user', content: [{ type: 'text', text: `use ${SECRETS.error}` }] }],
    temperature: 0.2,
  } as unknown as ProviderRequestParams

  return {
    redactor,
    envelopes,
    handoff,
    artifactStage,
    cacheInput,
    egressParams,
    debugResponseBody: mask(`{"detail":"rejected ${SECRETS.error}"}`),
    confirmActionName: mask(`git push to ${SECRETS.confirm}`),
    // Masked at the source: the session log and every `agent.ask` client hold the marker.
    clauseResults: [{
      functionId: 'config.auth.set',
      payload: { outcome: 'proposed', token: mask(SECRETS.opResult) },
    }],
  }
}

const FIXTURE = buildRollCallFixture()
const ALL_ORIGINALS = Object.values(SECRETS)

// A second handoff from the same redactor, shaped so the floor leg produces a quoted verdict.
const ROLLCALL_ANALYSIS_HANDOFF: CompletedRunHandoff = {
  schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
  runId: RUN_ID as unknown as RunId,
  scope: SCOPE,
  buildOrdinal: 1,
  executionContext: 'local-headless',
  aggregateVerdict: 'failed',
  configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_010_000,
  tests: [{
    testId: 't0',
    testName: 'Login test',
    filePath: 'tests/login.yaml',
    testIndex: 0,
    outcome: 'failed',
    steps: [{
      stepIndex: 0,
      stepText: 'Submit credentials',
      cacheStatus: 'miss',
      servedBrief: {
        scope: SCOPE,
        asOfBuild: 1,
        budget: 0,
        truncation: 'none',
        channel1: [],
        channel2: [],
        channel3: [],
        briefDigest: 'rollcall-analysis-digest',
      },
      subActions: [{
        plan: 'submit the login form',
        plannedAction: { type: 'click', ref: 'e1' },
        // PRESENT BECAUSE THE ANCHOR WALK READS IT. `exercisedAnchors` resolves the planned
        // action's ref against `stateBefore.elements` and mints the page anchor from its url; a
        // sub-action without one makes the fingerprint leg throw rather than answer nothing.
        stateBefore: {
          platform: 'web',
          tree: '',
          elements: [],
          refMap: {},
          url: '/login',
          timestamp: 1,
          metadata: {
            coordSpace: 'viewport',
            viewportWidth: 1280,
            viewportHeight: 720,
            scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 },
            captureMode: 'textOnly',
          },
        },
        result: { success: false, error: FIXTURE.redactor.redactString(`Timeout waiting for token ${SECRETS.error}`) },
      }],
      verifierVerdict: { pass: false, reasoning: 'timeout' },
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
  }],
} as unknown as CompletedRunHandoff

// The host is supplied, not composed, and carries no display member.
function dashboardRollCallHost(): AgentHost {
  return {
    registry: {},
    // Nothing reads a caller scope set.
    caller: { origin: 'human', surface: 'dashboard' } as never,
    // Every op id is named so the SHAPE is complete; the run host below overrides the ids it
    // dispatches, the registry and the dispatch itself.
    runsPostProcessingFunctionId: 'runs.postprocessing',
    runsEventsFunctionId: 'runs.events',
    runsDetailFunctionId: 'runs.detail',
    runsEvidenceFunctionId: 'runs.evidence',
    runsArtifactFunctionId: 'runs.artifact',
    analysisGetFunctionId: 'analysis.get',
    runsMarkFunctionId: 'runs.mark',
    runsMarksHistoryFunctionId: 'runs.marks.history',
    runsMarkPreviewFunctionId: 'runs.mark.preview',
    runsKnowledgeFunctionId: RUNS_KNOWLEDGE_FUNCTION_ID,
    invokeFunction: () => Promise.resolve({
      sessionId: 'chat-20260821-000000-r0ll',
      turnId: 'turn-1',
      status: 'completed',
      receipts: [],
      results: FIXTURE.clauseResults,
      denials: [],
    }),
  }
}


// Every dashboard run read serves text the run masked; a new read route that does not enrol fails.

/** The four REQUIRED read ports, minimal by construction — `runs.detail` reaches none of them. */
function rollCallFunctionDeps(
  runDetail: unknown,
  evidenceBlobs: unknown,
): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([ROLLCALL_ANALYSIS_HANDOFF]),
      // `analysis.get` reads the run through this port, so the analysis rows can be driven.
      get: (runId: unknown) =>
        Promise.resolve(String(runId) === RUN_ID ? ROLLCALL_ANALYSIS_HANDOFF : undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    // The floor leg: the port is bound and there is no artifact, so the handoff's quote is used.
    analysis: { getArtifact: () => undefined },
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
    runDetail,
    evidenceBlobs,
  } as unknown as FunctionDeps
}

/**
 * The roll-call host for the RUN reads: the base host above, with a real registry behind it.
 *
 * `dashboardRollCallHost` answers every dispatch with a planted fixture, which is useless for
 * these — `runs.detail` is where the projection is computed, where
 * the token sum is folded and where `RunNotFoundError` is minted, so a fixture that answered it
 * would be a second implementation of all three. This one DISPATCHES, through the shipped
 * `invokeFunction`.
 */
function dashboardRunRollCallHost(registry: FunctionRegistry): AgentHost {
  return {
    ...dashboardRollCallHost(),
    registry: registry as unknown as AgentHost['registry'],
    // No `grantedScopes` or `safeMode`; the registry reads neither.
    caller: {
      surface: 'dashboard',
      origin: 'human',
    },
    runsDetailFunctionId: RUNS_DETAIL_FUNCTION_ID,
    runsArtifactFunctionId: RUNS_ARTIFACT_FUNCTION_ID,
    analysisGetFunctionId: ANALYSIS_GET_FUNCTION_ID,
    // Widened here so every `AgentHost` literal in the workspace still satisfies the interface.
    runsKnowledgeFunctionId: RUNS_KNOWLEDGE_FUNCTION_ID,
    invokeFunction: (
      handle: unknown,
      functionId: string,
      input: unknown,
      caller: unknown,
    ): Promise<unknown> =>
      invokeFunction(handle as FunctionRegistry, functionId, input, caller as never),
  } as unknown as AgentHost
}

interface DashboardRunRollCall {
  readonly db: DashboardDatabase
  readonly host: AgentHost
  /** The content address the shipped store minted for the masked blob below. */
  readonly artifactSha: string
  /** The bytes that store holds, as it holds them. */
  readonly artifactBytes: Buffer
}

let dashboardRunRollCallOnce: Promise<DashboardRunRollCall> | undefined

// This file's one envelope stream and one masked blob, shared by every entry.
function dashboardRunRollCall(): Promise<DashboardRunRollCall> {
  dashboardRunRollCallOnce ??= (async (): Promise<DashboardRunRollCall> => {
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: {
        kind: 'test',
        testId: 't0',
        name: 'Login test',
        filePath: 'tests/login.yaml',
        loadStatus: 'loaded',
      },
      runId: RUN_ID,
      now: () => '2026-08-28T00:00:00.000Z',
    })
    for (const envelope of FIXTURE.envelopes) ingest.handler(envelope)
    await ingest.finalize()

    // ONE BLOB, WHOSE BYTES ARE A PNG HEADER FOLLOWED BY MASKED TEXT, so the masked assertion has a
    // marker to see; the sha comparison inside `render` is the byte-identity claim on top of it.
    const artifactBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(FIXTURE.redactor.redactString(`config token ${SECRETS.summary}`), 'utf8'),
    ])
    const ref = new FsEvidenceArtifactStore({ root: TMP_ROOT, runId: RUN_ID })
      .persistDecisionScreenshot(new Uint8Array(artifactBytes))

    const registry = createFunctionRegistry({
      deps: rollCallFunctionDeps(
        createDashboardRunDetailReader(db),
        createEvidenceBlobReader({ agentQaRoot: TMP_ROOT }),
      ),
      // No `resolveExecutionContext` registry option; the registry reads no context.
    })

    return { db, host: dashboardRunRollCallHost(registry), artifactSha: ref.sha, artifactBytes }
  })()
  return dashboardRunRollCallOnce
}

/** Mount a handler on a real socket, drive one request, return the body, close the socket. */
async function overOneSocket(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  path: string,
  init: RequestInit = {},
): Promise<string> {
  const server = createServer(handler)
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
    return await response.text()
  } finally {
    await new Promise<void>((closed) => server.close(() => { closed() }))
  }
}

/**
 * The same, answering BYTES.
 *
 * A binary body cannot travel through `response.text()` and come back whole — a PNG's own header
 * is not valid UTF-8, so the decode substitutes replacement characters and the sha of what comes
 * out is a sha of the decoding rather than of the transfer. The artifact entry's whole claim is
 * byte identity, so it reads the buffer.
 */
async function bytesOverOneSocket(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  path: string,
): Promise<Buffer> {
  const server = createServer(handler)
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    await new Promise<void>((closed) => server.close(() => { closed() }))
  }
}

/** One LOCAL-door read, over the SHIPPED router with the roll-call host bound. */
async function localDashboardRead(path: string): Promise<string> {
  const fixture = await dashboardRunRollCall()
  return overOneSocket(
    createRouter({ db: fixture.db, agentHost: fixture.host } as never),
    path,
  )
}

/** A planted session that replays THIS FILE'S envelope stream — the run-stream door's input. */
function rollCallRunSession(): unknown {
  return {
    id: RUN_ID,
    status: 'failed',
    executionContext: 'local-headless',
    subscribe(fromSeq: number, handler: (envelope: RunEventEnvelope) => void) {
      for (const envelope of FIXTURE.envelopes) {
        if (envelope.seq >= fromSeq) handler(envelope)
      }
      return () => undefined
    },
    subscribeFrames() { return undefined },
    streamCapabilityOf() { return { kind: 'none' as const } },
    cancel() { /* nothing to cancel on a planted session */ },
    done: Promise.resolve({ verdict: 'failed' }),
  }
}

/** The REMOTE run-service door's ports — enough to reach the READ rows and nothing more. */
async function rollCallServicePorts(): Promise<unknown> {
  const fixture = await dashboardRunRollCall()
  // No `verifyBearer`: the run service is tokenless.
  return {
    invokeRunStart: () => Promise.reject(new Error('this fixture starts no runs')),
    attach: (runId: string) => (runId === RUN_ID ? rollCallRunSession() : undefined),
    readiness: () => ({
      service: 'up',
      hostComposed: true,
      contractVersion: RUN_SERVICE_CONTRACT_VERSION,
    }),
    mintLiveUrl: () => Promise.reject(
      Object.assign(new Error('no live-view port is bound on this fixture'), {
        name: 'LiveViewUnavailableError',
      }),
    ),
    agentHost: fixture.host,
  }
}

// Each entry asserts a marker present and every original absent, from the same fixture.

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'unmask-rollcall-'))
const runDir = join(TMP_ROOT, RUNS_SUBDIR, slugBranch(RUN_ID))
afterAll(() => { removeTempRoots([TMP_ROOT]) })

interface MaskedSurface {
  name: string
  render: () => string | Promise<string>
  payloadFree?: true
  // The markers this surface must carry, where the surface names particular values.
  markers?: string[]
}

const MASKED_SURFACES: MaskedSurface[] = [
  {
    // The chat terminal's emit: the op-result payload block through the declared mask.
    name: 'chat:clause-results',
    markers: [markerOf('opResult')],
    render: () => FIXTURE.redactor.redactString(
      renderClauseResults(FIXTURE.clauseResults, FIXTURE.clauseResults.length).join('\n'),
    ),
  },
  {
    // Members carry the failure summary, steps carry the step text and the step error.
    name: 'dashboard:run-detail',
    markers: [markerOf('step'), markerOf('error'), markerOf('summary')],
    render: () => localDashboardRead(`/api/runs/${RUN_ID}/detail`),
  },
  {
    // The floor sentence quotes the failing step's recorded error.
    name: 'dashboard:run-analysis',
    markers: [markerOf('error')],
    render: () => localDashboardRead(`/api/runs/${RUN_ID}/analysis`),
  },
  {
    name: 'dashboard:run-list',
    markers: [markerOf('summary')],
    render: () => localDashboardRead('/api/runs'),
  },
  {
    // One run's ROW, on the arm the page reads before the projection arrives.
    name: 'dashboard:run-row',
    markers: [markerOf('summary')],
    render: () => localDashboardRead(`/api/runs/${RUN_ID}`),
  },
  {
    // Execution logs — hook stdout.
    name: 'dashboard:execution-logs',
    markers: [markerOf('hook')],
    render: () => localDashboardRead(`/api/runs/${RUN_ID}/execution-logs`),
  },
  {
    // The artifact drawer's JSON — the run row plus the artifact snapshot.
    name: 'dashboard:artifact-drawer',
    markers: [markerOf('summary')],
    render: () => localDashboardRead(`/api/runs/${RUN_ID}/artifact`),
  },
  {
    // events.jsonl — the durable event log, through the REAL FsEventLog under a tmpdir.
    name: 'durable:events.jsonl',
    render: () => {
      const log = new FsEventLog({ root: TMP_ROOT, runId: RUN_ID })
      for (const envelope of FIXTURE.envelopes) log.append(envelope)
      return readFileSync(join(runDir, EVENTS_FILE), 'utf-8')
    },
  },
  {
    // handoff.json — the completed-run handoff, through the REAL FsHandoffStore.
    name: 'durable:handoff.json',
    render: () => {
      new FsHandoffStore({ root: TMP_ROOT, runId: RUN_ID }).save(FIXTURE.handoff)
      return readFileSync(join(runDir, HANDOFF_FILE), 'utf-8')
    },
  },
  {
    // artifact.json — the run-dir artifact snapshot, through the REAL FsRunArtifactStore.
    name: 'durable:artifact.json',
    render: () => {
      new FsRunArtifactStore({ root: TMP_ROOT, runId: RUN_ID }).stage(FIXTURE.artifactStage)
      return readFileSync(join(runDir, ARTIFACT_FILE), 'utf-8')
    },
  },
  {
    // JUnit XML — the CI-archived masked artifact, through the REAL junit reporter's flush.
    name: 'durable:junit-xml',
    render: async () => {
      let xml = ''
      const junit = createJunitReporter({
        outputPath: '/unused/report.xml',
        write: async (_path, content) => {
          xml = content
        },
      })
      for (const envelope of FIXTURE.envelopes) junit.handler(envelope)
      await junit.flush()
      return xml
    },
  },
  {
    // stdout wire — the spawn/CI-captured verbatim envelope stream, through the REAL wire reporter.
    name: 'machine:stdout-wire',
    render: () => {
      const previous = process.env.AGENT_QA_LIVE_EVENTS
      process.env.AGENT_QA_LIVE_EVENTS = 'true'
      try {
        const chunks: string[] = []
        const wire = createWireReporter({ write: (chunk) => void chunks.push(chunk) })
        for (const envelope of FIXTURE.envelopes) wire.handler(envelope)
        return chunks.join('')
      } finally {
        if (previous === undefined) delete process.env.AGENT_QA_LIVE_EVENTS
        else process.env.AGENT_QA_LIVE_EVENTS = previous
      }
    },
  },
  {
    // The debug log prints the provider body as a length, so no payload reaches it.
    name: 'machine:debug-log',
    payloadFree: true,
    render: async () => {
      const lines: string[] = []
      const middleware = debugLoggingMiddleware({ enabled: true, sink: (line) => void lines.push(line) })
      const wrapGenerate = middleware.wrapGenerate
      if (!wrapGenerate) throw new Error('debug middleware must expose wrapGenerate when enabled')
      const params = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: FIXTURE.egressParams.prompt[0] ? 'shape-only' : 'x' }] }],
      }
      try {
        await wrapGenerate({
          doGenerate: async () => {
            throw { statusCode: 400, url: 'https://provider.test', responseBody: FIXTURE.debugResponseBody }
          },
          params,
          model: { modelId: 'test-model' },
        } as never)
      } catch {
        // the middleware re-throws after logging — expected
      }
      expect(lines.join('\n')).toContain('responseBodyLength=')
      return lines.join('\n')
    },
  },
  {
    // Cache key material, the masked-input floor, through the real `computeCacheKey` helpers.
    name: 'machine:cache-key-material',
    render: () => {
      // The key hash must be stable from the masked input and must not embed the raw secret.
      const key = computeCacheKey(FIXTURE.cacheInput)
      expect(key).not.toContain(SECRETS.error)
      return JSON.stringify(FIXTURE.cacheInput)
    },
  },
  {
    // Provider egress, through the real masking middleware every model call carries.
    name: 'machine:provider-egress',
    markers: [markerOf('error')],
    render: async () => {
      const middleware = createMaskingMiddleware((text) => FIXTURE.redactor.redactString(text))
      const transformParams = middleware.transformParams
      if (!transformParams) throw new Error('the masking middleware must expose transformParams')
      return JSON.stringify(await transformParams({
        params: FIXTURE.egressParams,
        type: 'generate',
        model: { modelId: 'test-model' },
      } as never))
    },
  },
  {
    // `renderClauseResults` renders without emitting: the caller gets the log's marker form.
    name: 'machine:chat-clause-results',
    render: () => renderClauseResults(FIXTURE.clauseResults, FIXTURE.clauseResults.length).join('\n'),
  },
  {
    // The rows the page reads, dumped whole: a cleartext value at ingest would outlive the request.
    name: 'durable:dashboard-sqlite-rows',
    render: async () => {
      const fixture = await dashboardRunRollCall()
      // The raw handle, deliberately: the claim is about what is IN the columns, and every typed
      // reader is a projection that could hide a column the claim ranges over.
      const raw = (fixture.db as unknown as {
        db: { prepare(query: string): { all(): unknown[] } }
      }).db
      return JSON.stringify(
        ['runs', 'run_members', 'run_steps', 'run_sub_actions', 'execution_logs']
          .map((table) => raw.prepare(`SELECT * FROM ${table}`).all()),
      )
    },
  },
  {
    // THE RUN-STREAM SSE. A machine wire whose consumer is its own display boundary, and the
    // channel a client persists — a frame that carried a declared value would put a credential in
    // whatever buffered it. The SHIPPED local router serves it over a real socket.
    name: 'machine:run-stream-sse',
    render: async () => {
      const fixture = await dashboardRunRollCall()
      return overOneSocket(
        createRouter({
          db: fixture.db,
          agentHost: fixture.host,
          runServiceAttach: (runId: string) =>
            (runId === RUN_ID ? rollCallRunSession() : undefined),
        } as never),
        `/api/run-stream/${RUN_ID}`,
      )
    },
  },
  {
    // The remote door's detail body: `serveRunDetailRead` with no `boundary` defaults to `machine`.
    name: 'machine:remote-run-detail',
    render: async () => {
      const ports = await rollCallServicePorts()
      return overOneSocket(
        createRunServiceRoutes(ports as never),
        `/run/${RUN_ID}/detail`,
      )
    },
  },
  {
    // The remote door's analysis body, on its detail sibling's terms.
    name: 'machine:remote-run-analysis',
    render: async () => {
      const ports = await rollCallServicePorts()
      return overOneSocket(
        createRunServiceRoutes(ports as never),
        `/run/${RUN_ID}/analysis`,
      )
    },
  },
  {
    // Artifact bytes are served as stored; the sha is checked against the store-minted address.
    name: 'machine:artifact-bytes',
    render: async () => {
      const fixture = await dashboardRunRollCall()
      const servedBytes = await bytesOverOneSocket(
        createRouter({ db: fixture.db, agentHost: fixture.host } as never),
        `/api/runs/${RUN_ID}/artifacts/${fixture.artifactSha}`,
      )
      expect(createHash('sha256').update(servedBytes).digest('hex'), 'bytes served === bytes stored')
        .toBe(fixture.artifactSha)
      expect(servedBytes.equals(fixture.artifactBytes)).toBe(true)
      // `latin1` is a byte-for-byte decoding, so the marker-present / original-absent scan the
      // masked registry runs over this string is a scan of the BYTES rather than of a re-encoding.
      return servedBytes.toString('latin1')
    },
  },
]

describe('unmask boundary roll-call — MASKED side keeps markers', () => {
  it.each(MASKED_SURFACES.map((surface) => [surface.name, surface] as const))(
    'masked surface %s keeps markers and leaks no original',
    async (_name, surface) => {
      const output = await surface.render()
      if (!surface.payloadFree) expect(output).toMatch(MARKER)
      for (const marker of surface.markers ?? []) expect(output).toContain(marker)
      for (const original of ALL_ORIGINALS) {
        expect(output).not.toContain(original)
      }
    },
  )
})

// A surface walked but not listed, or listed but not walked, fails this test.
const SURFACE_ROLLCALL = [
  'durable:events.jsonl',
  'durable:handoff.json',
  'durable:artifact.json',
  'durable:junit-xml',
  'machine:stdout-wire',
  'machine:debug-log',
  'machine:cache-key-material',
  'machine:provider-egress',
  'chat:clause-results',
  'machine:chat-clause-results',
  // The dashboard's run reads and the sinks behind them.
  'dashboard:run-detail',
  'dashboard:run-list',
  'dashboard:run-row',
  'dashboard:execution-logs',
  'dashboard:artifact-drawer',
  'durable:dashboard-sqlite-rows',
  'machine:run-stream-sse',
  'machine:remote-run-detail',
  'machine:artifact-bytes',
  // The failure view's read, on both doors.
  'dashboard:run-analysis',
  'machine:remote-run-analysis',
] as const

describe('unmask boundary roll-call — enrollment guard', () => {
  it('every walked surface is enrolled in the SURFACE_ROLLCALL union exactly once', () => {
    const walked = MASKED_SURFACES.map((s) => s.name)
    expect(new Set(walked).size).toBe(walked.length)
    // The walked union is exactly the declared roll-call — a new unenrolled surface fails here.
    expect([...walked].sort()).toEqual([...SURFACE_ROLLCALL].sort())
  })

  it('every surface derives from ONE fixture (single SecretRedactor, single envelope stream)', () => {
    expect(FIXTURE.redactor).toBeInstanceOf(SecretRedactor)
    expect(FIXTURE.envelopes.length).toBeGreaterThan(0)
    expect(MASKED_SURFACES.length).toBe(SURFACE_ROLLCALL.length)
  })
})

// The terminal commands refuse without a readable secrets file.

// `composes` is whether the command composes a host once the secrets file is readable: the
// control that makes the zero count after a refusal mean something.
const REFUSING_COMMANDS: readonly (readonly [string, readonly string[], boolean])[] = [
  ['entities', ['entities', 'get', 'MEM-001'], true],
  ['knowledge read', ['knowledge', 'bundles'], true],
  ['knowledge maintain', ['knowledge', 'rebuild-index'], false],
]

describe('reads refuse an unreadable secrets file', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it.each(REFUSING_COMMANDS)(
    '%s refuses at start when the secrets file cannot be read',
    async (_name, args, composes) => {
      const root = mkdtempSync(join(tmpdir(), 'display-refusal-'))
      roots.push(root)
      const configPath = join(root, 'agent-qa.config.yaml')
      writeFileSync(configPath, `${JSON.stringify({
        workspace: {
          testMatch: ['tests/**/*.yaml'],
          suiteMatch: ['suites/**/*.suite.yaml'],
          hooksFile: 'hooks.yaml',
          envFile: '.env',
          secretsFile: 'secrets-dir',
        },
        use: { mobile: { appState: 'preserve' } },
      })}\n`)
      // A directory: present, and unreadable as a file.
      mkdirSync(join(root, 'secrets-dir'))
      const secretsPath = join(root, 'secrets-dir')

      const out: string[] = []
      const err: string[] = []
      const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
        out.push(values.map(String).join(' '))
      })
      const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
        err.push(values.map(String).join(' '))
      })
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk))
        return true
      })
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err.push(String(chunk))
        return true
      })
      const priorExit = process.exitCode
      process.exitCode = undefined
      const drive = async (): Promise<void> => {
        const program = new Command()
          .option('--config <path>', 'config file path')
          .addCommand(createEntitiesCommand())
          .addCommand(createKnowledgeCommand())
        program.exitOverride()
        await program.parseAsync(['node', 'agent-qa', '--config', configPath, ...args])
      }
      try {
        hostCompositions.count = 0
        await drive()

        expect(process.exitCode).toBe(1)
        expect(out.join('')).toBe('')
        const stderrText = err.join('\n')
        expect(stderrText).toContain(`Error: Secrets file could not be read: ${secretsPath}`)
        expect(stderrText).toContain('Check the path and file permissions before running tests.')
        expect(hostCompositions.count).toBe(0)

        rmSync(secretsPath, { recursive: true })
        writeFileSync(secretsPath, '')
        await drive()
        expect(hostCompositions.count > 0).toBe(composes)
      } finally {
        process.exitCode = priorExit
        log.mockRestore()
        error.mockRestore()
        stdout.mockRestore()
        stderr.mockRestore()
      }
    },
  )
})
