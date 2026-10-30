// A completed in-process drain prints the digest; any other leg prints the count and fetch command.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyCanaryCreditCounters } from '../canary-credit.js'
import {
  completedRunDir,
  CURATION_TAIL_RECEIPT_FILE,
  CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
  readCurationTailReceipt,
} from '../curation-tail.js'
import type { Mock } from 'vitest'

import { chainJobIdsForRun, renderVerdictSentence } from '@vostride/agent-qa-agent'
import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { composeLocalAgent, DIGEST_JOB_ID_SOURCE } from '@vostride/agent-qa-agent-local'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import {
  asRunId,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CurationSnapshotSchema,
  CURRENT_BUS_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
  CURATION_SNAPSHOT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  AnalysisGetOutput,
  CompletedRunHandoff,
  PostProcessingStatus,
  RunDigest,
  RunEventEnvelope,
  RunNotificationView,
  Verdict,
  VerdictSentenceParts,
} from '@vostride/agent-qa-schema'

import {
  digestFetchCommand,
  renderAnalysisClusterBlock,
  runPostRunTail,
  type PostRunTailOperations,
  type RunPostRunTailOptions,
} from '../post-run-tail.js'
import {
  createPostVerdictStep,
  releaseUntakenPostVerdictLease,
  type PostVerdictStepOperations,
} from '../post-verdict-step.js'
import { enqueueThroughTheStep } from '../../__tests__/post-run-step-harness.js'

const agentQaRoot = '/workspace/project/.agent-qa'
const configDir = '/workspace/project'
const configPath = '/workspace/project/agent-qa.config.yaml'
const knowledgeRoot = '/workspace/project/agent-qa-knowledge'
const runId = 'run-post-run-tail-sentences'
const OWN_CHAIN = chainJobIdsForRun(runId, DIGEST_JOB_ID_SOURCE)

/** The exact fetch command the extended exit line must carry — the real `digest` verb. */
const FETCH_COMMAND = `agent-qa digest "${runId}"`

const handoff = {
  runId,
  schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
  executionContext: 'local-headless',
} as unknown as ReturnType<PostRunTailOperations['loadCompletedRunHandoff']>

// A real run directory, queue and handler bodies, the seams the mocked harness above stubs out.

const CHAIN_RUN_ID = 'run-snapshot-branch'
const chainRoots: string[] = []

afterEach(() => {
  for (const root of chainRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Unparseable text degrades the author to its deterministic floor; the chain mechanics stand. */
const CHAIN_MODEL: JobModelCapability = {
  modelId: 'test:snapshot-branch',
  generate: async () => ({ text: 'not an author payload' }),
}

const CHAIN_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/snapshot-branch.config.yaml',
    entries: [],
  }),
}

function chainHandoff(): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(CHAIN_RUN_ID),
    scope: { tier: 'product', key: 'snapshot-branch-storefront' },
    buildOrdinal: 7,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
    startedAt: 1,
    endedAt: 2,
    tests: [{
      testId: 't_timeout',
      testName: 'member the classifier reached',
      filePath: 'tests/checkout.yaml',
      testIndex: 0,
      outcome: 'timeout',
      steps: [],
      rootCause: {
        class: 'timeout',
        producer: 'deterministic-classifier',
        confidence: 1,
        evidence: {
          citedSteps: [0], citedAnchors: [], citedArtifacts: [],
          rationale: 'member outcome timeout',
        },
        memoryMisdirectionRuledOut: true,
        perTest: 0,
      },
    }],
  }
}

/** The run's own log as the runner left it — `runFinished` last, carrying its own `finalSeq`. */
const CHAIN_EVENT_LINES = [
  { seq: 1, ts: 10, runId: CHAIN_RUN_ID, type: 'runStarted', payload: { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION } },
  { seq: 2, ts: 20, runId: CHAIN_RUN_ID, type: 'verdict', payload: { verdict: 'failed' } },
  {
    seq: 3, ts: 30, runId: CHAIN_RUN_ID, type: 'runFinished',
    payload: { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: 3 },
  },
] as unknown as RunEventEnvelope[]

// ------------------------------------------------------------------------------------------
// The op-rendered fixture: sentences composed through the REAL barrel renderer, so the
// byte-equality assertion compares the tail's print against the one renderer's own output.
// ------------------------------------------------------------------------------------------

