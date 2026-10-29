import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  asRecordId,
  canonicalJson,
  type CanaryOutcome,
  type CurationAuthorship,
  type Delta,
  type ExecutionContext,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { scaffoldKnowledgeRoot } from '../../__tests__/fixtures/bundle-fixture.js'
import {
  enqueueArtifactFreeCandidateProjection,
  type ArtifactFreeCandidateProjectionInput,
} from '../../__tests__/fixtures/curation-candidate-fixture.js'
import { deriveBundleTrust, loadBundle } from '../../bundle-read.js'
import { enumerateBundleDirs } from '../../bundle-scan.js'
import { enqueueCanaryOutcome } from '../../canary-emit.js'
import * as knowledgeLocal from '../../index.js'
import {
  acquireWriterLease,
  LEASE_FILE,
  LEASE_HEARTBEAT_TTL_MS,
  releaseLease,
  WriterAuthorityLostError,
} from '../../lease/writer-lease.js'
import * as curationQueue from '../../queue/curation-queue.js'
import {
  claimNextJob,
  listQueuedCandidates,
  type ClaimedCurationJob,
} from '../../queue/curation-queue.js'
import { CURATION_JOB_STATE_SCHEMA_VERSION, readJobState } from '../../queue/job-state.js'
import {
  claimedCandidateDir,
  claimedLeaseDir,
  queuedCandidateDir,
} from '../../queue/queue-layout.js'
import { requestRebuild } from '../../rebuild-marker.js'
import type { CuratorAuthor } from '../author-contract.js'
import {
  drainQueue,
  type CurationDrainLifecycleEvent,
  type DrainOperations,
} from '../drain.js'
import {
  createLocalKnowledgeStore,
  type CanaryAuthorityHooks,
} from '../knowledge-store.js'

const NO_INDEX_MAINTENANCE = {
  indexAbsent: false,
  pendingEmbeddings: 0,
  renderingEpochStale: false,
  vectorReconciliationOutstanding: false,
} as const

