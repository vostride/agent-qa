import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import type { CuratorAuthor } from '../curator/author-contract.js'
import { appendOutcomeEvent } from '../bundle-append.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import {
  drainQueue,
  type DrainOperations,
} from '../curator/drain.js'
import {
  runKnowledgeGc,
  type GcSummary,
  type RunKnowledgeGcInput,
} from '../gc.js'
import { openIndexReaderConnection } from '../index-open.js'
import {
  rebuildIndex,
  removeBundleProjectionRows,
} from '../index-rebuild.js'
import {
  acquireWriterLease,
  LEASE_FILE,
  LEASE_HEARTBEAT_TTL_MS,
  WRITER_AUTHORITY_DB_FILE,
  WriterAuthorityLostError,
  type CurrentWriterAuthority,
  type WriterLeaseAuthority,
} from '../lease/writer-lease.js'
import {
  claimNextJob,
  requeueClaimed,
  type ClaimNextJobOptions,
  type ClaimNextJobOutcome,
  type RequeueClaimedOptions,
} from '../queue/curation-queue.js'
import {
  claimedCandidateDir,
  jobStatePath,
  queuedCandidateDir,
} from '../queue/queue-layout.js'
import {
  readJobState,
  writeJobState,
  type WriteJobStateOptions,
} from '../queue/job-state.js'
import {
  reconcileOnDrainStart,
  type ReconcileOnDrainStartDependencies,
  type ReconcileReport,
} from '../journal/reconcile.js'
import {
  makeBundleDraftFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'
import {
  enqueueArtifactFreeCandidateProjection,
  type ArtifactFreeCandidateProjectionInput,
} from './fixtures/curation-candidate-fixture.js'
import { DISTILLED_OBSERVATION_SCHEMA_VERSION, asEvidenceToken, type RecordId } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FencedClaimNextJobOptions extends ClaimNextJobOptions {
  authority: CurrentWriterAuthority
}

interface FencedRequeueClaimedOptions extends RequeueClaimedOptions {
  authority: CurrentWriterAuthority
}

interface FencedWriteJobStateOptions extends WriteJobStateOptions {
  authority: CurrentWriterAuthority
}

interface FencedReconcileDependencies extends ReconcileOnDrainStartDependencies {
  writerAuthority: CurrentWriterAuthority
}

const fencedClaimNextJob = claimNextJob as unknown as (
  options: FencedClaimNextJobOptions,
) => ClaimNextJobOutcome | undefined
const fencedRequeueClaimed = requeueClaimed as unknown as (
  options: FencedRequeueClaimedOptions,
) => string[]
const fencedWriteJobState = writeJobState as unknown as (
  options: FencedWriteJobStateOptions,
) => ReturnType<typeof writeJobState>
const fencedReconcileOnDrainStart = reconcileOnDrainStart as unknown as (
  dependencies: FencedReconcileDependencies,
) => ReconcileReport

interface GcAuthorityHooks {
  beforeGcRemoval?(recordId: RecordId): void
}

const fencedRunKnowledgeGc = runKnowledgeGc as unknown as (
  input: RunKnowledgeGcInput,
  writerAuthority: WriterLeaseAuthority,
  hooks?: GcAuthorityHooks,
) => GcSummary
const fencedRemoveBundleProjectionRows = removeBundleProjectionRows as unknown as (
  knowledgeRoot: string,
  bundleIds: readonly string[],
  writerAuthority: WriterLeaseAuthority,
) => number

const NO_INDEX_MAINTENANCE = {
  indexAbsent: false,
  pendingEmbeddings: 0,
  renderingEpochStale: false,
  vectorReconciliationOutstanding: false,
} as const

function snapshotTree(root: string): string[] {
  if (!existsSync(root)) return []
  const snapshot: string[] = []
  const visit = (path: string): void => {
    for (const entry of readdirSync(path).sort()) {
      const absolute = join(path, entry)
      const key = relative(root, absolute)
      if (
        key === WRITER_AUTHORITY_DB_FILE
        || key.startsWith(`${WRITER_AUTHORITY_DB_FILE}-`)
      ) {
        continue
      }
      const stat = lstatSync(absolute)
      if (stat.isDirectory()) {
        snapshot.push(`dir:${key}`)
        visit(absolute)
      } else {
        snapshot.push(`file:${key}:${readFileSync(absolute).toString('base64')}`)
      }
    }
  }
  visit(root)
  return snapshot
}

describe('queue and recovery writer-authority fencing (CR-02)', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-queue-authority-fencing-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function projectionInput(seed: string): ArtifactFreeCandidateProjectionInput {
    return {
      sourceRunId: `run-${seed}`,
      scope: { tier: 'product', key: 'queue-authority-fencing' },
      buildOrdinal: 42,
      executionContext: 'local-headless',      kind: 'fact',
      subtype: 'selector',
      anchors: [{ t: 'el', role: 'button', name: seed }],
      summarySeed: `${seed} selector`,
      bodySeed: `${seed} was resolved and verified.`,
      distilledObservations: [
        {
          schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
          step: { naturalKey: seed, ordinal: 0 },
          platform: 'web',
          element: { naturalKey: `button:${seed}` },
          observedAtOrdinal: 42,
        },
      ],
      evidenceToken: `evidence-${seed}`,
      attributingObservationId: `observation-${seed}`,
      emittedAt: '2026-07-30T00:00:00.000Z',
    }
  }

  function enqueue(seed: string): string {
    const outcome = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot,
      projectionInput: projectionInput(seed),
    })
    expect(outcome.kind).toBe('enqueued')
    if (outcome.kind !== 'enqueued') throw new Error('expected enqueued candidate')
    return outcome.candidateId
  }

  function acquireAuthority(): CurrentWriterAuthority {
    const outcome = acquireWriterLease(knowledgeRoot)
    expect(outcome.kind).toBe('acquired')
    if (outcome.kind !== 'acquired') throw new Error('expected acquired writer authority')
    return { leaseId: outcome.leaseId, epoch: outcome.epoch }
  }

  function reclaim(stale: CurrentWriterAuthority): CurrentWriterAuthority {
    const leasePath = join(knowledgeRoot, LEASE_FILE)
    const holder = JSON.parse(readFileSync(leasePath, 'utf8')) as Record<string, unknown>
    expect(holder.leaseId).toBe(stale.leaseId)
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        ...holder,
        heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS,
      })}\n`,
      'utf8',
    )
    const outcome = acquireWriterLease(knowledgeRoot)
    expect(outcome.kind).toBe('acquired')
    if (outcome.kind !== 'acquired') throw new Error('expected replacement authority')
    expect(outcome.epoch).toBeGreaterThan(stale.epoch)
    return { leaseId: outcome.leaseId, epoch: outcome.epoch }
  }

  function reconcileDependencies(
    writerAuthority: CurrentWriterAuthority,
  ): FencedReconcileDependencies {
    return {
      knowledgeRoot,
      writerAuthority,
      hasIndexRow: () => true,
      applyIndexDelta: () => undefined,
      deriveIndexRowFromBundle: () => undefined,
    }
  }

  function writerAuthority(
    authority: CurrentWriterAuthority,
  ): WriterLeaseAuthority {
    return { knowledgeRoot, ...authority }
  }

  function publishGcChain(
    chain: string,
    supersededGenerations: number,
  ): { superseded: Array<{ id: RecordId; dir: string }>; head: { id: RecordId; dir: string } } {
    const config = {
      knowledgeRoot,
      productKey: 'queue-authority-fencing',
    }
    const generations = Array.from(
      { length: supersededGenerations + 1 },
      (_, index) => {
        const generation = index + 1
        const outcome = publishBundle(config, {
          draft: makeBundleDraftFixture({
            subtype: 'measurement',
            anchors: [{ t: 'flow', name: `${chain}-${generation}` }],
            scope: { tier: 'product', key: 'queue-authority-fencing' },
            summary: `${chain} generation ${generation}`,
            body: `${chain} generation ${generation} canonical body.`,
          }),
          discriminant: {
            kind: 'fact',
            subtype: 'measurement',
            metricKey: `${chain}-${generation}`,
          },
          originClass: 'agent-verified',
          createdAtOrdinal: generation,
          screenStates: [],
          initialEvents: [{
            type: 'promoted',
            evidenceToken: asEvidenceToken(`${chain}-promoted-${generation}`),
            curationJobId: `${chain}-publish-${generation}`,
            buildOrdinal: generation,
          }],
          relations: [],
          provenance: { mode: 'standalone', sourceDescription: `${chain} fixture` },
          artifacts: [],
        })
        expect(outcome.kind).toBe('published')
        if (outcome.kind !== 'published') throw new Error('expected GC fixture publication')
        return { id: outcome.id, dir: outcome.dir }
      },
    )

    for (let index = 0; index < supersededGenerations; index += 1) {
      const victim = generations[index]!
      const replacement = generations[index + 1]!
      const buildOrdinal = index + 2
      expect(appendOutcomeEvent(config, victim.id, {
        type: 'superseded',
        evidenceToken: asEvidenceToken(`${chain}-superseded-${buildOrdinal}`),
        curationJobId: `${chain}-supersede-${buildOrdinal}`,
        buildOrdinal,
        byRecordId: replacement.id,
      }).kind).toBe('appended')
      expect(appendOutcomeEvent(config, victim.id, {
        type: 'window-close',
        evidenceToken: asEvidenceToken(`${chain}-closed-${buildOrdinal}`),
        curationJobId: `${chain}-supersede-${buildOrdinal}`,
        buildOrdinal,
        closedAtOrdinal: buildOrdinal,
      }).kind).toBe('appended')
    }

    return {
      superseded: generations.slice(0, -1),
      head: generations.at(-1)!,
    }
  }

  function projectionExists(recordId: string): boolean {
    const reader = openIndexReaderConnection(knowledgeRoot)
    try {
      return reader.db
        .prepare('SELECT 1 AS present FROM records WHERE bundle_id = ?')
        .get(recordId) !== undefined
    } finally {
      reader.db.close()
    }
  }

  it('rejects a stale claim before the queued tree changes', () => {
    const candidateId = enqueue('stale-claim')
    const stale = acquireAuthority()
    reclaim(stale)
    const before = snapshotTree(knowledgeRoot)

    expect(() => fencedClaimNextJob({
      knowledgeRoot,
      leaseId: stale.leaseId,
      authority: stale,
    })).toThrow(WriterAuthorityLostError)

    expect(snapshotTree(knowledgeRoot)).toEqual(before)
    expect(existsSync(queuedCandidateDir(knowledgeRoot, candidateId))).toBe(true)
  })

  it('accepts a current-authority claim and initializes its lifecycle state', () => {
    const candidateId = enqueue('current-claim')
    const authority = acquireAuthority()

    const claimed = fencedClaimNextJob({
      knowledgeRoot,
      leaseId: authority.leaseId,
      authority,
    })

    expect(claimed).toMatchObject({ kind: 'claimed', candidateId })
    expect(readJobState(knowledgeRoot, candidateId)).toMatchObject({
      kind: 'parsed',
      state: { lifecycle: 'queued' },
    })
  })

  it('rejects a stale requeue without moving or deleting claimed bytes', () => {
    const candidateId = 'a'.repeat(64)
    mkdirSync(claimedCandidateDir(knowledgeRoot, 'expired-claim', candidateId), {
      recursive: true,
    })
    const stale = acquireAuthority()
    reclaim(stale)
    const before = snapshotTree(knowledgeRoot)

    expect(() => fencedRequeueClaimed({
      knowledgeRoot,
      leaseId: 'expired-claim',
      authority: stale,
    })).toThrow(WriterAuthorityLostError)

    expect(snapshotTree(knowledgeRoot)).toEqual(before)
  })

  it('accepts a current-authority recovery requeue', () => {
    const candidateId = 'b'.repeat(64)
    mkdirSync(claimedCandidateDir(knowledgeRoot, 'expired-claim', candidateId), {
      recursive: true,
    })
    const authority = acquireAuthority()

    expect(fencedRequeueClaimed({
      knowledgeRoot,
      leaseId: 'expired-claim',
      authority,
    })).toEqual([candidateId])

    expect(existsSync(queuedCandidateDir(knowledgeRoot, candidateId))).toBe(true)
    expect(readJobState(knowledgeRoot, candidateId)).toMatchObject({
      kind: 'parsed',
      state: { lifecycle: 'queued' },
    })
  })

  it('rejects a stale lifecycle write without publishing a state file', () => {
    const candidateId = 'c'.repeat(64)
    const stale = acquireAuthority()
    reclaim(stale)
    const before = snapshotTree(knowledgeRoot)

    expect(() => fencedWriteJobState({
      knowledgeRoot,
      candidateId,
      lifecycle: 'authored',
      authority: stale,
    })).toThrow(WriterAuthorityLostError)

    expect(snapshotTree(knowledgeRoot)).toEqual(before)
    expect(existsSync(jobStatePath(knowledgeRoot, candidateId))).toBe(false)
  })

  it('accepts a current-authority lifecycle write', () => {
    const candidateId = 'd'.repeat(64)
    const authority = acquireAuthority()

    fencedWriteJobState({
      knowledgeRoot,
      candidateId,
      lifecycle: 'authored',
      authority,
    })

    expect(readJobState(knowledgeRoot, candidateId)).toMatchObject({
      kind: 'parsed',
      state: { lifecycle: 'authored' },
    })
  })

  it('removes only the current authority own claim when marking done', () => {
    const candidateId = 'e'.repeat(64)
    const authority = acquireAuthority()
    const ownClaim = claimedCandidateDir(knowledgeRoot, authority.leaseId, candidateId)
    const successorClaim = claimedCandidateDir(knowledgeRoot, 'successor-lease', candidateId)
    mkdirSync(ownClaim, { recursive: true })
    mkdirSync(successorClaim, { recursive: true })

    fencedWriteJobState({
      knowledgeRoot,
      candidateId,
      lifecycle: 'done',
      authority,
    })

    expect(existsSync(ownClaim)).toBe(false)
    expect(existsSync(successorClaim)).toBe(true)
  })

  it('rejects stale reconciliation before moving a recoverable claim', () => {
    const candidateId = 'f'.repeat(64)
    mkdirSync(claimedCandidateDir(knowledgeRoot, 'expired-claim', candidateId), {
      recursive: true,
    })
    const stale = acquireAuthority()
    reclaim(stale)
    const before = snapshotTree(knowledgeRoot)

    expect(() => fencedReconcileOnDrainStart(
      reconcileDependencies(stale),
    )).toThrow(WriterAuthorityLostError)

    expect(snapshotTree(knowledgeRoot)).toEqual(before)
  })

  it('accepts current-authority reconciliation and recovers the dead lease', () => {
    const candidateId = '1'.repeat(64)
    mkdirSync(claimedCandidateDir(knowledgeRoot, 'expired-claim', candidateId), {
      recursive: true,
    })
    const authority = acquireAuthority()

    expect(fencedReconcileOnDrainStart(reconcileDependencies(authority))).toMatchObject({
      jobsRequeued: 1,
    })
    expect(existsSync(queuedCandidateDir(knowledgeRoot, candidateId))).toBe(true)
  })

  it('stops a drain on its first typed authority loss without claiming the next candidate', async () => {
    const queued = [enqueue('drain-first'), enqueue('drain-second')].sort()
    const stale = acquireAuthority()
    let reclaimed = false
    const claimDuringTakeover = vi.fn((options: FencedClaimNextJobOptions) => {
      if (!reclaimed) {
        reclaimed = true
        reclaim(stale)
      }
      return fencedClaimNextJob({ ...options, authority: stale })
    })
    const author = vi.fn(async () => {
      throw new Error('author must not run after claim authority loss')
    }) as CuratorAuthor

    const report = await drainQueue({
      knowledgeRoot,
      author,
      executionContext: 'local-headless',
      maintenance: 'skip',
      lease: stale,
      operations: {
        claimNextJob: claimDuringTakeover as unknown as DrainOperations['claimNextJob'],
        readRebuildRequest: () => ({ present: false }),
        readIndexMaintenanceState: () => NO_INDEX_MAINTENANCE,
      },
    })

    expect(report).toMatchObject({
      kind: 'drained',
      jobsProcessed: 0,
      committed: 0,
      failures: 1,
      failureDetails: [
        expect.objectContaining({
          stage: 'claim',
          message: expect.stringContaining('writer authority lost'),
        }),
      ],
    })
    expect(claimDuringTakeover).toHaveBeenCalledOnce()
    expect(author).not.toHaveBeenCalled()
    expect(queued.every((candidateId) =>
      existsSync(queuedCandidateDir(knowledgeRoot, candidateId)),
    )).toBe(true)
  })

  it('rejects a paused GC before its first bundle removal after authority takeover', async () => {
    const chain = publishGcChain('paused-gc', 2)
    await rebuildIndex({ knowledgeRoot })
    const stale = acquireAuthority()
    const beforeRemoval = vi.fn(() => {
      reclaim(stale)
    })

    expect(() => fencedRunKnowledgeGc(
      { knowledgeRoot, horizon: { kind: 'none' }, retainK: 0 },
      writerAuthority(stale),
      { beforeGcRemoval: beforeRemoval },
    )).toThrow(WriterAuthorityLostError)

    expect(beforeRemoval).toHaveBeenCalledOnce()
    expect(chain.superseded.every(({ dir }) => existsSync(dir))).toBe(true)
    expect(chain.superseded.every(({ id }) => projectionExists(id))).toBe(true)
  })

  it('stops a GC sweep at the first removal boundary after authority loss', () => {
    const chain = publishGcChain('mid-sweep-gc', 3)
    const ordered = [...chain.superseded].sort((left, right) =>
      left.id.localeCompare(right.id),
    )
    const stale = acquireAuthority()
    const removals: RecordId[] = []

    expect(() => fencedRunKnowledgeGc(
      { knowledgeRoot, horizon: { kind: 'none' }, retainK: 0 },
      writerAuthority(stale),
      {
        beforeGcRemoval(recordId) {
          removals.push(recordId)
          if (removals.length === 2) reclaim(stale)
        },
      },
    )).toThrow(WriterAuthorityLostError)

    expect(removals).toEqual(ordered.slice(0, 2).map(({ id }) => id))
    expect(existsSync(ordered[0]!.dir)).toBe(false)
    expect(ordered.slice(1).every(({ dir }) => existsSync(dir))).toBe(true)
  })

  it('accepts current-authority GC and removes exactly its planned garbage set', () => {
    const chain = publishGcChain('current-gc', 2)
    const authority = acquireAuthority()

    const summary = fencedRunKnowledgeGc(
      { knowledgeRoot, horizon: { kind: 'none' }, retainK: 0 },
      writerAuthority(authority),
    )

    expect(summary.trimmedRecordIds).toEqual(
      chain.superseded.map(({ id }) => id).sort(),
    )
    expect(chain.superseded.every(({ dir }) => !existsSync(dir))).toBe(true)
    expect(existsSync(chain.head.dir)).toBe(true)
  })

  it('rejects stale projection deletion before its transaction removes a row', async () => {
    const chain = publishGcChain('stale-projection', 0)
    await rebuildIndex({ knowledgeRoot })
    const stale = acquireAuthority()
    reclaim(stale)

    expect(() => fencedRemoveBundleProjectionRows(
      knowledgeRoot,
      [chain.head.id],
      writerAuthority(stale),
    )).toThrow(WriterAuthorityLostError)
    expect(projectionExists(chain.head.id)).toBe(true)
  })
})
