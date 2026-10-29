// Lease and epoch files are fsync'd then renamed, so a kill exposes only the old or the new bytes.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { threadId } from 'node:worker_threads'

import { z } from 'zod'

import { assertWithinKnowledgeRoot } from '../knowledge-containment.js'

export const LEASE_FILE = '.lease'
export const EPOCH_FILE = '.epoch'

/** Provisional writer-heartbeat TTL; retune from operational evidence without adding config. */
export const LEASE_HEARTBEAT_TTL_MS = 30_000

/** Bounded mutation-lock takeover; retune from operational evidence without adding config. */
export const MUTATION_LOCK_TAKEOVER_MS = 45_000

/** Authority-store filename is pinned; retune only through a data-migration plan. */
export const WRITER_AUTHORITY_DB_FILE = '.writer-authority.sqlite'

/**
 * Provisional SQLite contention window; retune from operational evidence without adding config.
 *
 * The takeover deadline remains separate: this short timeout makes each failed write attempt
 * observable so the contender can apply the lease and verified-termination policy.
 */
export const MUTATION_LOCK_BUSY_TIMEOUT_MS = 2_000

// A monotonic deadline no on-disk value can move; above the takeover bound, so a reclaim fits.
export const ACQUIRE_WRITER_LEASE_DEADLINE_MS = 60_000

/** Provisional cap on one `ps` incarnation fork; retune from operational evidence without config. */
const PROCESS_INCARNATION_PS_TIMEOUT_MS = 1_000

/** Provisional floor for that cap — the bounded overshoot argued for at `psIncarnationCapMs`. */
const PROCESS_INCARNATION_PS_FLOOR_MS = 250

const PROCESS_INCARNATION_PS_PATH = '/bin/ps'
const PROCESS_INCARNATION_PS_ENV = Object.freeze({ LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' })

const MUTATION_LOCK_TERMINATION_POLL_MS = 10
const MUTATION_LOCK_TERMINATION_TIMEOUT_MS = 5_000
const MUTATION_LOCK_TERMINATION_WAIT = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
)

// Under `memory/queue/`, already gitignored, so a guard a crash leaves behind is never committed.
export const LEASE_GUARD_DIR = 'memory/queue/lease-guard'

const LEASE_GUARD_OWNER_PREFIX = 'owner-'

/** A guard older than this cannot belong to a live section (each is one read and one write). */
export const LEASE_GUARD_STALE_MS = 10_000

// Longer than the stale bound: a killed thread's guard carries a live pid, so only age clears it.
export const LEASE_GUARD_WAIT_MS = LEASE_GUARD_STALE_MS + 2_000

/** A staging directory lives at most as long as its waiter, so one older than this is a leak. */
const LEASE_GUARD_STAGING_STALE_MS = LEASE_GUARD_WAIT_MS + LEASE_GUARD_STALE_MS

const LEASE_GUARD_STAGING_PREFIX = `${basename(LEASE_GUARD_DIR)}.tmp-`

const LEASE_GUARD_RESIDUE_PREFIX = `${basename(LEASE_GUARD_DIR)}.residue-`

const LEASE_GUARD_POLL_MS = 2

const writerLeaseSchema = z
  .object({
    leaseId: z.string().uuid(),
    pid: z.number().int().positive(),
    epoch: z.number().int().positive(),
    heartbeatAtMs: z.number().int().nonnegative(),
  })
  .strict()

export type WriterLease = z.infer<typeof writerLeaseSchema>

/** What the contender could observe about the owner it gave up on; never an authority claim. */
export interface UnreclaimableMutationLockOwner {
  pid: number
  acquiredAtMs: number
  generationToken: string
  /** False when the row carries no incarnation, which is why escalation could never fire. */
  incarnationAttributed: boolean
}

export type AcquireWriterLeaseOutcome =
  | { kind: 'held'; holder: WriterLease }
  | { kind: 'acquired'; leaseId: string; epoch: number; reclaimed?: WriterLease }
  | {
      kind: 'refused'
      reason: 'corrupt-epoch-state'
      error: CorruptEpochStateError
    }
  | {
      // `code` is the raw errno, so an operator sees `EACCES`, not a silent spin.
      kind: 'refused'
      reason: 'unreadable-lease-state'
      code: string
      error: UnreadableWriterLeaseStateError
    }
  | {
      kind: 'refused'
      reason: 'mutation-lock-unreclaimable'
      // Both refusal arms carry an `error`, so every caller renders a new arm by name.
      error: WriterLeaseUnreclaimableError
      attempts: number
      waitedMs: number
      observedOwner?: UnreclaimableMutationLockOwner
      observedLease?: WriterLease
    }

export interface LeaseOperationOptions {
  knowledgeRoot: string
  leaseId: string
}

/** Test/chaos seam on the lease-file guard taken by `heartbeatLease` and `releaseLease`. */
export interface LeaseGuardHooks {
  /** Fires once, when the guard is first found held by a live section other than this caller's. */
  onLeaseGuardContended?: () => void
  /** Fires each time a guard has been judged residue, before this caller reclaims it. */
  beforeLeaseGuardReclaim?: () => void
  /** Fires inside a reclaim, after its first step and before its last. */
  duringLeaseGuardReclaim?: () => void
}

export type HeartbeatLeaseOutcome =
  | { kind: 'heartbeated'; holder: WriterLease }
  | {
      kind: 'refused'
      reason:
        | 'lease-missing'
        | 'lease-malformed'
        // The lease exists and could not be opened; nothing writes over what it cannot read.
        | 'lease-unreadable'
        | 'lease-id-mismatch'
        | 'stale-epoch'
        | 'corrupt-epoch-state'
      holder?: WriterLease
      observedEpoch?: number
      error?: CorruptEpochStateError
    }

export type ReleaseLeaseOutcome =
  | { kind: 'released' }
  | {
      kind: 'refused'
      reason: 'lease-missing' | 'lease-malformed' | 'lease-unreadable' | 'lease-id-mismatch'
      holder?: WriterLease
    }

export interface AssertEpochCurrentOptions {
  knowledgeRoot: string
  epoch: number
}

export type AssertEpochCurrentOutcome =
  | { current: true }
  | { current: false; observedEpoch: number }

/** Exact writer identity carried by governed maintenance mutators. */
export interface WriterLeaseAuthority extends LeaseOperationOptions {
  epoch: number
}

export type WriterAuthorityLostReason =
  | Extract<HeartbeatLeaseOutcome, { kind: 'refused' }>['reason']
  | 'epoch-mismatch-before-heartbeat'
  | 'epoch-mismatch-after-heartbeat'
  | 'mutation-lock-generation-lost'

/** Fail-closed maintenance refusal with the holder and fresh disk epoch attached. */
export class WriterAuthorityLostError extends Error {
  override readonly name = 'WriterAuthorityLostError'
  readonly authority: WriterLeaseAuthority
  readonly reason: WriterAuthorityLostReason
  readonly observedEpoch: number

  constructor(
    authority: WriterLeaseAuthority,
    reason: WriterAuthorityLostReason,
    observedEpoch: number,
  ) {
    super(
      `writer authority lost (${reason}); held epoch ${authority.epoch}, observed ${observedEpoch}`,
    )
    this.authority = authority
    this.reason = reason
    this.observedEpoch = observedEpoch
  }
}

export type CorruptEpochStateReason = 'unreadable' | 'malformed' | 'overflow'

/** Fail-closed authority-state error; callers must never substitute epoch zero for this state. */
export class CorruptEpochStateError extends Error {
  override readonly name = 'CorruptEpochStateError'
  readonly path: string
  readonly reason: CorruptEpochStateReason
  readonly rawPreview: string

  constructor(path: string, reason: CorruptEpochStateReason, rawPreview: string) {
    super(`writer epoch state is corrupt (${reason}) at ${path}`)
    this.path = path
    this.reason = reason
    this.rawPreview = rawPreview
  }
}

/**
 * Fail-closed acquisition refusal after the deadline; carries why the wait could not end well.
 *
 * A contender that gives up is reporting a fact about the SYSTEM, not about itself, so the
 * diagnostics travel with the error: the owner it kept losing to, whether that owner was even
 * attributable (an unattributed row can never be escalated against, which is usually the whole
 * story), and the lease it kept reading. `agent-qa daemon` prints this and exits non-zero where it
 * previously hung with no output at all.
 */
export class WriterLeaseUnreclaimableError extends Error {
  override readonly name = 'WriterLeaseUnreclaimableError'
  readonly reason = 'mutation-lock-unreclaimable' as const
  readonly attempts: number
  readonly waitedMs: number
  readonly observedOwner?: UnreclaimableMutationLockOwner
  readonly observedLease?: WriterLease

  constructor(
    attempts: number,
    waitedMs: number,
    observedOwner?: UnreclaimableMutationLockOwner,
    observedLease?: WriterLease,
  ) {
    super(
      `writer lease acquisition refused (mutation-lock-unreclaimable) after ${attempts} `
      + `attempts over ${Math.round(waitedMs)}ms; `
      + (observedOwner === undefined
        ? 'no mutation-lock owner was readable'
        : `mutation lock held by pid ${observedOwner.pid} (generation `
          + `${observedOwner.generationToken}, incarnation `
          + `${observedOwner.incarnationAttributed ? 'attributed' : 'unattributed'})`)
      + '; '
      + (observedLease === undefined
        ? 'no parseable lease on disk'
        : `lease ${observedLease.leaseId} at epoch ${observedLease.epoch} held by pid `
          + `${observedLease.pid}`),
    )
    this.attempts = attempts
    this.waitedMs = waitedMs
    if (observedOwner !== undefined) this.observedOwner = observedOwner
    if (observedLease !== undefined) this.observedLease = observedLease
  }
}

// Every refusal arm carries a throwable `error`; callers rethrow it without knowing the arm.
export class UnreadableWriterLeaseStateError extends Error {
  override readonly name = 'UnreadableWriterLeaseStateError'
  readonly path: string
  readonly code: string

  constructor(path: string, code: string) {
    super(`writer lease state is unreadable (${code}) at ${path}`)
    this.path = path
    this.code = code
  }
}

// `unreadable` (exists, cannot be opened) stays apart from `malformed`, which reads as no holder.
export type ReadWriterLeaseOutcome =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'unreadable'; code: string }
  | { kind: 'parsed'; lease: WriterLease }

