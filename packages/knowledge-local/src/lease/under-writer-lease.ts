// The committed-write verbs' serialized section, spelled ONCE (Phase 390 D-11 · WR-02 · G-390-2R;
// lifted here by Phase 391 D-03).
//
// WHY THIS MODULE EXISTS. The quarantine verbs and the grant verbs mutate two different committed
// artifacts under the SAME knowledge root and therefore under the same MRSW writer lease. Until 391
// the whole read-fold-decide-append scope — the handed-in-authority re-validation, the compile-time
// refusal of an async `decide`, the acquire/release discipline and the three exhaustive acquisition
// arms — lived inside `quarantine/operations.ts`, because quarantine was the only client. A second
// client written beside it would have been a second spelling of a serialization rule, and this
// repository's own measured lesson is that two spellings of one rule agree until they do not.
//
// So the rule lives here and the callers name their own refusal. What is NOT parameterised is
// everything else: the ladder, the ordering and the residual below are shared verbatim, which is
// the whole point of the move.
//
// WHAT THE SCOPE PROVES, AND WHAT IT DOES NOT. A HANDED-IN authority is re-read
// against disk before it licenses anything, and that check holds NO lock — unlike the lease
// module's own `withCurrentWriterAuthority`, which runs inside `withMutationLock`. So what it
// proves is bounded exactly: the authority was current AT THE MOMENT OF THE CHECK, not for the
// duration of the `decide` that follows it. A reclaim landing in that window is still unfenced and
// the append it licenses still lands. Before the check the window was FOREVER — a heartbeat-starved
// daemon kept appending beside its reclaimer for the rest of its life, which the two-OS-process
// harness measured as two `entered` lines for one identity. Narrowing forever to ONE SYNCHRONOUS
// call is a real improvement and it is not closure; closing it needs the APPEND itself to carry a
// fence, which is larger than either phase took.

import {
  LEASE_HEARTBEAT_TTL_MS,
  WriterAuthorityLostError,
  acquireWriterLease,
  assertEpochCurrent,
  readWriterLease,
  releaseLease,
} from './writer-lease.js'
import type { LeaseOperationOptions, WriterLease, WriterLeaseAuthority } from './writer-lease.js'

/** `process.emitWarning` code for a lease not given back after the work it guarded. */
export const LEASE_RELEASE_DEFERRED_WARNING = 'AGENT_QA_LEASE_RELEASE_DEFERRED'

/**
 * Give a lease back after the work it guarded, without letting the release decide that work's
 * outcome (2026-10-03, quick 261003-lgd, Phase 432 review WR-11).
 *
 * Called from a `finally`. A release that throws there (the lease guard stayed busy for its
 * whole wait, or its directory chain was refused) would replace a committed result with that
 * throw, or mask the work's own error. It is a named warning instead, and the lease lapses by
 * its heartbeat TTL, or at once when this process exits and its pid is gone. A typed refusal was
 * already left to the same lapse.
 */
export function releaseLeaseAfterWork(opts: LeaseOperationOptions): void {
  try {
    releaseLease(opts)
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    process.emitWarning(
      `the knowledge writer lease ${opts.leaseId} was not released after its work (${reason}); `
        + `it lapses within ${LEASE_HEARTBEAT_TTL_MS / 1_000} s, or when this process exits`,
      { code: LEASE_RELEASE_DEFERRED_WARNING },
    )
  }
}

/**
 * A `decide` that returns a promise, refused at COMPILE time.
 *
 * {@link underKnowledgeWriterLease} releases the lease in a `finally`, so an async `decide` would
 * hand back a PENDING promise, the `finally` would run immediately, and the lease would be given up
 * while the work it serializes is still running — reinstating precisely the race CR-03 closed,
 * without failing to compile (`Promise<Promise<X>>` collapses in the return position, so nothing
 * objects). The quarantine module's own history is a serialization claim that turned out to be
 * false; a signature that permits the false version by construction is the wrong default here
 * specifically, and it is now the wrong default for the grant verbs too.
 *
 * Spelled as an INTERSECTION on the callback's return rather than as a constraint on the type
 * parameter (`T extends NotSynchronous<T>` is rejected as a circular constraint) and rather than as
 * a conditional RETURN type (which resolves to `never`, and `never` is assignable to everything, so
 * the call site would still compile). In this position inference is preserved — `T` is still read
 * off the callback — and a promise-returning closure fails to satisfy `never`.
 */
export type SynchronousDecision<T> = T extends PromiseLike<unknown> ? never : unknown

