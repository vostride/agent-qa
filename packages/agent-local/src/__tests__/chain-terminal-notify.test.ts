// The real post-run chain; assertions read durable state, as exactly-once must survive a crash.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  chainJobIdsForRun,
  invokeFunction,
  RUNS_POST_PROCESSING_FUNCTION_ID,
} from '@vostride/agent-qa-agent'
import type {
  ClockPort,
  ConfigReaderPort,
  JobCheckpointRecord,
  JobModelCapability,
} from '@vostride/agent-qa-agent'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  asRunId,
  canonicalJson,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
  sha256hex,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  PostProcessingStatus,
  Verdict,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { composeLocalAgent, DIGEST_JOB_ID_SOURCE } from '../composition/compose-local-agent.js'
import type { LocalAgentHost, LocalAgentJobs } from '../composition/compose-local-agent.js'

// Passthrough: this fixture already speaks canonical workspace-relative bytes.
const MINT_IDENTITY = (filePath: string): string => filePath

const RUN_ID = 'run-alpha'

const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

// Unparseable text, so the author degrades per test to the deterministic floor, not aborting.
const TEST_MODEL: JobModelCapability = {
  modelId: 'test:chain-terminal-notify',
  generate: async () => ({ text: 'not an author payload' }),
}

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/chain-terminal-notify.config.yaml',
    entries: [],
  }),
}

/** Monotonic and fully determined, so every durable timestamp below is predictable. */
function createSteppingClock(): ClockPort {
  let tick = 0
  return {
    now() {
      // A minute per read, past every declared retry backoff.
      const stamp = new Date(Date.parse('2026-02-02T00:00:00.000Z') + tick * 60_000).toISOString()
      tick += 1
      return stamp
    },
  }
}

// One member with a persisted verdict and one without, so a dropped or overwritten verdict shows.
const PERSISTED_ROOT_CAUSE: Verdict = {
  class: 'timeout',
  producer: 'deterministic-classifier',
  confidence: 1,
  evidence: {
    citedSteps: [0],
    citedAnchors: [],
    citedArtifacts: [],
    rationale: 'member outcome timeout',
  },
  memoryMisdirectionRuledOut: true,
  perTest: 0,
}

function fixtureHandoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'chain-terminal-storefront' },
    buildOrdinal: 7,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 't_classified',
        testName: 'member the classifier reached',
        filePath: 'tests/classified.yaml',
        testIndex: 0,
        outcome: 'timeout',
        steps: [],
        rootCause: PERSISTED_ROOT_CAUSE,
      },
      {
        testId: 't_unclassified',
        testName: 'member the classifier declined',
        filePath: 'tests/unclassified.yaml',
        testIndex: 1,
        outcome: 'failed',
        steps: [],
      },
      {
        testId: 't_passed',
        testName: 'member that passed',
        filePath: 'tests/passed.yaml',
        testIndex: 2,
        outcome: 'passed',
        steps: [],
      },
    ],
  }
}