function assertAbsoluteKnowledgeRoot(knowledgeRoot: string): void {
  if (!isAbsolute(knowledgeRoot)) {
    throw new TypeError('knowledgeRoot must be absolute')
  }
}

function leasePath(knowledgeRoot: string): string {
  return join(knowledgeRoot, LEASE_FILE)
}

function epochPath(knowledgeRoot: string): string {
  return join(knowledgeRoot, EPOCH_FILE)
}

function writerAuthorityDbPath(knowledgeRoot: string): string {
  return join(knowledgeRoot, WRITER_AUTHORITY_DB_FILE)
}

function bestEffortFsyncDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code !== 'ENOENT' &&
      code !== 'EINVAL' &&
      code !== 'EISDIR' &&
      code !== 'EPERM' &&
      code !== 'ENOTSUP'
    ) {
      throw error
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

interface MutationLockOwner {
  pid: number
  acquiredAtMs: number
  generationToken: string
  /** OS-reported start-time token of the process that created this row; absent when unresolvable. */
  incarnation?: string
}

// A pid can be reused, so the start time names the process; `undefined` means do not signal.
export function resolveProcessIncarnation(
  pid: number,
  timeoutMs?: number,
  psExecutable?: string,
): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    if (process.platform === 'win32') return undefined
    return process.platform === 'linux'
      ? resolveLinuxProcessIncarnation(pid)
      : resolvePosixProcessIncarnation(pid, timeoutMs, psExecutable)
  } catch {
    return undefined
  }
}

export function incarnationFormat(token: string): string {
  const separator = token.indexOf(':')
  return separator < 0 ? '' : token.slice(0, separator)
}

function resolveLinuxProcessIncarnation(pid: number): string | undefined {
  let raw: string
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return undefined
  }
  const commEnd = raw.lastIndexOf(')')
  if (commEnd < 0) return undefined
  // The first field after `comm` is `state` (field 3), so `starttime` (field 22) sits at index 19.
  const startTime = raw.slice(commEnd + 1).trim().split(/\s+/)[19]
  return startTime !== undefined && /^\d+$/.test(startTime)
    ? `proc-starttime:${startTime}`
    : undefined
}

function resolvePosixProcessIncarnation(
  pid: number,
  timeoutMs?: number,
  psExecutable: string = PROCESS_INCARNATION_PS_PATH,
): string | undefined {
  // One rendering for every reader: the caller's `PATH`, `TZ` and locale never reach `ps`.
  const observed = spawnSync(psExecutable, ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: PROCESS_INCARNATION_PS_ENV,
    windowsHide: true,
    // `spawnSync` reads 0 as "no timeout", so an exhausted budget must never arrive here as 0.
    ...(timeoutMs === undefined ? {} : { timeout: Math.max(1, Math.ceil(timeoutMs)) }),
  })
  if (observed.error !== undefined || observed.status !== 0) return undefined
  const lstart = (observed.stdout ?? '').trim()
  return lstart === '' ? undefined : `ps-lstart-utc:${lstart}`
}

const OWN_INCARNATION_UNRESOLVED = Symbol('own-incarnation-unresolved')
// A resolved token or the sentinel: memoising `undefined` would make one missed fork permanent.
let ownIncarnation: string | typeof OWN_INCARNATION_UNRESOLVED = OWN_INCARNATION_UNRESOLVED

// Memoises only a resolved token; a miss returns `undefined` and the next claim forks `ps` again.
function ownProcessIncarnation(escalation: MutationEscalationContext = {}): string | undefined {
  if (ownIncarnation !== OWN_INCARNATION_UNRESOLVED) return ownIncarnation
  const resolved = resolveProcessIncarnation(
    process.pid,
    psIncarnationCapMs(escalation),
    escalation.psExecutable,
  )
  escalation.onIncarnationResolved?.(process.pid)
  if (resolved === undefined) return undefined
  ownIncarnation = resolved
  return resolved
}

export interface MutationLockOptions {
  /** Test/chaos seam after the claim is committed and before the held transaction begins. */
  afterMutationLockClaimed?: (generationToken: string) => void
  afterMutationLockAcquired?: () => void
  /** Test/chaos seam inside acquisition, after the epoch rewrite and before lease publication. */
  afterEpochRewrite?: () => void
  mutationLockTakeoverMs?: number
  /**
   * Test-only observation of every process-incarnation resolution the escalation path performs.
   *
   * Purely an observer, never a replacement: the production resolver still runs, so what a test
   * counts is what a daemon pays. It exists because the cost being bounded (a `ps` fork per
   * resolution, on the caller's main thread) is invisible to any assertion about outcomes.
   */
  onProcessIncarnationResolved?: (pid: number) => void
  // Test-only replacement for `/bin/ps`, for a wedged process table; production never sets it.
  psExecutable?: string
}

