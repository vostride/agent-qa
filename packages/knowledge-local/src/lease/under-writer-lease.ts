// The authority check holds no lock: a reclaim between the check and the append is still unfenced.

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

// Called from `finally`: a release error warns instead of masking the work's result or error.
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

// An async `decide` would free the lease while its work runs, so a promise return type is `never`.
export type SynchronousDecision<T> = T extends PromiseLike<unknown> ? never : unknown

// The epoch catches a reclaim and the lease a release; both reads are read-only and fail closed.
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
    // Released on every exit, so a failed verb never locks out the next drain.
    releaseLeaseAfterWork({ knowledgeRoot, leaseId: acquired.leaseId })
  }
}
