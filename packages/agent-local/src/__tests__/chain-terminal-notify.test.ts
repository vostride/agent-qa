// The Phase 388 tracer: one finished run drives the REAL post-run chain end to end.
//
// Real sqlite, a real handoff document on disk, the real composition root, the real handler
// bodies. The only injected fakes are the clock (so timestamps are assertable), the model
// capability (nothing on this path authors) and `curateRun` — which is a CAPABILITY the
// composition binds rather than a stub of the thing under test: `agent-local` cannot reach
// the CLI's curation drain, and D-01 puts that binding in the run tail (plan 02). What is
// under test here is the SEAM: enqueue -> analyze-run -> curate-memory -> exactly one
// notification row, with deterministic chain ids and the frozen verdicts-authored shape.
//
// Why the assertions are on durable state rather than on returned outcomes: the whole point
// of D-09 is that "notified exactly once" survives a crash, a second process and a replay,
// and an assertion on a value the engine happened to return would be satisfied just as well
// by an in-memory memo that the next process cannot see.

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

/**
 * The composition's REQUIRED quarantine identity mint. Passthrough here: this
 * fixture already speaks canonical workspace-relative bytes, and the recipe itself stays pinned
 * in core's `workspace-paths.test.ts` — what these hosts exercise is everything BUT quarantine.
 */
const MINT_IDENTITY = (filePath: string): string => filePath

const RUN_ID = 'run-388-alpha'

// no `grantedScopes` or `safeMode` on the caller; the registry reads
// neither.
const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

// 389-04's author swap put the unknown-floor member (`t_unclassified`) on the model path, so
// a throwing stub now aborts the very chain these tests exercise. Answering unparseable text
// instead makes the author degrade per-test to the byte-identical deterministic floor (plan 04's
// proven posture) — the chain mechanics under test are unchanged from their 388 shape.
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
      // a minute per read, past every declared retry backoff.
      const stamp = new Date(Date.parse('2026-02-02T00:00:00.000Z') + tick * 60_000).toISOString()
      tick += 1
      return stamp
    },
  }
}

/**
 * The verdict the runner already persisted for the member it could classify.
 *
 * The fixture carries one member WITH this and one member WITHOUT, and that pairing is the
 * point: a projection that dropped unclassified members, or one that overwrote a persisted
 * verdict with its own fill, would still satisfy a fixture where every member looked alike.
 */
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

/** Writes the handoff exactly where the D-06 path derivation will look for it. */
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
  /** Kept so a case can ask the ONE read op what a surface would render. */
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

    // The frozen 389 shape: the persisted verdict survives verbatim, and the member the
    // classifier declined is filled with a deterministic 'unknown' rather than dropped.
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

    // The chain enqueued exactly the kinds it derives ids for, pinned two ways: the
    // KEY SET of the derivation and the KINDS of the rows the store actually holds, both against
    // a sorted literal. Another derived id reds the first line by name and another enqueued row
    // reds the second, and each says WHAT arrived rather than that a count moved.
    const dump = await harness.jobs.store.dumpState()
    const byId = new Map(dump.jobs.map((row) => [row.id, row]))
    expect(Object.keys(ids).sort()).toEqual(['analyzeRun', 'curateMemory'])
    expect(dump.jobs.map((row) => row.kind).sort()).toEqual(['analyze-run', 'curate-memory'])
    expect(byId.get(String(ids.analyzeRun))).toMatchObject({ kind: 'analyze-run', status: 'done' })
    expect(byId.get(String(ids.curateMemory))).toMatchObject({
      kind: 'curate-memory',
      status: 'done',
    })

    // The successor payload carries what the daemon needs to resolve posture per claimed job
    // a curate-memory payload without executionContext is the DAEM-02 bug.
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
    // Dedupe alone is a shipped 385 guarantee and would pass here with no 388 code at all.
    // What makes this a pin on THIS phase is the address: the one row both enqueues collapse
    // onto must be the row `chainJobIdsForRun` predicts from `runId` alone, because that
    // derivation — not a stored chain table — is what every later reader addresses (Pattern 2).
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

    // the digest pins that the bytes analyzed are the bytes enqueued. Rewriting the
    // document after the enqueue is exactly the drift the pin exists to catch.
    writeHandoff(harness.agentQaRoot, { ...handoff, buildOrdinal: 8 })

    await pump(harness.jobs, fence)

    const dump = await harness.jobs.store.dumpState()
    const analyze = dump.jobs.find((row) => row.id === String(ids.analyzeRun))
    expect(analyze).toMatchObject({ kind: 'analyze-run', status: 'failed' })
    // A dead analysis head must never leave curation waiting on it (D-20 posture).
    expect(dump.jobs.some((row) => row.id === String(ids.curateMemory))).toBe(true)
  })

  // D-12. The chain ALWAYS terminates in a notification, and a failure is exactly when a user
  // most needs one — a success-only notify would be silent about the runs that went worst.
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

  // WR-03, the REJECT leg. Distinct from the case above in exactly one input: there the
  // capability THREW, so the engine never saw a report at all. Here it RETURNS, successfully,
  // and says the fold refused — which before the completeness gate landed the job `done` and
  // wrote a notification row reading `curation: {status: 'done'}` for a fold that committed no
  // bundle. The two cases look alike on purpose and are not the same measurement.
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

    // What a surface renders, through the ONE read op. Implied by the row status above
    // rather than independent of it — this pins that the projection is reached, not a second
    // mapping claim (the mapping is post-processing-status.test.ts's).
    const status = await invokeFunction(
      harness.host.registry,
      RUNS_POST_PROCESSING_FUNCTION_ID,
      { runId: RUN_ID },
      CALLER,
    ) as PostProcessingStatus
    expect(status.chips).toEqual({ analysis: 'complete', curation: 'failed' })
  })

  // WR-03, the ACCEPT leg. A gate that rejected everything would satisfy the case above just as
  // well; this is the corpus case the gate must let THROUGH — and it turns on the fold's own
  // designed recovery, which is a refold, not a repair.
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

  // D-09/D-10. A host that dies after committing the terminal transaction but before anything
  // downstream observed it replays that terminal on recovery. The dedupe has to be the store's
  // — a caller-side "have I notified?" read is two decisions about one row with a window
  // between them, and that window is exactly where the second notification gets written.
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

/** The D-06 payload the run tail will enqueue with. Minted once, used by every leg. */
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
