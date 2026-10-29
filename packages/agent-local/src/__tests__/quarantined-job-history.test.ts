// Each read through the diagnostic path is paired with a control that must still succeed.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { QuarantinedJobRequeueError } from '@vostride/agent-qa-agent'
import type { ClockPort, JobModelCapability, JobStoreFence } from '@vostride/agent-qa-agent'
import { asJobId, sha256hex16 } from '@vostride/agent-qa-schema'
import type { JobId, JobKind } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeJobRecovery } from '../composition/compose-job-recovery.js'
import { AGENT_JOB_STORE_DB_FILE } from '../store/sqlite-job-store.js'

// A kind no current vocabulary contains.
const RETIRED_KIND = 'retired-kind-fixture'

/** The one kind these cells drain. Single checkpoint, no successors, so a drain is one row. */
const VALID_KIND: JobKind = 'consolidate'

const EPOCH = 1

const CLOCK: ClockPort = { now: () => '2026-01-01T00:00:00.000Z' }

const ID_SOURCE = {
  jobIdFor: (kind: JobKind, idempotencyKey: string): JobId =>
    asJobId(`job_${sha256hex16(`${kind} ${idempotencyKey}`)}`),
}

const NEVER_AUTHORS: JobModelCapability = {
  modelId: 'test:none',
  generate: () => Promise.reject(new Error('the stand-in never authors')),
}

let roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-422-10-history-'))
  roots.push(root)
  return join(root, '.agent-qa')
}

function host(agentQaRoot: string): ReturnType<typeof composeJobRecovery> {
  return composeJobRecovery({
    agentQaRoot,
    clock: CLOCK,
    idSource: ID_SOURCE,
    model: NEVER_AUTHORS,
  })
}

async function enqueueValid(agentQaRoot: string, key: string): Promise<string> {
  const open = host(agentQaRoot)
  try {
    const outcome = await open.store.enqueue({
      id: ID_SOURCE.jobIdFor(VALID_KIND, key),
      kind: VALID_KIND,
      idempotencyKey: key,
      summary: `agent job ${VALID_KIND} (${key})`,
      payload: { note: 'a row this build reads' },
    })
    return String(outcome.job.id)
  } finally {
    open.close()
  }
}

/**
 * Write a row under a kind this build does not read, the way the build that retired it would have.
 *
 * Raw SQL because `enqueue` parses what it inserted before returning it: the store cannot produce
 * this row, and a fake that could would not be the row under test.
 */
function seedRetired(agentQaRoot: string, id: string, payload: unknown, createdAt: string): void {
  const db = new DatabaseSync(join(agentQaRoot, AGENT_JOB_STORE_DB_FILE))
  try {
    db.prepare(
      `INSERT INTO jobs
         (id, kind, idempotency_key, status, summary, payload, attempts, claimed_at,
          created_at, updated_at, last_failure_kind, last_failure_reason, cancel_requested_at)
       VALUES (?, ?, ?, 'queued', ?, ?, 0, NULL, ?, ?, NULL, NULL, NULL)`,
    ).run(id, RETIRED_KIND, `retired-${id}`, `agent job ${RETIRED_KIND}`,
      JSON.stringify(payload), createdAt, createdAt)
  } finally {
    db.close()
  }
}

interface SeededQueue {
  readonly agentQaRoot: string
  readonly retiredId: string
  readonly validId: string
}

/** Seed one poisoned head and one valid follower, drain once, and hand back the ids. */
async function quarantinedQueue(): Promise<SeededQueue> {
  const agentQaRoot = makeRoot()
  const validId = await enqueueValid(agentQaRoot, 'first')
  seedRetired(agentQaRoot, 'job_retired_head', { runId: 'r_retired', secret: 'never-printed' },
    '2025-12-31T23:59:58.000Z')

  const open = host(agentQaRoot)
  try {
    const fence = await open.store.adoptEpoch(EPOCH)
    const outcomes = await open.resumePending(fence)
    // Non-vacuity: every cell below describes a queue whose valid row really did run. A drain
    // that ran nothing would satisfy "nothing was corrupted" by having touched nothing.
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ ran: true, job: { id: validId, kind: VALID_KIND } })
  } finally {
    open.close()
  }
  return { agentQaRoot, retiredId: 'job_retired_head', validId }
}

async function withFence<T>(
  agentQaRoot: string,
  body: (open: ReturnType<typeof composeJobRecovery>, fence: JobStoreFence) => Promise<T>,
): Promise<T> {
  const open = host(agentQaRoot)
  try {
    return await body(open, await open.store.adoptEpoch(EPOCH))
  } finally {
    open.close()
  }
}

