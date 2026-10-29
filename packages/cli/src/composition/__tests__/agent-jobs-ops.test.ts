// The five cells behind 413 D-04 / D-06 (RESEARCH F15, OQ-4 option (b)).
//
// What is under test is not "a pump works" — the engine's own suites cover that. It is the
// narrower claim the campaign rests on: a host can drain ONE kind and leave the successor that
// kind enqueues sitting queued and unclaimed. F15 measured that no shipped host could do this
// (global FIFO, no kind filter), so every assertion here is about what the pump did NOT touch as
// much as about what it ran.
//
// The harness composes `composeJobRecovery` with `createRealJobKindRegistry()` — no capabilities,
// so every kind gets the stand-in handler whose payload script decides completion, chaining and
// failure. That is deliberate: the D-06 guarantee must hold for a `curate-memory` row whose
// handler WOULD run if it were ever claimed, which is exactly what the stand-in is.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DIGEST_JOB_ID_SOURCE,
  LOCAL_CURATION_CAPABILITIES,
  composeJobRecovery,
} from '@vostride/agent-qa-agent-local'
import { createRealJobKindRegistry } from '@vostride/agent-qa-agent'
import type { JobModelCapability } from '@vostride/agent-qa-agent'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  ANALYSIS_FILE,
  asJobId,
  asRunId,
  canonicalJson,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  guardRunAnalysisArtifact,
  sha256hex,
} from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, Verdict } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AGENT_JOBS_PUMP_BOUND,
  cancelAgentJob,
  defaultAgentJobsOpsDeps,
  listAgentJobs,
  pumpAgentJobs,
  requeueAgentJob,
} from '../agent-jobs-ops.js'
import type { AgentJobsOpsDeps } from '../agent-jobs-ops.js'

const { acquireWriterLease, releaseLease, refreshWriterLeaseAuthority }
  = LOCAL_CURATION_CAPABILITIES.maintenance

/**
 * The capability the queue is constructed with, shaped to `JobModelCapability` and unusable.
 *
 * A stand-in handler never reaches a model, so a model that REJECTS is the honest binding: if a
 * cell ever starts passing because a real handler authored something, this rejection is what turns
 * it red instead of quietly spending a token budget.
 */
const NEVER_AUTHORS: JobModelCapability = {
  modelId: 'test:none',
  generate: () => Promise.reject(new Error('the stand-in never authors')),
}

const clock = { now: (): string => new Date().toISOString() }

interface Harness {
  readonly deps: AgentJobsOpsDeps
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  enqueue(kind: 'analyze-run' | 'curate-memory', payload: unknown, key: string): Promise<void>
  dump(): Promise<
    readonly {
      id: string
      kind: string
      status: string
      attempts: number
      claimed: boolean
    }[]
  >
}

let roots: string[] = []

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-413-10-'))
  roots.push(root)
  const agentQaRoot = join(root, '.agent-qa')
  const knowledgeRoot = join(root, 'knowledge')
  mkdirSync(agentQaRoot, { recursive: true })
  mkdirSync(knowledgeRoot, { recursive: true })

  const open = (): ReturnType<typeof composeJobRecovery> =>
    composeJobRecovery({
      agentQaRoot,
      clock,
      idSource: DIGEST_JOB_ID_SOURCE,
      model: NEVER_AUTHORS,
      jobKinds: createRealJobKindRegistry(),
    })

  const deps: AgentJobsOpsDeps = {
    composeJobs: async () => {
      const host = open()
      return {
        jobs: {
          store: host.store,
          kinds: host.kinds,
          queue: host.queue,
          model: NEVER_AUTHORS,
          idSource: DIGEST_JOB_ID_SOURCE,
          // The composed host's belt, as DATA. `composeJobRecovery` builds no posture, so this
          // double states the empty set explicitly rather than omitting the field: an omission
          // would make every cell below silently measure the braces alone, which is exactly the
          // hole CR-02 was.
          unclaimableKinds: [],
        },
        close: async () => {
          host.close()
        },
      }
    },
    knowledgeRoot: async () => knowledgeRoot,
    clock,
    acquireWriterLease,
    releaseLease,
    refreshWriterLeaseAuthority,
  }

  return {
    deps,
    agentQaRoot,
    knowledgeRoot,
    async enqueue(kind, payload, key) {
      const host = open()
      try {
        await host.queue.enqueue(kind, payload, key)
      } finally {
        host.close()
      }
    },
    async dump() {
      const host = open()
      try {
        const state = await host.store.dumpState()
        return state.jobs.map((row) => ({
          id: row.id,
          kind: row.kind,
          status: row.status,
          attempts: row.attempts,
          claimed: row.claimed,
        }))
      } finally {
        host.close()
      }
    },
  }
}