// Escalation waits spend the caller's acquisition deadline, so the budget is passed down.
interface MutationEscalationContext {
  /** Absolute monotonic instant past which no escalation wait may continue; absent = no budget. */
  readonly deadlineAtNs?: bigint
  readonly onIncarnationResolved?: (pid: number) => void
  readonly psExecutable?: string
}

export interface AcquireWriterLeaseOptions extends MutationLockOptions {
  // Test seam that shortens the acquisition deadline; production never sets it.
  acquireDeadlineMs?: number
}

export interface CurrentWriterAuthority {
  leaseId: string
  epoch: number
}

export interface CurrentWriterAuthorityHooks extends MutationLockOptions {
  /** Test/chaos seam after the lock-held epoch comparison and before mutation. */
  afterFinalAuthorityCompare?: () => void
}

class MutationLockBusyError extends Error {
  override readonly name = 'MutationLockBusyError'
  readonly owner?: MutationLockOwner

  constructor(owner?: MutationLockOwner) {
    super('writer lease mutation lock is busy')
    this.owner = owner
  }
}

class MutationLockGenerationLostError extends Error {
  override readonly name = 'MutationLockGenerationLostError'
}

class LeaseGuardBusyError extends Error {
  override readonly name = 'LeaseGuardBusyError'
}

function mutationLockNowMs(): number {
  return new Date().getTime()
}

/**
 * Elapsed milliseconds from a `process.hrtime.bigint()` reading, immune to wall-clock movement.
 *
 * The acquisition deadline must not be extendable by anything the contended state can influence,
 * and a wall clock can be stepped backwards by NTP or by a test's own `Date.now` stub. This is the
 * external anchor the bound is measured against.
 */
function monotonicElapsedMs(startedAtNs: bigint): number {
  return Number(process.hrtime.bigint() - startedAtNs) / 1e6
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function isSqliteBusy(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR'
    && /database is (?:locked|busy)/i.test((error as Error).message)
}

function openWriterAuthorityDb(knowledgeRoot: string): DatabaseSync {
  mkdirSync(knowledgeRoot, { recursive: true })
  const db = new DatabaseSync(writerAuthorityDbPath(knowledgeRoot), {
    timeout: MUTATION_LOCK_BUSY_TIMEOUT_MS,
  })
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`PRAGMA busy_timeout = ${MUTATION_LOCK_BUSY_TIMEOUT_MS}`)
    db.exec(`
      CREATE TABLE IF NOT EXISTS mutation_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        generation_token TEXT NOT NULL,
        pid INTEGER NOT NULL CHECK (pid > 0),
        acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
        incarnation TEXT
      ) STRICT
    `)
    upgradeMutationLockSchema(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

// Racing daemons both run the `ALTER`; the loser's `duplicate column name` means success.
function upgradeMutationLockSchema(db: DatabaseSync): void {
  const columns = db.prepare(`
    SELECT name FROM pragma_table_info('mutation_lock')
  `).all() as { name: string }[]
  if (columns.some((column) => column.name === 'incarnation')) return
  try {
    db.exec('ALTER TABLE mutation_lock ADD COLUMN incarnation TEXT')
  } catch (error) {
    if (!isDuplicateMutationLockColumn(error)) throw error
  }
}

/** Classified by message beside `isMissingMutationLockTable`, which node:sqlite likewise untypes. */
function isDuplicateMutationLockColumn(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR'
    && /duplicate column name/i.test((error as Error).message)
}

function parseMutationLockOwner(value: unknown): MutationLockOwner | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  return typeof row.pid === 'number'
    && Number.isSafeInteger(row.pid)
    && row.pid > 0
    && typeof row.acquired_at_ms === 'number'
    && Number.isSafeInteger(row.acquired_at_ms)
    && row.acquired_at_ms >= 0
    && typeof row.generation_token === 'string'
    && row.generation_token !== ''
    ? {
        pid: row.pid,
        acquiredAtMs: row.acquired_at_ms,
        generationToken: row.generation_token,
        // A row written before the incarnation column existed, or by a claimant that could not
        // resolve its own start time, is deliberately left unattributed rather than guessed at.
        ...(typeof row.incarnation === 'string' && row.incarnation !== ''
          ? { incarnation: row.incarnation }
          : {}),
      }
    : undefined
}

function readMutationLockOwner(db: DatabaseSync): MutationLockOwner | undefined {
  // `SELECT *` so a store that predates the incarnation column still reads through a read-only
  // connection, which has no opportunity to upgrade the schema.
  return parseMutationLockOwner(db.prepare(`
    SELECT * FROM mutation_lock WHERE id = 1
  `).get())
}

// Absent store, missing table and busy store answer `undefined`, which callers read as no owner.
function readCommittedMutationLockOwner(
  knowledgeRoot: string,
): MutationLockOwner | undefined {
  try {
    const db = new DatabaseSync(writerAuthorityDbPath(knowledgeRoot), {
      readOnly: true,
      timeout: 0,
    })
    try {
      return readMutationLockOwner(db)
    } finally {
      db.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // A store file whose `mutation_lock` table does not exist yet reads exactly like an absent
    // store: nobody has committed a claim. This is reachable — `openWriterAuthorityDb` creates
    // the store file before `CREATE TABLE`, so a contender that loses the write lock in that
    // window arrives here and used to crash the daemon with a raw SQL logic error instead of
    // reporting contention.
    if (isMissingMutationLockTable(error)) return undefined
    // A store whose write lock is held by someone else answers nothing about who committed a
    // claim. `timeout: 0` is deliberate — this read is diagnostics on a path that has already
    // decided to refuse, so waiting on it would spend budget to learn a detail.
    if (isSqliteBusy(error)) return undefined
    throw error
  }
}

function isMissingMutationLockTable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR'
    && /no such table: mutation_lock/i.test((error as Error).message)
}

function mutationLockGenerationIsCurrent(
  db: DatabaseSync,
  generationToken: string,
): boolean {
  return readMutationLockOwner(db)?.generationToken === generationToken
}

function compareAndSwapMutationLock(
  db: DatabaseSync,
  expected: MutationLockOwner,
  replacement: MutationLockOwner,
): boolean {
  const result = db.prepare(`
    UPDATE mutation_lock
    SET generation_token = ?, pid = ?, acquired_at_ms = ?, incarnation = ?
    WHERE id = 1 AND generation_token = ?
  `).run(
    replacement.generationToken,
    replacement.pid,
    replacement.acquiredAtMs,
    replacement.incarnation ?? null,
    expected.generationToken,
  )
  return result.changes === 1
}

/** What the caller has left of its acquisition budget, or `undefined` when it declared none. */
function remainingEscalationBudgetMs(escalation: MutationEscalationContext): number | undefined {
  if (escalation.deadlineAtNs === undefined) return undefined
  return Math.max(Number(escalation.deadlineAtNs - process.hrtime.bigint()) / 1e6, 0)
}

// Bounded by the caller's budget: a killed child of a blocked process is never reaped.
function waitForVerifiedProcessExit(
  pid: number,
  escalation: MutationEscalationContext,
): boolean {
  const startedAtNs = process.hrtime.bigint()
  const remainingMs = remainingEscalationBudgetMs(escalation)
  const boundMs = remainingMs === undefined
    ? MUTATION_LOCK_TERMINATION_TIMEOUT_MS
    : Math.min(MUTATION_LOCK_TERMINATION_TIMEOUT_MS, remainingMs)
  while (processIsAlive(pid)) {
    if (monotonicElapsedMs(startedAtNs) >= boundMs) return false
    Atomics.wait(
      MUTATION_LOCK_TERMINATION_WAIT,
      0,
      0,
      MUTATION_LOCK_TERMINATION_POLL_MS,
    )
  }
  return true
}

type MutationLockOwnerIdentity = 'match' | 'mismatch' | 'unverifiable'

// Floored: `spawnSync` reads a zero timeout as none. An expired cap still refuses to signal.
function psIncarnationCapMs(escalation: MutationEscalationContext): number {
  const remainingMs = remainingEscalationBudgetMs(escalation)
  return Math.max(PROCESS_INCARNATION_PS_FLOOR_MS, Math.min(
    PROCESS_INCARNATION_PS_TIMEOUT_MS,
    remainingMs ?? PROCESS_INCARNATION_PS_TIMEOUT_MS,
  ))
}

// An unattributed row or an unresolvable pid answers `unverifiable`, which refuses the signal.
function verifyMutationLockOwnerIdentity(
  owner: MutationLockOwner,
  escalation: MutationEscalationContext,
): MutationLockOwnerIdentity {
  if (owner.incarnation === undefined) return 'unverifiable'
  const occupant = resolveProcessIncarnation(
    owner.pid,
    psIncarnationCapMs(escalation),
    escalation.psExecutable,
  )
  escalation.onIncarnationResolved?.(owner.pid)
  if (occupant === undefined) return 'unverifiable'
  if (incarnationFormat(occupant) !== incarnationFormat(owner.incarnation)) return 'unverifiable'
  return occupant === owner.incarnation ? 'match' : 'mismatch'
}

// Re-checks the incarnation before `SIGKILL`; a reused pid proves death and is never signalled.
function terminateExactMutationLockOwner(
  owner: MutationLockOwner,
  escalation: MutationEscalationContext,
): boolean {
  if (owner.pid === process.pid) return false
  const identity = verifyMutationLockOwnerIdentity(owner, escalation)
  if (identity === 'unverifiable') return false
  if (identity === 'mismatch') return true
  try {
    process.kill(owner.pid, 'SIGKILL')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ESRCH') {
      if (code === 'EPERM') return false
      throw error
    }
  }
  return waitForVerifiedProcessExit(owner.pid, escalation)
}

