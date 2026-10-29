// The agent job queue's store port.
//
// This port is deliberately NOT generic CRUD. `PersistencePort`'s `saveJob`/`getJob` shape
// let a caller express any interleaving it liked and left atomicity to review; here every
// verb is ONE store transaction with a name for what it means, so a wrong interleaving is
// not a bug the reviewer has to catch — it is a sentence the type surface cannot form
// The engine keeps policy (what may chain, how many attempts); the store keeps
// atomicity. Every verb is promise-returning so a store may be asynchronous, even though
// the phase-385 implementation happens to be synchronous underneath.
//
// FENCING. Every DRAIN-side verb — the ones only the process currently entitled to
// drain the queue may call — takes a `JobStoreFence` and the store re-reads the recorded
// epoch INSIDE the same transaction before mutating. The fence is present from birth rather
// than added when the second writer arrives in 386, because retrofitting it onto a live
// unfenced port means redesigning the commit boundary while split-brain is already possible.
//
// `enqueue` is fence-FREE, and that is the resolution of the D-02/D-07 tension rather than
// an oversight: D-02 says any process may enqueue directly against the database, so an
// enqueue fence would be a token no enqueuer could hold. Enqueue needs no authority because
// it arbitrates on data instead — the `(kind, idempotencyKey)` unique index makes a losing
// concurrent enqueue a dedupe, not a conflict. Authority is only ever needed to
// CLAIM or ADVANCE work, which is exactly the set of verbs that carries the fence.

import type {
  Job,
  JobConclusionKind,
  JobEnqueueRequest,
  JobId,
  JobKind,
  JobStatus,
} from '@vostride/agent-qa-schema'

/**
 * The authority token a drain-side verb must present.
 *
 * Deliberately a plain epoch record, not an opaque handle: 386 binds the v51 writer lease
 * as its source, and that lease's authority already IS an integer epoch on disk.
 */
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

/**
 * Refusal at the mutation boundary, mirroring v51's `WriterAuthorityLostError` shape: a
 * named class carrying both the epoch the caller held and the epoch the store observed, so
 * a log line says which writer was behind and by how much.
 */
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

/**
 * One job row to insert: a caller's `JobEnqueueRequest` plus what the engine resolved for it.
 *
 * 385 plan 02 split this from the request DTO rather than duplicating it. The request is the
 * three facts a CALLER knows; the two fields added here are derived at the engine boundary
 * and belong to nobody else. The id is derived from `(kind, idempotencyKey)` through an
 * injected id source, so the same logical job carries the same id in every process and in
 * every replay (D-03 corollary) — a store that minted its own would break that, and a caller
 * that supplied its own could break it twice. Timestamps are absent on purpose: the store
 * stamps them from ITS injected clock, so no SQL-side default can leak host time into a dump.
 *
 * There is no separate "chained enqueue" type. A successor differs from a root job in who
 * asked for it, not in what it is, and the difference that does matter — a successor is
 * inserted inside its predecessor's transaction — is expressed by the verb it arrives at.
 */
export interface JobInsert extends JobEnqueueRequest {
  readonly id: JobId
  readonly summary: string
}

/**
 * Refusal when an operator tries to requeue a row this build cannot read.
 *
 * A requeue is the one operator verb that DESTROYS history — it resets the attempt count, deletes
 * every checkpoint row and file the last attempt recorded, and disowns the run's chain-terminal
 * notification. For an ordinary terminal row that is the whole point: the row goes back so a fixed
 * handler can run it again. For a quarantined row there is no handler to run it again — no kind
 * registry contains its kind — so the reset would spend the remedy and buy nothing: the very next
 * claim would quarantine the row a second time, and the spent attempt and the fixed reason that
 * recorded WHY it was quarantined would be gone.
 *
 * Raised INSIDE the requeue's transaction and before any of those three media is touched, so a
 * refused requeue leaves the store byte-identical.
 *
 * THE MESSAGE DOES NOT NAME THE KIND, and that is the same rule
 * `QUARANTINED_UNREADABLE_KIND_REASON` states for `last_failure_reason`: the unreadable kind is
 * a string an EARLIER build -- or anything with write access to that database -- put in a
 * column, and this message is rendered on operator terminals and copied into logs.
 * Interpolating it here took the one field of the row this build refuses to trust and pasted it
 * into the one place an operator is most likely to read without thinking. The value stays on
 * `unreadableKind`, where a caller has to ask for it and knows what it is when they do --
 * exactly where the `kind` column keeps it.
 */
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

/**
 * The result of an enqueue.
 *
 * `deduped` reports that the unique index already held this `(kind, idempotencyKey)` pair
 * and `job` is the pre-existing row. A duplicate enqueue is a SUCCESS, never an error —
 * that is what makes "run the tail twice, get one job" a store guarantee rather than a
 * convention every caller has to remember.
 */
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

