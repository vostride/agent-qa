// Each member is exercised against real wiring, because typed nulls would pass a shape check.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

import { createJobKindRegistry, invokeFunction } from '@vostride/agent-qa-agent'
import type { JobKindRegistry, JobModelCapability } from '@vostride/agent-qa-agent'
import {
  COMMIT_RECEIPT_SCHEMA_VERSION,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  QUARANTINE_UNASSIGNED_OWNER,
  asRef,
  asEvidenceToken,
  canonicalJson,
  slugBranch,
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import {
  QUARANTINE_LEDGER_FILENAME,
  applyRunOutcomes,
  createLocalKnowledgeStore,
  readGateReceipts,
  indexDbPath,
  projectRunOutcomes,
} from '@vostride/agent-qa-knowledge-local'
import {
  FsEventLog,
  FsEvidenceArtifactStore,
  FsHandoffStore,
  RUNS_SUBDIR,
} from '@vostride/agent-qa-runner-local'
import type {
  CompletedRunHandoff,
  ElementInfo,
  FunctionCaller,
  MaskedResolvedConfig,
  QuarantineLedgerEvent,
  RunAnalysisArtifact,
  RunEventEnvelope,
  ScreenState,
  StepEvidence,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPromotionFloorFixture, markReceipt } from './fixtures/promotion-capabilities.js'

import { writeAnalysisArtifact } from '../../analysis/persist-analysis.js'
import { AGENT_JOB_STORE_DB_FILE } from '../../store/sqlite-job-store.js'
import {
  composeLocalAgent,
  createKnowledgeReview,
  LOCAL_CURATION_CAPABILITIES,
  DIGEST_JOB_ID_SOURCE,
  postRunCapabilities,
  SYSTEM_CLOCK,
} from '../compose-local-agent.js'
import type {
  ComposeLocalAgentInput,
  LocalAgentHost,
  RunExecutionPort,
} from '../compose-local-agent.js'

// Passthrough: this fixture already speaks canonical workspace-relative bytes.
const MINT_IDENTITY = (filePath: string): string => filePath

const CALLER: FunctionCaller = {
  surface: 'cli',
  origin: 'agent',
}

const AUTHORSHIP_KIND = 'analyze-run' as const
const AUTHORSHIP_CHECKPOINT = 'analysis'

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [{ key: 'use.llm', value: 'default', source: 'config-file', masked: false }],
}

/**
 * A model that RECORDS what it was asked and answers with its own id.
 *
 * The id travelling out in the answer is what makes "the queue authored with the capability the
 * composition bound" assertable: a second capability substituted anywhere on the path would put a
 * different string in the checkpoint.
 */
function recordingModel(modelId: string): JobModelCapability & {
  invocations: () => number
  prompts: () => readonly string[]
} {
  const prompts: string[] = []
  return {
    modelId,
    generate: (request) => {
      prompts.push(request.prompt)
      return Promise.resolve({ text: `answered by ${modelId}` })
    },
    invocations: () => prompts.length,
    prompts: () => prompts,
  }
}

/** One checkpointed kind whose handler authors through the engine's authorship primitive. */
function authoringKinds(): JobKindRegistry {
  return createJobKindRegistry([
    {
      kind: AUTHORSHIP_KIND,
      checkpointed: true,
      checkpointSchedule: [AUTHORSHIP_CHECKPOINT],
      allowedSuccessors: [],
      maxAttempts: 3,
      backoff: { kind: 'none' },
      onPermanentFailure: 'halt-chain',
      async handler(context) {
        await context.recordLlmAuthorship(
          AUTHORSHIP_CHECKPOINT,
          (model) => model.generate({ prompt: `summarise ${context.job.summary}` }),
        )
        return { status: 'complete', next: [] }
      },
    },
  ])
}