function appBugVerdict(perTest: number): Verdict {
  return {
    class: 'app_bug',
    producer: 'analyze-run',
    confidence: 0.9,
    evidence: {
      citedSteps: [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'the submit control is gone from the checkout DOM',
    },
    memoryMisdirectionRuledOut: true,
    perTest,
  } as Verdict
}

function partsFor(perTest: number, discriminator: string): VerdictSentenceParts {
  return {
    perTest,
    groundingQuote: { stepIndex: 2, quote: 'Error: element "Submit" not found' },
    discriminator,
    nextAction: 'file the failure against the application with the quoted evidence',
    links: [],
  }
}

const QUERY = { product: 'synthetic', filePath: 'tests/checkout.yaml', testName: 'checks out' }

/** The representative sentence of the two-member cluster — REAL renderer output. */
const CLUSTER_SENTENCE = renderVerdictSentence(
  appBugVerdict(0),
  partsFor(0, 'the same step passed on the previous build'),
  undefined,
  QUERY,
)
/** The singleton cluster's one sentence — also REAL renderer output. */
const SINGLETON_SENTENCE = renderVerdictSentence(
  appBugVerdict(2),
  partsFor(2, 'only this member exercised the legacy checkout'),
  undefined,
  QUERY,
)

function analysisOutput(): AnalysisGetOutput {
  return {
    runId,
    verdicts: [
      { perTest: 0, testId: 'TST-101', class: 'app_bug', producer: 'analyze-run', confidence: 0.9 },
      { perTest: 1, testId: 'TST-102', class: 'app_bug', producer: 'analyze-run', confidence: 0.8 },
      { perTest: 2, testId: 'TST-201', class: 'app_bug', producer: 'analyze-run', confidence: 0.7 },
    ],
    sentences: [
      { perTest: 0, testId: 'TST-101', sentence: CLUSTER_SENTENCE },
      { perTest: 1, testId: 'TST-102', sentence: CLUSTER_SENTENCE },
      { perTest: 2, testId: 'TST-201', sentence: SINGLETON_SENTENCE },
    ],
    clusters: [
      {
        fingerprint: 'fp-shared-anchor',
        count: 2,
        members: [
          { testIndex: 0, testId: 'TST-101' },
          { testIndex: 1, testId: 'TST-102' },
        ],
        representative: { testIndex: 0, sentence: CLUSTER_SENTENCE },
      },
      {
        fingerprint: 'fp-lonely',
        count: 1,
        members: [{ testIndex: 2, testId: 'TST-201' }],
        representative: { testIndex: 2, sentence: SINGLETON_SENTENCE },
      },
    ],
  }
}

// Composed through the real renderer, so the byte-equality legs compare against its own output.
function digestOutput(analysis: AnalysisGetOutput = analysisOutput()): RunDigest {
  const block = renderAnalysisClusterBlock(analysis)
  return {
    runId,
    verdictClusters: analysis.clusters,
    chain: { analysis: 'complete', curation: 'pending' },
    // The fixes this run's marks applied, read from its own ledger; no proposal is counted.
    markChanges: [
      { markId: 'mark_000000000001', ordinal: 1, fix: 'fact',
        change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: ['mem_1'] } },
      { markId: 'mark_000000000002', ordinal: 2, fix: 'test-edit',
        change: { kind: 'test-file', filePath: 'tests/checkout.yaml', contentDigest: 'abc' } },
    ],
    candidates: { curated: 0, deprecated: 0 },
    quarantine: { quarantined: 0, expired: 0, refs: [] },
    lines: [
      `digest — ${runId}`,
      ...(block === '' ? [] : [block]),
      'chain — analysis: complete · curation: pending',
      'marks — 2 changes applied:',
      '  mark_000000000001  fact: 1 record changed',
      '  mark_000000000002  test-edit: wrote tests/checkout.yaml',
      'candidates — 0 curated · 0 deprecated',
      'quarantine — 0 quarantined · 0 expired',
    ],
  }
}

function pendingStatus(): PostProcessingStatus {
  return {
    runId,
    chips: { analysis: 'pending', curation: 'pending' },
  }
}

function completeStatus(): PostProcessingStatus {
  return {
    runId,
    chips: { analysis: 'complete', curation: 'pending' },
  }
}

function terminalNotification(): RunNotificationView {
  return {
    schemaVersion: 2,
    runId,
    outcome: 'complete',
    verdictSummary: { total: 3, byClass: { app_bug: 3 } },
    stages: {
      analysis: { status: 'complete' },
      curation: { status: 'complete', curated: 2, deprecated: 0 },
    },
  } as unknown as RunNotificationView
}

// ------------------------------------------------------------------------------------------
// Harness: every operation injected, `info` captured — what is under test is which LINES the
// tail prints, from which posture, sourced from which op result.
// ------------------------------------------------------------------------------------------

interface Harness {
  operations: PostRunTailOperations
  runNextJob: ReturnType<typeof vi.fn>
  readRunDigest: ReturnType<typeof vi.fn>
  chipObserve: ReturnType<typeof vi.fn>
  info: Mock<(message: string) => void>
  warn: Mock<(message: string) => void>
  clock: { value: number }
}

function harness(overrides: {
  lease?: ReturnType<PostRunTailOperations['acquireWriterLease']>
  runNextJob?: ReturnType<typeof vi.fn>
  status?: PostProcessingStatus
  digest?: RunDigest
  readRunDigest?: ReturnType<typeof vi.fn>
} = {}): Harness {
  const clock = { value: 1_000 }
  const info = vi.fn<(message: string) => void>()
  const warn = vi.fn<(message: string) => void>()
  const runNextJob = overrides.runNextJob
    ?? vi.fn(async () => ({ ran: false, reason: 'no-job' }))
  const readRunDigest = overrides.readRunDigest
    ?? vi.fn(async () => overrides.digest ?? digestOutput())
  const chipObserve = vi.fn()

  const operations = {
    loadCompletedRunHandoff: vi.fn(() => handoff),
    resolveKnowledgeRoot: vi.fn(() => knowledgeRoot),
    composeHost: vi.fn(() => ({
      jobs: async () => ({
        queue: {
          enqueue: vi.fn(async () => ({ job: { id: 'job_analyze' }, deduped: false })),
          runNextJob,
          recoverAbandonedClaims: vi.fn(async () => ({ recovered: 0 })),
        },
        store: { adoptEpoch: vi.fn(async () => ({ epoch: 7 })) },
        idSource: DIGEST_JOB_ID_SOURCE,
      }),
      close: vi.fn(async () => undefined),
    })),
    acquireWriterLease: vi.fn(() => overrides.lease
      ?? { kind: 'acquired', leaseId: 'lease-1', epoch: 7 }),
    releaseLease: vi.fn(() => ({ kind: 'released' })),
    nudgeDaemon: vi.fn(async () => undefined),
    curateCompletedRun: vi.fn(async () => ({
      curated: 0,
      deprecated: 0,
      complete: true,
      drainKind: 'drained' as const,
    })),
    runCurationTail: vi.fn(async () => undefined),
    createChipEmitter: vi.fn(() => ({ observe: chipObserve })),
    readPostProcessingStatus: vi.fn(async () => overrides.status ?? pendingStatus()),
    readRunDigest,
    now: () => clock.value,
  } as unknown as PostRunTailOperations

  return { operations, runNextJob, readRunDigest, chipObserve, info, warn, clock }
}

function options(h: Harness): RunPostRunTailOptions {
  return {
    runId,
    agentQaRoot,
    configPath,
    knowledgeConfig: { dir: 'agent-qa-knowledge' },
    configDir,
    mask: (text: string) => text,
    log: {
      warn: (message: string) => h.warn(message),
      info: (message: string) => h.info(message),
    },
    operations: h.operations,
  }
}

