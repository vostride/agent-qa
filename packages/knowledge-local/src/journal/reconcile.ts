/**
 * Deterministic recovery before a writer starts draining.
 *
 * The caller acquires the writer lease first, which bumps the fencing epoch on stale takeover.
 * This module then reclaims every non-current claim, resolves journal state against canonical
 * bundle truth, and delegates projection work through injected index functions. It deliberately
 * has no author/model dependency: recovery can replay only the persisted deterministic tail.
 */
import {
  existsSync,
  readdirSync,
  rmdirSync,
  rmSync,
} from 'node:fs'
import { basename, join } from 'node:path'

import { enumerateBundleDirs } from '../bundle-scan.js'
import { loadBundle } from '../bundle-read.js'
import {
  withCurrentWriterAuthority,
  type CurrentWriterAuthority,
} from '../lease/writer-lease.js'
import {
  claimedCandidateDir,
  queuedCandidateDir,
} from '../queue/queue-layout.js'
import {
  listClaimedLeases,
  requeueClaimedWithinCurrentAuthority,
} from '../queue/curation-queue.js'
import {
  readJobState,
  writeJobStateWithinCurrentAuthority,
} from '../queue/job-state.js'
import {
  clearCommitIntent,
  listCommitIntents,
  quarantineStaleCommitIntent,
  readReconciledEpoch,
  writeReconciledEpochWithinCurrentAuthority,
  type CommitIntent,
  type ListedCommitIntent,
} from './intent-journal.js'
import { assertWithinKnowledgeRoot } from '../knowledge-containment.js'
import { recoverExpiredBundleMutations } from './bundle-mutation.js'
import {
  isCurationEffectCommitted,
  receiptForEffect,
  writeCurationEffectReceiptWithinCurrentAuthority,
} from './curation-effect-receipt.js'

export interface ReconcileOnDrainStartHooks {
  /**
   * Fires immediately before a stale intent is renamed aside. The only seam that can reproduce
   * the race a second reconciler on another host creates: it removes the intent file between our
   * listing and our rename.
   */
  beforeStaleQuarantine?(candidateId: string, epoch: number): void
}

export interface ReconcileOnDrainStartDependencies {
  knowledgeRoot: string
  writerAuthority: CurrentWriterAuthority
  hasIndexRow(bundleId: string): boolean
  applyIndexDelta(intent: CommitIntent): void
  deriveIndexRowFromBundle(bundleId: string): void
  hooks?: ReconcileOnDrainStartHooks
}

export interface ReconcileReport {
  intentsCleared: number
  intentsReplayed: number
  intentsDiscarded: number
  /** Intents authored before the reconciled-epoch watermark: renamed aside, never replayed. */
  intentsQuarantinedStale: number
  jobsRequeued: number
  orphansRemoved: number
  /** Present on production reconciliation; optional keeps injected legacy test reports compatible. */
  mutationsRecovered?: number
  malformed: number
}

function childDirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function stagingRoots(root: string): string[] {
  const roots: string[] = []
  const visit = (dir: string): void => {
    for (const name of childDirectories(dir)) {
      const child = join(dir, name)
      if (name === '.staging') {
        roots.push(child)
      } else {
        visit(child)
      }
    }
  }
  visit(root)
  return roots.sort()
}

function stagingEntryBelongsToLease(entryName: string, leaseId: string): boolean {
  return (
    entryName === leaseId ||
    entryName.startsWith(`${leaseId}-`) ||
    entryName.endsWith(`-${leaseId}`) ||
    entryName.includes(`-${leaseId}-`)
  )
}

