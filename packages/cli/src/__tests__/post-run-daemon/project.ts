// A shared module, not an imported `.test.ts`, because importing a test file runs its suite again.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { invokeFunction, RUNS_POST_PROCESSING_FUNCTION_ID } from '@vostride/agent-qa-agent'
import { composeLocalAgent, DIGEST_JOB_ID_SOURCE } from '@vostride/agent-qa-agent-local'
import type { LocalAgentHost, LocalAgentJobs } from '@vostride/agent-qa-agent-local'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  asRunId,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  type CompletedRunHandoff,
  type PostProcessingStatus,
  type RunEventEnvelope,
  type Verdict,
  CURRENT_BUS_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'

import { CLI_FUNCTION_CALLER } from '../../composition/local-agent-host.js'
import {
  runPostRunTail,
  type PostRunTailOperations,
  type PostRunTailReport,
} from '../../curation/post-run-tail.js'
import { enqueueThroughTheStep } from '../post-run-step-harness.js'

// Passthrough: the fixture speaks canonical workspace-relative bytes, and core pins the recipe.
const MINT_IDENTITY = (filePath: string): string => filePath

export const EVENTS_FILE = 'events.jsonl'
export const AGENT_JOB_STORE_DB_FILE = 'agent-jobs.db'
/** `job-checkpoint-store.ts`'s `JOB_CHECKPOINT_SUBDIR`; the store itself is off the barrel. */
export const JOB_CHECKPOINT_SUBDIR = ['agent-jobs', 'checkpoints'] as const

// Unparseable text, not a throw: a throwing model aborts the chain; this degrades to the floor.
const TEST_MODEL: JobModelCapability = {
  modelId: 'test:post-run-daemon',
  generate: async () => ({ text: 'not an author payload' }),
}

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/post-run-daemon.config.yaml',
    entries: [],
  }),
}

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

export function fixtureHandoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'post-run-daemon-storefront' },
    buildOrdinal: 6,
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

function fixtureEventLines(runId: string): RunEventEnvelope[] {
  return [
    { seq: 1, ts: 10, runId, type: 'runStarted', payload: { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION } },
    { seq: 2, ts: 20, runId, type: 'verdict', payload: { verdict: 'failed' } },
    {
      seq: 3,
      ts: 30,
      runId,
      type: 'runFinished',
      payload: { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: 3 },
    },
  ] as unknown as RunEventEnvelope[]
}

export interface WrittenProject {
  readonly runDir: string
  readonly handoffPath: string
  readonly eventsPath: string
  /** The finished run's log exactly as the fixture left it; the byte-stability comparison basis. */
  readonly eventsBytes: string
}

export function writeProjectFixture(agentQaRoot: string, runId: string): WrittenProject {
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
  mkdirSync(runDir, { recursive: true })
  const handoffPath = join(runDir, HANDOFF_FILE)
  writeFileSync(handoffPath, `${JSON.stringify(fixtureHandoff(runId))}\n`, 'utf8')
  const eventsPath = join(runDir, EVENTS_FILE)
  const eventsBytes = `${fixtureEventLines(runId).map((line) => JSON.stringify(line)).join('\n')}\n`
  writeFileSync(eventsPath, eventsBytes, 'utf8')
  return { runDir, handoffPath, eventsPath, eventsBytes }
}

export interface TailOutcome {
  readonly report: PostRunTailReport
  readonly info: readonly string[]
  readonly warn: readonly string[]
}

// The real lease and nudge, so the leg hands off and the nudge crosses the daemon's socket.
export async function runRealTail(input: {
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  readonly runId: string
  readonly hosts: LocalAgentHost[]
}): Promise<TailOutcome> {
  const info: string[] = []
  const warn: string[] = []
  const enqueueOutcome = await enqueueThroughTheStep({
    runId: input.runId,
    agentQaRoot: input.agentQaRoot,
    configPath: join(input.agentQaRoot, 'agent-qa.config.yaml'),
    composeHost: () => {
      const host = openProjectHost(input.agentQaRoot, input.knowledgeRoot)
      input.hosts.push(host)
      return host
    },
  })
  const tail = runPostRunTail({
    runId: input.runId,
    enqueueOutcome,
    agentQaRoot: input.agentQaRoot,
    configPath: join(input.agentQaRoot, 'agent-qa.config.yaml'),
    knowledgeConfig: { dir: input.knowledgeRoot },
    configDir: input.agentQaRoot,
    log: {
      warn: (message: string) => { warn.push(message) },
      info: (message: string) => { info.push(message) },
    },
    operations: {
      resolveKnowledgeRoot: () => input.knowledgeRoot,
      runCurationTail: async () => undefined,
      composeHost: () => {
        const host = openProjectHost(input.agentQaRoot, input.knowledgeRoot)
        input.hosts.push(host)
        return host
      },
    } satisfies Partial<PostRunTailOperations>,
  })
  await tail.drain()
  await tail.finish()
  return { report: tail.report(), info, warn }
}