it('pending preparation cannot be represented by an unrelated empty drain or receipt', async () => {
  const h = harness()
  const tail = runPostRunTail({ ...options(h), postVerdict: {
    outcome: undefined,
    completion: new Promise(() => undefined), pendingPath: '/owned/run/post-verdict-pending.json',
    takeAcquiredLease: () => undefined, takeUnclaimedLease: () => undefined,
  } })
  await tail.drain()
  await tail.finish()
  expect(tail.report()).toEqual({ preparationPending: true, drain: 'not-attempted', jobsRun: 0 })
  expect(h.runNextJob).not.toHaveBeenCalled()
  expect(h.operations.runCurationTail).not.toHaveBeenCalled()
  expect(h.info.mock.calls.flat().join('\n')).toContain('analysis is not yet queued')
  expect(h.readRunDigest).not.toHaveBeenCalled()
})

it('the host wait and terminal recovery/pump spend the same deadline', async () => {
  const h = harness()
  const recovery = vi.fn(async (input) => { h.clock.value = input.deadlineMs; return [] })
  const tail = runPostRunTail({ ...options(h), enqueueOutcome: 'enqueued', deadlineMs: 1001,
    operations: { ...h.operations, recoverPendingPostVerdictContinuations: recovery } })
  await tail.drain()
  expect(recovery.mock.calls[0]![0].deadlineMs).toBe(1001)
  expect(h.runNextJob).not.toHaveBeenCalled()
  expect(tail.report().drain).toBe('backlog-exhausted')
})

/** A pump script: the given outcomes in order, then an emptied queue. */
function pump(outcomes: readonly unknown[]): ReturnType<typeof vi.fn> {
  let call = 0
  return vi.fn(async () => outcomes[call++] ?? { ran: false, reason: 'no-job' })
}

const ANALYZE_COMPLETED = {
  ran: true,
  disposition: 'completed',
  job: { id: String(OWN_CHAIN.analyzeRun) },
}

