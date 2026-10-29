// The store's own guarantees, asserted against real sqlite (Phase 385 plan 03).
//
// Everything here drives `JobStorePort` directly rather than through the engine. That is
// deliberate: D-02 says any process may open this database and write to it, so the store is
// the boundary where dedupe, claim order, version drift and authority are guaranteed — and a
// guarantee that only holds when the engine is the caller is not a store guarantee at all.
//
// Each refusal is paired with a control that must still SUCCEED. "A stale epoch throws" is
// satisfied perfectly by a verb that throws unconditionally, and "a mismatched version
// throws" by a store that refuses every open; the paired success is the only thing that
// separates the two.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  createAgentJobQueue,
  createJobKindRegistry,
  JobCancellationNotRequestedError,
  MissingIdempotencyKeyError,
  StaleJobStoreEpochError,
} from '@vostride/agent-qa-agent'
import type {
  ClockPort,
  JobCheckpointRecord,
  JobIdSource,
  JobInsert,
  JobModelCapability,
  JobStoreFence,
} from '@vostride/agent-qa-agent'
import {
  asJobId,
  canonicalJson,
  CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
  sha256hex,
} from '@vostride/agent-qa-schema'
import type { RunNotification } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createJobCheckpointStore } from '../store/job-checkpoint-store.js'
import { orderedSelectSql } from '../store/logical-dump.js'
import {
  AGENT_JOB_STORE_DB_FILE,
  AGENT_JOB_STORE_USER_VERSION,
  createSqliteJobStore,
} from '../store/sqlite-job-store.js'
import type { SqliteJobStore } from '../store/sqlite-job-store.js'
import { JobStoreSchemaVersionError, UnknownJobRowError } from '../store/store-errors.js'

const KIND = 'analyze-run' as const

function steppingClock(): ClockPort {
  let tick = 0
  return {
    now() {
      const stamp = `2026-01-01T00:00:${String(tick).padStart(2, '0')}.000Z`
      tick += 1
      return stamp
    },
  }
}

function frozenClock(): ClockPort {
  return { now: () => '2026-01-01T00:00:00.000Z' }
}

function insert(id: string, idempotencyKey: string, payload: unknown = { n: 1 }): JobInsert {
  return {
    id: asJobId(id),
    kind: KIND,
    idempotencyKey,
    summary: `agent job ${KIND} (${idempotencyKey})`,
    payload,
  }
}

function checkpointRecord(
  jobId: JobCheckpointRecord['jobId'],
  checkpointId: string,
  value: unknown,
): JobCheckpointRecord {
  return {
    checkpointId,
    jobId,
    attempt: 1,
    recordedAt: '2026-01-01T00:00:00.000Z',
    value,
  }
}

interface SqliteJobStoreTestHooks {
  readonly beforeCheckpointFilePublish?: () => void
}

/**
 * A `RunNotification` shaped exactly as `buildChainTerminalNotification` shapes one.
 *
 * Written out here rather than imported because the store is the boundary under test and it
 * receives this record as OPAQUE bytes from the engine: a fixture built by the builder would
 * assert the store against the same code that produced the input. The guard on the way back out
 * of `listNotifications` is what pins the shape.
 */
function notification(runId: string, outcome: 'done' | 'failed'): RunNotification {
  const status = outcome === 'done' ? ('done' as const) : ('failed' as const)
  return {
    schemaVersion: CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
    runId,
    outcome,
    verdictSummary: { total: 0, byClass: {} },
    stages: { analysis: { status }, curation: { status } },
  }
}

function openStore(
  root: string,
  clock: ClockPort = steppingClock(),
  hooks?: SqliteJobStoreTestHooks,
): SqliteJobStore {
  return createSqliteJobStore({
    path: join(root, AGENT_JOB_STORE_DB_FILE),
    clock,
    checkpoints: createJobCheckpointStore({ root }),
    ...(hooks === undefined ? {} : { hooks }),
  } as Parameters<typeof createSqliteJobStore>[0] & { hooks?: SqliteJobStoreTestHooks })
}

/** Read the physical insertion order, which no port verb exposes and none should. */
function rowIdOrder(root: string): string[] {
  const db = new DatabaseSync(join(root, AGENT_JOB_STORE_DB_FILE))
  try {
    return db
      .prepare('SELECT id FROM jobs ORDER BY rowid ASC')
      .all()
      .map((row) => String(row.id))
  } finally {
    db.close()
  }
}

function rawRow(root: string, id: string): Record<string, unknown> | undefined {
  const db = new DatabaseSync(join(root, AGENT_JOB_STORE_DB_FILE))
  try {
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
  } finally {
    db.close()
  }
}

function rawCheckpointRows(root: string): Record<string, unknown>[] {
  const db = new DatabaseSync(join(root, AGENT_JOB_STORE_DB_FILE))
  try {
    return db
      .prepare('SELECT * FROM job_checkpoints ORDER BY job_id, attempt, checkpoint_id')
      .all()
  } finally {
    db.close()
  }
}

describe('agent job store: schema version', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-version-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('opens a database it created itself', () => {
    const store = openStore(root)
    try {
      expect(AGENT_JOB_STORE_USER_VERSION).toBe(2)
    } finally {
      store.close()
    }
  })

  // NEGATIVE CONTROL for the refusal below: a store that threw on every open would satisfy
  // "a mismatched version throws" and nothing else here would notice.
  it('reopens a database stamped at the version this build reads, with its rows intact', async () => {
    const first = openStore(root)
    await first.enqueue(insert('job_a', 'key-a'))
    first.close()

    const second = openStore(root)
    try {
      expect((await second.dumpState()).jobs).toHaveLength(1)
    } finally {
      second.close()
    }
  })

  it.each([1, 3, 4, 5, 7])(
    'refuses a database stamped %i by name before any DDL and leaves it as found',
    async (stamp) => {
      const first = openStore(root)
      await first.enqueue(insert('job_a', 'key-a'))
      first.close()

      const path = join(root, AGENT_JOB_STORE_DB_FILE)
      const raw = new DatabaseSync(path)
      raw.exec(`PRAGMA user_version=${stamp}`)
      raw.close()
      const before = readFileSync(path)

      let thrown: unknown
      try {
        openStore(root)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(JobStoreSchemaVersionError)
      expect((thrown as JobStoreSchemaVersionError).observedVersion).toBe(stamp)
      expect((thrown as JobStoreSchemaVersionError).expectedVersion).toBe(
        AGENT_JOB_STORE_USER_VERSION,
      )
      // Three queues coexist, so a remedy that only says "clear queue state" would not say which.
      expect((thrown as Error).message).toContain('clear agent job queue state')
      expect(readFileSync(path).equals(before)).toBe(true)
    },
  )
})

