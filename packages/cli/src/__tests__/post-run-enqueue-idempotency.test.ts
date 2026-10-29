// Drives the shipped hand-off and tail twice and compares the store's logical dump across both.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { chainJobIdsForRun } from '@vostride/agent-qa-agent'
import {
  composeLocalAgent,
  DIGEST_JOB_ID_SOURCE,
  type LocalAgentHost,
} from '@vostride/agent-qa-agent-local'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  asRunId,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  type CompletedRunHandoff,
  type Verdict,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runVerdictFirstCurationTail } from '../curation/curation-tail.js'
import {
  runPostRunTail,
  type PostRunTailOperations,
  type RunPostRunTailOptions,
} from '../curation/post-run-tail.js'
import { enqueueThroughTheStep } from './post-run-step-harness.js'

// Passthrough: the fixture speaks canonical workspace-relative bytes, and core pins the recipe.
const MINT_IDENTITY = (filePath: string): string => filePath

const RUN_ID = 'run-388-02-idempotency'

// Unparseable text, not a throw: a throwing model aborts the chain; this degrades to the floor.
const TEST_MODEL: JobModelCapability = {
  modelId: 'test:post-run-enqueue-idempotency',
  generate: async () => ({ text: 'not an author payload' }),
}

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/post-run-enqueue-idempotency.config.yaml',
    entries: [],
  }),
}

/** The verdict the runner already persisted; one member has it, one deliberately does not. */
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
    scope: { tier: 'product', key: 'idempotency-storefront' },
    buildOrdinal: 3,
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
    ],
  }
}

const roots: string[] = []
const hosts: LocalAgentHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  agentQaRoot: string
  knowledgeRoot: string
  curateCalls: string[]
  warn: ReturnType<typeof vi.fn>
  runCurationTail: ReturnType<typeof vi.fn>
  options(overrides?: Partial<PostRunTailOperations>): RunPostRunTailOptions
  /** The shipped step's hand-off, over this fixture's own host. */
  enqueue(): Promise<'enqueued' | 'deduped'>
}

