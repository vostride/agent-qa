/**
 * Epoch-fenced writer-role primitives for the gitignored knowledge root.
 *
 * This module never touches the curation queue. Plan 378-05 composes stale-holder requeue and
 * journal reconciliation around these lease decisions. Lease and epoch replacements are each
 * file-fsync'd and atomically renamed so a process kill can expose only old or new bytes.
 */
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

/**
 * Provisional acquisition deadline; retune from operational evidence without adding config.
 *
 * V-02: the retry loop's only exits used to be facts about the lease and the lock, and a state the
 * phase itself models — an epoch-invalid lease kept fresh by a renewal sidecar while a live owner
 * holds the authority transaction — satisfies none of them. A contender then spins on the caller's
 * main thread forever, which is what `agent-qa daemon` startup and `agent-qa knowledge drain` do.
 *
 * The bound is therefore anchored OUTSIDE that vocabulary: a monotonic clock reading taken at loop
 * entry plus an attempt counter, neither of which any on-disk value can influence. Deliberately
 * greater than MUTATION_LOCK_TAKEOVER_MS so a legitimate escalated takeover still fits inside the
 * budget and the deadline never pre-empts a reclaim that was going to succeed.
 */
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

/**
 * Transient guard serializing the beat's read-check-write with release's read-check-delete.
 *
 * A directory holding exactly one `owner-<token>` file, published whole by renaming a staged
 * directory into place. It lives under `memory/queue/`, which every scaffolded knowledge
 * `.gitignore` already ignores, so neither a guard in use nor one a crash left behind is ever a
 * commit-visible file in a user's knowledge repository (261002-lse follow-up; the user's
 * `.gitignore` is never rewritten, D-22).
 */
export const LEASE_GUARD_DIR = 'memory/queue/lease-guard'

const LEASE_GUARD_OWNER_PREFIX = 'owner-'

/** A guard older than this cannot belong to a live section (each is one read and one write). */
export const LEASE_GUARD_STALE_MS = 10_000