describe('agent job store: dedupe', () => {
  let root: string
  let store: SqliteJobStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-dedupe-'))
    store = openStore(root)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('merges a second enqueue of the same (kind, key) into the first row', async () => {
    const first = await store.enqueue(insert('job_a', 'key-a'))
    const second = await store.enqueue(insert('job_a', 'key-a', { n: 2 }))

    expect(second.deduped).toBe(true)
    expect(String(second.job.id)).toBe(String(first.job.id))
    expect((await store.dumpState()).jobs).toHaveLength(1)
    // The pre-existing row is what comes back, payload and all — a dedupe that overwrote the
    // first payload would make "running the tail twice" quietly change the queued work.
    expect((await store.dumpState()).jobs[0]?.payload).toEqual({ n: 1 })
  })

  // NEGATIVE CONTROL: "a duplicate yields one row" is satisfied by an enqueue that drops
  // every second call regardless of key. This is the case that separates them.
  it('keeps two enqueues with different keys as two rows', async () => {
    await store.enqueue(insert('job_a', 'key-a'))
    const second = await store.enqueue(insert('job_b', 'key-b'))

    expect(second.deduped).toBe(false)
    expect((await store.dumpState()).jobs).toHaveLength(2)
  })

  it('refuses an empty idempotency key at the store boundary, writing nothing', async () => {
    await expect(store.enqueue(insert('job_a', ''))).rejects.toBeInstanceOf(
      MissingIdempotencyKeyError,
    )
    await expect(store.enqueue(insert('job_a', '   '))).rejects.toBeInstanceOf(
      MissingIdempotencyKeyError,
    )

    expect((await store.dumpState()).jobs).toHaveLength(0)
  })
})

describe('agent job store: claim order', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-claim-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('claims jobs sharing a timestamp in ascending id order, not insertion order', async () => {
    const store = openStore(root, frozenClock())
    try {
      const fence = await store.adoptEpoch(1)
      // Inserted deliberately out of id order, so an implementation that leaned on the
      // physical row order would hand back `job_ccc` first.
      for (const id of ['job_ccc', 'job_aaa', 'job_bbb']) {
        await store.enqueue(insert(id, id))
      }
      expect(rowIdOrder(root)).toEqual(['job_ccc', 'job_aaa', 'job_bbb'])

      const claimed: string[] = []
      for (let i = 0; i < 3; i += 1) {
        const outcome = await store.claimNext(fence)
        if (!outcome.claimed) throw new Error('queue drained early')
        claimed.push(String(outcome.job.id))
      }

      expect(claimed).toEqual(['job_aaa', 'job_bbb', 'job_ccc'])
    } finally {
      store.close()
    }
  })

  // The companion control: id is the TIEBREAK, not the ordering. A store ordered by id alone
  // would pass the case above and fail this one, and would then claim a job enqueued an hour
  // later ahead of one that has been waiting.
  it('claims the older job first even when its id sorts last', async () => {
    const store = openStore(root)
    try {
      const fence = await store.adoptEpoch(1)
      await store.enqueue(insert('job_zzz', 'key-z'))
      await store.enqueue(insert('job_aaa', 'key-a'))

      const first = await store.claimNext(fence)
      expect(first.claimed && String(first.job.id)).toBe('job_zzz')
    } finally {
      store.close()
    }
  })
})

describe('agent job store: claim exclusion', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-exclusion-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function mixedInsert(id: string, kind: 'curate-memory' | 'analyze-run'): JobInsert {
    return {
      id: asJobId(id),
      kind,
      idempotencyKey: id,
      summary: `agent job ${kind} (${id})`,
      payload: { n: 1 },
    }
  }

  /** Oldest claimable row is curate-memory; the next-oldest is analyze-run. */
  async function seedMixedQueue(store: SqliteJobStore): Promise<JobStoreFence> {
    await store.enqueue(mixedInsert('job_curate', 'curate-memory'))
    await store.enqueue(mixedInsert('job_analyze', 'analyze-run'))
    return store.adoptEpoch(1)
  }

  it('skips an excluded kind and offers the next eligible row, not no-job', async () => {
    const store = openStore(root)
    try {
      const fence = await seedMixedQueue(store)
      const outcome = await store.claimNext(fence, { excludeKinds: ['curate-memory'] })
      if (!outcome.claimed) throw new Error('exclusion answered no-job over a claimable row')
      expect(String(outcome.job.id)).toBe('job_analyze')
      expect(outcome.job.kind).toBe('analyze-run')
    } finally {
      store.close()
    }
  })

  it('leaves the skipped row exactly as it was found: queued, unclaimed, attempts 0', async () => {
    const store = openStore(root)
    try {
      const fence = await seedMixedQueue(store)
      await store.claimNext(fence, { excludeKinds: ['curate-memory'] })
      const dump = await store.dumpState()
      expect(dump.jobs.find((row) => row.id === 'job_curate')).toMatchObject({
        status: 'queued',
        claimed: false,
        attempts: 0,
      })
      expect(rawRow(root, 'job_curate')?.claimed_at).toBeNull()
    } finally {
      store.close()
    }
  })

  it('claims that same row with no options: the exclusion is the only input the skip turns on', async () => {
    const store = openStore(root)
    try {
      const fence = await seedMixedQueue(store)
      const outcome = await store.claimNext(fence)
      if (!outcome.claimed) throw new Error('control claim answered no-job')
      expect(String(outcome.job.id)).toBe('job_curate')
      expect(outcome.job.kind).toBe('curate-memory')
      expect(outcome.job.attempts).toBe(1)
    } finally {
      store.close()
    }
  })

  it('answers {claimed: false} when every claimable row is excluded — never a throw', async () => {
    const store = openStore(root)
    try {
      const fence = await seedMixedQueue(store)
      const outcome = await store.claimNext(fence, {
        excludeKinds: ['curate-memory', 'analyze-run'],
      })
      expect(outcome).toEqual({ claimed: false })
    } finally {
      store.close()
    }
  })
})

describe('agent job store: completeAndChain ordering', () => {
  let root: string
  let store: SqliteJobStore
  let fence: JobStoreFence

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-chain-'))
    store = openStore(root)
    fence = await store.adoptEpoch(1)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('inserts successors in the order the handler returned them', async () => {
    const root_ = await store.enqueue(insert('job_root', 'key-root'))
    await store.claimNext(fence)

    const outcome = await store.completeAndChain(
      root_.job.id,
      [insert('job_first', 'key-first'), insert('job_second', 'key-second')],
      fence,
    )

    expect(outcome.job.status).toBe('done')
    expect(outcome.chained.map((entry) => String(entry.job.id))).toEqual([
      'job_first',
      'job_second',
    ])
    // Physical order, read outside the store: the returned array could be in handler order
    // while the writes went out reversed, and only the rows can tell.
    expect(rowIdOrder(root)).toEqual(['job_root', 'job_first', 'job_second'])
  })

  it('rolls the whole chain back when one successor insert fails', async () => {
    const root_ = await store.enqueue(insert('job_root', 'key-root'))
    await store.enqueue(insert('job_taken', 'key-taken'))
    await store.claimNext(fence)

    await expect(
      store.completeAndChain(
        root_.job.id,
        // The second successor collides on the primary key while presenting a fresh
        // (kind, key) pair, so the dedupe clause cannot absorb it and the statement raises.
        [insert('job_ok', 'key-ok'), insert('job_taken', 'key-other')],
        fence,
      ),
    ).rejects.toThrow()

    const dump = await store.dumpState()
    expect(dump.jobs.map((job) => job.id).sort()).toEqual(['job_root', 'job_taken'])
    // The predecessor did not complete either — a partial chain with a completed root is the
    // state nothing downstream would ever notice was wrong.
    expect(dump.jobs.find((job) => job.id === 'job_root')?.status).toBe('queued')
  })
})