beforeEach(() => {
  roots = []
})

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('pumpAgentJobs — the kind-filtered, lease-holding drain', () => {
  it('runs only analyze-run and leaves the curate-memory successor queued and unclaimed', async () => {
    const harness = makeHarness()
    await harness.enqueue('analyze-run', { runId: 'r_fixture', chain: true }, 'r_fixture')

    const outcome = await pumpAgentJobs({ only: 'analyze-run' }, harness.deps)

    expect(outcome.kind).toBe('pumped')
    if (outcome.kind !== 'pumped') return
    expect(outcome.ran).toBe(1)
    expect(outcome.outcomes[0]).toMatchObject({
      kind: 'analyze-run',
      runId: 'r_fixture',
      disposition: 'completed',
    })
    expect(outcome.stoppedOn).toBe('empty')
    expect([...outcome.excludedKinds].sort()).toEqual(
      ['chat', 'consolidate', 'curate-memory'],
    )

    const rows = await harness.dump()
    const analyze = rows.find((row) => row.kind === 'analyze-run')
    expect(analyze?.status).toBe('done')

    // THE D-06 CLAIM. The successor exists — the chain really did fire — and nothing touched it.
    const successor = rows.find((row) => row.kind === 'curate-memory')
    expect(successor).toBeDefined()
    expect(successor?.claimed).toBe(false)
    expect(successor?.attempts).toBe(0)
    expect(successor?.status).toBe('queued')
  })

  it('claims nothing at all when the only queued row is an excluded kind', async () => {
    const harness = makeHarness()
    await harness.enqueue('curate-memory', { runId: 'r_untouched' }, 'r_untouched->curate-memory')

    const outcome = await pumpAgentJobs({ only: 'analyze-run' }, harness.deps)

    expect(outcome.kind).toBe('pumped')
    if (outcome.kind !== 'pumped') return
    expect(outcome.ran).toBe(0)
    expect(outcome.outcomes).toEqual([])
    expect(outcome.stoppedOn).toBe('empty')

    const rows = await harness.dump()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'curate-memory', claimed: false, attempts: 0, status: 'queued' })
  })

  it('refuses while the writer lease is held, and releases its own lease on the way out', async () => {
    const harness = makeHarness()
    await harness.enqueue('analyze-run', { runId: 'r_leased' }, 'r_leased')

    const holder = acquireWriterLease(harness.knowledgeRoot)
    expect(holder.kind).toBe('acquired')
    if (holder.kind !== 'acquired') return

    const refused = await pumpAgentJobs({ only: 'analyze-run' }, harness.deps)
    expect(refused).toMatchObject({ kind: 'refused', reason: 'writer-lease-held' })
    if (refused.kind !== 'refused') return
    expect(refused.reason).toBe('writer-lease-held')
    expect(refused.holder).toMatchObject({ pid: process.pid, epoch: holder.epoch })
    expect(refused.holder?.leaseId).toBe(holder.leaseId)

    // Nothing was claimed under a refusal.
    expect((await harness.dump())[0]).toMatchObject({ claimed: false, attempts: 0 })

    expect(releaseLease({ knowledgeRoot: harness.knowledgeRoot, leaseId: holder.leaseId }).kind)
      .toBe('released')

    const pumped = await pumpAgentJobs({ only: 'analyze-run' }, harness.deps)
    expect(pumped.kind).toBe('pumped')

    // The pump's own lease is gone: a third party can take it. A pump that leaked its lease
    // would answer `held` here and wedge every later leg of the campaign.
    const after = acquireWriterLease(harness.knowledgeRoot)
    expect(after.kind).toBe('acquired')
    if (after.kind === 'acquired') {
      releaseLease({ knowledgeRoot: harness.knowledgeRoot, leaseId: after.leaseId })
    }
  })

  it('ends the loop on a retry-scheduled outcome instead of sleeping on the backoff', async () => {
    const harness = makeHarness()
    await harness.enqueue('analyze-run', { runId: 'r_a', fail: 'retryable' }, 'r_a')
    await harness.enqueue('analyze-run', { runId: 'r_b' }, 'r_b')

    const outcome = await pumpAgentJobs({ only: 'analyze-run' }, harness.deps)

    expect(outcome.kind).toBe('pumped')
    if (outcome.kind !== 'pumped') return
    expect(outcome.ran).toBe(1)
    expect(outcome.outcomes[0]?.disposition).toBe('retry-scheduled')
    expect(outcome.outcomes[0]?.runId).toBe('r_a')
    expect(outcome.stoppedOn).toBe('retry-scheduled')

    const rows = await harness.dump()
    const untouched = rows.filter((row) => row.id !== outcome.outcomes[0]?.jobId)
    expect(untouched).toHaveLength(1)
    expect(untouched[0]).toMatchObject({ claimed: false, attempts: 0, status: 'queued' })
  })

  it('lists every row without a payload and cancels one through the engine', async () => {
    const harness = makeHarness()
    await harness.enqueue('analyze-run', { runId: 'r_fixture', chain: true }, 'r_fixture')
    await pumpAgentJobs({ only: 'analyze-run' }, harness.deps)

    const listed = await listAgentJobs(harness.deps)
    expect(listed.jobs.length).toBe(2)
    for (const row of listed.jobs) {
      expect(Object.keys(row)).not.toContain('payload')
    }
    const analyze = listed.jobs.find((row) => row.kind === 'analyze-run')
    expect(analyze?.runId).toBe('r_fixture')

    const sortKey = (row: { status: string; kind: string; id: string }): string =>
      `${row.status} ${row.kind} ${row.id}`
    expect(listed.jobs.map(sortKey)).toEqual([...listed.jobs.map(sortKey)].sort())

    const successor = listed.jobs.find((row) => row.kind === 'curate-memory')
    expect(successor).toBeDefined()
    const cancelled = await cancelAgentJob(successor!.id, harness.deps)
    expect(cancelled).toEqual({ kind: 'cancelled' })

    const after = await listAgentJobs(harness.deps)
    expect(after.jobs.find((row) => row.id === successor!.id)?.status).toBe('cancelled')
  })

  it('bounds the loop rather than trusting the queue to empty', () => {
    expect(AGENT_JOBS_PUMP_BOUND).toBe(64)
  })
})