describe('drainQueue daemon substrate', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-drain-daemon-substrate-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function projectionInput(
    seed: string,
    executionContext: ExecutionContext,
  ): ArtifactFreeCandidateProjectionInput {
    return {
      sourceRunId: 'run-mixed-context',
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext,      kind: 'fact',
      subtype: 'selector',
      anchors: [
        { t: 'el', role: 'button', name: seed, ordinal: 0 },
        { t: 'page', route: `/${seed}` },
        { t: 'selector', literal: `[data-testid="${seed}"]` },
      ],
      summarySeed: `${seed} selector`,
      bodySeed: `${seed} was resolved and verified.`,
      distilledObservations: [
        {
          schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
          step: { naturalKey: `${seed}-click`, ordinal: 0 },
          platform: 'web',
          element: { naturalKey: `button:${seed}:0` },
          locator: { selector: `[data-testid="${seed}"]` },
          observedAtOrdinal: 42,
        },
      ],
      evidenceToken: `evidence-${seed}`,
      attributingObservationId: `observation-${seed}`,
      emittedAt: '2026-07-30T00:00:00.000Z',
    }
  }

  function enqueue(seed: string, executionContext: ExecutionContext): string {
    const outcome = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot,
      projectionInput: projectionInput(seed, executionContext),
    })
    expect(outcome.kind).toBe('enqueued')
    if (outcome.kind !== 'enqueued') throw new Error('expected enqueued projection')
    return outcome.candidateId
  }

  function scriptedAuthor(): CuratorAuthor {
    return async (job) => {
      const authorship: CurationAuthorship = {
        path: 'llm',
        model: { id: 'daemon-substrate-fixture' },
        executionContext: job.executionContext,
      }
      const delta: Delta = {
        kind: 'Add',
        origin: 'agent',
        scope: job.scope,
        citedIds: [],
        authorship,
        bundle: {
          kind: job.kind,
          ...(job.subtype === undefined ? {} : { subtype: job.subtype }),
          anchors: job.anchors,
          scope: job.scope,
          summary: job.summarySeed,
          body: job.bodySeed,
          distilledEvidenceRef: {
            id: `curation-candidate-${job.candidateId}`,
            sha: job.candidateId,
          },
          originStage: 'run-curation',
        },
      }
      return { kind: 'authored', deltas: [delta], authorship }
    }
  }

  function maintenanceFreeOperations(): Partial<DrainOperations> {
    return {
      readRebuildRequest: () => ({ present: false }),
      readIndexMaintenanceState: () => NO_INDEX_MAINTENANCE,
    }
  }

  function statusesBySummary(): Record<string, string> {
    return Object.fromEntries(
      enumerateBundleDirs(knowledgeRoot).map(({ dir }) => {
        const loaded = loadBundle(dir)
        if (loaded.kind !== 'loaded') throw new Error(`expected loaded bundle at ${dir}`)
        return [loaded.bundle.summary, deriveBundleTrust(loaded.bundle).status]
      }),
    )
  }

  type SqlValue = null | number | string | bigint | Uint8Array

  function quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`
  }

  function normalizeSqlValue(value: SqlValue): unknown {
    if (typeof value === 'bigint') return { bigint: value.toString() }
    if (value instanceof Uint8Array) {
      return { blobHex: Buffer.from(value).toString('hex') }
    }
    return value
  }

  function orderedLogicalIndexDump(): string {
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      const tables = reader.db.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all().map((row) => String(row.name))
      return canonicalJson(tables.map((table) => {
        const columns = reader.db
          .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
          .all()
          .map((row) => String(row.name))
          .filter((column) => column !== 'embedding')
        if (columns.length === 0) return { table, columns, rows: [] }
        const selection = columns.map(quoteIdentifier).join(', ')
        const rows = reader.db.prepare(
          `SELECT ${selection} FROM ${quoteIdentifier(table)} ORDER BY ${selection}`,
        ).all().map((row) => Object.fromEntries(
          columns.map((column) => [
            column,
            normalizeSqlValue(row[column] as SqlValue),
          ]),
        ))
        return { table, columns, rows }
      }))
    } finally {
      reader.db.close()
    }
  }

  function bundleByteTree(): string {
    const filesBelow = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = join(dir, entry.name)
        return entry.isDirectory() ? filesBelow(file) : entry.isFile() ? [file] : []
      })
    return canonicalJson(
      enumerateBundleDirs(knowledgeRoot)
        .flatMap(({ dir }) => filesBelow(dir).map((file) => ({
          path: relative(knowledgeRoot, file),
          bytes: readFileSync(file).toString('base64'),
        })))
        .sort((left, right) => left.path.localeCompare(right.path)),
    )
  }

  function reportRemaining(report: unknown): unknown {
    return (report as { remaining?: unknown }).remaining
  }

  function maintenanceTail() {
    const runMaintenanceTail = (
      knowledgeLocal as unknown as {
        runMaintenanceTail?: (options: {
          knowledgeRoot: string
          lease: { leaseId: string; epoch: number }
          operations?: Partial<DrainOperations>
        }) => Promise<{
          writerPass: unknown
          gc: unknown
          failures: readonly unknown[]
        }>
      }
    ).runMaintenanceTail
    expect(runMaintenanceTail).toBeTypeOf('function')
    if (runMaintenanceTail === undefined) throw new Error('runMaintenanceTail is not exported')
    return runMaintenanceTail
  }

  it('uses each claimed payload context inside one mixed-context drain', async () => {
    enqueue('ci-checkout', 'ci')
    enqueue('interactive-checkout', 'local-interactive')

    const report = await drainQueue({
      knowledgeRoot,
      author: scriptedAuthor(),
      executionContext: 'local-headless',
      operations: maintenanceFreeOperations(),
    })

    expect(report).toMatchObject({
      kind: 'drained',
      jobsProcessed: 2,
      committed: 2,
      failures: 0,
    })
    expect(reportRemaining(report)).toBe(0)
    expect(statusesBySummary()).toEqual({
      'ci-checkout selector': 'candidate',
      'interactive-checkout selector': 'active',
    })
    expect(listQueuedCandidates(knowledgeRoot)).toEqual([])

    const beforeSecondDrain = statusesBySummary()
    const second = await drainQueue({
      knowledgeRoot,
      author: scriptedAuthor(),
      executionContext: 'ci',
      operations: maintenanceFreeOperations(),
    })

    expect(second).toMatchObject({ kind: 'drained', jobsProcessed: 0, committed: 0 })
    expect(reportRemaining(second)).toBe(0)
    expect(statusesBySummary()).toEqual(beforeSecondDrain)
  })

  const completedReplayTest =
    'replays one completed candidate through duplicate arms without changing durable state'
  it(completedReplayTest, async () => {
    const candidateId = enqueue('completed-replay', 'local-interactive')
    const authority = acquireWriterLease(knowledgeRoot)
    if (authority.kind !== 'acquired') throw new Error('expected caller-owned replay lease')
    let retained: Parameters<typeof knowledgeLocal.commitCurationDelta> | undefined

    const report = await drainQueue({
      knowledgeRoot,
      author: scriptedAuthor(),
      executionContext: 'local-interactive',
      maintenance: 'skip',
      lease: { leaseId: authority.leaseId, epoch: authority.epoch },
      operations: {
        ...maintenanceFreeOperations(),
        commitCurationDelta: (...args) => {
          retained = args
          return knowledgeLocal.commitCurationDelta(...args)
        },
      },
    })

    expect(report).toMatchObject({
      kind: 'drained',
      jobsProcessed: 1,
      committed: 1,
      failures: 0,
    })
    expect(readJobState(knowledgeRoot, candidateId).kind).toBe('absent')
    if (retained === undefined) throw new Error('drain did not retain its commit input')
    const before = {
      bundles: bundleByteTree(),
      logicalIndex: orderedLogicalIndexDump(),
    }

    expect(knowledgeLocal.commitCurationDelta(...retained)).toMatchObject({
      kind: 'noop',
      reason: 'evidence-token-consumed',
    })
    expect({
      bundles: bundleByteTree(),
      logicalIndex: orderedLogicalIndexDump(),
    }).toEqual(before)
    expect(releaseLease({ knowledgeRoot, leaseId: authority.leaseId })).toEqual({
      kind: 'released',
    })
  })

  it('uses the drain-scoped fallback for a claimed legacy payload without context', async () => {
    const candidateId = enqueue('legacy-checkout', 'local-interactive')
    const author = vi.fn(scriptedAuthor())
    const claimWithoutContext: DrainOperations['claimNextJob'] = (options) => {
      const claimed = claimNextJob(options)
      if (claimed?.kind !== 'claimed') return claimed
      return {
        ...claimed,
        payload: {
          ...claimed.payload,
          executionContext: undefined,
        } as unknown as ClaimedCurationJob['payload'],
      }
    }

    const report = await drainQueue({
      knowledgeRoot,
      author,
      executionContext: 'local-headless',
      operations: {
        ...maintenanceFreeOperations(),
        claimNextJob: claimWithoutContext,
      },
    })

    expect(report).toMatchObject({
      kind: 'drained',
      jobsProcessed: 1,
      committed: 1,
      failures: 0,
    })
    expect(author).toHaveBeenCalledOnce()
    expect(author.mock.calls[0]?.[0].executionContext).toBe('local-headless')
    // the local-headless fallback drains to active, so the promotion floor runs.
    expect(statusesBySummary()).toEqual({ 'legacy-checkout selector': 'active' })
    expect(listQueuedCandidates(knowledgeRoot)).toEqual([])
    expect(readJobState(knowledgeRoot, candidateId).kind).toBe('absent')
  })

  it('drains under a caller-owned lease without touching its lease bytes', async () => {
    enqueue('caller-owned-lease', 'local-interactive')
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected caller lease')
    const leasePath = join(knowledgeRoot, LEASE_FILE)
    const before = readFileSync(leasePath)

    const report = await drainQueue({
      knowledgeRoot,
      author: scriptedAuthor(),
      executionContext: 'ci',
      lease: { leaseId: acquired.leaseId, epoch: acquired.epoch },
      operations: maintenanceFreeOperations(),
    } as Parameters<typeof drainQueue>[0] & {
      lease: { leaseId: string; epoch: number }
    })

    expect(report).toMatchObject({
      kind: 'drained',
      jobsProcessed: 1,
      committed: 1,
      failures: 0,
    })
    expect(reportRemaining(report)).toBe(0)
    expect(readFileSync(leasePath)).toEqual(before)
    expect(statusesBySummary()).toEqual({ 'caller-owned-lease selector': 'active' })
    expect(releaseLease({ knowledgeRoot, leaseId: acquired.leaseId })).toEqual({
      kind: 'released',
    })
  })

  it('reports one lifecycle completion after a real multi-delta terminal transition', async () => {
    const candidateId = enqueue('multi-delta-lifecycle', 'local-interactive')
    const singleDeltaAuthor = scriptedAuthor()
    const author: CuratorAuthor = async (job, neighbors) => {
      const authored = await singleDeltaAuthor(job, neighbors)
      if (authored.kind !== 'authored') throw new Error('expected authored fixture')
      const delta = authored.deltas[0]
      if (delta === undefined) throw new Error('expected fixture delta')
      return {
        ...authored,
        deltas: [delta, delta],
      }
    }
    const observed: Array<CurationDrainLifecycleEvent & { durableState: string }> = []

    const report = await drainQueue({
      knowledgeRoot,
      author,
      executionContext: 'local-interactive',
      maintenance: 'skip',
      onJobLifecycle: (event) => {
        const state = readJobState(knowledgeRoot, event.candidateId)
        observed.push({
          ...event,
          durableState: state.kind === 'parsed' ? state.state.lifecycle : state.kind,
        })
      },
      operations: maintenanceFreeOperations(),
    })

    expect(report).toMatchObject({
      kind: 'drained',
      jobsProcessed: 1,
      failures: 0,
    })
    expect(observed).toEqual([
      { kind: 'job-claimed', candidateId, durableState: 'queued' },
      { kind: 'job-completed', candidateId, durableState: 'absent' },
    ])
    expect(readJobState(knowledgeRoot, candidateId).kind).toBe('absent')
  })

  it('refuses a stale caller lease before reconciliation or claim', async () => {
    const candidateId = enqueue('stale-epoch-lifecycle', 'local-interactive')
    const stale = acquireWriterLease(knowledgeRoot)
    if (stale.kind !== 'acquired') throw new Error('expected stale lease seed')
    expect(releaseLease({ knowledgeRoot, leaseId: stale.leaseId })).toEqual({
      kind: 'released',
    })
    const current = acquireWriterLease(knowledgeRoot)
    if (current.kind !== 'acquired') throw new Error('expected current lease')
    const leasePath = join(knowledgeRoot, LEASE_FILE)
    const currentLeaseBytes = readFileSync(leasePath)
    const observed: CurationDrainLifecycleEvent[] = []

    const report = await drainQueue({
      knowledgeRoot,
      author: scriptedAuthor(),
      executionContext: 'local-interactive',
      maintenance: 'skip',
      lease: { leaseId: stale.leaseId, epoch: stale.epoch },
      onJobLifecycle: (event) => observed.push(event),
      operations: maintenanceFreeOperations(),
    })

    expect(report).toMatchObject({
      kind: 'drained',
      jobsProcessed: 0,
      committed: 0,
      failures: 1,
      failureDetails: [
        expect.objectContaining({
          stage: 'reconcile',
          message: expect.stringContaining('writer authority lost'),
        }),
      ],
    })
    expect(observed).toEqual([])
    expect(readFileSync(leasePath)).toEqual(currentLeaseBytes)
    expect(enumerateBundleDirs(knowledgeRoot)).toEqual([])
    expect(readJobState(knowledgeRoot, candidateId)).toEqual({
      kind: 'absent',
      present: false,
    })
    expect(listQueuedCandidates(knowledgeRoot)).toEqual([candidateId])
    expect(releaseLease({ knowledgeRoot, leaseId: current.leaseId })).toEqual({
      kind: 'released',
    })
  })

  it.each([
    'malformed state',
    'author failure',
    'checkpoint failure',
    'requeue resynthesis',
    'embedding crash requeue',
    'non-terminal commit failure',
  ] as const)('never reports completion after %s', async (scenario) => {
    const candidateId = enqueue(`lifecycle-${scenario.replaceAll(' ', '-')}`, 'ci')
    const observed: CurationDrainLifecycleEvent[] = []
    let author: CuratorAuthor = scriptedAuthor()
    const operations: Partial<DrainOperations> = maintenanceFreeOperations()

    switch (scenario) {
      case 'malformed state':
        operations.readJobState = () => ({ kind: 'malformed', present: true })
        break
      case 'author failure':
        author = async () => {
          throw new Error('injected author failure')
        }
        break
      case 'checkpoint failure':
        operations.persistAuthoredCheckpoint = () => ({
          kind: 'malformed-state',
          present: true,
        })
        break
      case 'requeue resynthesis':
        operations.commitCurationDelta = () => ({
          kind: 'requeue-resynthesis',
          reason: 'injected compare-and-set miss',
        })
        break
      case 'embedding crash requeue':
        operations.commitCurationDelta = () => {
          throw new Error('injected native embedding crash')
        }
        break
      case 'non-terminal commit failure':
        operations.commitCurationDelta = () => ({
          kind: 'failed',
          reason: 'append-failed',
        })
        break
    }

    await drainQueue({
      knowledgeRoot,
      author,
      executionContext: 'ci',
      maintenance: 'skip',
      onJobLifecycle: (event) => observed.push(event),
      operations,
    })

    expect(observed).toEqual([{ kind: 'job-claimed', candidateId }])
  })

  it('reports no lifecycle event when abort wins before the claim boundary', async () => {
    enqueue('pre-claim-abort', 'ci')
    const controller = new AbortController()
    controller.abort()
    const observed: CurationDrainLifecycleEvent[] = []

    const report = await drainQueue({
      knowledgeRoot,
      author: scriptedAuthor(),
      executionContext: 'ci',
      maintenance: 'skip',
      signal: controller.signal,
      onJobLifecycle: (event) => observed.push(event),
      operations: maintenanceFreeOperations(),
    })

    expect(report).toMatchObject({ kind: 'aborted', jobsProcessed: 0, committed: 0 })
    expect(observed).toEqual([])
  })

  it('reports the exact pending remainder on budget cut and handed off exits', async () => {
    enqueue('budget-first', 'local-interactive')
    enqueue('budget-second', 'local-interactive')
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(60_000)

    const budgetCut = await drainQueue({
      knowledgeRoot,
      author: scriptedAuthor(),
      executionContext: 'ci',
      now,
      operations: maintenanceFreeOperations(),
    })

    expect(budgetCut).toMatchObject({ kind: 'drained', jobsProcessed: 1, committed: 1 })
    expect(listQueuedCandidates(knowledgeRoot)).toHaveLength(1)
    expect(reportRemaining(budgetCut)).toBe(1)

    const holder = acquireWriterLease(knowledgeRoot)
    if (holder.kind !== 'acquired') throw new Error('expected holder lease')
    const handedOff = await drainQueue({
      knowledgeRoot,
      author: scriptedAuthor(),
      executionContext: 'local-interactive',
      operations: maintenanceFreeOperations(),
    })

    expect(handedOff).toMatchObject({ kind: 'handed-off' })
    expect(reportRemaining(handedOff)).toBe(1)
    expect(releaseLease({ knowledgeRoot, leaseId: holder.leaseId })).toEqual({
      kind: 'released',
    })
  })

  it('counts pending jobs and treats absent or empty queues as zero', () => {
    const countPendingCurationJobs = (
      curationQueue as unknown as {
        countPendingCurationJobs?: (knowledgeRoot: string) => number
      }
    ).countPendingCurationJobs

    expect(countPendingCurationJobs).toBeTypeOf('function')
    expect(countPendingCurationJobs?.(join(root, 'absent-knowledge-root'))).toBe(0)
    expect(countPendingCurationJobs?.(knowledgeRoot)).toBe(0)
    enqueue('pending-count-one', 'ci')
    enqueue('pending-count-two', 'ci')
    expect(countPendingCurationJobs?.(knowledgeRoot)).toBe(2)
  })

  it('counts the current claim while recovery visibility excludes only that claim', () => {
    const candidateIds = [
      enqueue('remaining-current-claim', 'ci'),
      enqueue('remaining-foreign-claim', 'ci'),
    ].sort()
    const authority = acquireWriterLease(knowledgeRoot)
    if (authority.kind !== 'acquired') throw new Error('expected writer authority')
    const current = claimNextJob({
      knowledgeRoot,
      leaseId: authority.leaseId,
      authority,
    })
    expect(current?.candidateId).toBe(candidateIds[0])
    if (current === undefined) throw new Error('expected current claim')

    const foreignLeaseId = 'foreign-visible-lease'
    mkdirSync(claimedLeaseDir(knowledgeRoot, foreignLeaseId), { recursive: true })
    renameSync(
      queuedCandidateDir(knowledgeRoot, candidateIds[1]!),
      claimedCandidateDir(knowledgeRoot, foreignLeaseId, candidateIds[1]!),
    )

    const countRemainingCurationWork = (
      curationQueue as unknown as {
        countRemainingCurationWork?: (
          knowledgeRoot: string,
          options?: { currentLeaseId?: string },
        ) => { queued: number; claimedNonterminal: number; quarantined: number }
      }
    ).countRemainingCurationWork
    const quarantineClaimed = (
      curationQueue as unknown as {
        quarantineClaimed?: (options: {
          knowledgeRoot: string
          leaseId: string
          candidateId: string
          authority: { leaseId: string; epoch: number }
          reason: 'malformed-payload'
        }) => string
      }
    ).quarantineClaimed

    expect(countRemainingCurationWork).toBeTypeOf('function')
    expect(quarantineClaimed).toBeTypeOf('function')
    expect(
      countRemainingCurationWork?.(knowledgeRoot, {
        currentLeaseId: authority.leaseId,
      }),
    ).toEqual({ queued: 0, claimedNonterminal: 2, quarantined: 0 })
    expect(
      curationQueue.inspectDrainableCurationWork({
        knowledgeRoot,
        currentLeaseId: authority.leaseId,
      }),
    ).toEqual({
      queuedCandidateIds: [],
      recoverableClaimedCandidateIds: [candidateIds[1]],
    })

    quarantineClaimed?.({
      knowledgeRoot,
      leaseId: authority.leaseId,
      candidateId: current.candidateId,
      authority,
      reason: 'malformed-payload',
    })

    expect(
      countRemainingCurationWork?.(knowledgeRoot, {
        currentLeaseId: authority.leaseId,
      }),
    ).toEqual({ queued: 0, claimedNonterminal: 1, quarantined: 1 })
    expect(
      JSON.parse(
        readFileSync(
          join(
            knowledgeRoot,
            'memory/queue/quarantined',
            current.candidateId,
            'quarantine.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({
      schemaVersion: curationQueue.CURATION_QUARANTINE_SCHEMA_VERSION,
      candidateId: current.candidateId,
      leaseId: authority.leaseId,
      reason: 'malformed-payload',
    })
    expect(releaseLease({ knowledgeRoot, leaseId: authority.leaseId })).toEqual({
      kind: 'released',
    })
  })

  it.each([
    ['malformed payload', 'malformed-payload'],
    ['malformed state', 'malformed-job-state'],
    ['malformed checkpoint', 'malformed-authored-checkpoint'],
  ] as const)('durably quarantines %s instead of stranding its claim', async (scenario, reason) => {
    const candidateId = enqueue(`quarantine-${scenario.replaceAll(' ', '-')}`, 'ci')
    const operations: Partial<DrainOperations> = maintenanceFreeOperations()
    if (scenario === 'malformed payload') {
      writeFileSync(join(queuedCandidateDir(knowledgeRoot, candidateId), 'payload.json'), '{')
    } else if (scenario === 'malformed state') {
      operations.readJobState = () => ({ kind: 'malformed', present: true })
    } else {
      operations.readJobState = () => ({
        kind: 'parsed',
        present: true,
        state: {
          schemaVersion: CURATION_JOB_STATE_SCHEMA_VERSION,
          candidateId,
          lifecycle: 'authored',
          embedCrashCount: 0,
          authored: { malformed: true },
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
      })
    }

    const report = await drainQueue({
      knowledgeRoot,
      author: scriptedAuthor(),
      executionContext: 'ci',
      maintenance: 'skip',
      operations,
    })

    expect(report).toMatchObject({
      kind: 'drained',
      jobsProcessed: 1,
      quarantined: 1,
      failures: 1,
      remaining: 1,
      remainingWork: { queued: 0, claimedNonterminal: 0, quarantined: 1 },
    })
    expect(listQueuedCandidates(knowledgeRoot)).toEqual([])
    expect(
      JSON.parse(
        readFileSync(
          join(
            knowledgeRoot,
            'memory/queue/quarantined',
            candidateId,
            'quarantine.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({ candidateId, reason })
  })

  it('requeues an author failure across two polling cycles with visible remaining work', async () => {
    const candidateId = enqueue('two-poll-author-failure', 'ci')
    const author: CuratorAuthor = async () => {
      throw new Error('injected author failure')
    }

    for (let poll = 0; poll < 2; poll += 1) {
      const report = await drainQueue({
        knowledgeRoot,
        author,
        executionContext: 'ci',
        maintenance: 'skip',
        operations: maintenanceFreeOperations(),
      })
      expect(report).toMatchObject({
        jobsProcessed: 1,
        requeued: 1,
        failures: 1,
        remaining: 1,
        remainingWork: { queued: 1, claimedNonterminal: 0, quarantined: 0 },
      })
      expect(listQueuedCandidates(knowledgeRoot)).toEqual([candidateId])
    }
  })

  it('requeues checkpoint-persist failure with a cleared durable checkpoint', async () => {
    const candidateId = enqueue('checkpoint-persist-requeue', 'ci')
    const report = await drainQueue({
      knowledgeRoot,
      author: scriptedAuthor(),
      executionContext: 'ci',
      maintenance: 'skip',
      operations: {
        ...maintenanceFreeOperations(),
        persistAuthoredCheckpoint: () => ({ kind: 'malformed-state', present: true }),
      },
    })

    expect(report).toMatchObject({
      requeued: 1,
      failures: 1,
      remaining: 1,
      remainingWork: { queued: 1, claimedNonterminal: 0, quarantined: 0 },
    })
    const state = readJobState(knowledgeRoot, candidateId)
    expect(state).toMatchObject({
      kind: 'parsed',
      state: { lifecycle: 'queued' },
    })
    if (state.kind !== 'parsed') throw new Error('expected parsed requeued state')
    expect(state.state.authored).toBeUndefined()
  })

  it('requeues a failed canary commit instead of losing its malformed sibling claim', async () => {
    const enqueued = enqueueCanaryOutcome(knowledgeRoot, {
      candidateId: asRecordId('missing-canary-candidate'),
      runId: 'run-canary-requeue',
      testId: 'canary-requeue',
      testIndex: 0,
      buildOrdinal: 42,
      stepIndex: 0,
      runOutcome: 'positive',
      benefit: 'rode-along',
      exercisedAnchor: { t: 'page', route: '/missing-canary' },
      attribution: 'run-canary-requeue:canary-requeue:0',
      briefDigest: 'missing canary target',
    })
    const report = await drainQueue({
      knowledgeRoot,
      author: scriptedAuthor(),
      executionContext: 'ci',
      maintenance: 'skip',
      operations: maintenanceFreeOperations(),
    })

    expect(report).toMatchObject({
      jobsProcessed: 1,
      requeued: 1,
      failures: 1,
      remaining: 1,
      remainingWork: { queued: 1, claimedNonterminal: 0, quarantined: 0 },
    })
    expect(listQueuedCandidates(knowledgeRoot)).toEqual([enqueued.entryId])
  })

  it('omits every maintenance mutation when the daemon cadence owns the tail', async () => {
    const writerMutation = join(root, 'writer-pass-mutated')
    const gcMutation = join(root, 'gc-mutated')
    const rebuild = vi.fn(async () => {
      writeFileSync(writerMutation, 'unexpected')
      return {
        projected: 0,
        skippedIncomplete: 0,
        scanIssues: [],
        removed: 0,
        backfilled: 0,
        vec: 'vec0' as const,
        pendingEmbeddings: 0,
        maintenanceRemaining: false,
      }
    })
    const gc = vi.fn(() => {
      writeFileSync(gcMutation, 'unexpected')
      return {
        trimmedRecordIds: [],
        skipped: { unknownRef: 0, withinK: 0, userOrigin: 0, horizon: 0 },
      }
    })

    const report = await drainQueue({
      knowledgeRoot,
      author: scriptedAuthor(),
      executionContext: 'local-headless',
      maintenance: 'skip',
      operations: {
        readRebuildRequest: () => ({ present: false }),
        readIndexMaintenanceState: () => ({
          ...NO_INDEX_MAINTENANCE,
          pendingEmbeddings: 1,
        }),
        acquireEmbedder: async () => ({ kind: 'lexical-only' }),
        rebuildIndex: rebuild,
        runKnowledgeGc: gc,
      },
    } as Parameters<typeof drainQueue>[0] & { maintenance: 'skip' })

    expect(report.writerPass).toEqual({ kind: 'skipped', reason: 'daemon-cadence' })
    expect(report.gc).toEqual({ kind: 'skipped', reason: 'daemon-cadence' })
    expect(rebuild).not.toHaveBeenCalled()
    expect(gc).not.toHaveBeenCalled()
    expect(existsSync(writerMutation)).toBe(false)
    expect(existsSync(gcMutation)).toBe(false)
    expect(enumerateBundleDirs(knowledgeRoot)).toEqual([])
  })

  it('runs the exported maintenance tail with the inline writer and GC result shapes', async () => {
    const runMaintenanceTail = maintenanceTail()
    const request = {
      reason: 'locked' as const,
      detail: 'daemon substrate direct tail',
      requestedAt: '2026-07-30T00:00:00.000Z',
    }
    const rebuild = {
      projected: 0,
      skippedIncomplete: 0,
      scanIssues: [],
      removed: 0,
      backfilled: 0,
      vec: 'vec0' as const,
      pendingEmbeddings: 0,
      maintenanceRemaining: false,
    }
    const summary = {
      trimmedRecordIds: [],
      skipped: { unknownRef: 0, withinK: 0, userOrigin: 0, horizon: 0 },
    }
    const beforeGcRemoval = vi.fn()
    const runKnowledgeGc = vi.fn((input, authority, hooks) => {
      expect(input).toEqual({ knowledgeRoot, horizon: { kind: 'none' } })
      expect(authority).toEqual({
        knowledgeRoot,
        leaseId: 'direct-tail-lease',
        epoch: 7,
      })
      expect(hooks).toEqual({ beforeGcRemoval })
      return summary
    })

    const result = await runMaintenanceTail({
      knowledgeRoot,
      lease: { leaseId: 'direct-tail-lease', epoch: 7 },
      operations: {
        readRebuildRequest: () => ({ present: true, request }),
        readIndexMaintenanceState: () => NO_INDEX_MAINTENANCE,
        acquireEmbedder: async () => ({ kind: 'lexical-only' }),
        rebuildIndex: vi.fn(async () => rebuild),
        runKnowledgeGc,
        beforeGcRemoval,
      },
    })

    expect(result).toEqual({
      writerPass: { kind: 'rebuilt', request, rebuild },
      gc: { kind: 'completed', summary },
      failures: [],
    })
    expect(runKnowledgeGc).toHaveBeenCalledOnce()
    expect(beforeGcRemoval).not.toHaveBeenCalled()
  })

  it('surfaces the same WriterAuthorityLostError from a stale direct tail', async () => {
    const runMaintenanceTail = maintenanceTail()
    const stale = acquireWriterLease(knowledgeRoot)
    if (stale.kind !== 'acquired') throw new Error('expected stale lease seed')
    expect(releaseLease({ knowledgeRoot, leaseId: stale.leaseId })).toEqual({
      kind: 'released',
    })
    const current = acquireWriterLease(knowledgeRoot)
    if (current.kind !== 'acquired') throw new Error('expected replacement lease')
    requestRebuild({
      knowledgeRoot,
      reason: 'locked',
      detail: 'force the direct writer pass through its fresh epoch fence',
    })

    await expect(
      runMaintenanceTail({
        knowledgeRoot,
        lease: { leaseId: stale.leaseId, epoch: stale.epoch },
        operations: {
          acquireEmbedder: async () => ({ kind: 'lexical-only' }),
        },
      }),
    ).rejects.toMatchObject({
      name: 'WriterAuthorityLostError',
      reason: 'epoch-mismatch-before-heartbeat',
      observedEpoch: current.epoch,
    })
    await expect(
      runMaintenanceTail({
        knowledgeRoot,
        lease: { leaseId: stale.leaseId, epoch: stale.epoch },
        operations: {
          acquireEmbedder: async () => ({ kind: 'lexical-only' }),
        },
      }),
    ).rejects.toBeInstanceOf(WriterAuthorityLostError)
    expect(releaseLease({ knowledgeRoot, leaseId: current.leaseId })).toEqual({
      kind: 'released',
    })
  })

  /**
   * canary evidence is trust/status currency, so every canary mutation must sit inside the
   * same exact-authority section as the terminal job-state write. Each barrier below names one
   * point at which a takeover either completes (and must find nothing landed) or is blocked (and
   * must observe the tail's holder), which is the only way "one held section" is executable.
   */
  describe('canary tail authority barriers', () => {
    type AcquireWithDeadline = (
      knowledgeRoot: string,
      hooks?: { mutationLockTakeoverMs?: number },
    ) => ReturnType<typeof acquireWriterLease>
    const acquireWithDeadline = acquireWriterLease as AcquireWithDeadline

    function acquireAuthority(): { leaseId: string; epoch: number } {
      const outcome = acquireWriterLease(knowledgeRoot)
      if (outcome.kind !== 'acquired') throw new Error('expected acquired canary authority')
      return { leaseId: outcome.leaseId, epoch: outcome.epoch }
    }

    function makeStale(): void {
      const file = join(knowledgeRoot, LEASE_FILE)
      const holder = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      writeFileSync(
        file,
        `${JSON.stringify({
          ...holder,
          heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS,
        })}\n`,
        'utf8',
      )
    }

    function takeOver(): { leaseId: string; epoch: number } {
      makeStale()
      const successor = acquireWithDeadline(knowledgeRoot, { mutationLockTakeoverMs: 0 })
      if (successor.kind !== 'acquired') throw new Error('expected successor takeover')
      return { leaseId: successor.leaseId, epoch: successor.epoch }
    }

    /** Canonical canary state: the outcome log, the manifest fold, and the projected rows. */
    function canarySnapshot(): unknown {
      return canonicalJson({
        bundles: enumerateBundleDirs(knowledgeRoot).map(({ product, dir }) => ({
          product,
          outcomes: readFileSync(join(dir, 'evidence/outcomes.jsonl'), 'utf8'),
          manifest: readFileSync(join(dir, 'manifest.json'), 'utf8'),
        })),
        logicalIndex: orderedLogicalIndexDump(),
      })
    }

    function onlyBundle() {
      const dirs = enumerateBundleDirs(knowledgeRoot)
      expect(dirs).toHaveLength(1)
      const loaded = loadBundle(dirs[0]!.dir)
      if (loaded.kind !== 'loaded') throw new Error('expected one loaded canary target')
      return { bundle: loaded.bundle, trust: deriveBundleTrust(loaded.bundle) }
    }

    function eventTypes(): string[] {
      return onlyBundle().bundle.events.map(({ type }) => type)
    }

    function indexRowStatus(bundleId: string): string | undefined {
      const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
      try {
        const row = reader.db
          .prepare('SELECT status FROM records WHERE bundle_id = ?')
          .get(bundleId) as { status: string } | undefined
        return row?.status
      } finally {
        reader.db.close()
      }
    }

    /** Drains one propose-only candidate so a real canonical bundle exists to canary. */
    async function seedCanaryTarget(seed: string): Promise<string> {
      enqueue(seed, 'ci')
      const report = await drainQueue({
        knowledgeRoot,
        author: scriptedAuthor(),
        executionContext: 'ci',
        maintenance: 'skip',
        operations: maintenanceFreeOperations(),
      })
      expect(report).toMatchObject({ kind: 'drained', committed: 1, failures: 0 })
      const seeded = onlyBundle()
      expect(seeded.trust.status).toBe('candidate')
      return seeded.bundle.manifest.id
    }

    function canaryOutcome(
      bundleId: string,
      seed: string,
      runOutcome: CanaryOutcome['runOutcome'],
    ): CanaryOutcome {
      return {
        candidateId: asRecordId(bundleId),
        runOutcome,
        benefit: 'rode-along',
        runId: `run-canary-${seed}`,
        testId: `canary::${seed}`,
        testIndex: 0,
        buildOrdinal: 43,
        stepIndex: 0,
        briefDigest: `canary-${seed}`,
        attribution: `run-canary-${seed}:canary::${seed}:0`,
        exercisedAnchor: { t: 'page', route: `/${seed}` },
      }
    }

    async function drainCanary(
      lease: { leaseId: string; epoch: number },
      canaryAuthorityHooks?: CanaryAuthorityHooks,
    ) {
      return drainQueue({
        knowledgeRoot,
        author: scriptedAuthor(),
        executionContext: 'local-interactive',
        maintenance: 'skip',
        lease,
        operations: {
          ...maintenanceFreeOperations(),
          ...(canaryAuthorityHooks === undefined ? {} : { canaryAuthorityHooks }),
        },
      })
    }

    const authorityLostFailure = [
      expect.objectContaining({
        stage: 'commit',
        message: expect.stringContaining('writer authority lost'),
      }),
    ]

    it('refuses a fabricated store identity at its first canonical canary mutation', async () => {
      const bundleId = await seedCanaryTarget('fabricated-store')
      const lease = acquireAuthority()
      const before = canarySnapshot()

      const store = createLocalKnowledgeStore({
        knowledgeRoot,
        executionContext: 'local-interactive',
        epoch: lease.epoch,
        writerLeaseId: 'fabricated-canary-writer',
        sourceBuildOrdinal: 43,
        sourceRunId: 'run-canary-fabricated-store',
      })

      await expect(
        store.recordCanaryOutcome(canaryOutcome(bundleId, 'fabricated-store', 'negative')),
      ).rejects.toMatchObject({
        name: 'WriterAuthorityLostError',
        reason: 'lease-id-mismatch',
      })

      expect(eventTypes()).not.toContain('contradicted')
      expect(canarySnapshot()).toEqual(before)
      expect(releaseLease({ knowledgeRoot, leaseId: lease.leaseId })).toEqual({
        kind: 'released',
      })
    })

    it('lands no negative canary evidence behind a takeover completed before its held section', async () => {
      const seed = 'negative-barrier'
      const bundleId = await seedCanaryTarget(seed)
      const enqueued = enqueueCanaryOutcome(
        knowledgeRoot,
        canaryOutcome(bundleId, seed, 'negative'),
      )
      const lease = acquireAuthority()
      const before = canarySnapshot()
      let successor: { leaseId: string; epoch: number } | undefined
      let snapshotAtPause: unknown

      const report = await drainCanary(lease, {
        beforeNegativeAppend: () => {
          snapshotAtPause = canarySnapshot()
          successor = takeOver()
        },
      })

      expect(successor).toMatchObject({ epoch: lease.epoch + 1 })
      expect(snapshotAtPause).toEqual(before)
      expect(report).toMatchObject({
        kind: 'drained',
        jobsProcessed: 1,
        committed: 0,
        failures: 1,
        failureDetails: authorityLostFailure,
      })
      expect(eventTypes()).not.toContain('contradicted')
      expect(canarySnapshot()).toEqual(before)
      // The terminal transition shares the refused section, so the claim survives for the
      // successor to reconcile rather than being completed behind an append that never landed.
      const state = readJobState(knowledgeRoot, enqueued.entryId)
      expect(state.kind).toBe('parsed')
      if (state.kind !== 'parsed') throw new Error('expected a surviving nonterminal claim')
      expect(state.state.lifecycle).not.toBe('done')
    })

    it('lands no canary promotion behind a takeover completed before its held section', async () => {
      const seed = 'promotion-barrier'
      const bundleId = await seedCanaryTarget(seed)
      enqueueCanaryOutcome(knowledgeRoot, canaryOutcome(bundleId, seed, 'positive'))
      const lease = acquireAuthority()
      let successor: { leaseId: string; epoch: number } | undefined
      let snapshotAtPause: unknown

      const report = await drainCanary(lease, {
        beforePromotionAppend: () => {
          snapshotAtPause = canarySnapshot()
          successor = takeOver()
        },
      })

      expect(successor).toMatchObject({ epoch: lease.epoch + 1 })
      expect(report).toMatchObject({
        kind: 'drained',
        jobsProcessed: 1,
        committed: 0,
        failures: 1,
        failureDetails: authorityLostFailure,
      })
      // The durable Confirm the paused writer already committed stays valid replay evidence,
      // and nothing of the promotion arm landed on top of it.
      expect(eventTypes()).not.toContain('promoted')
      expect(onlyBundle().trust.counters.confirmed).toBeGreaterThan(0)
      expect(onlyBundle().trust.status).toBe('candidate')
      expect(indexRowStatus(bundleId)).toBe('candidate')
      expect(canarySnapshot()).toEqual(snapshotAtPause)
    })

    it('completes a canary promotion refused mid-takeover exactly once under the successor', async () => {
      const seed = 'promotion-replay'
      const bundleId = await seedCanaryTarget(seed)
      enqueueCanaryOutcome(knowledgeRoot, canaryOutcome(bundleId, seed, 'positive'))
      const lease = acquireAuthority()
      let successor: { leaseId: string; epoch: number } | undefined

      await drainCanary(lease, {
        beforePromotionAppend: () => {
          successor = takeOver()
        },
      })
      expect(eventTypes()).not.toContain('promoted')
      if (successor === undefined) throw new Error('expected a successor takeover')

      const replay = await drainCanary(successor)

      expect(replay).toMatchObject({
        kind: 'drained',
        jobsProcessed: 1,
        committed: 1,
        failures: 0,
      })
      expect(eventTypes().filter((type) => type === 'promoted')).toEqual(['promoted'])
      expect(onlyBundle().trust.status).toBe('active')
      expect(indexRowStatus(bundleId)).toBe('active')
      expect(listQueuedCandidates(knowledgeRoot)).toEqual([])
      const afterReplay = canarySnapshot()

      const second = await drainCanary(successor)

      expect(second).toMatchObject({ kind: 'drained', jobsProcessed: 0, failures: 0 })
      expect(canarySnapshot()).toEqual(afterReplay)
    })

    it('blocks a contender between the canary append and its index projection', async () => {
      const seed = 'projection-barrier'
      const bundleId = await seedCanaryTarget(seed)
      enqueueCanaryOutcome(knowledgeRoot, canaryOutcome(bundleId, seed, 'negative'))
      const lease = acquireAuthority()
      let contender: ReturnType<typeof acquireWriterLease> | undefined

      const report = await drainCanary(lease, {
        beforeIndexProjection: () => {
          makeStale()
          contender = acquireWithDeadline(knowledgeRoot, { mutationLockTakeoverMs: 0 })
        },
      })

      // In-section: the tail owns the mutation lock, so the contender is told who holds it
      // rather than being handed the lease mid-append.
      expect(contender).toMatchObject({
        kind: 'held',
        holder: { leaseId: lease.leaseId, epoch: lease.epoch },
      })
      expect(report).toMatchObject({
        kind: 'drained',
        jobsProcessed: 1,
        committed: 1,
        failures: 0,
      })
      expect(eventTypes()).toContain('contradicted')
      expect(indexRowStatus(bundleId)).toBe('candidate')
      expect(listQueuedCandidates(knowledgeRoot)).toEqual([])
      expect(releaseLease({ knowledgeRoot, leaseId: lease.leaseId })).toEqual({
        kind: 'released',
      })
    })
  })
})