// Only `reclaimable` permits the kill; an unknown epoch or an unreadable lease refuses it.
function leasePermitsEscalation(knowledgeRoot: string, owner: MutationLockOwner): boolean {
  if (!processIsAlive(owner.pid)) return true
  const lease = readWriterLease(knowledgeRoot)
  switch (lease.kind) {
    case 'absent':
    case 'malformed':
      return true
    case 'unreadable':
      return false
    case 'parsed':
      return deriveWriterLeaseFreshness(
        knowledgeRoot,
        lease.lease,
        mutationLockNowMs(),
      ).kind === 'reclaimable'
  }
}

function tryEscalatedMutationLockTakeover(
  db: DatabaseSync,
  knowledgeRoot: string,
  expected: MutationLockOwner,
  replacement: MutationLockOwner,
  takeoverMs: number,
  escalation: MutationEscalationContext,
): boolean {
  if (mutationLockNowMs() - expected.acquiredAtMs < takeoverMs) return false
  if (!leasePermitsEscalation(knowledgeRoot, expected)) return false
  if (
    processIsAlive(expected.pid)
    && !terminateExactMutationLockOwner(expected, escalation)
  ) {
    return false
  }

  const observedAfterTermination = readMutationLockOwner(db)
  if (observedAfterTermination?.generationToken !== expected.generationToken) return false
  try {
    return compareAndSwapMutationLock(db, expected, replacement)
  } catch (error) {
    // A mismatched incarnation reclaims without killing anything, so the write lock can still be
    // held by whoever made the store busy. That is an ordinary retry, not a failure to surface.
    if (isSqliteBusy(error)) return false
    throw error
  }
}