/**
 * How long a waiter keeps trying for the guard: deliberately LONGER than the residue bound.
 *
 * 2026-10-03 (quick 261003-lgd, Phase 432 review WR-11): the wait used to reuse the 2 s
 * MUTATION_LOCK_BUSY_TIMEOUT_MS, shorter than the 10 s bound. A guard left by a thread terminated
 * inside its section carries this live process's pid, so only the age bound can judge it residue,
 * and no waiter ever lived long enough to see it cross: every beat and release after a terminated
 * beat worker threw. The bound is kept and the wait made to outlast it, rather than the bound cut
 * below the wait, because a bound short enough to fit a 2 s wait could cut a live section short
 * under heavy load. Measured whole calls (stage, claim, section, release), 400 beats and 100
 * releases at load 4 on 12 cores: beat p50 12 ms, p99 15 ms, max 21 ms; release p50 9 ms, p99
 * 13 ms. Load 126-255 is about 10-21 times oversubscribed, so even a p99 stretched that far stays
 * well under the 10 s bound. Live contention still clears in milliseconds; only a residue costs a
 * waiter up to the bound, once.
 */
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
      /**
       * CR-01 (round 5): the lease file's own sibling of `corrupt-epoch-state`.
       *
       * `code` is the raw errno so an operator sees EACCES rather than a contender that silently
       * spun to its deadline over an authority state nobody can evaluate; `error` keeps this arm
       * inside the union's stated contract that every refusal is rethrowable.
       */
      kind: 'refused'
      reason: 'unreadable-lease-state'
      code: string
      error: UnreadableWriterLeaseStateError
    }
  | {
      kind: 'refused'
      reason: 'mutation-lock-unreclaimable'
      /**
       * Both refusal arms carry a thrown-shaped `error` ON PURPOSE.
       *
       * Every caller of this union already renders `refused` as `[reason]: error.message` or
       * rethrows it, so a new arm that also carries one is surfaced by name at every entry point —
       * including any added later — without a list of call sites to keep in step. Naming the
       * refusal is the requirement; enumerating the callers who must name it is the failure mode
       * this phase keeps rediscovering.
       */
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
        /** the lease exists and could not be opened — never write over what you cannot read. */
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

/**
 * The lease file's sibling of `CorruptEpochStateError`, for a read that produced no throwable.
 *
 * `readFileSync` threw, but the value that reaches a consumer is a kinded outcome rather than an
 * exception, and `AcquireWriterLeaseOutcome`'s own contract is that EVERY refusal arm carries a
 * thrown-shaped `error` — three call sites rethrow or render it without knowing which arm they
 * hold (`drain.ts:842` among them). A refusal that carried only an errno string would have made
 * that contract a list of call sites to keep in step, which is the failure mode this module keeps
 * rediscovering. Deliberately not re-exported from the package index: the refusal is fully
 * legible from `reason`, `code` and `error.message`.
 */
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

/**
 * The authority-file read verdict, and it has four values rather than three.
 *
 * Round-5 CR-01: `unreadable` is the sibling of the epoch read's
 * `CorruptEpochStateError(…, 'unreadable', …)`. A file that EXISTS and could not be opened is a
 * different fact from a file that is not there and from a file whose bytes were read and failed to
 * parse, and the previous three arms had nowhere to put it — so EACCES, EIO, EMFILE and ENFILE all
 * landed on `malformed`, which every consumer reads as "nobody holds authority". `code` carries
 * the errno so the refusal that follows can name the cause to an operator.
 */
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

/**
 * Opaque process-incarnation token for one pid, anchored OUTSIDE any value this module writes.
 *
 * a durable row's pid is not an identity. Once the recorded process dies, the kernel is
 * free to hand that number to a stranger, and every later decision keyed on the number alone
 * (above all `SIGKILL`) targets whoever holds it now. The one fact that distinguishes them is
 * assigned by the OS and cannot be forged from inside the store: when the process at that pid
 * started.
 *
 * Linux reads field 22 (`starttime`) of `/proc/<pid>/stat`, counted from the LAST `)` because the
 * `comm` field is parenthesised and may itself contain spaces and parentheses. Other POSIX hosts
 * read `/bin/ps -p <pid> -o lstart=` in the C locale and UTC, so every reader renders one start
 * time as one token. Windows has no equivalent builtin, so it resolves to `undefined` and every
 * incarnation check there fails closed.
 *
 * Returns `undefined` — never throws — whenever the pid cannot be attributed. `undefined` means
 * "do not signal", never "safe to signal".
 *
 * `timeoutMs` bounds the POSIX arm's `ps` fork, which is the last wait beneath the
 * acquisition deadline that used to be able to outlive it — a wedged `ps` never returns, and this
 * resolution sits directly on the pre-signal path. A cap that expires resolves
 * through the SAME funnel every other failure uses (`undefined`), so a timed-out resolution is
 * unverifiable and therefore signal-ineligible. Callers with no budget of their own omit it.
 *
 * 386-32 consumes this same helper for the embedder-worker signal path, so both kill paths speak
 * one incarnation vocabulary.
 */
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
  // 2026-10-16 (442-14, GAP-D1): one rendering for every reader; the caller's PATH, TZ and
  // locale never reach ps.
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
/**
 * Only ever a RESOLVED token or the sentinel — `undefined` is deliberately not representable here.
 *
 * That is the whole of round-5 regression 2 in one type: storing `undefined` made "the process
 * table did not answer this once" indistinguishable from "the process table answered, and the
 * answer is that there is nothing to say", and the second reading is permanent.
 */
let ownIncarnation: string | typeof OWN_INCARNATION_UNRESOLVED = OWN_INCARNATION_UNRESOLVED

/**
 * This process's own incarnation, resolved once SUCCESSFULLY and retried until then.
 *
 * A pid's start time is fixed for the life of the process, and this process is alive by
 * definition, so a resolved value cannot go stale. Memoising it keeps the per-claim cost off the
 * hot mutation path (the POSIX arm shells out to `ps`), and the accepting control in the corpus
 * asserts the hit path still forks exactly once per process.
 *
 * Two things this function's previous comment stated, both of which the call site contradicted:
 *
 *   1. It claimed the fork "is not spending an escalation budget". It is. The sole call site is
 *      `withMutationLock`, which `acquireWriterLease` enters under `deadlineAtNs`, so a wedged
 *      `ps` here spends the acquisition deadline exactly as the pre-signal fork does. WR-04's
 *      clamp therefore applies to BOTH forks: `psIncarnationCapMs` degrades to the same flat
 *      `PROCESS_INCARNATION_PS_TIMEOUT_MS` when the caller has no budget, so the heartbeat and
 *      governed-mutation paths are unchanged, while a budgeted acquisition now caps this fork at
 *      `clamp(remaining, FLOOR, TIMEOUT)` like every other wait beneath it.
 *   2. It memoised a MISS. One timed-out fork at startup then wrote `undefined` into the memo for
 *      the life of the process, so every `mutation_lock` row that daemon ever wrote carried no
 *      incarnation, `verifyMutationLockOwnerIdentity` answered `unverifiable` for all of them, and
 *      no contender could ever escalate against it. Degraded liveness forever, from one fork.
 *
 * A miss is now a per-call answer: `undefined` is returned, the sentinel is left in place, and the
 * NEXT claim resolves again. There is no retry loop inside one call (that would spend the budget
 * this change exists to protect), no alternative resolver, and no default token — only a token the
 * OS assigned may replace the sentinel. The observer fires on every attempted resolution, because
 * a retry is a real `ps` fork and the cost being bounded has to stay countable.
 */
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

/**
 * The caller's remaining budget and observation hooks, threaded down the escalation path.
 *
 * W-05: the escalation is reached from `acquireWriterLease`, which owns a deadline; every wait it
 * performs is therefore spending someone else's time. Passing that fact down — rather than letting
 * each wait consult its own pinned constant — is what makes the deadline a real bound instead of
 * an approximate one. The relationship must hold structurally: the current constants happen to
 * satisfy it arithmetically (45 s takeover + 5 s termination < 60 s deadline), but an assertion
 * that rests on that coincidence would survive any retuning that broke it.
 */
interface MutationEscalationContext {
  /** Absolute monotonic instant past which no escalation wait may continue; absent = no budget. */
  readonly deadlineAtNs?: bigint
  readonly onIncarnationResolved?: (pid: number) => void
  readonly psExecutable?: string
}

export interface AcquireWriterLeaseOptions extends MutationLockOptions {
  /**
   * Test/chaos seam for the pinned acquisition deadline; production never sets it.
   *
   * The same shape as `mutationLockTakeoverMs` and the heartbeat supervisor's `stopTimeoutMs`: a
   * real unreclaimable wait is 60 s, which no test can afford to sit through, and shortening the
   * window is the only way to reach the refusal branch (D-15 — a seam, never a config key).
   */
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

/**
 * Add the incarnation column to a store created before CR-04 shipped.
 *
 * The authority database is transient lock state, not knowledge, so this needs no data-migration
 * plan: an inherited row keeps a NULL incarnation and is therefore unattributed, which fails the
 * signal check closed. That is the correct reading — nothing on disk can say which process wrote
 * a row that predates the column.
 *
 * W-06: the check and the ALTER are not one transaction and cannot be, because the ALTER is itself
 * the schema change every reader would have to serialize behind. Two daemons starting against one
 * legacy store therefore both decide the column is missing, and the loser's ALTER — which blocks on
 * the winner's write lock and then re-prepares against the new schema — fails with
 * `duplicate column name`. `isSqliteBusy` does not match that message, so it used to escape as a
 * raw SqliteError and kill a starting daemon over a race whose OUTCOME WAS ALREADY CORRECT: the
 * column exists, which is the entire postcondition. Losing this race is success, so it is reported
 * as success. Every other error still propagates.
 */
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

/**
 * Read the committed lock owner as a TYPED ABSENCE, never as a throw.
 *
 * Contract: every reason the owner cannot be read answers `undefined` — absent store, table not
 * created yet, and a store too busy to answer. Both callers already read `undefined` as
 * "no attributable owner": the busy-catch in `withMutationLock` puts it on a
 * `MutationLockBusyError`, and the acquisition deadline puts it on the typed
 * `mutation-lock-unreclaimable` refusal. A raw `SqliteError` escaping here therefore reached
 * neither of those promises — it propagated out of `acquireWriterLease` uncaught and killed a
 * starting daemon over contention, which is exactly the state the refusal exists to name.
 * Every other error still propagates.
 */
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

/**
 * Poll a signalled owner's disappearance, bounded by the CALLER'S remaining budget (W-05).
 *
 * The wait is synchronous on the caller's main thread, so its cost is charged to whoever asked for
 * the lock. Bounding it by MUTATION_LOCK_TERMINATION_TIMEOUT_MS alone let an acquisition overrun
 * its own deadline by that whole window, and the overrun was not hypothetical: SIGKILL cannot be
 * survived, but a killed child of a process that never returns to its event loop is never reaped,
 * so `kill(pid, 0)` keeps answering "alive" indefinitely. A daemon spinning synchronously on its
 * main thread is exactly the V-02 shape this phase reproduced, and its children are exactly those.
 *
 * The bound is therefore the MINIMUM of the pinned window and the time the caller has left. An
 * exhausted budget waits not at all and reports that the exit was NOT confirmed — a refusal to
 * reclaim, never a licence to CAS over an owner whose death was never observed. Elapsed time is
 * measured from `process.hrtime.bigint()` for the same reason the acquisition deadline is: a wall
 * clock can be stepped, and this loop's only exit must not be steppable.
 */
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

/**
 * The `ps` fork's share of the caller's remaining budget.
 *
 * The caller's remainder is the ceiling, which is what stops one fork from spending a deadline it
 * does not own. The FLOOR is the part that had to be argued for, because it is the one place this
 * cap can overshoot: an acquisition whose busy-timeout already consumed the whole deadline arrives
 * here with nothing left, and a zero-length cap would mean the identity of a genuinely stale owner
 * can never be re-read at all — turning "the wait is budgeted" (W-05) into "the verified kill is
 * cancelled", which is a different decision and one 386-40 pinned in the other direction.
 *
 * So the fork always gets one short, PINNED allowance: the overshoot is bounded by that constant
 * rather than by however long a wedged `ps` feels like taking, which is the whole subject of WR-04.
 * A zero-length cap would also be worse than useless mechanically — `spawnSync` reads 0 as "no
 * timeout" and would UNBOUND the fork entirely.
 *
 * What the floor does NOT do is buy permission: an expired cap still answers `undefined`, which
 * still answers `unverifiable`, which is still a refusal to signal. No default token, no retry.
 */
function psIncarnationCapMs(escalation: MutationEscalationContext): number {
  const remainingMs = remainingEscalationBudgetMs(escalation)
  return Math.max(PROCESS_INCARNATION_PS_FLOOR_MS, Math.min(
    PROCESS_INCARNATION_PS_TIMEOUT_MS,
    remainingMs ?? PROCESS_INCARNATION_PS_TIMEOUT_MS,
  ))
}

/**
 * Compare the row's recorded incarnation against the pid's CURRENT occupant.
 *
 * An unattributed row (legacy bytes, or a claimant that could not resolve its own start time) and
 * an unresolvable pid both answer `unverifiable`, which is a refusal to signal — never a licence.
 * a pid the process table will not report on INSIDE the caller's budget joins that second
 * class rather than extending the deadline, because the resolution sits on the pre-signal path.
 */
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

/**
 * the generation token authenticates the ROW, not the process now occupying its pid.
 *
 * The pid's current incarnation is therefore re-resolved immediately before the signal, and the
 * three answers are genuinely different outcomes:
 *
 *   match        the process that created this row is still there — SIGKILL and confirm ESRCH,
 *                exactly the Plan 20 verified-termination semantics.
 *   mismatch     the recorded process is gone and a stranger inherited its pid. A reused pid is
 *                EVIDENCE OF DEATH, not a target: report success so the caller's generation
 *                re-read and CAS reclaim the row with no signal delivered at all.
 *   unverifiable fail closed. Refusing escalation can wedge a contender until the occupant really
 *                exits; signalling an unattributable pid is local arbitrary-process
 *                termination. Only one of those is recoverable.
 */
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

/**
 * Escalation ends in SIGKILL, so this consumer names `unknown` AND `unreadable` as refusals.
 *
 * A wrong kill is unrecoverable; a contender that declines to kill is not. `reclaimable` is the
 * only verdict that permits, which means a live holder is escalated against exactly when its lease
 * has genuinely aged out or names a superseded epoch — never because the epoch could not be read,
 * and never because the lease could not be read.
 *
 * CR-01 (round 5): the read arms are an exhaustive ladder rather than a `!== 'parsed'`
 * short-circuit. That short-circuit was a fourth conjunct sitting one line ABOVE the derivation
 * the same round moved the third conjunct INTO, and it permitted the kill for the one input class
 * the derivation exists to refuse. `absent` and `malformed` still permit — a lease file that is
 * missing, or whose bytes were read and are not a lease, is recovery input — but a file that
 * exists and could not be opened is no evidence at all.
 *
 * This veto is the LAST lease guard on the governed-mutation contention path: a contender that
 * enters through `withCurrentWriterAuthority` (a fenced-out writer retrying its commit) claims the
 * mutation lock before it reads any lease, so `acquireWriterLease`'s pre-check never runs for it.
 * That path is what makes this gate reachable, and it is pinned by a corpus case that reddens when
 * the veto is removed.
 */
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

/**
 * Observe the guard path without ever reaching through it.
 *
 * A guard is only ever a real directory holding one regular `owner-<token>` file. Anything else at
 * the path, a symlink wherever it points or a plain file, is removed as an entry: `unlink` removes
 * a link, never its target. A directory nothing can attribute (entries but no owner, or an owner
 * that is not a regular file) is moved aside whole and its entries are never unlinked; no live
 * guard can look like that, because a guard is only published by renaming a staged directory onto
 * an empty one.
 */
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

/**
 * Sweep staging directories a holder leaked by dying between staging and claiming.
 *
 * A staging directory is exactly one owner file in a real directory, and lives no longer than its
 * waiter, so one is swept only when its owner is residue under that longer bound (or its process
 * is gone). The sweep is the same compare-and-swap as a reclaim: the owner's own name, then
 * `rmdir`. A link, or a directory holding anything else, is left exactly as it is. Housekeeping
 * only: nothing here may fail the section.
 */
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

/**
 * Reclaim a stale guard by compare-and-swap, never by moving whatever sits at the path.
 *
 * The compare is the owner file's NAME: only the stale owner's own file is unlinked. The swap is
 * `rmdir`, which removes the directory only if that left it empty. A live guard is a different
 * owner name inside a non-empty directory, so a second reclaimer of the same stale owner, however
 * late, removes nothing of it (261002-lse follow-up).
 */
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

/**
 * Run one lease-file section under the guard shared by `heartbeatLease` and `releaseLease`.
 *
 * Claiming is renaming a staged directory onto the guard path, which succeeds only where no guard
 * or an empty one sits. Governed mutations and acquisitions never take the guard, so a mutation of
 * any length cannot starve the beat (CR-03 stands) and a beat cannot block an acquisition. Waiting
 * is bounded by LEASE_GUARD_WAIT_MS, which outlasts the residue bound so that a guard left by a
 * terminated thread of this process is always reclaimed in time; a guard held by an
 * enclosing section on this very thread can never be let go by waiting, so that claim fails at
 * once. Nothing here reaches through a link or out of the knowledge root.
 */
function withLeaseGuard<T>(
  knowledgeRoot: string,
  section: () => T,
  hooks: LeaseGuardHooks = {},
): T {
  const guard = join(knowledgeRoot, LEASE_GUARD_DIR)
  // nothing is created, claimed or removed through a chain that leaves the root.
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

/**
 * Read and strictly validate current writer authority without acquiring or refreshing it.
 *
 * CR-01 (round 5): ENOENT is the only read failure that is evidence of absence, and NO read
 * failure is evidence of corruption. This is `readEpoch`'s rule applied to the file it was not
 * applied to — the derivation's own W-01 note says the guard belongs at the READ, so that
 * consumers inherit it rather than each re-deriving it, and this read has three consumers that
 * select SIGKILL, epoch minting and registration deletion from its answer.
 *
 * The `existsSync` fallback that used to sit here is deleted rather than kept beside the errno
 * test: under fd exhaustion it fails for the same reason the open did, so it degraded an EMFILE
 * read from `malformed` to `absent` — the strongest possible statement that nobody holds the
 * lease, produced by the weakest possible evidence.
 */
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

/**
 * An epoch-stale write is refused AT THE MUTATION BOUNDARY. Plan 378-10 calls this immediately
 * before the intent-journal write and again immediately before the publish rename; a stale result
 * abandons the in-flight job without mutation. Every call re-reads disk and never caches the epoch.
 */
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

/**
 * The one freshness answer, and it has three values rather than two.
 *
 * the previous derivation returned a boolean, so every way of failing to READ the epoch
 * collapsed into the same value a genuinely expired lease produces. `readEpoch` raises
 * `CorruptEpochStateError(…, 'unreadable', …)` for EACCES, EIO, EMFILE and ENFILE, not only for
 * corrupt bytes, and fd exhaustion produces both that failure and the daemon identity-handshake
 * failure at once. A live, healthy holder therefore became de-registrable and SIGKILL-eligible on
 * a transient read error.
 *
 * `unknown` is deliberately NOT resolved to either boolean here. Resolving it toward "fresh" makes
 * a permanently unreadable epoch an immortal phantom holder no contender can ever reclaim;
 * resolving it toward "reclaimable" is the kill this closes. It is returned to the consumers so
 * each of them names what it does with it, and so a fourth consumer added later cannot inherit a
 * default it never chose.
 *
 * W-01: the epoch conjunct lives HERE, in the derivation, not at the consumers. Three surfaces
 * classify recoverability from this verdict — `leasePermitsEscalation`, the acquisition
 * pre-check, and `classifyDaemonRegistration` in the CLI — and a fix applied consumer by consumer
 * is a list that the next surface joins without joining the guard. A lease naming a superseded
 * epoch is recovery input no matter how fresh its bytes are: nobody can still be inside a
 * transaction for an epoch that has already been replaced.
 *
 * a crash between the epoch rewrite and the lease rewrite leaves a lease naming the
 * previous epoch. Reporting that lease as held manufactures a phantom holder no TTL sweep ever
 * reclaims, so an epoch-invalid lease is recovery input rather than an answer.
 *
 * The inputs are the disk epoch and the lease value, and nothing else. There is no second
 * freshness channel and no further conjunct: three conjuncts produced three defects.
 */
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
    // a lease that exists and cannot be opened is not a licence to mint over it. Refusing
    // here is what keeps the loop below — and therefore the escalation surface underneath it —
    // out of reach for this input class entirely.
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
  /**
   * W-05: the same instant the loop's own exit is measured against, handed to everything that
   * waits beneath it.
   *
   * Escalation waits are spent on this budget, not beside it. Deriving the instant once here and
   * threading it down means no wait can be extended by retuning a constant it happens to sit
   * under, and none of them needs to know what the others cost.
   */
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
      /**
       * Contention answers 'held' only for an epoch-valid lease. Staleness deliberately does NOT
       * disqualify a holder here: the lock is busy, so the published holder is inside its own
       * serialized section and a stale heartbeat is exactly the fencing case DAEM-09 protects
       * (a paused drainer must be reported as holding, not stolen from). An epoch-mismatched
       * lease is different in kind — nobody can still be inside a transaction for a superseded
       * epoch — so it is recovery input and the loop keeps waiting for the lock.
       *
       * An epoch that cannot be READ is a third case and no longer hides inside the mismatch arm:
       * the contender surfaces the typed refusal by name instead of spinning silently to its
       * deadline over an authority state nobody can evaluate.
       */
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
      /**
       * the epoch alone is guessable, and release deliberately never advances it, so an
       * epoch-only guard admits both a fabricated identity and a holder that already released.
       * The lease is therefore read INSIDE the held transaction — the same serialization boundary
       * as the epoch and generation checks — and must match the supplied authority exactly. This
       * is heartbeatLease's presence/id/epoch ladder, applied where mutation actually happens.
       */
      const current = readWriterLease(knowledgeRoot)
      if (current.kind === 'absent') {
        throw new WriterAuthorityLostError(fullAuthority, 'lease-missing', observedEpoch)
      }
      if (current.kind === 'malformed') {
        throw new WriterAuthorityLostError(fullAuthority, 'lease-malformed', observedEpoch)
      }
      // authority that cannot be re-read inside the transaction is authority that cannot be
      // proven, and this is the fence that keeps a fenced-out writer from committing.
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

/**
 * Refresh the matching current-epoch holder without entering the mutation lock.
 *
 * CR-03 dissolves here rather than being worked around. The beat used to share
 * `withMutationLock` with every governed write, and it runs in a worker THREAD, so the daemon's
 * long synchronous mutation on the main thread held the lock while the worker blocked on it: the
 * holder starved its own heartbeat, crossed the TTL and became a takeover target. Writing `.lease`
 * directly means a governed mutation of any length cannot starve the beat at all, so heartbeat
 * independence is structural instead of a fallback that has to be maintained beside the real path.
 *
 * What the lock used to buy was check-then-write atomicity of the identity/epoch ladder below
 * against a concurrent reclaim, and dropping it opens exactly one race: a holder resuming from a
 * >=TTL wedge can land its read-check-write astride a contender's reclaim and clobber the
 * successor's lease. That is contained rather than prevented, and the containment is the epoch
 * fence: a reclaim rewrites `.epoch` strictly BEFORE it publishes its lease, both inside the lock,
 * so any lease clobbered afterwards names a superseded epoch. Every classifier reads it as
 * recovery input, no store write is admitted under it (the epoch fence at the store verbs), and
 * the successor's next authority check surfaces WriterAuthorityLostError, after which a fresh
 * acquisition reclaims at the next epoch. The worst case is one successor bounce in a microsecond
 * window after a 30 s wedge — a liveness hiccup, never minted authority. During the exact schedule
 * this lock-free write exists for (the holder's own mutation in flight) no contender can be
 * mid-reclaim at all, because a reclaim requires the very lock that mutation is holding.
 *
 * 2026-08-01 W-02 re-scope: `MUTATION_LOCK_TAKEOVER_MS` now governs reclaim from DEAD and
 * whole-process-STOPPED owners, which write no beats and cross the TTL. Auto-takeover of a LIVE
 * holder whose beat thread is still ticking is deliberately impossible; a wedged-forever live
 * daemon surfaces at every contender as the typed `mutation-lock-unreclaimable` refusal naming its
 * pid. That is an operator kill rather than an automated one, which is this module's own law: a
 * wrong kill is unrecoverable, a wedged contender is not.
 *
 * Identity is still proven first, and every refusal below leaves `.lease` byte-identical.
 *
 * 2026-10-02 (quick 261002-lse, 432-19 #7): the ladder and the write run under the lease-file
 * guard `releaseLease` also takes. Without it a beat that read before a release wrote after it,
 * and since release deliberately keeps the epoch, the resurrected lease named the CURRENT epoch:
 * the fence above contains a reclaim but not a release, and the next acquire answered `held`.
 * The guard is not the mutation lock, so everything said above about CR-03 still holds.
 */
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
    // a beat that cannot read the lease cannot prove it owns it, so it may not rewrite it.
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

/**
 * Remove only the matching lease file; the monotonic epoch is deliberately retained forever.
 *
 * The read and the deletion run under the lease-file guard, taken inside the mutation lock, so a
 * heartbeat in flight finishes before the lease is read and any later beat finds it gone
 * The guard is always taken second, and the beat never takes the mutation lock, so
 * the two cannot wait on each other.
 */
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
      // release is a deletion. An unreadable lease could belong to anybody, including a
      // successor that reclaimed while this caller was away, so it is never removed unseen.
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
