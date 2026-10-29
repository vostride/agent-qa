// An in-memory JobStorePort for the engine's unit seam.
//
// The engine holds policy and the store holds atomicity, so the engine's own tests
// need a store that is FAITHFUL about the handful of facts its policy reads — the attempt is
// spent at the claim, a claimed row is not claimable again, a retry disposition releases the
// claim, a permanent one is terminal, and a duplicate (kind, key) merges into the row that is
// already there. Everything the real store additionally guarantees (transactions, cross-
// process fencing, durability) is proven against the real store in the agent-local package;
// a second copy of those proofs here would only prove this file.

import type { Job, JobId, JobKind } from '@vostride/agent-qa-schema'

import type { ClockPort } from '../../ports/clock.js'
import type {
  ClaimNextOptions,
  JobCancelOutcome,
  JobCheckpointRecord,
  JobCheckpointReadOutcome,
  JobClaimOutcome,
  JobCompleteOutcome,
  JobEnqueueOutcome,
  JobFailAndChainOutcome,
  JobFailureDisposition,
  JobInsert,
  JobRequeueOutcome,
  JobStoreDump,
  JobStoreFence,
  JobStorePort,
} from '../../ports/job-store.js'
import {
  JobCancellationNotRequestedError,
  StaleJobStoreEpochError,
} from '../../ports/job-store.js'

interface Row {
  id: string
  kind: JobKind
  idempotencyKey: string
  status: Job['status']
  summary: string
  payload: unknown
  attempts: number
  claimed: boolean
  cancelRequested: boolean
  createdAt: string
  updatedAt: string
  lastFailureKind?: string
  lastFailureReason?: string
}

export interface FakeJobStore extends JobStorePort {
  rows(): readonly Row[]
  checkpoints(): readonly { jobId: string; checkpointId: string; payload: JobCheckpointRecord }[]
  callCount(verb: 'recordFailure' | 'failAndChain' | 'releaseInterrupted'): number
  /** What each claimNext call received as its options argument, in call order. */
  claimNextCalls(): readonly (ClaimNextOptions | undefined)[]
  failureDispositions(): readonly { jobId: string; disposition: JobFailureDisposition }[]
}

/** The three statuses a job never leaves. A cancel arriving at one of them changes nothing. */
const TERMINAL_STATUSES: readonly Job['status'][] = ['done', 'failed', 'cancelled']