// ————— the composition the SHIPPED pump actually runs (defaultAgentJobsOpsDeps) —————
//
// Everything above drives an INJECTED `AgentJobsOpsDeps` whose registry is
// `createRealJobKindRegistry()` — no capabilities, stand-in handlers. That seam is right for the
// D-06 claim (the guarantee must hold for a `curate-memory` row whose handler WOULD run), and it
// is exactly why the defect below survived Plan 10: the composition the CLI command actually
// reaches for, `defaultAgentJobsOpsDeps`, had no cell at all.
//
// What it composed was a host with NO `postRun`, and `postRunCapabilities()` answers `undefined`
// for the WHOLE bundle when `postRun` is absent — so `persistAnalysis` was discarded together with
// `curateRun`, and `createRealJobKindRegistry(undefined)` handed analyze-run its scripted
// stand-in, which publishes `verdicts-authored` and reports `complete` having written nothing.
// Measured over 413-08's 19-leg campaign: 19/19 legs recorded `analyzeRun: "completed"` and 0/19
// wrote `analysis.json`. The row claimed an analysis that did not exist — the masked fallback
// 413-07 named as the defect class this phase guards against.
//
// The two cells below hold the two properties apart, because a fix that satisfied one by breaking
// the other would be worse than the defect:
//
//   1. THE ARTIFACT. A campaign leg in miniature through the real composition — a run directory
//      with a handoff on disk, an analyze-run row enqueued against its digest, one
//      `agent-qa agent-jobs pump --only analyze-run` — asserting that `analysis.json` lands and
//      that the successor the completion enqueues is left queued, unclaimed, attempts 0.
//   2. THE BELT. The composed host's OWN queue, with the pump's `--only` exclusion nowhere in
//      sight, still refuses to claim a `curate-memory` row. That is `'no-masker'` folding through
//      `UNCLAIMABLE_BY_PROSE_POSTURE`, and it is what makes the guarantee survive an edit to
//      `pumpAgentJobs` — and what proves `PUMP_NEVER_CURATES` is never reached.
//
// The fixture's one member carries a PERSISTED `rootCause`, so the deterministic floor has no
// `unknown` member and the author reaches no model (`kinds.ts`: "a floor with no unknown members
// ... reaches no model"). That is deliberate: `defaultAgentJobsOpsDeps` resolves its own model
// from the config and this cell cannot inject one, so the assertion must not depend on what that
// resolution answers.