/**
 * The handed-in authority, re-read against disk before it licenses a write.
 *
 * WHY THE EPOCH IS THE FENCING TOKEN, and why no clock is involved. `acquireWriterLease` bumps the
 * monotonic epoch on EVERY acquisition including a reclaim, so "my epoch is no longer the disk
 * epoch" is exactly "somebody took this lease from under me" — no TTL, no timing window, nothing
 * to tune. And the daemon's captured epoch never legitimately moves during its lifetime:
 * `refreshWriterLeaseAuthority` heartbeats and returns THE SAME authority, throwing rather than
 * renumbering, so the value the daemon host closes over is a fixed constant that stays valid for
 * exactly as long as the daemon holds the lease. This check therefore cannot refuse a healthy
 * daemon; the accept-direction control in the quarantine suite is what keeps that a measurement.
 *
 * WHY THE LEASE IS READ TOO. `releaseLease` deliberately RETAINS the epoch forever, so a holder
 * that released still carries a matching counter while owning nothing. The epoch answers "did
 * anybody reclaim?"; the lease answers "am I still the holder?", and neither subsumes the other.
 *
 * WHY NOT `refreshWriterLeaseAuthority`, which asks nearly the same question. It also HEARTBEATS —
 * it rewrites the lease file — and a read-fold-decide-append verb has no business mutating the
 * lease as a side effect of answering a question about it. Both legs here are read-only.
 *
 * FAIL-CLOSED ON A STATE NOBODY CAN EVALUATE. `readCurrentEpoch` throws `CorruptEpochStateError`
 * for an unreadable or malformed epoch file and that propagates unflattened, exactly as an
 * `unreadable` lease raises rather than degrading to "nobody holds it". Authority that cannot be
 * proven is not a licence to write, which is the posture `acquireWriterLease` already takes for
 * the same inputs.
 *
 * Every reason raised here is an existing member of `WriterAuthorityLostReason`; nothing widens.
 */
function assertHandedInAuthority(
  knowledgeRoot: string,
  authority: { leaseId: string; epoch: number },
): void {
  const full: WriterLeaseAuthority = { knowledgeRoot, ...authority }

  const epoch = assertEpochCurrent({ knowledgeRoot, epoch: authority.epoch })
  if (!epoch.current) {
    throw new WriterAuthorityLostError(full, 'stale-epoch', epoch.observedEpoch)
  }

  const current = readWriterLease(knowledgeRoot)
  if (current.kind === 'absent') {
    throw new WriterAuthorityLostError(full, 'lease-missing', authority.epoch)
  }
  if (current.kind === 'malformed') {
    throw new WriterAuthorityLostError(full, 'lease-malformed', authority.epoch)
  }
  if (current.kind === 'unreadable') {
    throw new WriterAuthorityLostError(full, 'lease-unreadable', authority.epoch)
  }
  if (current.lease.leaseId !== authority.leaseId) {
    throw new WriterAuthorityLostError(full, 'lease-id-mismatch', authority.epoch)
  }
}

/**
 * Run one committed-write verb's WHOLE read-fold-decide-append cycle under the knowledge writer
 * lease — not just the append.
 *
 * Serializing only the file write would leave the interesting race intact: two writers could both
 * fold a ledger with no entry for a subject, both decide to open one, and both append, producing
 * two opening events for one window. So `decide` runs INSIDE the scope and is synchronous BY
 * SIGNATURE (see {@link SynchronousDecision}) — there is no await point between the read and the
 * append for another writer to be scheduled at.
 *
 * Three arms, and they are exhaustive over the acquisition outcome:
 *  - a handed-in authority is VALIDATED against disk and, if it is still current, means this
 *    process IS the holder; it then acquires nothing and releases nothing, because the lease it was
 *    given outlives this call (the daemon's arm). An authority this process no longer holds raises
 *    the lease module's own `WriterAuthorityLostError` before `decide` runs, so a reclaimed daemon
 *    writes nothing — BOUNDED as the module head states;
 *  - `held` hands the live holder to the caller's own refusal factory, having written nothing and
 *    having taken nothing from the holder. The factory is the ONE parameterised thing here: the
 *    port contracts these verbs implement carry no lease arm, so a refusal that is not one of their
 *    named outcomes surfaces as a typed throw, and a throw naming the WRONG committed artifact
 *    would send an operator looking in the wrong file;
 *  - every other non-`acquired` outcome rethrows the union's own error, which every refusal arm
 *    carries precisely so a new arm surfaces by name instead of being swallowed here.
 */
export async function underKnowledgeWriterLease<T>(
  knowledgeRoot: string,
  resolveWriterAuthority: (() => { leaseId: string; epoch: number } | undefined) | undefined,
  decide: () => T & SynchronousDecision<T>,
  onLeaseHeld: (holder: WriterLease) => Error,
): Promise<T> {
  const authority = resolveWriterAuthority?.()
  if (authority !== undefined) {
    assertHandedInAuthority(knowledgeRoot, authority)
    return decide()
  }

  const acquired = acquireWriterLease(knowledgeRoot)
  if (acquired.kind === 'held') throw onLeaseHeld(acquired.holder)
  if (acquired.kind !== 'acquired') throw acquired.error

  try {
    return decide()
  } finally {
    // Given back on EVERY exit, including the typed ledger refusals the read raises: a verb that
    // failed must not leave the next drain locked out of the knowledge root. A release that throws
    // never replaces the verb's own result or error.
    releaseLeaseAfterWork({ knowledgeRoot, leaseId: acquired.leaseId })
  }
}
