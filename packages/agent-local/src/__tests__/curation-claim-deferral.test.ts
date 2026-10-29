// Two hosts over one store differ only in posture: `no-masker` never claims, `masker-active` folds.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chainJobIdsForRun } from '@vostride/agent-qa-agent'
import type {
  ClockPort,
  ConfigReaderPort,
  JobModelCapability,
} from '@vostride/agent-qa-agent'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  asRunId,
  canonicalJson,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  sha256hex,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
// `JobKind` is a schema type; the agent barrel never re-exported it (TS2459 under the
// project-wide tsc, which vitest's per-file typecheck did not surface — the standing hazard).
import type { CompletedRunHandoff, JobKind } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import {
  composeLocalAgent,
  DIGEST_JOB_ID_SOURCE,
  UNCLAIMABLE_BY_PROSE_POSTURE,
} from '../composition/compose-local-agent.js'
import type { LocalAgentHost, LocalAgentJobs } from '../composition/compose-local-agent.js'

// Passthrough: this fixture already speaks canonical workspace-relative bytes.
const MINT_IDENTITY = (filePath: string): string => filePath

const RUN_ID = 'run-388-deferral'

const TEST_MODEL: JobModelCapability = {
  modelId: 'test:curation-claim-deferral',
  generate: async () => {
    throw new Error('the post-run chain never authors in 388')
  },
}

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/curation-claim-deferral.config.yaml',
    entries: [],
  }),
}

/** Monotonic and fully determined, so enqueue order IS `created_at` order. */
function createSteppingClock(): ClockPort {
  let tick = 0
  return {
    now() {
      const stamp = `2026-02-02T00:00:${String(tick % 60).padStart(2, '0')}.000Z`
      tick += 1
      return stamp
    },
  }
}

function fixtureHandoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'claim-deferral-storefront' },
    buildOrdinal: 7,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 't_passed',
        testName: 'member that passed',
        filePath: 'tests/passed.yaml',
        testIndex: 0,
        outcome: 'passed',
        steps: [],
      },
    ],
  }
}