beforeEach(() => {
  roots = []
})

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('the diagnostic projection of a quarantined row', () => {
  it('reports the original retired kind, the unreadable-kind conclusion and the spent attempt', async () => {
    const seeded = await quarantinedQueue()

    const dump = await withFence(seeded.agentQaRoot, async (open) => open.store.dumpState())

    const quarantined = dump.jobs.find((row) => row.id === seeded.retiredId)
    expect(quarantined).toBeDefined()
    // THE ORIGINAL KIND, verbatim. The projection names the column rather than a parsed `JobKind`,
    // which is what lets the row that cannot be parsed still be described.
    expect(quarantined).toMatchObject({
      kind: RETIRED_KIND,
      status: 'failed',
      attempts: 1,
      claimed: false,
      conclusionKind: 'unreadable_kind',
    })
    // And the payload bytes are still there — the landing is a conclusion, not an erasure.
    expect(quarantined?.payload).toEqual({ runId: 'r_retired', secret: 'never-printed' })
  })

  it('leaves a readable row with no conclusion at all — the control for the cell above', async () => {
    const seeded = await quarantinedQueue()

    const dump = await withFence(seeded.agentQaRoot, async (open) => open.store.dumpState())

    const readable = dump.jobs.find((row) => row.id === seeded.validId)
    expect(readable).toMatchObject({ kind: VALID_KIND, status: 'done', attempts: 1 })
    // A projection that stamped every row would make the assertion above vacuous.
    expect(readable?.conclusionKind).toBeUndefined()
    expect(Object.keys(readable ?? {})).not.toContain('conclusionKind')
  })

  it('reports no conclusion for a retired-kind row that has not been quarantined yet', async () => {
    const agentQaRoot = makeRoot()
    await enqueueValid(agentQaRoot, 'first')
    seedRetired(agentQaRoot, 'job_retired_queued', { runId: 'r_q' }, '2025-12-31T23:59:58.000Z')

    const dump = await withFence(agentQaRoot, async (open) => open.store.dumpState())

    // Still queued, never claimed: the conclusion names an event, and that event has not happened.
    // Deriving it from the unreadable kind ALONE would publish a receipt for a landing nobody made.
    const pending = dump.jobs.find((row) => row.id === 'job_retired_queued')
    expect(pending).toMatchObject({ kind: RETIRED_KIND, status: 'queued', attempts: 0 })
    expect(pending?.conclusionKind).toBeUndefined()
  })
})

describe('requeueing a quarantined row', () => {
  it('refuses by name and leaves every column of the history exactly as it found it', async () => {
    const seeded = await quarantinedQueue()

    const before = await withFence(seeded.agentQaRoot, async (open) => open.store.dumpLogicalState())

    await withFence(seeded.agentQaRoot, async (open, fence) => {
      await expect(
        open.store.requeueTerminal(asJobId(seeded.retiredId), fence),
      ).rejects.toBeInstanceOf(QuarantinedJobRequeueError)
    })

    // The refusal lands before any reset or delete, so the whole logical dump is the assertion.
    const after = await withFence(seeded.agentQaRoot, async (open) => open.store.dumpLogicalState())
    expect(after).toBe(before)
  })

  it('still requeues an ordinary terminal row — the control for the refusal above', async () => {
    const seeded = await quarantinedQueue()

    await withFence(seeded.agentQaRoot, async (open, fence) => {
      expect(await open.store.requeueTerminal(asJobId(seeded.validId), fence)).toEqual({
        outcome: 'requeued',
      })
    })

    const dump = await withFence(seeded.agentQaRoot, async (open) => open.store.dumpState())
    expect(dump.jobs.find((row) => row.id === seeded.validId)).toMatchObject({
      status: 'queued',
      attempts: 0,
    })
  })

  it('drains subsequent valid work after the refusal, across a reopen', async () => {
    const seeded = await quarantinedQueue()

    await withFence(seeded.agentQaRoot, async (open, fence) => {
      await expect(
        open.store.requeueTerminal(asJobId(seeded.retiredId), fence),
      ).rejects.toBeInstanceOf(QuarantinedJobRequeueError)
    })

    // A NEW row, enqueued after the refusal and drained by a NEW host: a refusal that wedged the
    // queue would look identical to one that did not, until something else had to get through.
    const nextId = await enqueueValid(seeded.agentQaRoot, 'second')
    const outcomes = await withFence(seeded.agentQaRoot, async (open, fence) =>
      open.resumePending(fence),
    )
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ ran: true, job: { id: nextId, kind: VALID_KIND } })

    // And the quarantined row was NOT re-offered by that drain: its attempt is still the one it
    // spent, and its conclusion is unchanged.
    const dump = await withFence(seeded.agentQaRoot, async (open) => open.store.dumpState())
    expect(dump.jobs.find((row) => row.id === seeded.retiredId)).toMatchObject({
      kind: RETIRED_KIND,
      status: 'failed',
      attempts: 1,
      conclusionKind: 'unreadable_kind',
    })
  })
})
