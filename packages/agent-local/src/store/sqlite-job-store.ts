// The agent job queue's durable lifecycle store.
//
// Built on Node's own sqlite binding, so the queue adds ZERO runtime dependencies
// while still getting real transactions and a real unique index. Every compound verb of
// `JobStorePort` is exactly one `BEGIN IMMEDIATE ... COMMIT` here: the binding is
// synchronous, so a verb cannot interleave with another verb in this process, and
// `BEGIN IMMEDIATE` plus a busy timeout covers the writer in the next process.
// There is no transaction helper in the binding, so every one of them is written out and
// the catch-block rollback is guarded on `isTransaction` — rolling back when no transaction
// is open throws, which would replace the real error with a confusing one.
//
// One thing this file deliberately does NOT do is invent a claim STATUS. `JobStatus` is a
// shipped kernel vocabulary that the C6 break extended by exactly two terminal members, and
// a job in flight is not a new public state — it is a fact about who holds it. So the claim
// lives in a `claimed_at` column the store owns, and the row's published status stays the
// one the contract already names.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  JobCancellationNotRequestedError,
  MissingIdempotencyKeyError,
  QuarantinedJobRequeueError,
  StaleJobStoreEpochError,
} from '@vostride/agent-qa-agent'
import type {
  ChainTerminalRecord,
  ClaimNextOptions,
  ClockPort,
  JobCancelOutcome,
  JobCheckpointRecord,
  JobCheckpointReadOutcome,
  JobClaimOutcome,
  JobCompleteOutcome,
  JobEnqueueOutcome,
  JobFailureDisposition,
  JobInsert,
  JobRequeueOutcome,
  JobStoreDump,
  JobStoreDumpRow,
  JobStoreFence,
  JobStorePort,
} from '@vostride/agent-qa-agent'
import {
  canonicalJson,
  guardRunNotification,
  isJobKind,
  jobSchema,
  sha256hex,
} from '@vostride/agent-qa-schema'
import type {
  Job,
  JobConclusionKind,
  JobId,
  JobStatus,
  RunNotification,
} from '@vostride/agent-qa-schema'

import type { JobCheckpointStore } from './job-checkpoint-store.js'
import { canonicalLogicalDump, createLogicalDump, selectOrderedRows } from './logical-dump.js'
import type { LogicalDump } from './logical-dump.js'
import { JobStoreSchemaVersionError, UnknownJobRowError } from './store-errors.js'

/**
 * Stamped into `PRAGMA user_version` at creation and checked on every open.
 *
 * Stamp and hard-fail, never migrate. The milestone ships nothing between its releases, so a
 * database written by another build is a development artifact rather than a user's history,
 * and migration machinery for it would be code with no user that everything afterwards has
 * to keep working.
 */
export const AGENT_JOB_STORE_USER_VERSION = 2

/**
 * Busy timeout for every connection to the job database.
 *
 * D-02's whole cross-process story is "several processes write small transactions and
 * sqlite arbitrates", which only works if a writer waiting on the write lock retries rather
 * than failing immediately. The binding's constructor `timeout` option is that retry
 * window.
 */
export const AGENT_JOB_STORE_BUSY_TIMEOUT_MS = 2000

/** The store's own file name under the agent-qa root, per the D-21 naming. */
export const AGENT_JOB_STORE_DB_FILE = 'agent-jobs.db'

export interface CreateSqliteJobStoreOptions {
  /** Absolute path to the database file, typically `<root>/agent-jobs.db`. */
  readonly path: string
  readonly clock: ClockPort
  readonly checkpoints: JobCheckpointStore
  readonly timeoutMs?: number
  readonly hooks?: SqliteJobStoreHooks
}

/** Test-only observation points around cross-media publication. Production omits them. */
export interface SqliteJobStoreHooks {
  /** Runs after the fenced row commits and immediately before the checkpoint file is replaced. */
  readonly beforeCheckpointFilePublish?: () => void | Promise<void>
}

/** One chain-terminal notification row, with its payload guarded on the way out. */
export interface JobStoreNotification {
  readonly runId: string
  readonly payload: RunNotification
  readonly createdAt: string
}

export interface SqliteJobStore extends JobStorePort {
  close(): void

  /**
   * The chain-terminal notifications this database holds, ordered by run.
   *
   * On the implementation rather than the neutral port, beside `logicalDump`, and for the
   * same reason: the port is the ENGINE's vocabulary and the engine never reads a
   * notification — it writes one, once, as part of ending a job. Every reader of these rows
   * is a surface, and 388 D-14 routes surfaces through the function layer, not through here.
   *
   * The payload is parsed through the schema guard rather than handed back as text: the
   * column is bytes another build could have written, and a row that lost a stage cannot be
   * allowed to travel as a `RunNotification`.
   */
  listNotifications(): Promise<readonly JobStoreNotification[]>

  /**
   * The D-03 comparison basis, in full: every table this database holds plus a digest per
   * checkpoint file.
   *
   * Kept beside `dumpState()` rather than replacing it, because the two answer different
   * questions and collapsing them would weaken both. `dumpState()` is the typed, engine-facing
   * projection of the job rows and it is part of the neutral port. This one is the storage
   * implementation's own full-state instrument: it knows about the checkpoint directory and
   * about tables the port has no vocabulary for, and it is the thing a crash comparison holds
   * up against another run.
   */
  logicalDump(): Promise<LogicalDump>

