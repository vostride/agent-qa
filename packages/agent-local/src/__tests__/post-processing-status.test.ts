// Driven through `invokeFunction`; a status query answers from disk and creates nothing.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'

import { chainJobIdsForRun, invokeFunction, RUNS_POST_PROCESSING_FUNCTION_ID } from '@vostride/agent-qa-agent'
import type { ClockPort, ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import type { PostRunJobCapabilities } from '@vostride/agent-qa-agent'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  asRunId,
  canonicalJson,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CurationSnapshotSchema,
  JOB_CHECKPOINT_SCHEMA_VERSION,
  sha256hex,
  toRunNotificationView,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
  CURATION_SNAPSHOT_SCHEMA_VERSION,
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
import { AGENT_JOB_STORE_DB_FILE, QUARANTINED_UNREADABLE_KIND_REASON } from '../store/sqlite-job-store.js'
import { canonicalLogicalDump, createLogicalDump } from '../store/logical-dump.js'
import { createPostProcessingReader } from '../store/post-processing-reader.js'
import { createJobCheckpointStore, readJobCheckpointEnvelope } from '../store/job-checkpoint-store.js'

// Passthrough: this fixture already speaks canonical workspace-relative bytes.
const MINT_IDENTITY = (filePath: string): string => filePath

const RUN_ID = 'run-388-status'

const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

const TEST_MODEL: JobModelCapability = {
  modelId: 'test:post-processing-status',
  generate: async () => {
    throw new Error('the post-run chain never authors in 388')
  },
}

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/post-processing-status.config.yaml',
    entries: [],
  }),
}

function createSteppingClock(): ClockPort {
  let tick = 0
  return {
    now() {
      // A minute per read, past every declared retry backoff.
      const stamp = new Date(Date.parse('2026-03-03T00:00:00.000Z') + tick * 60_000).toISOString()
      tick += 1
      return stamp
    },
  }
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

function fixtureHandoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'post-processing-storefront' },
    buildOrdinal: 9,
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