describe('the digest block — in-process analyze-run completed', () => {
  it('prints the digest after the exit line, bytes identical to the op result', async () => {
    const h = harness({ runNextJob: pump([ANALYZE_COMPLETED]), status: completeStatus() })
    const tail = runPostRunTail(options(h))
    await tail.drain()
    await tail.finish()

    const lines = h.info.mock.calls.map(([message]) => String(message))
    expect(lines).toHaveLength(2)
    // The exit line first, with no fetch command on this leg: the digest itself is one line down.
    expect(lines[0]).toBe('post-processing — analysis: complete · curation: pending')
    expect(lines[0]).not.toContain('agent-qa digest')
    expect(lines[0]).not.toContain('changes applied')

    // The block IS the op result's lines, joined and printed — nothing added, nothing
    // reordered, nothing annotated.
    const block = lines[1] as string
    expect(block).toBe(digestOutput().lines.join('\n'))
    // One sentence per cluster, with counts and refs on multi-member clusters.
    expect(block).toContain(
      'analysis — 2 distinct problems:\n'
      + `×2: TST-101, TST-102\n${CLUSTER_SENTENCE}\n`
      + SINGLETON_SENTENCE,
    )
    // Byte-equality, stated on its own: the printed sentence IS the renderer's output for the
    // same (verdict, parts, recurrence answer) — composed above through the real barrel
    // renderer, never a local composer.
    expect(block).toContain(CLUSTER_SENTENCE)
    expect(block).toContain(SINGLETON_SENTENCE)
    // …and the digest carries what the sentence block never could: what this run's marks changed.
    expect(block).toContain('marks — 2 changes applied:')
    expect(h.readRunDigest).toHaveBeenCalledTimes(1)
    expect(h.readRunDigest.mock.calls[0]![1]).toBe(runId)
  })

  it('prints the block after the terminal human line when the chain finished', async () => {
    const h = harness({
      runNextJob: pump([ANALYZE_COMPLETED]),
      status: { ...completeStatus(), notification: terminalNotification() },
    })
    const tail = runPostRunTail(options(h))
    await tail.drain()
    await tail.finish()

    const lines = h.info.mock.calls.map(([message]) => String(message))
    expect(lines).toHaveLength(2)
    // This line is rendered from the row and nothing else; no fetch command is grafted on.
    expect(lines[0]).toContain(`post-processing complete for ${runId}`)
    expect(lines[0]).not.toContain('agent-qa digest')
    expect(lines[1]).toContain(CLUSTER_SENTENCE)
  })

  it.each([
    [CURATION_TAIL_RECEIPT_SCHEMA_VERSION, false],
    [3, false],
    [CURATION_TAIL_RECEIPT_SCHEMA_VERSION, true],
  ] as const)('terminal caller renders counters only from a current receipt stamped %s (non-signal counts=%s)', async (schemaVersion, nonSignal) => {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-terminal-canary-'))
    try {
      const runDir = completedRunDir(root, runId)
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, CURATION_TAIL_RECEIPT_FILE), JSON.stringify({
        schemaVersion, runId, handoffDigest: 'a'.repeat(64), projectionVersion: 1,
        drainKind: 'drained', handoffHolderPid: null, candidateIds: [],
        ...(schemaVersion === CURATION_TAIL_RECEIPT_SCHEMA_VERSION ? { canary: { ...emptyCanaryCreditCounters(), rideAlongUncredited: 2,
          ...(nonSignal ? { nonSignal: { environment: 1, timeout: 2, flake: 3 }, rerunExcluded: 2 } : {}) } } : {}),
      }))
      const h = harness({ runNextJob: pump([ANALYZE_COMPLETED]),
        status: { ...completeStatus(), notification: terminalNotification() } })
      const tail = runPostRunTail({ ...options(h), agentQaRoot: root })
      await tail.drain()
      await tail.finish()
      const line = String(h.info.mock.calls[0]?.[0])
      if (nonSignal) expect(line).toContain('non-signal 6 (environment 1, timeout 2, flake 3), rerun-excluded 2')
      else if (schemaVersion === CURATION_TAIL_RECEIPT_SCHEMA_VERSION) expect(line).toContain('curation: complete (2 curated, 0 deprecated; canary: ride-along 2, non-signal 0, rerun-excluded 0)')
      else expect(line).not.toContain('canary:')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('still prints the block when the budget ran out AFTER analyze-run completed in-process',
    async () => {
      // Triggered by this process seeing analyze-run complete in budget, not by the drain outcome.
      const h = harness({
        runNextJob: vi.fn(async () => ANALYZE_COMPLETED),
        status: completeStatus(),
      })
      let reads = 0
      ;(h.operations as { now: () => number }).now = () => 1_000 + (reads++) * 30_000
      const tail = runPostRunTail(options(h))
      await tail.drain()
      expect(tail.report().drain).toBe('budget-exhausted')
      await tail.finish()

      const lines = h.info.mock.calls.map(([message]) => String(message))
      expect(lines.some((line) => line.includes(CLUSTER_SENTENCE))).toBe(true)
      expect(lines.some((line) => line.includes('analysis.get'))).toBe(false)
    })

  it('drops the ANALYSIS SECTION for a zero-failure run, and still prints the digest', async () => {
    // A run with no failures still prints the digest; only its analysis section is empty.
    const h = harness({
      runNextJob: pump([ANALYZE_COMPLETED]),
      status: completeStatus(),
      digest: digestOutput({ runId, verdicts: [], sentences: [], clusters: [] }),
    })
    const tail = runPostRunTail(options(h))
    await tail.drain()
    await tail.finish()

    const lines = h.info.mock.calls.map(([message]) => String(message))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('post-processing — analysis: complete · curation: pending')
    expect(lines[1]).not.toContain('analysis — ')
    expect(lines[1]).toContain('marks — 2 changes applied:')
  })

  it('a failed digest read costs the BLOCK and nothing else — warned, never thrown', async () => {
    const h = harness({
      runNextJob: pump([ANALYZE_COMPLETED]),
      status: completeStatus(),
      readRunDigest: vi.fn(async () => {
        throw new Error('the digest could not be composed')
      }),
    })
    const tail = runPostRunTail(options(h))
    await tail.drain()
    await expect(tail.finish()).resolves.toBeUndefined()

    const lines = h.info.mock.calls.map(([message]) => String(message))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('post-processing —')
    expect(h.warn).toHaveBeenCalledTimes(1)
    const warning = String(h.warn.mock.calls[0]![0])
    expect(warning).toContain('the digest could not be composed')
    // The warning names the recovery path: the same fetch command the exit line carries.
    expect(warning).toContain(FETCH_COMMAND)
  })
})

describe('the extended exit line — everything else gets count + command', () => {
  it('extends the summary line under --detach: no block, no wait, one copy-paste', async () => {
    const h = harness()
    const tail = runPostRunTail(options(h))
    await tail.finish({ detached: true })

    expect(tail.report().drain).toBe('detached')
    const lines = h.info.mock.calls.map(([message]) => String(message))
    expect(lines).toEqual([
      'post-processing — analysis: pending · curation: pending'
      + ` · marks: 2 changes applied · digest: ${FETCH_COMMAND}`,
    ])
    // The digest IS read on this leg — the count on the line is its answer, not a guess — and
    // exactly once, because the pointer and the (unprinted) block share one read.
    expect(h.readRunDigest).toHaveBeenCalledTimes(1)
  })

  it('extends the summary line on hand-off — the daemon may drain, the command still fetches',
    async () => {
      const h = harness({ lease: { kind: 'held', holder: { pid: 4242 } } as never })
      const tail = runPostRunTail(options(h))
      await tail.drain()
      await tail.finish()

      expect(tail.report().drain).toBe('handed-off')
      const lines = h.info.mock.calls.map(([message]) => String(message))
      expect(lines).toHaveLength(1)
      const line = lines[0] as string
      // The literal verb and the run's id, per the acceptance criterion.
      expect(line).toContain('agent-qa digest')
      expect(line).toContain(runId)
      expect(line).toContain(`marks: 2 changes applied · digest: ${FETCH_COMMAND}`)
      expect(line).not.toContain(CLUSTER_SENTENCE)
      expect(h.readRunDigest).toHaveBeenCalledTimes(1)
    })

  it('extends the summary line when the budget went out before analyze-run completed', async () => {
    // The differential twin of the budget-exhausted BLOCK case above: same clock, same
    // dispositions — the one input that differs is WHICH own-chain job the pump claimed.
    const h = harness({
      runNextJob: vi.fn(async () => ({
        ran: true,
        disposition: 'completed',
        job: { id: String(OWN_CHAIN.curateMemory) },
      })),
    })
    let reads = 0
    ;(h.operations as { now: () => number }).now = () => 1_000 + (reads++) * 30_000
    const tail = runPostRunTail(options(h))
    await tail.drain()
    expect(tail.report().drain).toBe('budget-exhausted')
    await tail.finish()

    const lines = h.info.mock.calls.map(([message]) => String(message))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`marks: 2 changes applied · digest: ${FETCH_COMMAND}`)
    expect(lines[0]).not.toContain(CLUSTER_SENTENCE)
  })

  it('an analyze-run that FAILED in-process is not a completed one — fetch command, no block',
    async () => {
      const h = harness({
        runNextJob: pump([{
          ran: true,
          disposition: 'failed',
          job: { id: String(OWN_CHAIN.analyzeRun) },
        }]),
      })
      const tail = runPostRunTail(options(h))
      await tail.drain()
      await tail.finish()

      const lines = h.info.mock.calls.map(([message]) => String(message))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(`marks: 2 changes applied · digest: ${FETCH_COMMAND}`)
      expect(lines[0]).not.toContain(CLUSTER_SENTENCE)
    })

  it('keeps the POINTER and drops the COUNT when the digest could not be read', async () => {
    // No count is fabricated when the ledger read fails; the fetch command still prints.
    const h = harness({
      lease: { kind: 'held', holder: { pid: 4242 } } as never,
      readRunDigest: vi.fn(async () => {
        throw new Error('the digest could not be composed')
      }),
    })
    const tail = runPostRunTail(options(h))
    await tail.drain()
    await tail.finish()

    const line = String(h.info.mock.calls[0]![0])
    expect(line).toContain(`digest: ${FETCH_COMMAND}`)
    // `pending` on its own appears in the chip vocabulary; what must be absent is the marks
    // CLAUSE, which is the only place this line would state a count it never read.
    expect(line).not.toContain('proposals:')
    expect(line).not.toContain('marks:')
    expect(String(h.warn.mock.calls[0]![0])).toContain('the digest could not be composed')
  })
})

