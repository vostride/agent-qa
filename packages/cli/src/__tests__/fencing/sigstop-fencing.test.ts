import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  acquireWriterLease,
  LEASE_HEARTBEAT_TTL_MS,
  enumerateBundleDirs,
  loadBundle,
  openIndexReaderConnection,
  readWriterLease,
} from '@vostride/agent-qa-knowledge-local'
import { afterAll, describe, expect, test } from 'vitest'

import { nudgeDaemon } from '../../daemon/client.js'
import { DAEMON_EVENTS_FILE } from '../../daemon/events.js'
import { inspectDaemonRegistration } from '../../daemon/registration.js'
import {
  buildFixture,
  enqueueFixtureBytes,
  writeFixture,
  type DualHostFixture,
} from '../dual-host/fixtures.js'
import { canonicalBundleTree, orderedLogicalDump } from '../dual-host/logical-dump.js'
import {
  FENCING_ENV,
  LEG_TIMEOUT_MS,
  cleanupFencingRoots,
  completeChildExpectingRefusal,
  completeChildSuccessfully,
  killIfRunning,
  makeRoot,
  processStateChar,
  sendSignalWhileAlive,
  startChild,
  startPausedDrainer,
  startReclaimingDaemon,
  waitForChildTermination,
  waitForDaemonEvent,
  waitForMarker,
  waitForReconcilePasses,
  writeDurableJson,
  type FencingPaths,
} from './spawn-helpers.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe

function singleCandidateFixture(): DualHostFixture {
  const source = buildFixture('mixed')
  return {
    ...source,
    candidates: [source.candidates[0]!],
    delayedCandidateId: null,
  }
}

function findEventAfter(
  events: readonly Record<string, unknown>[],
  after: number,
  predicate: (event: Record<string, unknown>) => boolean,
): number {
  const relative = events.slice(after + 1).findIndex(predicate)
  expect(relative).toBeGreaterThanOrEqual(0)
  return after + 1 + relative
}

function storeDigest(knowledgeRoot: string): string {
  return createHash('sha256')
    .update(canonicalBundleTree(knowledgeRoot))
    .update('\0')
    .update(orderedLogicalDump(knowledgeRoot))
    .digest('hex')
}

const JOURNAL_DIR = 'memory/queue/journal'
/** The only names `listCommitIntents` returns — the live intents a reconciler will act on. */
const LIVE_INTENT_FILE = /^([0-9a-f]{64})\.intent\.json$/
// A shape, not a name: the per-call UUID keeps a twice-quarantined candidate's evidence apart.
const QUARANTINED_INTENT_FILE =
  /^\.stale-(\d+)-([0-9a-f]{64})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.intent\.json$/

// Shorter than production's 60 s, so finishing inside the budget is a measurement, not a given.
const RECLAIM_SEAMS = { mutationLockTakeoverMs: 0, acquireDeadlineMs: 20_000 } as const