describe('composeLocalAgent', () => {
  let root: string
  let agentQaRoot: string
  let model: ReturnType<typeof recordingModel>
  let modelFactoryCalls: number
  let knowledgeRootCalls: number
  let configReads: number
  let host: LocalAgentHost

  function compose(
    overrides: {
      jobKinds?: JobKindRegistry
      runExecution?: RunExecutionPort
      knowledgeRoot?: () => Promise<string> | string
      feedback?: ComposeLocalAgentInput['feedback']
    } = {},
  ): LocalAgentHost {
    return composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: {
        getMasked: () => {
          configReads += 1
          return Promise.resolve(MASKED_CONFIG)
        },
      },
      knowledgeRoot: () => {
        knowledgeRootCalls += 1
        return join(root, 'knowledge')
      },
      model: () => {
        modelFactoryCalls += 1
        return model
      },
      ...overrides,
    })
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-compose-local-'))
    agentQaRoot = join(root, '.agent-qa')
    mkdirSync(agentQaRoot, { recursive: true })
    model = recordingModel('fixture:composed-model')
    modelFactoryCalls = 0
    knowledgeRootCalls = 0
    configReads = 0
    host = compose()
  })

  it.each([true, false])('review apply forwards persisted commitReceipt with strict absence (%s)', async present => {
    const proposalId = `prop_${randomUUID()}`
    const commitReceipt = { schemaVersion: COMMIT_RECEIPT_SCHEMA_VERSION as typeof COMMIT_RECEIPT_SCHEMA_VERSION, proposalId, committedAtOrdinal: 12,
      recordIds: ['fact-confirmed'], gate3: [{ candidateId: 'fact-confirmed', receiptDigest: 'a'.repeat(64) }],
      promoted: [{ candidateId: 'fact-confirmed', promotionPath: 'user-sovereign' as const }], held: [] }
    mkdirSync(join(agentQaRoot, 'proposals'), { recursive: true })
    const planted = join(agentQaRoot, 'proposals', `${proposalId}.applied.json`)
    writeFileSync(planted, JSON.stringify({
      proposal: { schemaVersion: 1, proposalId, verb: 'accept',
        targetRef: { grain: 'record', recordId: 'fact-confirmed' }, deltas: [],
        proposedAt: 1, status: 'applied' },
      ...(present ? { commitReceipt } : {}),
    }))
    const before = readFileSync(planted, 'utf8')
    const review = createKnowledgeReview({ agentQaRoot, resolveKnowledgeRoot: () => join(root, 'knowledge') })
    expect(Object.keys(review)).toEqual(['change'])
    expect(readFileSync(planted, 'utf8')).toBe(before)
  })

  it('exposes only the existing writer edge for receipt and promotion capabilities', () => {
    expect(LOCAL_CURATION_CAPABILITIES.recordGateReceipt).toBeTypeOf('function')
    expect(LOCAL_CURATION_CAPABILITIES.canaryOutcomeObservationId).toBeTypeOf('function')
    expect(LOCAL_CURATION_CAPABILITIES.promoteWithReceipts).toBeTypeOf('function')
    expect(Object.isFrozen(LOCAL_CURATION_CAPABILITIES)).toBe(true)
  })

  it('feedback is bound only when the host supplies the port', async () => {
    expect(host.registry.list(CALLER).find(entry => entry.id === 'runs.mark')).toMatchObject({ bindingStatus: 'unbound' })
    const feedback = { mark: vi.fn(), marksFor: vi.fn(async () => []) }
    const bound = compose({ feedback })
    try {
      expect(bound.registry.list(CALLER).find(entry => entry.id === 'runs.mark')).toMatchObject({ bindingStatus: 'bound' })
    } finally { await bound.close() }
  })

  it.each(['knowledge', 'test-draft'] as const)('the curation capabilities neither file nor withdraw a mark %s proposal, and leave a legacy one untouched', async proposalKind => {
    const capabilities = LOCAL_CURATION_CAPABILITIES as unknown as Record<string, unknown>
    expect(capabilities.withdrawPendingProposal).toBeUndefined()
    expect(capabilities.fileMarkTestDraft).toBeUndefined()
    const proposalId = `prop_${randomUUID()}`
    const payload = proposalKind === 'knowledge' ? {
      schemaVersion: 1, proposalId, verb: 'accept', targetRef: { grain: 'record', recordId: 'record-fixture' }, deltas: [], proposedAt: Date.now(), status: 'pending',
    } : {
      schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION, draftRef: { filePath: 'tests/draft.yaml', testId: 'fixture', testName: 'Checkout', contentDigest: 'digest' }, targetPath: 'tests/checkout.yaml', disposition: 'unverified', runsPreviewed: 0, runsConsumed: 0, repairIterations: 0, summaryLine: 'Checkout edit',
    }
    // The legacy record is planted as raw bytes, because no store in this package writes it.
    mkdirSync(join(agentQaRoot, 'proposals'), { recursive: true })
    writeFileSync(join(agentQaRoot, 'proposals', `${proposalId}.json`), `${JSON.stringify({
      schemaVersion: 1, id: proposalId, kind: proposalKind,
      origin: { emittedBy: 'runs.mark', at: Date.now() }, payload }, undefined, 2)}\n`)
    const before = readFileSync(join(agentQaRoot, 'proposals', `${proposalId}.json`), 'utf8')
    await host.close()
    host = compose()
    expect(readFileSync(join(agentQaRoot, 'proposals', `${proposalId}.json`), 'utf8')).toBe(before)
  })

  it('promotes through the caller held lease and records one floor line', async () => {
    const knowledgeRoot = join(root, 'knowledge')
    const fixture = createPromotionFloorFixture({ knowledgeRoot })
    const lease = LOCAL_CURATION_CAPABILITIES.maintenance.acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected test authority')
    try {
      const { draft, published } = fixture.publishHeldCandidate('composition')
      const input = { knowledgeRoot, executionContext: 'local-interactive' as const,
        lease: { leaseId: lease.leaseId, epoch: lease.epoch }, sourceBuildOrdinal: 46 }
      const store = createLocalKnowledgeStore({ ...input, writerLeaseId: lease.leaseId, epoch: lease.epoch })
      await store.commit([{ kind: 'Confirm', origin: 'agent', scope: draft.scope,
        citedIds: [published.id], targetId: published.id, evidenceToken: asEvidenceToken('composition-confirm'),
        authorship: { path: 'deterministic-fallback', executionContext: 'local-interactive' } }])
      await expect(LOCAL_CURATION_CAPABILITIES.promoteWithReceipts({ ...input, candidateId: published.id }))
        .resolves.toEqual({ kind: 'promoted', promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [] })
      expect(readGateReceipts(published.dir, published.id)).toHaveLength(1)
      await expect(LOCAL_CURATION_CAPABILITIES.promoteWithReceipts({ ...input, candidateId: published.id }))
        .resolves.toEqual({ kind: 'already-active', promotionPath: 'deterministic-verdict-floor' })
      expect(readGateReceipts(published.dir, published.id)).toHaveLength(1)
      const receipt = markReceipt(published.id)
      await expect(LOCAL_CURATION_CAPABILITIES.recordGateReceipt({ ...input, receipt })).resolves.toEqual({ kind: 'appended' })
      await expect(LOCAL_CURATION_CAPABILITIES.recordGateReceipt({ ...input, receipt })).resolves.toEqual({ kind: 'duplicate' })
      const invalid = { ...input, lease: { leaseId: 'foreign', epoch: lease.epoch } }
      await expect(LOCAL_CURATION_CAPABILITIES.recordGateReceipt({ ...invalid, receipt })).rejects.toThrow()
      await expect(LOCAL_CURATION_CAPABILITIES.promoteWithReceipts({ ...invalid, candidateId: published.id })).rejects.toThrow()
      expect(readGateReceipts(published.dir, published.id)).toHaveLength(2)
    } finally {
      LOCAL_CURATION_CAPABILITIES.maintenance.releaseLease({ knowledgeRoot, leaseId: lease.leaseId })
    }
  })

  afterEach(() => {
    host.close()
    rmSync(root, { recursive: true, force: true })
  })

  // ---- the registry half ----------------------------------------------------------------

  it('binds the seed capabilities: a run op answers from the runs directory it was handed', async () => {
    const runDir = join(agentQaRoot, 'runs', 'main-abc')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'handoff.json'),
      JSON.stringify({
        schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
        runId: 'run_composed_fixture' as CompletedRunHandoff['runId'],
        scope: { tier: 'product', key: 'shop' },
        buildOrdinal: 1,
        executionContext: 'local-headless',
        aggregateVerdict: 'passed',
        configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
        startedAt: 1_000,
        endedAt: 2_000,
        tests: [],
      } satisfies CompletedRunHandoff),
      'utf8',
    )

    const rows = await invokeFunction(host.registry, 'runs.list', {}, CALLER) as readonly {
      runId: string
    }[]

    // The port really enumerated the fixture. An unbound registry answers `[]` here, which is
    // exactly why the fixture is planted rather than the empty case being asserted.
    expect(rows.map((row) => row.runId)).toEqual(['run_composed_fixture'])
  })

  it('consults the INJECTED config port rather than resolving configuration of its own', async () => {
    const masked = await invokeFunction(host.registry, 'config.get', {}, CALLER)

    expect(masked).toEqual(MASKED_CONFIG)
    expect(configReads).toBe(1)
  })

  it('writes NO execution-audit row at the project root for an invocation', async () => {
    await expect(invokeFunction(host.registry, 'config.get', {}, CALLER)).resolves.toBeDefined()

    expect(existsSync(join(agentQaRoot, 'execution_audit.jsonl'))).toBe(false)
  })

  // ---- the durable half -----------------------------------------------------------------

  it('does NOT open the job database until a host asks for it', () => {
    // The lazy-wrong implementation of "the handle carries the queue" is an eager one, and it is
    // invisible to every other test in this file: `agent-qa fn --list` would silently create a
    // queue database in a project that has never enqueued anything.
    expect(existsSync(join(agentQaRoot, AGENT_JOB_STORE_DB_FILE))).toBe(false)
    expect(modelFactoryCalls).toBe(0)
    expect(knowledgeRootCalls).toBe(0)
  })

  it('opens a real sqlite store and runs a job to a real checkpoint file', async () => {
    host = compose({ jobKinds: authoringKinds() })
    const jobs = await host.jobs()

    expect(existsSync(join(agentQaRoot, AGENT_JOB_STORE_DB_FILE))).toBe(true)

    const fence = await jobs.store.adoptEpoch(1)
    const enqueued = await jobs.queue.enqueue(AUTHORSHIP_KIND, { runRef: 'run_1' }, 'key-a')
    const outcome = await jobs.queue.runNextJob({ fence })

    expect(outcome).toMatchObject({ ran: true, checkpointsPublished: [AUTHORSHIP_CHECKPOINT] })

    const checkpointPath = join(
      agentQaRoot,
      'agent-jobs',
      'checkpoints',
      String(enqueued.job.id),
      `${AUTHORSHIP_CHECKPOINT}.json`,
    )
    expect(existsSync(checkpointPath)).toBe(true)

    const dump = await jobs.store.dumpState()
    expect(dump.jobs).toHaveLength(1)
    expect(dump.jobs[0]).toMatchObject({ status: 'done', attempts: 1 })
  })

  // ---- the model binding ----------------------------------------------------------------

  it('authors with the capability the composition bound, proven by the id in the recorded bytes', async () => {
    host = compose({ jobKinds: authoringKinds() })
    const jobs = await host.jobs()

    const fence = await jobs.store.adoptEpoch(1)
    const enqueued = await jobs.queue.enqueue(AUTHORSHIP_KIND, { runRef: 'run_1' }, 'key-a')
    await jobs.queue.runNextJob({ fence })

    expect(model.invocations()).toBe(1)
    expect(jobs.model.modelId).toBe('fixture:composed-model')

    const recorded = JSON.parse(readFileSync(
      join(
        agentQaRoot,
        'agent-jobs',
        'checkpoints',
        String(enqueued.job.id),
        `${AUTHORSHIP_CHECKPOINT}.json`,
      ),
      'utf8',
    )) as { value: { value: { text: string } } }

    // Asserting the ANSWER rather than the call count: a capability that was constructed and then
    // discarded in favour of another still shows one invocation somewhere, but the id it stamped
    // into the durable bytes can only be the id of the capability the engine actually called.
    expect(JSON.stringify(recorded)).toContain('answered by fixture:composed-model')
  })

  it('resolves the model exactly once, however many times the queue is asked for', async () => {
    const first = await host.jobs()
    const second = await host.jobs()

    expect(second).toBe(first)
    expect(modelFactoryCalls).toBe(1)
  })

  it('opens the database once under concurrent callers', async () => {
    const [first, second] = await Promise.all([host.jobs(), host.jobs()])

    // Memoizing the resolved VALUE instead of the promise leaves a window in which two callers
    // each run the factory and each open the database. Awaiting both together is the only shape
    // that can see it.
    expect(second).toBe(first)
    expect(modelFactoryCalls).toBe(1)
  })

  it('closes what it opened, and closing a host that opened nothing is a no-op', async () => {
    const untouched = compose()
    expect(() => untouched.close()).not.toThrow()

    const jobs = await host.jobs()
    host.close()
    await expect(jobs.store.dumpState()).rejects.toThrow()
  })

  // ---- the defaults, named ---------------------------------------------------------------

  it('derives job ids from (kind, key) so two hosts address the same row', () => {
    expect(String(DIGEST_JOB_ID_SOURCE.jobIdFor('analyze-run', 'key-a')))
      .toBe(String(DIGEST_JOB_ID_SOURCE.jobIdFor('analyze-run', 'key-a')))
    expect(String(DIGEST_JOB_ID_SOURCE.jobIdFor('analyze-run', 'key-a')))
      .not.toBe(String(DIGEST_JOB_ID_SOURCE.jobIdFor('analyze-run', 'key-b')))
  })

  it('defaults the clock to wall time in the format every store column is written in', () => {
    expect(host.clock).toBe(SYSTEM_CLOCK)
    expect(SYSTEM_CLOCK.now()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u)
  })

  // ---- runs.start: what this host can and cannot do ------------------------------

  it('lists runs.start as UNBOUND when this composition has no run executor', async () => {
    const declaration = host.registry.list(CALLER).find((entry) => entry.id === 'runs.start')

    expect(declaration).toMatchObject({ bindingStatus: 'unbound' })
    expect(Object.keys(declaration ?? {})).not.toContain('requiredScopes')
    await expect(invokeFunction(host.registry, 'runs.start', {}, CALLER))
      .rejects.toMatchObject({ name: 'FunctionNotBoundError' })
  })

  it('binds runs.start as soon as a host supplies one — the same composition, one argument apart', async () => {
    const started: string[] = []
    const bound = compose({
      runExecution: {
        execute: () => {
          const runId = 'run_composed_start'
          started.push(runId)
          new FsEventLog({ root: agentQaRoot, runId }).append({
            seq: 1,
            ts: 1_700_000_000_001,
            runId,
            type: 'runStarted',
            payload: {},
          } as RunEventEnvelope)
          new FsHandoffStore({ root: agentQaRoot, runId }).save({
            schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
            runId: runId as CompletedRunHandoff['runId'],
            scope: { tier: 'product', key: 'shop' },
            buildOrdinal: 3,
            executionContext: 'local-headless',
            aggregateVerdict: 'passed',
            configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
            startedAt: 1_700_000_000_001,
            endedAt: 1_700_000_000_009,
            tests: [],
          })
          return Promise.resolve({ runId: runId as CompletedRunHandoff['runId'] })
        },
      },
    })

    try {
      expect(bound.registry.list(CALLER).find((entry) => entry.id === 'runs.start'))
        .toMatchObject({ bindingStatus: 'bound' })
      expect(await invokeFunction(bound.registry, 'runs.start', {}, CALLER)).toMatchObject({
        runId: 'run_composed_start',
        buildOrdinal: 3,
        scope: { tier: 'product', key: 'shop' },
      })
      expect(started).toEqual(['run_composed_start'])
    } finally {
      bound.close()
    }
  })

  it('refuses a run executor that reported a run it never ran', async () => {
    // The composition's own evidence check, against the run's real event log on disk. This is
    // the laziest wrong binding — a port that returns a well-formed id — and it is the one a
    // suite asserting only "runs.start is bound" would have accepted.
    const fabricating = compose({
      runExecution: {
        execute: () => Promise.resolve({ runId: 'run_never_happened' as CompletedRunHandoff['runId'] }),
      },
    })
    try {
      await expect(invokeFunction(fabricating.registry, 'runs.start', {}, CALLER))
        .rejects.toMatchObject({ name: 'RunProducedNoEventsError' })
    } finally {
      fabricating.close()
    }
  })

  const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
  const REBUILD_INSTRUCTION = 'run `pnpm --filter @vostride/agent-qa-agent-local build` or `pnpm build`'
    + ' at the repository root first; a stale bundle certifies the previous revision'

  function newestBundleInput(): { path: string; mtimeMs: number } {
    const config = join(PACKAGE_ROOT, 'tsdown.config.ts')
    let newest = { path: relative(PACKAGE_ROOT, config), mtimeMs: statSync(config).mtimeMs }
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.isFile() || /\.test(?:-d)?\.ts$/u.test(entry.name)) continue
        const { mtimeMs } = statSync(full)
        if (mtimeMs > newest.mtimeMs) newest = { path: relative(PACKAGE_ROOT, full), mtimeMs }
      }
    }
    walk(join(PACKAGE_ROOT, 'src'))
    return newest
  }

  // vitest resolves the source, so only the built bundle shows a lost `node:` prefix, and a bare
  // `sqlite` specifier resolves to nothing.
  it('keeps the node: protocol in the published bundle, or the store cannot be imported', () => {
    const newest = newestBundleInput()
    for (const file of ['index.js', 'index.cjs']) {
      const path = join(PACKAGE_ROOT, 'dist', file)
      expect(existsSync(path), `dist/${file} is missing; ${REBUILD_INSTRUCTION}`).toBe(true)
      const stale = `${newest.path} is newer than dist/${file}; ${REBUILD_INSTRUCTION}`
      expect(statSync(path).mtimeMs, stale).toBeGreaterThanOrEqual(newest.mtimeMs)
      const bundle = readFileSync(path, 'utf8')
      expect(bundle).toContain('node:sqlite')
      expect(bundle).not.toMatch(/(?:from|import|require\()\s*["']sqlite["']/)
    }
  })

  // ---- the analysis bindings: analysis reader, recurrence, capability members ----------

  describe('the analysis bindings', () => {
    const ANALYZED_RUN_ID = 'run_bound_analysis'
    const TEST_FILE_PATH = 'tests/checkout.yaml'
    const TEST_NAME = 'checkout loads'

    function knowledgeRootDir(): string {
      return join(root, 'knowledge')
    }

    function failedHandoff(runId: string, buildOrdinal: number): CompletedRunHandoff {
      return {
        schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
        runId: runId as CompletedRunHandoff['runId'],
        scope: { tier: 'product', key: 'shop' },
        buildOrdinal,
        executionContext: 'local-headless',
        aggregateVerdict: 'failed',
        configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
        startedAt: 1_000,
        endedAt: 2_000,
        tests: [
          {
            testId: 't_checkout',
            testName: TEST_NAME,
            filePath: TEST_FILE_PATH,
            testIndex: 0,
            outcome: 'failed',
            steps: [],
          },
        ],
      }
    }

    function plantHandoff(handoff: CompletedRunHandoff): string {
      const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(String(handoff.runId)))
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, 'handoff.json'), `${JSON.stringify(handoff)}\n`, 'utf8')
      return runDir
    }

    /** Seeds the derived run-outcome projection through the real writer path. */
    function seedOutcome(handoff: CompletedRunHandoff): void {
      const path = indexDbPath(knowledgeRootDir())
      mkdirSync(dirname(path), { recursive: true })
      const db = new DatabaseSync(path)
      try {
        applyRunOutcomes(db, projectRunOutcomes(handoff, { extractAnchors: () => [] }))
      } finally {
        db.close()
      }
    }

    function authoredArtifact(runId: string): RunAnalysisArtifact {
      return {
        schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
        runId,
        verdicts: [
          {
            class: 'app_bug',
            producer: 'analyze-run',
            confidence: 0.9,
            evidence: {
              citedSteps: [],
              citedAnchors: [],
              citedArtifacts: [],
              rationale: 'the checkout endpoint answered 500 on every attempt',
            },
            memoryMisdirectionRuledOut: true,
            perTest: 0,
          },
        ],
        parts: [
          {
            perTest: 0,
            groundingQuote: { source: 'test-outcome', quote: 'failed' },
            discriminator: 'the endpoint failed identically without memory involvement',
            nextAction: 'inspect the checkout endpoint logs',
            links: [],
          },
        ],
      }
    }

    type AnalysisAnswer = {
      verdicts: readonly { class: string; producer: string; confidence: number }[]
      sentences: readonly { sentence: string }[]
    }

    it('lists analysis.get as BOUND and answers the deterministic floor when no artifact exists', async () => {
      plantHandoff(failedHandoff(ANALYZED_RUN_ID, 1))

      expect(host.registry.list(CALLER).find((entry) => entry.id === 'analysis.get'))
        .toMatchObject({ bindingStatus: 'bound' })

      const answer = await invokeFunction(
        host.registry, 'analysis.get', { runId: ANALYZED_RUN_ID }, CALLER,
      ) as AnalysisAnswer

      // Artifact absent: the answer is the minted unknown.
      expect(answer.verdicts).toEqual([
        {
          perTest: 0, testId: 't_checkout', class: 'unknown',
          producer: 'deterministic-classifier', confidence: 0,
          // The deterministic floor cites nothing; an exact match keeps it the minted unknown only.
          evidence: { citedSteps: [], citedArtifacts: [] },
        },
      ])
      expect(answer.sentences[0]!.sentence).toContain('no failure history is recorded for this test')
    })

    it('serves a persisted artifact through the version guard — the round-trip', async () => {
      const runDir = plantHandoff(failedHandoff(ANALYZED_RUN_ID, 1))
      writeAnalysisArtifact(join(runDir, 'analysis.json'), authoredArtifact(ANALYZED_RUN_ID))

      const answer = await invokeFunction(
        host.registry, 'analysis.get', { runId: ANALYZED_RUN_ID }, CALLER,
      ) as AnalysisAnswer

      expect(answer.verdicts[0]).toMatchObject({
        class: 'app_bug', producer: 'analyze-run', confidence: 0.9,
      })
      expect(answer.sentences[0]!.sentence).toContain('app_bug: observed (test outcome): "failed"')
    })

    it('refuses a PRESENT artifact recording another run\'s id — floor by identity, adoption once corrected', async () => {
      // The two-sided-contract pin law: BOTH legs have the file PRESENT on run B's own
      // path — only the recorded runId varies — which is what distinguishes the identity
      // refusal from absence. The write half derives this path FROM artifact.runId; a
      // copied/restored run directory is exactly a foreign runId on the resolved path.
      const runDir = plantHandoff(failedHandoff(ANALYZED_RUN_ID, 1))

      // Foreign leg: guard-admissible bytes authored for ANOTHER run, on THIS run's path.
      writeAnalysisArtifact(join(runDir, 'analysis.json'), authoredArtifact('run_foreign_sibling'))
      const foreign = await invokeFunction(
        host.registry, 'analysis.get', { runId: ANALYZED_RUN_ID }, CALLER,
      ) as AnalysisAnswer

      // The run's OWN deterministic floor — never the foreign app_bug verdict or its parts.
      expect(foreign.verdicts).toEqual([
        {
          perTest: 0, testId: 't_checkout', class: 'unknown',
          producer: 'deterministic-classifier', confidence: 0,
          // The deterministic floor cites nothing; an exact match keeps it the minted unknown only.
          evidence: { citedSteps: [], citedArtifacts: [] },
        },
      ])
      expect(foreign.sentences[0]!.sentence).toContain('unknown:')
      expect(foreign.sentences[0]!.sentence).not.toContain('app_bug')

      // Control leg: the SAME artifact with runId corrected to this run, on the SAME path.
      writeAnalysisArtifact(join(runDir, 'analysis.json'), authoredArtifact(ANALYZED_RUN_ID))
      const adopted = await invokeFunction(
        host.registry, 'analysis.get', { runId: ANALYZED_RUN_ID }, CALLER,
      ) as AnalysisAnswer
      expect(adopted.verdicts[0]).toMatchObject({
        class: 'app_bug', producer: 'analyze-run', confidence: 0.9,
      })
    })

    it('propagates a newer artifact schema version as the typed error, never a silent floor', async () => {
      const runDir = plantHandoff(failedHandoff(ANALYZED_RUN_ID, 1))
      writeFileSync(
        join(runDir, 'analysis.json'),
        `${JSON.stringify({
          schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION + 1,
          runId: ANALYZED_RUN_ID,
          verdicts: [],
          parts: [],
        })}\n`,
        'utf8',
      )

      await expect(
        invokeFunction(host.registry, 'analysis.get', { runId: ANALYZED_RUN_ID }, CALLER),
      ).rejects.toMatchObject({ name: 'AnalysisVersionError' })
    })

    it('joins recurrence LIVE per call: a store update between two invocations changes the clause', async () => {
      plantHandoff(failedHandoff(ANALYZED_RUN_ID, 1))
      seedOutcome(failedHandoff(ANALYZED_RUN_ID, 1))

      const first = await invokeFunction(
        host.registry, 'analysis.get', { runId: ANALYZED_RUN_ID }, CALLER,
      ) as AnalysisAnswer
      expect(first.sentences[0]!.sentence)
        .toContain('failure 1 of this test in the last 1 builds')

      // A second failure of the same identity between invocations; the live join must see it.
      seedOutcome(failedHandoff('run_bound_analysis_b', 2))

      const second = await invokeFunction(
        host.registry, 'analysis.get', { runId: ANALYZED_RUN_ID }, CALLER,
      ) as AnalysisAnswer
      expect(second.sentences[0]!.sentence)
        .toContain('failure 2 of this test in the last 2 builds')
    })

    it('primes an ASYNC knowledge root before the sync join — the CLI-host resolver shape', async () => {
      // The CLI root resolver is async and the seam sync, so the invocation resolves it first.
      plantHandoff(failedHandoff(ANALYZED_RUN_ID, 1))
      seedOutcome(failedHandoff(ANALYZED_RUN_ID, 1))

      const asyncHost = compose({
        knowledgeRoot: () => Promise.resolve().then(() => knowledgeRootDir()),
      })
      try {
        const answer = await invokeFunction(
          asyncHost.registry, 'analysis.get', { runId: ANALYZED_RUN_ID }, CALLER,
        ) as AnalysisAnswer
        expect(answer.sentences[0]!.sentence)
          .toContain('failure 1 of this test in the last 1 builds')
      } finally {
        await asyncHost.close()
      }
    })

    // Two failed members: only a second verdict mints a second promise while one is in flight.

    function twoFailureHandoff(runId: string, buildOrdinal: number): CompletedRunHandoff {
      return {
        ...failedHandoff(runId, buildOrdinal),
        tests: [
          {
            testId: 't_checkout',
            testName: TEST_NAME,
            filePath: TEST_FILE_PATH,
            testIndex: 0,
            outcome: 'failed',
            steps: [],
          },
          {
            testId: 't_login',
            testName: 'login loads',
            filePath: 'tests/login.yaml',
            testIndex: 1,
            outcome: 'failed',
            steps: [],
          },
        ],
      }
    }

    it('never crashes the render on a rejecting async resolver', async () => {
      // Prime's mint plus one re-mint; the second join reuses the in-flight promise.
      const runId = 'run_rejecting_resolver'
      plantHandoff(twoFailureHandoff(runId, 1))

      let resolverCalls = 0
      const rejectingHost = compose({
        knowledgeRoot: () => {
          resolverCalls += 1
          return Promise.reject(new Error('config resolution failed'))
        },
      })
      const orphaned: unknown[] = []
      const capture = (reason: unknown): void => {
        orphaned.push(reason)
      }
      process.on('unhandledRejection', capture)
      try {
        const answer = await invokeFunction(
          rejectingHost.registry, 'analysis.get', { runId }, CALLER,
        ) as AnalysisAnswer

        // Settle two macrotask turns so any orphaned rejection lands inside this test's
        // lifetime rather than after the listener is removed.
        await new Promise((resolve) => setImmediate(resolve))
        await new Promise((resolve) => setImmediate(resolve))

        expect(answer.sentences).toHaveLength(2)
        for (const entry of answer.sentences) {
          expect(entry.sentence).toContain('no failure history is recorded for this test')
        }
        expect(orphaned).toEqual([])
        expect(resolverCalls).toBe(2)
      } finally {
        process.removeListener('unhandledRejection', capture)
        await rejectingHost.close()
      }
    })

    it('degrades a sync-throwing resolver to the no-history clause instead of failing the read', async () => {
      // A read that needs no knowledge root must never fail on one: a resolver that throws
      // SYNCHRONOUSLY is swallowed to the same degrade as a rejecting async one, so the
      // wrapped runs.get hop the op awaits cannot reject on a knowledge-root problem.
      const runId = 'run_throwing_resolver'
      plantHandoff(twoFailureHandoff(runId, 1))

      const throwingHost = compose({
        knowledgeRoot: () => {
          throw new Error('sync config resolution failed')
        },
      })
      try {
        const answer = await invokeFunction(
          throwingHost.registry, 'analysis.get', { runId }, CALLER,
        ) as AnalysisAnswer

        expect(answer.sentences).toHaveLength(2)
        for (const entry of answer.sentences) {
          expect(entry.sentence).toContain('no failure history is recorded for this test')
        }
      } finally {
        await throwingHost.close()
      }
    })

    it('retries a failed resolution on the next query — the transient contract', async () => {
      // The rejection handler clearing the in-flight marker is the retry-on-transient
      // contract: a later query whose resolver now succeeds must render the seeded
      // recurrence clause, never a provider pinned to permanent no-history. This is the
      // pinned CONTROL the single-flight fix must keep green.
      const runId = 'run_transient_resolver'
      plantHandoff(twoFailureHandoff(runId, 1))
      seedOutcome(twoFailureHandoff(runId, 1))

      let failing = true
      const transientHost = compose({
        knowledgeRoot: () =>
          failing
            ? Promise.reject(new Error('transient config failure'))
            : Promise.resolve(knowledgeRootDir()),
      })
      try {
        const first = await invokeFunction(
          transientHost.registry, 'analysis.get', { runId }, CALLER,
        ) as AnalysisAnswer
        expect(first.sentences).toHaveLength(2)
        for (const entry of first.sentences) {
          expect(entry.sentence).toContain('no failure history is recorded for this test')
        }

        failing = false
        await new Promise((resolve) => setImmediate(resolve))

        const second = await invokeFunction(
          transientHost.registry, 'analysis.get', { runId }, CALLER,
        ) as AnalysisAnswer
        expect(second.sentences).toHaveLength(2)
        for (const entry of second.sentences) {
          expect(entry.sentence).toContain('failure 1 of this test in the last 1 builds')
        }
      } finally {
        await transientHost.close()
      }
    })

    // ---- the capability members, bound here (postRunCapabilities) --------

    function capabilityInput(
      overrides: Partial<ComposeLocalAgentInput> = {},
    ): ComposeLocalAgentInput {
      return {
        mask: (text) => text,
        agentQaRoot,
        mintQuarantineIdentityPath: MINT_IDENTITY,
        config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
        knowledgeRoot: () => knowledgeRootDir(),
        model: () => model,
        postRun: {
          curateRun: () => Promise.resolve({ curated: 0, deprecated: 0, complete: true }),
          candidateProse: 'masker-active',
        },
        ...overrides,
      }
    }

    it('binds readTestHistory over the projection store, keyed the projection way', () => {
      seedOutcome(failedHandoff(ANALYZED_RUN_ID, 1))
      const caps = postRunCapabilities(capabilityInput(), knowledgeRootDir())!

      const history = caps.readTestHistory?.({
        product: 'shop', filePath: TEST_FILE_PATH, testName: TEST_NAME,
      })
      expect(history).toMatchObject({ failures: 1, passes: 0, lastBuildOrdinal: 1 })

      // An identity the projection never counted is a TYPED absence, not an empty row.
      expect(caps.readTestHistory?.({
        product: 'shop', filePath: 'tests/other.yaml', testName: 'other',
      })).toBeUndefined()
    })

    it('answers undefined history when the knowledge store has never been created', () => {
      const caps = postRunCapabilities(capabilityInput(), join(root, 'nowhere'))!
      expect(caps.readTestHistory?.({
        product: 'shop', filePath: TEST_FILE_PATH, testName: TEST_NAME,
      })).toBeUndefined()
    })

    it('round-trips an evidence blob by sha and refuses a malformed sha before any path use', () => {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      const stored = new FsEvidenceArtifactStore({ root: agentQaRoot, runId: ANALYZED_RUN_ID })
        .persistDecisionScreenshot(bytes)
      const caps = postRunCapabilities(capabilityInput(), knowledgeRootDir())!

      expect(caps.readEvidenceBlob?.(ANALYZED_RUN_ID, stored.sha)).toEqual(bytes)
      // The 64-hex guard precedes the join, so a traversal-shaped sha answers `undefined`.
      expect(caps.readEvidenceBlob?.(ANALYZED_RUN_ID, '../../etc/passwd')).toBeUndefined()
      expect(caps.readEvidenceBlob?.(ANALYZED_RUN_ID, 'a'.repeat(64))).toBeUndefined()
    })

    it('passes the host-supplied analysisTokenBudget through untouched, absent when unsupplied', () => {
      // The input carries a FACTORY (the model idiom, resolved once at queue open);
      // postRunCapabilities receives the RESOLVED value and passes it through untouched.
      const budget = { estimate: (text: string) => text.length, inputBudget: 123 }
      const withBudget = postRunCapabilities(
        capabilityInput({ analysisTokenBudget: () => budget }), knowledgeRootDir(), budget,
      )!
      expect(withBudget.analysisTokenBudget).toBe(budget)

      const without = postRunCapabilities(capabilityInput(), knowledgeRootDir())!
      expect(without.analysisTokenBudget).toBeUndefined()

      // No postRun input → no capability bag at all.
      const bagless = capabilityInput()
      expect(postRunCapabilities(
        { ...bagless, postRun: undefined } as unknown as ComposeLocalAgentInput,
        knowledgeRootDir(),
      )).toBeUndefined()
    })

    it('keys the readTestHistory binding the projection way — no testId in the binding source', () => {
      const source = readFileSync(
        new URL('../compose-local-agent.ts', import.meta.url),
        'utf8',
      )
      // The region spans the projection-read helper through the capability bag, the whole binding.
      const start = source.indexOf('function readProjectedTestHistory')
      expect(start).toBeGreaterThan(-1)
      const end = source.indexOf('export function composeLocalAgent', start)
      const body = source
        .slice(start, end)
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
        .join('\n')
      expect(body).toContain('readTestOutcomeHistory')
      expect(body).not.toContain('testId')
    })
  })

  // The recurrence clause and `quarantine.list` must read one live computation.

  describe('the quarantine bindings', () => {
    const QUARANTINED_RUN_ID = 'run_quarantine_a'
    const TEST_FILE_PATH = 'tests/checkout.yaml'
    const TEST_NAME = 'checkout loads'
    const PRODUCT = 'shop'

    const WRITE_CALLER: FunctionCaller = {
      surface: 'cli',
      origin: 'agent',
    }

    const IDENTITY = { product: PRODUCT, filePath: TEST_FILE_PATH, testName: TEST_NAME }

    function knowledgeRootDir(): string {
      return join(root, 'knowledge')
    }

    function failedHandoff(runId: string, buildOrdinal: number): CompletedRunHandoff {
      return {
        schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
        runId: runId as CompletedRunHandoff['runId'],
        scope: { tier: 'product', key: PRODUCT },
        buildOrdinal,
        executionContext: 'local-headless',
        aggregateVerdict: 'failed',
        configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
        startedAt: 1_000,
        endedAt: 2_000,
        tests: [{
          testId: 't_checkout',
          testName: TEST_NAME,
          filePath: TEST_FILE_PATH,
          testIndex: 0,
          outcome: 'failed',
          steps: [],
        }],
      }
    }

    // Only the anchor name varies, so two runs of one test carry different fingerprints.
    function steppedHandoff(
      runId: string,
      buildOrdinal: number,
      anchorName: string,
    ): CompletedRunHandoff {
      const element: ElementInfo = {
        ref: asRef('e1'),
        role: 'button',
        name: anchorName,
        nameNormalized: anchorName.trim().toLowerCase(),
        state: { enabled: true, focused: false, visible: true },
        labels: {},
        attributes: {},
      }
      const stateBefore: ScreenState = {
        platform: 'web',
        tree: '',
        elements: [element],
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
      }
      const step: StepEvidence = {
        stepIndex: 0,
        stepText: `click the ${anchorName} button`,
        cacheStatus: 'miss',
        servedBrief: {
          scope: { tier: 'product', key: PRODUCT },
          asOfBuild: buildOrdinal,
          budget: 0,
          truncation: 'none',
          channel1: [],
          channel2: [],
          channel3: [],
          briefDigest: 'compose-brief-digest',
        },
        subActions: [{
          plan: `click ${anchorName}`,
          plannedAction: { type: 'click', ref: element.ref },
          stateBefore,
          result: { success: false, error: `Error: element "${anchorName}" not found` },
        }],
        verifierVerdict: { pass: false, reasoning: `the ${anchorName} button never appeared` },
      }
      const base = failedHandoff(runId, buildOrdinal)
      return { ...base, tests: [{ ...base.tests[0]!, steps: [step] }] }
    }

    function plantHandoff(handoff: CompletedRunHandoff): string {
      const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(String(handoff.runId)))
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, 'handoff.json'), `${JSON.stringify(handoff)}\n`, 'utf8')
      return runDir
    }

    /** Seeds the derived projection — counters AND the fingerprint window — the real writer way. */
    function seedOutcome(handoff: CompletedRunHandoff): void {
      const path = indexDbPath(knowledgeRootDir())
      mkdirSync(dirname(path), { recursive: true })
      const db = new DatabaseSync(path)
      try {
        applyRunOutcomes(db, projectRunOutcomes(handoff, { extractAnchors: () => [] }))
      } finally {
        db.close()
      }
    }

    function plantLedger(events: readonly QuarantineLedgerEvent[]): void {
      mkdirSync(knowledgeRootDir(), { recursive: true })
      writeFileSync(
        join(knowledgeRootDir(), QUARANTINE_LEDGER_FILENAME),
        `${events.map((event) => canonicalJson(event)).join('\n')}\n`,
        'utf8',
      )
    }

    function enteredEvent(overrides: Partial<Record<string, unknown>> = {}): QuarantineLedgerEvent {
      return {
        schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
        kind: 'entered',
        at: '2026-08-05T10:00:00.000Z',
        ...IDENTITY,
        fingerprint: 'fp-compose',
        verdictClass: 'flake',
        owner: QUARANTINE_UNASSIGNED_OWNER,
        expiresAt: '2126-09-04T10:00:00.000Z',
        ...overrides,
      } as QuarantineLedgerEvent
    }

    async function sentenceFor(runId: string): Promise<string> {
      const answer = await invokeFunction(
        host.registry, 'analysis.get', { runId }, CALLER,
      ) as { sentences: readonly { sentence: string }[] }
      return answer.sentences[0]!.sentence
    }

    function ledgerText(): string {
      return readFileSync(join(knowledgeRootDir(), QUARANTINE_LEDGER_FILENAME), 'utf8')
    }

    // ---- the binding itself ---------------------------------------------------------------

    it('lists all three quarantine verbs as BOUND on this composition', () => {
      const listed = host.registry.list(WRITE_CALLER)
      for (const id of ['quarantine.list', 'quarantine.release', 'quarantine.add']) {
        expect(listed.find((entry) => entry.id === id)).toMatchObject({ bindingStatus: 'bound' })
      }
    })

    it('answers an empty list against a knowledge root with no ledger', async () => {
      expect(await invokeFunction(host.registry, 'quarantine.list', {}, CALLER))
        .toEqual({ entries: [] })
    })

    it('add / list / release operate on the REAL committed ledger under the knowledge root', async () => {
      const added = await invokeFunction(
        host.registry, 'quarantine.add', IDENTITY, WRITE_CALLER,
      ) as { kind: string; entry: { owner: string; state: string } }

      expect(added.kind).toBe('entered')
      expect(added.entry).toMatchObject({ owner: QUARANTINE_UNASSIGNED_OWNER, state: 'quarantined' })
      // The bytes really landed in the committed file, not in some in-memory stand-in.
      expect(ledgerText()).toContain('"kind":"entered"')

      const listed = await invokeFunction(host.registry, 'quarantine.list', {}, CALLER) as {
        entries: readonly { filePath: string; state: string }[]
      }
      expect(listed.entries).toEqual([expect.objectContaining({
        filePath: TEST_FILE_PATH, state: 'quarantined',
      })])

      const releasedAnswer = await invokeFunction(
        host.registry, 'quarantine.release', IDENTITY, WRITE_CALLER,
      ) as { kind: string }
      expect(releasedAnswer.kind).toBe('released')
      expect(ledgerText()).toContain('"kind":"released-manual"')

      // …and the release is a typed arm the second time, not a throw.
      expect(await invokeFunction(host.registry, 'quarantine.release', IDENTITY, WRITE_CALLER))
        .toEqual({ kind: 'no-entry' })
    })

    // ---- one computation, two surfaces ------------------------------------------------

    it('a ledger mutation between two analysis.get calls changes the clause, and the SAME mutation shows in quarantine.list', async () => {
      plantHandoff(failedHandoff(QUARANTINED_RUN_ID, 1))
      seedOutcome(failedHandoff(QUARANTINED_RUN_ID, 1))

      const before = await sentenceFor(QUARANTINED_RUN_ID)
      expect(before).toContain('failure 1 of this test in the last 1 builds')
      expect(before).not.toContain('quarantined until')

      // ONE mutation, through the bound write verb — the same ledger both surfaces read.
      await invokeFunction(host.registry, 'quarantine.add', IDENTITY, WRITE_CALLER)

      const after = await sentenceFor(QUARANTINED_RUN_ID)
      expect(after).toContain('failure 1 of this test in the last 1 builds; quarantined until ')
      expect(after).not.toBe(before)

      // The list verb's half of the same computation, id-addressed to the same identity.
      const listed = await invokeFunction(host.registry, 'quarantine.list', {}, CALLER) as {
        entries: readonly { filePath: string; testName: string; state: string }[]
      }
      expect(listed.entries).toEqual([expect.objectContaining({
        filePath: TEST_FILE_PATH, testName: TEST_NAME, state: 'quarantined',
      })])

      // And releasing it takes the clause back — the join is live in BOTH directions.
      await invokeFunction(host.registry, 'quarantine.release', IDENTITY, WRITE_CALLER)
      expect(await sentenceFor(QUARANTINED_RUN_ID)).toBe(before)
    })

    it('renders the QUARANTINED arm with the recorded deadline, byte for byte', async () => {
      plantHandoff(failedHandoff(QUARANTINED_RUN_ID, 1))
      seedOutcome(failedHandoff(QUARANTINED_RUN_ID, 1))
      // The default fixture deadline is far future, so the fold answers `quarantined`.
      plantLedger([enteredEvent()])

      expect(await sentenceFor(QUARANTINED_RUN_ID)).toContain(
        'failure 1 of this test in the last 1 builds; quarantined until Sep 4',
      )
    })

    it('renders the EXPIRED arm with the recorded deadline — failures count again', async () => {
      plantHandoff(failedHandoff(QUARANTINED_RUN_ID, 1))
      seedOutcome(failedHandoff(QUARANTINED_RUN_ID, 1))
      // The SAME entry with a deadline already behind it: suppression stopped, the entry stays
      // listed, and the clause says so. Only `expiresAt` varies between this leg and the one
      // above, which is what makes the two arms a differential rather than two fixtures.
      plantLedger([enteredEvent({
        at: '2025-08-05T10:00:00.000Z',
        expiresAt: '2025-09-04T10:00:00.000Z',
      })])

      expect(await sentenceFor(QUARANTINED_RUN_ID)).toContain(
        'failure 1 of this test in the last 1 builds; quarantine expired Sep 4 — failures count again',
      )
    })

    it('propagates an UNREADABLE ledger rather than rendering a test as un-quarantined', async () => {
      plantHandoff(failedHandoff(QUARANTINED_RUN_ID, 1))
      seedOutcome(failedHandoff(QUARANTINED_RUN_ID, 1))
      mkdirSync(knowledgeRootDir(), { recursive: true })
      writeFileSync(
        join(knowledgeRootDir(), QUARANTINE_LEDGER_FILENAME),
        `${JSON.stringify({
          ...enteredEvent(),
          schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION + 1,
        })}\n`,
        'utf8',
      )

      // Committed truth this build cannot read is a refusal, never a healed absence.
      await expect(sentenceFor(QUARANTINED_RUN_ID))
        .rejects.toMatchObject({ name: 'QuarantineLedgerVersionError' })
      await expect(invokeFunction(host.registry, 'quarantine.list', {}, CALLER))
        .rejects.toMatchObject({ name: 'QuarantineLedgerVersionError' })
    })

    // ---- the fingerprint-keyed rebind ------------------------------------------------------

    it('counts recurrence per FINGERPRINT, not per test — two different failures of one test stay apart', async () => {
      // Same identity, two different anchors: the fingerprint window answers `failure 1`.
      plantHandoff(steppedHandoff('run_fp_a', 1, 'Submit'))
      plantHandoff(steppedHandoff('run_fp_b', 2, 'Pay'))
      seedOutcome(steppedHandoff('run_fp_a', 1, 'Submit'))
      seedOutcome(steppedHandoff('run_fp_b', 2, 'Pay'))

      expect(await sentenceFor('run_fp_b'))
        .toContain('failure 1 of this test in the last 2 builds')

      // Control: a third build with the first anchor recurs, so run A's fingerprint counts two.
      plantHandoff(steppedHandoff('run_fp_c', 3, 'Submit'))
      seedOutcome(steppedHandoff('run_fp_c', 3, 'Submit'))

      expect(await sentenceFor('run_fp_a'))
        .toContain('failure 2 of this test in the last 3 builds; suspected flaky')
    })
  })
})