describe('agent job store: recordFailure (ledger 1)', () => {
  let root: string
  let store: SqliteJobStore
  let fence: JobStoreFence

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-failure-'))
    store = openStore(root)
    fence = await store.adoptEpoch(1)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  async function claimOne(): Promise<string> {
    const enqueued = await store.enqueue(insert('job_a', 'key-a'))
    const claim = await store.claimNext(fence)
    expect(claim.claimed).toBe(true)
    return String(enqueued.job.id)
  }

  it('returns a retryable job to the queue with its claim released', async () => {
    const id = await claimOne()

    await store.recordFailure(asJobId(id), { kind: 'retry', reason: 'provider timed out' }, fence)

    const dump = await store.dumpState()
    expect(dump.jobs[0]).toMatchObject({ status: 'queued', claimed: false, attempts: 1 })

    // Claimable again, and the attempt counter moves again — D-18's bound is spent at the
    // claim, so a job that keeps failing keeps consuming it.
    const reclaim = await store.claimNext(fence)
    expect(reclaim.claimed).toBe(true)
    expect(reclaim.claimed && reclaim.job.attempts).toBe(2)
  })

  it('lands a permanent failure in the terminal failed status, unclaimable', async () => {
    const id = await claimOne()

    await store.recordFailure(asJobId(id), { kind: 'permanent', reason: 'bad payload' }, fence)

    const dump = await store.dumpState()
    expect(dump.jobs[0]).toMatchObject({ status: 'failed', claimed: false })
    expect(await store.claimNext(fence)).toEqual({ claimed: false })
  })

  // NEGATIVE CONTROL for both cases above. A `recordFailure` that ignored its disposition
  // argument entirely — releasing the claim and nothing else — passes the retry case on its
  // own. Two stores driven through the IDENTICAL history except for the disposition must end
  // in different states, and the comparison is made from the same starting point so that a
  // difference cannot come from anywhere but the argument.
  it('reaches a different state for each disposition, from identical histories', async () => {
    async function stateAfter(kind: 'retry' | 'permanent'): Promise<string> {
      const isolated = mkdtempSync(join(tmpdir(), 'agent-qa-job-disposition-'))
      const other = openStore(isolated)
      try {
        const otherFence = await other.adoptEpoch(1)
        const enqueued = await other.enqueue(insert('job_a', 'key-a'))
        await other.claimNext(otherFence)
        await other.recordFailure(enqueued.job.id, { kind, reason: 'same reason' }, otherFence)
        return JSON.stringify(await other.dumpState())
      } finally {
        other.close()
        rmSync(isolated, { recursive: true, force: true })
      }
    }

    expect(await stateAfter('retry')).not.toBe(await stateAfter('permanent'))
  })

  it('records the reason the caller gave, not a placeholder', async () => {
    const id = await claimOne()
    await store.recordFailure(
      asJobId(id),
      { kind: 'permanent', reason: 'model refused the request' },
      fence,
    )

    expect(rawRow(root, id)).toMatchObject({
      last_failure_kind: 'permanent',
      last_failure_reason: 'model refused the request',
    })
  })
})

describe('agent job store: failAndChain atomicity', () => {
  let root: string
  let store: SqliteJobStore
  let fence: JobStoreFence

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-fail-chain-'))
    store = openStore(root)
    fence = await store.adoptEpoch(1)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  async function claimHead(): Promise<void> {
    await store.enqueue(insert('job_root', 'key-root'))
    const claim = await store.claimNext(fence)
    expect(claim.claimed).toBe(true)
  }

  it('refuses a stale fence before changing the parent or inserting any continuation', async () => {
    await claimHead()
    const current = await store.adoptEpoch(2)
    const parentBefore = rawRow(root, 'job_root')

    await expect(
      store.failAndChain(
        asJobId('job_root'),
        { kind: 'permanent', reason: 'stale host gave up' },
        [insert('job_first', 'key-first'), insert('job_second', 'key-second')],
        fence,
      ),
    ).rejects.toBeInstanceOf(StaleJobStoreEpochError)

    expect(rawRow(root, 'job_root')).toEqual(parentBefore)
    expect((await store.dumpState()).jobs.map((row) => row.id)).toEqual(['job_root'])

    await expect(
      store.failAndChain(
        asJobId('job_root'),
        { kind: 'permanent', reason: 'current host gave up' },
        [insert('job_first', 'key-first'), insert('job_second', 'key-second')],
        current,
      ),
    ).resolves.toMatchObject({ chained: [{ deduped: false }, { deduped: false }] })
  })

  it('publishes the terminal parent and the complete continuation set as one fact', async () => {
    await claimHead()

    const outcome = await store.failAndChain(
      asJobId('job_root'),
      { kind: 'permanent', reason: 'dead head' },
      [insert('job_first', 'key-first'), insert('job_second', 'key-second')],
      fence,
    )

    expect(outcome.job.status).toBe('failed')
    expect(outcome.chained.map((entry) => String(entry.job.id))).toEqual([
      'job_first',
      'job_second',
    ])
    expect(rawRow(root, 'job_root')).toMatchObject({
      status: 'failed',
      claimed_at: null,
      last_failure_kind: 'permanent',
      last_failure_reason: 'dead head',
    })
    expect((await store.dumpState()).jobs.map((row) => row.id).sort()).toEqual([
      'job_first',
      'job_root',
      'job_second',
    ])
  })

  it('rolls back the parent transition and every earlier insert when a successor fails', async () => {
    await store.enqueue(insert('job_taken', 'key-taken'))
    await claimHead()
    const parentBefore = rawRow(root, 'job_root')

    await expect(
      store.failAndChain(
        asJobId('job_root'),
        { kind: 'permanent', reason: 'must roll back' },
        [
          insert('job_ok', 'key-ok'),
          // Fresh dedupe key plus an occupied primary id forces the second INSERT to fail
          // after the parent transition and first successor have both executed.
          insert('job_taken', 'key-other'),
        ],
        fence,
      ),
    ).rejects.toThrow()

    expect(rawRow(root, 'job_root')).toEqual(parentBefore)
    expect((await store.dumpState()).jobs.map((row) => row.id).sort()).toEqual([
      'job_root',
      'job_taken',
    ])
  })

  it('dedupes an identical retry without creating another continuation row', async () => {
    await claimHead()
    const successors = [insert('job_first', 'key-first'), insert('job_second', 'key-second')]

    const first = await store.failAndChain(
      asJobId('job_root'),
      { kind: 'permanent', reason: 'dead head' },
      successors,
      fence,
    )
    const replay = await store.failAndChain(
      asJobId('job_root'),
      { kind: 'permanent', reason: 'dead head' },
      successors,
      fence,
    )

    expect(first.chained.map((entry) => entry.deduped)).toEqual([false, false])
    expect(replay.chained.map((entry) => entry.deduped)).toEqual([true, true])
    expect((await store.dumpState()).jobs).toHaveLength(3)
  })
})