function removeEmptyDirectory(dir: string): void {
  try {
    rmdirSync(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
  }
}

function removeExpiredLeaseStaging(
  knowledgeRoot: string,
  expiredLeaseIds: ReadonlySet<string>,
): number {
  let removed = 0
  if (expiredLeaseIds.size === 0) return removed

  for (const stagingRoot of stagingRoots(knowledgeRoot)) {
    assertWithinKnowledgeRoot(knowledgeRoot, stagingRoot)
    for (const entryName of childDirectories(stagingRoot)) {
      if (
        [...expiredLeaseIds].some((leaseId) =>
          stagingEntryBelongsToLease(entryName, leaseId),
        )
      ) {
        rmSync(join(stagingRoot, entryName), { recursive: true, force: true })
        removed += 1
      }
    }
    removeEmptyDirectory(stagingRoot)
  }
  return removed
}

function requeueCandidate(
  knowledgeRoot: string,
  candidateId: string,
  requeued: Set<string>,
  writerAuthority: CurrentWriterAuthority,
): void {
  for (const leaseId of listClaimedLeases(knowledgeRoot)) {
    if (!existsSync(claimedCandidateDir(knowledgeRoot, leaseId, candidateId))) continue
    for (const movedCandidateId of requeueClaimedWithinCurrentAuthority({
      knowledgeRoot,
      leaseId,
      authority: writerAuthority,
    })) {
      requeued.add(movedCandidateId)
    }
  }

  if (!existsSync(queuedCandidateDir(knowledgeRoot, candidateId))) return
  const state = readJobState(knowledgeRoot, candidateId)
  if (state.kind === 'parsed' && state.state.lifecycle === 'queued') return
  writeJobStateWithinCurrentAuthority({
    knowledgeRoot,
    candidateId,
    authority: writerAuthority,
    lifecycle: 'queued',
    embedCrashCount: state.kind === 'parsed' ? state.state.embedCrashCount : 0,
    ...(state.kind === 'parsed' && state.state.authored !== undefined
      ? { authored: state.state.authored }
      : {}),
  })
  requeued.add(candidateId)
}

function loadedBundleIds(knowledgeRoot: string): Map<string, string> {
  const loaded = new Map<string, string>()
  for (const entry of enumerateBundleDirs(knowledgeRoot)) {
    const outcome = loadBundle(entry.dir)
    if (outcome.kind !== 'loaded') continue
    loaded.set(outcome.bundle.manifest.id, entry.dir)
  }
  return loaded
}

// Runs after lease acquisition, before the first claim; a thrown apply leaves the intent to retry.
function reconcileOnDrainStartWithinCurrentAuthority(
  deps: ReconcileOnDrainStartDependencies,
): ReconcileReport {
  const report: ReconcileReport = {
    intentsCleared: 0,
    intentsReplayed: 0,
    intentsDiscarded: 0,
    intentsQuarantinedStale: 0,
    jobsRequeued: 0,
    orphansRemoved: 0,
    mutationsRecovered: 0,
    malformed: 0,
  }
  const requeued = new Set<string>()
  const expiredLeaseIds = new Set<string>()

  for (const leaseId of listClaimedLeases(deps.knowledgeRoot)) {
    if (deps.writerAuthority.leaseId === leaseId) continue
    expiredLeaseIds.add(leaseId)
    for (const candidateId of requeueClaimedWithinCurrentAuthority({
      knowledgeRoot: deps.knowledgeRoot,
      leaseId,
      authority: deps.writerAuthority,
    })) {
      requeued.add(candidateId)
    }
  }
  report.mutationsRecovered = recoverExpiredBundleMutations(
    deps.knowledgeRoot,
    [...expiredLeaseIds],
  ).mutationsRecovered
  report.orphansRemoved = removeExpiredLeaseStaging(
    deps.knowledgeRoot,
    expiredLeaseIds,
  )

  /**
   * An intent authored before the last completed reconciliation belongs to a generation this
   * writer has already superseded: replaying it would apply obsolete index work or requeue a
   * candidate the successor already completed. Keyed off the watermark rather than bare epoch
   * inequality, because the crash journal a successor legitimately inherits is written at a
   * lower epoch too and must still replay.
   */
  const reconciledEpoch = readReconciledEpoch(deps.knowledgeRoot)
  const entries: ListedCommitIntent[] = []
  for (const entry of listCommitIntents(deps.knowledgeRoot)) {
    if ('parsed' in entry && entry.parsed.epoch < reconciledEpoch) {
      deps.hooks?.beforeStaleQuarantine?.(entry.parsed.candidateId, entry.parsed.epoch)
      const outcome = quarantineStaleCommitIntent(
        deps.knowledgeRoot,
        entry.parsed.candidateId,
        entry.parsed.epoch,
      )
      // An intent that vanished under us was already handled by whoever removed it; the pass
      // must not count it and must not die on it — it is running inside the held section.
      if (outcome.kind === 'quarantined') report.intentsQuarantinedStale += 1
      continue
    }
    entries.push(entry)
  }
  const bundleIdsWithIntent = new Set(
    entries.flatMap((entry) => ('parsed' in entry ? [entry.parsed.bundleId] : [])),
  )
  const bundles = loadedBundleIds(deps.knowledgeRoot)

  for (const entry of entries) {
    if ('malformed' in entry) {
      requeueCandidate(
        deps.knowledgeRoot,
        entry.candidateId,
        requeued,
        deps.writerAuthority,
      )
      clearCommitIntent(deps.knowledgeRoot, entry.candidateId)
      report.intentsDiscarded += 1
      report.malformed += 1
      continue
    }

    const { parsed: intent } = entry
    if (intent.observation !== undefined) {
      let committed = 0
      for (const effect of intent.observation.effects) {
        if (!isCurationEffectCommitted(deps.knowledgeRoot, intent.candidateId, effect)) continue
        // The main bundle may have published while its victim/maintenance suffix did not.
        // Replay only projections of independently verified canonical effects.
        deps.applyIndexDelta({ ...intent, bundleId: effect.recordId })
        writeCurationEffectReceiptWithinCurrentAuthority({
          knowledgeRoot: deps.knowledgeRoot,
          authority: deps.writerAuthority,
          receipt: receiptForEffect(intent.candidateId, intent.observation, effect),
        })
        committed += 1
      }
      if (committed < intent.observation.effects.length) {
        requeueCandidate(deps.knowledgeRoot, intent.candidateId, requeued, deps.writerAuthority)
      }
      clearCommitIntent(deps.knowledgeRoot, intent.candidateId)
      if (committed > 0) {
        report.intentsReplayed += 1
        report.intentsCleared += 1
      } else {
        report.intentsDiscarded += 1
      }
      continue
    }
    if (!bundles.has(intent.bundleId)) {
      requeueCandidate(
        deps.knowledgeRoot,
        intent.candidateId,
        requeued,
        deps.writerAuthority,
      )
      clearCommitIntent(deps.knowledgeRoot, intent.candidateId)
      report.intentsDiscarded += 1
      continue
    }

    deps.applyIndexDelta(intent)
    report.intentsReplayed += 1
    clearCommitIntent(deps.knowledgeRoot, intent.candidateId)
    report.intentsCleared += 1
  }

  for (const [bundleId, dir] of bundles) {
    if (bundleIdsWithIntent.has(bundleId) || deps.hasIndexRow(bundleId)) continue
    const outcome = loadBundle(dir)
    if (outcome.kind !== 'loaded' || basename(dir) !== outcome.bundle.manifest.id) continue
    deps.deriveIndexRowFromBundle(bundleId)
  }

  // Last step of the held section: the watermark advances only for a pass that completed.
  writeReconciledEpochWithinCurrentAuthority(
    deps.knowledgeRoot,
    deps.writerAuthority.epoch,
  )
  report.jobsRequeued = requeued.size
  return report
}

export function reconcileOnDrainStart(
  deps: ReconcileOnDrainStartDependencies,
): ReconcileReport {
  return withCurrentWriterAuthority(
    deps.knowledgeRoot,
    deps.writerAuthority,
    () => reconcileOnDrainStartWithinCurrentAuthority(deps),
  )
}