/**
 * What a claim may be told is not its to take (Phase 388-09, G-388-2 substrate).
 *
 * The exclusion is an OWNERSHIP declaration: a host names the kinds it may not claim, fixed
 * when its queue is composed. A kind on this list must be left exactly as the claim found it
 * — never claimed and released — because per D-18 the attempt is spent AT the claim, and
 * (388-09 Task 1, M-2) a released row is re-offered ahead of every younger row, so a
 * claim-then-release "refusal" either burns the row's bound or starves every other kind
 * behind it for as long as the row exists. The only refusal that writes no receipt and
 * costs nothing is one where the excluded row is never offered at all.
 */
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

/**
 * How a failed attempt should be disposed of. Behaviour lands with the retry plan.
 *
 * This is NOT a second spelling of the handler's `JobHandlerOutcome`, and the two are kept
 * apart deliberately (385 plan 02). The handler REPORTS whether the thing that went wrong
 * could go right next time; the engine DECIDES what to record, and only the engine knows how
 * many attempts remain. A retryable report on the last permitted attempt becomes a permanent
 * disposition here — which is exactly the bound D-18 puts on retries, and it would have
 * nowhere to live if the report and the decision were one type.
 */
export type JobFailureDisposition =
  | { readonly kind: 'retry'; readonly reason: string; readonly retryAfterMs?: number }
  | { readonly kind: 'permanent'; readonly reason: string }

export type JobCheckpointReadOutcome =
  | { readonly found: false }
  | { readonly found: true; readonly payload: unknown }

/**
 * What asking to cancel a job actually did.
 *
 * Three outcomes, because cancellation genuinely has three cases and collapsing any two of
 * them loses a guarantee. A job nobody is running stops at once — there is nothing to be
 * cooperative about. A job in flight only records the REQUEST: terminating its row out from
 * under a running handler would abandon a half-finished step and leave whatever it was part
 * way through with no owner, so the driver honours the request at its next checkpoint boundary
 * instead. A job that has already finished, failed or been cancelled reports what it is and
 * nothing moves — a cancel is not an eraser.
 */
export type JobCancelOutcome =
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'cancel-requested' }
  | { readonly outcome: 'already-terminal'; readonly status: JobStatus }

/**
 * What returning a finished job to the queue actually did (413 D-04/D-06 gap closure).
 *
 * A requeue is an OPERATOR's explicit act under the fence, not a lifecycle transition any
 * handler can reach. It exists because Phase 413's pump composed without the post-run
 * capabilities, the kind registry selected the STAND-IN analyze-run handler, and nineteen
 * rows reached `done` with a checkpoint recorded and nothing authored — a completion the
 * queue has no vocabulary to disown.
 *
 * `requeued` returns the row to `queued` with its attempts reset AND everything its last
 * attempt recorded FORGOTTEN in all three durable media, because they are one remedy rather
 * than three tidy-ups. The checkpoint rows and the checkpoint files go because `readCheckpoint`
 * resolves the LATEST recorded value across attempts, so a reset that kept the stand-in's
 * `verdicts-authored` row would hand the real handler the stand-in's value on the next attempt
 * and it would report completion having written nothing — the very substitution the requeue
 * exists to undo, performed a second time by the recovery path. The chain-terminal notification
 * the attempt minted for the run this job's payload names goes for a stronger reason: the
 * store's insert dedupes on the run (`ON CONFLICT (run_id) DO NOTHING`), so a receipt that
 * survives a requeue can never be replaced by the re-run — it would keep publishing an outcome
 * for an attempt whose every other trace the same transaction just deleted.
 *
 * What the requeue does NOT touch is the row's identity: the id and the
 * `(kind, idempotencyKey)` pair survive, so the chain identity `chainJobIdsForRun` derives
 * from the run id still addresses this row and a re-chained successor dedupes onto the
 * existing slot instead of doubling it. Enqueueing a fresh job under a new key would have
 * been the easier remedy and the wrong one.
 *
 * `not-terminal` is a refusal, and it carries the status it found. A queued or claimed job
 * belongs to a drainer: requeueing one would reset the attempt count out from under a
 * handler that is running, which is the two-writers-under-one-fence tampering the fence
 * exists to exclude.
 */
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

/**
 * What a chain-terminal transition asks the store to record, if it really is terminal
 *
 * The 385 D-05 split, applied to a new decision. POLICY is already resolved by the time this
 * record exists: the engine decided which run this job belongs to, which ids the chain could
 * have enqueued, and what the notification should say. What the STORE decides is the only
 * part that cannot be decided outside a transaction — whether every candidate that exists is
 * terminal at the instant of the write, and whether this run has been notified already.
 *
 * `payloadJson` arrives serialized rather than as a value, and that is deliberate: the record
 * crosses a storageNeutral port into a store whose column is text, and canonical
 * serialization is a shipped primitive. A store that serialized it would be a second place
 * the bytes are decided, and the two would differ on the first key-order question.
 *
 * The parameter is OPTIONAL on both terminal verbs and defaults absent, so every existing
 * caller — the store-contract suite, the kill matrix, every kind that is not a chain member —
 * compiles and behaves exactly as before. A record that arrives for a chain that turns out
 * NOT to be terminal is not an error: the store simply writes nothing.
 */