describe('agent job store: the deterministic logical dump', () => {
  const roots: string[] = []

  function scratchRoot(): string {
    const created = mkdtempSync(join(tmpdir(), 'agent-qa-job-dump-'))
    roots.push(created)
    return created
  }

  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
  })

  /** One history rich enough that every table and the checkpoint directory are non-empty. */
  async function drive(
    root: string,
    keys: readonly string[] = ['key-a', 'key-b', 'key-c'],
  ): Promise<void> {
    const store = openStore(root, frozenClock())
    try {
      const fence = await store.adoptEpoch(4)
      for (const key of keys) await store.enqueue(insert(`job_${key.slice(-1)}`, key))
      const claim = await store.claimNext(fence)
      if (!claim.claimed) throw new Error('nothing to claim')
      await store.publishCheckpoint(
        claim.job.id,
        'analysis',
        checkpointRecord(claim.job.id, 'analysis', { verdict: 'ok' }),
        fence,
      )
      await store.completeAndChain(claim.job.id, [], fence)
      const second = await store.claimNext(fence)
      if (!second.claimed) throw new Error('nothing to claim')
      await store.recordFailure(second.job.id, { kind: 'permanent', reason: 'nope' }, fence)
    } finally {
      store.close()
    }
  }

  async function dumpOf(root: string): Promise<string> {
    const store = openStore(root, frozenClock())
    try {
      return await store.dumpLogicalState()
    } finally {
      store.close()
    }
  }

  it('is byte-identical for two stores driven through the same history', async () => {
    const left = scratchRoot()
    const right = scratchRoot()
    await drive(left)
    await drive(right)

    expect(await dumpOf(left)).toBe(await dumpOf(right))
  })

  it('is byte-identical across a close and reopen', async () => {
    const root = scratchRoot()
    await drive(root)

    expect(await dumpOf(root)).toBe(await dumpOf(root))
  })

  // THE control that matters most. A dump that discarded its input and returned a frozen
  // constant satisfies every equality assertion above perfectly — that exact defect passed a
  // full suite in phase 384. Two different states must produce two different dumps.
  it('changes when the state changes', async () => {
    const root = scratchRoot()
    await drive(root)
    const before = await dumpOf(root)

    const store = openStore(root, frozenClock())
    try {
      await store.enqueue(insert('job_d', 'key-d'))
    } finally {
      store.close()
    }

    expect(await dumpOf(root)).not.toBe(before)
  })

  it('changes when a checkpoint file changes and nothing else does', async () => {
    const left = scratchRoot()
    const right = scratchRoot()
    await drive(left)
    await drive(right)

    const store = openStore(right, frozenClock())
    try {
      const fence = await store.adoptEpoch(4)
      await store.publishCheckpoint(
        asJobId('job_b'),
        'analysis',
        checkpointRecord(asJobId('job_b'), 'analysis', { verdict: 'other' }),
        fence,
      )
    } finally {
      store.close()
    }

    // The rows still match; only the bytes under the checkpoint root moved. A dump that
    // covered the database alone would call these two states equal.
    expect(await dumpOf(left)).not.toBe(await dumpOf(right))
  })

  it('is insensitive to the order the same rows were inserted in', async () => {
    const forwards = scratchRoot()
    const backwards = scratchRoot()

    const store = openStore(forwards, frozenClock())
    try {
      for (const key of ['key-a', 'key-b', 'key-c']) {
        await store.enqueue(insert(`job_${key.slice(-1)}`, key))
      }
    } finally {
      store.close()
    }

    const reversed = openStore(backwards, frozenClock())
    try {
      for (const key of ['key-c', 'key-b', 'key-a']) {
        await reversed.enqueue(insert(`job_${key.slice(-1)}`, key))
      }
    } finally {
      reversed.close()
    }

    expect(rowIdOrder(forwards)).not.toEqual(rowIdOrder(backwards))
    expect(await dumpOf(forwards)).toBe(await dumpOf(backwards))
  })

  it('states an explicit order for every table it reads', async () => {
    const root = scratchRoot()
    await drive(root)

    const store = openStore(root, frozenClock())
    try {
      const dump = await store.logicalDump()
      // Enumerated from the catalogue, so a table added later is COVERED without an edit —
      // and named here, so adding one is a visible edit rather than a silent widening of what
      // the D-03 comparison is willing to call equal. 388's notifications table arrived
      // exactly that way: it needed no dump code at all, and it needed this line.
      expect(dump.tables.map((table) => table.table)).toEqual([
        'job_checkpoints',
        'job_store_fence',
        'jobs',
        'notifications',
      ])
      for (const table of dump.tables) {
        expect(table.orderBy.length).toBeGreaterThan(0)
        expect(orderedSelectSql(table.table, table.orderBy)).toContain('ORDER BY')
      }
      expect(dump.checkpoints.map((entry) => entry.path)).toEqual(['job_a/analysis.json'])
      expect(dump.checkpoints[0]?.digest).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      store.close()
    }
  })

  it('agrees with the typed dump about which rows exist and in what order', async () => {
    const root = scratchRoot()
    await drive(root)

    const store = openStore(root, frozenClock())
    try {
      const logical = await store.logicalDump()
      const jobs = logical.tables.find((table) => table.table === 'jobs')
      expect(jobs?.rows.map((row) => String(row.id))).toEqual(
        (await store.dumpState()).jobs.map((job) => job.id),
      )
    } finally {
      store.close()
    }
  })

  it('refuses to build a SELECT around an identifier it cannot quote safely', () => {
    expect(() => orderedSelectSql('jobs; DROP TABLE jobs', ['id'])).toThrow(TypeError)
    expect(() => orderedSelectSql('jobs', ['id"'])).toThrow(TypeError)
  })
})

describe('agent job store: the stale-epoch refusal matrix', () => {
  let root: string
  let store: SqliteJobStore
  let stale: JobStoreFence
  let current: JobStoreFence

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-fence-'))
    store = openStore(root)
    stale = await store.adoptEpoch(1)
    await store.enqueue(insert('job_a', 'key-a'))
    current = await store.adoptEpoch(2)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses claimNext, and the current holder can still claim', async () => {
    const before = JSON.stringify(await store.dumpState())

    await expect(store.claimNext(stale)).rejects.toBeInstanceOf(StaleJobStoreEpochError)
    expect(JSON.stringify(await store.dumpState())).toBe(before)

    const claim = await store.claimNext(current)
    expect(claim.claimed).toBe(true)
  })

  it('refuses completeAndChain, and the current holder can still complete', async () => {
    await store.claimNext(current)
    const before = JSON.stringify(await store.dumpState())

    await expect(
      store.completeAndChain(asJobId('job_a'), [insert('job_b', 'key-b')], stale),
    ).rejects.toBeInstanceOf(StaleJobStoreEpochError)
    expect(JSON.stringify(await store.dumpState())).toBe(before)

    const completed = await store.completeAndChain(
      asJobId('job_a'),
      [insert('job_b', 'key-b')],
      current,
    )
    expect(completed.job.status).toBe('done')
  })

  it('refuses recordFailure, and the current holder can still record one', async () => {
    await store.claimNext(current)
    const before = JSON.stringify(await store.dumpState())

    await expect(
      store.recordFailure(asJobId('job_a'), { kind: 'permanent', reason: 'x' }, stale),
    ).rejects.toBeInstanceOf(StaleJobStoreEpochError)
    expect(JSON.stringify(await store.dumpState())).toBe(before)

    await store.recordFailure(asJobId('job_a'), { kind: 'permanent', reason: 'x' }, current)
    expect((await store.dumpState()).jobs[0]?.status).toBe('failed')
  })

  it('refuses publishCheckpoint, writing no file, and the current holder can still publish', async () => {
    await store.claimNext(current)
    const before = JSON.stringify(await store.dumpState())
    const record = checkpointRecord(asJobId('job_a'), 'analysis', { v: 1 })

    await expect(
      store.publishCheckpoint(asJobId('job_a'), 'analysis', record, stale),
    ).rejects.toBeInstanceOf(StaleJobStoreEpochError)
    expect(JSON.stringify(await store.dumpState())).toBe(before)
    // The refusal is inside the transaction that precedes the file, so no bytes escaped
    // either — a fence checked after the durable side effect would refuse too late.
    expect(readdirSync(root)).not.toContain('agent-jobs')

    await store.publishCheckpoint(asJobId('job_a'), 'analysis', record, current)
    expect(await store.readCheckpoint(asJobId('job_a'), 'analysis')).toEqual({
      found: true,
      payload: record,
    })
  })

  it('refuses to adopt an epoch behind the recorded one', async () => {
    await expect(store.adoptEpoch(1)).rejects.toBeInstanceOf(StaleJobStoreEpochError)
    expect((await store.dumpState()).epoch).toBe(2)
  })
})