/** A composition over the same root the daemon serves — the second, socket-free reader. */
export function openProjectHost(agentQaRoot: string, knowledgeRoot: string): LocalAgentHost {
  return composeLocalAgent({
    mask: (text) => text,
    mintQuarantineIdentityPath: MINT_IDENTITY,
    agentQaRoot,
    config: TEST_CONFIG,
    knowledgeRoot: () => knowledgeRoot,
    model: () => TEST_MODEL,
    idSource: DIGEST_JOB_ID_SOURCE,
    postRun: {
      curateRun: () => {
        throw new Error('the reading host never curates')
      },
      // True of this substitute: it throws on entry, so no candidate emission is reachable.
      candidateProse: 'masker-active',
    },
  })
}

/**
 * Chip truth through the ONE read op, from a SECOND composition over the same root.
 *
 * A fresh host per call on purpose: the claim is that a re-querying user reads the truth from
 * durable job state, and a handle kept alive across the daemon's work would be answering partly
 * from whatever it was holding. This composition has no daemon client, no apply delegate and no
 * socket path — there is nothing here that could ask another process anything.
 */
export async function readStatusThroughTheOp(
  agentQaRoot: string,
  knowledgeRoot: string,
  runId: string,
): Promise<PostProcessingStatus> {
  const host = openProjectHost(agentQaRoot, knowledgeRoot)
  try {
    return await invokeFunction(
      host.registry,
      RUNS_POST_PROCESSING_FUNCTION_ID,
      { runId },
      CLI_FUNCTION_CALLER,
    ) as PostProcessingStatus
  } finally {
    await host.close()
  }
}

export interface JobRowView {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly claimed: boolean
  readonly attempts: number
}

/** Every job row, through a host composed for this read alone. */
export async function readJobRows(
  agentQaRoot: string,
  knowledgeRoot: string,
): Promise<readonly JobRowView[]> {
  const host = openProjectHost(agentQaRoot, knowledgeRoot)
  try {
    const jobs: LocalAgentJobs = await host.jobs()
    const dump = await jobs.store.dumpState()
    return dump.jobs.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      status: String(row.status),
      claimed: row.claimed === true,
      attempts: Number(row.attempts),
    }))
  } finally {
    await host.close()
  }
}

/** The durable notification read: the store implementation, never the engine port. */
export async function readNotifications(
  agentQaRoot: string,
  knowledgeRoot: string,
): Promise<readonly { runId: string; payload: unknown; createdAt: string }[]> {
  const host = openProjectHost(agentQaRoot, knowledgeRoot)
  try {
    const jobs = await host.jobs()
    return (await jobs.store.listNotifications()).map((row) => ({
      runId: row.runId,
      payload: row.payload,
      createdAt: row.createdAt,
    }))
  } finally {
    await host.close()
  }
}

export function readEventsBytes(eventsPath: string): string {
  return readFileSync(eventsPath, 'utf8')
}

/**
 * Every checkpoint file under the store's checkpoint root, by path relative to it.
 *
 * Read from DISK rather than from the authoritative table, because the claim the crash legs make
 * is about the fsync'd artifact a killed host left behind — the bytes a resumed attempt must not
 * quietly re-author.
 */
export function readCheckpointFiles(agentQaRoot: string): Record<string, string> {
  const root = join(agentQaRoot, ...JOB_CHECKPOINT_SUBDIR)
  const found: Record<string, string> = {}
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      found[relative(root, path).split(sep).join('/')] = readFileSync(path, 'utf8')
    }
  }
  walk(root)
  return found
}