export function createFakeJobStore(clock: ClockPort): FakeJobStore {
  const rows = new Map<string, Row>()
  const published: { jobId: string; checkpointId: string; payload: JobCheckpointRecord }[] = []
  const claimNextCallLog: (ClaimNextOptions | undefined)[] = []
  const failureLog: { jobId: string; disposition: JobFailureDisposition }[] = []
  const callCounts = {
    recordFailure: 0,
    failAndChain: 0,
    releaseInterrupted: 0,
  }
  let epoch = 0

  function requireFence(fence: JobStoreFence): void {
    if (fence.epoch !== epoch) throw new StaleJobStoreEpochError(fence.epoch, epoch)
  }

  function toJob(row: Row): Job {
    return {
      id: row.id as JobId,
      kind: row.kind,
      status: row.status,
      summary: row.summary,
      attempts: row.attempts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  function requireRow(jobId: JobId): Row {
    const row = rows.get(String(jobId))
    if (row === undefined) throw new Error(`unknown job row: ${String(jobId)}`)
    return row
  }

  function insertOrGet(request: JobInsert, now: string): JobEnqueueOutcome {
    for (const row of rows.values()) {
      if (row.kind === request.kind && row.idempotencyKey === request.idempotencyKey) {
        return { job: toJob(row), deduped: true }
      }
    }
    if (rows.has(String(request.id))) {
      throw new Error(`duplicate job row id: ${String(request.id)}`)
    }
    const row: Row = {
      id: String(request.id),
      kind: request.kind,
      idempotencyKey: request.idempotencyKey,
      status: 'queued',
      summary: request.summary,
      payload: request.payload,
      attempts: 0,
      claimed: false,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    }
    rows.set(row.id, row)
    return { job: toJob(row), deduped: false }
  }

  /** Roll back all row mutations when a compound fake-store verb throws. */
  function atomically<T>(body: () => T): T {
    const before = new Map([...rows].map(([id, row]) => [id, { ...row }]))
    try {
      return body()
    } catch (error) {
      rows.clear()
      for (const [id, row] of before) rows.set(id, row)
      throw error
    }
  }

  return {
    rows: () => [...rows.values()].map((row) => ({ ...row })),
    checkpoints: () => published.map((entry) => ({ ...entry })),
    callCount: (verb) => callCounts[verb],
    claimNextCalls: () => [...claimNextCallLog],
    failureDispositions: () => failureLog.map((entry) => ({ ...entry })),

    async adoptEpoch(next: number): Promise<JobStoreFence> {
      if (next < epoch) throw new StaleJobStoreEpochError(next, epoch)
      epoch = next
      return { epoch }
    },

    async enqueue(request: JobInsert): Promise<JobEnqueueOutcome> {
      return insertOrGet(request, clock.now())
    },

    async claimNext(
      fence: JobStoreFence,
      options?: ClaimNextOptions,
    ): Promise<JobClaimOutcome> {
      requireFence(fence)
      claimNextCallLog.push(options)
      const excluded = new Set(options?.excludeKinds ?? [])
      const now = clock.now()
      for (const row of rows.values()) {
        if (row.status !== 'queued' || row.claimed) continue
        if (excluded.has(row.kind)) continue
        // the attempt is spent HERE, at the claim.
        row.attempts += 1
        row.claimed = true
        row.updatedAt = now
        return { claimed: true, job: toJob(row), payload: row.payload }
      }
      return { claimed: false }
    },

    async completeAndChain(
      jobId: JobId,
      next: readonly JobInsert[],
      fence: JobStoreFence,
    ): Promise<JobCompleteOutcome> {
      requireFence(fence)
      const now = clock.now()
      return atomically(() => {
        const row = requireRow(jobId)
        row.status = 'done'
        row.claimed = false
        row.updatedAt = now
        const chained = next.map((request) => insertOrGet(request, now))
        return { job: toJob(row), chained }
      })
    },

    async failAndChain(
      jobId: JobId,
      disposition: Extract<JobFailureDisposition, { readonly kind: 'permanent' }>,
      next: readonly JobInsert[],
      fence: JobStoreFence,
    ): Promise<JobFailAndChainOutcome> {
      callCounts.failAndChain += 1
      requireFence(fence)
      const now = clock.now()
      return atomically(() => {
        const row = requireRow(jobId)
        row.status = 'failed'
        row.claimed = false
        row.updatedAt = now
        row.lastFailureKind = disposition.kind
        row.lastFailureReason = disposition.reason
        const chained = next.map((request) => insertOrGet(request, now))
        return { job: toJob(row), chained }
      })
    },

    async recordFailure(
      jobId: JobId,
      disposition: JobFailureDisposition,
      fence: JobStoreFence,
    ): Promise<void> {
      callCounts.recordFailure += 1
      requireFence(fence)
      failureLog.push({ jobId: String(jobId), disposition: { ...disposition } })
      const row = requireRow(jobId)
      row.claimed = false
      row.updatedAt = clock.now()
      row.lastFailureKind = disposition.kind
      row.lastFailureReason = disposition.reason
      if (disposition.kind === 'permanent') row.status = 'failed'
    },

    async releaseInterrupted(jobId: JobId, fence: JobStoreFence): Promise<void> {
      callCounts.releaseInterrupted += 1
      requireFence(fence)
      const row = requireRow(jobId)
      row.claimed = false
      row.attempts = Math.max(row.attempts - 1, 0)
      row.updatedAt = clock.now()
    },

    async requestCancel(jobId: JobId, fence: JobStoreFence): Promise<JobCancelOutcome> {
      requireFence(fence)
      const row = requireRow(jobId)
      if (TERMINAL_STATUSES.includes(row.status)) {
        return { outcome: 'already-terminal', status: row.status }
      }
      row.cancelRequested = true
      row.updatedAt = clock.now()
      // The two paths of D-19, decided by whether anybody is holding the job right now.
      if (row.claimed) {
        return { outcome: 'cancel-requested' }
      }
      row.status = 'cancelled'
      return { outcome: 'cancelled' }
    },

    async recordCancellation(jobId: JobId, fence: JobStoreFence): Promise<void> {
      requireFence(fence)
      const row = requireRow(jobId)
      if (!row.cancelRequested) {
        throw new JobCancellationNotRequestedError(jobId)
      }
      row.status = 'cancelled'
      row.claimed = false
      row.updatedAt = clock.now()
    },

    // 413-13. The fake answers the requeue in the same terms the sqlite store does, because
    // the engine's unit seam has to be able to stand a job up twice; forgetting the published
    // checkpoints is not an optimisation here either — a fake that kept them would let a
    // resumed handler read a value from an attempt the row no longer remembers.
    async requeueTerminal(jobId: JobId, fence: JobStoreFence): Promise<JobRequeueOutcome> {
      requireFence(fence)
      const row = requireRow(jobId)
      if (!TERMINAL_STATUSES.includes(row.status)) {
        return { outcome: 'not-terminal', status: row.status }
      }
      row.status = 'queued'
      row.claimed = false
      row.attempts = 0
      row.cancelRequested = false
      delete row.lastFailureKind
      delete row.lastFailureReason
      row.updatedAt = clock.now()
      for (let index = published.length - 1; index >= 0; index -= 1) {
        if (published[index]?.jobId === String(jobId)) published.splice(index, 1)
      }
      return { outcome: 'requeued' }
    },

    async publishCheckpoint(
      jobId: JobId,
      checkpointId: string,
      payload: JobCheckpointRecord,
      fence: JobStoreFence,
    ): Promise<void> {
      requireFence(fence)
      requireRow(jobId)
      published.push({ jobId: String(jobId), checkpointId, payload })
    },

    async readCheckpoint(
      jobId: JobId,
      checkpointId: string,
    ): Promise<JobCheckpointReadOutcome> {
      for (let index = published.length - 1; index >= 0; index -= 1) {
        const entry = published[index]
        if (entry !== undefined && entry.jobId === String(jobId) && entry.checkpointId === checkpointId) {
          return { found: true, payload: entry.payload }
        }
      }
      return { found: false }
    },

    async dumpState(): Promise<JobStoreDump> {
      return {
        schemaVersion: 1,
        epoch,
        jobs: [...rows.values()]
          .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
          .map((row) => ({
            id: row.id,
            kind: row.kind,
            idempotencyKey: row.idempotencyKey,
            status: row.status,
            summary: row.summary,
            payload: row.payload,
            attempts: row.attempts,
            claimed: row.claimed,
            cancelRequested: row.cancelRequested,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })),
      }
    },
  }
}