describe('agent job store: fenced checkpoint rows', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-checkpoint-fence-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('recovers the successor payload after the stale host wins the final file write', async () => {
    const jobId = asJobId('job_a')
    const staleRecord = checkpointRecord(jobId, 'analysis', { author: 'stale-host' })
    const successorRecord = checkpointRecord(jobId, 'analysis', { author: 'successor' })
    let crossedPublishBarrier = false

    const staleHost = openStore(root, steppingClock(), {
      beforeCheckpointFilePublish: () => {
        crossedPublishBarrier = true
        const successor = openStore(root)
        try {
          void successor.adoptEpoch(2)
          void successor.publishCheckpoint(jobId, 'analysis', successorRecord, { epoch: 2 })
        } finally {
          successor.close()
        }
      },
    })

    try {
      const staleFence = await staleHost.adoptEpoch(1)
      await staleHost.enqueue(insert('job_a', 'key-a'))
      await staleHost.claimNext(staleFence)

      await staleHost.publishCheckpoint(jobId, 'analysis', staleRecord, staleFence)

      expect(crossedPublishBarrier).toBe(true)
      // The stale host resumed last and really did replace the cache file. Reading only that
      // file would therefore adopt the wrong author even though sqlite already fenced it out.
      expect(createJobCheckpointStore({ root }).read('job_a', 'analysis')).toEqual({
        found: true,
        payload: staleRecord,
      })
      expect(await staleHost.readCheckpoint(jobId, 'analysis')).toEqual({
        found: true,
        payload: successorRecord,
      })
      expect(rawCheckpointRows(root)).toHaveLength(1)
      expect(rawCheckpointRows(root)[0]).toMatchObject({ epoch: 2 })
    } finally {
      staleHost.close()
    }
  })

  it('persists neither a checkpoint row nor a file when the fence is already stale', async () => {
    const store = openStore(root)
    try {
      const staleFence = await store.adoptEpoch(1)
      await store.enqueue(insert('job_a', 'key-a'))
      await store.claimNext(staleFence)
      await store.adoptEpoch(2)
      const before = JSON.stringify(await store.dumpState())
      const record = checkpointRecord(asJobId('job_a'), 'analysis', { author: 'stale-host' })

      await expect(
        store.publishCheckpoint(asJobId('job_a'), 'analysis', record, staleFence),
      ).rejects.toBeInstanceOf(StaleJobStoreEpochError)

      expect(JSON.stringify(await store.dumpState())).toBe(before)
      expect(rawCheckpointRows(root)).toEqual([])
      expect(readdirSync(root)).not.toContain('agent-jobs')
    } finally {
      store.close()
    }
  })

  it('stores the canonical payload and digest in the fenced row while the file agrees', async () => {
    const store = openStore(root)
    try {
      const fence = await store.adoptEpoch(4)
      await store.enqueue(insert('job_a', 'key-a'))
      const claim = await store.claimNext(fence)
      if (!claim.claimed) throw new Error('nothing to claim')
      const record = checkpointRecord(claim.job.id, 'analysis', { verdict: 'no-takeover' })

      await store.publishCheckpoint(claim.job.id, 'analysis', record, fence)

      expect(rawCheckpointRows(root)).toEqual([
        expect.objectContaining({
          job_id: 'job_a',
          checkpoint_id: 'analysis',
          attempt: 1,
          payload_json: canonicalJson(record),
          payload_digest: sha256hex(canonicalJson(record)),
          epoch: 4,
        }),
      ])
      expect(createJobCheckpointStore({ root }).read('job_a', 'analysis')).toEqual({
        found: true,
        payload: record,
      })
      expect(await store.readCheckpoint(claim.job.id, 'analysis')).toEqual({
        found: true,
        payload: record,
      })
    } finally {
      store.close()
    }
  })
})

// Phase 385 plan 05 — cancellation as a STORE guarantee (D-19). Driven through the port
// directly, because D-02 lets any process open this database: a three-way outcome that only
// held when the engine was the caller would not be a store guarantee at all.
describe('agent job store: cancellation', () => {
  let root: string
  let store: SqliteJobStore
  let fence: JobStoreFence

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-cancel-'))
    store = openStore(root)
    fence = await store.adoptEpoch(1)
    await store.enqueue(insert('job_a', 'key-a'))
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('cancels a job nobody is running, at once', async () => {
    expect(await store.requestCancel(asJobId('job_a'), fence)).toEqual({ outcome: 'cancelled' })

    const row = rawRow(root, 'job_a')
    expect(row?.status).toBe('cancelled')
    expect(row?.cancel_requested_at).not.toBeNull()
    // Terminal in the store's own terms: the claim query never offers it again.
    expect(await store.claimNext(fence)).toEqual({ claimed: false })
  })

  // The control that separates the two paths. A store that cancelled everything outright
  // would satisfy the case above and destroy this one.
  it('only RECORDS the request for a job that is claimed, leaving it claimable state and all', async () => {
    await store.claimNext(fence)

    expect(await store.requestCancel(asJobId('job_a'), fence)).toEqual({
      outcome: 'cancel-requested',
    })

    const row = rawRow(root, 'job_a')
    expect(row?.status).toBe('queued')
    expect(row?.claimed_at).not.toBeNull()
    expect(row?.cancel_requested_at).not.toBeNull()
    expect((await store.dumpState()).jobs[0]).toMatchObject({
      status: 'queued',
      claimed: true,
      cancelRequested: true,
    })
  })

  it.each([
    { label: 'done', settle: 'done' },
    { label: 'failed', settle: 'failed' },
    { label: 'cancelled', settle: 'cancelled' },
  ])('reports already-terminal for a $label job and mutates nothing', async ({ settle }) => {
    if (settle === 'done') {
      await store.claimNext(fence)
      await store.completeAndChain(asJobId('job_a'), [], fence)
    } else if (settle === 'failed') {
      await store.claimNext(fence)
      await store.recordFailure(asJobId('job_a'), { kind: 'permanent', reason: 'gave up' }, fence)
    } else {
      await store.requestCancel(asJobId('job_a'), fence)
    }
    const before = JSON.stringify(await store.dumpState())

    expect(await store.requestCancel(asJobId('job_a'), fence)).toEqual({
      outcome: 'already-terminal',
      status: settle,
    })
    expect(JSON.stringify(await store.dumpState())).toBe(before)
  })

  it('refuses a stale epoch, mutates nothing, and the current holder still cancels', async () => {
    const current = await store.adoptEpoch(2)
    const before = JSON.stringify(await store.dumpState())

    await expect(store.requestCancel(asJobId('job_a'), fence)).rejects.toBeInstanceOf(
      StaleJobStoreEpochError,
    )
    expect(JSON.stringify(await store.dumpState())).toBe(before)

    expect(await store.requestCancel(asJobId('job_a'), current)).toEqual({
      outcome: 'cancelled',
    })
  })

  it('refuses to record a cancellation nobody requested, and records one that was', async () => {
    await store.claimNext(fence)
    const before = JSON.stringify(await store.dumpState())

    await expect(
      store.recordCancellation(asJobId('job_a'), fence),
    ).rejects.toBeInstanceOf(JobCancellationNotRequestedError)
    expect(JSON.stringify(await store.dumpState())).toBe(before)

    // The paired success: the verb works, it just will not invent the request.
    await store.requestCancel(asJobId('job_a'), fence)
    await store.recordCancellation(asJobId('job_a'), fence)
    expect(rawRow(root, 'job_a')).toMatchObject({ status: 'cancelled', claimed_at: null })
  })

  it('shows the request in the deterministic dump, and only when there is one', async () => {
    await store.enqueue(insert('job_b', 'key-b'))
    await store.requestCancel(asJobId('job_a'), fence)

    const dump = await store.dumpState()

    expect(dump.jobs.map((row) => [row.id, row.cancelRequested])).toEqual([
      ['job_a', true],
      ['job_b', false],
    ])
  })
})