  /** The same dump as one comparable string. Byte equality here is state equality. */
  dumpLogicalState(): Promise<string>
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS jobs (
     id              TEXT PRIMARY KEY,
     kind            TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     status          TEXT NOT NULL,
     summary         TEXT NOT NULL,
     payload         TEXT NOT NULL,
     attempts        INTEGER NOT NULL,
     claimed_at      TEXT,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL,
     -- The disposition the engine DECIDED, recorded so a failed job says why it failed.
     -- Nullable because most rows never fail; written only by recordFailure.
     last_failure_kind   TEXT,
     last_failure_reason TEXT,
     -- When somebody asked this job to stop (D-19). A column rather than a status, for the
     -- same reason the claim is one: the job status vocabulary describes lifecycle stages,
     -- and "still queued, but asked to stop" is a fact about a request, not a stage.
     -- Appended LAST deliberately - a column inserted in the middle would move every
     -- positional read of this table for no gain.
     cancel_requested_at TEXT,
     -- The instant this row was FIRST claimed, kept after the lease is released (425). The
     -- claim column answers who holds the row now; no column answered how long the work took.
     -- Written once by the claim, cleared only by the operator requeue. Appended last, as above.
     started_at TEXT,
     -- 444.1 D-23: a retrying row is not claimable before this instant. Appended last, as above.
     not_before TEXT
   )`,
  // D-08's dedupe is THIS line. Making it a store-level constraint rather than a check the
  // caller performs is what turns "two enqueues of the same work produce one job" from a
  // convention into something no caller, in any process, can get wrong.
  `CREATE UNIQUE INDEX IF NOT EXISTS jobs_kind_idempotency_key
     ON jobs (kind, idempotency_key)`,
  `CREATE TABLE IF NOT EXISTS job_store_fence (
     id    INTEGER PRIMARY KEY CHECK (id = 1),
     epoch INTEGER NOT NULL
   )`,
  // The row is the authoritative checkpoint. The file remains a durable projection for
  // cross-process observability, but recovery accepts its bytes only when their digest agrees
  // with the latest fenced row for this job/checkpoint. Attempt stays in the key so retries
  // preserve their recorded history while a same-attempt takeover replaces only that attempt.
  `CREATE TABLE IF NOT EXISTS job_checkpoints (
     job_id         TEXT NOT NULL,
     checkpoint_id  TEXT NOT NULL,
     attempt        INTEGER NOT NULL,
     payload_json   TEXT NOT NULL,
     payload_digest TEXT NOT NULL,
     epoch          INTEGER NOT NULL,
     PRIMARY KEY (job_id, attempt, checkpoint_id)
   )`,
  // the chain-terminal record, beside the jobs it summarizes rather than in a
  // second durable medium. `created_at` is written from the injected clock like every other
  // timestamp in this file — a SQL-side default would leak host time into the D-03 dump and
  // make two identical histories compare unequal.
  `CREATE TABLE IF NOT EXISTS notifications (
     run_id     TEXT NOT NULL,
     payload    TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  // D-10's dedupe is THIS line, and it is the same idiom as the jobs index above for the same
  // reason: a crash-replayed chain terminal re-attempts the insert, and "one notification per
  // run, ever" has to be something no caller — in this process or the next — can get wrong.
  `CREATE UNIQUE INDEX IF NOT EXISTS notifications_run_id
     ON notifications (run_id)`,
] as const

/** The statuses a job never leaves. A cancel arriving at one of them moves nothing. */
const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['done', 'failed', 'cancelled']

/**
 * The conclusion a quarantined row records. A CONCLUSION, never a kind.
 *
 * Declared as `JobConclusionKind` rather than inferred, so removing the member from the shipped
 * vocabulary fails to compile HERE as well as in the schema's own contract tests — the store may
 * not go on recording an outcome the contract no longer publishes.
 */
const UNREADABLE_KIND_CONCLUSION: JobConclusionKind = 'unreadable_kind'

/**
 * The FIXED reason a quarantine writes, carrying none of the bytes it is about.
 *
 * Masked deliberately. The unreadable kind is a string an EARLIER build — or anything with write
 * access to this database — put in a column, and `last_failure_reason` is rendered on operator
 * terminals and copied into logs. Interpolating it here would take the one field of the row this
 * build refuses to trust and paste it into the one place an operator is most likely to read
 * without thinking. The original kind stays in the `kind` column, where a reader has to ask for it
 * and knows what it is when they do.
 */
export const QUARANTINED_UNREADABLE_KIND_REASON =
  'agent job quarantined at claim: this build does not read the kind recorded for this row, so '
  + 'the row was landed permanently without being parsed. The original kind, id and payload are '
  + 'preserved in the row for inspection.'

/**
 * How many rows one claim will pass over before it gives up.
 *
 * The quarantine loop below is already monotone — every iteration either returns a claim or moves
 * a row out of the claimable set — so this bound is unreachable by construction. It is here for
 * the same reason `AGENT_JOBS_PUMP_BOUND` is: an unbounded loop inside a write transaction is not
 * something to leave resting on an argument, and a store that somehow stopped shrinking its own
 * queue must say so rather than spin holding the write lock.
 */
const QUARANTINE_SCAN_BOUND = 1_000

/**
 * Whether this row's kind is one this build cannot read.
 *
 * Asked of the RAW column, before `rowToJob`, and that ordering is the entire fix. `claimNext`
 * spends the attempt at the claim and then parses; a kind the contract does not contain
 * threw out of `jobSchema.parse` INSIDE the transaction, so `inTransaction` rolled the spent
 * attempt back with it and the very next claim was offered the same row again — a crash-loop
 * reached with no crash, starving every valid row behind it. Recognising the row here means the
 * quarantine and the attempt commit together.
 */
function isUnreadableKindRow(row: Record<string, unknown>): boolean {
  return !isJobKind(String(row.kind))
}

/**
 * The conclusion a quarantined row is READ back with — derived, never a column.
 *
 * Derived because it is derivable: the three facts below are already on the row, which is why 422
 * declined a column for it under D-04's stamp-and-hard-fail rule. The durable record IS the three
 * facts this reads — an unreadable kind, a permanent landing, and the fixed reason above — and the
 * conclusion is their name rather than a fourth fact that could disagree with them. It is
 * deliberately NOT "any row whose kind is unreadable": a retired-kind row still sitting queued has
 * not been quarantined yet, and saying it had would be a receipt for an event that has not happened.
 */
function quarantineConclusionOf(row: Record<string, unknown>): JobConclusionKind | undefined {
  if (!isUnreadableKindRow(row)) return undefined
  if (String(row.status) !== 'failed') return undefined
  if (String(row.last_failure_kind) !== 'permanent') return undefined
  if (String(row.last_failure_reason) !== QUARANTINED_UNREADABLE_KIND_REASON) return undefined
  return UNREADABLE_KIND_CONCLUSION
}


/**
 * The run a job's payload column names, if it names one as a non-empty string.
 *
 * `chainTerminalFor`'s predicate verbatim (`engine.ts`), and it has to be verbatim: the key that
 * function derives IS the `notifications.run_id` a terminal writes, because `dedupeKey` is the
 * run id and nothing else. A looser reader here would disown a receipt no requeue is entitled to
 * disown; a stricter one would leave behind a receipt `ON CONFLICT (run_id) DO NOTHING` can never
 * replace. The column is bytes this store's own `enqueue` wrote with `JSON.stringify`, read the
 * same way `dumpRow` reads it.
 */
function runIdOfPayloadColumn(payload: unknown): string | undefined {
  const record = JSON.parse(String(payload)) as unknown
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined
  const runId = (record as { runId?: unknown }).runId
  return typeof runId === 'string' && runId !== '' ? runId : undefined
}

function toNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

export function createSqliteJobStore(options: CreateSqliteJobStoreOptions): SqliteJobStore {
  const { clock, checkpoints, hooks } = options

  mkdirSync(dirname(options.path), { recursive: true })
  const db = new DatabaseSync(options.path, {
    timeout: options.timeoutMs ?? AGENT_JOB_STORE_BUSY_TIMEOUT_MS,
  })
  db.exec('PRAGMA journal_mode=WAL')

  // The version is read BEFORE a single schema statement runs, so a database this build
  // cannot read is not touched on the way to being refused. A hard fail that had already
  // created a table, or re-stamped the header, would be a migration nobody wrote.
  const stampedVersion = toNumber(db.prepare('PRAGMA user_version').get()?.user_version)
  if (stampedVersion !== 0 && stampedVersion !== AGENT_JOB_STORE_USER_VERSION) {
    db.close()
    throw new JobStoreSchemaVersionError(
      options.path,
      AGENT_JOB_STORE_USER_VERSION,
      stampedVersion,
    )
  }
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement)
  if (stampedVersion === 0) {
    db.exec(`PRAGMA user_version=${AGENT_JOB_STORE_USER_VERSION}`)
  }

