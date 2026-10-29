import { existsSync, readFileSync } from 'node:fs'

import {
  canonicalJson,
  asRecordId,
  type BundleKind,
  type CanaryOutcome,
  type ExecutionContext,
  type FactSubtype,
  type IndexEntry,
  type PromotionGateHoldReason,
  type PromotionPath,
  type CurationSnapshot,
  type CurationSnapshotChange,
} from '@vostride/agent-qa-schema'
import { foldCurationSnapshot, readCurationEffectsForRun } from './curation-snapshot.js'

import { openKnowledgeReader, type KnowledgeReader } from '../index-reader.js'
import {
  indexDbPath,
  openIndexReaderConnection,
  readIndexMaintenanceState,
} from '../index-open.js'
import { rebuildIndex, removeBundleProjectionRows } from '../index-rebuild.js'
import {
  acquireEmbedder,
  type AcquireEmbedderOutcome,
} from '../embedder-acquire.js'
import { runKnowledgeGc } from '../gc.js'
import { readRebuildRequest } from '../rebuild-marker.js'
import { buildRetrievalQuery, type RetrievalQueryInput } from '../query-helper.js'
import { retrieve } from '../retrieve.js'
import {
  reconcileOnDrainStart,
  type ReconcileReport,
} from '../journal/reconcile.js'
import type { CommitIntent } from '../journal/intent-journal.js'
import {
  acquireWriterLease,
  heartbeatLease,
  releaseLease,
  WriterAuthorityLostError,
  type CurrentWriterAuthority,
  type HeartbeatLeaseOutcome,
  type WriterLease,
} from '../lease/writer-lease.js'
import {
  claimNextJob,
  countRemainingCurationWork,
  quarantineClaimed,
  requeueClaimed,
  type CurationQuarantineReason,
  type CurationRemainingWork,
  type ClaimedCurationJob,
  type ClaimNextJobOutcome,
  type MalformedClaimedCurationJob,
} from '../queue/curation-queue.js'
import {
  canaryOutcomeContentAddress,
  readQueuedCanaryPayload,
} from '../queue/canary-payload.js'
import {
  persistAuthoredCheckpoint,
  readJobState,
  writeJobState,
  writeJobStateWithinCurrentAuthority,
} from '../queue/job-state.js'
import type { CurationCandidatePayload } from '../queue/queue-payload.js'
import {
  AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  parseAuthoredCheckpoint,
  resolveDispositionProfile,
  sliceAuthoredCheckpoint,
  type AuthoredCheckpoint,
  type CurationJobView,
  type CuratorAuthor,
  type NeighborRecord,
} from './author-contract.js'
import {
  applyIndexDeltaForBundle,
  commitCurationDelta,
  deriveIndexRowFromBundle,
  type CommitCurationOutcome,
  type EmptyDeltaCause,
} from './commit.js'
import type { DispositionDrainState } from './disposition.js'
import { constructFallbackDeltas } from './fallback.js'
import { createLocalKnowledgeStore } from './knowledge-store.js'
import type { CanaryAuthorityHooks } from './knowledge-store.js'
import {
  runMaintenanceTail,
  type GcPassReport,
  type MaintenanceOperations,
  type WriterPassReport,
} from './maintenance.js'

export type { GcPassReport, WriterPassReport } from './maintenance.js'

/** Ratified M2 one-shot budget. A run's tail aborts an author request in flight at its end. */
export const DRAIN_BUDGET_MS = 60_000

/** Provisional §7.4 cap over distinct search-before-create query targets. */
export const SEARCH_BEFORE_CREATE_MAX_QUERIES = 5

/** Provisional 376 D-14 per-job breaker before a vector-deferred commit is forced. */
export const EMBED_CRASH_VECTORLESS_THRESHOLD = 2

const SEARCH_BEFORE_CREATE_RESULTS_PER_QUERY = 8
const SEARCH_BEFORE_CREATE_MAX_NEIGHBORS = 12

export type DrainFailureStage =
  | 'lease'
  | 'reconcile'
  | 'claim'
  | 'heartbeat'
  | 'job-state'
  | 'search'
  | 'author'
  | 'checkpoint'
  | 'commit'
  | 'quarantine'
  | 'requeue'
  | 'release'
  | 'writer-pass'
  | 'gc'

export interface DrainFailure {
  stage: DrainFailureStage
  message: string
  candidateId?: string
}

/**
 * A commit that decided there was nothing to apply. Legitimate reasons exist (evidence-token
 * dedup), so a noop is never a failure — but dropping it on the floor made live procedure
 * extraction die silently for 13 UAT runs. Visibility, never a gate.
 */
export interface DrainNoop {
  candidateId: string
  reason: string
  /**
   * present only on delta-noop entries — distinguishes a defeated extraction
   * (`fallback-*`) from a deliberate authored Noop; benign dedup carries no cause.
   */
  emptyDeltaCause?: EmptyDeltaCause
}

export interface DrainPromotionOutcome {
  candidateId: string
  promotionPath?: PromotionPath
  promotionHoldReason?: PromotionGateHoldReason
}