const PUMPED_RUN_ID = 'run-413-10-pumped'

/** A config a project could actually have: enough for `resolveConfig` to name a knowledge root. */
const PUMP_CONFIG = `workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local

registry:
  llms:
    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra

use:
  llm: judge
  mobile:
    appState: preserve
  parallel: false
`

/** Classified by the runner and PERSISTED, which is what keeps the floor off the model path. */
const PERSISTED_ROOT_CAUSE: Verdict = {
  class: 'timeout',
  producer: 'deterministic-classifier',
  confidence: 1,
  evidence: {
    citedSteps: [],
    citedAnchors: [],
    citedArtifacts: [],
    rationale: 'member outcome timeout',
  },
  memoryMisdirectionRuledOut: true,
  perTest: 0,
}

function pumpFixtureHandoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'pumped-storefront' },
    buildOrdinal: 1,
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
    ],
  }
}

interface ComposedFixture {
  readonly configPath: string
  readonly agentQaRoot: string
  readonly runDir: string
  /** The handoff written to `runDir`, so a caller can digest the bytes it enqueues against. */
  readonly handoff: CompletedRunHandoff
  /** A stand-in composition over the SAME sqlite file — enqueue and read only, never a drain. */
  open(): ReturnType<typeof composeJobRecovery>
}