function writeHandoff(agentQaRoot: string, handoff: CompletedRunHandoff): void {
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(String(handoff.runId)))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(handoff)}\n`, 'utf8')
}

function enqueuePayload(handoff: CompletedRunHandoff): Record<string, unknown> {
  return {
    runId: String(handoff.runId),
    handoffDigest: sha256hex(canonicalJson(handoff)),
    handoffSchemaVersion: handoff.schemaVersion,
    executionContext: handoff.executionContext,
  }
}

const roots: string[] = []
const hosts: LocalAgentHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Harness {
  readonly agentQaRoot: string
  readonly host: LocalAgentHost
  readonly status: () => Promise<PostProcessingStatus>
}

/**
 * A host with no job store OPENED — `jobs()` is deliberately not called here.
 *
 * That is the point of the fixture rather than an omission: the no-creation case needs a host
 * that has done nothing durable, and the cases that do need rows open the store themselves.
 */
function createHarness(existingRoot?: string, postRun?: {
  curateRun?: PostRunJobCapabilities['curateRun']
}, mask: (text: string) => string = (text) => text): Harness {
  const agentQaRoot = existingRoot ?? mkdtempSync(join(tmpdir(), 'agent-qa-pp-status-'))
  if (existingRoot === undefined) roots.push(agentQaRoot)
  const host = composeLocalAgent({
    mask,
    mintQuarantineIdentityPath: MINT_IDENTITY,
    agentQaRoot,
    config: TEST_CONFIG,
    knowledgeRoot: () => join(agentQaRoot, 'knowledge'),
    model: () => TEST_MODEL,
    clock: createSteppingClock(),
    postRun: {
      curateRun: async () => ({ curated: 2, deprecated: 1, complete: true }),
      // True of this substitute: it returns counts without ever reaching candidate emission.
      candidateProse: 'masker-active',
      ...postRun,
    },
  })
  hosts.push(host)
  return {
    agentQaRoot,
    host,
    status: async () => await invokeFunction(
      host.registry,
      RUNS_POST_PROCESSING_FUNCTION_ID,
      { runId: RUN_ID },
      CALLER,
    ) as PostProcessingStatus,
  }
}

async function pump(jobs: LocalAgentJobs, fence: { epoch: number }): Promise<void> {
  for (let pumped = 0; pumped < 24; pumped += 1) {
    const outcome = await jobs.queue.runNextJob({ fence })
    if (!outcome.ran) return
  }
  throw new Error('the post-run chain did not drain within the pump bound')
}

async function closeWriter(harness: Harness): Promise<void> {
  await harness.host.close()
  hosts.splice(hosts.indexOf(harness.host), 1)
}

function readQueue(root: string) {
  const db = new DatabaseSync(join(root, AGENT_JOB_STORE_DB_FILE), { readOnly: true })
  try {
    return {
      rows: db.prepare('SELECT * FROM jobs ORDER BY created_at, id').all(),
      logical: canonicalLogicalDump(createLogicalDump({
        db,
        schemaVersion: Number(db.prepare('PRAGMA user_version').get()?.user_version),
        checkpointsRoot: join(root, 'agent-jobs'),
      })),
    }
  } finally {
    db.close()
  }
}

const CURATION_SNAPSHOT = CurationSnapshotSchema.parse({
  schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
  rows: [{ recordId: 'affected-record', bucket: 'added', changes: [{ bucket: 'added',
    change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'affected-record', change: 'added', atOrdinal: 9 },
  }] }],
  breakdown: { added: 1, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 },
})

function readColdChain(root: string, runId = RUN_ID) {
  return createPostProcessingReader({ agentQaRoot: root, idSource: DIGEST_JOB_ID_SOURCE })
    .readChain(chainJobIdsForRun(runId, DIGEST_JOB_ID_SOURCE), runId)
}

async function completedCuration() {
  const writer = createHarness(undefined, {
    curateRun: async () => ({ curated: 7, deprecated: 3, complete: true, snapshot: CURATION_SNAPSHOT }),
  })
  const jobs = await writer.host.jobs()
  const fence = await jobs.store.adoptEpoch(1)
  const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)
  await jobs.queue.enqueue('curate-memory', { runId: RUN_ID }, `${ids.analyzeRun}->curate-memory`)
  expect(await jobs.queue.runNextJob({ fence })).toMatchObject({ ran: true, disposition: 'completed' })
  await closeWriter(writer)
  return { writer, ids }
}

describe('the completed checkpoint snapshot', () => {
  it('CHECKPOINT-ENVELOPE keeps safe addresses and named version refusal without creating directories', () => {
    const harness = createHarness()
    const root = join(harness.agentQaRoot, 'missing-root')
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)
    expect(readJobCheckpointEnvelope({ root }, ids.curateMemory, 'bundle-committed')).toEqual({ found: false })
    expect(existsSync(root)).toBe(false)
    expect(() => readJobCheckpointEnvelope({ root }, '../escape', 'bundle-committed'))
      .toThrowError(expect.objectContaining({ name: 'InvalidJobCheckpointIdError' }))
    expect(() => readJobCheckpointEnvelope({ root: 'relative' }, ids.curateMemory, 'bundle-committed'))
      .toThrow('must be absolute')
    const store = createJobCheckpointStore({ root })
    store.publish(ids.curateMemory, 'bundle-committed', {})
    const path = store.checkpointPath(ids.curateMemory, 'bundle-committed')
    const envelope = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...envelope, schemaVersion: 999 }))
    expect(() => readJobCheckpointEnvelope({ root }, ids.curateMemory, 'bundle-committed'))
      .toThrowError(expect.objectContaining({ name: 'JobCheckpointSchemaVersionError' }))
    writeFileSync(path, JSON.stringify({ ...envelope, jobId: ids.analyzeRun }))
    expect(() => readJobCheckpointEnvelope({ root }, ids.curateMemory, 'bundle-committed'))
      .toThrow('does not match its address')
  })

  it.each([1, 3])('refuses a checkpoint file stamped %i by name', (stamp) => {
    const root = join(createHarness().agentQaRoot, 'stamped-root')
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)
    const store = createJobCheckpointStore({ root })
    store.publish(ids.curateMemory, 'bundle-committed', {})
    const path = store.checkpointPath(ids.curateMemory, 'bundle-committed')
    const envelope = JSON.parse(readFileSync(path, 'utf8'))
    expect(envelope.schemaVersion).toBe(JOB_CHECKPOINT_SCHEMA_VERSION)
    writeFileSync(path, JSON.stringify({ ...envelope, schemaVersion: stamp }))
    expect(() => readJobCheckpointEnvelope({ root }, ids.curateMemory, 'bundle-committed'))
      .toThrowError(expect.objectContaining({
        name: 'JobCheckpointSchemaVersionError',
        path,
        observedVersion: stamp,
      }))
  })

  it.each(['historical', 'incomplete'] as const)('CHECKPOINT-MISSING %s never invents a snapshot', async kind => {
    const writer = createHarness(undefined, {
      curateRun: async () => ({ curated: 7, deprecated: 3, complete: kind === 'historical',
        ...(kind === 'incomplete' ? { snapshot: CURATION_SNAPSHOT } : {}),
      }),
    })
    const jobs = await writer.host.jobs()
    const fence = await jobs.store.adoptEpoch(1)
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)
    await jobs.queue.enqueue('curate-memory', { runId: RUN_ID }, `${ids.analyzeRun}->curate-memory`)
    await jobs.queue.runNextJob({ fence })
    const checkpoint = await jobs.store.readCheckpoint(ids.curateMemory, 'bundle-committed')
    expect(checkpoint.found).toBe(kind === 'historical')
    await closeWriter(writer)
    expect(await readColdChain(writer.agentQaRoot)).not.toHaveProperty('curationSnapshot')
    expect(await readColdChain(writer.agentQaRoot, 'unrelated-run')).not.toHaveProperty('curationSnapshot')
  })

  it.each(['snapshot', 'run', 'job', 'checkpoint', 'attempt', 'digest', 'chain', 'job-run'] as const)(
    'CHECKPOINT-INVALID %s refuses authoritative corruption without changing bytes', async field => {
      const { writer, ids } = await completedCuration()
      const db = new DatabaseSync(join(writer.agentQaRoot, AGENT_JOB_STORE_DB_FILE))
      try {
        const row = db.prepare('SELECT payload_json FROM job_checkpoints WHERE checkpoint_id = ?')
          .get('bundle-committed')!
        const payload = JSON.parse(String(row.payload_json))
        if (field === 'snapshot') payload.value.curationSnapshot = { ...CURATION_SNAPSHOT, breakdown: {} }
        if (field === 'run') payload.value.runId = 'unrelated-run'
        if (field === 'job') payload.jobId = ids.analyzeRun
        if (field === 'checkpoint') payload.checkpointId = 'candidates-authored'
        if (field === 'attempt') payload.attempt += 1
        if (field === 'chain') db.prepare('UPDATE jobs SET idempotency_key = ? WHERE id = ?')
          .run('unrelated-chain', ids.curateMemory)
        if (field === 'job-run') db.prepare('UPDATE jobs SET payload = ? WHERE id = ?')
          .run(JSON.stringify({ runId: 'unrelated-run' }), ids.curateMemory)
        const json = canonicalJson(payload)
        db.prepare('UPDATE job_checkpoints SET payload_json = ?, payload_digest = ? WHERE checkpoint_id = ?')
          .run(json, field === 'digest' ? 'invalid-digest' : sha256hex(json), 'bundle-committed')
      } finally { db.close() }
      const before = readQueue(writer.agentQaRoot)
      await expect(readColdChain(writer.agentQaRoot)).rejects.toMatchObject({ name: 'CurationSnapshotReadError' })
      expect(readQueue(writer.agentQaRoot)).toEqual(before)
    },
  )

  it.each(['missing', 'malformed', 'stale', 'misaddressed'] as const)(
    'CHECKPOINT-CACHE %s recovers the validated fenced snapshot', async kind => {
      const { writer, ids } = await completedCuration()
      const checkpoints = createJobCheckpointStore({ root: writer.agentQaRoot })
      const path = checkpoints.checkpointPath(ids.curateMemory, 'bundle-committed')
      const envelope = JSON.parse(readFileSync(path, 'utf8'))
      if (kind === 'missing') rmSync(path)
      else if (kind === 'malformed') writeFileSync(path, '{')
      else {
        if (kind === 'stale') envelope.payload.value.curationSnapshot = { ...CURATION_SNAPSHOT, rows: [] }
        else envelope.jobId = ids.analyzeRun
        writeFileSync(path, JSON.stringify(envelope))
      }
      const before = readQueue(writer.agentQaRoot)
      expect(await readColdChain(writer.agentQaRoot)).toHaveProperty('curationSnapshot', CURATION_SNAPSHOT)
      expect(readQueue(writer.agentQaRoot)).toEqual(before)
    },
  )

  it('CHECKPOINT-LATEST reads the newest fenced attempt, never a stale valid file', async () => {
    const { writer, ids } = await completedCuration()
    const empty = CurationSnapshotSchema.parse({ schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [],
      breakdown: { added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 },
    })
    const db = new DatabaseSync(join(writer.agentQaRoot, AGENT_JOB_STORE_DB_FILE))
    try {
      const row = db.prepare('SELECT * FROM job_checkpoints WHERE checkpoint_id = ?')
        .get('bundle-committed')!
      const payload = JSON.parse(String(row.payload_json))
      payload.attempt = 2
      payload.value.curationSnapshot = empty
      const json = canonicalJson(payload)
      db.prepare('UPDATE jobs SET attempts = 2 WHERE id = ?').run(ids.curateMemory)
      db.prepare(`INSERT INTO job_checkpoints
        (job_id, checkpoint_id, attempt, payload_json, payload_digest, epoch) VALUES (?, ?, 2, ?, ?, ?)`)
        .run(ids.curateMemory, 'bundle-committed', json, sha256hex(json), row.epoch!)
    } finally { db.close() }
    expect(await readColdChain(writer.agentQaRoot)).toHaveProperty('curationSnapshot', empty)
    const remove = new DatabaseSync(join(writer.agentQaRoot, AGENT_JOB_STORE_DB_FILE))
    try { remove.prepare('DELETE FROM job_checkpoints WHERE job_id = ?').run(ids.curateMemory) }
    finally { remove.close() }
    expect(await readColdChain(writer.agentQaRoot)).not.toHaveProperty('curationSnapshot')
  })
})

describe('cold stage facts', () => {
  it.each(['queued', 'retried', 'complete', 'failed', 'cancelled'] as const)(
    'STAGE-COLD %s preserves exact rows and queue contents',
    async lifecycle => {
      const writer = createHarness()
      const jobs = await writer.host.jobs()
      const fence = await jobs.store.adoptEpoch(1)
      const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)
      const stages = [
        ['analysis', 'analyze-run', RUN_ID, ids.analyzeRun],
        ['curation', 'curate-memory', `${ids.analyzeRun}->curate-memory`, ids.curateMemory],
      ] as const
      for (const [stage, kind, key, id] of stages) {
        const enqueued = await jobs.queue.enqueue(kind, { runId: RUN_ID }, key)
        expect(enqueued.job.id).toBe(id)
        if (lifecycle === 'cancelled') {
          expect(await jobs.store.requestCancel(id, fence)).toEqual({ outcome: 'cancelled' })
        } else if (lifecycle !== 'queued') {
          const excludeKinds = stages.map(item => item[1]).filter(other => other !== kind)
          const claimed = await jobs.store.claimNext(fence, { excludeKinds })
          expect(claimed).toMatchObject({ claimed: true, job: { id } })
          if (lifecycle === 'complete') await jobs.store.completeAndChain(id, [], fence)
          if (lifecycle === 'failed') {
            await jobs.store.recordFailure(id, { kind: 'permanent', reason: `${stage} failed` }, fence)
          }
          if (lifecycle === 'retried') {
            await jobs.store.recordFailure(id, { kind: 'retry', reason: `${stage} retry` }, fence)
            expect(await jobs.store.claimNext(fence, { excludeKinds }))
              .toMatchObject({ claimed: true, job: { id, attempts: 2 } })
          }
        }
      }
      await closeWriter(writer)
      const before = readQueue(writer.agentQaRoot)
      expect(before.rows).toHaveLength(2)
      const bytes = readFileSync(join(writer.agentQaRoot, AGENT_JOB_STORE_DB_FILE))
      const cold = createHarness(writer.agentQaRoot)
      const result = await cold.status()
      const expected = Object.fromEntries(stages.map(([stage, , , id]) => {
        const row = before.rows.find(row => row.id === id)!
        expect(row.status).toBe(lifecycle === 'retried' ? 'queued' : lifecycle === 'complete' ? 'done' : lifecycle)
        expect(Number(row.attempts)).toBe(lifecycle === 'retried' ? 2 : lifecycle === 'complete' || lifecycle === 'failed' ? 1 : 0)
        // THE SETTLED SHAPE, asserted rather than assumed: a terminal transition releases the lease
        // and keeps the start, and a row nobody claimed has no start at all.
        if (lifecycle === 'complete' || lifecycle === 'failed') {
          expect(row.claimed_at).toBeNull()
          expect(row.started_at).not.toBeNull()
        }
        if (lifecycle === 'queued') expect(row.started_at).toBeNull()
        return [stage, {
          attempts: Number(row.attempts),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
          ...(row.started_at === null ? {} : { startedAt: row.started_at }),
          ...(row.last_failure_kind === null ? {} : { lastFailureKind: row.last_failure_kind }),
          ...(row.last_failure_reason === null ? {} : { lastFailureReason: row.last_failure_reason }),
        }]
      }))
      expect(result.stageDetails).toEqual(expected)
      const chip = lifecycle === 'retried' ? 'running' : lifecycle === 'complete' ? 'complete'
        : lifecycle === 'queued' ? 'pending' : 'failed'
      expect(result.chips).toEqual({ analysis: chip, curation: chip })
      expect(readQueue(writer.agentQaRoot)).toEqual(before)
      expect(readFileSync(join(writer.agentQaRoot, AGENT_JOB_STORE_DB_FILE))).toEqual(bytes)
    },
  )

  // Terminal transitions release the claim lease, so a finished stage is timed from its start.
  it('DURABLE-START-SURVIVES-THE-LEASE: a settled stage carries its start and no lease after cold reopen', async () => {
    const FAILED_RUN = 'run-425-start-failed'
    const QUEUED_RUN = 'run-425-start-queued'
    const writer = createHarness()
    const jobs = await writer.host.jobs()
    const fence = await jobs.store.adoptEpoch(1)
    const done = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE).analyzeRun
    const failed = chainJobIdsForRun(FAILED_RUN, DIGEST_JOB_ID_SOURCE).analyzeRun
    const queued = chainJobIdsForRun(QUEUED_RUN, DIGEST_JOB_ID_SOURCE).analyzeRun

    expect((await jobs.queue.enqueue('analyze-run', { runId: RUN_ID }, RUN_ID)).job.id).toBe(done)
    expect(await jobs.store.claimNext(fence)).toMatchObject({ claimed: true, job: { id: done } })
    await jobs.store.completeAndChain(done, [], fence)
    expect((await jobs.queue.enqueue('analyze-run', { runId: FAILED_RUN }, FAILED_RUN)).job.id)
      .toBe(failed)
    expect(await jobs.store.claimNext(fence)).toMatchObject({ claimed: true, job: { id: failed } })
    await jobs.store.recordFailure(failed, { kind: 'permanent', reason: 'analysis failed' }, fence)
    expect((await jobs.queue.enqueue('analyze-run', { runId: QUEUED_RUN }, QUEUED_RUN)).job.id)
      .toBe(queued)
    await closeWriter(writer)

    const rows = readQueue(writer.agentQaRoot).rows
    const rowOf = (id: string) => rows.find(row => row.id === id)!
    for (const id of [done, failed]) {
      expect(rowOf(id).claimed_at).toBeNull()
      expect(rowOf(id).started_at).not.toBeNull()
    }
    expect(rowOf(queued).started_at).toBeNull()

    const cold = createHarness(writer.agentQaRoot)
    const statusOf = async (runId: string) => await invokeFunction(
      cold.host.registry,
      RUNS_POST_PROCESSING_FUNCTION_ID,
      { runId },
      CALLER,
    ) as PostProcessingStatus

    for (const [runId, id] of [[RUN_ID, done], [FAILED_RUN, failed]] as const) {
      const detail = (await statusOf(runId)).stageDetails?.analysis
      expect(detail).toBeDefined()
      expect('claimedAt' in detail!, `${runId}: a settled stage holds no lease`).toBe(false)
      expect(detail!.startedAt).toBe(String(rowOf(id).started_at))
      const created = Date.parse(detail!.createdAt!)
      const started = Date.parse(detail!.startedAt!)
      const updated = Date.parse(detail!.updatedAt!)
      expect(created).toBeLessThanOrEqual(started)
      expect(started).toBeLessThanOrEqual(updated)
    }

    const never = (await statusOf(QUEUED_RUN)).stageDetails?.analysis
    expect(never).toBeDefined()
    expect('startedAt' in never!, 'a stage nobody claimed has no start: absent is not zero').toBe(false)
    expect('claimedAt' in never!).toBe(false)
  })

  it("MASK-FAILURE-REASON masks persisted prose with the host's declared mask", async () => {
    const writer = createHarness()
    const jobs = await writer.host.jobs()
    const fence = await jobs.store.adoptEpoch(1)
    const { job } = await jobs.queue.enqueue('analyze-run', { runId: RUN_ID }, RUN_ID)
    await jobs.store.claimNext(fence)
    const reason = 'synthetic-cold-secret for operator@example.test'
    await jobs.store.recordFailure(job.id, { kind: 'permanent', reason }, fence)
    await closeWriter(writer)
    const before = readQueue(writer.agentQaRoot)
    expect(before.rows[0]?.last_failure_reason).toBe(reason)
    const redactor = new SecretRedactor(new SecretStore({ COLD_KEY: 'synthetic-cold-secret' }))
    const result = await createHarness(writer.agentQaRoot, undefined, (text) => redactor.redactString(text)).status()
    expect(result.stageDetails?.analysis?.lastFailureReason).toBe('[secret:COLD_KEY] for operator@example.test')
    expect(JSON.stringify(result)).not.toContain('synthetic-cold-secret')
    expect(JSON.stringify(result)).toContain('operator@example.test')
    expect(readQueue(writer.agentQaRoot)).toEqual(before)
  })

  it('JOB-MISSING-OMITTED projects only the existing row after cold reopen', async () => {
    const writer = createHarness()
    const jobs = await writer.host.jobs()
    await jobs.queue.enqueue('analyze-run', { runId: RUN_ID }, RUN_ID)
    await closeWriter(writer)
    const before = readQueue(writer.agentQaRoot)
    const row = before.rows[0]!
    const result = await createHarness(writer.agentQaRoot).status()
    expect(result.stageDetails).toEqual({ analysis: {
      attempts: 0, createdAt: row.created_at, updatedAt: row.updated_at,
    } })
    expect(readQueue(writer.agentQaRoot)).toEqual(before)
  })

  it('CONCLUSION-RECORDED reports the writer quarantine conclusion after cold reopen', async () => {
    const writer = createHarness()
    const jobs = await writer.host.jobs()
    await jobs.queue.enqueue('analyze-run', { runId: RUN_ID }, RUN_ID)
    await closeWriter(writer)
    const db = new DatabaseSync(join(writer.agentQaRoot, AGENT_JOB_STORE_DB_FILE))
    try {
      expect(Number(db.prepare('UPDATE jobs SET kind = ?').run('unknown-fixture-kind').changes)).toBe(1)
    } finally { db.close() }
    const quarantine = createHarness(writer.agentQaRoot)
    const reopened = await quarantine.host.jobs()
    const fence = await reopened.store.adoptEpoch(1)
    expect(await reopened.store.claimNext(fence)).toEqual({ claimed: false })
    expect((await reopened.store.dumpState()).jobs[0]?.conclusionKind).toBe('unreadable_kind')
    await closeWriter(quarantine)
    const before = readQueue(writer.agentQaRoot)
    expect(before.rows[0]?.last_failure_reason).toBe(QUARANTINED_UNREADABLE_KIND_REASON)
    const result = await createHarness(writer.agentQaRoot).status()
    expect(result.stageDetails?.analysis?.conclusionKind).toBe('unreadable_kind')
    expect(readQueue(writer.agentQaRoot)).toEqual(before)
  })
})

describe('a status read creates no queue state', () => {
  it('answers the all-pending projection and leaves NO agent-jobs.db behind', async () => {
    const harness = createHarness()

    const status = await harness.status()

    expect(status).toEqual({
      runId: RUN_ID,
      chips: { analysis: 'pending', curation: 'pending' },
    })
    // The assertion that matters is this one, and it is on the FILESYSTEM rather than on the
    // answer: a read routed through `host.jobs()` returns exactly the same projection while
    // bringing a queue database into existence in a project that has never enqueued anything.
    // Only the disk can tell those two implementations apart.
    expect(existsSync(join(harness.agentQaRoot, AGENT_JOB_STORE_DB_FILE))).toBe(false)
    expect(existsSync(join(harness.agentQaRoot, 'agent-jobs'))).toBe(false)
  })

  it('still creates nothing when asked repeatedly', async () => {
    const harness = createHarness()

    await harness.status()
    await harness.status()
    await harness.status()

    expect(existsSync(join(harness.agentQaRoot, AGENT_JOB_STORE_DB_FILE))).toBe(false)
  })
})

describe('chip truth is read from durable rows', () => {
  it('reads a chain that was enqueued and never drained as pending, from the real row', async () => {
    const harness = createHarness()
    const jobs = await harness.host.jobs()
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(harness.agentQaRoot, handoff)

    await jobs.store.adoptEpoch(1)
    const enqueued = await jobs.queue.enqueue('analyze-run', enqueuePayload(handoff), RUN_ID)
    // The id the op will address, asserted against the id the enqueue produced: this is what
    // makes the `pending` below a fact about THAT row rather than about an absent one, which
    // the previous describe block already showed also reads `pending`.
    expect(String(enqueued.job.id))
      .toBe(String(chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE).analyzeRun))

    const status = await harness.status()

    expect(existsSync(join(harness.agentQaRoot, AGENT_JOB_STORE_DB_FILE))).toBe(true)
    expect(status.chips).toEqual({
      analysis: 'pending',
      curation: 'pending',
    })
    expect('notification' in status).toBe(false)
  })

  it('reads a completed chain as complete/complete with the notification attached', async () => {
    const harness = createHarness()
    const jobs = await harness.host.jobs()
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(harness.agentQaRoot, handoff)

    const fence = await jobs.store.adoptEpoch(1)
    await jobs.queue.enqueue('analyze-run', enqueuePayload(handoff), RUN_ID)
    await pump(jobs, fence)

    const status = await harness.status()

    expect(status.chips).toEqual({ analysis: 'complete', curation: 'complete' })
    // Compared whole with the store's own record, so a projection's plausible rebuild would fail.
    const [written] = await jobs.store.listNotifications()
    expect(status.notification).toEqual(toRunNotificationView(written!.payload))
    expect(written?.payload).toMatchObject({ outcome: 'done', stages: { analysis: { status: 'done' } } })
    expect(status.notification).toMatchObject({
      runId: RUN_ID,
      outcome: 'complete',
      stages: {
        analysis: { status: 'complete' },
        curation: { status: 'complete', curated: 2, deprecated: 1 },
      },
    })
  })

  it('reads a chain whose curation died as complete/failed', async () => {
    const agentQaRoot = mkdtempSync(join(tmpdir(), 'agent-qa-pp-status-'))
    roots.push(agentQaRoot)
    const host = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: TEST_CONFIG,
      knowledgeRoot: () => join(agentQaRoot, 'knowledge'),
      model: () => TEST_MODEL,
      clock: createSteppingClock(),
      postRun: {
        curateRun: () => Promise.reject(new Error('the knowledge root is unreachable')),
        // True of this substitute: it rejects before any candidate emission could be reached.
        candidateProse: 'masker-active',
      },
    })
    hosts.push(host)
    const jobs = await host.jobs()
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(agentQaRoot, handoff)

    const fence = await jobs.store.adoptEpoch(1)
    await jobs.queue.enqueue('analyze-run', enqueuePayload(handoff), RUN_ID)
    await pump(jobs, fence)

    const status = await invokeFunction(
      host.registry,
      RUNS_POST_PROCESSING_FUNCTION_ID,
      { runId: RUN_ID },
      CALLER,
    ) as PostProcessingStatus

    // The failure is reported per STAGE: a chip set that collapsed to one outcome would say
    // the analysis failed too, and the analysis is exactly the artifact that survived.
    expect(status.chips).toEqual({ analysis: 'complete', curation: 'failed' })
    expect(status.notification).toMatchObject({ outcome: 'failed' })
  })

  it('answers about the run it was ASKED about, not about whichever chain the store holds', async () => {
    const harness = createHarness()
    const jobs = await harness.host.jobs()
    const handoff = fixtureHandoff(RUN_ID)
    writeHandoff(harness.agentQaRoot, handoff)

    const fence = await jobs.store.adoptEpoch(1)
    await jobs.queue.enqueue('analyze-run', enqueuePayload(handoff), RUN_ID)
    await pump(jobs, fence)

    // A neighbour run in the SAME database, finished, with rows under other ids. A projection
    // that read "the chain" rather than "this run's chain" would report it as this one's.
    const other = await invokeFunction(
      harness.host.registry,
      RUNS_POST_PROCESSING_FUNCTION_ID,
      { runId: 'run-388-someone-else' },
      CALLER,
    ) as PostProcessingStatus

    expect(other.chips).toEqual({
      analysis: 'pending',
      curation: 'pending',
    })
    expect('notification' in other).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------
// The STORED-ROW cell.
//
// Every cell above writes its notification with THIS build's writer, so together they measure
// this build talking to itself. The only thing standing between bytes another build wrote and a
// surface is `guardRunNotification`, reached through the op. Pinning the refusal at the guard
// alone would leave the WIRING free: a reader that stopped calling the guard, or an op that read
// the column some other way, passes every guard-level cell in `schema` and hands a stale record
// straight to a renderer.
// ------------------------------------------------------------------------------------------

describe('a row another build wrote is refused, through the op', () => {
  it('refuses a stored schemaVersion-1 notification by name',
    async () => {
      const harness = createHarness()
      const jobs = await harness.host.jobs()
      const handoff = fixtureHandoff(RUN_ID)
      writeHandoff(harness.agentQaRoot, handoff)

      const fence = await jobs.store.adoptEpoch(1)
      await jobs.queue.enqueue('analyze-run', enqueuePayload(handoff), RUN_ID)
      await pump(jobs, fence)
      // The store is closed before the column is rewritten: the point is bytes at rest that this
      // process did not author, and a live handle would leave the row half this build's.
      await harness.host.close()
      hosts.splice(hosts.indexOf(harness.host), 1)

      // Written by hand because no build in this tree produces it: three stages, the third a
      // structural placeholder, stamped schemaVersion: 1.
      const legacyPayload = {
        schemaVersion: 1,
        runId: RUN_ID,
        outcome: 'done',
        verdictSummary: { total: 2, byClass: { timeout: 1, unknown: 1 } },
        stages: {
          analysis: { status: 'done' },
          curation: { status: 'done', curated: 2, deprecated: 1 },
          issues: { status: 'reserved' },
        },
      }
      const dbPath = join(harness.agentQaRoot, AGENT_JOB_STORE_DB_FILE)
      const db = new DatabaseSync(dbPath)
      try {
        // Asserted rather than assumed: an UPDATE that matched no row would leave this build's
        // own record in place and make every claim below vacuous.
        const updated = db
          .prepare('UPDATE notifications SET payload = ? WHERE run_id = ?')
          .run(JSON.stringify(legacyPayload), RUN_ID)
        expect(Number(updated.changes)).toBe(1)
      } finally {
        db.close()
      }

      // A COLD host — nothing of the process that wrote the rows survives into this read.
      const cold = composeLocalAgent({
        mask: (text) => text,
        mintQuarantineIdentityPath: MINT_IDENTITY,
        agentQaRoot: harness.agentQaRoot,
        config: TEST_CONFIG,
        knowledgeRoot: () => join(harness.agentQaRoot, 'knowledge'),
        model: () => TEST_MODEL,
        clock: createSteppingClock(),
        postRun: {
          curateRun: async () => ({ curated: 2, deprecated: 1, complete: true }),
          candidateProse: 'masker-active',
        },
      })
      hosts.push(cold)
      await expect(
        invokeFunction(cold.registry, RUNS_POST_PROCESSING_FUNCTION_ID, { runId: RUN_ID }, CALLER),
      ).rejects.toThrow(/declares schemaVersion 1, and this build reads 2\./u)
    })
})