// The 413-13 gap closure. Phase 413's `agent-jobs pump` composed with no post-run capability
// set, so the kind registry selected the STAND-IN analyze-run handler: nineteen rows reached
// `done` with a `verdicts-authored` checkpoint recorded and nothing authored. Returning those
// rows to the queue is only half a remedy, and the smaller half — `readCheckpoint` resolves
// through `selectLatestCheckpoint`'s `ORDER BY attempt DESC`, so a row reset that KEPT the
// stand-in's checkpoint would hand the real handler the stand-in's recorded value and it
// would report `completed` having written nothing, a second time. So the cells below assert
// the forget in BOTH media, and assert that the row's identity survives it.
describe('agent job store: requeueTerminal, the stand-in forget', () => {
  let root: string
  let store: SqliteJobStore
  let fence: JobStoreFence

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-requeue-'))
    store = openStore(root)
    fence = await store.adoptEpoch(1)
    await store.enqueue(insert('job_a', 'r_requeue'))
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  /** The file path the store's own checkpoint store would use — asserted on directly. */
  function checkpointFile(jobId: string, checkpointId: string): string {
    return createJobCheckpointStore({ root }).checkpointPath(jobId, checkpointId)
  }

  it('requeueTerminal forgets a terminal job: queued, attempts 0, no checkpoint row, no checkpoint file, same id and key', async () => {
    await store.claimNext(fence)
    await store.publishCheckpoint(
      asJobId('job_a'),
      'verdicts-authored',
      checkpointRecord(asJobId('job_a'), 'verdicts-authored', { verdicts: ['stand-in'] }),
      fence,
    )
    await store.completeAndChain(asJobId('job_a'), [], fence)

    const file = checkpointFile('job_a', 'verdicts-authored')
    // The precondition, asserted rather than assumed: without it a store that never wrote a
    // checkpoint at all would satisfy every "it is gone" expectation below.
    expect(rawRow(root, 'job_a')).toMatchObject({ status: 'done', attempts: 1 })
    expect(await store.readCheckpoint(asJobId('job_a'), 'verdicts-authored')).toMatchObject({
      found: true,
    })
    expect(existsSync(file)).toBe(true)

    expect(await store.requeueTerminal(asJobId('job_a'), fence)).toEqual({ outcome: 'requeued' })

    // Same id, same key: the derived chain identity `chainJobIdsForRun` addresses is intact,
    // so the re-run's successor dedupes on the existing slot instead of duplicating it.
    expect((await store.dumpState()).jobs).toMatchObject([
      {
        id: 'job_a',
        idempotencyKey: 'r_requeue',
        status: 'queued',
        attempts: 0,
        claimed: false,
        cancelRequested: false,
      },
    ])
    expect(await store.readCheckpoint(asJobId('job_a'), 'verdicts-authored')).toEqual({
      found: false,
    })
    expect(rawCheckpointRows(root)).toEqual([])
    expect(existsSync(file)).toBe(false)

    // And it is genuinely back in the queue, on a fresh attempt.
    expect(await store.claimNext(fence)).toMatchObject({
      claimed: true,
      job: { id: 'job_a', status: 'queued', attempts: 1 },
    })
  })

  // CR-01. The stand-in's attempt was recorded in THREE durable media, not two: the checkpoint
  // rows, the checkpoint files, and the `notifications` row its chain terminal minted. The cell
  // above asserts the first two. This one asserts the third, and it is the one the other cells
  // structurally cannot see — they call `completeAndChain(id, [], fence)` with no `chainTerminal`
  // argument, so no notification is ever written in their fixture and a store that never deleted
  // one would satisfy every expectation they make.
  //
  // The third medium is also the only one that cannot be corrected afterwards, which is why
  // leaving it is worse than leaving a checkpoint. `insertNotification` is
  // `ON CONFLICT (run_id) DO NOTHING` — by design, so a crash-replayed terminal dedupes — and the
  // re-run's REAL analyze-run handler chains a successor, so `chainTerminalFor` returns
  // `undefined` and never offers a replacement record at all. A receipt left behind therefore
  // wins forever, naming an attempt whose every other trace the operator just deleted, on a
  // surface that renders it (`post-processing-reader.ts` -> the dashboard and CLI status).
  it('requeueTerminal forgets the chain-terminal notification, the third durable medium', async () => {
    const run = 'r_notified'
    await store.enqueue(insert('job_n', run, { runId: run }))
    await store.claimNext(fence) // `job_a`, enqueued first by the fixture
    await store.claimNext(fence) // `job_n`
    await store.publishCheckpoint(
      asJobId('job_n'),
      'verdicts-authored',
      checkpointRecord(asJobId('job_n'), 'verdicts-authored', { verdicts: ['stand-in'] }),
      fence,
    )
    // The chain terminal the stand-in's completion minted. `dedupeKey` IS the run id, which is
    // what makes the payload's `runId` the key this requeue has to address (engine.ts's
    // `chainTerminalFor`); the absent successor is skipped by `recordChainTerminal`'s candidate
    // walk, and the head exists and is terminal, so the row is written.
    await store.completeAndChain(asJobId('job_n'), [], fence, {
      dedupeKey: run,
      candidateJobIds: [asJobId('job_n'), asJobId('job_n->curate-memory')],
      payloadJson: canonicalJson(notification(run, 'failed')),
    })

    // The precondition, asserted rather than assumed.
    expect(await store.listNotifications()).toMatchObject([{ runId: run }])

    // The forget is in the SAME fenced transaction as the status reset and the checkpoint-row
    // delete, so a writer that lost its lease moves this medium no more than it moves the others.
    const current = await store.adoptEpoch(2)
    await expect(store.requeueTerminal(asJobId('job_n'), fence)).rejects.toBeInstanceOf(
      StaleJobStoreEpochError,
    )
    expect(await store.listNotifications()).toMatchObject([{ runId: run }])

    expect(await store.requeueTerminal(asJobId('job_n'), current)).toEqual({ outcome: 'requeued' })
    expect(await store.listNotifications()).toEqual([])

    // And the receipt is genuinely REPLACEABLE now, which is the point rather than a bonus: the
    // insert that `ON CONFLICT (run_id) DO NOTHING` would otherwise have swallowed forever writes
    // the re-run's record instead.
    await store.claimNext(current)
    await store.completeAndChain(asJobId('job_n'), [], current, {
      dedupeKey: run,
      candidateJobIds: [asJobId('job_n'), asJobId('job_n->curate-memory')],
      payloadJson: canonicalJson(notification(run, 'done')),
    })
    expect(await store.listNotifications()).toMatchObject([
      { runId: run, payload: { outcome: 'done' } },
    ])

    // The paired control, and the reason the delete is keyed on the PAYLOAD rather than on the
    // job id: `job_a` names no run, so requeueing it disowns nothing. A delete that swept by job
    // would pass every assertion above and destroy an unrelated run's receipt here.
    await store.failAndChain(asJobId('job_a'), { kind: 'permanent', reason: 'gave up' }, [], current)
    expect(await store.requeueTerminal(asJobId('job_a'), current)).toEqual({ outcome: 'requeued' })
    expect(await store.listNotifications()).toMatchObject([{ runId: run }])
  })

  it('requeueTerminal refuses a queued or claimed row as not-terminal and moves nothing', async () => {
    const queuedBefore = JSON.stringify(await store.dumpState())
    expect(await store.requeueTerminal(asJobId('job_a'), fence)).toEqual({
      outcome: 'not-terminal',
      status: 'queued',
    })
    expect(JSON.stringify(await store.dumpState())).toBe(queuedBefore)

    // A claimed row keeps the published status `queued` and holds its claim — the store owns
    // the claim in a column, not in the status vocabulary — so the refusal reports `queued`
    // and the claim and the attempt it spent both survive it.
    await store.claimNext(fence)
    const claimedBefore = JSON.stringify(await store.dumpState())
    expect(await store.requeueTerminal(asJobId('job_a'), fence)).toEqual({
      outcome: 'not-terminal',
      status: 'queued',
    })
    expect(JSON.stringify(await store.dumpState())).toBe(claimedBefore)
    expect((await store.dumpState()).jobs[0]).toMatchObject({ claimed: true, attempts: 1 })

    // The paired successes, one per remaining terminal status: the verb works on `failed`
    // and on `cancelled` too, and clears the columns that recorded how they got there.
    await store.enqueue(insert('job_f', 'r_failed'))
    await store.claimNext(fence)
    await store.failAndChain(asJobId('job_f'), { kind: 'permanent', reason: 'gave up' }, [], fence)
    expect(rawRow(root, 'job_f')).toMatchObject({
      status: 'failed',
      last_failure_kind: 'permanent',
    })
    expect(await store.requeueTerminal(asJobId('job_f'), fence)).toEqual({ outcome: 'requeued' })
    expect(rawRow(root, 'job_f')).toMatchObject({
      status: 'queued',
      attempts: 0,
      claimed_at: null,
      last_failure_kind: null,
      last_failure_reason: null,
      cancel_requested_at: null,
    })

    await store.enqueue(insert('job_c', 'r_cancelled'))
    await store.requestCancel(asJobId('job_c'), fence)
    expect(rawRow(root, 'job_c')?.status).toBe('cancelled')
    expect(await store.requeueTerminal(asJobId('job_c'), fence)).toEqual({ outcome: 'requeued' })
    expect((await store.dumpState()).jobs.find((row) => row.id === 'job_c')).toMatchObject({
      status: 'queued',
      attempts: 0,
      cancelRequested: false,
    })
  })

  it('requeueTerminal is fenced, and refuses an id no row answers to', async () => {
    await store.claimNext(fence)
    await store.publishCheckpoint(
      asJobId('job_a'),
      'verdicts-authored',
      checkpointRecord(asJobId('job_a'), 'verdicts-authored', { verdicts: ['stand-in'] }),
      fence,
    )
    await store.completeAndChain(asJobId('job_a'), [], fence)

    const current = await store.adoptEpoch(2)
    const before = JSON.stringify(await store.dumpState())

    await expect(store.requeueTerminal(asJobId('job_a'), fence)).rejects.toBeInstanceOf(
      StaleJobStoreEpochError,
    )
    expect(JSON.stringify(await store.dumpState())).toBe(before)
    // The forget is inside the same refused transaction, so the checkpoint survives too.
    expect(await store.readCheckpoint(asJobId('job_a'), 'verdicts-authored')).toMatchObject({
      found: true,
    })

    // A mismatched id is a caller bug, not a third outcome arm (413-02 D-4).
    await expect(store.requeueTerminal(asJobId('job_missing'), current)).rejects.toBeInstanceOf(
      UnknownJobRowError,
    )

    // The paired success: the verb works, it just will not work for a writer that lost its lease.
    expect(await store.requeueTerminal(asJobId('job_a'), current)).toEqual({
      outcome: 'requeued',
    })
  })
})