/** A project on disk: a config, a runtime root, and one completed run's handoff. */
function composedFixture(): ComposedFixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-413-10-composed-'))
  roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(configPath, PUMP_CONFIG, 'utf8')
  const agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })

  const handoff = pumpFixtureHandoff(PUMPED_RUN_ID)
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(PUMPED_RUN_ID))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(handoff)}\n`, 'utf8')

  return {
    configPath,
    agentQaRoot,
    runDir,
    handoff,
    open: () => composeJobRecovery({
      agentQaRoot,
      clock,
      idSource: DIGEST_JOB_ID_SOURCE,
      model: NEVER_AUTHORS,
      jobKinds: createRealJobKindRegistry(),
    }),
  }
}

describe('defaultAgentJobsOpsDeps — the composition the shipped pump runs', () => {
  it('persists analysis.json for a pumped analyze-run and leaves curate-memory unclaimed', async () => {
    const fixture = composedFixture()

    // An enqueue only, so no handler of this stand-in registry ever runs. What RUNS the row is the
    // pump below, through the composition under test.
    const enqueuer = fixture.open()
    try {
      await enqueuer.queue.enqueue(
        'analyze-run',
        {
          runId: PUMPED_RUN_ID,
          handoffDigest: sha256hex(canonicalJson(fixture.handoff)),
          handoffSchemaVersion: fixture.handoff.schemaVersion,
          executionContext: fixture.handoff.executionContext,
        },
        PUMPED_RUN_ID,
      )
    } finally {
      enqueuer.close()
    }

    const outcome = await pumpAgentJobs(
      { only: 'analyze-run' },
      defaultAgentJobsOpsDeps(fixture.configPath),
    )

    expect(outcome.kind).toBe('pumped')
    if (outcome.kind !== 'pumped') return
    expect(outcome.outcomes[0]).toMatchObject({
      kind: 'analyze-run',
      runId: PUMPED_RUN_ID,
      disposition: 'completed',
    })

    // THE DEFECT. A `completed` row whose artifact is absent is a row that lied, and the campaign
    // measured exactly that 19 times.
    const artifactPath = join(fixture.runDir, ANALYSIS_FILE)
    expect(existsSync(artifactPath)).toBe(true)
    const artifact = guardRunAnalysisArtifact(JSON.parse(readFileSync(artifactPath, 'utf8')))
    expect(artifact.runId).toBe(PUMPED_RUN_ID)
    expect(artifact.verdicts.map((verdict) => verdict.class)).toEqual(['timeout'])

    // AND D-06, undamaged. The successor exists at all only because the REAL body ran — the
    // stand-in returned `next: []` for an unscripted payload, which is why the campaign enqueued
    // zero curate-memory jobs where D-06 expected 19.
    const reader = fixture.open()
    let dump
    try {
      dump = await reader.store.dumpState()
    } finally {
      reader.close()
    }
    const successor = dump.jobs.find((row) => row.kind === 'curate-memory')
    expect(successor).toBeDefined()
    expect(successor).toMatchObject({ status: 'queued', claimed: false, attempts: 0 })
  })

  it("composes on the 'no-masker' posture, so the host's OWN queue cannot claim curate-memory", async () => {
    const fixture = composedFixture()
    const enqueuer = fixture.open()
    try {
      await enqueuer.queue.enqueue(
        'curate-memory',
        { runId: PUMPED_RUN_ID, executionContext: 'local-headless' },
        `${PUMPED_RUN_ID}->curate-memory`,
      )
    } finally {
      enqueuer.close()
    }

    // The BELT, measured on its own: this is the host's own queue, constructed from
    // `UNCLAIMABLE_BY_PROSE_POSTURE['no-masker']`, with the pump's `--only` exclusion nowhere in
    // sight. A posture flipped to `'masker-active'` would claim the row here and reach
    // `PUMP_NEVER_CURATES` — which throws rather than publishing a receipt no fold earned.
    const composed = await defaultAgentJobsOpsDeps(fixture.configPath).composeJobs()
    try {
      const fence = await composed.jobs.store.adoptEpoch(1)
      const outcome = await composed.jobs.queue.runNextJob({ fence })
      expect(outcome.ran).toBe(false)
    } finally {
      await composed.close()
    }

    const reader = fixture.open()
    try {
      const dump = await reader.store.dumpState()
      expect(dump.jobs).toHaveLength(1)
      expect(dump.jobs[0]).toMatchObject({
        kind: 'curate-memory',
        status: 'queued',
        claimed: false,
        attempts: 0,
      })
    } finally {
      reader.close()
    }
  })
  // CR-02. The file claimed the curator was held back "twice over" — the host's own
  // posture-derived belt plus the pump's `--only` braces. Only the braces existed. `pumpAgentJobs`
  // builds a FRESH `createAgentJobQueue` over the raw `jobs.store`, so the belt the cell above
  // measures governs a queue that never drains, and `ComposedAgentJobs.jobs` was a `Pick<…>` that
  // dropped `unclaimableKinds` — the one published field on `LocalAgentJobs` that exists so a
  // re-composer can honour it. The claim was not merely unused; it was unreachable.
  //
  // `--only curate-memory` is a parser-accepted operator command, so the hole was reachable by
  // typing a valid flag value. With one exclusion the curator became claimable, the real handler
  // ran, `curateRun` = `PUMP_NEVER_CURATES` threw, and the engine's handler-throw path had already
  // spent the attempt at claim: `retry-scheduled`, then `failed` at the bound — which is a
  // chain terminal, minting a `failed` receipt for a curation nobody ever attempted.
  //
  // This cell asserts the union, not the refusal: the row a `--only curate-memory` pump names must
  // come out of it exactly as it went in.
  it('will not claim curate-memory even when --only names it, because the belt is unioned in', async () => {
    const fixture = composedFixture()
    const enqueuer = fixture.open()
    try {
      await enqueuer.queue.enqueue(
        'curate-memory',
        { runId: PUMPED_RUN_ID, executionContext: 'local-headless' },
        `${PUMPED_RUN_ID}->curate-memory`,
      )
    } finally {
      enqueuer.close()
    }

    const outcome = await pumpAgentJobs(
      { only: 'curate-memory' },
      defaultAgentJobsOpsDeps(fixture.configPath),
    )

    expect(outcome.kind).toBe('pumped')
    if (outcome.kind !== 'pumped') return
    expect(outcome.ran).toBe(0)
    expect(outcome.stoppedOn).toBe('empty')
    // The belt, VISIBLE in the DTO the operator reads: the kind they named is excluded, so the
    // empty drain is reported rather than looking like an empty queue.
    expect([...outcome.excludedKinds].sort()).toEqual(
      ['analyze-run', 'chat', 'consolidate', 'curate-memory'],
    )

    // The row, untouched. `attempts: 0` is the load-bearing one: the engine spends an attempt at
    // CLAIM, so a curator that was claimed and then threw reads `attempts: 1` here even though
    // nothing was folded.
    const reader = fixture.open()
    try {
      const dump = await reader.store.dumpState()
      expect(dump.jobs).toHaveLength(1)
      expect(dump.jobs[0]).toMatchObject({
        kind: 'curate-memory',
        status: 'queued',
        claimed: false,
        attempts: 0,
      })
    } finally {
      reader.close()
    }

    // And no receipt was minted for a fold that never ran.
    const notifier = fixture.open()
    try {
      expect(await notifier.store.listNotifications()).toEqual([])
    } finally {
      notifier.close()
    }
  })

})

// ————— requeueAgentJob — the operator's explicit forget —————
//
// The 413-08 campaign left 19 `analyze-run` rows `done` with nothing authored, and the store dedups
// on `(kind, idempotencyKey)`, so a second enqueue for the same run is impossible — and would be
// wrong anyway, because `chainJobIdsForRun` derives chain identity from that pair. `requeue` is the
// only way back: the row itself returns to `queued`, and the checkpoints its last attempt recorded
// are forgotten in both media.
//
// The forget is the load-bearing half, and the first cell asserts it directly rather than trusting
// the status. `selectLatestCheckpoint` is `ORDER BY attempt DESC LIMIT 1`, so a status-only reset
// would hand the REAL handler the stand-in's empty `verdicts-authored` payload as recorded
// authorship — it would author nothing and report `completed`, reproducing the defect exactly.

describe('requeueAgentJob — returning a terminal agent job to the queue', () => {
  it('a requeued analyze-run runs its author again and re-chains its successor exactly once', async () => {
    const harness = makeHarness()
    await harness.enqueue('analyze-run', { runId: 'r_requeue', chain: true }, 'r_requeue')

    const first = await pumpAgentJobs({ only: 'analyze-run' }, harness.deps)
    expect(first.kind).toBe('pumped')
    if (first.kind !== 'pumped') return
    expect(first.ran).toBe(1)
    const analyzeId = first.outcomes[0]?.jobId
    expect(analyzeId).toBeDefined()
    if (analyzeId === undefined) return

    const before = await harness.dump()
    expect(before.filter((row) => row.kind === 'curate-memory')).toHaveLength(1)
    expect(before.find((row) => row.kind === 'analyze-run')?.status).toBe('done')

    const requeued = await requeueAgentJob(analyzeId, harness.deps)
    expect(requeued).toEqual({ kind: 'requeued' })

    // THE FORGET, read through the same store the next attempt will read. A `found: true` here is
    // the state that replays a stand-in's authorship as though a handler had produced it.
    const composed = await harness.deps.composeJobs()
    try {
      const read = await composed.jobs.store.readCheckpoint(asJobId(analyzeId), 'verdicts-authored')
      expect(read).toEqual({ found: false })
    } finally {
      await composed.close()
    }

    const second = await pumpAgentJobs({ only: 'analyze-run' }, harness.deps)
    expect(second.kind).toBe('pumped')
    if (second.kind !== 'pumped') return
    expect(second.ran).toBe(1)
    expect(second.outcomes[0]).toMatchObject({
      jobId: analyzeId,
      kind: 'analyze-run',
      runId: 'r_requeue',
      disposition: 'completed',
      // Attempts were reset to 0 by the requeue, so the claim that ran this body is attempt 1
      // again — not attempt 2 of a row that never had a first.
      attempt: 1,
    })
    expect(second.stoppedOn).toBe('empty')

    const after = await harness.dump()
    expect(after.find((row) => row.id === analyzeId)?.status).toBe('done')

    // D-06 HELD TWICE. The successor key `${id}->curate-memory` is derived from a row id the
    // requeue deliberately preserved, so the re-chain dedupes onto the existing slot instead of
    // doubling it — and the row it dedupes onto is still queued, unclaimed, attempts 0.
    const successors = after.filter((row) => row.kind === 'curate-memory')
    expect(successors).toHaveLength(1)
    expect(successors[0]).toMatchObject({ status: 'queued', attempts: 0, claimed: false })
  })

  it('requeue answers not-terminal for a queued row and refuses under a held lease', async () => {
    const harness = makeHarness()
    await harness.enqueue('analyze-run', { runId: 'r_queued' }, 'r_queued')

    const rows = await harness.dump()
    const queuedId = rows[0]?.id
    expect(queuedId).toBeDefined()
    if (queuedId === undefined) return

    // A queued row belongs to whoever claims it next. Resetting its attempts out from under a
    // running handler is the two-writers-under-one-fence tampering the fence exists to exclude.
    const notTerminal = await requeueAgentJob(queuedId, harness.deps)
    expect(notTerminal).toEqual({ kind: 'not-terminal', status: 'queued' })
    expect(await harness.dump()).toEqual(rows)

    const holder = acquireWriterLease(harness.knowledgeRoot)
    expect(holder.kind).toBe('acquired')
    if (holder.kind !== 'acquired') return
    try {
      const refused = await requeueAgentJob(queuedId, harness.deps)
      expect(refused).toMatchObject({ kind: 'refused', reason: 'writer-lease-held' })
      if (refused.kind !== 'refused') return
      expect(refused.holder).toMatchObject({ pid: process.pid, epoch: holder.epoch })
      expect(await harness.dump()).toEqual(rows)
    } finally {
      releaseLease({ knowledgeRoot: harness.knowledgeRoot, leaseId: holder.leaseId })
    }
  })
})