function fixture(): Fixture {
  const agentQaRoot = mkdtempSync(join(tmpdir(), 'agent-qa-388-02-'))
  roots.push(agentQaRoot)
  const knowledgeRoot = join(agentQaRoot, 'knowledge')
  mkdirSync(knowledgeRoot, { recursive: true })

  const handoff = fixtureHandoff(RUN_ID)
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(RUN_ID))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(handoff)}\n`, 'utf8')

  const curateCalls: string[] = []
  const warn = vi.fn<(message: string) => void>()
  const runCurationTail = vi.fn(async () => undefined)
  const configPath = join(agentQaRoot, 'agent-qa.config.yaml')
  const openHost = (): LocalAgentHost => {
    const host = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: TEST_CONFIG,
      knowledgeRoot: () => knowledgeRoot,
      model: () => TEST_MODEL,
      idSource: DIGEST_JOB_ID_SOURCE,
      postRun: {
        curateRun: async (input) => {
          curateCalls.push(input.runId)
          return { curated: 1, deprecated: 0, complete: true }
        },
        // True of this substitute: it records the call and returns counts, never reaching
        // candidate emission at all.
        candidateProse: 'masker-active',
      },
    })
    hosts.push(host)
    return host
  }

  return {
    agentQaRoot,
    knowledgeRoot,
    curateCalls,
    warn,
    runCurationTail,
    async enqueue(): Promise<'enqueued' | 'deduped'> {
      return await enqueueThroughTheStep({
        runId: RUN_ID,
        agentQaRoot,
        configPath,
        composeHost: openHost,
      })
    },
    options(overrides: Partial<PostRunTailOperations> = {}): RunPostRunTailOptions {
      return {
        runId: RUN_ID,
        agentQaRoot,
        configPath: join(agentQaRoot, 'agent-qa.config.yaml'),
        knowledgeConfig: { dir: 'knowledge' },
        configDir: agentQaRoot,
        log: { warn: (message: string) => warn(message) },
        operations: {
          resolveKnowledgeRoot: () => knowledgeRoot,
          runCurationTail,
          composeHost: openHost,
          ...overrides,
        },
      }
    },
  }
}

/**
 * The logical dump with the authority ratchet split out.
 *
 * `job_store_fence` MUST differ between two tail runs: each run acquires its own writer lease,
 * which mints a new epoch, and `adoptEpoch` records it. That row moving is the evidence the
 * second run really took authority and really pumped — so it is asserted SEPARATELY rather
 * than allowed to weaken the byte-identity claim about everything the chain wrote.
 */
function splitDump(logicalDump: string): { chain: string; fenceEpoch: number } {
  const parsed = JSON.parse(logicalDump) as {
    tables: { table: string; rows: { epoch?: number }[] }[]
  }
  const fence = parsed.tables.find((table) => table.table === 'job_store_fence')
  return {
    chain: JSON.stringify({
      ...parsed,
      tables: parsed.tables.filter((table) => table.table !== 'job_store_fence'),
    }),
    fenceEpoch: fence?.rows[0]?.epoch ?? -1,
  }
}

/** Read durable state through a SECOND composition — an in-memory memo could not survive this. */
async function readDurableState(agentQaRoot: string): Promise<{
  logicalDump: string
  rows: { id: string; kind: string; status: string; claimedAt: unknown }[]
}> {
  const host = composeLocalAgent({
    mask: (text) => text,
    mintQuarantineIdentityPath: MINT_IDENTITY,
    agentQaRoot,
    config: TEST_CONFIG,
    knowledgeRoot: () => join(agentQaRoot, 'knowledge'),
    model: () => TEST_MODEL,
    idSource: DIGEST_JOB_ID_SOURCE,
  })
  try {
    const jobs = await host.jobs()
    const logicalDump = await jobs.store.dumpLogicalState()
    const dump = await jobs.store.dumpState()
    return {
      logicalDump,
      rows: dump.jobs.map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        status: String(row.status),
        claimedAt: (row as { claimedAt?: unknown }).claimedAt,
      })),
    }
  } finally {
    await host.close()
  }
}

describe('the real post-run tail run twice', () => {
  it('produces exactly one analyze-run job, and the second run dedupes rather than errors', async () => {
    const f = fixture()
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)

    const firstEnqueue = await f.enqueue()
    const first = runPostRunTail({ ...f.options(), enqueueOutcome: firstEnqueue })
    await first.drain()
    const afterFirst = await readDurableState(f.agentQaRoot)

    const secondEnqueue = await f.enqueue()
    const second = runPostRunTail({ ...f.options(), enqueueOutcome: secondEnqueue })
    await second.drain()
    const afterSecond = await readDurableState(f.agentQaRoot)

    expect(first.report().enqueue).toBe('enqueued')
    // A deduped second hand-off is a success, so no enqueue warning fires for a healthy run.
    expect(second.report().enqueue).toBe('deduped')
    expect(f.warn).not.toHaveBeenCalled()

    const analyzeRows = afterSecond.rows.filter((row) => row.kind === 'analyze-run')
    expect(analyzeRows).toHaveLength(1)
    expect(analyzeRows[0]!.id).toBe(String(ids.analyzeRun))
    // Sorted literals on both, so an extra derived id or an extra enqueued row fails by name.
    expect(Object.keys(ids).sort()).toEqual(['analyzeRun', 'curateMemory'])
    expect(afterSecond.rows.map((row) => row.kind).sort()).toEqual(['analyze-run', 'curate-memory'])
    expect(afterSecond.rows.find((row) => row.kind === 'curate-memory'))
      .toMatchObject({ id: String(ids.curateMemory), status: 'done' })
    expect(f.curateCalls).toEqual([RUN_ID])

    // The second tail left every byte the chain wrote untouched; a row count would miss a rewrite.
    const first1 = splitDump(afterFirst.logicalDump)
    const second2 = splitDump(afterSecond.logicalDump)
    expect(second2.chain).toBe(first1.chain)
    // …and the fence DID advance, which is what makes the identity above non-vacuous: the
    // second tail took its own authority and pumped a queue it found already drained.
    expect(first1.fenceEpoch).toBe(1)
    expect(second2.fenceEpoch).toBe(2)
    expect(first1.chain.match(/"kind":"analyze-run"/g) ?? []).toHaveLength(1)
  })

  it('still enqueues under --detach, and drains nothing', async () => {
    const f = fixture()
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)
    // The shell's step hands off even under `--detach`: detaching declines the work, not its row.
    const tail = runPostRunTail({ ...f.options(), enqueueOutcome: await f.enqueue() })

    const exitCode = await runVerdictFirstCurationTail({
      exitCode: 1,
      detach: true,
      runTail: () => tail.drain(),
    })

    expect(exitCode).toBe(1)
    const state = await readDurableState(f.agentQaRoot)
    // The record exists…
    expect(state.rows).toEqual([
      expect.objectContaining({
        id: String(ids.analyzeRun),
        kind: 'analyze-run',
        status: 'queued',
      }),
    ])
    // …and nothing claimed or finished it: no chain successor, no curation, no sweep.
    expect(state.rows[0]!.claimedAt ?? null).toBeNull()
    expect(f.curateCalls).toEqual([])
    expect(f.runCurationTail).not.toHaveBeenCalled()
    expect(tail.report().drain).toBe('not-attempted')
  })

  it('a failed hand-off REJECTS out of the step, and the tail still prints nothing about it', async () => {
    // The step raises and the shell publishes the failure; told `failed`, `finish()` says nothing.
    const f = fixture()
    await expect(enqueueThroughTheStep({
      runId: RUN_ID,
      agentQaRoot: f.agentQaRoot,
      configPath: join(f.agentQaRoot, 'agent-qa.config.yaml'),
      composeHost: () => {
        throw new Error('the handoff store is unreachable')
      },
      loadCompletedRunHandoff: () => {
        throw new Error('the handoff store is unreachable')
      },
    })).rejects.toThrow('the handoff store is unreachable')

    const tail = runPostRunTail({ ...f.options(), enqueueOutcome: 'failed' })
    const exitCode = await runVerdictFirstCurationTail({
      exitCode: 7,
      detach: true,
      runTail: () => tail.drain(),
      finish: (input) => tail.finish(input),
    })

    expect(exitCode, 'the verdict\'s code was frozen long before any of this').toBe(7)
    expect(tail.report().enqueue).toBe('failed')
    expect(f.warn, 'no second, quieter version of a warning the shell already published').not.toHaveBeenCalled()
  })
})