function writeHandoff(agentQaRoot: string, handoff: CompletedRunHandoff): void {
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(String(handoff.runId)))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(handoff)}\n`, 'utf8')
}

function handoffDigest(handoff: CompletedRunHandoff): string {
  return sha256hex(canonicalJson(handoff))
}

const roots: string[] = []
const hosts: LocalAgentHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface DeferralHarness {
  readonly jobs: LocalAgentJobs
  readonly curateCalls: { runId: string; executionContext: unknown }[]
}

/**
 * The ONE varied input is the posture. Everything else — root, config, model, clock shape,
 * id source, `curateRun` body — is identical between the two hosts a case composes.
 */
async function openHost(
  agentQaRoot: string,
  candidateProse: 'masker-active' | 'no-masker',
): Promise<DeferralHarness> {
  const curateCalls: { runId: string; executionContext: unknown }[] = []
  const host = composeLocalAgent({
    mask: (text) => text,
    mintQuarantineIdentityPath: MINT_IDENTITY,
    agentQaRoot,
    config: TEST_CONFIG,
    knowledgeRoot: () => join(agentQaRoot, 'knowledge'),
    model: () => TEST_MODEL,
    clock: createSteppingClock(),
    idSource: DIGEST_JOB_ID_SOURCE,
    postRun: {
      curateRun: async (input) => {
        curateCalls.push({ runId: input.runId, executionContext: input.executionContext })
        return { curated: 1, deprecated: 0, complete: true }
      },
      candidateProse,
    },
  })
  hosts.push(host)
  return { jobs: await host.jobs(), curateCalls }
}

function freshRoot(): string {
  const agentQaRoot = mkdtempSync(join(tmpdir(), 'agent-qa-claim-deferral-'))
  roots.push(agentQaRoot)
  return agentQaRoot
}

/** The bounded pump, shaped like the daemon's dispatcher loop. */
async function pump(jobs: LocalAgentJobs, fence: { epoch: number }): Promise<number> {
  for (let pumped = 0; pumped < 24; pumped += 1) {
    const outcome = await jobs.queue.runNextJob({ fence })
    if (!outcome.ran) return pumped
  }
  throw new Error('the queue did not drain within the pump bound')
}

describe('curation claim deferral by candidate-prose posture', () => {
  it('a host declaring no masker pumps and never claims curate-memory: the row stays queued, unclaimed, attempts 0', async () => {
    const root = freshRoot()
    const unmasked = await openHost(root, 'no-masker')
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)

    // The chain's OWN successor key (`${analyzeRunId}->curate-memory`), so the enqueued row
    // IS the row `chainJobIdsForRun` addresses — the id the daemon leg would have claimed.
    await unmasked.jobs.queue.enqueue(
      'curate-memory',
      { runId: RUN_ID, executionContext: 'local-headless' },
      `${String(ids.analyzeRun)}->curate-memory`,
    )
    const fence = await unmasked.jobs.store.adoptEpoch(1)
    await pump(unmasked.jobs, fence)

    expect(unmasked.curateCalls).toHaveLength(0)
    const dump = await unmasked.jobs.store.dumpState()
    const row = dump.jobs.find((job) => job.id === String(ids.curateMemory))
    expect(row).toMatchObject({ status: 'queued', claimed: false, attempts: 0 })
  })

  it('the masked host claims the SAME row the unmasked host refused — the positive control', async () => {
    const root = freshRoot()
    const unmasked = await openHost(root, 'no-masker')
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)

    // The chain's OWN successor key (`${analyzeRunId}->curate-memory`), so the enqueued row
    // IS the row `chainJobIdsForRun` addresses — the id the daemon leg would have claimed.
    await unmasked.jobs.queue.enqueue(
      'curate-memory',
      { runId: RUN_ID, executionContext: 'local-headless' },
      `${String(ids.analyzeRun)}->curate-memory`,
    )
    const unmaskedFence = await unmasked.jobs.store.adoptEpoch(1)
    await pump(unmasked.jobs, unmaskedFence)
    expect(unmasked.curateCalls).toHaveLength(0)

    // Same store, same row, one input different: the posture.
    const masked = await openHost(root, 'masker-active')
    const maskedFence = await masked.jobs.store.adoptEpoch(2)
    await pump(masked.jobs, maskedFence)

    expect(masked.curateCalls).toEqual([
      { runId: RUN_ID, executionContext: 'local-headless' },
    ])
    expect(unmasked.curateCalls).toHaveLength(0)
    const dump = await masked.jobs.store.dumpState()
    const row = dump.jobs.find((job) => job.id === String(ids.curateMemory))
    expect(row).toMatchObject({ status: 'done', claimed: false, attempts: 1 })
  })

  it('the unmasked host still drains everything else: an older curate-memory row does not stall a younger analyze-run row', async () => {
    const root = freshRoot()
    const unmasked = await openHost(root, 'no-masker')
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(root, handoff)
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)

    // The deferred kind enqueued FIRST, so it is the OLDER row `selectClaimable` would offer
    // ahead of everything younger (ORDER BY created_at ASC) if the exclusion did not hold.
    // The chain's OWN successor key (`${analyzeRunId}->curate-memory`), so the enqueued row
    // IS the row `chainJobIdsForRun` addresses — the id the daemon leg would have claimed.
    await unmasked.jobs.queue.enqueue(
      'curate-memory',
      { runId: RUN_ID, executionContext: 'local-headless' },
      `${String(ids.analyzeRun)}->curate-memory`,
    )
    await unmasked.jobs.queue.enqueue(
      'analyze-run',
      {
        runId: RUN_ID,
        handoffDigest: handoffDigest(handoff),
        handoffSchemaVersion: handoff.schemaVersion,
        executionContext: handoff.executionContext,
      },
      RUN_ID,
    )
    const fence = await unmasked.jobs.store.adoptEpoch(1)
    await pump(unmasked.jobs, fence)

    // A deferral that stalls the whole queue is not a deferral: the younger analyze-run row
    // ran to done behind the deferred one, which itself stayed exactly as enqueued.
    const dump = await unmasked.jobs.store.dumpState()
    const byId = new Map(dump.jobs.map((job) => [job.id, job]))
    expect(byId.get(String(ids.analyzeRun))).toMatchObject({
      kind: 'analyze-run',
      status: 'done',
      attempts: 1,
    })
    expect(byId.get(String(ids.curateMemory))).toMatchObject({
      status: 'queued',
      claimed: false,
      attempts: 0,
    })
    expect(unmasked.curateCalls).toHaveLength(0)
  })

  it('the published unclaimable set names curate-memory for the unmasked host and is empty for the masked one', async () => {
    const unmasked = await openHost(freshRoot(), 'no-masker')
    const masked = await openHost(freshRoot(), 'masker-active')
    expect(unmasked.jobs.unclaimableKinds).toEqual(['curate-memory'])
    expect(masked.jobs.unclaimableKinds).toEqual([])
  })

  it('a host with NO postRun binding is treated as unmasked, not as unconstrained', async () => {
    // Silence reads as `no-masker`: a host composed without `postRun` would fold unreviewed.
    const host = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot: freshRoot(),
      config: TEST_CONFIG,
      knowledgeRoot: () => join(freshRoot(), 'knowledge'),
      model: () => TEST_MODEL,
      clock: createSteppingClock(),
      idSource: DIGEST_JOB_ID_SOURCE,
    })
    hosts.push(host)
    const jobs = await host.jobs()
    expect(jobs.unclaimableKinds).toEqual(['curate-memory'])
  })

  it('the posture table is frozen and the queue cannot be re-armed through it', async () => {
    // It guards a disclosure boundary and the engine holds its arrays by reference: frozen.
    expect(Object.isFrozen(UNCLAIMABLE_BY_PROSE_POSTURE)).toBe(true)
    expect(Object.isFrozen(UNCLAIMABLE_BY_PROSE_POSTURE['no-masker'])).toBe(true)

    // The published set IS the table's own frozen entry — one object, so it cannot drift from
    // what the queue claims against — and freezing is precisely what makes that sharing safe.
    // Emptying what a caller can reach must not empty the guard.
    const unmasked = await openHost(freshRoot(), 'no-masker')
    const published = unmasked.jobs.unclaimableKinds as JobKind[]
    try {
      published.length = 0
    } catch {
      // A frozen copy refuses the write outright, which is the stronger of the two outcomes.
    }
    expect(UNCLAIMABLE_BY_PROSE_POSTURE['no-masker']).toEqual(['curate-memory'])
  })
})