export interface ChainTerminalRecord {
  /** The UNIQUE key one notification per run rests on. `runId` alone. */
  readonly dedupeKey: string
  /**
   * Every job the chain COULD have enqueued, whether or not it did.
   *
   * Candidates rather than members, because a derived chain id is not a promise that a row
   * exists. `chainJobIdsForRun` derives EVERY one of the chain's ids from the run id alone, up
   * front, while the rows appear one at a time: each successor is enqueued only once its
   * predecessor chains, and a deduped or halted chain leaves a derived id no row will ever
   * carry. The store's rule is therefore stated over the candidates that EXIST — a successor
   * that has not been written yet cannot be read as a finished one, so the terminal cannot fire
   * a job early. The head is the one exception and is checked by name: a chain whose analyze-run
   * row was never written is not a run's chain at all.
   *
   * the chain narrowed to two ids.
   * three again, the third being the proposal stage the fold now
   * chains to. The candidate/member distinction is what carries that widening for free — a
   * chain halted at a permanently failed fold has no proposal row, and the rule reads it as the
   * absence it is rather than as an unfinished stage that blocks the record forever.
   */
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
  /**
   * Someone has asked for this job to stop.
   *
   * Store-owned state, exactly like `claimed`, and for the same reason: `JobStatus` is a
   * shipped kernel vocabulary whose C6 break added the two TERMINAL members the queue needed,
   * and "a running job that has been asked to stop" is not a terminal state — it is a fact
   * about what has been asked of a job that is still queued. Adding a status member for it
   * would be a second contract break to describe something no observer of the row needs to
   * treat as a lifecycle stage.
   */
  readonly cancelRequested: boolean
  /**
   * What this row CONCLUDED, when the store can say it from the row alone.
   *
   * Present today for exactly one conclusion, `unreadable_kind`: a row written under a kind this
   * build has since retired, landed permanently at claim without ever being parsed. It belongs on
   * the DIAGNOSTIC projection rather than on `Job` because that is the only projection such a row
   * can travel through at all — `Job.kind` is the strict five-kind enum, so a quarantined row is
   * precisely the row the typed DTO cannot carry. Naming the column-shaped facts here is what lets
   * a listing describe it instead of throwing on it.
   *
   * ABSENT means "this row concluded nothing the store can name", which includes an ordinary
   * `done` row and a retired-kind row still sitting queued. It is not a summary of the status.
   */
  readonly conclusionKind?: JobConclusionKind
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * A deterministic, ordered, canonical-JSON-comparable projection of everything the store
 * holds. The kill matrix compares THIS across an interrupted and an uninterrupted history —
 * never raw database bytes, whose page layout is not deterministic.
 */
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

  /** Fence-free by design — see the D-02/D-07 note at the top of this module. */
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

  /**
   * Terminate one job and enqueue its declared successors in the SAME transaction. Two
   * verbs would leave a window where a crash loses the chain; one verb has no window.
   *
   * `chainTerminal`, when supplied, joins that same transaction: the notification
   * a replayed terminal re-attempts dedupes on a unique index rather than on a caller's
   * memory of having written it.
   */
  completeAndChain(
    jobId: JobId,
    next: readonly JobInsert[],
    fence: JobStoreFence,
    chainTerminal?: ChainTerminalRecord,
  ): Promise<JobCompleteOutcome>

  /**
   * Land one permanent failure and enqueue every declared continuation in the SAME fenced
   * transaction. A stale or crashing host therefore exposes neither half or both halves,
   * never a terminal parent with a partial chain (or an orphaned chain with a live parent).
   *
   * Carries the same optional chain-terminal record as its sibling, and that symmetry is
   * a failure is exactly when the user most needs to hear from the chain, so the
   * notification cannot live on the success path alone.
   */
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

  /**
   * Ask for a job to stop, and report what that meant for the job it found.
   *
   * Fenced like every other verb that moves a job, and for the sharper reason: a writer that
   * has lost its lease could otherwise cancel work the current writer is actively running.
   * One transaction, so the decision between "stop it now" and "ask it to stop" is made
   * against the same row state it is then written to.
   */
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

  /**
   * Return a FINISHED job to the queue, forgetting what its last attempt recorded.
   *
   * Terminal is exactly `done | failed | cancelled` — the store's own `TERMINAL_JOB_STATUSES`
   * — and anything else answers `not-terminal` having moved nothing. The lifecycle reset and
   * the checkpoint forget are ONE fenced transaction, because a row that reads `queued` while
   * its checkpoints still exist is precisely the state that replays a stand-in's recorded
   * authorship as though a handler had produced it.
   *
   * An id no row answers to raises the store's existing not-found error rather than gaining a
   * third outcome arm: the outcome union describes what the store found a JOB
   * to be, and a mismatched id is a caller bug, not data.
   */
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