// 425-13: THE START OUTLIVES THE LEASE. `claimed_at` answers who holds a row right now and every
// terminal transition releases it, so a card that timed a settled stage from it could never say how
// long the stage took. `started_at` is written once, at the first claim, and cleared only by the
// operator requeue. The stepping clock is what makes "once" observable: every `now()` is a later
// instant, so a second claim that overwrote the column would read differently.
describe('agent job store: durable start instant', () => {
  let root: string
  let store: SqliteJobStore
  let fence: JobStoreFence

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-start-'))
    store = openStore(root)
    fence = await store.adoptEpoch(1)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('DURABLE-START-WRITTEN-ONCE: a retried claim keeps the first claim as the start', async () => {
    await store.enqueue(insert('job_a', 'key-a'))
    expect(rawRow(root, 'job_a')?.started_at).toBeNull()

    await store.claimNext(fence)
    const first = rawRow(root, 'job_a')
    expect(first?.started_at).not.toBeNull()
    expect(first?.started_at).toBe(first?.claimed_at)

    await store.recordFailure(asJobId('job_a'), { kind: 'retry', reason: 'provider timed out' }, fence)
    await store.claimNext(fence)
    const second = rawRow(root, 'job_a')

    expect(Number(second?.attempts)).toBe(2)
    expect(second?.claimed_at).not.toBe(first?.claimed_at)
    expect(
      second?.started_at,
      'the second claim is a second attempt at work that already began, not a new start',
    ).toBe(first?.started_at)
  })

  it('DURABLE-START-SURVIVES-EVERY-TERMINAL: each terminal releases the lease and keeps the start; only the requeue clears it', async () => {
    for (const id of ['job_done', 'job_failed', 'job_cancelled']) {
      await store.enqueue(insert(id, id))
    }

    await store.claimNext(fence)
    await store.completeAndChain(asJobId('job_done'), [], fence)
    await store.claimNext(fence)
    await store.recordFailure(asJobId('job_failed'), { kind: 'permanent', reason: 'bad payload' }, fence)
    await store.claimNext(fence)
    expect(await store.requestCancel(asJobId('job_cancelled'), fence)).toEqual({
      outcome: 'cancel-requested',
    })
    await store.recordCancellation(asJobId('job_cancelled'), fence)

    for (const [id, status] of [
      ['job_done', 'done'],
      ['job_failed', 'failed'],
      ['job_cancelled', 'cancelled'],
    ] as const) {
      const row = rawRow(root, id)
      expect(row?.status).toBe(status)
      expect(row?.claimed_at, `${status} releases the lease`).toBeNull()
      expect(row?.started_at, `${status} keeps the start`).not.toBeNull()
    }

    expect(await store.requeueTerminal(asJobId('job_done'), fence)).toEqual({ outcome: 'requeued' })
    const requeued = rawRow(root, 'job_done')
    expect(Number(requeued?.attempts)).toBe(0)
    expect(
      requeued?.started_at,
      'a requeued row starts a new queue life; keeping the start would time one that no longer exists',
    ).toBeNull()
  })
})