describe('declared values in post-run tail warnings', () => {
  it('a post-run tail warning shows a declared value only as its marker', async () => {
    const redactor = new SecretRedactor(SecretStore.fromEnvContent('PW_KEY=Hunter-42-zz\n'))
    const h = harness({
      runNextJob: pump([ANALYZE_COMPLETED]),
      status: completeStatus(),
      readRunDigest: vi.fn(async () => {
        throw new Error('the digest for Hunter-42-zz could not be composed')
      }),
    })
    const tail = runPostRunTail({
      ...options(h),
      mask: (text: string) => redactor.redactString(text),
    })
    await tail.drain()
    await tail.finish()

    const warnings = h.warn.mock.calls.map(([message]) => String(message))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[secret:PW_KEY]')
    expect(warnings.join('\n')).not.toContain('Hunter-42-zz')
  })
})

describe('prohibitions: never-wait and print-not-publish', () => {
  it('the print path emits NO chip or bus event — chips observe pump outcomes only', async () => {
    const h = harness({ runNextJob: pump([ANALYZE_COMPLETED]), status: completeStatus() })
    const tail = runPostRunTail(options(h))
    await tail.drain()
    const observedDuringPump = h.chipObserve.mock.calls.length
    expect(observedDuringPump).toBe(1)
    await tail.finish()

    // `finish` printed the digest; the emitter saw nothing new, and no call ever carried a
    // sentence — the tail prints, it does not publish (C13; runFinished consumers untouched).
    expect(h.chipObserve.mock.calls.length).toBe(observedDuringPump)
    for (const call of h.chipObserve.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('sentence')
    }
  })

  it('adds no wait, no poll and no second timing knob to the tail source', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(
      fileURLToPath(new URL('../post-run-tail.ts', import.meta.url)),
      'utf8',
    )
    // Never-wait as a measurement: the one timer aborts the budget signal at the deadline.
    expect(source).not.toMatch(/setInterval/u)
    expect(source.match(/setTimeout\(/gu)).toEqual(['setTimeout('])
    expect(source).toContain('setTimeout(() => { budget.abort() }, drainDeadlineMs - drainStartedMs)')
    expect(source).toContain('budgetTimer.unref()')
    // The one budget still stands imported — no second timing constant beside it.
    expect(source).toContain('DRAIN_BUDGET_MS')
    expect(source).not.toMatch(/60_000|60000/u)
  })
})

describe('the chain terminal line after a retry', () => {
  const FOREIGN_RETRY = {
    ran: true,
    disposition: 'retry-scheduled',
    reason: 'transient',
    retryDelayMs: 1_000,
    attemptsRemaining: 2,
    job: { id: 'job_some_other_run' },
  }

  type CloseOut = { drain: string; lines: string[] }

  async function closeOut(outcomes: readonly unknown[]): Promise<CloseOut> {
    const h = harness({
      runNextJob: pump(outcomes),
      status: { ...completeStatus(), notification: terminalNotification() },
    })
    const tail = runPostRunTail(options(h))
    await tail.drain()
    await tail.finish()
    return {
      drain: tail.report().drain,
      lines: h.info.mock.calls.map(([message]) => String(message)),
    }
  }

  function expectChainTerminal(result: CloseOut): void {
    expect(result.drain).toBe('drained')
    expect(result.lines.length).toBeGreaterThan(0)
    expect(result.lines[0]).toContain(`post-processing complete for ${runId}`)
    expect(result.lines.filter((line) => line.startsWith('post-processing — '))).toEqual([])
  }

  it('a chain that completes after a retry of another run closes with the chain terminal line', async () => {
    expectChainTerminal(await closeOut([FOREIGN_RETRY, ANALYZE_COMPLETED]))
  })

  it('a chain whose analysis an earlier process completed closes with the chain terminal line after a retry of another run', async () => {
    expectChainTerminal(await closeOut([
      FOREIGN_RETRY,
      { ran: true, disposition: 'completed', job: { id: String(OWN_CHAIN.curateMemory) } },
    ]))
  })

  it('an analysis that retries and then completes in one pump closes with the chain terminal line', async () => {
    expectChainTerminal(await closeOut([
      { ...FOREIGN_RETRY, job: { id: String(OWN_CHAIN.analyzeRun) } },
      ANALYZE_COMPLETED,
    ]))
  })
})

describe('the pure renderers (exported for exactly these pins)', () => {
  it('renderAnalysisClusterBlock: count+refs for multi-member clusters, bare sentence for singletons',
    () => {
      expect(renderAnalysisClusterBlock(analysisOutput())).toBe(
        'analysis — 2 distinct problems:\n'
        + `×2: TST-101, TST-102\n${CLUSTER_SENTENCE}\n`
        + SINGLETON_SENTENCE,
      )
      expect(renderAnalysisClusterBlock({ runId, verdicts: [], sentences: [], clusters: [] }))
        .toBe('')
    })

  it('renderAnalysisClusterBlock falls back to #testIndex only for a member with no testId', () => {
    const analysis = analysisOutput()
    const clusters = analysis.clusters.map((cluster, index) => (index === 0
      ? {
          ...cluster,
          members: [{ testIndex: 0, testId: '' }, { testIndex: 1, testId: 'TST-102' }],
        }
      : cluster))
    expect(renderAnalysisClusterBlock({ ...analysis, clusters }))
      .toContain('×2: #0, TST-102')
  })

  it('digestFetchCommand is the real verb invocation, byte-for-byte', () => {
    expect(digestFetchCommand(runId)).toBe(FETCH_COMMAND)
    // JSON-quoted, so a runId needing escaping cannot silently produce a broken command.
    expect(digestFetchCommand('run"x')).toBe('agent-qa digest "run\\"x"')
  })
})

