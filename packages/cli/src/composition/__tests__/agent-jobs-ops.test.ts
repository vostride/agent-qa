// A host drains one job kind and leaves the successor that kind enqueues queued and unclaimed.

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

// Strictly increasing: the store claims same-millisecond rows in id order, so two enqueues in one
// millisecond would otherwise not claim in enqueue order.
let lastTick = 0
const clock = {
  now: (): string => {
    lastTick = Math.max(Date.now(), lastTick + 1)
    return new Date(lastTick).toISOString()
  },
}

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
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-'))
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
          // Stated empty, not omitted, or the cells would measure only the `--only` braces.
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

// The member carries a persisted `rootCause`, so the floor has no unknown member and no model runs.

const PUMPED_RUN_ID = 'run-pumped'

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
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-composed-'))
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

    // The successor exists only because the real body ran; the stand-in returns `next: []`.
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
  // `pumpAgentJobs` builds its own queue, so the host's unclaimable kinds are unioned into it.
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

// Requeue forgets the last attempt's checkpoints too, or the real handler replays empty authorship.

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

    // The successor key comes from the kept row id, so the re-chain dedupes onto that slot.
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