function claimMutationLock(
  db: DatabaseSync,
  knowledgeRoot: string,
  owner: MutationLockOwner,
  takeoverMs: number,
  escalation: MutationEscalationContext,
): void {
  try {
    const inserted = db.prepare(`
      INSERT INTO mutation_lock (id, generation_token, pid, acquired_at_ms, incarnation)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      owner.generationToken,
      owner.pid,
      owner.acquiredAtMs,
      owner.incarnation ?? null,
    )
    if (inserted.changes === 1) return
  } catch (error) {
    if (!isSqliteBusy(error)) throw error
    const current = readMutationLockOwner(db)
    if (
      current !== undefined
      && tryEscalatedMutationLockTakeover(
        db,
        knowledgeRoot,
        current,
        owner,
        takeoverMs,
        escalation,
      )
    ) {
      return
    }
    throw new MutationLockBusyError(current)
  }

  const current = readMutationLockOwner(db)
  if (current === undefined) {
    throw new MutationLockBusyError()
  }

  const ownerIsDead = !processIsAlive(current.pid)
  const ownerPastDeadline =
    mutationLockNowMs() - current.acquiredAtMs >= takeoverMs
  if (!ownerIsDead && !ownerPastDeadline) {
    throw new MutationLockBusyError(current)
  }

  try {
    if (compareAndSwapMutationLock(db, current, owner)) return
  } catch (error) {
    if (!isSqliteBusy(error)) throw error
    if (
      tryEscalatedMutationLockTakeover(
        db,
        knowledgeRoot,
        current,
        owner,
        takeoverMs,
        escalation,
      )
    ) {
      return
    }
    throw new MutationLockBusyError(current)
  }
  throw new MutationLockBusyError(readMutationLockOwner(db))
}

function releaseMutationLock(db: DatabaseSync, generationToken: string): void {
  db.prepare(`
    DELETE FROM mutation_lock
    WHERE id = 1 AND generation_token = ?
  `).run(generationToken)
}

function withMutationLock<T>(
  knowledgeRoot: string,
  mutate: (generationToken: string, db: DatabaseSync) => T,
  options: MutationLockOptions = {},
  /**
   * The caller's acquisition deadline, when it has one.
   *
   * Only `acquireWriterLease` does: a heartbeat or a governed mutation is not racing a bound, so
   * omitting it leaves those paths on the pinned termination window exactly as before.
   */
  deadlineAtNs?: bigint,
): T {
  const escalation: MutationEscalationContext = {
    ...(deadlineAtNs === undefined ? {} : { deadlineAtNs }),
    ...(options.onProcessIncarnationResolved === undefined
      ? {}
      : { onIncarnationResolved: options.onProcessIncarnationResolved }),
    ...(options.psExecutable === undefined ? {} : { psExecutable: options.psExecutable }),
  }
  let db: DatabaseSync
  try {
    db = openWriterAuthorityDb(knowledgeRoot)
  } catch (error) {
    if (isSqliteBusy(error)) {
      throw new MutationLockBusyError(
        readCommittedMutationLockOwner(knowledgeRoot),
      )
    }
    throw error
  }
  const claimantIncarnation = ownProcessIncarnation(escalation)
  const owner: MutationLockOwner = {
    pid: process.pid,
    acquiredAtMs: mutationLockNowMs(),
    generationToken: randomUUID(),
    // A claimant that cannot prove its own incarnation records none, accepting that its row may
    // then only ever be reclaimed after it really dies. Never a fabricated token.
    ...(claimantIncarnation === undefined ? {} : { incarnation: claimantIncarnation }),
  }
  const takeoverMs = options.mutationLockTakeoverMs ?? MUTATION_LOCK_TAKEOVER_MS
  let claimed = false
  let transactionOpen = false
  try {
    claimMutationLock(db, knowledgeRoot, owner, takeoverMs, escalation)
    claimed = true
    options.afterMutationLockClaimed?.(owner.generationToken)
    try {
      db.exec('BEGIN IMMEDIATE')
      transactionOpen = true
    } catch (error) {
      if (isSqliteBusy(error)) throw new MutationLockBusyError(readMutationLockOwner(db))
      throw error
    }

    if (!mutationLockGenerationIsCurrent(db, owner.generationToken)) {
      throw new MutationLockGenerationLostError()
    }
    options.afterMutationLockAcquired?.()
    const result = mutate(owner.generationToken, db)
    db.exec('COMMIT')
    transactionOpen = false
    return result
  } finally {
    if (transactionOpen) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The original failure is authoritative.
      }
    }
    if (claimed) {
      try {
        releaseMutationLock(db, owner.generationToken)
      } catch {
        // A crashed/contended cleanup leaves a CAS-recoverable row.
      }
    }
    db.close()
  }
}

function sweepStagedEpochsBefore(knowledgeRoot: string, epoch: number): void {
  const memoryRoot = join(knowledgeRoot, 'memory')
  let products: Dirent<string>[]
  try {
    products = readdirSync(memoryRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  for (const product of products) {
    if (!product.isDirectory()) continue
    const bundlesDir = join(memoryRoot, product.name, 'bundles')
    const stagingRoot = join(bundlesDir, '.staging')
    let staged: Dirent<string>[]
    try {
      staged = readdirSync(stagingRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of staged) {
      if (!entry.isDirectory()) continue
      const match = /^\.staged-epoch-(\d+)-[A-Za-z0-9._-]+$/.exec(entry.name)
      if (match === null) continue
      const stagedEpoch = Number(match[1])
      if (!Number.isSafeInteger(stagedEpoch) || stagedEpoch >= epoch) continue
      rmSync(join(stagingRoot, entry.name), { recursive: true, force: true })
    }
    if (existsSync(stagingRoot)) bestEffortFsyncDirectory(stagingRoot)
    try {
      rmdirSync(stagingRoot)
      bestEffortFsyncDirectory(bundlesDir)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
    }
  }
}

function atomicRewrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx')
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, file)
    bestEffortFsyncDirectory(dirname(file))
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

const leaseGuardOwnerSchema = z
  .object({
    pid: z.number().int().positive(),
    threadId: z.number().int().nonnegative(),
    token: z.string().uuid(),
    claimedAtNs: z.string().regex(/^[0-9]+$/),
  })
  .strict()

type LeaseGuardOwner = z.infer<typeof leaseGuardOwnerSchema>

type ObservedLeaseGuard =
  | { kind: 'vacant' }
  | { kind: 'held'; ownerFile: string; owner?: LeaseGuardOwner }

function ignoreErrno(run: () => void, codes: readonly string[]): void {
  try {
    run()
  } catch (error) {
    if (!codes.includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
}

function errnoOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? ''
}

/** `lstat` that answers `undefined` for a missing entry; it never follows a link. */
function lstatOrAbsent(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return undefined
    throw error
  }
}

/** Move a directory nothing can attribute aside, whole: its entries are never ours to delete. */
function moveLeaseGuardAside(guard: string): void {
  const aside = join(dirname(guard), `${LEASE_GUARD_RESIDUE_PREFIX}${randomUUID()}`)
  ignoreErrno(() => renameSync(guard, aside), ['ENOENT'])
}

/** Read an owner file without following a link or blocking on a special file. */
function readLeaseGuardOwner(path: string, name: string): LeaseGuardOwner | undefined {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  let raw: string
  try {
    raw = readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
  try {
    const parsed = leaseGuardOwnerSchema.safeParse(JSON.parse(raw))
    return parsed.success && `${LEASE_GUARD_OWNER_PREFIX}${parsed.data.token}` === name
      ? parsed.data
      : undefined
  } catch {
    return undefined
  }
}

// `unlink` removes a link, never its target; an unattributable directory is moved aside whole.
function observeLeaseGuard(guard: string): ObservedLeaseGuard {
  const stat = lstatOrAbsent(guard)
  if (stat === undefined) return { kind: 'vacant' }
  if (!stat.isDirectory()) {
    ignoreErrno(() => unlinkSync(guard), ['ENOENT', 'EISDIR', 'EPERM'])
    return { kind: 'vacant' }
  }
  let names: string[]
  try {
    names = readdirSync(guard)
  } catch (error) {
    // Replaced between the two calls: the next observation judges whatever is there now.
    if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return { kind: 'vacant' }
    throw error
  }
  if (names.length === 0) {
    ignoreErrno(() => rmdirSync(guard), ['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'])
    return { kind: 'vacant' }
  }
  const ownerFile = names.filter((name) => name.startsWith(LEASE_GUARD_OWNER_PREFIX)).sort()[0]
  const ownerStat = ownerFile === undefined ? undefined : lstatOrAbsent(join(guard, ownerFile))
  if (ownerFile === undefined || (ownerStat !== undefined && !ownerStat.isFile())) {
    moveLeaseGuardAside(guard)
    return { kind: 'vacant' }
  }
  if (ownerStat === undefined) return { kind: 'vacant' }
  let owner: LeaseGuardOwner | undefined
  try {
    owner = readLeaseGuardOwner(join(guard, ownerFile), ownerFile)
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return { kind: 'vacant' }
    if (errnoOf(error) === 'ELOOP') {
      moveLeaseGuardAside(guard)
      return { kind: 'vacant' }
    }
    throw error
  }
  return owner === undefined ? { kind: 'held', ownerFile } : { kind: 'held', ownerFile, owner }
}

// Housekeeping that never fails the section; it sweeps by owner name then `rmdir`, like a reclaim.
function sweepLeakedLeaseGuardStaging(parent: string, ownStaged: string): void {
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(LEASE_GUARD_STAGING_PREFIX)) continue
    const dir = join(parent, name)
    if (dir === ownStaged) continue
    try {
      sweepLeakedStagingDirectory(dir)
    } catch {
      // Left for a later sweep.
    }
  }
}

function sweepLeakedStagingDirectory(dir: string): void {
  const stat = lstatOrAbsent(dir)
  if (stat === undefined || !stat.isDirectory()) return
  const entries = readdirSync(dir)
  // Wall clock, not `Date.now()`: the beat's only `Date.now()` is a seam the race cells use.
  const nowMs = mutationLockNowMs()
  if (entries.length === 0) {
    // Staged, not yet written: judged by its own age only.
    if (nowMs - stat.mtimeMs >= LEASE_GUARD_STAGING_STALE_MS) {
      ignoreErrno(() => rmdirSync(dir), ['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'])
    }
    return
  }
  const ownerFile = entries[0]!
  if (entries.length !== 1 || !ownerFile.startsWith(LEASE_GUARD_OWNER_PREFIX)) return
  const ownerPath = join(dir, ownerFile)
  const ownerStat = lstatOrAbsent(ownerPath)
  if (ownerStat === undefined || !ownerStat.isFile()) return
  const owner = readLeaseGuardOwner(ownerPath, ownerFile)
  // An owner being written can read as nothing yet, so unattributable bytes wait out the bound.
  const residue = owner === undefined
    ? nowMs - ownerStat.mtimeMs >= LEASE_GUARD_STAGING_STALE_MS
    : leaseGuardOwnerIsResidue(owner, LEASE_GUARD_STAGING_STALE_MS)
  if (!residue) return
  ignoreErrno(() => unlinkSync(ownerPath), ['ENOENT'])
  ignoreErrno(() => rmdirSync(dir), ['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'])
}

/**
 * True when no live section can still be behind the guard.
 *
 * Unattributable owner bytes are residue. So is a claim from a dead process, one older than the
 * bound (a thread terminated inside its section leaves its live process's pid behind), and one
 * stamped ahead of this monotonic clock, which can only come from a previous boot.
 */
function leaseGuardIsResidue(owner: LeaseGuardOwner | undefined): boolean {
  if (owner === undefined) return true
  return leaseGuardOwnerIsResidue(owner, LEASE_GUARD_STALE_MS)
}

function leaseGuardOwnerIsResidue(owner: LeaseGuardOwner, staleMs: number): boolean {
  const ageMs = Number(process.hrtime.bigint() - BigInt(owner.claimedAtNs)) / 1e6
  if (ageMs < 0 || ageMs >= staleMs) return true
  return owner.pid !== process.pid && !processIsAlive(owner.pid)
}

// Unlinks only the stale owner's file, then `rmdir`, so a late reclaimer removes nothing live.
function reclaimLeaseGuard(guard: string, ownerFile: string, hooks: LeaseGuardHooks): void {
  ignoreErrno(() => unlinkSync(join(guard, ownerFile)), ['ENOENT'])
  hooks.duringLeaseGuardReclaim?.()
  ignoreErrno(() => rmdirSync(guard), ['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'])
}

function releaseLeaseGuard(guard: string, ownerFile: string): void {
  try {
    unlinkSync(join(guard, ownerFile))
    ignoreErrno(() => rmdirSync(guard), ['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'])
  } catch {
    // Whatever is left is residue, and the age bound reclaims it.
  }
}

// Mutations and acquisitions never take this guard, so no mutation can starve the beat.
function withLeaseGuard<T>(
  knowledgeRoot: string,
  section: () => T,
  hooks: LeaseGuardHooks = {},
): T {
  const guard = join(knowledgeRoot, LEASE_GUARD_DIR)
  assertWithinKnowledgeRoot(knowledgeRoot, dirname(guard))
  const claimedAtNs = process.hrtime.bigint()
  const token = randomUUID()
  const ownerFile = `${LEASE_GUARD_OWNER_PREFIX}${token}`
  const raw = `${JSON.stringify({
    pid: process.pid,
    threadId,
    token,
    claimedAtNs: String(claimedAtNs),
  })}\n`
  const parent = dirname(guard)
  // `memory/queue/` and `memory/` are created only when absent, and removed again only by `rmdir`
  // (so only while empty), keeping a lease round-trip from leaving anything under `memory/`.
  const createdAncestors = [parent, dirname(parent)].filter((dir) => !existsSync(dir))
  const staged = `${guard}.tmp-${randomUUID()}`
  let contended = false
  try {
    try {
      while (true) {
        mkdirSync(parent, { recursive: true })
        try {
          mkdirSync(staged)
          break
        } catch (error) {
          // Another section's cleanup removed the empty parent between the two calls.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      writeFileSync(join(staged, ownerFile), raw, { encoding: 'utf8', flag: 'wx' })
      while (true) {
        try {
          renameSync(staged, guard)
          break
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOTDIR') throw error
        }
        const observed = observeLeaseGuard(guard)
        if (observed.kind === 'vacant') continue
        const owner = observed.owner
        if (leaseGuardIsResidue(owner)) {
          hooks.beforeLeaseGuardReclaim?.()
          reclaimLeaseGuard(guard, observed.ownerFile, hooks)
          continue
        }
        if (owner?.pid === process.pid && owner.threadId === threadId) {
          throw new LeaseGuardBusyError(
            'writer lease guard is held by an enclosing section on this thread',
          )
        }
        if (!contended) {
          contended = true
          hooks.onLeaseGuardContended?.()
        }
        if (monotonicElapsedMs(claimedAtNs) >= LEASE_GUARD_WAIT_MS) {
          throw new LeaseGuardBusyError(
            `writer lease guard stayed held by pid ${owner?.pid ?? 'unknown'} for `
              + `${LEASE_GUARD_WAIT_MS}ms`,
          )
        }
        Atomics.wait(MUTATION_LOCK_TERMINATION_WAIT, 0, 0, LEASE_GUARD_POLL_MS)
      }
    } finally {
      // After a successful claim the staged directory IS the guard, so nothing is left to remove.
      rmSync(staged, { recursive: true, force: true })
    }
    try {
      sweepLeakedLeaseGuardStaging(parent, staged)
      return section()
    } finally {
      releaseLeaseGuard(guard, ownerFile)
    }
  } finally {
    for (const dir of createdAncestors) {
      try {
        rmdirSync(dir)
      } catch {
        // Not empty, already gone, or not ours to judge: left as it is.
      }
    }
  }
}

// Only `ENOENT` means absent; any other read failure is `unreadable`, never absent or malformed.
export function readWriterLease(knowledgeRoot: string): ReadWriterLeaseOutcome {
  const file = leasePath(knowledgeRoot)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', code: code ?? 'unknown-read-error' }
  }

  try {
    const parsed = writerLeaseSchema.safeParse(JSON.parse(raw))
    return parsed.success ? { kind: 'parsed', lease: parsed.data } : { kind: 'malformed' }
  } catch {
    return { kind: 'malformed' }
  }
}

function previewEpochState(raw: string): string {
  const preview = raw.slice(0, 64).replaceAll('\r', '\\r').replaceAll('\n', '\\n')
  return preview === '' ? '<empty>' : preview
}

function readEpoch(knowledgeRoot: string): number {
  const file = epochPath(knowledgeRoot)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 0
    throw new CorruptEpochStateError(file, 'unreadable', code ?? 'unknown-read-error')
  }
  const canonical = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  if (!/^(0|[1-9][0-9]*)$/.test(canonical)) {
    throw new CorruptEpochStateError(file, 'malformed', previewEpochState(raw))
  }
  const epoch = Number(canonical)
  if (!Number.isSafeInteger(epoch)) {
    throw new CorruptEpochStateError(file, 'overflow', previewEpochState(raw))
  }
  return epoch
}

/** Fresh-read the monotonic disk epoch; only an absent file is pre-acquire epoch zero. */
export function readCurrentEpoch(knowledgeRoot: string): number {
  assertAbsoluteKnowledgeRoot(knowledgeRoot)
  return readEpoch(knowledgeRoot)
}

// Every call re-reads the disk epoch; a cached epoch would miss a reclaim.
export function assertEpochCurrent(
  opts: AssertEpochCurrentOptions,
): AssertEpochCurrentOutcome {
  const observedEpoch = readCurrentEpoch(opts.knowledgeRoot)
  return observedEpoch === opts.epoch
    ? { current: true }
    : { current: false, observedEpoch }
}

function nextEpoch(current: number): number {
  if (current === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('writer lease epoch exhausted')
  }
  return current + 1
}

/** Purely classify a guarded or untrusted lease value against one explicit wall-clock instant. */
export function isLeaseStale(lease: unknown, nowMs: number): boolean {
  const parsed = writerLeaseSchema.safeParse(lease)
  if (!parsed.success || !Number.isFinite(nowMs)) return true
  return nowMs - parsed.data.heartbeatAtMs >= LEASE_HEARTBEAT_TTL_MS
}

// An unreadable epoch is `unknown`: as fresh it makes a phantom holder, as stale a wrong kill.
export type WriterLeaseFreshness =
  | { kind: 'fresh' }
  | { kind: 'reclaimable' }
  | { kind: 'unknown'; error: CorruptEpochStateError }

export function deriveWriterLeaseFreshness(
  knowledgeRoot: string,
  lease: WriterLease,
  nowMs: number,
): WriterLeaseFreshness {
  let observedEpoch: number
  try {
    observedEpoch = readEpoch(knowledgeRoot)
  } catch (error) {
    if (error instanceof CorruptEpochStateError) return { kind: 'unknown', error }
    throw error
  }
  if (lease.epoch !== observedEpoch) return { kind: 'reclaimable' }
  return isLeaseStale(lease, nowMs) ? { kind: 'reclaimable' } : { kind: 'fresh' }
}

/** Return a live holder or atomically mint a new, monotonically fenced writer identity. */
export function acquireWriterLease(
  knowledgeRoot: string,
  hooks?: AcquireWriterLeaseOptions,
): AcquireWriterLeaseOutcome {
  assertAbsoluteKnowledgeRoot(knowledgeRoot)
  const beforeLock = readWriterLease(knowledgeRoot)
  if (beforeLock.kind === 'parsed') {
    // This consumer names `unknown` as the typed refusal it already had for corrupt epoch bytes:
    // an authority state that cannot be read is not a licence to mint a new one.
    const verdict = deriveWriterLeaseFreshness(
      knowledgeRoot,
      beforeLock.lease,
      mutationLockNowMs(),
    )
    if (verdict.kind === 'unknown') {
      return { kind: 'refused', reason: 'corrupt-epoch-state', error: verdict.error }
    }
    if (verdict.kind === 'fresh') return { kind: 'held', holder: beforeLock.lease }
  } else if (beforeLock.kind === 'unreadable') {
    // A lease that exists but cannot be opened is never minted over.
    return {
      kind: 'refused',
      reason: 'unreadable-lease-state',
      code: beforeLock.code,
      error: new UnreadableWriterLeaseStateError(leasePath(knowledgeRoot), beforeLock.code),
    }
  } else {
    // With no lease to derive from, the epoch is still read before any acquisition: unreadable or
    // corrupt authority state refuses here exactly as it does through the verdict above.
    try {
      readEpoch(knowledgeRoot)
    } catch (error) {
      if (error instanceof CorruptEpochStateError) {
        return { kind: 'refused', reason: 'corrupt-epoch-state', error }
      }
      throw error
    }
  }

  const deadlineMs = hooks?.acquireDeadlineMs ?? ACQUIRE_WRITER_LEASE_DEADLINE_MS
  const startedAtNs = process.hrtime.bigint()
  // Escalation waits spend this one budget, so no constant beneath it extends the deadline.
  const deadlineAtNs = startedAtNs + BigInt(Math.round(deadlineMs * 1e6))
  let attempts = 0

  while (true) {
    attempts += 1
    try {
      return withMutationLock(knowledgeRoot, () => {
        let observedEpoch: number
        try {
          observedEpoch = readEpoch(knowledgeRoot)
        } catch (error) {
          if (error instanceof CorruptEpochStateError) {
            return { kind: 'refused' as const, reason: 'corrupt-epoch-state' as const, error }
          }
          throw error
        }
        const current = readWriterLease(knowledgeRoot)
        const nowMs = Date.now()
        if (current.kind === 'unreadable') {
          // The in-lock repeat of the pre-lock arm: a lease that turned unopenable while this
          // contender waited for the lock is still not evidence that nobody holds it.
          return {
            kind: 'refused' as const,
            reason: 'unreadable-lease-state' as const,
            code: current.code,
            error: new UnreadableWriterLeaseStateError(leasePath(knowledgeRoot), current.code),
          }
        }
        if (current.kind === 'parsed') {
          const verdict = deriveWriterLeaseFreshness(knowledgeRoot, current.lease, nowMs)
          if (verdict.kind === 'unknown') {
            return {
              kind: 'refused' as const,
              reason: 'corrupt-epoch-state' as const,
              error: verdict.error,
            }
          }
          if (verdict.kind === 'fresh' && current.lease.epoch === observedEpoch) {
            return { kind: 'held', holder: current.lease }
          }
        }
        const reclaimed = current.kind === 'parsed' ? current.lease : undefined

        const epoch = nextEpoch(observedEpoch)
        const holder = writerLeaseSchema.parse({
          leaseId: randomUUID(),
          pid: process.pid,
          epoch,
          heartbeatAtMs: nowMs,
        })
        atomicRewrite(epochPath(knowledgeRoot), `${epoch}\n`)
        hooks?.afterEpochRewrite?.()
        sweepStagedEpochsBefore(knowledgeRoot, epoch)
        atomicRewrite(leasePath(knowledgeRoot), `${JSON.stringify(holder)}\n`)
        return {
          kind: 'acquired',
          leaseId: holder.leaseId,
          epoch: holder.epoch,
          ...(reclaimed === undefined ? {} : { reclaimed }),
        }
      }, hooks, deadlineAtNs)
    } catch (error) {
      if (!(error instanceof MutationLockBusyError)) throw error
      // A stale heartbeat still answers `held`: a paused holder is never stolen from.
      const current = readWriterLease(knowledgeRoot)
      if (current.kind === 'unreadable') {
        // A lease that cannot be READ is a fourth case here for the same reason an unreadable
        // epoch is a third one: the contender surfaces it by name instead of spinning to its
        // deadline over an authority state nobody can evaluate.
        return {
          kind: 'refused',
          reason: 'unreadable-lease-state',
          code: current.code,
          error: new UnreadableWriterLeaseStateError(leasePath(knowledgeRoot), current.code),
        }
      }
      if (current.kind === 'parsed') {
        let observedEpoch: number
        try {
          observedEpoch = readEpoch(knowledgeRoot)
        } catch (epochError) {
          if (epochError instanceof CorruptEpochStateError) {
            return { kind: 'refused', reason: 'corrupt-epoch-state', error: epochError }
          }
          throw epochError
        }
        if (current.lease.epoch === observedEpoch) {
          return { kind: 'held', holder: current.lease }
        }
      }
      /**
       * The outermost exit, and the only one anchored outside this module's own vocabulary.
       *
       * It is checked AFTER the `held` narrow above, so a contender that could have answered
       * `held` always does; the deadline never converts a good answer into a refusal. It is also
       * strictly larger than MUTATION_LOCK_TAKEOVER_MS, so a reclaim that was going to happen has
       * already had its chance by the time this fires.
       */
      const waitedMs = monotonicElapsedMs(startedAtNs)
      if (waitedMs >= deadlineMs) {
        const observedOwner = readCommittedMutationLockOwner(knowledgeRoot)
        const error = new WriterLeaseUnreclaimableError(
          attempts,
          waitedMs,
          observedOwner === undefined ? undefined : {
            pid: observedOwner.pid,
            acquiredAtMs: observedOwner.acquiredAtMs,
            generationToken: observedOwner.generationToken,
            incarnationAttributed: observedOwner.incarnation !== undefined,
          },
          current.kind === 'parsed' ? current.lease : undefined,
        )
        return {
          kind: 'refused',
          reason: 'mutation-lock-unreclaimable',
          error,
          attempts,
          waitedMs,
          ...(error.observedOwner === undefined ? {} : { observedOwner: error.observedOwner }),
          ...(error.observedLease === undefined ? {} : { observedLease: error.observedLease }),
        }
      }
      Atomics.wait(
        MUTATION_LOCK_TERMINATION_WAIT,
        0,
        0,
        MUTATION_LOCK_TERMINATION_POLL_MS,
      )
    }
  }
}

/**
 * Compare one exact writer authority and run its mutation under the same generation lock.
 * The generation check after the failpoint prevents an expired owner from resuming after a
 * bounded takeover. Mutation implementations must keep irreversible work inside `mutate`.
 */
export function withCurrentWriterAuthority<T>(
  knowledgeRoot: string,
  authority: CurrentWriterAuthority,
  mutate: () => T,
  hooks: CurrentWriterAuthorityHooks = {},
): T {
  assertAbsoluteKnowledgeRoot(knowledgeRoot)
  const fullAuthority: WriterLeaseAuthority = { knowledgeRoot, ...authority }
  try {
    return withMutationLock(knowledgeRoot, (generationToken, db) => {
      const observedEpoch = readCurrentEpoch(knowledgeRoot)
      if (observedEpoch !== authority.epoch) {
        throw new WriterAuthorityLostError(
          fullAuthority,
          'epoch-mismatch-before-heartbeat',
          observedEpoch,
        )
      }
      // Release keeps the epoch, so the lease is re-read here and must match exactly.
      const current = readWriterLease(knowledgeRoot)
      if (current.kind === 'absent') {
        throw new WriterAuthorityLostError(fullAuthority, 'lease-missing', observedEpoch)
      }
      if (current.kind === 'malformed') {
        throw new WriterAuthorityLostError(fullAuthority, 'lease-malformed', observedEpoch)
      }
      // Authority that cannot be re-read here cannot be proven, so the commit is fenced.
      if (current.kind === 'unreadable') {
        throw new WriterAuthorityLostError(fullAuthority, 'lease-unreadable', observedEpoch)
      }
      if (current.lease.leaseId !== authority.leaseId) {
        throw new WriterAuthorityLostError(fullAuthority, 'lease-id-mismatch', observedEpoch)
      }
      if (current.lease.epoch !== authority.epoch) {
        throw new WriterAuthorityLostError(fullAuthority, 'stale-epoch', observedEpoch)
      }
      hooks.afterFinalAuthorityCompare?.()
      if (!mutationLockGenerationIsCurrent(db, generationToken)) {
        throw new WriterAuthorityLostError(
          fullAuthority,
          'mutation-lock-generation-lost',
          readCurrentEpoch(knowledgeRoot),
        )
      }
      return mutate()
    }, hooks)
  } catch (error) {
    if (
      error instanceof MutationLockBusyError
      || error instanceof MutationLockGenerationLostError
    ) {
      throw new WriterAuthorityLostError(
        fullAuthority,
        'mutation-lock-generation-lost',
        readCurrentEpoch(knowledgeRoot),
      )
    }
    throw error
  }
}

// Lock-free so a long mutation cannot starve the beat; a clobbered lease names a stale epoch.
export function heartbeatLease(
  opts: LeaseOperationOptions,
  hooks: LeaseGuardHooks = {},
): HeartbeatLeaseOutcome {
  assertAbsoluteKnowledgeRoot(opts.knowledgeRoot)
  // Nothing to resurrect and nothing to guard: absence is answered before any guard is staged.
  if (readWriterLease(opts.knowledgeRoot).kind === 'absent') {
    return { kind: 'refused', reason: 'lease-missing' }
  }
  return withLeaseGuard(opts.knowledgeRoot, (): HeartbeatLeaseOutcome => {
    const current = readWriterLease(opts.knowledgeRoot)
    if (current.kind === 'absent') return { kind: 'refused', reason: 'lease-missing' }
    if (current.kind === 'malformed') return { kind: 'refused', reason: 'lease-malformed' }
    // A beat that cannot read the lease cannot prove it owns it.
    if (current.kind === 'unreadable') return { kind: 'refused', reason: 'lease-unreadable' }
    if (current.lease.leaseId !== opts.leaseId) {
      return { kind: 'refused', reason: 'lease-id-mismatch', holder: current.lease }
    }
    let observedEpoch: number
    try {
      observedEpoch = readEpoch(opts.knowledgeRoot)
    } catch (error) {
      if (error instanceof CorruptEpochStateError) {
        return {
          kind: 'refused',
          reason: 'corrupt-epoch-state',
          holder: current.lease,
          error,
        }
      }
      throw error
    }
    if (current.lease.epoch !== observedEpoch) {
      return {
        kind: 'refused',
        reason: 'stale-epoch',
        holder: current.lease,
        observedEpoch,
      }
    }

    const holder = writerLeaseSchema.parse({
      ...current.lease,
      heartbeatAtMs: Date.now(),
    })
    atomicRewrite(leasePath(opts.knowledgeRoot), `${JSON.stringify(holder)}\n`)
    return { kind: 'heartbeated', holder }
  }, hooks)
}

/**
 * Refresh one exact maintenance writer at a non-mutating boundary.
 *
 * The epoch reads deliberately bracket the heartbeat: the first rejects an already-reclaimed
 * holder, while the second detects a reclaim race after the lease rewrite. The authority-store
 * transaction is released before this function returns, so this is NOT a mutation fence. Any
 * irreversible mutation must instead run inside `withCurrentWriterAuthority`.
 */
export function refreshWriterLeaseAuthority(
  authority: WriterLeaseAuthority,
): WriterLeaseAuthority {
  const beforeHeartbeat = assertEpochCurrent(authority)
  if (!beforeHeartbeat.current) {
    throw new WriterAuthorityLostError(
      authority,
      'epoch-mismatch-before-heartbeat',
      beforeHeartbeat.observedEpoch,
    )
  }

  const heartbeat = heartbeatLease(authority)
  if (heartbeat.kind === 'refused') {
    if (heartbeat.reason === 'corrupt-epoch-state' && heartbeat.error !== undefined) {
      throw heartbeat.error
    }
    throw new WriterAuthorityLostError(
      authority,
      heartbeat.reason,
      readCurrentEpoch(authority.knowledgeRoot),
    )
  }

  const afterHeartbeat = assertEpochCurrent(authority)
  if (!afterHeartbeat.current) {
    throw new WriterAuthorityLostError(
      authority,
      'epoch-mismatch-after-heartbeat',
      afterHeartbeat.observedEpoch,
    )
  }

  return authority
}

// The epoch is kept forever; the guard is always taken second, so release and beat cannot deadlock.
export function releaseLease(
  opts: LeaseOperationOptions,
  hooks: LeaseGuardHooks = {},
): ReleaseLeaseOutcome {
  assertAbsoluteKnowledgeRoot(opts.knowledgeRoot)
  return withMutationLock(opts.knowledgeRoot, () => {
    const outcome = withLeaseGuard(opts.knowledgeRoot, (): ReleaseLeaseOutcome => {
      const current = readWriterLease(opts.knowledgeRoot)
      if (current.kind === 'absent') return { kind: 'refused', reason: 'lease-missing' }
      if (current.kind === 'malformed') return { kind: 'refused', reason: 'lease-malformed' }
      // An unreadable lease may belong to a successor, so it is never removed unseen.
      if (current.kind === 'unreadable') return { kind: 'refused', reason: 'lease-unreadable' }
      if (current.lease.leaseId !== opts.leaseId) {
        return { kind: 'refused', reason: 'lease-id-mismatch', holder: current.lease }
      }

      rmSync(leasePath(opts.knowledgeRoot), { force: true })
      return { kind: 'released' }
    }, hooks)
    if (outcome.kind === 'released') bestEffortFsyncDirectory(opts.knowledgeRoot)
    return outcome
  })
}