  const insertJob = db.prepare(
    `INSERT INTO jobs
       (id, kind, idempotency_key, status, summary, payload, attempts, claimed_at,
        created_at, updated_at, last_failure_kind, last_failure_reason,
        cancel_requested_at, started_at, not_before)
     VALUES (?, ?, ?, 'queued', ?, ?, 0, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL)
     ON CONFLICT (kind, idempotency_key) DO NOTHING`,
  )
  const selectByKey = db.prepare('SELECT * FROM jobs WHERE kind = ? AND idempotency_key = ?')
  const selectById = db.prepare('SELECT * FROM jobs WHERE id = ?')
  const selectClaimable = db.prepare(
    `SELECT * FROM jobs
     WHERE status = 'queued' AND claimed_at IS NULL
       AND (not_before IS NULL OR not_before <= ?)
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
  )
  // The exclusion path's statements, cached by placeholder ARITY so a hot claim path never
  // re-prepares. Bound parameters only — one `?` per excluded kind — even though
  // `JobKind` is a closed vocabulary: the bound form costs nothing and removes the question
  // of a caller string ever reaching the SQL text. The predicate is the SAME
  // WHERE plus `kind NOT IN (...)`, same ORDER BY, so the only thing an exclusion changes is
  // which row the SELECT offers — never what claiming does to it (T-388-21/23).
  const selectClaimableExcluding = new Map<number, ReturnType<typeof db.prepare>>()
  function claimableStatementFor(excludedCount: number): ReturnType<typeof db.prepare> {
    const cached = selectClaimableExcluding.get(excludedCount)
    if (cached !== undefined) return cached
    const placeholders = Array.from({ length: excludedCount }, () => '?').join(', ')
    const prepared = db.prepare(
      `SELECT * FROM jobs
       WHERE status = 'queued' AND claimed_at IS NULL
         AND (not_before IS NULL OR not_before <= ?) AND kind NOT IN (${placeholders})
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    )
    selectClaimableExcluding.set(excludedCount, prepared)
    return prepared
  }
  // COALESCE because the first claim IS the start: a later claim after a retryable failure is a
  // second attempt at work that already began, and overwriting the start would time only it.
  const markClaimed = db.prepare(
    `UPDATE jobs
     SET claimed_at = ?, started_at = COALESCE(started_at, ?), attempts = attempts + 1,
         updated_at = ?
     WHERE id = ?`,
  )
  const markDone = db.prepare(
    "UPDATE jobs SET status = 'done', claimed_at = NULL, updated_at = ? WHERE id = ?",
  )
  // the quarantine landing. Terminal, claim released, reason fixed — and the row's
  // `kind`, `id` and `payload` untouched, because the point of landing it rather than deleting it
  // is that an operator can still see what an earlier build wrote. `attempts` is not named here:
  // the claim immediately above this statement already spent it, and this transaction commits
  // both, which is the difference between a spent attempt and a rolled-back one.
  const markQuarantined = db.prepare(
    `UPDATE jobs
     SET status = 'failed', claimed_at = NULL, last_failure_kind = 'permanent',
         last_failure_reason = ?, updated_at = ?
     WHERE id = ?`,
  )
  const touchJob = db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?')
  // Two statements, because the two dispositions are two different outcomes: a retryable
  // failure releases the claim and leaves the row queued for the next attempt, while a
  // permanent one is terminal. Whether a retryable REPORT becomes a retry disposition at all
  // is the engine's call under D-18's bound — the store records the decision, never makes it.
  const markRetryable = db.prepare(
    `UPDATE jobs
     SET claimed_at = NULL, last_failure_kind = 'retry', last_failure_reason = ?,
         updated_at = ?, not_before = ?
     WHERE id = ?`,
  )
  // An aborted attempt did not fail, so its attempt is refunded and its claim released. The last
  // failure, not-before and started_at are kept; a first attempt's start is the refunded claim's.
  const markInterrupted = db.prepare(
    `UPDATE jobs
     SET claimed_at = NULL, attempts = MAX(attempts - 1, 0), updated_at = ?
     WHERE id = ?`,
  )
  const markFailed = db.prepare(
    `UPDATE jobs
     SET status = 'failed', claimed_at = NULL, last_failure_kind = 'permanent',
         last_failure_reason = ?, updated_at = ?
     WHERE id = ?`,
  )
  // The two halves of D-19, as two statements, because they are two different transitions.
  // One stops a job nobody is running; the other only records that somebody asked, and leaves
  // the row exactly as claimable as it was so the driver can finish its step.
  const markCancelledNow = db.prepare(
    `UPDATE jobs
     SET status = 'cancelled', claimed_at = NULL, cancel_requested_at = ?, updated_at = ?
     WHERE id = ?`,
  )
  const markCancelRequested = db.prepare(
    'UPDATE jobs SET cancel_requested_at = ?, updated_at = ? WHERE id = ?',
  )
  const markCancelHonoured = db.prepare(
    `UPDATE jobs
     SET status = 'cancelled', claimed_at = NULL, updated_at = ?
     WHERE id = ?`,
  )
  // The operator requeue's three statements. The UPDATE clears every column that
  // recorded HOW the row finished as well as the status itself — a requeued job that kept its
  // failure reason or its cancel request would be a queued row still carrying the verdict of
  // an attempt that no longer exists, and the next drainer would read it as its own. The start
  // goes with them: a requeued row that kept it would time a queue life that no longer exists.
  const markRequeued = db.prepare(
    `UPDATE jobs
     SET status = 'queued', claimed_at = NULL, started_at = NULL, attempts = 0,
         last_failure_kind = NULL, last_failure_reason = NULL, cancel_requested_at = NULL,
         not_before = NULL, updated_at = ?
     WHERE id = ?`,
  )
  // DISTINCT because the checkpoint key carries the attempt: one checkpoint id published
  // across two attempts is two rows and one file, and the file is discarded once.
  const selectCheckpointIdsForJob = db.prepare(
    'SELECT DISTINCT checkpoint_id FROM job_checkpoints WHERE job_id = ?',
  )
  const deleteCheckpointsForJob = db.prepare('DELETE FROM job_checkpoints WHERE job_id = ?')
  const selectFence = db.prepare('SELECT epoch FROM job_store_fence WHERE id = 1')
  const upsertFence = db.prepare(
    `INSERT INTO job_store_fence (id, epoch) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET epoch = excluded.epoch`,
  )
  const upsertCheckpoint = db.prepare(
    `INSERT INTO job_checkpoints
       (job_id, checkpoint_id, attempt, payload_json, payload_digest, epoch)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (job_id, attempt, checkpoint_id) DO UPDATE SET
       payload_json = excluded.payload_json,
       payload_digest = excluded.payload_digest,
       epoch = excluded.epoch`,
  )
  const selectLatestCheckpoint = db.prepare(
    `SELECT payload_json, payload_digest, attempt, epoch
     FROM job_checkpoints
     WHERE job_id = ? AND checkpoint_id = ?
     ORDER BY attempt DESC
     LIMIT 1`,
  )
  // ON CONFLICT DO NOTHING rather than a caller-side "already notified?" read: the read and
  // the write would be two decisions about one row, and the window between them is precisely
  // where a replayed terminal writes the second notification.
  const insertNotification = db.prepare(
    `INSERT INTO notifications (run_id, payload, created_at) VALUES (?, ?, ?)
     ON CONFLICT (run_id) DO NOTHING`,
  )
  const selectJobStatus = db.prepare('SELECT status FROM jobs WHERE id = ?')
  const selectNotifications = db.prepare(
    'SELECT run_id, payload, created_at FROM notifications ORDER BY run_id ASC',
  )
  const deleteNotificationForRun = db.prepare('DELETE FROM notifications WHERE run_id = ?')

  function inTransaction<T>(body: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      db.exec('COMMIT')
      return result
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  }

  /** No epoch adopted yet reads as epoch 0, so an un-adopted store refuses every drain. */
  function currentEpoch(): number {
    const row = selectFence.get()
    return row === undefined ? 0 : toNumber(row.epoch)
  }

  /**
   * The fence check, called from INSIDE each drain-side verb's transaction.
   *
   * Inside is the whole point: checking before `BEGIN IMMEDIATE` would leave a window in
   * which another writer adopts a newer epoch between the check and the mutation, which is
   * precisely the split-brain the fence exists to exclude. The epoch is re-read every time
   * and never cached (the v51 lease discipline).
   */
  function requireFence(fence: JobStoreFence): void {
    const observed = currentEpoch()
    if (observed !== fence.epoch) {
      throw new StaleJobStoreEpochError(fence.epoch, observed)
    }
  }

  /**
   * Every row leaves this store through the shipped zod contract.
   *
   * That is a boundary check, not ceremony: the payload column is opaque text a second
   * process wrote, and the columns around it are only as trustworthy as whatever produced
   * them. Parsing means a row that lost its attempt count or its timestamps cannot travel
   * as a `Job` — which is exactly the class of row the C6 break exists to forbid.
   */
  function rowToJob(row: Record<string, unknown> | undefined): Job {
    if (row === undefined) {
      throw new UnknownJobRowError('<missing>')
    }
    return jobSchema.parse({
      id: String(row.id),
      kind: String(row.kind),
      status: String(row.status),
      summary: String(row.summary),
      attempts: toNumber(row.attempts),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    })
  }

  function requireRow(jobId: string): Record<string, unknown> {
    const row = selectById.get(jobId)
    if (row === undefined) {
      throw new UnknownJobRowError(jobId)
    }
    return row
  }

  function insertOrGet(request: JobInsert, now: string): JobEnqueueOutcome {
    // Checked HERE and not only in the engine. D-02 lets any process open this database, so
    // the store is where dedupe is guaranteed, and an empty key satisfies the unique index
    // while collapsing every job of a kind onto one slot — the failure the guarantee exists
    // to prevent. The engine's error is reused rather than reprinted: one condition, one name.
    if (request.idempotencyKey.trim() === '') {
      throw new MissingIdempotencyKeyError(request.kind)
    }
    const changes = insertJob.run(
      String(request.id),
      request.kind,
      request.idempotencyKey,
      request.summary,
      JSON.stringify(request.payload ?? null),
      now,
      now,
    ).changes
    return {
      job: rowToJob(selectByKey.get(request.kind, request.idempotencyKey)),
      deduped: toNumber(changes) === 0,
    }
  }

  /**
   * Record the chain-terminal notification, if the chain really has terminated.
   *
   * Called from INSIDE both terminal transactions, and the placement is the guarantee: the
   * statuses it reads are the ones this very transaction just wrote, so there is no instant
   * between "the last job became terminal" and "the run was notified" for a crash to land in.
   *
   * The rule is stated over the candidates that EXIST rather than over a membership list,
   * which is what lets a candidate have an id and no row without making every
   * chain look incomplete. Its head must exist, though: a chain-member job that arrived
   * with a run id but whose analyze-run row was never written is not a run's chain at all, and
   * notifying for it would mint a dedupe key nothing else in the system agrees with.
   *
   * the reserved sixth job kind that first motivated the rule left
   * with the Issue-slot cleanup.
   */
  function recordChainTerminal(chainTerminal: ChainTerminalRecord, now: string): void {
    let headExists = false
    for (const candidate of chainTerminal.candidateJobIds) {
      const row = selectJobStatus.get(String(candidate))
      if (row === undefined) continue
      headExists ||= String(candidate) === String(chainTerminal.candidateJobIds[0])
      if (!TERMINAL_JOB_STATUSES.includes(String(row.status) as JobStatus)) return
    }
    if (!headExists) return
    insertNotification.run(chainTerminal.dedupeKey, chainTerminal.payloadJson, now)
  }

  function dumpRow(row: Record<string, unknown>): JobStoreDumpRow {
    const conclusionKind = quarantineConclusionOf(row)
    return {
      id: String(row.id),
      kind: String(row.kind),
      idempotencyKey: String(row.idempotency_key),
      status: String(row.status),
      summary: String(row.summary),
      payload: JSON.parse(String(row.payload)) as unknown,
      attempts: toNumber(row.attempts),
      claimed: row.claimed_at !== null,
      cancelRequested: row.cancel_requested_at !== null,
      // OMITTED rather than `undefined` when there is nothing to say, so a reader that
      // serializes this row does not publish an empty conclusion key for every ordinary job.
      ...(conclusionKind === undefined ? {} : { conclusionKind }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  return {
    close() {
      db.close()
    },

    async adoptEpoch(epoch: number): Promise<JobStoreFence> {
      return inTransaction(() => {
        const observed = currentEpoch()
        // Authority only ever moves forward. A store that accepted a lower epoch would let
        // a writer that already lost its lease re-arm itself simply by asking again.
        if (epoch < observed) {
          throw new StaleJobStoreEpochError(epoch, observed)
        }
        upsertFence.run(epoch)
        return { epoch }
      })
    },

    async enqueue(request: JobInsert): Promise<JobEnqueueOutcome> {
      const now = clock.now()
      return inTransaction(() => insertOrGet(request, now))
    },

    async claimNext(fence: JobStoreFence, options?: ClaimNextOptions): Promise<JobClaimOutcome> {
      const now = clock.now()
      // Honoured in the SELECT itself, never by claiming and undoing: per D-18 the attempt
      // is spent at the claim, and (388-09 M-2) a released row is re-offered ahead of every
      // younger row, so claim-and-undo would burn the bound or starve the queue.
      const excludeKinds = options?.excludeKinds ?? []
      return inTransaction(() => {
        // FIRST, and before the loop rather than inside it: a quarantine is a WRITE, so a caller
        // whose epoch the store does not recognise must be refused having moved nothing at all.
        requireFence(fence)
        for (let scanned = 0; scanned <= QUARANTINE_SCAN_BOUND; scanned += 1) {
          const row =
            excludeKinds.length === 0
              ? selectClaimable.get(now)
              : claimableStatementFor(excludeKinds.length).get(now, ...excludeKinds)
          if (row === undefined) {
            return { claimed: false }
          }
          // the attempt is counted HERE, at the claim, not when a failure is recorded.
          // A job that kills its host on every attempt records no failures at all, so a
          // failure-time counter would let it retry forever.
          markClaimed.run(now, now, now, String(row.id))
          const claimed = requireRow(String(row.id))
          // asked of the RAW row, BEFORE `rowToJob`. The landing joins the claim's own
          // transaction, so the attempt this claim just spent commits with it instead of being
          // rolled back by a parser throwing on the way out — and the loop then offers the next
          // claimable row, so several poisoned heads cost one pass rather than one per row.
          if (isUnreadableKindRow(claimed)) {
            markQuarantined.run(QUARANTINED_UNREADABLE_KIND_REASON, now, String(row.id))
            continue
          }
          // The payload travels with the claim, not on the job row's DTO: it is the opaque
          // input this kind's handler reads, and the handler is the only thing that can.
          return {
            claimed: true,
            job: rowToJob(claimed),
            payload: JSON.parse(String(claimed.payload)) as unknown,
          }
        }
        // Unreachable by construction — every iteration above either returns or moves a row to a
        // terminal status, which removes it from the claimable set. Recorded rather than trusted,
        // and a throw rather than a silent `{claimed: false}`: reaching it means the claimable
        // predicate stopped shrinking, and reporting an empty queue would hide that forever.
        throw new Error(
          `agent job claim scanned ${QUARANTINE_SCAN_BOUND} rows without reaching a claimable or `
          + 'exhausted queue; the claimable set is not shrinking, so no row was claimed and the '
          + 'transaction is rolled back rather than reporting an empty queue',
        )
      })
    },

    async completeAndChain(
      jobId: JobId,
      next: readonly JobInsert[],
      fence: JobStoreFence,
      chainTerminal?: ChainTerminalRecord,
    ): Promise<JobCompleteOutcome> {
      const now = clock.now()
      return inTransaction(() => {
        requireFence(fence)
        requireRow(String(jobId))
        markDone.run(now, String(jobId))
        // Same transaction as the completion: two transactions would leave a window where a
        // crash loses the chain while the predecessor already reads as done, and nothing
        // downstream would ever notice the successor never existed.
        const chained = next.map((request) => insertOrGet(request, now))
        if (chainTerminal !== undefined) recordChainTerminal(chainTerminal, now)
        return { job: rowToJob(requireRow(String(jobId))), chained }
      })
    },

    async failAndChain(
      jobId: JobId,
      disposition: Extract<JobFailureDisposition, { readonly kind: 'permanent' }>,
      next: readonly JobInsert[],
      fence: JobStoreFence,
      chainTerminal?: ChainTerminalRecord,
    ) {
      const now = clock.now()
      return inTransaction(() => {
        requireFence(fence)
        requireRow(String(jobId))
        markFailed.run(disposition.reason, now, String(jobId))
        // Parent transition and every insert share this transaction. If any insert raises,
        // inTransaction rolls the parent and all earlier successors back before surfacing it.
        const chained = next.map((request) => insertOrGet(request, now))
        // D-12's other half. Notify rides the failure terminal on exactly the same footing as
        // the success one, because a chain that gave up is when a user most needs to hear.
        if (chainTerminal !== undefined) recordChainTerminal(chainTerminal, now)
        return { job: rowToJob(requireRow(String(jobId))), chained }
      })
    },

    async recordFailure(
      jobId: JobId,
      disposition: JobFailureDisposition,
      fence: JobStoreFence,
    ): Promise<void> {
      const now = clock.now()
      inTransaction(() => {
        requireFence(fence)
        requireRow(String(jobId))
        // The attempt count is NOT touched here. D-18 spends it at the claim, so a job that
        // kills its host before it can report anything still exhausts its bound; incrementing
        // again on the way out would charge a reported failure twice and an unreported one
        // never.
        if (disposition.kind === 'retry') {
          // Lexical comparison in the claim holds only because both sides are toISOString().
          const notBefore =
            disposition.retryAfterMs === undefined
              ? null
              : new Date(Date.parse(now) + disposition.retryAfterMs).toISOString()
          markRetryable.run(disposition.reason, now, notBefore, String(jobId))
        } else {
          markFailed.run(disposition.reason, now, String(jobId))
        }
      })
    },

    async releaseInterrupted(jobId: JobId, fence: JobStoreFence): Promise<void> {
      const now = clock.now()
      inTransaction(() => {
        requireFence(fence)
        requireRow(String(jobId))
        markInterrupted.run(now, String(jobId))
      })
    },

    async requestCancel(jobId: JobId, fence: JobStoreFence): Promise<JobCancelOutcome> {
      const now = clock.now()
      return inTransaction(() => {
        requireFence(fence)
        const row = requireRow(String(jobId))
        const status = String(row.status) as JobStatus
        // Read and written inside ONE transaction: which of the three things a cancel means
        // depends on whether the row is claimed at this instant, and deciding that from a
        // read taken outside the transaction would let a claim land in between.
        if (TERMINAL_JOB_STATUSES.includes(status)) {
          return { outcome: 'already-terminal', status }
        }
        if (row.claimed_at !== null) {
          // In flight. The request is recorded and the row stays exactly as it was, so the
          // step the handler is part way through finishes and is checkpointed; the driver
          // stops it at the next boundary.
          markCancelRequested.run(now, now, String(jobId))
          return { outcome: 'cancel-requested' }
        }
        // Nobody is running it, so there is no step to protect and no boundary to wait for.
        // The request is stamped as well as the status, so `cancelled` never appears without
        // the record of the ask that produced it.
        markCancelledNow.run(now, now, String(jobId))
        return { outcome: 'cancelled' }
      })
    },

    async recordCancellation(jobId: JobId, fence: JobStoreFence): Promise<void> {
      const now = clock.now()
      inTransaction(() => {
        requireFence(fence)
        const row = requireRow(String(jobId))
        if (row.cancel_requested_at === null) {
          throw new JobCancellationNotRequestedError(jobId)
        }
        markCancelHonoured.run(now, String(jobId))
      })
    },

    // The 413-13 gap closure, and the checkpoint forget is its load-bearing half.
    //
    // Phase 413's pump composed with no post-run capabilities, so the kind registry selected
    // the STAND-IN analyze-run handler: nineteen rows recorded a `verdicts-authored`
    // checkpoint and reached `done` with nothing authored. Resetting the status alone would
    // not undo that, it would REPEAT it — `selectLatestCheckpoint` reads
    // `ORDER BY attempt DESC`, so the real handler's next attempt would resume on the
    // stand-in's recorded value, author nothing again, and report completion again. So the
    // rows go with the status, inside the same transaction, and the files follow the rows.
    async requeueTerminal(jobId: JobId, fence: JobStoreFence): Promise<JobRequeueOutcome> {
      const now = clock.now()
      const decided = inTransaction((): JobRequeueOutcome & { readonly discard?: string[] } => {
        requireFence(fence)
        const row = requireRow(String(jobId))
        const status = String(row.status) as JobStatus
        // 422 D-16, BEFORE the terminal check and before every write below. A quarantined row is
        // terminal, so the ordinary path would accept it and then spend the whole remedy on it:
        // the attempts reset, the checkpoint rows and files deleted, the run's chain-terminal
        // notification disowned — and the next claim would quarantine it again, because no
        // registered kind can run it. Refusing here, inside the transaction and ahead of the first
        // mutation, is what makes "the history survives an operator's mistake" a store guarantee
        // rather than a rule the surface has to remember. Checked on the RAW kind, never parsed.
        if (isUnreadableKindRow(row)) {
          throw new QuarantinedJobRequeueError(String(jobId), String(row.kind))
        }
        // Read and written in ONE transaction for the same reason a cancel is: whether this
        // row is a drainer's is a fact about the instant of the write, and a status read
        // taken outside would let a claim land in between and be reset out from under it.
        if (!TERMINAL_JOB_STATUSES.includes(status)) {
          return { outcome: 'not-terminal', status }
        }
        const discard = selectCheckpointIdsForJob
          .all(String(jobId))
          .map((checkpoint) => String(checkpoint.checkpoint_id))
        deleteCheckpointsForJob.run(String(jobId))
        // The THIRD medium, and the one that cannot be corrected later. If this row's last
        // attempt landed the chain terminal, `recordChainTerminal` wrote a `notifications` row
        // keyed on the run this payload names — and `insertNotification` is
        // `ON CONFLICT (run_id) DO NOTHING`, so a receipt left here wins forever: the re-run's
        // real handler chains a successor, which makes `chainTerminalFor` answer `undefined`
        // and offer no replacement at all. Leaving it would publish "this run's chain
        // terminated with these values" over an attempt whose every other trace this very
        // transaction is deleting. Inside the transaction with the rows for the same reason
        // they are: the three media are one disowning, or the crash between them is a state
        // recovery has no vocabulary for.
        const requeuedRun = runIdOfPayloadColumn(row.payload)
        if (requeuedRun !== undefined) deleteNotificationForRun.run(requeuedRun)
        markRequeued.run(now, String(jobId))
        return { outcome: 'requeued', discard }
      })
      // Files AFTER the authoritative rows commit — `publishCheckpoint`'s ordering, run
      // backwards, and for the same reason. The row decides what recovery believes, so a
      // crash between the commit and these removals leaves stale FILES behind a row that no
      // longer exists, which `readCheckpoint` already ignores; the opposite order would leave
      // a live row whose file is gone, and that is a real loss.
      if (decided.outcome === 'requeued') {
        for (const checkpointId of decided.discard ?? []) {
          checkpoints.discard(String(jobId), checkpointId)
        }
        return { outcome: 'requeued' }
      }
      return decided
    },

    async publishCheckpoint(
      jobId: JobId,
      checkpointId: string,
      payload: JobCheckpointRecord,
      fence: JobStoreFence,
    ): Promise<void> {
      const now = clock.now()
      const payloadJson = canonicalJson(payload)
      const payloadDigest = sha256hex(payloadJson)
      inTransaction(() => {
        requireFence(fence)
        requireRow(String(jobId))
        touchJob.run(now, String(jobId))
        // This INSERT belongs to the SAME transaction as both requireFence and the job touch.
        // Once it commits, this row decides what recovery believes; a later file writer cannot
        // change checkpoint authorship without first winning another fenced transaction.
        upsertCheckpoint.run(
          String(jobId),
          checkpointId,
          payload.attempt,
          payloadJson,
          payloadDigest,
          fence.epoch,
        )
      })
      // File AFTER the authoritative row commits: it remains the fsync'd cross-process
      // projection, but the read path digest-checks it against the row before trusting it.
      // A takeover here may let the stale host replace the file; it cannot replace the row.
      if (hooks?.beforeCheckpointFilePublish !== undefined) {
        await hooks.beforeCheckpointFilePublish()
      }
      checkpoints.publish(String(jobId), checkpointId, payload)
    },

    async readCheckpoint(
      jobId: JobId,
      checkpointId: string,
    ): Promise<JobCheckpointReadOutcome> {
      const row = selectLatestCheckpoint.get(String(jobId), checkpointId)
      if (row === undefined) return { found: false }

      const authoritative = {
        found: true as const,
        payload: JSON.parse(String(row.payload_json)) as unknown,
      }
      try {
        const projection = checkpoints.read(String(jobId), checkpointId)
        if (!projection.found) return authoritative
        const projectionDigest = sha256hex(canonicalJson(projection.payload))
        return projectionDigest === String(row.payload_digest) ? projection : authoritative
      } catch {
        // The file is a cache now. Missing, malformed, unreadable, or otherwise untrustworthy
        // projection bytes cannot block recovery from the fenced SQLite record.
        return authoritative
      }
    },

    async dumpState(): Promise<JobStoreDump> {
      return {
        schemaVersion: AGENT_JOB_STORE_USER_VERSION,
        epoch: currentEpoch(),
        // The same ordered read the logical dump uses, so the typed projection and the
        // equality instrument cannot disagree about which rows exist or in what order.
        jobs: selectOrderedRows(db, 'jobs').rows.map(dumpRow),
      }
    },

    async listNotifications(): Promise<readonly JobStoreNotification[]> {
      return selectNotifications.all().map((row) => ({
        runId: String(row.run_id),
        payload: guardRunNotification(JSON.parse(String(row.payload)) as unknown),
        createdAt: String(row.created_at),
      }))
    },

    async logicalDump(): Promise<LogicalDump> {
      return createLogicalDump({
        db,
        schemaVersion: AGENT_JOB_STORE_USER_VERSION,
        checkpointsRoot: checkpoints.checkpointsRoot,
      })
    },

    async dumpLogicalState(): Promise<string> {
      return canonicalLogicalDump(
        createLogicalDump({
          db,
          schemaVersion: AGENT_JOB_STORE_USER_VERSION,
          checkpointsRoot: checkpoints.checkpointsRoot,
        }),
      )
    },
  }
}