interface DrainReportBase {
  /** Actual surviving effects for the requested run, also present on incomplete drains. */
  effects?: readonly CurationSnapshotChange[]
  /** Certified only after a complete drain; absent for historical missing receipts. */
  snapshot?: CurationSnapshot
  /**
   * The effects committed; only the projection over them failed, so `snapshot` is absent. Never a
   * failure: the drain stays complete and nothing is retried or refolded.
   */
  snapshotFoldFailed?: true
  jobsProcessed: number
  committed: number
  // the canary evidence commits in `committed`; no bucket counts them.
  evidenceCommitted?: number
  /**
   * Committed deltas whose kind was `Deprecate`.
   *
   * OPTIONAL because the drain report is constructed by fault-injection fakes across four
   * packages and a required field would make every one of them a compile error over a number
   * they have no opinion about. The real drain always sets it, so a production report saying
   * `deprecated: 0` is a measurement rather than an absence — which is what the post-run
   * chain's notification needs in order to tell a drain that deprecated nothing apart
   * from a drain that never ran at all.
   */
  deprecated?: number
  /** Optional for fault-injection fakes; the real drain always sets this measurement. */
  promotions?: readonly DrainPromotionOutcome[]
  downgraded: number
  withheld: number
  quarantined: number
  requeued: number
  failures: number
  failureDetails: DrainFailure[]
  noops: number
  noopDetails: DrainNoop[]
  reconcile: ReconcileReport | undefined
  writerPass: WriterPassReport
  gc: GcPassReport
  /** Visibility only: every durable disposition that still prevents queue completion. */
  remaining: number
  /** Durable remainder partition. The current writer's nonterminal claim is included. */
  remainingWork: CurationRemainingWork
}

interface MutableDrainReport extends DrainReportBase {
  promotions: DrainPromotionOutcome[]
  evidenceCommitted: number
}

export type DrainReport = DrainReportBase &
  (
    | { kind: 'drained' | 'aborted' }
    | { kind: 'handed-off'; holder: WriterLease }
  )

export type CurationDrainLifecycleEvent =
  | { readonly kind: 'job-claimed'; readonly candidateId: string }
  | { readonly kind: 'job-completed'; readonly candidateId: string }

/**
 * Internal capability table used by focused fault-injection tests. Production callers omit it;
 * every default delegates directly to the shipped queue, lease, retrieval, commit, and rebuild
 * authorities.
 */
export interface DrainOperations extends MaintenanceOperations {
  acquireWriterLease: typeof acquireWriterLease
  heartbeatLease: typeof heartbeatLease
  releaseLease: typeof releaseLease
  reconcileOnDrainStart: typeof reconcileOnDrainStart
  claimNextJob: typeof claimNextJob
  quarantineClaimed: typeof quarantineClaimed
  requeueClaimed: typeof requeueClaimed
  readJobState: typeof readJobState
  writeJobState: typeof writeJobState
  persistAuthoredCheckpoint: typeof persistAuthoredCheckpoint
  openKnowledgeReader: typeof openKnowledgeReader
  buildRetrievalQuery: typeof buildRetrievalQuery
  retrieve: typeof retrieve
  commitCurationDelta: typeof commitCurationDelta
  /** The canonical commit already projects dense work as pending; the breaker selects this seam. */
  commitCurationDeltaVectorless: typeof commitCurationDelta
  hasIndexRow(knowledgeRoot: string, bundleId: string): boolean
  applyIndexDeltaForBundle: typeof applyIndexDeltaForBundle
  deriveIndexRowFromBundle: typeof deriveIndexRowFromBundle
  /** CR-02 takeover barriers for the canary branch; production omits them. */
  canaryAuthorityHooks?: CanaryAuthorityHooks
}

export interface DrainOptions {
  /** A per-run reader request, independent of which queued jobs this drain claims. */
  sourceRunId?: string
  observationIds?: readonly string[]
  knowledgeRoot: string
  /** `unbounded` is reserved for a standing host whose process lifetime is the boundary. */
  budgetMs?: number | 'unbounded'
  /** Standing writer authority owned by the caller; drainQueue never mutates its lifecycle. */
  lease?: { leaseId: string; epoch: number }
  author: CuratorAuthor
  executionContext: ExecutionContext
  /** Host-resolved posture; daemon sessions pass worker-required capability here. */
  embeddingCapability?: AcquireEmbedderOutcome
  /** Default inline preserves one-shot behavior; daemon sessions skip for their own cadence. */
  maintenance?: 'inline' | 'skip'
  signal?: AbortSignal
  /** Synchronous durable-boundary observer; daemon hosts append these facts before proceeding. */
  onJobLifecycle?: (event: CurationDrainLifecycleEvent) => void
  /** D-06 test seam. Production uses the one wall clock only at drain boundaries. */
  now?: () => number
  /** Fault-injection seam; production callers must omit it. */
  operations?: Partial<DrainOperations>
}

const BUNDLE_KINDS = new Set<BundleKind>([
  'fact',
  'procedure',
  'caution',
  'unknown',
  'policy',
])
const FACT_SUBTYPES = new Set<FactSubtype>([
  'selector',
  'behavioral',
  'navigational',
  'measurement',
  'content',
])

function hasIndexRow(knowledgeRoot: string, bundleId: string): boolean {
  if (!existsSync(indexDbPath(knowledgeRoot))) return false
  let reader: ReturnType<typeof openIndexReaderConnection> | undefined
  try {
    reader = openIndexReaderConnection(knowledgeRoot)
    return reader.db.prepare('SELECT 1 FROM records WHERE bundle_id = ?').get(bundleId)
      !== undefined
  } catch {
    return false
  } finally {
    reader?.db.close()
  }
}