// Observes which chain line a real snapshot-bearing run prints, through the shipped tail and op.

/** A committed fold's snapshot: one record in each bucket, so no bucket's count is a default. */
const COMMITTED_SNAPSHOT = CurationSnapshotSchema.parse({
  schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
  rows: [{
    recordId: 'record-added',
    bucket: 'added',
    changes: [{
      bucket: 'added',
      change: {
        schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
        recordId: 'record-added',
        change: 'added',
        atOrdinal: 7,
        sourceRunId: CHAIN_RUN_ID,
        observationId: 'observation-added',
      },
    }],
  }],
  breakdown: { added: 1, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 },
})

describe('the chain-terminal line a real snapshot-bearing run prints', () => {
  it('CHAIN-LINE-SNAPSHOT-BRANCH lists the five buckets in order, zeros included', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-snapshot-branch-'))
    chainRoots.push(root)
    const knowledge = join(root, 'knowledge')
    mkdirSync(knowledge, { recursive: true })
    const runDir = join(root, RUNS_SUBDIR, slugBranch(CHAIN_RUN_ID))
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(chainHandoff())}\n`, 'utf8')
    writeFileSync(join(runDir, 'events.jsonl'), `${CHAIN_EVENT_LINES
      .map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')

    const info = vi.fn<(message: string) => void>()
    const warn = vi.fn<(message: string) => void>()
    const composeChainHost = (): never => composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: (filePath: string) => filePath,
      agentQaRoot: root,
      config: CHAIN_CONFIG,
      knowledgeRoot: () => knowledge,
      model: () => CHAIN_MODEL,
      idSource: DIGEST_JOB_ID_SOURCE,
      postRun: {
        // The shipped shape: `curateRun`'s return carries the receipt's snapshot verbatim.
        curateRun: async () => ({
          curated: 1,
          deprecated: 0,
          complete: true,
          snapshot: COMMITTED_SNAPSHOT,
        }),
        candidateProse: 'masker-active',
      },
    }) as never
    const hostsOpened: { close: () => Promise<void> }[] = []
    const openChainHost = (): never => {
      const host = composeChainHost()
      hostsOpened.push(host as unknown as { close: () => Promise<void> })
      return host
    }

    const report = await runSafetyScope(
      { executionContext: 'local-headless' },
      async () => {
        await enqueueThroughTheStep({
          runId: CHAIN_RUN_ID,
          agentQaRoot: root,
          configPath: join(root, 'agent-qa.config.yaml'),
          composeHost: openChainHost,
        })
        const tail = runPostRunTail({
          runId: CHAIN_RUN_ID,
          agentQaRoot: root,
          configPath: join(root, 'agent-qa.config.yaml'),
          knowledgeConfig: { dir: 'knowledge' },
          configDir: root,
          log: { warn: (m: string) => warn(m), info: (m: string) => info(m) },
          operations: {
            resolveKnowledgeRoot: () => knowledge,
            runCurationTail: async () => undefined,
            composeHost: openChainHost,
          } as unknown as PostRunTailOperations,
        })
        await tail.drain()
        await tail.finish()
        return tail.report()
      },
    )
    for (const host of hostsOpened) await host.close()

    // The chain really did run to its terminal in this process — the branch under observation
    // is reachable only from a drained pump, so a `handed-off` or `budget-exhausted` report
    // would make everything below vacuous.
    expect(report.drain).toBe('drained')

    const lines = info.mock.calls.map(([message]) => String(message))
    const terminal = lines.find((message) => message.startsWith('post-processing complete for'))
    expect(terminal, `no chain-terminal line in:\n${lines.join('\n')}`).toBeDefined()

    // A recorded snapshot measured every bucket, so each zero prints as a measurement.
    expect(terminal).toContain(
      'curation: complete (added 1, confirmed 0, superseded 0, deprecated 0, proposed 0')
    // …and neither spelling of the legacy sentence survives beside it.
    expect(terminal).not.toContain(' curated')
    expect(terminal).not.toContain(' deprecated)')
  })

  // A fold that committed nothing prints zero buckets, never the legacy pair.
  it('CHAIN-LINE-ZERO-EFFECT prints five zero buckets for a run whose curation changed nothing', async () => {
    const zeroRun = 'run-chain-zero-effect'
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-zero-effect-'))
    chainRoots.push(root)
    const knowledge = join(root, 'knowledge')
    mkdirSync(knowledge, { recursive: true })
    const runDir = join(root, RUNS_SUBDIR, slugBranch(zeroRun))
    mkdirSync(runDir, { recursive: true })
    // A passing run with no step to learn from: its fold files no curation candidate.
    const passed = {
      ...chainHandoff(),
      runId: asRunId(zeroRun),
      scope: { tier: 'product', key: 'zero-effect-storefront' },
      aggregateVerdict: 'passed',
      tests: [{
        testId: 't_passed', testName: 'checks out', filePath: 'tests/checkout.yaml',
        testIndex: 0, outcome: 'passed', steps: [],
      }],
    }
    writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(passed)}\n`, 'utf8')
    writeFileSync(join(runDir, 'events.jsonl'), `${CHAIN_EVENT_LINES
      .map((line) => JSON.stringify({ ...line, runId: zeroRun, payload: line.type === 'runStarted'
        ? line.payload
        : line.type === 'verdict'
          ? { verdict: 'passed' }
          : { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: 3 } }))
      .join('\n')}\n`, 'utf8')

    const info = vi.fn<(message: string) => void>()
    const hostsOpened: { close: () => Promise<void> }[] = []
    const openChainHost = (input?: { readonly curateRun?: unknown }): never => {
      const host = composeLocalAgent({
        mask: (text: string) => text,
        mintQuarantineIdentityPath: (filePath: string) => filePath,
        agentQaRoot: root,
        config: CHAIN_CONFIG,
        knowledgeRoot: () => knowledge,
        model: () => CHAIN_MODEL,
        idSource: DIGEST_JOB_ID_SOURCE,
        postRun: {
          curateRun: input?.curateRun ?? (async () => {
            throw new Error('the enqueue host never folds')
          }),
          candidateProse: 'masker-active',
        },
      } as never)
      hostsOpened.push(host as unknown as { close: () => Promise<void> })
      return host as never
    }

    const report = await runSafetyScope(
      { executionContext: 'local-headless' },
      async () => {
        await enqueueThroughTheStep({
          runId: zeroRun,
          agentQaRoot: root,
          configPath: join(root, 'agent-qa.config.yaml'),
          composeHost: () => openChainHost(),
        })
        const tail = runPostRunTail({
          runId: zeroRun,
          agentQaRoot: root,
          configPath: join(root, 'agent-qa.config.yaml'),
          knowledgeConfig: { dir: 'knowledge' },
          configDir: root,
          log: { warn: () => undefined, info: (m: string) => info(m) },
          operations: {
            resolveKnowledgeRoot: () => knowledge,
            runCurationTail: async () => undefined,
            composeHost: openChainHost,
          } as unknown as PostRunTailOperations,
        })
        await tail.drain()
        await tail.finish()
        return tail.report()
      },
    )
    for (const host of hostsOpened) await host.close()

    expect(report.drain).toBe('drained')
    // The real fold wrote the record the line is about.
    expect(readCurationTailReceipt(runDir)?.snapshot).toEqual({
      schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
      rows: [],
      breakdown: { added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 },
    })
    const lines = info.mock.calls.map(([message]) => String(message))
    const terminal = lines.find((message) => message.startsWith('post-processing complete for'))
    expect(terminal, `no chain-terminal line in:\n${lines.join('\n')}`).toBeDefined()
    // A real fold's receipt also carries its canary counters, which close the same parenthesis.
    expect(terminal).toContain(
      'curation: complete (added 0, confirmed 0, superseded 0, deprecated 0, proposed 0; canary: '
      + 'ride-along 0, non-signal 0, rerun-excluded 0)')
    expect(terminal).not.toContain('curated')
  })
})

// These cells assert the fence state: is the writer lease still held after everything the run does?

/**
 * A writer lease with a HOLDER, so "is it released" is a readable fact rather than a spy call.
 *
 * The two shipped behaviours this run's code depends on, and nothing else: an acquisition mints a
 * new epoch when nobody holds it and answers `held` when somebody does, and a release clears the
 * holder only for the lease id that actually holds it. The second half is what makes a double
 * release visible instead of silently idempotent.
 */
function writerFence(): {
  readonly acquireWriterLease: ReturnType<typeof vi.fn>
  readonly releaseLease: ReturnType<typeof vi.fn>
  readonly holder: () => string | undefined
} {
  let holder: string | undefined
  let epoch = 0
  const acquireWriterLease = vi.fn((_knowledgeRoot: string) => {
    if (holder !== undefined) {
      return { kind: 'held', holder: { leaseId: holder, pid: 4242, epoch, heartbeatAtMs: 1 } }
    }
    epoch += 1
    holder = `lease-${epoch}`
    return { kind: 'acquired', leaseId: holder, epoch }
  })
  const releaseLease = vi.fn((input: { knowledgeRoot: string; leaseId: string }) => {
    if (holder === input.leaseId) holder = undefined
    return { kind: 'released' }
  })
  return { acquireWriterLease, releaseLease, holder: () => holder }
}

/** The step's table: an ordinary local run — nobody holds the lease, and the enqueue succeeds. */
function stepOperations(
  fence: ReturnType<typeof writerFence>,
  overrides: Record<string, unknown> = {},
): Partial<PostVerdictStepOperations> {
  return {
    // This legacy queue/lease harness substitutes IO; real ownership is exercised in post-verdict-continuation.test.ts.
    ownContinuation: async ({ enqueue }: Parameters<PostVerdictStepOperations['ownContinuation']>[0]) => await enqueue(),
    acquireWriterLease: fence.acquireWriterLease,
    releaseLease: fence.releaseLease,
    readWriterLease: vi.fn(() => ({ kind: 'absent' })),
    deriveWriterLeaseFreshness: vi.fn(() => ({ kind: 'fresh' })),
    nudgeDaemon: vi.fn(async () => undefined),
    loadCompletedRunHandoff: vi.fn(() => handoff),
    composeHost: vi.fn(() => ({
      jobs: async () => ({
        queue: { enqueue: vi.fn(async () => ({ job: { id: 'job_analyze' }, deduped: false })) },
      }),
      close: vi.fn(async () => undefined),
    })),
    now: () => 1_700_000_000_000,
    ...overrides,
  } as unknown as Partial<PostVerdictStepOperations>
}

/** The REAL step, composed over that fence, decided exactly as the shell decides it. */
async function decidedStep(
  fence: ReturnType<typeof writerFence>,
  overrides: Record<string, unknown> = {},
): Promise<ReturnType<typeof createPostVerdictStep>> {
  const step = createPostVerdictStep({
    runId,
    agentQaRoot,
    knowledgeRoot,
    configPath,
    log: { warn: () => undefined },
    operations: stepOperations(fence, overrides),
  })
  await step.port.run({ runId: runId as never, verdict: 'passed' as never })
  return step
}

/** The tail, over the same fence, with whatever the cell wants to break. */
function tailOverFence(
  h: Harness,
  fence: ReturnType<typeof writerFence>,
  overrides: Partial<PostRunTailOperations> = {},
): ReturnType<typeof runPostRunTail> {
  return runPostRunTail({
    ...options(h),
    operations: {
      ...h.operations,
      acquireWriterLease: fence.acquireWriterLease,
      releaseLease: fence.releaseLease,
      ...overrides,
    } as unknown as PostRunTailOperations,
  })
}

/** The drive's outermost close-out, verbatim in its effect: whatever nobody took is released. */
function closeOutRun(
  step: ReturnType<typeof createPostVerdictStep>,
  fence: ReturnType<typeof writerFence>,
): void {
  releaseUntakenPostVerdictLease({
    handoff: step.handoff,
    knowledgeRoot,
    runId,
    log: { warn: () => undefined },
    operations: {
      releaseLease: fence.releaseLease as unknown as PostVerdictStepOperations['releaseLease'],
    },
  })
}

describe('an acquired writer lease is released on EVERY path out of drain()', () => {
  it('releases it when composing the host throws, instead of holding the fence for its TTL',
    async () => {
      const fence = writerFence()
      const step = await decidedStep(fence)
      // THE LAZINESS, restated where this cell depends on it: the step DECIDED `drained` from a
      // non-acquiring read, so nothing is held yet and the pump's request is what will mint it.
      expect(fence.holder(), 'the decision reads the lease; it does not take it').toBeUndefined()
      expect(fence.acquireWriterLease).not.toHaveBeenCalled()

      const h = harness()
      const tail = tailOverFence(h, fence, {
        composeHost: vi.fn(() => {
          throw new Error('[vitest] No "curateCompletedRun" export is defined')
        }) as unknown as PostRunTailOperations['composeHost'],
      })

      await tail.drain({ takeLease: () => step.handoff.takeAcquiredLease() })
      closeOutRun(step, fence)

      // THE CLAIM. Not "a warning was logged" — the fence itself is free, so the next process to
      // ask is told the truth rather than being told to wait 30s on a pump that is not running.
      expect(
        fence.holder(),
        'a fence held by a process that stopped pumping is the defect this cell guards',
      ).toBeUndefined()
      // …and it is free because it was RELEASED, once, by the leg that took it — not because it
      // was never acquired. Both halves matter: the take is what the wire's `drained` promised.
      expect(fence.acquireWriterLease).toHaveBeenCalledTimes(1)
      expect(fence.releaseLease).toHaveBeenCalledTimes(1)
      expect(fence.releaseLease).toHaveBeenCalledWith({ knowledgeRoot, leaseId: 'lease-1' })
      // A composition that never came up attempted nothing, and the exit code is already frozen.
      expect(tail.report().drain).toBe('not-attempted')
      expect(h.warn).toHaveBeenCalledTimes(1)
    })

  it('acquires NOTHING when the knowledge root cannot be resolved — there is no address to release against',
    async () => {
      // The other half of the early return, and the reason the take sits where it does rather
      // than merely being wrapped: a release is addressed to a knowledge root, so a lease taken
      // before the root is known would be a lease nothing in this process could ever end.
      const fence = writerFence()
      const step = await decidedStep(fence)

      const h = harness()
      const tail = tailOverFence(h, fence, {
        resolveKnowledgeRoot: vi.fn(() => {
          throw new Error('no knowledge root is configured for this project')
        }) as unknown as PostRunTailOperations['resolveKnowledgeRoot'],
      })

      await tail.drain({ takeLease: () => step.handoff.takeAcquiredLease() })
      closeOutRun(step, fence)

      expect(fence.holder()).toBeUndefined()
      expect(
        fence.acquireWriterLease,
        'the take is what acquires, and it never happened — so there is nothing to leak',
      ).not.toHaveBeenCalled()
      expect(fence.releaseLease).not.toHaveBeenCalled()
      expect(tail.report().drain).toBe('not-attempted')
    })

  it('releases it when the pump itself throws, and reports `threw` rather than `not-attempted`',
    async () => {
      const fence = writerFence()
      const step = await decidedStep(fence)

      const h = harness()
      const tail = tailOverFence(h, fence, {
        composeHost: vi.fn(() => ({
          jobs: async () => { throw new Error('the durable store would not open') },
          close: vi.fn(async () => undefined),
        })) as unknown as PostRunTailOperations['composeHost'],
      })

      await tail.drain({ takeLease: () => step.handoff.takeAcquiredLease() })
      closeOutRun(step, fence)

      expect(fence.holder()).toBeUndefined()
      expect(fence.acquireWriterLease).toHaveBeenCalledTimes(1)
      expect(fence.releaseLease).toHaveBeenCalledTimes(1)
      // The host came up here, so this is the pump's failure, not a never-attempted composition.
      expect(tail.report().drain).toBe('threw')
    })
})

describe('the fallback consult, and the one door that declines it', () => {
  /** A step whose probe finds a CURRENT-EPOCH holder: plan `none`, so the take answers nothing. */
  async function stepWithAHolder(
    fence: ReturnType<typeof writerFence>,
  ): Promise<ReturnType<typeof createPostVerdictStep>> {
    return await decidedStep(fence, {
      readWriterLease: vi.fn(() => ({
        kind: 'parsed',
        lease: { leaseId: 'daemon', pid: 4242, epoch: 6, heartbeatAtMs: 1_700_000_000_000 },
      })),
    })
  }

  it('a take that answers `undefined` falls back to this pump\'s OWN acquisition by default',
    async () => {
      // The step acquired nothing, so the pump consults first; the holder may have released.
      const fence = writerFence()
      const step = await stepWithAHolder(fence)
      expect(step.handoff.takeAcquiredLease()).toBeUndefined()

      const h = harness()
      const tail = tailOverFence(h, fence)
      await tail.drain({ takeLease: () => step.handoff.takeAcquiredLease() })

      expect(fence.acquireWriterLease, 'the fallback consult is a real, first acquisition')
        .toHaveBeenCalledTimes(1)
      expect(tail.report().drain).toBe('drained')
      expect(fence.holder(), 'and it still leaves through exactly one release').toBeUndefined()
    })

  it('`withoutLease: \'skip\'` pumps nothing and composes nothing — the `runs.start` door rule',
    async () => {
      const fence = writerFence()
      const step = await stepWithAHolder(fence)

      const h = harness()
      const tail = tailOverFence(h, fence)
      await tail.drain({
        takeLease: () => step.handoff.takeAcquiredLease(),
        withoutLease: 'skip',
      })

      expect(fence.acquireWriterLease, 'this door consults for nobody but itself')
        .not.toHaveBeenCalled()
      expect(
        h.operations.composeHost as unknown as ReturnType<typeof vi.fn>,
        'and it opens no store for a chain it is not going to pump',
      ).not.toHaveBeenCalled()
      // `not-attempted` is what `finish({ detached: true })` reads to name the posture, which is
      // exactly what the caller-side `if` around this call used to produce.
      expect(tail.report().drain).toBe('not-attempted')
      expect(fence.holder()).toBeUndefined()
    })
})