describe('agent job store: retry not-before times and the refused old version', () => {
  const T0 = Date.parse('2026-01-01T00:00:00.000Z')
  let root: string
  let offsetMs: number
  let store: SqliteJobStore
  let fence: JobStoreFence

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-backoff-'))
    offsetMs = 0
    store = openStore(root, { now: () => new Date(T0 + offsetMs).toISOString() })
    fence = await store.adoptEpoch(1)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('a claim skips a retrying row until its not-before time and then claims it', async () => {
    await store.enqueue(insert('job_a', 'key-a'))
    await store.enqueue(insert('job_b', 'key-b'))
    const first = await store.claimNext(fence)
    expect(first.claimed && String(first.job.id)).toBe('job_a')
    await store.recordFailure(
      asJobId('job_a'),
      { kind: 'retry', reason: 'provider timed out', retryAfterMs: 1000 },
      fence,
    )

    offsetMs = 999
    const skipped = await store.claimNext(fence)
    expect(
      skipped.claimed && String(skipped.job.id),
      'job_a is inside its backoff, so the younger row is offered',
    ).toBe('job_b')
    expect(await store.claimNext(fence, { excludeKinds: ['curate-memory'] })).toEqual({
      claimed: false,
    })
    expect(rawRow(root, 'job_a')).toMatchObject({
      status: 'queued',
      claimed_at: null,
      attempts: 1,
      not_before: '2026-01-01T00:00:01.000Z',
    })

    offsetMs = 1000
    expect(await store.claimNext(fence)).toMatchObject({
      claimed: true,
      job: { id: 'job_a', attempts: 2 },
    })

    await store.recordFailure(
      asJobId('job_a'),
      { kind: 'retry', reason: 'provider timed out', retryAfterMs: 60_000 },
      fence,
    )
    await store.recordFailure(asJobId('job_a'), { kind: 'permanent', reason: 'gave up' }, fence)
    expect(await store.requeueTerminal(asJobId('job_a'), fence)).toEqual({ outcome: 'requeued' })
    expect(rawRow(root, 'job_a')?.not_before, 'the operator requeue clears the backoff').toBeNull()
    expect(await store.claimNext(fence)).toMatchObject({
      claimed: true,
      job: { id: 'job_a', attempts: 1 },
    })
  })

  it('a row whose not-before time is now is claimable', async () => {
    await store.enqueue(insert('job_a', 'key-a'))
    await store.claimNext(fence)
    offsetMs = 250
    await store.recordFailure(
      asJobId('job_a'),
      { kind: 'retry', reason: 'transient', retryAfterMs: 500 },
      fence,
    )
    expect(rawRow(root, 'job_a')?.not_before).toBe('2026-01-01T00:00:00.750Z')

    offsetMs = 749
    expect(await store.claimNext(fence)).toEqual({ claimed: false })
    expect(await store.claimNext(fence, { excludeKinds: ['curate-memory'] })).toEqual({
      claimed: false,
    })

    offsetMs = 750
    expect(await store.claimNext(fence, { excludeKinds: ['curate-memory'] })).toMatchObject({
      claimed: true,
      job: { id: 'job_a', attempts: 2 },
    })
  })

  it('a job store written at version 4 is refused by name', () => {
    const versionFour = mkdtempSync(join(tmpdir(), 'agent-qa-job-v4-'))
    try {
      const raw = new DatabaseSync(join(versionFour, AGENT_JOB_STORE_DB_FILE))
      raw.exec(
        `CREATE TABLE jobs (
           id TEXT PRIMARY KEY, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL,
           status TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL,
           attempts INTEGER NOT NULL, claimed_at TEXT, created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL, last_failure_kind TEXT, last_failure_reason TEXT,
           cancel_requested_at TEXT, started_at TEXT
         )`,
      )
      raw.exec('PRAGMA user_version=4')
      raw.close()

      let thrown: unknown
      try {
        openStore(versionFour).close()
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(JobStoreSchemaVersionError)
      expect((thrown as JobStoreSchemaVersionError).observedVersion).toBe(4)
      expect((thrown as JobStoreSchemaVersionError).expectedVersion).toBe(
        AGENT_JOB_STORE_USER_VERSION,
      )
      expect((thrown as Error).message).toContain('clear agent job queue state')

      const after = new DatabaseSync(join(versionFour, AGENT_JOB_STORE_DB_FILE))
      try {
        expect(Number(after.prepare('PRAGMA user_version').get()?.user_version)).toBe(4)
        const columns = after
          .prepare('PRAGMA table_info(jobs)')
          .all()
          .map((column) => String(column.name))
        expect(columns).toContain('started_at')
        expect(columns).not.toContain('not_before')
      } finally {
        after.close()
      }
    } finally {
      rmSync(versionFour, { recursive: true, force: true })
    }
  })
})

describe('agent job store: interrupted jobs', () => {
  let root: string
  let store: SqliteJobStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-interrupted-'))
    store = openStore(root)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('an interrupted job is queued again with its attempt refunded and its last failure kept', async () => {
    const controller = new AbortController()
    let markCalled: () => void = () => {}
    const called = new Promise<void>((resolve) => {
      markCalled = resolve
    })
    const model: JobModelCapability = {
      modelId: 'test:waiting',
      generate: () => {
        markCalled()
        return new Promise((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new DOMException('the model request was aborted', 'AbortError')),
            { once: true },
          )
        })
      },
    }
    const idSource: JobIdSource = {
      jobIdFor: (kind, idempotencyKey) => asJobId(`job_${kind}_${idempotencyKey}`),
    }
    const queue = createAgentJobQueue({
      store,
      registry: createJobKindRegistry([
        {
          kind: KIND,
          checkpointed: true,
          checkpointSchedule: ['verdicts-authored'],
          allowedSuccessors: [],
          maxAttempts: 3,
          backoff: { kind: 'none' },
          onPermanentFailure: 'halt-chain',
          handler: async (context) => {
            if (context.job.attempts === 1) {
              return { status: 'retryable', reason: 'the provider timed out' }
            }
            await context.recordLlmAuthorship('verdicts-authored', (bound) =>
              bound.generate({ prompt: 'author the verdicts' }),
            )
            return { status: 'complete', next: [] }
          },
        },
      ]),
      clock: steppingClock(),
      idSource,
      model,
    })
    const fence = await store.adoptEpoch(1)
    const enqueued = await queue.enqueue(KIND, {}, 'key-a')
    const id = String(enqueued.job.id)
    expect(await queue.runNextJob({ fence })).toMatchObject({ disposition: 'retry-scheduled' })
    const afterRetry = rawRow(root, id)
    expect(afterRetry).toMatchObject({ attempts: 1, last_failure_kind: 'retry' })

    const running = queue.runNextJob({ fence, signal: controller.signal })
    await called
    controller.abort()
    const outcome = await running

    expect(rawRow(root, id)).toMatchObject({
      status: 'queued',
      claimed_at: null,
      attempts: 1,
      last_failure_kind: 'retry',
      last_failure_reason: 'the provider timed out',
      not_before: afterRetry?.not_before,
      started_at: afterRetry?.started_at,
    })
    expect(outcome).toMatchObject({ ran: true, disposition: 'interrupted', job: { attempts: 2 } })
    expect(await store.claimNext(fence)).toMatchObject({
      claimed: true,
      job: { id, attempts: 2 },
    })
  })
})
