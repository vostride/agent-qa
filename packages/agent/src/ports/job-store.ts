// Drain-side verbs take a fence; `enqueue` needs none, because its unique index dedupes.

import type {
  Job,
  JobConclusionKind,
  JobEnqueueRequest,
  JobId,
  JobKind,
  JobStatus,
} from '@vostride/agent-qa-schema'

// A plain epoch record, because the writer lease's authority is an integer epoch on disk.
export interface JobStoreFence {
  readonly epoch: number
}

/**
 * The semantic unit accepted by the checkpoint persistence boundary.
 *
 * The engine constructs this record and the store owns its durable bytes. Keeping the
 * envelope beside the port makes a foreign raw payload unrepresentable without making the
 * storage-neutral port depend on the engine that consumes it.
 */
export interface JobCheckpointRecord {
  readonly checkpointId: string
  readonly jobId: JobId
  readonly attempt: number
  readonly recordedAt: string
  readonly value: unknown
}

// Carries the epoch the caller held and the one the store saw, so a log shows who was behind.
export class StaleJobStoreEpochError extends Error {
  override readonly name = 'StaleJobStoreEpochError'

  constructor(
    readonly heldEpoch: number,
    readonly observedEpoch: number,
  ) {
    super(
      `agent job store authority lost; held epoch ${heldEpoch}, observed ${observedEpoch}`,
    )
  }
}

// The id derives from `(kind, idempotencyKey)` and the store stamps times from its own clock.
export interface JobInsert extends JobEnqueueRequest {
  readonly id: JobId
  readonly summary: string
}

// Raised before anything is touched; the message omits the kind, an untrusted column value.
export class QuarantinedJobRequeueError extends Error {
  override readonly name = 'QuarantinedJobRequeueError'

  constructor(
    readonly jobId: string,
    readonly unreadableKind: string,
  ) {
    super(
      `Agent job ${jobId} cannot be requeued: it was recorded under a kind this build does ` +
        'not read, so it was quarantined at claim rather than handled. No registered kind can ' +
        'run it, and a requeue would reset its spent attempt and delete the record of why it ' +
        'was quarantined without making it runnable. The original kind, id and payload are ' +
        'preserved in the row for inspection. Clear the row deliberately if it is no longer ' +
        'wanted.',
    )
  }
}

// A duplicate enqueue is a success: `deduped` reports the pre-existing row.
export interface JobEnqueueOutcome {
  readonly job: Job
  readonly deduped: boolean
}

/**
 * An empty queue is an ordinary outcome, not an exception.
 *
 * The claim carries the `payload` beside the job because the `Job` DTO does not hold it and
 * should not: the payload is opaque input only the claiming kind's handler knows how to read,
 * while `Job` is the row every observer of the queue sees. Without it on the claim a handler
 * would be a function of its own id and no kind could do real work at all.
 */
export type JobClaimOutcome =
  | { readonly claimed: false }
  | { readonly claimed: true; readonly job: Job; readonly payload: unknown }

// An excluded kind is never offered: the attempt is spent at claim, and a release jumps the queue.
export interface ClaimNextOptions {
  readonly excludeKinds?: readonly JobKind[]
}

export interface JobCompleteOutcome {
  readonly job: Job
  readonly chained: readonly JobEnqueueOutcome[]
}

/** The terminal parent and continuation rows committed by one permanent-failure transaction. */
export interface JobFailAndChainOutcome {
  readonly job: Job
  readonly chained: readonly JobEnqueueOutcome[]
}

// The handler reports retryability; the engine decides, because only it knows attempts remaining.
export type JobFailureDisposition =
  | { readonly kind: 'retry'; readonly reason: string; readonly retryAfterMs?: number }
  | { readonly kind: 'permanent'; readonly reason: string }

export type JobCheckpointReadOutcome =
  | { readonly found: false }
  | { readonly found: true; readonly payload: unknown }

// An idle job stops at once, an in-flight one stops at its next checkpoint, a finished one stays.
export type JobCancelOutcome =
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'cancel-requested' }
  | { readonly outcome: 'already-terminal'; readonly status: JobStatus }

// Requeue forgets checkpoints and the chain notification too, or the re-run inherits stale state.
export type JobRequeueOutcome =
  | { readonly outcome: 'requeued' }
  | { readonly outcome: 'not-terminal'; readonly status: JobStatus }

/**
 * Refusal when a driver tries to land a job cancelled that nobody asked to cancel.
 *
 * `cancelled` is reachable through exactly one path — a request, then either an immediate
 * transition or a boundary the driver honoured — and this refusal is what makes that a store
 * invariant instead of a property of the current driver. A future host that decided to
 * "clean up" a stuck job by cancelling it directly gets told which step it skipped.
 */
export class JobCancellationNotRequestedError extends Error {
  override readonly name = 'JobCancellationNotRequestedError'

  constructor(readonly jobId: JobId) {
    super(
      `agent job ${String(jobId)} cannot be recorded as cancelled: no cancellation was ever ` +
        'requested for it. A job reaches the cancelled state only by being asked to, so a ' +
        'driver landing one here has skipped the request the operator never made.',
    )
  }
}