const DEFAULT_OPERATIONS: DrainOperations = {
  acquireWriterLease,
  heartbeatLease,
  releaseLease,
  reconcileOnDrainStart,
  claimNextJob,
  quarantineClaimed,
  requeueClaimed,
  readJobState,
  writeJobState,
  persistAuthoredCheckpoint,
  openKnowledgeReader,
  buildRetrievalQuery,
  retrieve,
  commitCurationDelta,
  commitCurationDeltaVectorless: commitCurationDelta,
  readRebuildRequest,
  readIndexMaintenanceState,
  acquireEmbedder,
  rebuildIndex,
  runKnowledgeGc,
  removeBundleProjectionRows,
  hasIndexRow,
  applyIndexDeltaForBundle,
  deriveIndexRowFromBundle,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readClaimedCanaryOutcome(
  claimed: MalformedClaimedCurationJob,
): CanaryOutcome | undefined {
  try {
    const read = readQueuedCanaryPayload(
      JSON.parse(readFileSync(claimed.payloadPath, 'utf8')),
    )
    if (read.kind === 'refused') return undefined
    if (canaryOutcomeContentAddress(read.payload) !== claimed.candidateId) {
      return undefined
    }
    return {
      candidateId: asRecordId(read.payload.candidateId),
      runOutcome: read.payload.outcome,
      benefit: read.payload.benefit,
      runId: read.payload.runId,
      testId: read.payload.testId,
      testIndex: read.payload.testIndex,
      buildOrdinal: read.payload.buildOrdinal,
      stepIndex: read.payload.stepIndex,
      briefDigest: read.payload.briefDigest,
      attribution: read.payload.attribution,
      exercisedAnchor: read.payload.exercisedAnchor,
    }
  } catch {
    return undefined
  }
}

function isEmbeddingCrash(error: unknown, seen = new Set<object>()): boolean {
  if (typeof error !== 'object' || error === null || seen.has(error)) return false
  seen.add(error)
  const value = error as { name?: unknown; message?: unknown; cause?: unknown }
  const attribution = `${String(value.name ?? '')} ${String(value.message ?? '')}`
  return /(?:embedder|embedding|embeddings|embedDocument|FloorEmbedding|NativeEmbedding)/i
    .test(attribution)
    || isEmbeddingCrash(value.cause, seen)
}

function emptyReport(): MutableDrainReport {
  return {
    jobsProcessed: 0,
    committed: 0,
    evidenceCommitted: 0,
    deprecated: 0,
    promotions: [],
    downgraded: 0,
    withheld: 0,
    quarantined: 0,
    requeued: 0,
    failures: 0,
    failureDetails: [],
    noops: 0,
    noopDetails: [],
    reconcile: undefined,
    writerPass: { kind: 'not-requested' },
    gc: { kind: 'not-run' },
    remaining: 0,
    remainingWork: { queued: 0, claimedNonterminal: 0, quarantined: 0 },
  }
}

function updateRemaining(
  report: DrainReportBase,
  knowledgeRoot: string,
  currentLeaseId?: string,
): void {
  const remainingWork = countRemainingCurationWork(
    knowledgeRoot,
    currentLeaseId === undefined ? {} : { currentLeaseId },
  )
  report.remainingWork = remainingWork
  report.remaining =
    remainingWork.queued
    + remainingWork.claimedNonterminal
    + remainingWork.quarantined
}

function recordFailure(
  report: DrainReportBase,
  stage: DrainFailureStage,
  error: unknown,
  candidateId?: string,
): void {
  report.failures += 1
  report.failureDetails.push({
    stage,
    message: errorMessage(error),
    ...(candidateId === undefined ? {} : { candidateId }),
  })
}

function jobView(
  payload: CurationCandidatePayload,
  fallbackExecutionContext: ExecutionContext,
): CurationJobView {
  return {
    candidateId: payload.candidateId,
    kind: payload.kind,
    ...(payload.subtype === undefined ? {} : { subtype: payload.subtype }),
    ...(payload.rootCauseClass === undefined
      ? {}
      : { rootCauseClass: payload.rootCauseClass }),
    anchors: payload.anchors,
    summarySeed: payload.summarySeed,
    bodySeed: payload.bodySeed,
    distilledObservations: payload.distilledObservations,
    scope: payload.scope,
    buildOrdinal: payload.buildOrdinal,
    attributingObservationId: payload.attributingObservationId,
    executionContext: payload.executionContext ?? fallbackExecutionContext,
  }
}

function addTargetedQuery(
  queries: RetrievalQueryInput[],
  seen: Set<string>,
  query: RetrievalQueryInput,
): void {
  if (queries.length >= SEARCH_BEFORE_CREATE_MAX_QUERIES) return
  const key = canonicalJson({ intent: query.intent, anchors: query.anchors })
  if (seen.has(key)) return
  seen.add(key)
  queries.push(query)
}

function targetedQueries(payload: CurationCandidatePayload): RetrievalQueryInput[] {
  const primary = payload.anchors[0]!
  const queries: RetrievalQueryInput[] = []
  const seen = new Set<string>()
  addTargetedQuery(queries, seen, {
    intent: payload.summarySeed,
    anchors: [primary],
  })

  for (const anchor of payload.anchors) {
    if (anchor.t === 'error') {
      addTargetedQuery(queries, seen, {
        intent: anchor.message,
        anchors: [primary, anchor],
      })
    } else if (anchor.t === 'flow') {
      addTargetedQuery(queries, seen, {
        intent: anchor.name,
        anchors: [primary, anchor],
      })
    }
  }
  for (const observation of payload.distilledObservations) {
    if (observation.error !== undefined) {
      addTargetedQuery(queries, seen, {
        intent: observation.error.naturalKey,
        anchors: [
          primary,
          { t: 'error', message: observation.error.naturalKey },
        ],
      })
    }
    if (observation.flow !== undefined) {
      addTargetedQuery(queries, seen, {
        intent: observation.flow.name,
        anchors: [primary, { t: 'flow', name: observation.flow.name }],
      })
    }
  }
  return queries
}

function retrievalOptions(
  payload: CurationCandidatePayload,
  embeddingCapability: AcquireEmbedderOutcome | undefined,
) {
  return {
    n: SEARCH_BEFORE_CREATE_RESULTS_PER_QUERY,
    product: payload.scope.key,
    ...(payload.scope.tier === 'test' ? { testKey: payload.scope.key } : {}),
    ...(payload.scope.tier === 'suite' ? { suiteKey: payload.scope.key } : {}),
    includeSuperseded: true,
    ...(embeddingCapability === undefined ? {} : { embeddingCapability }),
  }
}

function neighborFromEntry(entry: IndexEntry, alias: number): NeighborRecord | undefined {
  if (!BUNDLE_KINDS.has(entry.kind as BundleKind) || entry.audit === undefined) return undefined
  const kind = entry.kind as BundleKind
  const observedOrdinal = entry.audit.closedAtOrdinal ?? entry.audit.openedAtOrdinal
  const base = {
    alias,
    recordId: entry.id,
    summary: entry.summary,
    anchors: entry.anchors,
    observedStatus: entry.audit.status,
    observedOrdinal,
  }
  if (kind === 'fact') {
    if (!FACT_SUBTYPES.has(entry.subtype as FactSubtype)) return undefined
    return { ...base, kind, subtype: entry.subtype as FactSubtype }
  }
  return { ...base, kind }
}

async function searchBeforeCreate(
  operations: DrainOperations,
  payload: CurationCandidatePayload,
  knowledgeRoot: string,
  embeddingCapability: AcquireEmbedderOutcome | undefined,
): Promise<NeighborRecord[]> {
  let reader: KnowledgeReader | undefined
  try {
    reader = operations.openKnowledgeReader(knowledgeRoot)
    const byRecordId = new Map<string, IndexEntry>()
    for (const query of targetedQueries(payload)) {
      // The explicit build call fixes normalization/query classification at this boundary; the
      // retrieve pipeline consumes the same structured input through its public entry point.
      operations.buildRetrievalQuery(query)
      const hits = await operations.retrieve(
        reader,
        query,
        retrievalOptions(payload, embeddingCapability),
      )
      for (const hit of hits) {
        if (!byRecordId.has(hit.id)) byRecordId.set(hit.id, hit)
      }
    }

    const neighbors: NeighborRecord[] = []
    for (const hit of byRecordId.values()) {
      const neighbor = neighborFromEntry(hit, neighbors.length + 1)
      if (neighbor !== undefined) neighbors.push(neighbor)
      if (neighbors.length >= SEARCH_BEFORE_CREATE_MAX_NEIGHBORS) break
    }
    return neighbors
  } finally {
    reader?.close()
  }
}

function checkpointFromAuthored(
  deltas: AuthoredCheckpoint['deltas'],
  authorship: AuthoredCheckpoint['authorship'],
  neighbors: readonly NeighborRecord[],
): AuthoredCheckpoint {
  const seen = new Set<string>()
  const preconditions = deltas
    .flatMap((delta) => delta.precondition ?? [])
    .filter((cas) => {
      const key = canonicalJson(cas)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  return parseAuthoredCheckpoint({
    schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
    deltas,
    neighborIds: neighbors.map(({ recordId }) => recordId),
    preconditions,
    authorship,
  })
}

async function authorCheckpoint(
  options: DrainOptions,
  operations: DrainOperations,
  job: ClaimedCurationJob,
): Promise<AuthoredCheckpoint> {
  const view = jobView(job.payload, options.executionContext)
  const neighbors = await searchBeforeCreate(
    operations,
    job.payload,
    options.knowledgeRoot,
    options.embeddingCapability,
  )
  const outcome = await options.author(view, neighbors)
  if (outcome.kind === 'authored') {
    if (outcome.deltas.length === 0) {
      throw new Error('authored outcome must carry at least one delta')
    }
    return checkpointFromAuthored(outcome.deltas, outcome.authorship, neighbors)
  }

  const fallback = constructFallbackDeltas(view, neighbors, outcome.reason)
  if (fallback.length !== 1 || fallback[0] === undefined) {
    throw new Error('deterministic fallback must produce exactly one delta')
  }
  const authorship = fallback[0].authorship
  if (authorship === undefined || authorship.path !== 'deterministic-fallback') {
    throw new Error('deterministic fallback omitted its authorship stamp')
  }
  return checkpointFromAuthored(fallback, authorship, neighbors)
}

function claimedExecutionContext(
  claimed: ClaimNextJobOutcome,
  fallback: ExecutionContext,
): ExecutionContext {
  return claimed.kind === 'claimed'
    ? claimed.payload.executionContext ?? fallback
    : fallback
}

function persistCheckpoint(
  operations: DrainOperations,
  knowledgeRoot: string,
  authority: CurrentWriterAuthority,
  candidateId: string,
  checkpoint: AuthoredCheckpoint,
): void {
  const persisted = operations.persistAuthoredCheckpoint({
    knowledgeRoot,
    candidateId,
    authority,
    authored: checkpoint,
  })
  if (persisted.kind !== 'persisted') {
    throw new Error('cannot persist authored checkpoint over malformed job state')
  }
}

function clearCheckpointAndRequeue(
  operations: DrainOperations,
  knowledgeRoot: string,
  authority: CurrentWriterAuthority,
  job: ClaimedCurationJob,
): number {
  return clearCandidateAndRequeue(
    operations,
    knowledgeRoot,
    authority,
    job.candidateId,
  )
}

function clearCandidateAndRequeue(
  operations: DrainOperations,
  knowledgeRoot: string,
  authority: CurrentWriterAuthority,
  candidateId: string,
): number {
  const state = operations.readJobState(knowledgeRoot, candidateId)
  operations.writeJobState({
    knowledgeRoot,
    candidateId,
    authority,
    lifecycle: 'queued',
    embedCrashCount: state.kind === 'parsed' ? state.state.embedCrashCount : 0,
  })
  const requeued = operations.requeueClaimed({
    knowledgeRoot,
    leaseId: authority.leaseId,
    authority,
  })
  if (!requeued.includes(candidateId)) {
    throw new Error(`failed candidate ${candidateId} was not requeued`)
  }
  return requeued.length
}

function quarantineMalformedClaim(
  report: DrainReportBase,
  operations: DrainOperations,
  knowledgeRoot: string,
  authority: CurrentWriterAuthority,
  candidateId: string,
  reason: CurationQuarantineReason,
): boolean {
  try {
    operations.quarantineClaimed({
      knowledgeRoot,
      leaseId: authority.leaseId,
      candidateId,
      authority,
      reason,
    })
    report.quarantined += 1
    return true
  } catch (error) {
    recordFailure(report, 'quarantine', error, candidateId)
    return false
  }
}

function preserveAuthoredCheckpointAndRequeue(
  operations: DrainOperations,
  knowledgeRoot: string,
  authority: CurrentWriterAuthority,
  job: ClaimedCurationJob,
  checkpoint: AuthoredCheckpoint,
  embedCrashCount: number,
  failureLabel: string,
): number {
  operations.writeJobState({
    knowledgeRoot,
    candidateId: job.candidateId,
    authority,
    lifecycle: 'authored',
    embedCrashCount,
    authored: checkpoint,
  })
  const requeued = operations.requeueClaimed({
    knowledgeRoot,
    leaseId: authority.leaseId,
    authority,
  })
  if (!requeued.includes(job.candidateId)) {
    throw new Error(`${failureLabel} candidate ${job.candidateId} was not requeued`)
  }
  return requeued.length
}

function incrementEmbedCrashAndRequeue(
  operations: DrainOperations,
  knowledgeRoot: string,
  authority: CurrentWriterAuthority,
  job: ClaimedCurationJob,
  checkpoint: AuthoredCheckpoint,
  embedCrashCount: number,
): number {
  return preserveAuthoredCheckpointAndRequeue(
    operations,
    knowledgeRoot,
    authority,
    job,
    checkpoint,
    embedCrashCount + 1,
    'embed-crashed',
  )
}

/** A commit that landed a `Deprecate` delta retired a record; nothing else did. */
function countDeprecation(report: DrainReportBase, deltaKind: string): void {
  if (deltaKind === 'Deprecate') report.deprecated = (report.deprecated ?? 0) + 1
}

function mapCommitOutcome(
  report: MutableDrainReport,
  outcome: CommitCurationOutcome,
  job: ClaimedCurationJob,
  operations: DrainOperations,
  options: DrainOptions,
  authority: CurrentWriterAuthority,
): 'continue' | 'stop' {
  if ((outcome.kind === 'applied' || outcome.kind === 'converted-confirm' || outcome.kind === 'downgraded')
    && (outcome.promotionPath !== undefined || outcome.promotionHoldReason !== undefined)) {
    report.promotions.push({
      candidateId: job.candidateId,
      ...(outcome.promotionPath === undefined ? {} : { promotionPath: outcome.promotionPath }),
      ...(outcome.promotionHoldReason === undefined ? {} : { promotionHoldReason: outcome.promotionHoldReason }),
    })
  }
  switch (outcome.kind) {
    case 'applied':
    case 'converted-confirm':
      report.committed += 1
      countDeprecation(report, outcome.deltaKind)
      return 'continue'
    case 'downgraded':
      report.committed += 1
      report.downgraded += 1
      countDeprecation(report, outcome.deltaKind)
      return 'continue'
    case 'noop':
      // Counted and named, never fatal — the complete predicate must not gate on this.
      report.noops += 1
      report.noopDetails.push({
        candidateId: job.candidateId,
        reason: outcome.reason,
        ...(outcome.emptyDeltaCause === undefined
          ? {}
          : { emptyDeltaCause: outcome.emptyDeltaCause }),
      })
      return 'continue'
    case 'failed':
      recordFailure(report, 'commit', outcome.reason, job.candidateId)
      return 'continue'
    case 'abandoned-stale-epoch':
      recordFailure(
        report,
        'commit',
        `writer epoch became stale (observed ${outcome.observedEpoch})`,
        job.candidateId,
      )
      return 'stop'
    case 'requeue-resynthesis':
      try {
        clearCheckpointAndRequeue(
          operations,
          options.knowledgeRoot,
          authority,
          job,
        )
        report.requeued += 1
      } catch (error) {
        recordFailure(report, 'requeue', error, job.candidateId)
      }
      // Fresh neighbors belong to the next drain; reclaiming immediately could livelock on the
      // same lexicographically-first candidate.
      return 'stop'
  }
}

function isSuccessfulTerminalCommitOutcome(outcome: CommitCurationOutcome): boolean {
  // These kinds return only after markDone for a non-deferred delta. `failed` also describes
  // branches that can exit before queue completion, so its name alone is not sufficient evidence
  // for a lifecycle fact.
  switch (outcome.kind) {
    case 'applied':
    case 'converted-confirm':
    case 'downgraded':
    case 'noop':
      return true
    case 'failed':
    case 'abandoned-stale-epoch':
    case 'requeue-resynthesis':
      return false
  }
}

function reconcileDependencies(
  operations: DrainOperations,
  knowledgeRoot: string,
  writerAuthority: CurrentWriterAuthority,
) {
  return {
    knowledgeRoot,
    writerAuthority,
    hasIndexRow: (bundleId: string) => operations.hasIndexRow(knowledgeRoot, bundleId),
    applyIndexDelta: (intent: CommitIntent) => {
      operations.applyIndexDeltaForBundle({ knowledgeRoot, bundleId: intent.bundleId })
    },
    deriveIndexRowFromBundle: (bundleId: string) => {
      operations.deriveIndexRowFromBundle({ knowledgeRoot, bundleId })
    },
  }
}

function budgetMs(options: DrainOptions): number {
  const value = options.budgetMs ?? DRAIN_BUDGET_MS
  if (value === 'unbounded') return Number.POSITIVE_INFINITY
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("budgetMs must be a finite non-negative number or 'unbounded'")
  }
  return value
}

/**
 * Lease-gated one-shot Curator drain. It owns no provider: authoring is injected, serialized, and
 * durably checkpointed before the deterministic commit tail. Abort and budget are checked at job
 * boundaries; an in-flight model request is cut off only by the host's own author signal.
 */
export async function drainQueue(options: DrainOptions): Promise<DrainReport> {
  const operations: DrainOperations = { ...DEFAULT_OPERATIONS, ...options.operations }
  const now = options.now ?? Date.now
  const startedAt = now()
  const limit = budgetMs(options)
  const report = emptyReport()
  const drainOwnsLease = options.lease === undefined
  let lease: CurrentWriterAuthority
  if (options.lease !== undefined) {
    lease = options.lease
  } else {
    const acquired = operations.acquireWriterLease(options.knowledgeRoot)
    if (acquired.kind === 'held') {
      report.writerPass = { kind: 'skipped', reason: 'lease-held' }
      report.gc = { kind: 'skipped', reason: 'lease-held' }
      updateRemaining(report, options.knowledgeRoot)
      return { ...report, kind: 'handed-off', holder: acquired.holder }
    }
    if (acquired.kind === 'refused') throw acquired.error
    lease = acquired
  }

  const result: MutableDrainReport & { kind: 'drained' | 'aborted' } = {
    ...report,
    kind: 'drained',
  }
  const drainState: DispositionDrainState = { supersedesSeenByAnchorKey: new Map() }
  const completedCandidateIds = new Set<string>()
  const emitCompleted = (candidateId: string): void => {
    if (completedCandidateIds.has(candidateId)) return
    completedCandidateIds.add(candidateId)
    options.onJobLifecycle?.({ kind: 'job-completed', candidateId })
  }
  try {
    try {
      result.reconcile = operations.reconcileOnDrainStart(
        reconcileDependencies(operations, options.knowledgeRoot, lease),
      )
    } catch (error) {
      recordFailure(result, 'reconcile', error)
      return result
    }

    while (true) {
      if (now() - startedAt >= limit) break
      if (options.signal?.aborted === true) {
        result.kind = 'aborted'
        break
      }

      let claimed
      try {
        claimed = operations.claimNextJob({
          knowledgeRoot: options.knowledgeRoot,
          leaseId: lease.leaseId,
          authority: lease,
        })
      } catch (error) {
        recordFailure(result, 'claim', error)
        break
      }
      if (claimed === undefined) break
      options.onJobLifecycle?.({
        kind: 'job-claimed',
        candidateId: claimed.candidateId,
      })
      result.jobsProcessed += 1
      const executionContext = claimedExecutionContext(claimed, options.executionContext)

      if (drainOwnsLease) {
        // A beat that throws (the lease guard stayed busy for its whole wait, or was refused) is
        // a heartbeat failure like a refusal, never a throw out of the loop.
        let heartbeat: HeartbeatLeaseOutcome
        try {
          heartbeat = operations.heartbeatLease({
            knowledgeRoot: options.knowledgeRoot,
            leaseId: lease.leaseId,
          })
        } catch (error) {
          recordFailure(result, 'heartbeat', error, claimed.candidateId)
          break
        }
        if (heartbeat.kind === 'refused') {
          recordFailure(result, 'heartbeat', heartbeat.reason, claimed.candidateId)
          break
        }
      }

      if (claimed.kind === 'malformed') {
        // the strict sibling payload branches before checkpoint lookup, retrieval, or
        // author construction. A canary job therefore has no control-flow path to an LLM and
        // consumes none of the search-before-create query budget.
        const canaryOutcome = readClaimedCanaryOutcome(claimed)
        if (canaryOutcome === undefined) {
          recordFailure(
            result,
            'job-state',
            'claimed candidate payload is malformed',
            claimed.candidateId,
          )
          if (!quarantineMalformedClaim(
            result,
            operations,
            options.knowledgeRoot,
            lease,
            claimed.candidateId,
            'malformed-payload',
          )) break
          continue
        }
        try {
          const store = createLocalKnowledgeStore({
            knowledgeRoot: options.knowledgeRoot,
            executionContext,
            epoch: lease.epoch,
            sourceBuildOrdinal: canaryOutcome.buildOrdinal,
            sourceRunId: canaryOutcome.runId,
            sourceJobId: claimed.candidateId,
            writerLeaseId: lease.leaseId,
            onPromotionOutcome: outcome => result.promotions.push(outcome),
            /**
             * the terminal transition joins the canary tail's own held section through
             * the within-held form. Calling the fenced writeJobState here would re-enter
             * withCurrentWriterAuthority against a BEGIN IMMEDIATE the tail already holds and
             * deadlock (the Plan 25/28 within-held idiom).
             */
            onCanaryTailWithinCurrentAuthority: () => {
              writeJobStateWithinCurrentAuthority({
                knowledgeRoot: options.knowledgeRoot,
                candidateId: claimed.candidateId,
                authority: lease,
                lifecycle: 'done',
              })
            },
            ...(operations.canaryAuthorityHooks === undefined
              ? {}
              : { canaryAuthorityHooks: operations.canaryAuthorityHooks }),
          })
          await store.recordCanaryOutcome(canaryOutcome)
        } catch (error) {
          recordFailure(result, 'commit', error, claimed.candidateId)
          if (error instanceof WriterAuthorityLostError) break
          try {
            result.requeued += clearCandidateAndRequeue(
              operations,
              options.knowledgeRoot,
              lease,
              claimed.candidateId,
            )
          } catch (requeueError) {
            recordFailure(result, 'requeue', requeueError, claimed.candidateId)
          }
          break
        }
        emitCompleted(claimed.candidateId)
        result.committed += 1
        result.evidenceCommitted += 1
        continue
      }

      let checkpoint: AuthoredCheckpoint
      const state = operations.readJobState(options.knowledgeRoot, claimed.candidateId)
      if (state.kind === 'malformed') {
        recordFailure(result, 'job-state', 'job lifecycle state is malformed', claimed.candidateId)
        if (!quarantineMalformedClaim(
          result,
          operations,
          options.knowledgeRoot,
          lease,
          claimed.candidateId,
          'malformed-job-state',
        )) break
        continue
      }
      const embedCrashCount = state.kind === 'parsed' ? state.state.embedCrashCount : 0
      if (state.kind === 'parsed' && state.state.authored !== undefined) {
        try {
          checkpoint = parseAuthoredCheckpoint(state.state.authored)
        } catch (error) {
          recordFailure(result, 'checkpoint', error, claimed.candidateId)
          if (!quarantineMalformedClaim(
            result,
            operations,
            options.knowledgeRoot,
            lease,
            claimed.candidateId,
            'malformed-authored-checkpoint',
          )) break
          continue
        }
      } else {
        try {
          checkpoint = await authorCheckpoint(options, operations, claimed)
        } catch (error) {
          recordFailure(result, 'author', error, claimed.candidateId)
          try {
            result.requeued += clearCheckpointAndRequeue(
              operations,
              options.knowledgeRoot,
              lease,
              claimed,
            )
          } catch (requeueError) {
            recordFailure(result, 'requeue', requeueError, claimed.candidateId)
          }
          break
        }
        try {
          persistCheckpoint(
            operations,
            options.knowledgeRoot,
            lease,
            claimed.candidateId,
            checkpoint,
          )
        } catch (error) {
          recordFailure(result, 'checkpoint', error, claimed.candidateId)
          if (error instanceof WriterAuthorityLostError) break
          try {
            result.requeued += clearCheckpointAndRequeue(
              operations,
              options.knowledgeRoot,
              lease,
              claimed,
            )
          } catch (requeueError) {
            recordFailure(result, 'requeue', requeueError, claimed.candidateId)
          }
          break
        }
      }

      // dispose each authored delta independently through the one commit boundary.
      // Only the final delta completes the queue job so earlier disposals keep the claimed
      // candidate directory (and its artifacts) available.
      const vectorless = embedCrashCount >= EMBED_CRASH_VECTORLESS_THRESHOLD
      const slices = sliceAuthoredCheckpoint(checkpoint)
      let stopDrain = false
      /**
       * Sibling-failure invariant: no later slice may complete a job after any slice fails.
       * Preserve the whole authored checkpoint so successful siblings coalesce on retry while
       * the missing slice can land without re-invoking the author.
       */
      let anySliceFailed = false
      for (const [sliceIndex, slice] of slices.entries()) {
        const finalDelta = sliceIndex === slices.length - 1
        let outcome: CommitCurationOutcome
        try {
          const commit = vectorless
            ? operations.commitCurationDeltaVectorless
            : operations.commitCurationDelta
          outcome = commit(
            {
              knowledgeRoot: options.knowledgeRoot,
              epoch: lease.epoch,
              profile: resolveDispositionProfile(executionContext),
              drainState,
              ...(!finalDelta || anySliceFailed ? { deferCompletion: true } : {}),
            },
            claimed,
            slice,
          )
        } catch (error) {
          if (!vectorless && isEmbeddingCrash(error)) {
            recordFailure(result, 'commit', error, claimed.candidateId)
            try {
              result.requeued += incrementEmbedCrashAndRequeue(
                operations,
                options.knowledgeRoot,
                lease,
                claimed,
                checkpoint,
                embedCrashCount,
              )
            } catch (requeueError) {
              recordFailure(result, 'requeue', requeueError, claimed.candidateId)
            }
            // A requeued crash is deliberately a next-drain retry. At the durable threshold that
            // retry uses the vectorless seam and lands the canonical bundle with dense work
            // pending. Already-committed sibling deltas coalesce as Confirm on the retry.
            stopDrain = true
            break
          }
          anySliceFailed = true
          recordFailure(result, 'commit', error, claimed.candidateId)
          continue
        }
        if (outcome.kind === 'failed') anySliceFailed = true
        const mapped = mapCommitOutcome(
          result,
          outcome,
          claimed,
          operations,
          options,
          lease,
        )
        if (
          finalDelta
          && !anySliceFailed
          && isSuccessfulTerminalCommitOutcome(outcome)
        ) {
          emitCompleted(claimed.candidateId)
        }
        if (mapped === 'stop') {
          stopDrain = true
          break
        }
      }
      if (anySliceFailed && !stopDrain) {
        try {
          result.requeued += preserveAuthoredCheckpointAndRequeue(
            operations,
            options.knowledgeRoot,
            lease,
            claimed,
            checkpoint,
            embedCrashCount,
            'partially failed',
          )
        } catch (error) {
          recordFailure(result, 'requeue', error, claimed.candidateId)
        }
        // Reclaiming the same lexicographically-first candidate in this drain can livelock;
        // the durable checkpoint retry deliberately belongs to the next drain.
        stopDrain = true
      }
      if (stopDrain) break
    }

    if (result.kind === 'aborted') {
      result.writerPass = { kind: 'skipped', reason: 'aborted' }
      result.gc = { kind: 'skipped', reason: 'aborted' }
    } else if (now() - startedAt >= limit) {
      result.writerPass = { kind: 'skipped', reason: 'budget-exhausted' }
      result.gc = { kind: 'skipped', reason: 'budget-exhausted' }
    } else if (options.maintenance === 'skip') {
      result.writerPass = { kind: 'skipped', reason: 'daemon-cadence' }
      result.gc = { kind: 'skipped', reason: 'daemon-cadence' }
    } else {
      const maintenance = await runMaintenanceTail({
        knowledgeRoot: options.knowledgeRoot,
        lease,
        ...(options.embeddingCapability === undefined
          ? {}
          : { embeddingCapability: options.embeddingCapability }),
        operations,
        budget: { now, startedAtMs: startedAt, limitMs: limit },
        surfaceAuthorityLoss: false,
      })
      result.writerPass = maintenance.writerPass
      result.gc = maintenance.gc
      for (const failure of maintenance.failures) {
        recordFailure(result, failure.stage, failure.error)
      }
    }
    return result
  } finally {
    // Stays true unless the read proves no store change belongs to the run: lost receipts never fold to zero.
    let runLinked = true
    if (options.sourceRunId !== undefined) {
      try {
        const read = readCurationEffectsForRun({ knowledgeRoot: options.knowledgeRoot,
          sourceRunId: options.sourceRunId, observationIds: options.observationIds })
        result.effects = read.effects
        runLinked = read.runLinked
      } catch {
        recordFailure(result, 'commit', 'curation effect read incomplete')
      }
    }
    if (drainOwnsLease) {
      try {
        const released = operations.releaseLease({
          knowledgeRoot: options.knowledgeRoot,
          leaseId: lease.leaseId,
        })
        if (released.kind === 'refused') recordFailure(result, 'release', released.reason)
      } catch (error) {
        recordFailure(result, 'release', error)
      }
    }
    updateRemaining(result, options.knowledgeRoot, lease.leaseId)
    if (result.kind === 'drained' && result.failures === 0 && result.requeued === 0
      && result.remaining === 0 && result.effects !== undefined
      && (result.effects.length > 0 || runLinked === false)) {
      // Not recordFailure: a failure count would make a committed drain incomplete and retry it.
      try {
        result.snapshot = foldCurationSnapshot(result.effects)
      } catch {
        result.snapshotFoldFailed = true
      }
    }
  }
}