// Writes the handoff exactly where the path derivation looks for it.
function writeHandoff(agentQaRoot: string, handoff: CompletedRunHandoff): void {
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(String(handoff.runId)))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(handoff)}\n`, 'utf8')
}

const roots: string[] = []
const hosts: LocalAgentHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Harness {
  readonly agentQaRoot: string
  readonly jobs: LocalAgentJobs
  readonly curateCalls: { runId: string; executionContext: unknown }[]
  // Kept so a case can ask the one read op what a surface would render.
  readonly host: LocalAgentHost
}

async function createHarness(options?: {
  readonly curateRun?: () => Promise<{
    curated: number
    deprecated: number
    complete: boolean
  }>
}): Promise<Harness> {
  const agentQaRoot = mkdtempSync(join(tmpdir(), 'agent-qa-chain-notify-'))
  roots.push(agentQaRoot)
  const curateCalls: { runId: string; executionContext: unknown }[] = []
  const host = composeLocalAgent({
    mask: (text) => text,
    mintQuarantineIdentityPath: MINT_IDENTITY,
    agentQaRoot,
    config: TEST_CONFIG,
    knowledgeRoot: () => join(agentQaRoot, 'knowledge'),
    model: () => TEST_MODEL,
    clock: createSteppingClock(),
    postRun: {
      curateRun: async (input) => {
        curateCalls.push({ runId: input.runId, executionContext: input.executionContext })
        return options?.curateRun === undefined
          ? { curated: 1, deprecated: 0, complete: true }
          : await options.curateRun()
      },
      // True of this substitute: it records the call and returns counts, never reaching
      // candidate emission at all — so no candidate prose exists for a masker to redact.
      candidateProse: 'masker-active',
    },
  })
  hosts.push(host)
  return { agentQaRoot, jobs: await host.jobs(), curateCalls, host }
}

/**
 * The bounded pump, shaped like the daemon's dispatcher loop: claim, run, stop when the
 * queue reports nothing eligible. Bounded so a kind that retries forever fails the test
 * instead of hanging it.
 */
async function pump(jobs: LocalAgentJobs, fence: { epoch: number }): Promise<number> {
  for (let pumped = 0; pumped < 24; pumped += 1) {
    const outcome = await jobs.queue.runNextJob({ fence })
    if (!outcome.ran) return pumped
  }
  throw new Error('the post-run chain did not drain within the pump bound')
}

/** The value a checkpoint carries, with the engine's record envelope peeled exactly once. */
async function readCheckpointValue(
  jobs: LocalAgentJobs,
  jobId: string,
  checkpointId: string,
): Promise<unknown> {
  const recorded = await jobs.store.readCheckpoint(jobId as never, checkpointId)
  if (!recorded.found) return undefined
  return (recorded.payload as JobCheckpointRecord).value
}

describe('post-run chain terminal notify', () => {
  it('drives enqueue -> analyze-run -> curate-memory -> exactly one notification row', async () => {
    const harness = await createHarness()
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(harness.agentQaRoot, handoff)
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)

    const fence = await harness.jobs.store.adoptEpoch(1)
    await harness.jobs.queue.recoverAbandonedClaims({ fence })
    const enqueued = await harness.jobs.queue.enqueue(
      'analyze-run',
      {
        runId: RUN_ID,
        handoffDigest: handoffDigest(handoff),
        handoffSchemaVersion: handoff.schemaVersion,
        executionContext: handoff.executionContext,
      },
      RUN_ID,
    )
    expect(String(enqueued.job.id)).toBe(String(ids.analyzeRun))

    await pump(harness.jobs, fence)

    // The persisted verdict survives verbatim, and a declined member is filled with `unknown`.
    const authored = await readCheckpointValue(
      harness.jobs,
      String(ids.analyzeRun),
      'verdicts-authored',
    ) as { runId: string; verdicts: Verdict[] }
    expect(authored.runId).toBe(RUN_ID)
    expect(authored.verdicts).toHaveLength(2)
    expect(authored.verdicts[0]).toEqual(PERSISTED_ROOT_CAUSE)
    expect(authored.verdicts[1]).toMatchObject({
      class: 'unknown',
      producer: 'deterministic-classifier',
      confidence: 0,
      perTest: 1,
    })

    // Pinned as the derivation's key set and the stored row kinds, so a failure names what arrived.
    const dump = await harness.jobs.store.dumpState()
    const byId = new Map(dump.jobs.map((row) => [row.id, row]))
    expect(Object.keys(ids).sort()).toEqual(['analyzeRun', 'curateMemory'])
    expect(dump.jobs.map((row) => row.kind).sort()).toEqual(['analyze-run', 'curate-memory'])
    expect(byId.get(String(ids.analyzeRun))).toMatchObject({ kind: 'analyze-run', status: 'done' })
    expect(byId.get(String(ids.curateMemory))).toMatchObject({
      kind: 'curate-memory',
      status: 'done',
    })

    // The successor payload carries `executionContext`, so the daemon resolves posture per job.
    expect(harness.curateCalls).toEqual([
      { runId: RUN_ID, executionContext: 'local-headless' },
    ])

    const notifications = await harness.jobs.store.listNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.runId).toBe(RUN_ID)
    expect(notifications[0]?.payload).toMatchObject({
      schemaVersion: CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
      runId: RUN_ID,
      outcome: 'done',
      verdictSummary: { total: 2, byClass: { timeout: 1, unknown: 1 } },
      stages: {
        analysis: { status: 'done' },
        curation: { status: 'done', curated: 1, deprecated: 0 },
      },
    })
  })

  // The ordering property the store's own rule rests on, measured rather than argued. Nothing
  // else in this file could see it: both the successor insert and the terminal decision happen
  // inside one `completeAndChain`, so the only observable is that no record exists at the
  // moment the first stage lands and exactly one exists after the second does.
  it('inserts the successor before it considers the terminal — no record at the first stage', async () => {
    const harness = await createHarness()
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(harness.agentQaRoot, handoff)
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)

    const fence = await harness.jobs.store.adoptEpoch(1)
    await harness.jobs.queue.enqueue('analyze-run', enqueuePayload(handoff), RUN_ID)

    // One single-job pump, stopping the instant analyze-run has landed.
    await harness.jobs.queue.runNextJob({ fence })

    const midDump = await harness.jobs.store.dumpState()
    const midById = new Map(midDump.jobs.map((row) => [row.id, row]))
    expect(midById.get(String(ids.analyzeRun))).toMatchObject({ status: 'done' })
    // The successor exists ALREADY, written by the very transaction that landed its predecessor…
    expect(midById.get(String(ids.curateMemory))).toMatchObject({
      kind: 'curate-memory',
      status: 'queued',
    })
    // …which is exactly what makes the record absent here: the store found a candidate that
    // exists and is not terminal. A build that recorded first would have written a record
    // claiming this chain had ended, and then enqueued the stage that had not run.
    expect(await harness.jobs.store.listNotifications()).toHaveLength(0)

    await pump(harness.jobs, fence)
    expect(await harness.jobs.store.listNotifications()).toHaveLength(1)
  })

  it('dedupes a second identical enqueue at the seam', async () => {
    const harness = await createHarness()
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(harness.agentQaRoot, handoff)
    const payload = {
      runId: RUN_ID,
      handoffDigest: handoffDigest(handoff),
      handoffSchemaVersion: handoff.schemaVersion,
      executionContext: handoff.executionContext,
    }

    const first = await harness.jobs.queue.enqueue('analyze-run', payload, RUN_ID)
    const second = await harness.jobs.queue.enqueue('analyze-run', payload, RUN_ID)

    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    expect(String(second.job.id)).toBe(String(first.job.id))
    // The collapsed row must be the one `chainJobIdsForRun` predicts from `runId` alone.
    expect(String(first.job.id)).toBe(String(chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE).analyzeRun))
    const dump = await harness.jobs.store.dumpState()
    expect(dump.jobs.filter((row) => row.kind === 'analyze-run')).toHaveLength(1)
  })

  it('fails analyze-run permanently when the handoff bytes drifted, still chaining curation', async () => {
    const harness = await createHarness()
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(harness.agentQaRoot, handoff)
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)

    const fence = await harness.jobs.store.adoptEpoch(1)
    await harness.jobs.queue.enqueue(
      'analyze-run',
      {
        runId: RUN_ID,
        handoffDigest: handoffDigest(handoff),
        handoffSchemaVersion: handoff.schemaVersion,
        executionContext: handoff.executionContext,
      },
      RUN_ID,
    )

    // The digest pins the analyzed bytes to the enqueued bytes; this rewrite is the drift.
    writeHandoff(harness.agentQaRoot, { ...handoff, buildOrdinal: 8 })

    await pump(harness.jobs, fence)

    const dump = await harness.jobs.store.dumpState()
    const analyze = dump.jobs.find((row) => row.id === String(ids.analyzeRun))
    expect(analyze).toMatchObject({ kind: 'analyze-run', status: 'failed' })
    // A dead analysis head must not leave curation waiting on it.
    expect(dump.jobs.some((row) => row.id === String(ids.curateMemory))).toBe(true)
  })

  // A failure is when a user most needs the notification; success-only would hide the worst runs.
  it('notifies on the FAILURE terminal, reporting the failed stage honestly', async () => {
    const harness = await createHarness({
      curateRun: () => {
        throw new Error('the knowledge root is unwritable')
      },
    })
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(harness.agentQaRoot, handoff)
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)

    const fence = await harness.jobs.store.adoptEpoch(1)
    await harness.jobs.queue.enqueue('analyze-run', enqueuePayload(handoff), RUN_ID)
    await pump(harness.jobs, fence)

    const dump = await harness.jobs.store.dumpState()
    expect(dump.jobs.find((row) => row.id === String(ids.analyzeRun))?.status).toBe('done')
    // The bound is spent at the CLAIM, so three claims is three attempts and the third is
    // terminal — the permanent failure lands through failAndChain, not recordFailure.
    expect(dump.jobs.find((row) => row.id === String(ids.curateMemory))).toMatchObject({
      status: 'failed',
      attempts: 3,
    })

    const notifications = await harness.jobs.store.listNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.payload).toMatchObject({
      runId: RUN_ID,
      outcome: 'failed',
      // Honest per stage: the analysis really did succeed, and saying otherwise would be as
      // wrong as saying the chain finished clean.
      stages: {
        analysis: { status: 'done' },
        curation: { status: 'failed' },
      },
    })
    // No counts on a stage that never committed a bundle: zeros would claim it curated
    // nothing, which is a different sentence from never having got that far.
    expect(notifications[0]?.payload.stages.curation.curated).toBeUndefined()
  })

  // The capability returns a refusal here rather than throwing, so this is a distinct measurement.
  it('lands curation: failed when the fold never completes', async () => {
    const harness = await createHarness({
      curateRun: async () => ({ curated: 0, deprecated: 0, complete: false }),
    })
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(harness.agentQaRoot, handoff)
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)

    const fence = await harness.jobs.store.adoptEpoch(1)
    await harness.jobs.queue.enqueue('analyze-run', enqueuePayload(handoff), RUN_ID)
    await pump(harness.jobs, fence)

    // The declared bound is what adjudicates, and it is spent at the CLAIM: three claims, the
    // third terminal through failAndChain. A retryable row is re-claimable once its backoff has
    // passed, and the harness clock moves a minute per read, so the plain pump above exhausts
    // the bound.
    const dump = await harness.jobs.store.dumpState()
    expect(dump.jobs.find((row) => row.id === String(ids.analyzeRun))?.status).toBe('done')
    expect(dump.jobs.find((row) => row.id === String(ids.curateMemory))).toMatchObject({
      status: 'failed',
      attempts: 3,
    })
    expect(harness.curateCalls).toHaveLength(3)

    // The durable half of "the gate fired BEFORE the publish". Asserting only the absence would
    // pass just as well against an empty checkpoint store or the wrong job id, so the
    // checkpoint the handler publishes FIRST is read in the same breath as the one it must not.
    expect(
      await readCheckpointValue(harness.jobs, String(ids.curateMemory), 'candidates-authored'),
    ).toEqual({ runId: RUN_ID })
    expect(
      await readCheckpointValue(harness.jobs, String(ids.curateMemory), 'bundle-committed'),
    ).toBeUndefined()

    const notifications = await harness.jobs.store.listNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.payload).toMatchObject({
      runId: RUN_ID,
      outcome: 'failed',
      stages: {
        analysis: { status: 'done' },
        curation: { status: 'failed' },
      },
    })
    // No counts on a stage that committed no bundle: `0 curated` would be a claim about work
    // that ran, and the fold's whole point in refusing is that it did not get there.
    expect(notifications[0]?.payload.stages.curation.curated).toBeUndefined()
    expect(notifications[0]?.payload.stages.curation.deprecated).toBeUndefined()

    // Reached through the one read op; the mapping itself is `post-processing-status.test.ts`'s.
    const status = await invokeFunction(
      harness.host.registry,
      RUNS_POST_PROCESSING_FUNCTION_ID,
      { runId: RUN_ID },
      CALLER,
    ) as PostProcessingStatus
    expect(status.chips).toEqual({ analysis: 'complete', curation: 'failed' })
  })

  // The case the completeness gate must let through: a refold, not a repair.
  it('recovers when a retry completes the fold', async () => {
    let attempt = 0
    const harness = await createHarness({
      curateRun: async () => {
        attempt += 1
        return attempt === 1
          ? { curated: 0, deprecated: 0, complete: false }
          : { curated: 2, deprecated: 1, complete: true }
      },
    })
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(harness.agentQaRoot, handoff)
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)

    const fence = await harness.jobs.store.adoptEpoch(1)
    await harness.jobs.queue.enqueue('analyze-run', enqueuePayload(handoff), RUN_ID)
    await pump(harness.jobs, fence)

    const dump = await harness.jobs.store.dumpState()
    expect(dump.jobs.find((row) => row.id === String(ids.curateMemory))).toMatchObject({
      status: 'done',
      // Two claims: the refused attempt and the one that completed. A row that landed done on
      // its first attempt would mean the incomplete report never cost anything.
      attempts: 2,
    })
    expect(harness.curateCalls).toHaveLength(2)

    // The counts on the record are the COMPLETED attempt's, not the refused attempt's zeros.
    expect(
      await readCheckpointValue(harness.jobs, String(ids.curateMemory), 'bundle-committed'),
    ).toEqual({ runId: RUN_ID, curated: 2, deprecated: 1 })

    const notifications = await harness.jobs.store.listNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.payload.outcome).toBe('done')
    expect(notifications[0]?.payload.stages.curation).toEqual({
      status: 'done',
      curated: 2,
      deprecated: 1,
    })
  })

  // The dedupe is the store's unique index; a caller-side check leaves a window for a second row.
  it('dedupes a replayed chain terminal on the unique index, byte-identically', async () => {
    const harness = await createHarness()
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(harness.agentQaRoot, handoff)
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)

    const fence = await harness.jobs.store.adoptEpoch(1)
    await harness.jobs.queue.enqueue('analyze-run', enqueuePayload(handoff), RUN_ID)
    await pump(harness.jobs, fence)

    const before = await harness.jobs.store.listNotifications()
    expect(before).toHaveLength(1)

    // The replay: the SAME terminal verb, with the same record, against rows that are already
    // terminal. This is what a recovered host does, expressed without a second process.
    await harness.jobs.store.completeAndChain(ids.curateMemory, [], fence, {
      dedupeKey: RUN_ID,
      candidateJobIds: [ids.analyzeRun, ids.curateMemory],
      payloadJson: canonicalJson({ ...before[0]?.payload, outcome: 'failed' }),
    })

    const after = await harness.jobs.store.listNotifications()
    expect(after).toHaveLength(1)
    // Byte-identical, and deliberately replayed with a DIFFERENT payload: an upsert would pass
    // a "still one row" assertion while quietly rewriting the record every replay touched.
    expect(after[0]?.payload).toEqual(before[0]?.payload)
    expect(after[0]?.createdAt).toBe(before[0]?.createdAt)
  })

  // The fallback path, measured end to end. A permanently failed analysis hands on the SAME
  // successor list the success path does, so the store ends up holding the same two kinds — and
  // the cell pins that the same two ways the success cell does, on the derivation's key set and
  // on the kinds the store holds, so the two paths cannot drift apart unnoticed.
  it('notifies honestly when the analysis died and curation carried on', async () => {
    const harness = await createHarness()
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)
    // No handoff written at all: the derived path addresses nothing, which is permanent.
    const fence = await harness.jobs.store.adoptEpoch(1)
    await harness.jobs.queue.enqueue(
      'analyze-run',
      {
        runId: RUN_ID,
        handoffDigest: 'a'.repeat(64),
        handoffSchemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
        executionContext: 'local-headless',
      },
      RUN_ID,
    )
    await pump(harness.jobs, fence)

    const dump = await harness.jobs.store.dumpState()
    expect(dump.jobs.find((row) => row.id === String(ids.analyzeRun))?.status).toBe('failed')
    expect(dump.jobs.find((row) => row.id === String(ids.curateMemory))?.status).toBe('done')
    expect(Object.keys(ids).sort()).toEqual(['analyzeRun', 'curateMemory'])
    expect(dump.jobs.map((row) => row.kind).sort()).toEqual(['analyze-run', 'curate-memory'])
    // The successor really was handed the run's identity and posture by the FALLBACK, not
    // only by the success path.
    expect(harness.curateCalls).toEqual([
      { runId: RUN_ID, executionContext: 'local-headless' },
    ])

    const notifications = await harness.jobs.store.listNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.payload).toMatchObject({
      runId: RUN_ID,
      outcome: 'failed',
      // The chain proceeded with no verdicts and the record says so, even though the job that
      // reported the terminal is downstream of the one that died. The marker had to survive the
      // fallback's payload and sqlite.
      stages: {
        analysis: { status: 'failed' },
        curation: { status: 'done', curated: 1, deprecated: 0 },
      },
      verdictSummary: { total: 0, byClass: {} },
    })
  })
})

// The payload the run tail enqueues with, minted once and used by every leg.
function enqueuePayload(handoff: CompletedRunHandoff): Record<string, unknown> {
  return {
    runId: String(handoff.runId),
    handoffDigest: handoffDigest(handoff),
    handoffSchemaVersion: handoff.schemaVersion,
    executionContext: handoff.executionContext,
  }
}

/** The one digest mint, mirrored from the run tail's `curationTailHandoffDigest`. */
function handoffDigest(handoff: CompletedRunHandoff): string {
  return sha256hex(canonicalJson(handoff))
}