function journalNames(knowledgeRoot: string): string[] {
  try {
    return readdirSync(join(knowledgeRoot, JOURNAL_DIR)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Read the journal directory directly: the on-disk partition, not the lister's view of it. */
function liveIntentNames(knowledgeRoot: string): string[] {
  return journalNames(knowledgeRoot).filter((name) => LIVE_INTENT_FILE.test(name))
}

function quarantinedIntentNames(knowledgeRoot: string): string[] {
  return journalNames(knowledgeRoot).filter((name) => name.startsWith('.stale-'))
}

function journalBytes(knowledgeRoot: string, name: string): string {
  return readFileSync(join(knowledgeRoot, JOURNAL_DIR, name), 'utf8')
}

function indexedBundleIds(knowledgeRoot: string): string[] {
  const { db } = openIndexReaderConnection(knowledgeRoot)
  try {
    return db.prepare('SELECT bundle_id FROM records ORDER BY bundle_id')
      .all()
      .map((row) => String((row as { bundle_id: unknown }).bundle_id))
  } finally {
    db.close()
  }
}

// Asserts the path, so a harness that killed the stopped writer itself cannot pass.
async function assertEscalatedReclaim(input: {
  paths: FencingPaths
  drainer: ReturnType<typeof startChild>
  daemon: ReturnType<typeof startChild>
  paused: Record<string, unknown>
  ready: Record<string, unknown>
}): Promise<void> {
  const { paths, drainer, daemon, paused, ready } = input
  const drainerPid = drainer.child.pid
  expect(ready).toMatchObject({
    ready: true,
    pid: daemon.child.pid,
    epoch: 2,
    takeoverMs: RECLAIM_SEAMS.mutationLockTakeoverMs,
    acquireDeadlineMs: RECLAIM_SEAMS.acquireDeadlineMs,
  })
  expect(ready.incarnationResolvedPids).toContain(drainerPid)
  expect(Number(ready.acquireElapsedMs)).toBeLessThan(RECLAIM_SEAMS.acquireDeadlineMs)

  const terminated = await waitForChildTermination(drainer, 'escalated SIGKILL of the stopped owner')
  expect(terminated).toEqual({ code: null, signal: 'SIGKILL' })

  const events = readFileSync(`${paths.agentQaRoot}/${DAEMON_EVENTS_FILE}`, 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  const acquiredIndex = findEventAfter(events, -1, (event) =>
    event.kind === 'lease-acquired' && event.pid === daemon.child.pid && event.epoch === 2)
  findEventAfter(events, acquiredIndex, (event) =>
    event.kind === 'lease-reclaimed'
    && event.priorHolderPid === paused.pid
    && event.priorLeaseId === paused.leaseId
    && event.priorEpoch === paused.oldEpoch
    && event.newEpoch === 2)
  expect(Number(readFileSync(`${paths.knowledgeRoot}/.epoch`, 'utf8').trim())).toBe(2)
}

function immediateWriterAttempt(knowledgeRoot: string): 'busy' | 'entered' {
  const db = new DatabaseSync(join(knowledgeRoot, '.writer-authority.sqlite'), {
    timeout: 5,
  })
  let transactionOpen = false
  try {
    db.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    return 'entered'
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR'
      && /database is locked/i.test((error as Error).message)
    ) {
      return 'busy'
    }
    throw error
  } finally {
    if (transactionOpen) db.exec('ROLLBACK')
    db.close()
  }
}

describePosix('SIGSTOP writer-epoch fencing', () => {
  afterAll(cleanupFencingRoots)

    test('serializes takeover behind a drainer paused inside the publish rename mutation', async () => {
      const paths = makeRoot('publish-rename-held')
      const fixture = singleCandidateFixture()
      const candidateId = fixture.candidates[0]!.candidateId
      writeFixture(paths.fixture, fixture)

      const drainer = startChild('paused-drainer', paths, {
        [FENCING_ENV.pauseAt]: 'publish-rename',
      })
      try {
        const paused = await waitForMarker(
          drainer,
          paths.marker,
          'beforePublishRename marker',
        )
        expect(paused).toMatchObject({
          phase: 'beforePublishRename',
          pid: drainer.child.pid,
          candidateId,
          oldEpoch: 1,
        })
        sendSignalWhileAlive(drainer, 'SIGSTOP')

        expect(immediateWriterAttempt(paths.knowledgeRoot)).toBe('busy')
        const whilePaused = acquireWriterLease(paths.knowledgeRoot, {
          mutationLockTakeoverMs: 0,
        })
        expect(whilePaused).toMatchObject({
          kind: 'held',
          holder: {
            pid: drainer.child.pid,
            leaseId: paused.leaseId,
            epoch: 1,
          },
        })
        expect(drainer.child.exitCode).toBeNull()
        expect(drainer.child.signalCode).toBeNull()

        writeDurableJson(paths.permit, { resume: true })
        sendSignalWhileAlive(drainer, 'SIGCONT')
        const report = await completeChildSuccessfully(drainer, paths.drainerReport)
        expect(report).toMatchObject({
          pauseAt: 'publish-rename',
          candidateId,
          hookCount: 1,
          beforePublishRenameReached: true,
          acceptedKind: 'applied',
          publicationEntryCount: 1,
        })
        expect(enumerateBundleDirs(paths.knowledgeRoot)).toHaveLength(1)
        const { db } = openIndexReaderConnection(paths.knowledgeRoot)
        try {
          expect(db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count).toBe(1)
        } finally {
          db.close()
        }

        expect(acquireWriterLease(paths.knowledgeRoot, {
          mutationLockTakeoverMs: 0,
        })).toMatchObject({ kind: 'acquired', epoch: 2 })
      } finally {
        if (drainer.child.exitCode === null && drainer.child.signalCode === null) {
          drainer.child.kill('SIGCONT')
        }
        await killIfRunning(drainer.child)
      }
    }, LEG_TIMEOUT_MS)

    const postPublicationTailTest =
      'serializes takeover behind a drainer paused in the post-publication commit tail'
    test(postPublicationTailTest, async () => {
      const paths = makeRoot('post-publication-tail-held')
      const fixture = singleCandidateFixture()
      const candidateId = fixture.candidates[0]!.candidateId
      writeFixture(paths.fixture, fixture)

      const drainer = startPausedDrainer(paths, 'afterBundlePublished')
      try {
        const paused = await waitForMarker(
          drainer,
          paths.marker,
          'afterBundlePublished marker',
        )
        expect(paused).toMatchObject({
          phase: 'afterBundlePublished',
          pid: drainer.child.pid,
          candidateId,
          oldEpoch: 1,
        })
        sendSignalWhileAlive(drainer, 'SIGSTOP')

        expect(immediateWriterAttempt(paths.knowledgeRoot)).toBe('busy')
        expect(acquireWriterLease(paths.knowledgeRoot, {
          mutationLockTakeoverMs: 0,
        })).toMatchObject({
          kind: 'held',
          holder: {
            pid: drainer.child.pid,
            leaseId: paused.leaseId,
            epoch: 1,
          },
        })
        expect(drainer.child.exitCode).toBeNull()
        expect(drainer.child.signalCode).toBeNull()

        const pausedBundles = enumerateBundleDirs(paths.knowledgeRoot)
        expect(pausedBundles).toHaveLength(1)
        const pausedBundle = loadBundle(pausedBundles[0]!.dir)
        expect(pausedBundle.kind).toBe('loaded')
        if (pausedBundle.kind !== 'loaded') throw new Error('paused bundle was not readable')
        expect(pausedBundle.bundle.events.map((event) => event.type)).toEqual([
          'confirmed',
          'promoted',
        ])
        expect(pausedBundle.bundle.relations.relations).toEqual([])
        expect(existsSync(join(
          pausedBundles[0]!.dir,
          'evidence/measurements.json',
        ))).toBe(false)
        const pausedIndex = openIndexReaderConnection(paths.knowledgeRoot)
        try {
          expect(pausedIndex.db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count)
            .toBe(0)
        } finally {
          pausedIndex.db.close()
        }

        writeDurableJson(paths.permit, { resume: true })
        sendSignalWhileAlive(drainer, 'SIGCONT')
        const report = await completeChildSuccessfully(drainer, paths.drainerReport)
        expect(report).toMatchObject({
          pauseAt: 'afterBundlePublished',
          candidateId,
          oldEpoch: 1,
          hookCount: 1,
          acceptedKind: 'applied',
          publicationEntryCount: 1,
        })

        const bundles = enumerateBundleDirs(paths.knowledgeRoot)
        expect(bundles).toHaveLength(1)
        const loaded = loadBundle(bundles[0]!.dir)
        expect(loaded.kind).toBe('loaded')
        if (loaded.kind !== 'loaded') throw new Error('completed bundle was not readable')
        expect(loaded.bundle.events.map((event) => event.type)).toEqual([
          'confirmed',
          'promoted',
        ])
        expect(loaded.bundle.relations.relations).toEqual([])
        expect(existsSync(join(
          bundles[0]!.dir,
          'evidence/measurements.json',
        ))).toBe(false)
        const completedIndex = openIndexReaderConnection(paths.knowledgeRoot)
        try {
          expect(completedIndex.db.prepare(`
            SELECT bundle_id FROM records ORDER BY bundle_id
          `).all()).toEqual([{ bundle_id: loaded.bundle.manifest.id }])
        } finally {
          completedIndex.db.close()
        }

        expect(acquireWriterLease(paths.knowledgeRoot, {
          mutationLockTakeoverMs: 0,
        })).toMatchObject({ kind: 'acquired', epoch: 2 })
      } finally {
        if (drainer.child.exitCode === null && drainer.child.signalCode === null) {
          drainer.child.kill('SIGCONT')
        }
        await killIfRunning(drainer.child)
      }
    }, LEG_TIMEOUT_MS)

    test('refuses a drainer resumed after the daemon reclaims and commits X', async () => {
      const paths = makeRoot('reclaim')
      const fixture = singleCandidateFixture()
      writeFixture(paths.fixture, fixture)

      const drainer = startChild('paused-drainer', paths)
      let daemon: ReturnType<typeof startChild> | undefined
      try {
        const paused = await waitForMarker(drainer, paths.marker, 'beforeCommitAuthorityEntry marker')
        const candidateId = fixture.candidates[0]!.candidateId
        expect(paused).toMatchObject({
          phase: 'beforeCommitAuthorityEntry',
          pid: drainer.child.pid,
          candidateId,
          oldEpoch: 1,
        })
        sendSignalWhileAlive(drainer, 'SIGSTOP')

        await new Promise((resolve) =>
          setTimeout(resolve, LEASE_HEARTBEAT_TTL_MS + 1_500))

        daemon = startChild('reclaiming-daemon', paths)
        await waitForMarker(daemon, paths.readyMarker, 'successor daemon readiness')
        await nudgeDaemon(paths.agentQaRoot)
        const committed = await waitForMarker(
          daemon,
          paths.committedMarker,
          'successor commit and post-X heartbeat',
        )
        expect(committed).toMatchObject({
          committed: true,
          candidateId,
          holderPid: daemon.child.pid,
          epoch: 2,
          diskEpoch: 2,
        })
        expect(daemon.child.exitCode).toBeNull()
        expect(daemon.child.signalCode).toBeNull()

        const beforeResume = readWriterLease(paths.knowledgeRoot)
        expect(beforeResume.kind).toBe('parsed')
        if (beforeResume.kind !== 'parsed') throw new Error('successor lease disappeared')
        expect(beforeResume.lease).toMatchObject({
          pid: daemon.child.pid,
          leaseId: committed.leaseId,
          epoch: committed.epoch,
        })
        expect(Date.now() - beforeResume.lease.heartbeatAtMs).toBeLessThan(
          LEASE_HEARTBEAT_TTL_MS,
        )
        expect(Number(readFileSync(`${paths.knowledgeRoot}/.epoch`, 'utf8').trim())).toBe(2)

        writeDurableJson(paths.permit, { resume: true })
        sendSignalWhileAlive(drainer, 'SIGCONT')
        const refusal = await completeChildExpectingRefusal(drainer, paths.drainerReport)
        expect(refusal).toMatchObject({
          candidateId,
          oldEpoch: 1,
          exactInputRetained: true,
          hookCount: 1,
          beforePublishRenameReached: false,
          retainedReferenceEquality: {
            deps: true,
            job: true,
            checkpoint: true,
          },
          mutationFreeReplay: true,
          nonHeartbeatEventsUnchanged: true,
          publicationEntryCount: 0,
        })
        expect(refusal.outcomes).toEqual([{
            guard: 'beforePublish',
            kind: 'abandoned-stale-epoch',
            observedEpoch: 2,
          }, {
            guard: 'beforeWork',
            kind: 'abandoned-stale-epoch',
            observedEpoch: 2,
          }])

        const afterRefusal = readWriterLease(paths.knowledgeRoot)
        expect(afterRefusal.kind).toBe('parsed')
        if (afterRefusal.kind !== 'parsed') throw new Error('successor lease disappeared')
        expect(afterRefusal.lease).toMatchObject({
          pid: daemon.child.pid,
          leaseId: committed.leaseId,
          epoch: 2,
        })
        expect(Date.now() - afterRefusal.lease.heartbeatAtMs).toBeLessThan(
          LEASE_HEARTBEAT_TTL_MS,
        )
        expect(storeDigest(paths.knowledgeRoot)).toBe(committed.storeDigest)

        sendSignalWhileAlive(daemon, 'SIGTERM')
        const daemonReport = await completeChildSuccessfully(daemon, paths.daemonReport)
        expect(daemonReport).toMatchObject({ candidateId, exitCode: 0 })
        expect(inspectDaemonRegistration(paths.agentQaRoot).kind).toBe('absent')
        expect(readWriterLease(paths.knowledgeRoot).kind).toBe('absent')

        const bundles = enumerateBundleDirs(paths.knowledgeRoot)
        expect(bundles).toHaveLength(1)
        expect(loadBundle(bundles[0]!.dir).kind).toBe('loaded')
        const { db } = openIndexReaderConnection(paths.knowledgeRoot)
        try {
          expect(db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count).toBe(1)
        } finally {
          db.close()
        }

        const events = readFileSync(
          `${paths.agentQaRoot}/${DAEMON_EVENTS_FILE}`,
          'utf8',
        ).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
        const acquiredIndex = findEventAfter(events, -1, (event) =>
          event.kind === 'lease-acquired'
          && event.pid === committed.holderPid
          && event.leaseId === committed.leaseId
          && event.epoch === committed.epoch)
        const reclaimedIndex = findEventAfter(events, acquiredIndex, (event) =>
          event.kind === 'lease-reclaimed'
          && event.priorHolderPid === paused.pid
          && event.priorLeaseId === paused.leaseId
          && event.priorEpoch === paused.oldEpoch
          && event.newEpoch === committed.epoch)
        const epochIndex = findEventAfter(events, reclaimedIndex, (event) =>
          event.kind === 'epoch-bump' && event.epoch === committed.epoch)
        const sessionStartIndex = findEventAfter(events, epochIndex, (event) =>
          event.kind === 'drain-session-start'
          && event.holderPid === committed.holderPid
          && event.epoch === committed.epoch)
        const sessionId = events[sessionStartIndex]!.sessionId
        const claimedIndex = findEventAfter(events, sessionStartIndex, (event) =>
          event.kind === 'job-claimed'
          && event.candidateId === candidateId
          && event.sessionId === sessionId
          && event.holderPid === committed.holderPid
          && event.leaseId === committed.leaseId
          && event.epoch === committed.epoch)
        const completedIndex = findEventAfter(events, claimedIndex, (event) =>
          event.kind === 'job-completed'
          && event.candidateId === candidateId
          && event.sessionId === sessionId
          && event.holderPid === committed.holderPid
          && event.leaseId === committed.leaseId
          && event.epoch === committed.epoch)
        const sessionEndIndex = findEventAfter(events, completedIndex, (event) =>
          event.kind === 'drain-session-end'
          && event.sessionId === sessionId
          && event.holderPid === committed.holderPid
          && event.epoch === committed.epoch)
        const heartbeatIndex = findEventAfter(events, sessionEndIndex, (event) =>
          event.kind === 'lease-heartbeated'
          && event.pid === committed.holderPid
          && event.epoch === committed.epoch)
        findEventAfter(events, heartbeatIndex, (event) => event.kind === 'daemon-stopped')
        expect(events.filter((event) =>
          event.kind === 'job-completed' && event.candidateId === candidateId)).toHaveLength(1)
      } finally {
        if (drainer.child.exitCode === null && drainer.child.signalCode === null) {
          drainer.child.kill('SIGCONT')
        }
        await killIfRunning(drainer.child)
        if (daemon !== undefined) await killIfRunning(daemon.child)
        expect(existsSync(paths.fixture)).toBe(true)
      }
    }, LEG_TIMEOUT_MS)

    test('serializes takeover behind a drainer paused after the final authority comparison', async () => {
      const paths = makeRoot('post-comparison-held')
      const fixture = singleCandidateFixture()
      const candidateId = fixture.candidates[0]!.candidateId
      writeFixture(paths.fixture, fixture)

      const drainer = startChild('paused-drainer', paths, {
        [FENCING_ENV.pauseAt]: 'afterFinalAuthorityCompare',
      })
      try {
        const paused = await waitForMarker(
          drainer,
          paths.marker,
          'afterFinalAuthorityCompare marker',
        )
        expect(paused).toMatchObject({
          phase: 'afterFinalAuthorityCompare',
          pid: drainer.child.pid,
          candidateId,
          oldEpoch: 1,
        })
        sendSignalWhileAlive(drainer, 'SIGSTOP')
        expect(immediateWriterAttempt(paths.knowledgeRoot)).toBe('busy')
        expect(acquireWriterLease(paths.knowledgeRoot, {
          mutationLockTakeoverMs: 0,
        })).toMatchObject({
          kind: 'held',
          holder: {
            pid: drainer.child.pid,
            leaseId: paused.leaseId,
            epoch: 1,
          },
        })
        expect(drainer.child.exitCode).toBeNull()
        expect(drainer.child.signalCode).toBeNull()

        writeDurableJson(paths.permit, { resume: true })
        sendSignalWhileAlive(drainer, 'SIGCONT')
        const report = await completeChildSuccessfully(drainer, paths.drainerReport)
        expect(report).toMatchObject({
          pauseAt: 'afterFinalAuthorityCompare',
          candidateId,
          oldEpoch: 1,
          hookCount: 1,
          beforePublishRenameReached: true,
          acceptedKind: 'applied',
          publicationEntryCount: 1,
        })
        const bundles = enumerateBundleDirs(paths.knowledgeRoot)
        expect(bundles).toHaveLength(1)
        expect(loadBundle(bundles[0]!.dir).kind).toBe('loaded')
        const { db } = openIndexReaderConnection(paths.knowledgeRoot)
        try {
          expect(db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count).toBe(1)
        } finally {
          db.close()
        }

        expect(acquireWriterLease(paths.knowledgeRoot, {
          mutationLockTakeoverMs: 0,
        })).toMatchObject({ kind: 'acquired', epoch: 2 })
      } finally {
        if (drainer.child.exitCode === null && drainer.child.signalCode === null) {
          drainer.child.kill('SIGCONT')
        }
        await killIfRunning(drainer.child)
        expect(existsSync(paths.fixture)).toBe(true)
      }
    }, LEG_TIMEOUT_MS)

    // Reconciliation requeues the candidate for the unpublished bundle; the successor commits once.
    test('reclaims a writer stopped holding a durable intent for an unpublished bundle', async () => {
      const paths = makeRoot('durable-intent-unpublished')
      const fixture = singleCandidateFixture()
      const candidateId = fixture.candidates[0]!.candidateId
      writeFixture(paths.fixture, fixture)

      const drainer = startPausedDrainer(paths, 'afterIntentWritten')
      let daemon: ReturnType<typeof startChild> | undefined
      try {
        const paused = await waitForMarker(drainer, paths.marker, 'afterIntentWritten marker')
        expect(paused).toMatchObject({
          phase: 'afterIntentWritten',
          pid: drainer.child.pid,
          candidateId,
          oldEpoch: 1,
        })
        sendSignalWhileAlive(drainer, 'SIGSTOP')

        // The premise, read from the kernel rather than from this process's bookkeeping.
        expect(processStateChar(drainer.child.pid!)).toMatch(/^T/)
        expect(immediateWriterAttempt(paths.knowledgeRoot)).toBe('busy')

        // Intent durable, transaction held, nothing published, index empty.
        expect(liveIntentNames(paths.knowledgeRoot)).toEqual([`${candidateId}.intent.json`])
        const inheritedIntent = JSON.parse(
          journalBytes(paths.knowledgeRoot, `${candidateId}.intent.json`),
        ) as Record<string, unknown>
        expect(inheritedIntent).toMatchObject({ candidateId, epoch: 1 })
        expect(enumerateBundleDirs(paths.knowledgeRoot)).toHaveLength(0)
        expect(indexedBundleIds(paths.knowledgeRoot)).toEqual([])

        await new Promise((resolve) => setTimeout(resolve, LEASE_HEARTBEAT_TTL_MS + 1_500))

        daemon = startReclaimingDaemon(paths, RECLAIM_SEAMS)
        const ready = await waitForMarker(daemon, paths.readyMarker, 'successor daemon readiness')
        await assertEscalatedReclaim({ paths, drainer, daemon, paused, ready })

        await nudgeDaemon(paths.agentQaRoot)
        const committed = await waitForMarker(
          daemon,
          paths.committedMarker,
          'successor commit and post-reclaim heartbeat',
        )
        expect(committed).toMatchObject({
          committed: true,
          candidateId,
          holderPid: daemon.child.pid,
          epoch: 2,
          diskEpoch: 2,
        })

        // The inherited intent named a bundle no successor can find: requeued, never projected.
        const [reconcile] = await waitForReconcilePasses(
          daemon,
          paths,
          1,
          "the successor's reconcile pass",
        )
        expect(reconcile).toMatchObject({
          intentsDiscarded: 1,
          intentsReplayed: 0,
          intentsQuarantinedStale: 0,
          malformed: 0,
        })
        expect(Number(reconcile?.jobsRequeued)).toBeGreaterThanOrEqual(1)

        // No duplicate and no loss: exactly one record, and the journal is empty in both partitions.
        const bundles = enumerateBundleDirs(paths.knowledgeRoot)
        expect(bundles).toHaveLength(1)
        expect(loadBundle(bundles[0]!.dir).kind).toBe('loaded')
        expect(indexedBundleIds(paths.knowledgeRoot)).toHaveLength(1)
        expect(liveIntentNames(paths.knowledgeRoot)).toEqual([])
        expect(quarantinedIntentNames(paths.knowledgeRoot)).toEqual([])

        sendSignalWhileAlive(daemon, 'SIGTERM')
        const daemonReport = await completeChildSuccessfully(daemon, paths.daemonReport)
        expect(daemonReport).toMatchObject({ candidateId, exitCode: 0 })
      } finally {
        if (drainer.child.exitCode === null && drainer.child.signalCode === null) {
          drainer.child.kill('SIGCONT')
        }
        await killIfRunning(drainer.child)
        if (daemon !== undefined) await killIfRunning(daemon.child)
      }
    }, LEG_TIMEOUT_MS)

    // Paused after the publish rename and before the index row, so the successor replays it.
    test('replays an inherited intent across processes and quarantines it below the watermark', async () => {
      const paths = makeRoot('durable-intent-replay-quarantine')
      const fixture = singleCandidateFixture()
      const candidateId = fixture.candidates[0]!.candidateId
      const intentName = `${candidateId}.intent.json`
      writeFixture(paths.fixture, fixture)

      const drainer = startPausedDrainer(paths, 'afterBundlePublished')
      let daemon: ReturnType<typeof startChild> | undefined
      try {
        const paused = await waitForMarker(drainer, paths.marker, 'afterBundlePublished marker')
        expect(paused).toMatchObject({
          phase: 'afterBundlePublished',
          pid: drainer.child.pid,
          candidateId,
          oldEpoch: 1,
        })
        sendSignalWhileAlive(drainer, 'SIGSTOP')
        expect(processStateChar(drainer.child.pid!)).toMatch(/^T/)
        expect(immediateWriterAttempt(paths.knowledgeRoot)).toBe('busy')

        // Intent durable, bundle published, index row still missing: the replayable state.
        expect(liveIntentNames(paths.knowledgeRoot)).toEqual([intentName])
        const authoredIntentBytes = journalBytes(paths.knowledgeRoot, intentName)
        const authoredIntent = JSON.parse(authoredIntentBytes) as Record<string, unknown>
        expect(authoredIntent).toMatchObject({ candidateId, epoch: 1 })
        const publishedBundleId = String(authoredIntent.bundleId)
        expect(enumerateBundleDirs(paths.knowledgeRoot)).toHaveLength(1)
        expect(indexedBundleIds(paths.knowledgeRoot)).toEqual([])

        await new Promise((resolve) => setTimeout(resolve, LEASE_HEARTBEAT_TTL_MS + 1_500))

        daemon = startReclaimingDaemon(paths, RECLAIM_SEAMS)
        const ready = await waitForMarker(daemon, paths.readyMarker, 'successor daemon readiness')
        await assertEscalatedReclaim({ paths, drainer, daemon, paused, ready })

        await nudgeDaemon(paths.agentQaRoot)
        await waitForMarker(
          daemon,
          paths.committedMarker,
          'successor commit and post-reclaim heartbeat',
        )

        // REPLAY: the inherited generation's intent was projected, then cleared — not quarantined.
        const [replayPass] = await waitForReconcilePasses(
          daemon,
          paths,
          1,
          "the successor's first reconcile pass",
        )
        expect(replayPass).toMatchObject({
          intentsReplayed: 1,
          intentsCleared: 1,
          intentsQuarantinedStale: 0,
          intentsDiscarded: 0,
          malformed: 0,
        })
        expect(indexedBundleIds(paths.knowledgeRoot)).toEqual([publishedBundleId])
        expect(liveIntentNames(paths.knowledgeRoot)).toEqual([])
        expect(quarantinedIntentNames(paths.knowledgeRoot)).toEqual([])

        // QUARANTINE: the same bytes, now authored below a watermark the successor has advanced.
        writeFileSync(
          join(paths.knowledgeRoot, JOURNAL_DIR, intentName),
          authoredIntentBytes,
          'utf8',
        )
        expect(liveIntentNames(paths.knowledgeRoot)).toEqual([intentName])

        const second = buildFixture('mixed').candidates[1]!
        enqueueFixtureBytes(paths.knowledgeRoot, {
          schemaVersion: 1,
          variant: 'mixed',
          candidates: [second],
          delayedCandidateId: null,
        })
        await nudgeDaemon(paths.agentQaRoot)
        await waitForDaemonEvent(
          daemon,
          paths.agentQaRoot,
          (event) => event.kind === 'job-completed' && event.candidateId === second.candidateId,
          'second drain pass completing its candidate',
        )

        // Exactly two passes, so the quarantine verdict below is unambiguously the second one's.
        const passes = await waitForReconcilePasses(
          daemon,
          paths,
          2,
          "the successor's second reconcile pass",
        )
        expect(passes).toHaveLength(2)
        const quarantinePass = passes[1]
        expect(quarantinePass).toMatchObject({
          intentsQuarantinedStale: 1,
          intentsReplayed: 0,
          intentsCleared: 0,
          intentsDiscarded: 0,
          malformed: 0,
        })
        // Renamed aside under the uniquified shape, bytes intact, never returned as a live intent.
        const quarantined = quarantinedIntentNames(paths.knowledgeRoot)
        expect(quarantined).toHaveLength(1)
        const parsedName = QUARANTINED_INTENT_FILE.exec(quarantined[0]!)
        expect(parsedName, `unexpected quarantine name: ${quarantined[0]}`).not.toBeNull()
        expect(parsedName![1]).toBe('1')
        expect(parsedName![2]).toBe(candidateId)
        expect(journalBytes(paths.knowledgeRoot, quarantined[0]!)).toBe(authoredIntentBytes)
        expect(liveIntentNames(paths.knowledgeRoot)).toEqual([])
        // It never reached the index: the replayed row stands alone beside the second candidate's.
        expect(indexedBundleIds(paths.knowledgeRoot)).toHaveLength(2)
        expect(indexedBundleIds(paths.knowledgeRoot)).toContain(publishedBundleId)

        sendSignalWhileAlive(daemon, 'SIGTERM')
        expect(await completeChildSuccessfully(daemon, paths.daemonReport))
          .toMatchObject({ candidateId, exitCode: 0 })
      } finally {
        if (drainer.child.exitCode === null && drainer.child.signalCode === null) {
          drainer.child.kill('SIGCONT')
        }
        await killIfRunning(drainer.child)
        if (daemon !== undefined) await killIfRunning(daemon.child)
      }
    }, LEG_TIMEOUT_MS)

    test('accepts the same real commit wrapper when authority was never reclaimed', async () => {
      const paths = makeRoot('no-pause-control')
      const fixture = singleCandidateFixture()
      const candidateId = fixture.candidates[0]!.candidateId
      writeFixture(paths.fixture, fixture)
      writeDurableJson(paths.permit, { resume: true, control: true })

      const control = startChild('paused-drainer', paths, {
        [FENCING_ENV.control]: '1',
      })
      try {
        const report = await completeChildSuccessfully(control, paths.drainerReport)
        expect(report).toMatchObject({
          failed: false,
          control: true,
          candidateId,
          hookCount: 1,
          acceptedKind: 'applied',
          publicationEntryCount: 1,
        })
        expect(enumerateBundleDirs(paths.knowledgeRoot)).toHaveLength(1)
        const { db } = openIndexReaderConnection(paths.knowledgeRoot)
        try {
          expect(db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count).toBe(1)
        } finally {
          db.close()
        }
      } finally {
        await killIfRunning(control.child)
      }
    }, LEG_TIMEOUT_MS)
  })