// `payloadJson` arrives serialized, so the store is not a second place the bytes are decided.
export interface ChainTerminalRecord {
  // The unique key one notification per run rests on: `runId` alone.
  readonly dedupeKey: string
  // Candidates, not members: a derived chain id is no promise that a row exists.
  readonly candidateJobIds: readonly JobId[]
  /** Canonical JSON of the `RunNotification` this terminal would record. */
  readonly payloadJson: string
}

/** One row of the deterministic logical dump. Column names, not the DTO shape. */
export interface JobStoreDumpRow {
  readonly id: string
  readonly kind: string
  readonly idempotencyKey: string
  readonly status: string
  readonly summary: string
  readonly payload: unknown
  readonly attempts: number
  readonly claimed: boolean
  // A flag, not a status: a running job asked to stop is not in a terminal state.
  readonly cancelRequested: boolean
  // Lives on the diagnostic projection, the only one a retired-kind row can travel through.
  readonly conclusionKind?: JobConclusionKind
  readonly createdAt: string
  readonly updatedAt: string
}

// The kill matrix compares this, never raw database bytes, whose page layout is not deterministic.
export interface JobStoreDump {
  readonly schemaVersion: number
  readonly epoch: number
  readonly jobs: readonly JobStoreDumpRow[]
}

export interface JobStorePort {
  /**
   * Record `epoch` as the authority that may now drain, and hand back the fence proving it.
   * Adopting an epoch BELOW the recorded one is refused: authority only moves forward.
   */
  adoptEpoch(epoch: number): Promise<JobStoreFence>

  // Fence-free: the unique index arbitrates concurrent enqueues.
  enqueue(request: JobInsert): Promise<JobEnqueueOutcome>

  /**
   * Offer the next claimable row, honouring an optional kind exclusion in the SELECTION
   * itself — an excluded row is never claimed, so its status, claim and attempt count are
   * untouched (see `ClaimNextOptions`).
   *
   * `options` is OPTIONAL for a reason worth keeping: TypeScript accepts an implementation
   * that declares fewer parameters, so every existing store and every fake in the repo keeps
   * compiling untouched, and the corpus of things that must change is exactly the things
   * that must BEHAVE differently.
   */
  claimNext(fence: JobStoreFence, options?: ClaimNextOptions): Promise<JobClaimOutcome>

  // One transaction terminates the job and enqueues successors, so a crash cannot lose the chain.
  completeAndChain(
    jobId: JobId,
    next: readonly JobInsert[],
    fence: JobStoreFence,
    chainTerminal?: ChainTerminalRecord,
  ): Promise<JobCompleteOutcome>

  // One fenced transaction, so a crash exposes neither half or both.
  failAndChain(
    jobId: JobId,
    disposition: Extract<JobFailureDisposition, { readonly kind: 'permanent' }>,
    next: readonly JobInsert[],
    fence: JobStoreFence,
    chainTerminal?: ChainTerminalRecord,
  ): Promise<JobFailAndChainOutcome>

  recordFailure(
    jobId: JobId,
    disposition: JobFailureDisposition,
    fence: JobStoreFence,
  ): Promise<void>

  // Refund an aborted attempt and free its claim, keeping last failure, not-before and started_at.
  releaseInterrupted(jobId: JobId, fence: JobStoreFence): Promise<void>

  /**
   * Durably publish one checkpoint. The store records the canonical payload and digest in
   * the same fenced transaction that touches the job. A file may be written afterward as a
   * cross-process projection, but that projection never becomes the source of authority.
   */
  publishCheckpoint(
    jobId: JobId,
    checkpointId: string,
    payload: JobCheckpointRecord,
    fence: JobStoreFence,
  ): Promise<void>

  // Fenced, or a writer that lost its lease could cancel the current writer's running work.
  requestCancel(jobId: JobId, fence: JobStoreFence): Promise<JobCancelOutcome>

  /**
   * Land a job that was asked to stop, releasing its claim. THE DRIVER'S verb, not a caller's.
   *
   * Separate from `requestCancel` because they are opposite ends of the protocol: one records
   * an intention against a job somebody else is running, the other completes it from inside
   * the run. Refuses with `JobCancellationNotRequestedError` when no request exists, which is
   * what keeps `cancelled` unreachable except through the two-step path.
   */
  recordCancellation(jobId: JobId, fence: JobStoreFence): Promise<void>

  // Reset and checkpoint forget share one fenced transaction, or a stand-in's authorship replays.
  requeueTerminal(jobId: JobId, fence: JobStoreFence): Promise<JobRequeueOutcome>

  /**
   * Read-side: no fence, because reading claims no authority.
   *
   * Returns the authoritative payload recorded under the fence. A concrete store may serve
   * a file projection only after validating its digest against that record; a missing or
   * mismatched projection falls back to the authoritative record, never to bare file bytes.
   */
  readCheckpoint(jobId: JobId, checkpointId: string): Promise<JobCheckpointReadOutcome>

  dumpState(): Promise<JobStoreDump>
}
