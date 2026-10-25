// The one local composition root (Phase 385 plan 09 — D-15).
//
// `packages/agent` is storageNeutral — it may not touch `node:*`. Every host capability the
// function ops and the job queue need is built HERE over the concrete local storage and handed in
// as an injected port. This is the file `packages/cli/src/composition/function-registry.ts` named
// as its own successor in its header, moved down to where the local implementations already live.
//
// Why it is here and not in a surface: 386's daemon composes the same host. A composition that
// lives inside one surface is a composition every other host re-derives, and two hosts deriving the
// same registry differently is the host-divergence bug class the dual-host proof exists to exclude.
// So there is one function, and both hosts call it.
//
// Heavy first-party dependencies are legal in this subtree and nowhere else in this package; the
// arch rule named composition-carveout enforces that, so the job store proper stays lean.

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { canaryOutcomeObservationId, planMarkEvidence, projectMarkEvidenceOutcome } from '@vostride/agent-qa-knowledge-local/reader'
import {
  AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
  CHAT_HELP_TEXT,
  CHAT_RESOLVER_TABLE,
  createAgentJobQueue,
  createChatCompactionHook,
  createChatState,
  createFunctionRegistry,
  createPlannerStage,
  createRealJobKindRegistry,
  createTurnEngine,
  deterministicOverrideStrategy,
  foldFunctionResult,
  invokeFunction,
  projectPlannerTools,
  RUNS_START_FUNCTION_ID,
  replayToModelMessages,
  splitClauses,
} from '@vostride/agent-qa-agent'
import type {
  AgentJobQueue,
  AuthoringFunnelPortLike,
  CapabilityCatalogPort,
  ChatConfigState,
  ChatDirectiveHandlers,
  ChatLanguageModel,
  ChatStateContainer,
  ChatStateSnapshot,
  ChatTokenAccounting,
  CompactionHook,
  LiveViewPort,
  PlannerStagePort,
  RunDetailReaderPort,
  ReconcileStrategy,
  AnalysisArtifactReaderPort,
  ClockPort,
  ConfigFilesPortLike,
  ConfigReaderPort,
  ConfigScaffoldContentPortLike,
  ConfigValidatePortLike,
  EntityDirectoryPort,
  FunctionDeps,
  FunctionRegistry,
  JobIdSource,
  JobKindRegistry,
  JobModelCapability,
  KnowledgeReaderPort,
  PostRunJobCapabilities,
  RecurrenceLadder,
  RecurrenceProvider,
  RunInvocationPort,
  RunsReaderPort,
  StartedRun,
  StepEvidenceAddress,
  StepEvidenceLookup,
} from '@vostride/agent-qa-agent'
import {
  ADDRESSING_LEDGER_DB_FILE,
  acquireEmbedder,
  acquireWriterLease,
  classifyIndexFace,
  countPendingCurationJobs,
  createMemorySightingSource,
  createLocalKnowledgeStore,
  createQuarantineOperations,
  QUARANTINE_FLAG_FLOOR,
  describeAllEntities,
  embedPendingEntities,
  countRemainingCurationWork,
  deriveWriterLeaseFreshness,
  drainQueue,
  DRAIN_BUDGET_MS,
  EMBEDDER_WORKER_REGISTRATION_FILE,
  EMBEDDER_WORKER_START_TIMEOUT_MS,
  EMBEDDER_WORKER_TERM_GRACE_MS,
  EmbedderWorkerTimeoutError,
  embedderWorkerProcessIsAlive,
  embedderWorkerSocketPath,
  enqueueCurationCandidateProjection,
  failureRecurrence,
  fingerprintRecurrence,
  listTestsInFile,
  foldQuarantineLedgerState,
  foldRetrievalRung,
  foldRunOutcomes,
  createDraftReceiptsStore,
  createSuiteFingerprintIndex,
  indexDbPath,
  readQuarantineLedger,
  readTestOutcomeHistory,
  getEntityDescriptor,
  heartbeatLease,
  inspectDrainableCurationWork,
  isLeaseStale,
  listQueuedCandidates,
  openAddressingLedger,
  openEntityIndex,
  openKnowledgeReader,
  purgeAffectedSetFingerprint,
  probeEmbedderWorkerSocket,
  purgeRecord,
  readCanonicalBundleAnchors,
  readCanonicalBundleStateDigests,
  standingReceiptDigestsFor,
  readEmbedderWorkerRegistration,
  readWriterLease,
  rebuildIndex,
  reconcileRunOutcomesProjection,
  entityIndexDbPath,
  resolveEntityRef,
  sightEntity,
  refreshWriterLeaseAuthority,
  releaseLease,
  removeEmbedderWorkerRegistration,
  resetEmbedderCapability,
  resolveEmbedderCapability,
  resolveProcessIncarnation,
  verifyEmbedderWorkerIncarnation,
  resolvePurgeAffectedSet,
  resolveRollbackAffectedSet,
  rollbackAffectedSetFingerprint,
  rollbackCampaign,
  rollbackCurationJob,
  runMaintenanceTail,
  sweepEntityIndex,
  RUN_OUTCOMES_PROJECTION_VERSION,
  ENTITY_INDEX_SWEEP_INTERVAL_MS,
  type EmbedderWorkerRegistration,
  type EntityIndexSweepReport,
  type ResolveEntityRefDeps,
  applyExplicitReview,
  appendMarkEvidence,
  triageMark,
  servedIdsOn,
  procedureReadOn,
  applyFeedback,
  enumerateBundleDirs,
  loadBundle,
  verifyBundleIntegrity,
  createAuthoringReader,
  openAddressingLedger as openAddressingLedgerForReview,
  resolveRetrievalRung,
} from '@vostride/agent-qa-knowledge-local'
import type {
  ExplicitReviewDelegate,
  ExplicitReviewRequest,
  ExplicitReviewResult,
  CreateLocalKnowledgeStoreConfig,
} from '@vostride/agent-qa-knowledge-local'
import type { KnowledgeReviewPort } from '@vostride/agent-qa-agent'
import type { FeedbackPort, FeedbackReadsPort } from '@vostride/agent-qa-schema'
import type { ArtifactRef } from '@vostride/agent-qa-schema'
import type { ServedRecordFacts } from '@vostride/agent-qa-knowledge-local'
export type { ServedRecordFacts, MarkTriage, ApplyFeedbackInput } from '@vostride/agent-qa-knowledge-local'
import { ReplayIncompleteError } from '@vostride/agent-qa-runner'
import {
  getActiveExecutionContext,
  setActiveExecutionContextResolver,
} from '@vostride/agent-qa-safety'
import {
  ARTIFACT_FILE,
  FsEventLog,
  FsEvidenceArtifactStore,
  HANDOFF_FILE,
  RUNS_SUBDIR,
  loadCompletedRunHandoff,
  slugBranch,
} from '@vostride/agent-qa-runner-local'
import {
  admitAnalysisArtifactForRun,
  ANALYSIS_FILE,
  asJobId,
  DEFAULT_EMBEDDING_PROFILE,
  guardRunAnalysisArtifact,
  maskPayloadTree,
  sha256hex16,
} from '@vostride/agent-qa-schema'
import type {
  AuthoringBrief,
  AuthoringVerifyDraftInput,
  ChatSessionEvent,
  ChatSessionHandle,
  CompletedRunHandoff,
  DraftReceipt,
  ExecutionContext,
  GateReceipt,
  GateReceiptRecordOutcome,
  KnowledgeChangeOutput,
  KnowledgeChangeVerb,
  MaskFn,
  PromotionOutcome,
  RecordId,
  FunctionCaller,
  JobKind,
  QuarantineEntryStateName,
  QuarantineLadderState,
  RecordedTargets,
  RunEventEnvelope,
  RunId,
  RunStartAcknowledgement,
  TestEditPatchSet,
  TestFileWrite,
  RunsStartInput,
  ScopeKey,
  SessionLogPort,
} from '@vostride/agent-qa-schema'

import { createKnowledgeReaderPort } from './knowledge-review-reader.js'
import type { SightMemoryEntities } from './knowledge-review-reader.js'
import { createEvidenceBlobReader, readEvidenceBlobBytes } from './evidence-blob-reader.js'
import { buildRunPorts } from './run-composition.js'
import type { RetrievalRungResolver } from './run-composition.js'
import { writeAnalysisArtifact } from '../analysis/persist-analysis.js'
import { createJsonlSessionLog } from '../session/jsonl-session-log.js'
import { createJobCheckpointStore } from '../store/job-checkpoint-store.js'
import { createPostProcessingReader } from '../store/post-processing-reader.js'
import { AGENT_JOB_STORE_DB_FILE, createSqliteJobStore } from '../store/sqlite-job-store.js'
import type { SqliteJobStore } from '../store/sqlite-job-store.js'

// ---- the knowledge-writer capabilities (D-14, SC5) --------------------------------------------
//
// This file is the ONE place the knowledge package's writer-gated main entry is named, and the arch
// rule named reader-carveout enforces both halves of that: a second file naming it fails, and zero
// files naming it fails too — an allowance nothing uses is a rule that passes forever while
// checking nothing.
//
// What this is NOT: a per-host binding. Every function below takes the roots and options it works
// against as arguments, so there is nothing for a composition to close over and every host would
// bind the identical object. Saying that plainly matters, because the value of gathering them here
// is not parameterisation — it is that "which writer powers does the local host grant?" has one
// answer, in one type, reachable through one edge, instead of being the union of whatever six
// surface files happened to import.
//
// Consequence for a caller: a module that needs one of these at MODULE scope takes it from
// `LOCAL_CURATION_CAPABILITIES` directly; a host that has a handle takes it from `host.curation`,
// which is the same frozen object. Threading a handle through the curation tail's call graph would
// have been a signature change to code D-14 requires this phase to leave semantically untouched.

/**
 * 407 D-13/D-17 — THE retrieval-rung resolver, bound at the one edge that may name the writer
 * entry (385 D-14/SC5) and handed to `openRunKnowledgeComposition` by every run door.
 *
 * The binding exists so there is exactly ONE resolver in the tree with exactly ONE importer of
 * the package that owns it. `run-composition.ts` declares the seam's shape structurally and takes
 * the function as a required input rather than importing it — naming knowledge-local's main entry
 * from a second file would retire the singleton the arch gate enforces, and the fix would look
 * like relaxing the gate.
 *
 * Typed as {@link RetrievalRungResolver} rather than by its own signature, so the pass-through
 * that reaches the CLI is the narrow two-root contract the doors actually use — the embedder
 * `probes` seam and the preferred profile stay knowledge-local's business.
 */
export const resolveHostRetrievalRung: RetrievalRungResolver = resolveRetrievalRung

/**
 * 407 D-18/D-20 — the READ-ONLY knowledge probes a diagnostic grades a host with.
 *
 * `doctor` needs the two axes SEPARATELY, not just the folded word: its `Knowledge store` row is
 * about the index face, its `Embedder` row is about the capability outcome, and only its third row
 * is the fold. {@link resolveHostRetrievalRung} above hands back the fold alone, so a surface that
 * had only that would have to re-derive the other two — which is a second fold in everything but
 * name, and exactly what D-17's one-resolver rule exists to prevent.
 *
 * Published as its own frozen table rather than folded into {@link LOCAL_DAEMON_CAPABILITIES}
 * because every member here is a READ. Nothing in it acquires a lease, spawns a worker, downloads
 * an artifact or writes to the knowledge root, and a caller that holds this object cannot mutate
 * the thing it is reporting on. That is the whole mitigation for T-407-19: the boundary is the
 * shape of the capability, not a promise in a doc comment at the call site.
 *
 * `foldRetrievalRung` rides along for the same reason the resolver does — one fold table in one
 * package, reached through the one edge that may name the writer entry (385 D-14/SC5).
 */
export interface LocalKnowledgeProbeCapabilities {
  readonly classifyIndexFace: typeof classifyIndexFace
  readonly foldRetrievalRung: typeof foldRetrievalRung
  readonly indexDbPath: typeof indexDbPath
  readonly readEmbedderWorkerRegistration: typeof readEmbedderWorkerRegistration
  readonly readWriterLease: typeof readWriterLease
  readonly resolveEmbedderCapability: typeof resolveEmbedderCapability
}

export const LOCAL_KNOWLEDGE_PROBES: LocalKnowledgeProbeCapabilities = Object.freeze({
  classifyIndexFace,
  foldRetrievalRung,
  indexDbPath,
  readEmbedderWorkerRegistration,
  readWriterLease,
  resolveEmbedderCapability,
})

// The probe vocabulary the three doctor rows are typed against, re-exported through the same one
// edge. Types are erased, so this hands a caller no power the frozen table above does not.
export type {
  AcquireEmbedderOutcome,
  IndexFace,
  ReadEmbedderWorkerRegistrationOutcome,
  ResolveEmbedderCapabilityOptions,
} from '@vostride/agent-qa-knowledge-local'

// 387-08 D-18: the delegate transport's own vocabulary, re-exported through the one edge that
// names the writer entry. 2026-10-01 (432-17): the proposal door's `ApplyDelegate` and
// `ApplyReviewResult` are deleted with it; a delegate receives the validated request and its stable
// identity (432-09), never a proposal id to reload.
export type {
  ExplicitReviewDelegate,
  ExplicitReviewDelegation,
  ExplicitReviewRequest,
  ExplicitReviewResult,
} from '@vostride/agent-qa-knowledge-local'

export type {
  AcquireWriterLeaseOutcome,
  AuthorOutcome,
  AuthoringTestRef,
  CurationCandidateProjection,
  CurationJobView,
  CurationProjectionArtifactSource,
  CuratorAuthor,
  EnqueueCurationCandidateProjectionOutcome,
  HeartbeatLeaseOutcome,
  LeaseOperationOptions,
  NeighborRecord,
  OpenServingKnowledgeReaderConfig,
  PurgeAffectedSet,
  PurgeReceipt,
  RebuildReport,
  ReadWriterLeaseOutcome,
  ReleaseLeaseOutcome,
  RollbackAffectedSet,
  RollbackCampaignInput,
  RollbackCurationJobInput,
  RollbackReport,
  WriterLease,
  WriterLeaseAuthority,
  WriterLeaseFreshness,
} from '@vostride/agent-qa-knowledge-local'

// Surface hosts reach worker lifecycle vocabulary through this one legal composition edge.
export {
  /**
   * THE one-shot post-run budget (388-02 D-03), reached through the same edge.
   *
   * Re-exported rather than restated: the CLI's post-run tail runs the agent-job chain under
   * the identical bound the curation drain has always used, and a surface that spelled `60_000`
   * of its own would be the second knob the user explicitly refused.
   */
  DRAIN_BUDGET_MS,
  EMBEDDER_WORKER_REGISTRATION_FILE,
  EMBEDDER_WORKER_START_TIMEOUT_MS,
  EMBEDDER_WORKER_TERM_GRACE_MS,
  EmbedderWorkerTimeoutError,
  // The projection's maintenance cadence reaches the daemon host through the same one edge.
  ENTITY_INDEX_SWEEP_INTERVAL_MS,
}

/**
 * The standing daemon's writer-authority substrate, published through the same one composition
 * edge as every other local writer capability. Surface packages may import agent-local, but the
 * architecture firewall deliberately forbids them from naming knowledge-local or safety
 * directly; keeping this frozen table here preserves that boundary without duplicating lease
 * behavior in the CLI host.
 */
export interface LocalDaemonCapabilities {
  readonly acquireWriterLease: typeof acquireWriterLease
  readonly heartbeatLease: typeof heartbeatLease
  readonly releaseLease: typeof releaseLease
  readonly readWriterLease: typeof readWriterLease
  readonly isLeaseStale: typeof isLeaseStale
  /**
   * CR-01/CR-08: the one three-valued freshness verdict — fresh, reclaimable, or unknown.
   *
   * Any surface that classifies a holder as recoverable must read this and not the lease file
   * alone, and must name what it does with `unknown` rather than inheriting a boolean it never
   * chose. An authority state that cannot be read is not evidence that nobody holds it.
   */
  readonly deriveWriterLeaseFreshness: typeof deriveWriterLeaseFreshness
  readonly countPendingCurationJobs: typeof countPendingCurationJobs
  readonly countRemainingCurationWork: typeof countRemainingCurationWork
  readonly inspectDrainableCurationWork: typeof inspectDrainableCurationWork
  readonly listQueuedCandidates: typeof listQueuedCandidates
  readonly acquireEmbedder: typeof acquireEmbedder
  readonly drainQueue: typeof drainQueue
  readonly runMaintenanceTail: typeof runMaintenanceTail
  readonly resolveEmbedderWorkerEntryPath: () => string
  readonly readEmbedderWorkerRegistration: typeof readEmbedderWorkerRegistration
  readonly embedderWorkerProcessIsAlive: typeof embedderWorkerProcessIsAlive
  readonly embedderWorkerSocketPath: typeof embedderWorkerSocketPath
  readonly probeEmbedderWorkerSocket: typeof probeEmbedderWorkerSocket
  /** CR-05: no surface may signal a registered worker pid without this verdict returning 'match'. */
  readonly verifyEmbedderWorkerIncarnation: typeof verifyEmbedderWorkerIncarnation
  // 2026-10-16 (442-02, D-20): a run owner's start time, read for the CLI's runs.db ownership.
  readonly resolveProcessIncarnation: typeof resolveProcessIncarnation
  readonly removeEmbedderWorkerRegistration: (
    agentQaRoot: string,
    expected: EmbedderWorkerRegistration,
  ) => ReturnType<typeof removeEmbedderWorkerRegistration>
  readonly resetEmbedderCapability: () => void
  readonly pinLocalHeadlessExecutionContext: () => void
}

function resolveEmbedderWorkerEntryPath(): string {
  const requireBase = typeof __filename === 'string'
    ? __filename
    : import.meta.url
  const knowledgeEntry = createRequire(requireBase).resolve('@vostride/agent-qa-knowledge-local')
  return join(dirname(knowledgeEntry), 'embedder-worker', 'worker-entry.js')
}

export const LOCAL_DAEMON_CAPABILITIES: LocalDaemonCapabilities = Object.freeze({
  acquireWriterLease,
  heartbeatLease,
  releaseLease,
  readWriterLease,
  deriveWriterLeaseFreshness,
  isLeaseStale,
  countPendingCurationJobs,
  countRemainingCurationWork,
  inspectDrainableCurationWork,
  listQueuedCandidates,
  acquireEmbedder,
  drainQueue,
  runMaintenanceTail,
  resolveEmbedderWorkerEntryPath,
  readEmbedderWorkerRegistration,
  embedderWorkerProcessIsAlive,
  embedderWorkerSocketPath,
  probeEmbedderWorkerSocket,
  verifyEmbedderWorkerIncarnation,
  resolveProcessIncarnation,
  removeEmbedderWorkerRegistration,
  resetEmbedderCapability: () => resetEmbedderCapability(DEFAULT_EMBEDDING_PROFILE),
  pinLocalHeadlessExecutionContext: () => {
    setActiveExecutionContextResolver(() => 'local-headless')
  },
})

/**
 * Index maintenance and the campaign/job rollback verbs, plus the lease every one of them is only
 * legal to hold under. Grouped rather than flattened because they share that precondition: a host
 * reaching for `purgeRecord` without a lease is the mistake the grouping makes visible.
 */
export interface LocalKnowledgeMaintenanceCapabilities {
  readonly acquireWriterLease: typeof acquireWriterLease
  readonly refreshWriterLeaseAuthority: typeof refreshWriterLeaseAuthority
  readonly releaseLease: typeof releaseLease
  readonly rebuildIndex: typeof rebuildIndex
  readonly purgeRecord: typeof purgeRecord
  readonly resolvePurgeAffectedSet: typeof resolvePurgeAffectedSet
  readonly purgeAffectedSetFingerprint: typeof purgeAffectedSetFingerprint
  readonly rollbackCampaign: typeof rollbackCampaign
  readonly rollbackCurationJob: typeof rollbackCurationJob
  readonly resolveRollbackAffectedSet: typeof resolveRollbackAffectedSet
  readonly rollbackAffectedSetFingerprint: typeof rollbackAffectedSetFingerprint
}

interface ReceiptWriterInput extends Pick<CreateLocalKnowledgeStoreConfig,
  'knowledgeRoot' | 'executionContext' | 'resolveTrustPriors' | 'sourceBuildOrdinal' | 'sourceRunId'> {
  /** The caller already holds this authority; these capabilities never acquire a lease. */
  lease: { leaseId: string; epoch: number }
}

export interface RecordGateReceiptInput extends ReceiptWriterInput {
  receipt: GateReceipt
}

export interface PromoteWithReceiptsInput extends ReceiptWriterInput {
  candidateId: RecordId
  receipts?: readonly GateReceipt[]
}

function receiptWriter(input: ReceiptWriterInput) {
  return createLocalKnowledgeStore({
    knowledgeRoot: input.knowledgeRoot,
    executionContext: input.executionContext,
    writerLeaseId: input.lease.leaseId,
    epoch: input.lease.epoch,
    ...(input.resolveTrustPriors === undefined ? {} : { resolveTrustPriors: input.resolveTrustPriors }),
    ...(input.sourceBuildOrdinal === undefined ? {} : { sourceBuildOrdinal: input.sourceBuildOrdinal }),
    ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
  })
}

function recordGateReceipt(input: RecordGateReceiptInput): Promise<GateReceiptRecordOutcome> {
  return receiptWriter(input).recordGateReceipt(input.receipt)
}

function promoteWithReceipts(input: PromoteWithReceiptsInput): Promise<PromotionOutcome> {
  return receiptWriter(input).promote(input.candidateId, input.receipts)
}

/** Internal facts only: public showRecord deliberately omits bundle construction fields. */
function readFeedbackRecord(input: { knowledgeRoot: string; recordId: string; evidenceRef?: ArtifactRef }): ServedRecordFacts | undefined {
  const matches = enumerateBundleDirs(input.knowledgeRoot).flatMap(entry => {
    const result = loadBundle(entry.dir)
    return result.kind === 'loaded' && result.bundle.manifest.id === input.recordId
      && verifyBundleIntegrity(entry.dir).ok ? [result.bundle] : []
  })
  if (matches.length !== 1) return undefined
  const bundle = matches[0]!
  const artifact = input.evidenceRef ?? bundle.artifactsIndex.artifacts[0]
  if (artifact === undefined) return undefined
  return { recordId: input.recordId, kind: bundle.frontmatter.kind,
    ...(bundle.frontmatter.subtype === undefined ? {} : { subtype: bundle.frontmatter.subtype }),
    anchors: bundle.frontmatter.anchors.map(anchor => anchor.raw), scope: bundle.frontmatter.scope,
    summary: bundle.summary, distilledEvidenceRef: { id: artifact.id, sha: artifact.sha },
    // This is the only admitted draft construction stage; user origin belongs on the delta.
    originStage: 'run-curation' }
}

export interface LocalCurationCapabilities {
  readonly readFeedbackRecord: typeof readFeedbackRecord
  readonly appendMarkEvidence: typeof appendMarkEvidence
  /**
   * 2026-09-15, 423 D-16/D-17: the lease-free planning half appendMarkEvidence executes, so a
   * consequence preview names every confirm/overturn effect without the writer. Reads only.
   */
  readonly planMarkEvidence: typeof planMarkEvidence
  readonly projectMarkEvidenceOutcome: typeof projectMarkEvidenceOutcome
  readonly triageMark: typeof triageMark
  readonly servedIdsOn: typeof servedIdsOn
  readonly procedureReadOn: typeof procedureReadOn
  readonly applyFeedback: typeof applyFeedback
  readonly recordGateReceipt: typeof recordGateReceipt
  readonly promoteWithReceipts: typeof promoteWithReceipts
  /** Serving-side reader the tail folds against; read-only despite arriving on the writer edge. */
  readonly openKnowledgeReader: typeof openKnowledgeReader
  readonly drainQueue: typeof drainQueue
  readonly foldRunOutcomes: typeof foldRunOutcomes
  /**
   * THE mechanism a version bump rides (393 CR-02). The per-run receipt below carries the
   * version, but invalidating receipts only re-runs folds that answer 'already-applied' on the
   * durable marker — so the refold a bump promises happens through THIS capability, as a rebuild
   * of the derived family, and nowhere else.
   *
   * It is invoked at exactly two sites, one per supported host (393 round 6, CR-02-daemon): once
   * per CLI curation-tail sweep, and once per daemon lease acquisition. Both, because the CLI
   * tail is unreachable whenever a standing daemon takes the hand-off — a promise true of one
   * host is, on the other host, a projection that never converges.
   */
  readonly reconcileRunOutcomesProjection: typeof reconcileRunOutcomesProjection
  readonly enqueueCurationCandidateProjection: typeof enqueueCurationCandidateProjection
  readonly readCanonicalBundleAnchors: typeof readCanonicalBundleAnchors
  readonly readCanonicalBundleStateDigests: typeof readCanonicalBundleStateDigests
  readonly readStandingGateReceipts: typeof standingReceiptDigestsFor
  /** 418 D-07: reuse the writer's observation identity through the existing CLI bridge. */
  readonly canaryOutcomeObservationId: typeof canaryOutcomeObservationId
  /**
   * Component of the tail's receipt: a bump refolds runs already receipted at the old version.
   * The receipt is the per-run half of that promise; `reconcileRunOutcomesProjection` above is
   * the half that actually re-derives the rows.
   */
  readonly runOutcomesProjectionVersion: typeof RUN_OUTCOMES_PROJECTION_VERSION
  readonly maintenance: LocalKnowledgeMaintenanceCapabilities
}

export const LOCAL_CURATION_CAPABILITIES: LocalCurationCapabilities = Object.freeze({
  readFeedbackRecord,
  appendMarkEvidence,
  planMarkEvidence,
  projectMarkEvidenceOutcome,
  triageMark,
  servedIdsOn,
  procedureReadOn,
  applyFeedback,
  recordGateReceipt,
  promoteWithReceipts,
  openKnowledgeReader,
  drainQueue,
  foldRunOutcomes,
  reconcileRunOutcomesProjection,
  enqueueCurationCandidateProjection,
  readCanonicalBundleAnchors,
  readCanonicalBundleStateDigests,
  readStandingGateReceipts: standingReceiptDigestsFor,
  runOutcomesProjectionVersion: RUN_OUTCOMES_PROJECTION_VERSION,
  canaryOutcomeObservationId,
  maintenance: Object.freeze({
    acquireWriterLease,
    refreshWriterLeaseAuthority,
    releaseLease,
    rebuildIndex,
    purgeRecord,
    resolvePurgeAffectedSet,
    purgeAffectedSetFingerprint,
    rollbackCampaign,
    rollbackCurationJob,
    resolveRollbackAffectedSet,
    rollbackAffectedSetFingerprint,
  }),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTargetName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * The target names an artifact snapshot recorded (431 D-08), read out of an UNTRUSTED document:
 * a single test's resolved definition, or every suite member that recorded one. Any shape it does
 * not recognise answers `unknown`, so malformed metadata can never read as "recorded no targets".
 * Only the names cross this seam; no other part of the snapshot does.
 */
function recordedTargetsOf(artifact: unknown): RecordedTargets {
  const source = isRecord(artifact) ? artifact.source : undefined
  if (!isRecord(source)) return { status: 'unknown' }

  if (source.kind === 'test') {
    const target = isRecord(source.resolvedDefinition) ? source.resolvedDefinition.target : undefined
    return isTargetName(target) ? { status: 'recorded', names: [target] } : { status: 'unknown' }
  }
  if (source.kind !== 'suite' || !Array.isArray(source.members)) return { status: 'unknown' }

  const names = new Set<string>()
  for (const member of source.members) {
    if (!isRecord(member)) return { status: 'unknown' }
    if (member.target === undefined || member.target === null) continue
    if (!isTargetName(member.target)) return { status: 'unknown' }
    names.add(member.target)
  }
  return names.size === 0 ? { status: 'unknown' } : { status: 'recorded', names: [...names].sort() }
}

/**
 * Enumerate `<agentQaRoot>/runs/<slug>/handoff.json`. A project with no runs directory is an
 * ordinary empty result, not an error; an individual unreadable or version-rejected document is
 * skipped so one bad run never hides every other run.
 */
export function createRunsReader(agentQaRoot: string): RunsReaderPort {
  function enumerate(): CompletedRunHandoff[] {
    const runsDir = join(agentQaRoot, RUNS_SUBDIR)
    if (!existsSync(runsDir)) return []

    const documents: CompletedRunHandoff[] = []
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const handoffPath = join(runsDir, entry.name, HANDOFF_FILE)
      if (!existsSync(handoffPath)) continue
      try {
        documents.push(loadCompletedRunHandoff(handoffPath))
      } catch {
        continue
      }
    }
    return documents
  }

  return {
    list(): Promise<readonly CompletedRunHandoff[]> {
      return Promise.resolve(enumerate())
    },
    /**
     * Resolution runs over the ENUMERATED run documents and matches on the recorded `runId`,
     * never by joining the caller's string onto a path (T-384-08): a `runId` of `../../etc` can
     * therefore address nothing outside the runs directory, because it is never used to build a
     * path at all.
     */
    get(runId: RunId): Promise<CompletedRunHandoff | undefined> {
      return Promise.resolve(enumerate().find((document) => document.runId === runId))
    },
    /**
     * Deep replay of one run's `events.jsonl` through the SAME concrete store the v49 bus appends
     * with, so a replayed stream is byte-for-byte what the run emitted.
     *
     * Two cases are deliberately distinct. An absent or empty log is an ordinary empty replay —
     * nothing was recorded, so nothing was lost. A log whose earliest surviving seq is ABOVE the
     * requested resume point means events the caller asked for existed and are gone; that is
     * reported with the bus's own `ReplayIncompleteError` carrying the floor, never papered over
     * by returning the surviving suffix (D-07/D-08).
     */
    readEvents(runId: RunId, fromSeq: number): Promise<readonly RunEventEnvelope[]> {
      const recorded = [...new FsEventLog({ root: agentQaRoot, runId }).read(0)]
        .sort((left, right) => left.seq - right.seq)
      if (recorded.length === 0) return Promise.resolve([])

      const earliestAvailableSeq = recorded[0]!.seq
      if (fromSeq < earliestAvailableSeq) {
        return Promise.reject(new ReplayIncompleteError(fromSeq, earliestAvailableSeq))
      }
      return Promise.resolve(recorded.filter((event) => event.seq >= fromSeq))
    },
    /**
     * One step's persisted evidence, read back out of the run's own handoff document
     * (387 KREV-02 / D-15).
     *
     * Through `loadCompletedRunHandoff` — the version guard — and NOT through a raw JSON read,
     * which is the load-bearing half. 387-02 gave the guard a present-implies-valid clause for
     * the retrieval trace, so a document whose trace is present but malformed is refused here
     * rather than reaching the why-verb looking well-formed.
     *
     * The ambiguity check is the never-guess law at this seam. `stepIndex` numbers steps per
     * MEMBER TEST, so a run with two tests has two step 0s; when the address does not name a
     * test and more than one candidate answers to it, this reports the candidates rather than
     * picking whichever test the document happened to list first. Picking would have produced a
     * confident, wrong answer to a question that was never asked — and a why-verb that does
     * that is worse than one that refuses, because its answer looks exactly like a right one.
     */
    readStepEvidence(runId: RunId, address: StepEvidenceAddress): Promise<StepEvidenceLookup> {
      const document = enumerate().find((candidate) => candidate.runId === runId)
      if (document === undefined) return Promise.resolve({ kind: 'run-not-recorded' })

      const candidates = document.tests.filter((test) => (
        (address.testId === undefined || test.testId === address.testId)
        && test.steps.some((step) => step.stepIndex === address.stepIndex)
      ))
      if (candidates.length === 0) return Promise.resolve({ kind: 'step-not-found' })
      if (candidates.length > 1) {
        return Promise.resolve({
          kind: 'ambiguous-step-address',
          // Sorted, so the refusal a surface prints is the same list twice running.
          testIds: candidates.map((test) => test.testId).sort(),
        })
      }

      const evidence = candidates[0]!.steps.find((step) => step.stepIndex === address.stepIndex)
      return Promise.resolve(
        evidence === undefined
          ? { kind: 'step-not-found' }
          : { kind: 'found', evidence },
      )
    },
    /**
     * Resolved over the ENUMERATED run directories (T-384-08, T-431-01): the caller's id is only
     * ever compared, never joined onto a path, and the directory must hold a completed handoff
     * recording that same id, so one run's snapshot can never answer for another. A snapshot that
     * is absent, unreadable or gone since `list()` answered is `unknown`, never an error.
     */
    getRecordedTargets(runId: RunId): Promise<RecordedTargets> {
      const runsDir = join(agentQaRoot, RUNS_SUBDIR)
      if (!existsSync(runsDir)) return Promise.resolve({ status: 'unknown' })

      const entry = readdirSync(runsDir, { withFileTypes: true })
        .find((candidate) => candidate.isDirectory() && candidate.name === runId)
      if (entry === undefined) return Promise.resolve({ status: 'unknown' })

      try {
        const runDir = join(runsDir, entry.name)
        if (loadCompletedRunHandoff(join(runDir, HANDOFF_FILE)).runId !== runId) {
          return Promise.resolve({ status: 'unknown' })
        }
        return Promise.resolve(
          recordedTargetsOf(JSON.parse(readFileSync(join(runDir, ARTIFACT_FILE), 'utf8'))),
        )
      } catch {
        return Promise.resolve({ status: 'unknown' })
      }
    },
  }
}

/**
 * The knowledge READ port, served through the PHYSICALLY read-only `/reader` package entry.
 *
 * The five read verbs live in `knowledge-review-reader.ts`, which is registered in the arch
 * reader carve-out's pinned file list and therefore CANNOT name the writer-gated entry. This
 * file can (it also binds the curator), so keeping the verbs here would have put them in the
 * one place in the workspace where a write import is legal — separation by discipline instead
 * of by rule. What stays here is the half that genuinely belongs to a composition root: the
 * D-01 sighting site, which mints into the durable addressing ledger and so must live where
 * the writer entry may be named.
 *
 * The knowledge ROOT arrives as a host-supplied resolver rather than being derived here: deciding
 * which configuration file is in force, layering an environment over it and choosing whether to
 * load and execute auth plugins are three decisions a daemon makes differently from a terminal,
 * and by the plan-08 dissection rule a thing a headless host would substitute is a port.
 */
export function createKnowledgeReader(
  resolveKnowledgeRoot: () => Promise<string> | string,
  sightMemoryEntities?: SightMemoryEntities,
  resolveTrustPriors?: CreateLocalKnowledgeStoreConfig['resolveTrustPriors'],
): KnowledgeReaderPort {
  return createKnowledgeReaderPort({
    resolveKnowledgeRoot,
    ...(resolveTrustPriors === undefined ? {} : { resolveTrustPriors }),
    ...(sightMemoryEntities === undefined ? {} : { sightMemoryEntities }),
  })
}

// ---- knowledge review: the WRITE half of the verb family (387 KREV-01 / D-17 · D-18) --------

export interface CreateKnowledgeReviewInput {
  readonly resolveTrustPriors?: CreateLocalKnowledgeStoreConfig['resolveTrustPriors']
  readonly agentQaRoot: string
  readonly resolveKnowledgeRoot: () => Promise<string> | string
  /**
   * The writer lease this host ALREADY holds, when it is the holder (D-18).
   *
   * The daemon's half of the routing rule. A holder cannot acquire its own lease a second time, so
   * it hands the authority it owns to the change; supplying this is mutually exclusive with
   * supplying a delegate, and a host that supplies both is a host claiming to be two places.
   */
  readonly resolveWriterAuthority?: () => { readonly leaseId: string; readonly epoch: number } | undefined
  /**
   * 432-12 (D-05): how a direct change reaches a live writer-lease holder. The holder receives the
   * validated request and the change's stable identity, bounded; the lease is never taken. Absent,
   * a held lease refuses the change by name. Exclusive with {@link resolveWriterAuthority}: a holder
   * never delegates. The daemon supplies none, which is why its own changes cannot recurse.
   */
  readonly knowledgeChangeDelegate?: ExplicitReviewDelegate
  /**
   * 432-12: the context a direct change is recorded under. Absent means the process resolver, the
   * default every registry in this composition already reads. The context is recorded as-is; an
   * explicit change applies in every context (D-04/D-08).
   */
  readonly resolveExecutionContext?: () => ExecutionContext
}

/** The public answer to one direct change, from the explicit writer's own result (432-12). */
function knowledgeChangeOutput(
  verb: KnowledgeChangeVerb,
  operationId: string,
  result: ExplicitReviewResult,
): KnowledgeChangeOutput {
  switch (result.outcome) {
    case 'applied':
      return {
        outcome: 'applied',
        verb,
        operationId,
        recordIds: [...result.recordIds],
        ...(result.forgetReceipt === undefined ? {} : { forgetReceipt: result.forgetReceipt }),
        ...(result.commitReceipt === undefined ? {} : { commitReceipt: result.commitReceipt }),
      }
    case 'target-not-found':
      return { outcome: 'target-not-found', verb, operationId, target: result.target }
    case 'policy-materialize-refused':
      return { outcome: 'refused', verb, operationId, reason: 'policy-materialize-refused' }
    default:
      return result satisfies never
  }
}

/**
 * Bind the mutating review verbs over the review modules and the Curator's one commit path.
 *
 * A SEPARATE factory from `createKnowledgeReader`, mirroring the port split it implements: this
 * is the object whose presence makes accept/reject/forget report `bound`, and a host that wants
 * only the read verbs simply does not build one. The `MEM-` short-ID leg resolves through the
 * addressing ledger, opened per call and closed again on exactly the reasoning the entity
 * directory uses — a durable file the composition root owns, never a handle a review module holds.
 */
export function createKnowledgeReview(input: CreateKnowledgeReviewInput): KnowledgeReviewPort {
  async function roots(): Promise<{ knowledgeRoot: string }> {
    return { knowledgeRoot: await input.resolveKnowledgeRoot() }
  }

  // 432-12: this host's direct changes take the writer lease one at a time. Two changes racing in
  // one process would otherwise find the lease held by each other and the second would refuse as if
  // another writer held it. The queue releases on success and failure alike (the config
  // transaction's pattern); it does not claim to serialize across processes, which the lease does.
  let changeChain: Promise<unknown> = Promise.resolve()
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = changeChain.then(work, work)
    changeChain = next.then(() => undefined, () => undefined)
    return next
  }

  return {
    // 432-12 (D-04/D-05/D-09): one explicit change, applied in the call through the direct writer
    // (432-06). Nothing is filed: the change is committed under the lease, handed to a live
    // holder, or refused by type. A missing identity is minted here, once per call, and returned on
    // the receipt so the caller can retry the same change.
    change: (request) => serialized(async () => {
      const { knowledgeRoot } = await roots()
      const operationId = request.operationId ?? randomUUID()
      const authority = input.resolveWriterAuthority?.()
      const result = await applyKnowledgeChange({
        agentQaRoot: input.agentQaRoot,
        knowledgeRoot,
        request: { verb: request.verb, input: request.input } as ExplicitReviewRequest,
        operationId,
        // The op that made the change, stamped on Gate-3 receipts: `knowledge.accept`,
        // `knowledge.reject` or `knowledge.forget`, which is the verb's own op id.
        opId: `knowledge.${request.verb}`,
        executionContext: (input.resolveExecutionContext ?? getActiveExecutionContext)(),
        ...(input.resolveTrustPriors === undefined ? {} : { resolveTrustPriors: input.resolveTrustPriors }),
        ...(input.knowledgeChangeDelegate === undefined ? {} : { delegate: input.knowledgeChangeDelegate }),
        ...(authority === undefined ? {} : { writerAuthority: authority }),
      })
      return knowledgeChangeOutput(request.verb, operationId, result)
    }),
    // 2026-10-01 (432-17, D-05/D-22): `propose` and `apply` are deleted with the proposal inbox.
  }
}



// ---- 432-09: an explicit knowledge change, applied in the call (D-04/D-11) ------------------------

export interface ApplyKnowledgeChangeInput {
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  readonly request: ExplicitReviewRequest
  /** The caller's stable identity for this change: a retry with the same identity lands nothing twice. */
  readonly operationId: string
  /** The op making the change, stamped on its Gate-3 receipts. */
  readonly opId: string
  /** The caller's actual context, recorded as-is. An explicit change applies in every context. */
  readonly executionContext: ExecutionContext
  readonly resolveTrustPriors?: CreateLocalKnowledgeStoreConfig['resolveTrustPriors']
  /**
   * How this host reaches a live writer-lease holder. The holder receives exactly the validated
   * request and identity, bounded; the lease is never taken. Absent, a held lease refuses by name.
   */
  readonly delegate?: ExplicitReviewDelegate
  /** The lease this host already holds, when it is the holder. Exclusive with {@link delegate}. */
  readonly writerAuthority?: { readonly leaseId: string; readonly epoch: number }
}

/**
 * Apply one explicit knowledge change through the direct writer (432-06), with this host's short-id
 * resolver. Nothing is filed: the change is committed, or it is refused by type.
 */
export async function applyKnowledgeChange(input: ApplyKnowledgeChangeInput): Promise<ExplicitReviewResult> {
  const ledger = openAddressingLedgerForReview({
    path: join(input.agentQaRoot, ADDRESSING_LEDGER_DB_FILE),
  })
  try {
    return await applyExplicitReview({
      agentQaRoot: input.agentQaRoot,
      knowledgeRoot: input.knowledgeRoot,
      request: input.request,
      operationId: input.operationId,
      opId: input.opId,
      executionContext: input.executionContext,
      resolveBundleShortId: (shortId) => ledger.lookupByShortId(shortId)?.machineId,
      ...(input.resolveTrustPriors === undefined ? {} : { resolveTrustPriors: input.resolveTrustPriors }),
      ...(input.delegate === undefined ? {} : { delegate: input.delegate }),
      ...(input.writerAuthority === undefined ? {} : { writerAuthority: input.writerAuthority }),
    })
  } finally {
    ledger.close()
  }
}

// ---- entities: the addressing ledger and the tier-(a) resolver (387 D-01/D-02/D-09) ----------

export interface CreateEntityDirectoryInput {
  readonly agentQaRoot: string
  readonly resolveKnowledgeRoot: () => Promise<string> | string
}

/**
 * Bind the entity directory over this host's durable addressing ledger.
 *
 * The ledger file is opened PER CALL and closed again, and both halves of that are deliberate.
 *
 * Opened per call, because the ledger is a durable file under the agent-qa root: opening it
 * eagerly at composition time would bring an `entity-addresses.db` into existence in a project
 * that has never resolved anything, and `agent-qa fn --list` is exactly such a caller. This is
 * the same law the job store's deferred `jobs()` handle carries, expressed for a port that has
 * no handle to defer.
 *
 * Closed again, because minting is LEASE-FREE by design (D-02) — the CLI must mint with no
 * daemon running, so several processes hold this file at once and sqlite arbitrates through
 * WAL and the busy timeout. A connection kept open for the life of a composition would hold a
 * reader open across a caller's whole session for no gain; the transactions here are single
 * statements at a human-paced grain.
 *
 * The path is resolved HERE rather than inside `knowledge-local`, beside `agent-jobs.db`, so
 * the package that owns the runtime root is the package that names its files.
 */
export function createEntityDirectory(input: CreateEntityDirectoryInput): EntityDirectoryPort {
  return {
    resolve(ref) {
      return withEntityResolutionDeps(input, (deps) => resolveEntityRef(ref, deps))
    },
    get(ref) {
      return withEntityResolutionDeps(input, (deps) => getEntityDescriptor(ref, deps))
    },
  }
}

/**
 * The D-01 LIST-VERB sighting site (387 plan 06).
 *
 * Lives beside the entity directory rather than inside the read port, because minting reaches
 * the durable addressing ledger through the writer-gated package entry, and the file that
 * binds the read verbs is held to the reader subpath by the arch carve-out. So the read port
 * is handed this callback and never a ledger.
 *
 * It goes through `sightEntity` — the resolver's OWN sighting leg — and not through a local
 * mint. D-01 names four sighting sites and a second minting path written for the fourth is a
 * second place where "first sighting mints, idempotently, and projects into the entity index"
 * could stop being true with nothing comparing the two. `resolveEntityRef` is deliberately NOT
 * what is called here: it would fall through to the hybrid tiers on an id no source recognises
 * (a purged record's id, say), running a retrieval to answer a question nobody asked.
 *
 * One ledger span for the whole batch. A listing surfaces every bundle at once, and opening the
 * two databases per row would turn a human-paced review verb into N open/close cycles.
 */
export function createMemorySightingHook(
  input: CreateEntityDirectoryInput,
): SightMemoryEntities {
  return (bundleIds) => withEntityResolutionDeps(input, (deps) => {
    for (const bundleId of bundleIds) sightEntity(bundleId, deps)
  })
}

/**
 * Open the addressing ledger and the entity-index projection for ONE span, run `body`, close.
 *
 * Shared by the directory port and the list-verb sighting hook so both obey the same open/close
 * law rather than two copies of it.
 */
async function withEntityResolutionDeps<T>(
  input: CreateEntityDirectoryInput,
  body: (deps: ResolveEntityRefDeps) => T | Promise<T>,
): Promise<T> {
  const knowledgeRoot = await input.resolveKnowledgeRoot()
  const ledger = openAddressingLedger({
    path: join(input.agentQaRoot, ADDRESSING_LEDGER_DB_FILE),
  })
  // The D-06 projection is opened beside the ledger and for the same span. It lives under
  // the KNOWLEDGE root rather than the agent-qa root because it is derived from knowledge
  // the same way the memidex index is, and it is disposable in exactly that sense — while
  // the ledger, one directory tree away, is the thing that must never be rebuilt.
  const entityIndex = openEntityIndex({ path: entityIndexDbPath(knowledgeRoot), knowledgeRoot })
  try {
    // AWAITED inside the try, not returned from it: tier (b)'s dense leg is asynchronous, so
    // returning the promise would close both databases while the resolution was still using
    // them. The bug is invisible while every caller is synchronous, which is exactly why it
    // is worth the word.
    return await body({
      ledger,
      entityIndex,
      // One kind is wired by the tracer. 387-03 registers the remaining sources here and
      // neither the resolver nor the ops change — which is the property the tracer exists
      // to establish before anything expands.
      sources: [createMemorySightingSource(() => knowledgeRoot)],
    })
  } finally {
    entityIndex.close()
    ledger.close()
  }
}

export interface SweepEntityIndexInput extends CreateEntityDirectoryInput {
  /**
   * Test seam ONLY. Production omission runs the real acquisition ladder, which is what makes
   * the dense rung appear on hosts that have a model and stay absent on hosts that do not.
   */
  readonly acquireEmbedderCapability?: typeof acquireEmbedder
}

export interface SweepEntityIndexOutcome extends EntityIndexSweepReport {
  /** How many renderings gained a vector this sweep. Zero on a floor host, by design. */
  readonly embedded: number
}

/**
 * The daemon's maintenance-cadence sweep over the D-06 projection.
 *
 * Three properties, and each is a deliberate refusal rather than an omission:
 *
 *  - it takes NO writer lease. Everything it writes lives in the entity index's own file, and
 *    a projection that needed the lease could not be maintained by a host that does not hold
 *    one — which is every one-shot CLI process.
 *  - it never writes the addressing ledger. It READS the ledger to know what exists (D-02: the
 *    ledger is the durable truth, not a projection) and writes only the rendering of it.
 *  - it embeds only what a host can already embed. `acquireEmbedder` with no download is the
 *    same ladder the retrieval legs ride: ready means the dense rung joins the resolver on this
 *    host, and anything else leaves the projection lexical-only rather than blocking the sweep.
 */
export async function sweepEntityIndexProjection(
  input: SweepEntityIndexInput,
): Promise<SweepEntityIndexOutcome> {
  const knowledgeRoot = await input.resolveKnowledgeRoot()
  const ledger = openAddressingLedger({
    path: join(input.agentQaRoot, ADDRESSING_LEDGER_DB_FILE),
  })
  const entityIndex = openEntityIndex({ path: entityIndexDbPath(knowledgeRoot), knowledgeRoot })
  try {
    const report = sweepEntityIndex(entityIndex, describeAllEntities({
      ledger,
      sources: [createMemorySightingSource(() => knowledgeRoot)],
    }))

    let embedded = 0
    const acquire = input.acquireEmbedderCapability ?? acquireEmbedder
    const capability = await acquire({
      preferredProfile: DEFAULT_EMBEDDING_PROFILE,
      allowDownload: false,
      agentQaRoot: input.agentQaRoot,
    })
    if (capability.kind === 'ready') {
      embedded = await embedPendingEntities(
        entityIndex,
        capability.embedder,
        capability.profile,
      )
    }
    return { ...report, embedded }
  } finally {
    entityIndex.close()
    ledger.close()
  }
}

// ---- runs.start: the composition's binding (D-16) ---------------------------------------------

/**
 * The host's run-execution capability: run this request to completion, and say which run it was.
 *
 * A PORT rather than shared code, by the plan-08 dissection rule. Would a headless drainer
 * execute a suite the way a terminal host does? It would substitute — the process model
 * (in-process, a child, a worker pool), the signal handling, the reporters and the exit
 * discipline are all decisions the host owns and answers differently. What crosses into the
 * composition is the type; what stays with the host is the orchestration.
 *
 * The verb resolves the IDENTITY of the run and nothing else. Anything richer would be the
 * host telling the composition what happened, and the whole point of the binding below is
 * that the composition does not take the host's word for it.
 */
export interface RunExecutionPort {
  /**
   * 2026-10-01 (432-18, D-15): the optional `gate` argument (401-08, D-08) carried the standing
   * approvals in force — the durable ledger's answer unioned with any dispatch-scoped grant — to a
   * run gate behind the port. The run gate went in 432-13 and the ledger and the dispatch overlay
   * go in 432-18, so a host is handed the request and nothing else.
   */
  execute(request: RunsStartInput): Promise<StartedRun>
}

/**
 * The run this host reported did not leave a durable event log behind.
 *
 * The composition's evidence check, and the reason `runs.start` cannot be satisfied by a host
 * that returns a plausible run id without running anything. The v49 bus writes `runStarted`
 * before anything else can happen, so a run that began at all has a non-empty log; an empty
 * one means no run took place under that id. Read through {@link buildRunPorts} — the same
 * `FsEventLog` family the runner appends with — so what is inspected is the run's own record
 * rather than a path this file re-derives.
 */
export class RunProducedNoEventsError extends Error {
  constructor(readonly runId: string) {
    super(
      `The host reported run ${runId}, but no run events were recorded for it. ` +
        'A run that started at all writes runStarted before anything else, so an empty ' +
        'event log means no run took place under that id.',
    )
    this.name = 'RunProducedNoEventsError'
  }
}

/**
 * Bind `runs.start` over a host's run execution.
 *
 * The composition contributes the half a host must not be trusted with: after the host says a
 * run happened, the run's own durable event log is read back and an empty one is refused. The
 * op then builds its acknowledgment from the completed-run record through the SAME reader
 * `runs.get` answers from, so "the run is real" and "the run is addressable" are one fact.
 */
export function createLocalRunInvocation(input: {
  readonly agentQaRoot: string
  readonly execution: RunExecutionPort
}): RunInvocationPort {
  return {
    async start(request: RunsStartInput): Promise<StartedRun> {
      const started = await input.execution.execute(request)
      const { eventLog } = buildRunPorts({
        configDir: dirname(input.agentQaRoot),
        runId: String(started.runId),
      })
      if (eventLog.read(0).length === 0) {
        throw new RunProducedNoEventsError(String(started.runId))
      }
      return started
    },
  }
}

// ---- authoring.draft.verify: the keep-gate evaluator's binding (393 D-01 / D-15) --------------

/** The stable test identity, spelled once for this binding. */
interface DraftIdentity {
  readonly filePath: string
  readonly testName: string
}

/**
 * A parsed draft, as the HOST hands it over.
 *
 * Structurally identical to `packages/agent`'s `ParsedDraftLike`, and mirrored here rather than
 * imported for the reason every mirror in this graph exists: that type lives inside `agent`'s
 * `authoring/` and is not on its barrel, and publishing it to give a composition a name would put
 * a gate-orchestration type on the surface that publishes exactly one dispatch.
 *
 * `filePath` MUST be the workspace-relative identity the runner records on
 * `PerTestOutcome.filePath` — `workspaceRelativeIdentityPath`, the one spelling of that recipe.
 * Gates 1-2 find the draft's own member inside each run document by comparing against those bytes,
 * so a path spelled any other way makes every gate-run report `absent` for its own draft and gate
 * 1 fail for a join reason wearing a draft reason's clothes.
 */
export interface ParsedDraftDescriptor {
  readonly testId: string
  readonly filePath: string
  readonly testName: string
  /**
   * The parsed test's `target`. REQUIRED, exactly as `ParsedDraftLike.target` and
   * `TestDefinitionSchema` require it (394-37, WR-04).
   *
   * A mirror that dropped it would hand `packages/agent` a draft whose target the compile stage
   * cannot check against the vocabulary it just served — and the cost of not checking is paid as
   * real child gate runs on a name `resolveTarget` throws on, against a key no repair patch may
   * edit.
   */
  readonly target: string
  readonly steps: readonly string[]
  /**
   * The parsed test's `context` block — an EDITABLE root, and therefore one the credential gate
   * scans. Structurally identical to `ParsedDraftLike.context`; a mirror that dropped it would
   * hand `packages/agent` a draft whose context can no longer be screened.
   */
  readonly context?: string
  readonly contentDigest: string
}

/**
 * What a host can say about a caller-supplied draft path.
 *
 * Four refusal arms and one success, because `packages/agent` is `storageNeutral` and genuinely
 * cannot answer any of them: it can neither stat a path nor know where the workspace ends. The op
 * turns each arm into its own NAMED error, so the refusal a caller catches is declared beside the
 * capability while the syscall stays with the host that owns a filesystem (T-393-01).
 */
export type DraftParseOutcome =
  | { readonly kind: 'parsed'; readonly draft: ParsedDraftDescriptor }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-a-file' }
  | { readonly kind: 'outside-workspace' }
  | { readonly kind: 'unparsable'; readonly reason: string }

/** One authored suite test as TEXT, for gate 3's degraded lane (D-16). */
export interface SuiteTextEntry {
  readonly filePath: string
  readonly testName: string
  readonly stepsText: readonly string[]
}

/**
 * The host's authoring capability: parse ONE draft, and enumerate the authored-test universe.
 *
 * BOTH VERBS OR NEITHER, and the bundling is a report rather than a convenience. A host that
 * supplied only the parse would bind a capability whose gate-3 text lane is permanently empty —
 * evidence-less suite tests would silently stop joining the comparison, and a draft would look
 * novel purely because whatever it duplicates has never been run. That is D-16's unsafe direction
 * arrived at by omission, and the only way to make it un-omittable is to make the two arrive
 * together.
 *
 * Both verbs live at the HOST because both need `parseTestFile` from `@vostride/agent-qa-core`,
 * which neither this package nor `agent` may import (the FUNC-02 firewall) — the parse-at-host
 * precedent `cli/src/curation/authoring-test-discovery.ts` established.
 */
export interface DraftAuthoringPort {
  parseDraft(filePath: string): Promise<DraftParseOutcome>
  suiteTextCorpus(): Promise<readonly SuiteTextEntry[]>
  /**
   * 394-33 · WR-07: the names a `target` may legally take in this project.
   *
   * ON THIS PORT for the reason `deriveDefaultScope` is: both hosts build their authoring
   * capability from ONE factory, so a verb that lives here is reached by the CLI `fn` surface and
   * the chat/daemon host without a second binding either could forget. A vocabulary served by only
   * one of the two hosts would make "does stage 3 guess at `target`" depend on which surface a
   * person happened to author from.
   *
   * IT ENUMERATES AND NEVER REFUSES — the opposite posture to `deriveDefaultScope` right below it,
   * which throws when the answer is not unique. There is no such thing as an ambiguous list, and a
   * project declaring no targets has an honest empty answer rather than a failure.
   */
  configuredTargetNames(): Promise<readonly string[]>
  /**
   * 394-26 · WINDOWS 110: which scope this project authors for, when the caller named none.
   *
   * ON THIS PORT rather than beside it, and that placement is the guarantee. Both hosts build
   * their authoring capability from one factory, so a verb that lives here is reached by the CLI
   * `fn` surface and the chat/daemon host without a second binding either could forget — which is
   * what makes "there is ONE derivation" a fact about the wiring rather than a convention.
   *
   * IT THROWS RATHER THAN ANSWERING `undefined` when the project has no unique product: the host
   * is the only side that knows which candidates it saw, and a refusal that cannot name them
   * leaves an author with no way to write the `scope` that would have worked.
   */
  deriveDefaultScope(): Promise<ScopeKey>
  /**
   * 394 D-01 · WTST-01: PARSE the compiled draft, then WRITE it to the shelf — in that order, as
   * one verb, joining for exactly the reason the two above bundle.
   *
   * ONE VERB AND NOT TWO, because the order is the mitigation (T-394-06). Model-authored YAML is
   * the one input on the authoring path that no schema at the op boundary can vet, and separate
   * verbs would let a caller write first and discover the parse failure afterwards — with bytes
   * already on this workspace's disk. Here an unparsable draft answers `unparsable` having
   * created nothing at all.
   *
   * THE DIGEST IS THE HOST'S, over the bytes it is writing, and it is the caller's only
   * addressing: the shelf path is minted from it, so nothing the model emitted reaches the
   * filesystem as a path component. `DraftRef.contentDigest`'s whole promise — a later edit
   * cannot inherit an earlier receipt — is only true while the digest is over what was stored.
   */
  stageDraft(contents: string): Promise<DraftStageOutcome>
  /**
   * 394-06 D-09/D-20: apply an RFC-6902 patch set to a staged draft and stage the result.
   *
   * AT THE HOST for the same reason its two neighbours are: `applyPatchSetToTestDoc` needs the
   * yaml CST from `@vostride/agent-qa-core`, which neither this package nor `agent` may import.
   * It answers the same `DraftStageOutcome`, so a patch that renders an unrunnable document is
   * refused with the shelf untouched rather than written and discovered later.
   */
  applyPatchesToDraft(
    draft: ParsedDraftDescriptor,
    patchSet: TestEditPatchSet,
  ): Promise<DraftStageOutcome>
  /**
   * 432 D-06/D-07: write a staged draft's bytes to its test path — the direct final-test writer.
   *
   * AT THE HOST for its neighbours' reason: the workspace identity mint lives in
   * `@vostride/agent-qa-core`. The host checks the boundary and that the target still holds the
   * bytes the caller read (absent for a new test), writes through a sibling temp and a rename, runs
   * no git, and answers `not-written` with its reason whenever the bytes did not land.
   */
  publishDraft(request: DraftPublishRequest): Promise<TestFileWrite>
}

/** One draft to write: its shelf path, its target, and what the target held when it was read. */
export interface DraftPublishRequest {
  readonly draftPath: string
  readonly targetPath: string
  readonly sourceDigest?: string
}

/**
 * What staging produced: a parsed draft that IS on the shelf, or a refusal that wrote nothing.
 *
 * Structurally the mirror of `agent`'s `DraftStageOutcome`, on this file's own mirror discipline
 * — that type lives inside `agent`'s `authoring/` and the value crossing this seam is assignable
 * to it unchanged.
 */
export type DraftStageOutcome =
  | { readonly kind: 'staged'; readonly draft: ParsedDraftDescriptor }
  | { readonly kind: 'unparsable'; readonly reason: string }

/** The suite comparison, materialized once per evaluation. */
interface FingerprintSnapshot {
  readonly union: ReadonlySet<string>
  readonly covered: readonly DraftIdentity[]
  readonly elements: ReadonlyMap<string, readonly string[]>
}

const EMPTY_FINGERPRINT_SNAPSHOT: FingerprintSnapshot = {
  union: new Set<string>(),
  covered: [],
  elements: new Map<string, readonly string[]>(),
}

/**
 * The identity as one comparable key.
 *
 * The separator is written as the ESCAPE `\u0000`, never as a raw control byte in this source.
 * 393-05 and 393-06 each shipped a module carrying a literal control byte and `file(1)` classified
 * both `data`, so every `grep` over them reported nothing — a false CLEAN verdict from the exact
 * instrument this phase's posture checks are made of. A separator is still needed, because
 * concatenation alone lets ("ab", "c") and ("a", "bc") collide.
 */
function draftIdentityKey(identity: DraftIdentity): string {
  return `${identity.filePath}\u0000${identity.testName}`
}

/**
 * Read the suite's fingerprints for one product, EXCLUDING the draft's own identity.
 *
 * THE UNION IS FOLDED FROM THE PER-TEST VERBS rather than read from `elementUnion()`, and that is
 * the whole reason this function exists. A draft is very often an EXISTING test — "is this one
 * still worth keeping?" is D-01's standalone value — so its own rows are in the table, and
 * `elementUnion()` would hand back a set already containing everything the draft exercises. Gate 3
 * would then find nothing novel and reject every test that has ever run, which is the mirror of
 * the defect 393-06 found on the other side: a gate that cannot say yes is as useless as one that
 * cannot say no. The exclusion is applied to `coveredTests()` and the union is folded from what
 * survives, so both of gate 3's lanes see the same suite and neither compares the draft to itself.
 *
 * A missing database, a store predating the projection, and a product with no rows all answer the
 * EMPTY snapshot, which gate 3 reads as an uncovered suite. Any other read failure propagates: a
 * corrupt index is not an empty suite.
 */
function readSuiteFingerprints(
  knowledgeRoot: string,
  product: string,
  draft: DraftIdentity,
): FingerprintSnapshot {
  const path = indexDbPath(knowledgeRoot)
  if (!existsSync(path)) return EMPTY_FINGERPRINT_SNAPSHOT
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const index = createSuiteFingerprintIndex(db, { product })
    const draftKey = draftIdentityKey(draft)
    const covered = index
      .coveredTests()
      .filter((identity) => draftIdentityKey(identity) !== draftKey)
    const elements = new Map<string, readonly string[]>()
    const union = new Set<string>()
    for (const identity of covered) {
      const own = index.elementsForTest(identity.filePath, identity.testName)
      elements.set(draftIdentityKey(identity), own)
      for (const element of own) union.add(element)
    }
    return { union, covered, elements }
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) {
      return EMPTY_FINGERPRINT_SNAPSHOT
    }
    throw error
  } finally {
    db.close()
  }
}

interface DraftEvaluationBindingInput {
  readonly authoring: DraftAuthoringPort
  readonly agentQaRoot: string
  readonly knowledgeRoot: () => Promise<string> | string
  /** The SAME reader `runs.get` answers from — see below. */
  readonly readRun: (runId: string) => Promise<CompletedRunHandoff | undefined>
  /** Dispatch one gate-run through the REAL `runs.start` op (D-02, op-calls-op). */
  readonly startGateRun: (request: RunsStartInput) => Promise<RunStartAcknowledgement>
  /**
   * The funnel's read bundle, handed straight through for D-14's gate-2 consultation (394-17).
   *
   * THE SAME OBJECT the `authoring.funnel.get` op binds. This evaluation does not read a second
   * projection: it asks the one this composition already answers "what does this project know
   * about this suite" with.
   */
  readonly authoringFunnel: AuthoringFunnelPortLike
}

/**
 * Bind `authoring.draft.verify` over this host's capabilities (385 D-15).
 *
 * WHAT IS ASSEMBLED HERE, and why each piece is where it is:
 *
 *   `runs.start` is reached as an OP, not as a port (D-02). The evaluator confirms a gate-run by
 *   reading both markers off the ACKNOWLEDGMENT, and `runs.start` is the one function that copies
 *   them from the run's own durable record instead of echoing the request. Binding the raw
 *   invocation port instead would have meant re-deriving an acknowledgment here — a second
 *   spelling of a contract that op already owns, free to disagree with it about exactly the fact
 *   the confirmation turns on. It also means every gate-run crosses the policy gate and lands in
 *   the execution audit, which is T-393-09's stated mitigation rather than a side effect.
 *
 *   `runs.get` is reached as the READER and not as the op, because that op projects a `RunDetail`
 *   and gates 1-2 need the completed-run HANDOFF: the per-step sub-action evidence gate 3's
 *   fingerprint is minted from does not survive the projection. This is `runs-start.ts`'s own
 *   posture verbatim — its acknowledgment is built "through the SAME reader `runs.get` answers
 *   from" — applied one layer out.
 *
 *   THE PRODUCT IS OBSERVED, NEVER DERIVED. `createSuiteFingerprintIndex` requires the partition
 *   the fold wrote under, which is `slugBranch(scope.key)` of the run's own scope. Deriving it
 *   here from configuration would be a SECOND rule for a fact the write side already decides, and
 *   the first time the two disagreed a draft would be measured against an empty suite and pass
 *   gate 3 for free. So it is read off the first acknowledgment this evaluation receives — and
 *   since D-04 forbids short-circuiting, gates 1-2 have always taken at least one run by the time
 *   gate 3 asks the index anything. The index is opened LAZILY for exactly that reason, and once:
 *   three verbs against one snapshot, one connection, closed before gate 3 reads a byte of it.
 */
function createDraftEvaluation(input: DraftEvaluationBindingInput) {
  return {
    resolveDraft(draftPath: string): Promise<DraftParseOutcome> {
      return input.authoring.parseDraft(draftPath)
    },
    async openEvaluation(draft: ParsedDraftDescriptor) {
      const knowledgeRoot = await input.knowledgeRoot()
      const draftIdentity: DraftIdentity = {
        filePath: draft.filePath,
        testName: draft.testName,
      }
      const draftKey = draftIdentityKey(draftIdentity)
      // The authored universe MINUS the draft itself. Handed its own bytes to compare against,
      // the text lane scores 1.0 and reads the draft as already covered — by itself.
      const textCorpus = (await input.authoring.suiteTextCorpus()).filter(
        (entry) => draftIdentityKey(entry) !== draftKey,
      )

      let observedProduct: string | undefined
      let snapshot: FingerprintSnapshot | undefined
      const fingerprints = (): FingerprintSnapshot => {
        if (snapshot !== undefined) return snapshot
        snapshot = observedProduct === undefined
          ? EMPTY_FINGERPRINT_SNAPSHOT
          : readSuiteFingerprints(knowledgeRoot, observedProduct, draftIdentity)
        return snapshot
      }

      return {
        runs: {
          async start(request: RunsStartInput): Promise<RunStartAcknowledgement> {
            const acknowledgement = await input.startGateRun(request)
            observedProduct ??= slugBranch(acknowledgement.scope.key)
            return acknowledgement
          },
          get: (runId: string) => input.readRun(runId),
        },
        fingerprints: {
          elementUnion: () => fingerprints().union,
          coveredTests: () => fingerprints().covered,
          elementsForTest: (filePath: string, testName: string) =>
            fingerprints().elements.get(draftIdentityKey({ filePath, testName })) ?? [],
        },
        textCorpus,
        // D-19: the gitignored per-draft receipt store, bound over `agentQaRoot` beside the
        // proposals inbox and for its reason — a receipt is machine-local working state under the
        // runtime root, not a committed artifact a pull request has any business showing.
        receipts: createDraftReceiptsStore({ resolveAgentQaRoot: () => input.agentQaRoot }),
        // D-14's live arm (394-17, step c). `product` is the SAME `observedProduct` gate 3's index
        // is opened against — read off the first gate-run acknowledgment, never derived from
        // configuration — so the stability read and the suite index can never be asking about two
        // different applications. Before any run is acknowledged it is `undefined` and the
        // consultation is skipped; D-04 forbids short-circuiting, so a flip cannot be observed
        // until at least one run has been.
        suiteStability: {
          port: input.authoringFunnel,
          product: () => observedProduct,
        },
      }
    },
  }
}

/**
 * The caller every gate-run is dispatched as (D-02, op-calls-op).
 *
 * MINTED HERE, on the rule every caller in this file is under: the composition says who a call is
 * on behalf of. `origin: agent` because nobody typed this run: a person asked for a draft to be
 * verified, and the runs that answer that are the system's own doing.
 *
 * 2026-10-01 (432-20/432-21, D-12): no scope set and no safe-mode flag. The two scopes this caller
 * held were exactly `authoring.draft.verify`'s declared ones, so a nested call could not widen what
 * the outer caller was granted; with no scope checked anywhere there is nothing to widen.
 */
const AUTHORING_GATE_RUN_CALLER: FunctionCaller = Object.freeze({
  surface: 'authoring',
  origin: 'agent',
})

/**
 * The caller the authoring loop's stage 4 dispatches `authoring.draft.verify` as (394 D-01,
 * op-calls-op · T-394-05).
 *
 * There is no second minted caller for `runs.start` / `runs.get`, and its absence is the design
 * rather than an omission. The loop takes no run of its own: every gate-run is started INSIDE
 * `authoring.draft.verify`, which already dispatches it on {@link AUTHORING_GATE_RUN_CALLER}
 * above.
 *
 * `origin: agent` for the reason the gate-run caller is: a person asked for a test to be written,
 * and the verification that answers it is the system's own doing. 2026-10-01 (432-20/432-21,
 * D-12): the narrowed scope pair this caller carried — the callee's own `requiredScopes`, asserted
 * against the spec — is deleted with the scope check it was narrowing for.
 */
const AUTHORING_LOOP_VERIFY_CALLER: FunctionCaller = Object.freeze({
  surface: 'authoring',
  origin: 'agent',
})

/** Wall-clock in the one format every store column and dump row is written in. */
export const SYSTEM_CLOCK: ClockPort = Object.freeze({
  now: (): string => new Date().toISOString(),
})

/**
 * Job ids are derived from `(kind, idempotencyKey)` rather than minted at random, so two hosts
 * enqueuing the same logical work address the same row and the store's unique index has something
 * stable to deduplicate on.
 */
const digestJobIdSource: JobIdSource = {
  jobIdFor: (kind, idempotencyKey) =>
    asJobId(`job_${sha256hex16(`${kind} ${idempotencyKey}`)}`),
}
export const DIGEST_JOB_ID_SOURCE: JobIdSource = Object.freeze(digestJobIdSource)

/**
 * The durable half of the host, opened on demand.
 *
 * `store` is the concrete sqlite store rather than the neutral port: the host that opened the
 * database is the one entitled to close it and to take the D-03 logical dump, and both verbs live
 * on the implementation. Nothing else in the package publishes it.
 */
export interface LocalAgentJobs {
  readonly queue: AgentJobQueue
  readonly store: SqliteJobStore
  readonly kinds: JobKindRegistry
  /** The capability the queue was constructed with, exposed so a host can assert what it bound. */
  readonly model: JobModelCapability
  /**
   * The id source the queue was constructed with.
   *
   * Exposed because a caller that watches this queue's outcomes must be able to derive the same
   * ids the enqueue addressed — the push half of a run's chip trail and the pull half of its
   * status have to agree about which rows belong to which run. Publishing the SOURCE makes that
   * agreement structural; re-deriving a default at the call site would make it a convention, and
   * a convention is exactly what breaks the first time a host is composed with a different one.
   */
  readonly idSource: JobIdSource
  /**
   * The kind exclusion the queue was constructed with, resolved from
   * `UNCLAIMABLE_BY_PROSE_POSTURE` and published for the same stated reason `idSource` is:
   * a caller that must assert what its queue was constructed with should read the value
   * rather than re-derive a default. Empty when the host declared `'masker-active'` or was
   * composed with no `postRun` at all.
   */
  readonly unclaimableKinds: readonly JobKind[]
}

/** Refusal returned when durable capabilities are requested after their composition was closed. */
export class LocalAgentClosedError extends Error {
  override readonly name = 'LocalAgentClosedError'

  constructor(readonly agentQaRoot: string) {
    super(
      `The local agent composition for ${agentQaRoot} is closed. A closed composition cannot `
      + 'reopen its job store; create a new composition with fresh lifecycle ownership instead.',
    )
  }
}

export interface LocalAgentHost {
  /** The 384 function registry with every seed capability bound over local storage. */
  readonly registry: FunctionRegistry
  /**
   * The live chat session composed beside the registry (392 plan 08).
   *
   * Present on EVERY host, because the turn engine is (D-24) — a host whose chat session were
   * optional would make `agent.ask` bound and its state absent, which is two answers to whether
   * this host can hold a conversation.
   */
  readonly chat: LocalAgentChatSession
  /** The knowledge-writer powers this host grants — the same frozen object for every host. */
  readonly curation: LocalCurationCapabilities
  /** The clock every store column, dump row and audit stamp in this host is written against. */
  readonly clock: ClockPort
  /**
   * Open (once) the durable job queue and its sqlite store over this host's runtime root.
   *
   * A method rather than an eager member, and the reason is a behaviour rather than a taste:
   * constructing the store CREATES `<agentQaRoot>/agent-jobs.db` and the checkpoint directory. A
   * host that only lists the registry — `agent-qa fn --list` is exactly that — would otherwise
   * bring a queue database into existence in a project that has never enqueued anything. Repeated
   * calls return the same instance, so "opened once" is a property of the handle and not of the
   * caller's discipline.
   */
  jobs(): Promise<LocalAgentJobs>
  /** Close whatever was opened and join an open already in flight. Idempotent. */
  close(): Promise<void>
}

/**
 * What a host's curation binding does with candidate prose (388-10, UF-388-01 / D-11).
 *
 * A closed union, REQUIRED wherever `postRun` is supplied: a host that cannot say what its
 * fold does with candidate prose has not been reviewed for UF-388-01, and the typechecker is
 * what makes that review mandatory rather than customary.
 *
 * - `'masker-active'` — the fold has the declared-secret mask bound (441-01 decision 10), or the
 *   binding never reaches candidate emission at all.
 * - `'no-masker'` — the binding folds with NO declared mask. A statement about DISCLOSURE, not
 *   about capability: the fold would run, but its prose masking would degrade to a pass-through,
 *   so a host declaring this may not claim the kind that runs it.
 */
export type CandidateProsePosture = 'masker-active' | 'no-masker'

/**
 * The chain kinds a host of each posture MAY NOT CLAIM — one table, no second spelling.
 *
 * A `Record` over the union rather than a condition, deliberately: this phase's named defect
 * class is a guard whose input domain is written in prose while the code ranges over a
 * subset, and a total `Record` stops compiling the day a third posture is added. The queue's
 * `unclaimableKinds` is derived from this table and from nothing else.
 */
export const UNCLAIMABLE_BY_PROSE_POSTURE: Record<CandidateProsePosture, readonly JobKind[]>
  = Object.freeze({
    // Frozen to the same depth it is read at (WR-11). The shallow freeze every sibling table
    // here uses is not enough for this one: the VALUES are the arrays the queue claims
    // against, so an unfrozen inner array is a writable disclosure guard reachable from any
    // module that can import the table.
    'masker-active': Object.freeze([]),
    'no-masker': Object.freeze(['curate-memory'] as const),
  })

export interface ComposeLocalAgentInput {
  // 2026-10-14 (441-55, 441-16, D-06): the declared-secret mask for chat projections and run reads.
  readonly mask: MaskFn
  /** Immutable neutral data resolved by the host, reused until recomposition. */
  readonly resolveTrustPriors?: CreateLocalKnowledgeStoreConfig['resolveTrustPriors']
  readonly feedback?: FeedbackPort
  /**
   * 423 D-19/D-16: read-only mark history and consequence preview; absent leaves runs.marks.history
   * and runs.mark.preview unbound by name, and a port without `preview` leaves only the preview unbound.
   */
  readonly feedbackReads?: FeedbackReadsPort
  /** The project's runtime root, i.e. `<configDir>/.agent-qa`. Absolute. */
  readonly agentQaRoot: string
  /**
   * Masked configuration reads. Injected because flattening and masking a resolved configuration
   * needs the host's own loader — its file layering, its environment, its plugin policy — and the
   * masking decision is a disclosure boundary the host owns (T-384-07 / T-384-17).
   */
  readonly config: ConfigReaderPort
  /** Resolves the knowledge root this invocation serves from. See `createKnowledgeReader`. */
  readonly knowledgeRoot: () => Promise<string> | string
  /**
   * The model a job may author with (D-10, plan 05).
   *
   * A required factory. REQUIRED because the queue's own `model` option is required and not
   * defaultable — an optional capability means a queue can be built with none, and the only place
   * to discover that is inside an author callback far from the composition that forgot it. A
   * FACTORY because `jobs()` is deferred, and resolving a provider handle costs a configuration
   * read and an auth resolution that a host listing the registry must not pay.
   *
   * It is called at most once, when the queue is opened. `agent-local` never constructs a model:
   * its ownership contract forbids provider invocation, so the handle arrives already built and no
   * provider name is named here.
   */
  readonly model: () => JobModelCapability | Promise<JobModelCapability>
  /**
   * How this host executes a run (D-16). OPTIONAL, and the optionality is the reporting
   * mechanism rather than a convenience: a host that supplies it lists `runs.start` as
   * `bound` and can run it; a host that does not lists the same capability as `unbound` and
   * refuses it by name. Not every composition can start a run — a listing, a read-only
   * surface, 386's daemon before it wires an executor — and D-09 requires that to be a
   * visible state rather than a call that fails somewhere far from the composition.
   */
  readonly runExecution?: RunExecutionPort
  /**
   * How this host parses a draft and enumerates its authored suite (393 D-01), on the exact
   * optional-operation idiom `runExecution` above uses.
   *
   * OPTIONAL, and — like its neighbour — the optionality is the reporting mechanism rather than a
   * convenience. `authoring.draft.verify` is bound only where this AND `runExecution` are both
   * present, because a host that cannot parse a test file and a host that cannot start a run are
   * both hosts that cannot verify a draft. Either one missing lists the capability `unbound` BY
   * NAME, which is the honest answer; the alternative is a receipt whose four booleans were
   * computed from no runs at all, and a refusal wearing a verdict's clothes is the one answer that
   * could get a draft kept on the strength of nothing.
   *
   * Host-supplied for the reason `mintQuarantineIdentityPath` is: it needs `parseTestFile` and the
   * CHECKOUT ROOT, and neither this package nor `agent` may name `@vostride/agent-qa-core`.
   */
  readonly draftAuthoring?: DraftAuthoringPort
  // 432-16 (D-07): `draftApply`, `configApply` and `configUndoSource` are gone from this input. They
  // were the one-commit test-draft apply, the one-commit config apply and the git-history read the
  // config undo proposed from; agent-qa makes no git commits, so no host supplies them and the
  // pre-432 verbs that named them answer unbound until 432-17 deletes the verbs.
  /**
   * 395-01 D-03/D-17 · CFGM-01/04: the committed config file SET as RAW BYTES, plus the
   * comment-preserving field edit over them.
   *
   * Host-supplied because the edit is `yaml`'s Document API, and neither this package nor `agent`
   * may name that dependency under their ownership contracts. The CLI host already depends on it and already owns the file format.
   */
  readonly configFiles?: ConfigFilesPortLike
  /**
   * 395-01 CFGM-01: whole-config validation, run BEFORE a proposal surfaces.
   *
   * Host-supplied because `AgentQaConfigSchema` lives in `@vostride/agent-qa-core`, which neither
   * this package nor `agent` may name — the `mintQuarantineIdentityPath` arrangement exactly.
   */
  readonly configValidate?: ConfigValidatePortLike
  /**
   * 395-08 D-04 · CFGM-05: the shared scaffold CONTENT, rendered by the host that owns it.
   *
   * A SEPARATE OPTIONAL BINDING. The substance lives beside
   * `init`'s own write path in `packages/cli`, which neither this package nor `packages/agent` may
   * import; its absence leaves `config.project.scaffold` — and only that op — unbound, which is the
   * honest catalogue answer for a host that can edit a configuration but cannot create one.
   */
  readonly scaffoldContent?: ConfigScaffoldContentPortLike
  /**
   * 2026-09-30, 432-07 D-05/D-07: the direct config writer. Host-supplied because its transaction
   * is the dashboard's config file transaction, shared per path with the dashboard's own writes.
   */
  readonly configWrite?: FunctionDeps['configWrite']
  /**
   * 2026-08-17 (398 D-09 / D-11 · XPLN-02): the four host halves `agent.explain` needs — the
   * committed capability catalog as data, the model's citation over it, and the two coverage hooks.
   *
   * Host-supplied for the reason `scaffoldContent` is, and the boundary is harder here rather than
   * softer: the artifact is read by `loadCapabilityCatalog` in `packages/cli`, which walks the
   * package root and touches `fs`, and this package is host-neutral. The citation call needs the
   * model the chat host already composed through `createModel`, which is a resolution neither this
   * package nor `packages/agent` may perform. The coverage append is a file write.
   *
   * OPTIONAL, and the absence is the report. A composition that omits it lists `agent.explain`
   * `unbound` BY NAME rather than degrading to a model-only answer — which is the one behaviour
   * XPLN-02 exists to forbid, and the one that would be hardest to notice, because an explain
   * answering from model memory still sounds exactly like an explain.
   */
  readonly capabilityCatalog?: CapabilityCatalogPort
  /**
   * 403 D-03: the live-view mint seam `runs.liveurl` binds through, handed straight through from
   * the host — this composition decides nothing about it.
   *
   * OPTIONAL because the absence is a genuine host fact and not a degradation: a host serving no
   * HTTP origin has no URL it could honestly mint, so the op lists `unbound` BY NAME rather than
   * returning a link that resolves to nothing.
   */
  readonly liveView?: LiveViewPort
  /**
   * 405 D-03: the durable run-detail projection read `runs.detail` binds through, handed straight
   * through from the host — this composition decides nothing about it and constructs no database.
   *
   * OPTIONAL because a host may have no projection to read, and then `runs.detail` lists `unbound`
   * BY NAME. The CLI host binds a reader over the configured or default runs database path whenever
   * its config parses (a read before that file exists answers not recorded in the runs database);
   * the dashboard passes its own handle.
   */
  readonly runDetail?: RunDetailReaderPort
  /**
   * 432-12 (D-05): how a direct knowledge change reaches the writer-lease holder when one is alive,
   * as an OPTIONAL operation on the input bag rather than a new production seam (the 386-41 D-2
   * idiom): `agent-local` cannot name a socket and does not. The CLI host injects a closure
   * over `invokeViaDaemon` that invokes the change op there with the same identity; the daemon's
   * own composition injects nothing, because it holds the lease.
   */
  readonly knowledgeChangeDelegate?: ExplicitReviewDelegate
  /** The writer lease a leaseholding host already owns (387-08 D-18). See `createKnowledgeReview`. */
  readonly resolveWriterAuthority?: () => { readonly leaseId: string; readonly epoch: number } | undefined
  /**
   * Mints the durable workspace-relative identity the quarantine ledger keys `filePath` on
   * (390-12 / D-01). Core's `workspaceRelativeIdentityPath`, pre-bound by the host to its own
   * config directory.
   *
   * Host-supplied for the same reason `resolveWriterAuthority` one field up is: the CHECKOUT ROOT is
   * a fact only a host knows. Neither this composition nor the verbs beneath it can discover it, and
   * a layer that guessed would mint identities against the wrong root.
   *
   * REQUIRED, and — unlike its neighbour — not conditionally spread. The optionality of the writer
   * authority is a real report about a real difference between hosts: one holds the lease, one does
   * not. There is no host that can legitimately lack a checkout root, so an absent mint is not a
   * posture, it is exactly the unvalidated pass-through that let the write verbs author permanently
   * unreadable lines into a committed artifact. It belongs at compile time, at the composition that
   * forgot it.
   */
  readonly mintQuarantineIdentityPath: (filePath: string) => string
  readonly clock?: ClockPort
  readonly idSource?: JobIdSource
  /** The kind registry the queue dispatches through. Defaults to the real declarations. */
  readonly jobKinds?: JobKindRegistry
  /**
   * What the post-run chain's real handlers may do (388 D-01), on the optional-operation
   * idiom `runExecution` and `applyDelegate` already use.
   *
   * OPTIONAL, and the optionality is the report rather than a convenience: a host that
   * supplies it dispatches the REAL analyze-run and curate-memory bodies, and a host that
   * does not keeps the scripted stand-ins. Only `curateRun` is asked for — the handoff read
   * is built here, from `agentQaRoot`, because it is a path derivation this package already
   * owns and a caller-supplied one would be a second layout to keep in step with the writer's.
   *
   * `curateRun` is the caller's because it is not a local concern at all: it needs the writer
   * lease, a knowledge root and the v51 drain, and the CLI's run tail is where all three
   * already meet (plan 02 binds it).
   */
  readonly postRun?: {
    readonly curateRun: PostRunJobCapabilities['curateRun']
    /**
     * REQUIRED beside the binding it describes: a `postRun` that omits it must stop
     * typechecking, because the posture is the UF-388-01 review of this binding and an
     * unreviewed binding is exactly what let the daemon fold unmasked. See
     * `CandidateProsePosture` for what each member does and does not certify.
     */
    readonly candidateProse: CandidateProsePosture
  }
  /**
   * D-01's TokenAccounting substrate for the analyze-run author (389 plan 06). OPTIONAL
   * and host-resolved: both production hosts derive it from the SAME model-profile
   * resolution as the job model itself (one source of truth, no second config surface —
   * 386 D-15), and `composeLocalAgent` only passes the resolved value through. A FACTORY
   * on the exact `model` idiom — resolution may need a configuration read, and it is paid
   * once, at queue open, never by a host that only lists the registry. A factory that
   * answers `undefined` composes the plan-04 no-ladder posture: packs travel whole.
   */
  readonly analysisTokenBudget?: () =>
    | Promise<PostRunJobCapabilities['analysisTokenBudget']>
    | PostRunJobCapabilities['analysisTokenBudget']
  /**
   * The host's execution context for this composition (400-01, D-05).
   *
   * 2026-10-02 (432-39, D-12): it reaches the knowledge review, which records a direct change under
   * it, and nothing else here; the registry option it was also forwarded to is deleted, because no
   * op decides in a context. The history below explains why it is injected per composition.
   *
   * INJECTED RATHER THAN PINNED ON THE PROCESS, and that is the whole reason this field exists.
   * The registry accepted a `resolveExecutionContext` from 384 until 432-39; what it did NOT have
   * was a way for a host to supply one, so the only lever a host had was
   * `setActiveExecutionContextResolver` — a PROCESS GLOBAL. Reaching for it changes the answer
   * for everything composed in that process, including compositions the host does not own, and a
   * host that forgot to restore it leaks its posture into every later caller. The dashboard door
   * is the first host that has to state a posture per composition rather than per process
   * (D-01/D-05: the browser confirm channel is what makes the context interactive, and it is a
   * property of a server, not of the machine), so the injected form is what it binds.
   *
   * ABSENT MEANS THE SHIPPED AMBIENT RESOLVER, unchanged: the knowledge review's own default reads
   * safety's process resolver, so every existing host composes exactly as it did before. This is
   * a passthrough and nothing here decides what a context MEANS. (432-19: `requiresFailClosed`, the
   * gate's reading of a context, is deleted; the four-member vocabulary stays.)
   */
  readonly resolveExecutionContext?: () => ExecutionContext
  /**
   * Notified AFTER one session event has been appended to its log (400-01, D-03).
   *
   * AN OBSERVER, AND EVERY WORD OF THAT IS THE CONTRACT. It is called with an event that is
   * ALREADY ON THE FILE — after `append` resolves, never before and never instead — so a host
   * pushing these somewhere cannot show a person an event the durable log does not carry. It
   * cannot append, cannot rewrite and cannot refuse: the return value is discarded and a throw is
   * swallowed at the notify site, because a surface's push channel failing must not fail the turn
   * that produced the event.
   *
   * WHY THIS AND NOT A HOST-SUPPLIED `SessionLogPort`. The obvious alternative — let a host wrap
   * or replace the log — is exactly what D-04 forbids: sessions belong to the agent, not to a
   * surface, and a replaceable log is a second store one conversation at a time. This seam widens
   * nothing. The log stays the single producer and the single writer; what a host gets is a
   * carbon copy of what was written.
   *
   * The SESSION ID travels with the event because the event itself carries only a `turnId` — the
   * grammar's exact-key guard means it never will carry more (Pitfall 4), so the fact a subscriber
   * needs is supplied beside the record rather than smuggled into it.
   */
  readonly observeSessionEvent?: (sessionId: string, event: ChatSessionEvent) => void
  // 2026-10-01 (432-17, D-05): `mintingSurface` — which door a composition minted proposals as
  // (400-05) — is deleted with the proposal records it stamped. A direct change records no door.
  /**
   * The turn engine's reconciliation strategy (392 D-16).
   *
   * AN INTERNAL COMPOSITION OPTION, and every word of that is load-bearing. It is here so the
   * mutation proof can assemble the REAL host twice — override on, override off — and read the
   * difference off a named compound scenario, which is the only differential that measures what
   * production actually wires (Pitfall 3, the produced-not-literal law).
   *
   * IT IS NOT, AND MUST NEVER BECOME, CONFIG-REACHABLE. No field of `AgentQaConfig` names it and
   * none may: the deterministic override is the mechanism that stops a model's plan from beating
   * a proven mapping, so a production knob that switched it off would be a supported way to
   * disable a safety property. Absent, the shipped strategy is used — which is what makes the
   * absence the safe default rather than an unconfigured state.
   */
  readonly chatReconcile?: ReconcileStrategy
  /**
   * The model stage 2 plans with, ALREADY BUILT by the host through `createModel` (CHAT-06).
   *
   * A model OBJECT and never a model id: the SDK's own type also admits an id it resolves by
   * constructing a client, which would put a provider client behind chat without the masking
   * middleware and the profile resolution `createModel` owns. The type closes that door here.
   *
   * ABSENT IS A REAL POSTURE, NOT AN UNCONFIGURED ONE. A host with no model bound is HEADLESS: any
   * clause the deterministic table cannot resolve fails the turn closed by name (D-08), which is
   * the correct behaviour rather than a degraded one. That is also why no planner is stubbed in —
   * a stub answering "I could not plan that" would say the same words about an entirely different
   * fact, that a model was asked and declined.
   */
  readonly chatModel?: ChatLanguageModel
  /**
   * The accounting instance chat's degrade pass measures against (CHAT-04, plan 06).
   *
   * HOST-RESOLVED and passed through untouched, on `analysisTokenBudget`'s precedent and for its
   * reason: the ceilings must come from the SAME capability resolution as the chat model itself,
   * or a session would compact against a window the model does not have. This composition adds no
   * knob of its own and cannot construct one — `agent-local` reaches no provider.
   *
   * Absent ⇒ no degrade pass runs and the `compaction` seat stays empty, which is the posture
   * every host had before a model was bound.
   */
  readonly chatAccounting?: ChatTokenAccounting
  /**
   * How this host resolves a model NAMED by `/model <name>` (D-04, plan 08).
   *
   * Supplied by the host for the same reason `chatModel` is, and enforced by the same rule: the
   * chat subtree may not construct a model, so a session-scoped switch has to arrive as a
   * capability the composition was handed. Absent ⇒ `/model` still records the session's declared
   * model and emits its `model_change` (the header, the prompt and the drift check all follow it),
   * and no new client is resolved — the honest behaviour for a host that composed one model.
   */
  readonly chatModelFor?: (name: string) => ChatLanguageModel | Promise<ChatLanguageModel>
  /**
   * Where a chat session PRINTS a mid-turn artifact a person reads (395-13, D-14).
   *
   * A PLAIN FUNCTION: printing needs nothing from this composition. The surface is handed text and
   * writes it. (432-16 deleted the `chatConfirm` factory that used to sit beside it.)
   *
   * PASSED THROUGH UNTOUCHED to the turn engine's `present`. Absent ⇒ the engine renders nothing
   * mid-turn, which is every host that is not a REPL — and no gate, receipt or session row moves.
   */
  readonly chatPresent?: (text: string) => void | Promise<void>
}

// 432-16 (D-14/D-15): `ChatConfirmBindings` and `ChatApprovalDecisionRecord` are deleted with the
// chat confirm they served. Nothing asks, so no grant is minted from chat and no `approval_decision`
// row is written; sessions written before 432 still carry such rows and the session guard in
// `schema/src/chat/session-events.ts` still reads them.

/**
 * The live chat session a host holds beside the registry (plan 08, RESEARCH Open Q2).
 *
 * Exposed because two of its facts have no other route to a surface: the state a REPL renders
 * from, and the ability to close an interrupted turn honestly. Everything else a conversation does
 * goes through `agent.ask` like every other capability (D-24).
 */
export interface LocalAgentChatSession {
  /**
   * The live state of ONE conversation, or `undefined` for a session this host has not opened
   * (392 plan 13, CR-02).
   *
   * A LOOKUP RATHER THAN A CONTAINER, because the facts inside it — the turn in flight, the
   * conversation, the model in force, what `/pin` denies, whether `/quit` was typed — are facts
   * about a session and never about a host. A composition serving two conversations that handed
   * out one container was answering both of them with whichever turn wrote last, which is what
   * let a planner read the wrong history (CR-02) and a pin outlive its session (W-03).
   *
   * `undefined` is the honest answer for an id nobody here is holding, and reading NEVER creates
   * a scope: a surface asking about a session cannot bring one into being by asking.
   */
  stateFor(sessionId: string): ChatStateSnapshot | undefined
  /**
   * Write the explicit `aborted` event for the turn in flight, and fsync (D-19's graceful arm).
   *
   * A no-op between turns, deliberately: an `aborted` row for a turn that already carries its
   * `turn_complete` would make the repair on the next open trim a turn that finished.
   */
  abortActiveTurn(): Promise<void>
}

/**
 * One test's recorded outcome history, read per query from the derived run-outcome
 * projection (389 plan 02's read side) at `<knowledgeRoot>/memory/index/knowledge.db`.
 *
 * Absence discipline: a database that was never created, a store predating the projection
 * tables, and an identity the projection never counted ALL answer `undefined` — the author
 * and the renderer both carry a typed no-history posture, and faking an empty row would
 * erase the distinction plan 02 pinned. Any OTHER read failure propagates: a corrupt store
 * is not "no history".
 */
function readProjectedTestHistory(
  knowledgeRoot: string,
  query: { readonly product: string; readonly filePath: string; readonly testName: string },
): ReturnType<typeof readTestOutcomeHistory> {
  const path = indexDbPath(knowledgeRoot)
  if (!existsSync(path)) return undefined
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return readTestOutcomeHistory(db, {
      product: query.product,
      filePath: query.filePath,
      testName: query.testName,
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) return undefined
    throw error
  } finally {
    db.close()
  }
}

/**
 * The recurrence pair the clause renders, from whichever window the query keyed (390 D-07).
 *
 * `kth` / `windowBuilds` keep 389's names because they are the renderer's vocabulary; what
 * changed underneath is which window answers them.
 */
interface ProjectedRecurrence {
  readonly kth: number
  readonly windowBuilds: number
}

/**
 * One recurrence read, over ONE connection (390 D-07).
 *
 * A query CARRYING a fingerprint is answered by the fingerprint-keyed window — the same failure
 * recurring, which is what the ladder triggers on — and a query without one falls back to the
 * per-test window 389 bound this seam to. The fallback is not a degradation: a member with no
 * failing step to key from has no fingerprint to count, and its per-test history is the honest
 * answer rather than a stand-in key's.
 *
 * The read-time "current build" is the row's own `lastBuildOrdinal` (falling back to the greatest
 * windowed ordinal) for BOTH legs: at render time the latest recorded build IS current, and using
 * one ordinal for both keeps the numerator and the denominator on the same window.
 */
function readProjectedRecurrence(
  knowledgeRoot: string,
  query: { readonly product: string; readonly filePath: string; readonly testName: string
    readonly fingerprint?: string },
): ProjectedRecurrence | undefined {
  const path = indexDbPath(knowledgeRoot)
  if (!existsSync(path)) return undefined
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const history = readTestOutcomeHistory(db, {
      product: query.product,
      filePath: query.filePath,
      testName: query.testName,
    })
    if (history === undefined) return undefined
    const currentBuildOrdinal =
      history.lastBuildOrdinal
      ?? history.lastOutcomes.reduce((max, entry) => Math.max(max, entry.buildOrdinal), 0)
    if (query.fingerprint === undefined) return failureRecurrence(history, currentBuildOrdinal)
    const windowed = fingerprintRecurrence(
      db,
      { product: query.product, fingerprint: query.fingerprint },
      currentBuildOrdinal,
    )
    return { kth: windowed.occurrenceOrdinals, windowBuilds: windowed.windowOrdinals }
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) return undefined
    throw error
  } finally {
    db.close()
  }
}

/**
 * What a folded ledger entry renders as on the sentence's ladder — a TOTAL table (390 D-17).
 *
 * `satisfies Record<QuarantineEntryStateName, …>` is load-bearing: a fourth ledger state cannot
 * compile until someone decides how it reads to a human. `released` maps to NO rung because a
 * closed window is history, not a state of the test today — the clause would otherwise announce a
 * quarantine that ended.
 */
const LADDER_STATE_FOR_ENTRY = {
  quarantined: 'quarantined',
  expired: 'expired',
  released: undefined,
} as const satisfies Record<QuarantineEntryStateName, QuarantineLadderState | undefined>

/**
 * The ladder rung this identity sits on, joined LIVE from the committed ledger (390 D-06/D-17).
 *
 * Keyed on IDENTITY, not on the fingerprint: the ledger records which TEST is suppressed, and a
 * test whose failure mode changed is still suppressed. `now` arrives as an argument (one read per
 * query — two reads could land either side of one deadline).
 *
 * An unreadable ledger PROPAGATES its typed error rather than answering "no rung". Healing here
 * would render a suppressed test's sentence as an ordinary one, which is the silent flip this
 * phase exists to prevent (the same posture 390-03 pinned for the authoring reader).
 *
 * Below the ledger, the FLAG floor: a fingerprint at D-06's floor with no open window is
 * `flagged` — one build of warning before anything changes — and that covers both halves of
 * D-05's class gate, since a class that never auto-quarantines still recurs loudly here.
 */
function readQuarantineLadder(
  knowledgeRoot: string,
  identity: { readonly product: string; readonly filePath: string; readonly testName: string },
  now: string,
  recurrence: ProjectedRecurrence,
): RecurrenceLadder | undefined {
  const entries = foldQuarantineLedgerState(readQuarantineLedger(knowledgeRoot).events, now)
  const entry = entries.find((candidate) =>
    candidate.product === identity.product
    && candidate.filePath === identity.filePath
    && candidate.testName === identity.testName)
  const state = entry === undefined ? undefined : LADDER_STATE_FOR_ENTRY[entry.state]
  if (entry !== undefined && state !== undefined) return { state, expiresAt: entry.expiresAt }
  if (recurrence.kth >= QUARANTINE_FLAG_FLOOR) return { state: 'flagged' }
  return undefined
}

interface ProjectionRecurrence {
  readonly provider: RecurrenceProvider
  /**
   * Resolve (and cache) the knowledge root the SYNC provider reads under. See the
   * `runs.get` wrapper in `composeLocalAgent` for why this exists and where it is awaited.
   */
  prime(): Promise<void>
}

/**
 * The D-08 recurrence seam, bound at ONE composition root.
 *
 * 389 bound it to v51's per-test run-outcome window; 390-06 REBOUND the COMPUTATION to the
 * fingerprint-keyed window plus a per-call fold of the committed quarantine ledger (D-07/D-17).
 * The priming machinery below is unchanged and deliberately so — G-389-2's fused
 * mint-and-attach is a shipped fix, and only what the provider computes moved.
 *
 * The join is LIVE per call: both reads run on every query and nothing about the ANSWER is
 * cached, so a store update OR a ledger append between two renders changes the clause (D-08,
 * SC4). Only the knowledge ROOT — a composition-lifetime fact, not an answer — is resolved
 * once and remembered.
 *
 * A host may supply an ASYNC root resolver (the CLI layers configuration). A query that
 * arrives before the root resolves answers `undefined` — rendered as the explicit
 * no-history clause — which is why every `analysis.get` invocation primes the root through
 * the awaited `runs.get` hop before the sync join can run. A synchronously-throwing
 * resolver is swallowed to the SAME degrade (a read that needs no knowledge root never
 * fails on one), and minting + handler attachment are fused in `beginResolve` — the one
 * place a root-resolution promise is created — so no promise can be orphaned (G-389-2).
 */
function createProjectionRecurrenceProvider(
  resolveKnowledgeRoot: () => Promise<string> | string,
  /** The host clock, read ONCE per query — the ladder's expiry comparison needs an instant. */
  now: () => string,
): ProjectionRecurrence {
  let root: string | undefined
  let resolving: Promise<void> | undefined

  function beginResolve(): Promise<void> | undefined {
    if (resolving !== undefined) return resolving // reuse the in-flight resolution; never mint a second promise
    let answer: Promise<string> | string
    try {
      answer = resolveKnowledgeRoot()
    } catch {
      return undefined // sync throw: swallowed here, retried on the next query
    }
    if (typeof answer === 'string') {
      root = answer
      return undefined
    }
    // A failed resolution clears the marker so the next query retries rather than
    // pinning the provider to permanent no-history over a transient host error.
    resolving = answer.then(
      (value) => {
        root = value
      },
      () => {
        resolving = undefined
      },
    )
    return resolving
  }

  function rootNow(): string | undefined {
    if (root !== undefined) return root
    beginResolve()
    return root
  }

  return {
    prime(): Promise<void> {
      if (root !== undefined) return Promise.resolve()
      // Both stored handlers swallow, so prime never rejects — the awaited runs.get hop
      // cannot fail on a knowledge-root problem.
      return beginResolve() ?? Promise.resolve()
    },
    provider: {
      failureRecurrence(query) {
        const knowledgeRoot = rootNow()
        if (knowledgeRoot === undefined) return undefined
        const recurrence = readProjectedRecurrence(knowledgeRoot, query)
        // No recorded history is the honest no-history clause, ladder or not: 389's absence
        // discipline is a prohibition this plan inherits, and a reader who needs the owner or
        // the deadline of an entry with no history has `quarantine.list` and the entity card.
        if (recurrence === undefined) return undefined
        const ladder = readQuarantineLadder(knowledgeRoot, query, now(), recurrence)
        return ladder === undefined ? recurrence : { ...recurrence, ladder }
      },
    },
  }
}

/**
 * The `analysis.json` read side (389 D-10/D-11), path-derived from the artifact's own
 * `runId` through the SAME `runs/<slug>/` law as the handoff read and the persist binding
 * — `slugBranch` is the traversal guard (T-389-01), and no caller ever supplies a path.
 *
 * An absent file is `undefined` — "the analysis never ran" is a true state of a run, which
 * `analysis.get` serves as the floor. Everything else propagates: a schemaVersion newer
 * than this build reads is `guardRunAnalysisArtifact`'s typed hard failure (never swallowed
 * into a silent floor), and malformed bytes are corruption, not absence. A PRESENT file
 * recording ANOTHER run's id is refused by identity (`admitAnalysisArtifactForRun`,
 * G-389-3A) and served as the floor — a refusal, not an absence, distinguishable by the
 * two-leg differential: the same bytes with the id corrected are adopted.
 */
function createAnalysisArtifactReader(agentQaRoot: string): AnalysisArtifactReaderPort {
  return {
    getArtifact(runId) {
      const path = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId), ANALYSIS_FILE)
      let bytes: string
      try {
        bytes = readFileSync(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      const admission = admitAnalysisArtifactForRun(
        guardRunAnalysisArtifact(JSON.parse(bytes)),
        runId,
      )
      return admission.kind === 'admitted' ? admission.artifact : undefined
    },
  }
}

/**
 * The post-run handlers' capabilities, or nothing at all (388 D-01 / D-06).
 *
 * The handoff read is DERIVED from `runId` through the same `runs/<slug>/handoff.json` layout
 * `FsHandoffStore` writes and `createRunsReader` enumerates — never a path carried on the job
 * payload, which would be a stored fact free to go stale between the enqueue and the claim,
 * and a caller-controlled string on the way to `join`. `slugBranch` is what makes a runId of
 * `../../etc` address nothing outside the runs directory (T-361-01 precedent).
 *
 * `loadCompletedRunHandoff` already hard-fails typed on a missing file or an unreadable
 * schema version, which is exactly the posture the handler wants: both are permanent
 * conditions of that run, not transient ones worth a retry.
 */
export function postRunCapabilities(
  input: ComposeLocalAgentInput,
  /**
   * The RESOLVED knowledge root. `openJobs` awaits the host's resolver once at queue open
   * — the same once-at-open idiom the model factory follows — so the SYNC capability
   * members below never race an async resolution mid-job.
   */
  knowledgeRoot: string,
  /** The RESOLVED budget, awaited from the input factory at the same open (see above). */
  analysisTokenBudget?: PostRunJobCapabilities['analysisTokenBudget'],
): PostRunJobCapabilities | undefined {
  const postRun = input.postRun
  if (postRun === undefined) return undefined
  return {
    loadCompletedRunHandoff: (runId: string) =>
      loadCompletedRunHandoff(
        join(input.agentQaRoot, RUNS_SUBDIR, slugBranch(runId), HANDOFF_FILE),
      ),
    curateRun: postRun.curateRun,
    // 389 D-09: the artifact's path is DERIVED from the artifact's own runId through the
    // same `runs/<slug>/` law as the handoff read above — `slugBranch` is the traversal
    // guard (T-389-01), and a job payload never carries a path.
    persistAnalysis: (artifact) =>
      writeAnalysisArtifact(
        join(input.agentQaRoot, RUNS_SUBDIR, slugBranch(artifact.runId), ANALYSIS_FILE),
        artifact,
      ),
    // Plan 02's read side over the derived projection, keyed the projection's way —
    // (product, filePath, testName), the stable identity, NEVER a per-run explicit id.
    // The query arrives already keyed by the author callback; this binding only reads.
    readTestHistory: (query) => readProjectedTestHistory(knowledgeRoot, query),
    // D-02's sha-addressed screenshot bytes: the SAME CASS-02 store the runner writes.
    // `FsEvidenceArtifactStore.getBlob` validates the lowercase 64-hex shape BEFORE any
    // path use (T-389-14) and answers ENOENT as honest absence; the runId becomes a path
    // segment only through `slugBranch` inside the store's own constructor.
    //
    // 405-05: THROUGH THE SHARED RULE, not a lambda of its own. `runs.artifact` binds a port over
    // the same `lookupEvidenceBlob` below, and two lambdas over one store would be two answers to
    // where a run's blobs live — agreeing on the day the second is written and diverging the first
    // time either side changes a root. This job wants only the found bytes, so the three-arm
    // lookup collapses here; the SPLIT is what the op needs and what this caller does not.
    readEvidenceBlob: (runId, sha) =>
      readEvidenceBlobBytes({ agentQaRoot: input.agentQaRoot }, runId, sha),
    // Host-resolved and passed through untouched (386 D-15): the budget derives from the
    // same profile resolution as the job model, and this composition adds no knob of its own.
    ...(analysisTokenBudget === undefined ? {} : { analysisTokenBudget }),
  }
}

/** Compose the local agent host. */
/**
 * The two callers chat mints, one per stage (392, RESEARCH Pitfall 1 / 391 D-06).
 *
 * IDENTICAL BUT FOR `origin`. `FunctionCaller.origin` answers "did a person decide this", and inside
 * ONE turn both answers occur: a person typing a canonical alias decided that call, and a model
 * planning one did not. The receipts a turn logs record that origin per clause.
 *
 * `surface` is `'chat'` on both and is ATTRIBUTION ONLY. Nothing in the function layer may branch
 * on it (`invoke.ts:28-29`).
 *
 * 2026-10-01 (432-20/432-21, D-12): no scope set and no safe-mode flag. `CHAT_STAGE_SCOPES`, the
 * whole closed scope union both stages held, is deleted: every caller can call every operation, and
 * the human-origin restriction the origin split once protected is deleted with `requiresHumanOrigin`.
 */
export const CHAT_RESOLVER_CALLER: FunctionCaller = Object.freeze({
  surface: 'chat',
  origin: 'human',
})

export const CHAT_PLANNER_CALLER: FunctionCaller = Object.freeze({
  surface: 'chat',
  origin: 'agent',
})

/**
 * A fingerprint of what the turn engine could reach when a session opened.
 *
 * Derived from the REGISTRY rather than from a hand-kept list, which is D-07's projection law
 * applied to the log: the toolset a turn is measured against is whatever the catalogue declares,
 * so a build that gains an op gains it here without anybody remembering to say so. A registry not
 * yet composed answers `'unbound'` — the same honest word the model field uses.
 */
function chatToolsetIds(registry: FunctionRegistry | undefined): readonly string[] {
  if (registry === undefined) return []
  return registry
    .list(CHAT_RESOLVER_CALLER)
    .map((declaration) => declaration.id)
    .sort()
}

function chatToolsetHash(registry: FunctionRegistry | undefined): string {
  if (registry === undefined) return 'unbound'
  // Sorted before hashing, which is what makes the hash an identity of the SET rather than of the
  // walk: a registry that enumerated in a different order must not read as a toolset change.
  // The workspace's own digest helper, not a second hashing call site (388 C13 in miniature).
  return sha256hex16(chatToolsetIds(registry).join('\n'))
}

// 2026-10-15 (441-68, GAP2-D3): chat projections mask the text a person, an op or config wrote and
// keep the closed vocabulary the code writes and reads back (`guardChatSessionEvent` checks keys,
// `kind`, `turnId` and `at` exactly). Keys are never renamed outside an op's payload. A member no
// table names is masked as a tree, which fails closed.
type ChatMemberRule = 'as-written' | 'text' | 'tree' | ((value: unknown, mask: MaskFn) => unknown)
type ChatMemberRules = Readonly<Record<string, ChatMemberRule>>

function projectChatMembers<T extends object>(value: T, rules: ChatMemberRules, mask: MaskFn): T {
  return Object.fromEntries(Object.entries(value).map(([key, member]) => {
    const rule = Object.hasOwn(rules, key) ? rules[key]! : 'tree'
    if (rule === 'as-written') return [key, member]
    if (typeof rule === 'function') return [key, rule(member, mask)]
    if (rule === 'text' && typeof member === 'string') return [key, mask(member)]
    return [key, maskPayloadTree(member, mask)]
  })) as T
}

const eachChatRecord = (rules: ChatMemberRules): ChatMemberRule => (value, mask) => {
  const project = (entry: unknown) =>
    isRecord(entry) ? projectChatMembers(entry, rules, mask) : maskPayloadTree(entry, mask)
  return Array.isArray(value) ? value.map(project) : project(value)
}

const CHAT_EVENT_BASE: ChatMemberRules = {
  kind: 'as-written', turnId: 'as-written', at: 'as-written',
}
const CHAT_CLAUSE_RECEIPT_RULES: ChatMemberRules = {
  clause: 'text', functionId: 'as-written', origin: 'as-written', status: 'as-written', outcome: 'text',
}
const CHAT_EVENT_RULES: Readonly<Record<ChatSessionEvent['kind'], ChatMemberRules>> = {
  user_message: { ...CHAT_EVENT_BASE, text: 'text' },
  stage_outcome: { ...CHAT_EVENT_BASE, stage: 'as-written', outcome: 'as-written' },
  clause_receipt: { ...CHAT_EVENT_BASE, ...CHAT_CLAUSE_RECEIPT_RULES },
  clause_result: { ...CHAT_EVENT_BASE, functionId: 'as-written', payload: 'tree' },
  approval_decision: {
    ...CHAT_EVENT_BASE, actionClass: 'as-written', decision: 'as-written', source: 'as-written',
  },
  mark_unhandled: { ...CHAT_EVENT_BASE, clause: 'text', reason: 'text' },
  model_change: { ...CHAT_EVENT_BASE, from: 'text', to: 'text', source: 'as-written' },
  active_tools_change: {
    ...CHAT_EVENT_BASE, addedIds: 'as-written', removedIds: 'as-written', toolsetHash: 'as-written',
  },
  compaction: {
    ...CHAT_EVENT_BASE, beforeTokens: 'as-written', afterTokens: 'as-written', outcome: 'as-written',
  },
  aborted: { ...CHAT_EVENT_BASE, source: 'as-written' },
  turn_complete: { ...CHAT_EVENT_BASE, status: 'as-written' },
}

const CHAT_INVOKE_ANSWER_RULES: ChatMemberRules = {
  payload: 'tree',
  verdict: eachChatRecord({ status: 'as-written', outcome: 'text' }),
  foldLines: 'tree',
}

const CHAT_TURN_RESULT_RULES: ChatMemberRules = {
  sessionId: 'as-written',
  turnId: 'as-written',
  status: 'as-written',
  answer: 'text',
  receipts: eachChatRecord(CHAT_CLAUSE_RECEIPT_RULES),
  results: eachChatRecord({ functionId: 'as-written', payload: 'tree' }),
  unhandled: eachChatRecord({ clause: 'text', reason: 'text' }),
  refusedLineCount: 'as-written',
}

function projectChatSessionEvent(event: ChatSessionEvent, mask: MaskFn): ChatSessionEvent {
  const rules = Object.hasOwn(CHAT_EVENT_RULES, event.kind)
    ? CHAT_EVENT_RULES[event.kind]
    : CHAT_EVENT_BASE
  return projectChatMembers(event, rules, mask)
}

export function composeLocalAgent(input: ComposeLocalAgentInput): LocalAgentHost {
  const clock = input.clock ?? SYSTEM_CLOCK

  const entityResolutionInput = {
    agentQaRoot: input.agentQaRoot,
    resolveKnowledgeRoot: input.knowledgeRoot,
  }

  // 389 plan 06: the recurrence seam and its root priming. `analysis.get` awaits
  // `deps.runs.get` before any recurrence join runs (analysis-get.ts invoke order), so
  // priming the root inside that awaited hop is what makes the SYNC provider correct on a
  // host whose knowledge-root resolver is async (the CLI): by the time the join runs, the
  // root string is cached. A resolution failure is swallowed HERE only — the provider then
  // answers the honest no-history clause, and the knowledge verbs report their own errors
  // through their own awaited resolutions.
  const recurrence = createProjectionRecurrenceProvider(input.knowledgeRoot, () => clock.now())
  const runsReader = createRunsReader(input.agentQaRoot)

  // 392 D-02 / D-14 / D-24: the chat turn engine, assembled at THE composition root.
  //
  // Assembled HERE and nowhere else for 385 D-15's reason, which bites harder for chat than for
  // anything before it: two hosts assembling a turn engine differently would be two answers to
  // "what can a conversation do", and one of the two would be the one a user is talking to.
  //
  // The dispatch binding closes over `composedRegistry`, which this very call is about to
  // produce. That is deliberate rather than awkward: the engine invokes ops through
  // `invokeFunction` on the SAME registry `agent.ask` is registered in, so a clause a turn runs
  // crosses the identical eight-step gate a typed CLI verb does (D-24 / 384 FUNC-03). Reading the
  // reference at call time rather than at construction is what lets that cycle exist without a
  // second registry, and it is safe because a turn cannot run before the registry it is bound
  // into has been built.
  let composedRegistry: FunctionRegistry | undefined
  // `unbound` when this host binds no model — the honest word rather than a placeholder, and the
  // same vocabulary the registry uses for a declared capability with no implementation behind it.
  // A headless host's session header says so, and the day one is bound the drift from here is a
  // `model_change` event rather than a header rewrite (D-04; the log is append-only).
  const composedChatModelName = input.chatModel === undefined ? 'unbound' : input.chatModel.modelId

  // 392 plan 08/13 (RESEARCH Open Q2, CR-02 / W-03): the live turn state and the pin set, KEYED BY
  // SESSION.
  //
  // Both used to be one object per composition, and the verifier's finding is what that costs on a
  // host serving more than one conversation: `activeTurnId` / `conversation` / `activeModel` are
  // facts about ONE session, so a single container published whichever turn wrote last — and the
  // planner, which reads the conversation at plan time across an `await`, could therefore put one
  // person's history into another person's outbound provider request. The pin holder is the same
  // shape with a sharper edge: a `/pin` typed in one conversation denied that action class for
  // every later caller until the process restarted, while `pin-overlay.ts`'s own header said the
  // pin dies with the session. It now does.
  //
  // CREATED ON FIRST RESOLUTION and held for the composition's life. That is bounded by the number
  // of sessions this host serves and reaped with the composition, which is the same lifetime the
  // single container had; what changed is that it is one per conversation instead of one per host.
  interface ChatSessionScope {
    readonly state: ChatStateContainer
  }
  const chatScopes = new Map<string, ChatSessionScope>()
  const chatScopeFor = (sessionId: string): ChatSessionScope => {
    const existing = chatScopes.get(sessionId)
    if (existing !== undefined) return existing
    if (composedRegistry === undefined) {
      throw new TypeError('a chat session opened before its registry finished composing')
    }
    const scope: ChatSessionScope = {
      // An UNBORN session has run no `/model`, so it opens under the model this host composed —
      // which is also what its header will say. A container seeded from another session's override
      // would make one conversation's verb the next conversation's opening posture.
      state: createChatState({ activeModel: composedChatModelName }),
      // 432-13 (D-14): no pin holder. `/pin` left chat resolution with the op gate it tightened.
    }
    chatScopes.set(sessionId, scope)
    return scope
  }

  // THE MODEL IN FORCE IS READ, NEVER CAPTURED, and this one line is the whole of 392-07's warning.
  // `/model` writes the override into the session's own state; every consumer below — the planner's
  // prompt and the per-turn config re-read — reads it through here. A thunk that kept answering the
  // COMPOSED model would emit a `model_change` straight back on the next turn, silently undoing the
  // verb that had just been recorded.
  const chatModelNameFor = (sessionId: string): string =>
    chatScopeFor(sessionId).state.read().activeModel

  // The live model OBJECT for a model name. Keyed by name rather than by session, because
  // `chatModelFor` is a resolution of a name and two sessions naming the same model mean the same
  // model — the same reason the planner stage cache below is keyed that way. Which name a session
  // is under is the per-session fact, and it lives in that session's state.
  const chatModelsByName = new Map<string, ChatLanguageModel>()
  if (input.chatModel !== undefined) chatModelsByName.set(composedChatModelName, input.chatModel)

  const chatSessionLog = createJsonlSessionLog({
    root: input.agentQaRoot,
    now: () => clock.now(),
    // THE COMPOSED MODEL, not a session's override, and the difference is a leak this keying closes.
    // This thunk is read when a header is WRITTEN, which happens exactly once per session and only
    // for a session that has not existed until now — so no `/model` can have run in it. Answering
    // with a live override would stamp one conversation's switch onto the opening header of every
    // conversation opened after it. 441 GAP3-D4: written and listed through the declared mask.
    model: () => input.mask(composedChatModelName),
    toolsetHash: () => chatToolsetHash(composedRegistry),
  })

  // 392-12 / CR-01: WHICH SESSIONS ARE OPEN RIGHT NOW, and which turns each of them has recorded.
  //
  // The engine owns a session for the length of a turn, but a writer here is OUTSIDE a turn's
  // call stack and still belongs to one: `chat.abortActiveTurn`, reached from a signal handler
  // (the confirm port's `onDecision` was the other until 432-16 deleted it). Both used to
  // append through the adapter, which — while the adapter had one descriptor — meant "whichever
  // session opened last". They now write through the handle of the session whose file already
  // carries the turn in question, and the ATTRIBUTION IS THE LOG'S OWN: every event carries a
  // `turnId`, so the wrapper records the ids it has written per handle and a later writer names a
  // turn rather than guessing a session. A turn nobody here is holding gets no row, which is the
  // fail-safe direction — the alternative is a row in the wrong conversation, and that is CR-01.
  const liveChatSessions = new Map<string, { handle: ChatSessionHandle; turnIds: Set<string> }>()

  const trackedChatSessionLog: SessionLogPort = {
    async open(sessionId?: string): Promise<ChatSessionHandle> {
      const opened = await chatSessionLog.open(sessionId)
      const id = opened.header.sessionId
      const turnIds = new Set<string>()
      const tracked: ChatSessionHandle = {
        header: opened.header,
        events: opened.events,
        refusedLines: opened.refusedLines,
        append: async (event) => {
          // 2026-10-14 (441-06, D-06): every event carries the declared mask (441-68: per member).
          const projected = projectChatSessionEvent(event, input.mask)
          turnIds.add(projected.turnId)
          await opened.append(projected)
          // 400-01 (D-03): the host's carbon copy, taken AFTER the write and never instead of it.
          // Swallowed by name: a surface's push channel is downstream of the durable log, and a
          // failing SSE write must not fail the turn whose event it was trying to announce.
          try {
            input.observeSessionEvent?.(id, projected)
          } catch { /* a push channel's failure is not the turn's */ }
        },
        turnBoundary: () => opened.turnBoundary(),
        close: async () => {
          // Unregistered BEFORE the descriptor goes, so nothing can pick this handle up in the
          // window between the two and write through a closed one.
          liveChatSessions.delete(id)
          await opened.close()
        },
      }
      liveChatSessions.set(id, { handle: tracked, turnIds })
      return tracked
    },
  }

  /** The open session whose file already carries this turn, or none if nobody here holds it. */
  const chatSessionHoldingTurn = (turnId: string): ChatSessionHandle | undefined => {
    for (const entry of liveChatSessions.values()) {
      if (entry.turnIds.has(turnId)) return entry.handle
    }
    return undefined
  }

  // 392 plan 04/07: stage 2, assembled LAZILY over the registry this call is about to produce.
  //
  // The laziness is the same cycle the dispatch binding below resolves, for the same reason: the
  // toolset is a walk of the registry `agent.ask` is registered in, and D-07's projection law says
  // the planner's vocabulary IS that catalogue — so an eagerly-built toolset would either need a
  // second registry or would have to be a curated list, which is exactly what 397's conformance
  // and 396's MCP parity are built against not being. Built once on first use and reused after,
  // because a walk per turn would re-project ~30 JSON schemas for no new information.
  //
  // KEYED BY THE MODEL IN FORCE (plan 08). `createPlannerStage` binds its model at construction, so
  // a single cached stage would keep planning through the model a `/model` verb had just replaced —
  // the override would move the prompt's `activeModel` line and change nothing about who answered.
  // One stage per model, built on first use of each.
  const plannerStages = new Map<string, PlannerStagePort>()
  const chatPlanner: PlannerStagePort | undefined =
    input.chatModel === undefined
      ? undefined
      : {
          plan: (request) => {
            if (composedRegistry === undefined) {
              throw new TypeError('a chat turn ran before its registry finished composing')
            }
            const activeName = chatModelNameFor(request.sessionId)
            let stage = plannerStages.get(activeName)
            if (stage === undefined) {
              stage = createPlannerStage({
                model: (chatModelsByName.get(activeName) ?? input.chatModel) as ChatLanguageModel,
                tools: projectPlannerTools(composedRegistry, CHAT_PLANNER_CALLER),
                // Read PER REQUEST — not per turn and not per stage (392 plan 13, CR-02). A stage
                // is shared by every session planning under the same model name, so a context
                // thunk taking no argument had exactly one conversation to answer with, and on
                // two interleaved turns it answered with whichever one published last. Taking the
                // requesting session's id makes "the conversation this request replays" a fact
                // about the call. The read is still LIVE, so a `/model` override still moves what
                // the prompt states without the stage being rebuilt, and the conversation block
                // still carries what compaction left rather than a second replay of the log.
                context: (contextRequest) => {
                  const scope = chatScopeFor(contextRequest.sessionId).state.read()
                  return { activeModel: scope.activeModel, conversation: scope.conversation }
                },
              })
              plannerStages.set(activeName, stage)
            }
            return stage.plan(request)
          },
        }

  // CHAT-04's degrade pass, bound when the host supplied the accounting instance (plan 06).
  // Its one event goes through the HANDLE the engine hands it per turn (392-12) — the hook holds
  // no log of its own and no longer holds a binding to one, so there is exactly one writer per
  // session and it is that session's own.
  const chatCompaction: CompactionHook | undefined =
    input.chatAccounting === undefined
      ? undefined
      : createChatCompactionHook({
          accounting: input.chatAccounting,
          now: () => clock.now(),
          // 392-06's flagged consumer, wired: what compaction leaves IS the conversation the
          // prompt renders, and it lands in the live state on EVERY turn rather than only on a
          // triggered pass — a sink that fired only when a pass ran would leave the prompt holding
          // a stale conversation on every quiet turn. Into the SESSION'S OWN container (plan 13):
          // the id is the compacted turn's, so a pruned history cannot land in another
          // conversation however many turns are in flight.
          onConversation: (messages, sessionId) => {
            chatScopeFor(sessionId).state.setConversation(messages)
          },
        })

  const chatTurn = createTurnEngine({
    table: CHAT_RESOLVER_TABLE,
    // 392 plan 02, D-09: the real conjunction grammar, quote-aware. The tracer's
    // whole-utterance placeholder is gone; this is the seam filled, not widened.
    split: splitClauses,
    reconcile: input.chatReconcile ?? deterministicOverrideStrategy,
    sessionLog: trackedChatSessionLog,
    // RESEARCH Pitfall 1: per-STAGE minting, because origin is a per-call fact. A deterministic
    // table hit is a person typing and mints `human`; a planner-planned call mints `agent`, and the
    // turn's receipts record which.
    // 2026-10-01 (432-21, D-12): NOT STAMPED WITH THE SESSION ANY MORE. The session id rode the
    // caller for the gate's deny overlay (plan 13, W-03) and the overlay is deleted (432-13/18/19);
    // nothing reads `FunctionCaller.sessionId`. The session still reaches the ops that record it
    // through the turn's own session facts, not through the caller.
    mint: {
      forStage: (stage) => (stage === 'resolver' ? CHAT_RESOLVER_CALLER : CHAT_PLANNER_CALLER),
    },
    // 399.1 D-01/D-03/D-05: the classified envelope, built HERE because this closure is the one
    // place in the system holding both the registry and the invoke call. The chat subtree cannot
    // reach a spec by construction (384 FUNC-03), so the verdict and the render fold have to arrive
    // as data on this return — which is what `ChatInvokeAnswer` is. `foldFunctionResult` owns the
    // fail-closed rule so both composition roots get the same one rather than a copy each.
    //
    // invokeFunction validates canonical output; it does not promise masking. Classify those
    // original bytes before projecting the answer into results[] and the durable clause_result.
    invoke: async (functionId, invokeInput, caller) => {
      if (composedRegistry === undefined) {
        throw new TypeError('a chat turn ran before its registry finished composing')
      }
      const payload = await invokeFunction(composedRegistry, functionId, invokeInput, caller)
      const fold = foldFunctionResult(composedRegistry, functionId, payload)
      return projectChatMembers({ payload, ...fold }, CHAT_INVOKE_ANSWER_RULES, input.mask)
    },
    ...(chatPlanner === undefined ? {} : { planner: chatPlanner }),
    ...(chatCompaction === undefined ? {} : { compaction: chatCompaction }),
    // 392 plan 08: the directive handlers, which is what turns the engine's
    // `directive recognised but no handler` refusal from the shipped behaviour into an
    // unreachable arm on this host. `/help` and `/quit` are REPL chrome and answer in prose;
    // `/model` changes what the session is and returns the EFFECT it had. (432-13: `/pin` is gone.)
    //
    // RESOLVED PER SESSION (plan 13, CR-02 / W-03). Each one acts on a conversation rather than the
    // project, so the handler set is built over the scope of the session running the turn:
    // `/model` moves that conversation's model and `/quit` asks that loop to end.
    directives: (sessionId) => ({
      // THE BATCH PRE-FLIGHT (392-14, E3/E3b). The engine asks this of EVERY directive of a turn
      // before it applies the first one, so a refused later directive leaves an earlier one
      // unapplied.
      //
      // IT APPLIES NOTHING. `/model` RESOLVES the model and caches it under its name — a cache is
      // not the session's state, and the session's own `activeModel` is left exactly where it was.
      // The resolution is also the only part of `/model` that can fail, so caching it here is what
      // makes the later apply unable to throw after an earlier directive has already been carried
      // out.
      validate: async (directive, argument) => {
        if (directive === 'model' && argument !== undefined && input.chatModelFor !== undefined) {
          chatModelsByName.set(argument, await input.chatModelFor(argument))
        }
      },
      model: async (name) => {
        const scope = chatScopeFor(sessionId)
        const from = scope.state.read().activeModel
        // Resolved ALREADY, when this host publishes `validate` — the pre-flight cached it under
        // this name and the apply reuses it rather than resolving a second time. Two resolutions
        // of one name on one turn would be two chances to disagree, and the second of them would
        // be running after the batch had been declared safe.
        if (input.chatModelFor !== undefined && !chatModelsByName.has(name)) {
          // Resolved by the HOST (CHAT-06): the chat subtree may not construct a model, so a
          // session-scoped switch is a capability this composition was handed. A resolution
          // failure throws, and the engine turns it into the same named refusal every other
          // unroutable clause gets — a `/model` that silently kept the old model would be the
          // worst answer available, since every later turn would report the new name.
          //
          // Recorded under the NAME, which is the key the planner cache and every other session
          // naming that model read it back by. The resolution is a fact about the name; which
          // session is under it is the fact that stays in the session's own state.
          chatModelsByName.set(name, await input.chatModelFor(name))
        }
        scope.state.setActiveModel(name)
        return { from, to: name, line: `model: ${from} → ${name}` }
      },
      help: () => CHAT_HELP_TEXT,
      quit: () => {
        chatScopeFor(sessionId).state.requestClose()
        return 'closing this session'
      },
    }),
    state: (sessionId) => chatScopeFor(sessionId).state,
    // D-04: the configuration RE-READ, per turn and PER SESSION. A thunk rather than a captured
    // value, because the drift worth detecting is precisely the one that happens underneath a
    // running session — a model resolved differently by the host, or a build whose registry
    // reaches further than the one this session opened against. The engine folds the log for what
    // was last recorded and emits `model_change` / `active_tools_change` on the difference.
    //
    // THE MODEL IT REPORTS IS THE ASKING SESSION'S (plan 13). A composition-wide read would answer
    // one conversation's `/model` override for every conversation, and the per-turn diff would
    // then write a `model_change` into sessions nobody had switched.
    //
    // 441 GAP3-D4: masked, because the log it is compared with is masked on append.
    config: (sessionId): ChatConfigState => {
      const ids = chatToolsetIds(composedRegistry)
      return {
        model: input.mask(chatModelNameFor(sessionId)),
        toolset: { hash: chatToolsetHash(composedRegistry), ids },
      }
    },
    // 395-08 D-14/D-15 · CFGM-05: the target vocabulary the PRE-DISPATCH write_test route reads.
    // Bound off the SAME host verb `authoringRead.configuredTargetNames` uses, so the seam that
    // decides whether to offer a scaffold and the loop that later checks what a model emitted are
    // reading one answer rather than two. A host that cannot name its targets binds nothing and the
    // route never runs, which leaves the shipped dispatch and the loop's own backstop exactly as
    // they were.
    // BOUND ONLY WHERE THE LOOP IS. A host that cannot author has nothing for this route to route,
    // and binding it anyway would answer an empty vocabulary — which the route reads as the
    // from-zero case and refuses, reporting the wrong cause for a host whose real problem is that
    // `authoring.draft.write` is unbound. Absent leaves the shipped dispatch untouched.
    ...(input.draftAuthoring !== undefined && input.runExecution !== undefined
      ? { configuredTargets: () => (input.draftAuthoring as DraftAuthoringPort).configuredTargetNames() }
      : {}),
    // 395-13 D-14: where the scaffold proposal is rendered before the in-turn apply is invoked.
    // Conditionally spread on the exact idiom above, so a host that binds no surface leaves the
    // field ABSENT and the engine's own "renders nothing" posture is what answers — in one place.
    ...(input.chatPresent === undefined ? {} : { present: input.chatPresent }),
    now: () => clock.now(),
    mintTurnId: () => `turn-${randomUUID()}`,
  })

  // 2026-10-01 (432-18, D-14/D-15/D-22): no grants port, standing-approval read or dispatch-scoped
  // grant overlay is composed. The grant ops, the ledger and the overlay are deleted, and an old
  // `grants.jsonl` under the knowledge root is never opened.

  // 394 D-01: the authoring loop's host half, narrowed ONCE so the loop's closures capture a value
  // rather than an optional property — and so "can this host author a draft" is decided in one
  // place. `runExecution` is part of the condition even though nothing here calls it: stage 4
  // dispatches `authoring.draft.verify`, which is itself unbound without it, so a host bound to
  // author but not to verify would produce a draft and then refuse to say whether it is any good.
  const authoringLoopHost = input.draftAuthoring !== undefined && input.runExecution !== undefined
    ? input.draftAuthoring
    : undefined

  // 394-07 D-12/D-14 · WTST-05: the honesty funnel's reads, assembled ONCE and handed to both
  // consumers — the `authoring.funnel.get` op below, and the gate-2 flip consultation the draft
  // evaluator makes (394-17). Two bindings would be two answers to what this project knows about
  // one suite, which is the 385 D-15 rule this whole file is under.
  const authoringFunnel: AuthoringFunnelPortLike = {
    receipts: createDraftReceiptsStore({ resolveAgentQaRoot: () => input.agentQaRoot }),
    quarantine: {
      list: async () => (await createQuarantineOperations({
        resolveKnowledgeRoot: input.knowledgeRoot,
        now: () => clock.now(),
        mintIdentityPath: input.mintQuarantineIdentityPath,
        ...(input.resolveWriterAuthority === undefined
          ? {}
          : { resolveWriterAuthority: input.resolveWriterAuthority }),
      }).list()),
    },
    // D-14's history half, over the run-outcome projection's own read side (394-17, step b).
    //
    // ONE CONNECTION PER VERB, opened read-only and closed in `finally`, on the shape
    // `readProjectedTestHistory` above already takes. An absent database, a store predating the
    // projection tables and an identity nothing has counted all answer EMPTY — which
    // `assessSuiteStability` turns into the honest `no-history` posture rather than into a clean
    // bill of health. Any other read failure propagates: a corrupt store is not "no history".
    //
    // THE OUTCOME WORDS. The durable window keeps one boolean per build (`last_outcomes_json`),
    // which is what the fold reduced each member's outcome to, so this spells it back with the two
    // words it was reduced FROM. Nothing downstream compares those strings against a member list —
    // `assessSuiteStability` counts DISTINCT values — so a flip in the window is a flip here, and
    // no vocabulary is invented beyond what the projection actually kept.
    outcomes: {
      testsIn: async (product: string, filePath: string) => {
        const knowledgeRoot = await input.knowledgeRoot()
        const path = indexDbPath(knowledgeRoot)
        if (!existsSync(path)) return []
        const db = new DatabaseSync(path, { readOnly: true })
        try {
          return listTestsInFile(db, { product, filePath })
            .map((testName) => ({ filePath, testName }))
        } catch (error) {
          if (error instanceof Error && error.message.includes('no such table')) return []
          throw error
        } finally {
          db.close()
        }
      },
      outcomesFor: async (product: string, filePath: string, testName: string) => {
        const knowledgeRoot = await input.knowledgeRoot()
        const history = readProjectedTestHistory(knowledgeRoot, { product, filePath, testName })
        if (history === undefined) return []
        return history.lastOutcomes.map((entry) => (entry.passed ? 'passed' : 'failed'))
      },
    },
  }

  const registry = createFunctionRegistry({
    deps: {
      secretMask: input.mask,
      runs: {
        ...runsReader,
        get: async (runId) => {
          await recurrence.prime()
          return runsReader.get(runId)
        },
      },
      // 387 D-01: this host's list verbs are live sighting sites. Every entity a listing,
      // an inspect, a diff or a show surfaces gets its permanent address the first time it
      // is surfaced — which is what "pre-existing entities get IDs the day they are first
      // referenced" means in practice, and it costs the creation paths nothing.
      knowledge: createKnowledgeReader(
        input.knowledgeRoot,
        createMemorySightingHook(entityResolutionInput),
        input.resolveTrustPriors,
      ),
      config: input.config,
      entities: createEntityDirectory(entityResolutionInput),
      // 387-08 KREV-01: the WRITE half, and it is present in every local composition because a
      // local host owns the knowledge root it serves from. It stays an OPTIONAL dep so a host
      // that is genuinely read-only — a listing, a remote surface — reports the four mutating
      // verbs as `unbound` BY NAME rather than as a hole in the catalogue.
      knowledgeReview: createKnowledgeReview({
        ...(input.resolveTrustPriors === undefined ? {} : { resolveTrustPriors: input.resolveTrustPriors }),
            agentQaRoot: input.agentQaRoot,
        resolveKnowledgeRoot: input.knowledgeRoot,
        ...(input.knowledgeChangeDelegate === undefined
          ? {}
          : { knowledgeChangeDelegate: input.knowledgeChangeDelegate }),
        ...(input.resolveWriterAuthority === undefined
          ? {}
          : { resolveWriterAuthority: input.resolveWriterAuthority }),
        // 432-12: the host's own context, so a direct change is recorded under the context it was
        // actually made in. (432-39: the registry no longer receives it; this is its one reader.)
        ...(input.resolveExecutionContext === undefined
          ? {}
          : { resolveExecutionContext: input.resolveExecutionContext }),
      }),
      // 388 D-14: chip truth, on EVERY local host and not gated on `postRun`. The two are
      // different questions and conflating them would be the bug: `postRun` says whether this
      // host can DO the chain's work, while this says whether it can SEE what the chain did —
      // and a host that never drains anything (a status query, a listing, the CLI after a
      // handed-off tail) is exactly the caller that most needs to read durable state.
      //
      // Given the SAME id source the queue below is built with, so the rows projected are the
      // rows enqueued. It opens nothing here: the reader constructs no handle until it is asked
      // a question, and never one that could create the database (Pitfall 4).
      postProcessing: createPostProcessingReader({
        agentQaRoot: input.agentQaRoot,
        idSource: input.idSource ?? DIGEST_JOB_ID_SOURCE,
      }),
      // 405 D-03: the run-detail projection read, conditionally spread on the house rule — an
      // absent port must be an ABSENT field and not a present `undefined` one, because the
      // registry reads exactly this record to decide what the capability LISTS as. Unlike
      // `postProcessing` above it is NOT present on every local host: chip truth is readable from
      // `agentQaRoot` alone, but a run's projected step tree lives in a dashboard database that
      // only the dashboard process holds.
      // 423 D-04: runs.evidence shares this reader with runs.detail and the blob reader
      // below. The registry requires both for evidence without narrowing detail availability.
      ...(input.runDetail === undefined ? {} : { runDetail: input.runDetail }),
      // 405-05 D-12/D-13: the run-scoped evidence-blob read, on EVERY local host and NOT
      // conditionally spread — unlike `runDetail` one line up, which needs a dashboard database
      // this host may not hold, every local composition has a runtime root and therefore has the
      // run directories these blobs live in. It is the SAME reader the analysis job's
      // `readEvidenceBlob` is built over, so "resolve this ref" and "diet this evidence" cannot
      // disagree about where a blob is.
      evidenceBlobs: createEvidenceBlobReader({ agentQaRoot: input.agentQaRoot }),
      // Present iff this host can execute a run. The registry reads the SAME record to
      // decide what `runs.start` lists as, so the declaration and the dispatch cannot
      // disagree about whether this composition can run it (D-16).
      ...(input.runExecution === undefined ? {} : {
        runInvocation: createLocalRunInvocation({
          agentQaRoot: input.agentQaRoot,
          execution: input.runExecution,
        }),
      }),
      // 389 D-10/D-11: the artifact read `analysis.get` binds through, and the D-08
      // recurrence join the one renderer consults. Both are bindable from `agentQaRoot`
      // and the knowledge root alone, so every local composition carries them — a host
      // with no artifact on disk serves the floor, and a host with no recorded history
      // renders the explicit no-history clause; neither is a refusal (plan 05's law).
      analysis: createAnalysisArtifactReader(input.agentQaRoot),
      recurrence: recurrence.provider,
      // 398 D-09 (dated 2026-08-17): the catalog port `agent.explain` binds through, handed
      // straight through from the host. Conditionally spread rather than assigned, on the
      // `runInvocation` precedent: an absent port must be an ABSENT field and not a present
      // `undefined` one, because the registry reads exactly this record to decide what the
      // capability LISTS as — so the declaration and the dispatch cannot disagree about whether
      // this composition can explain itself (D-16).
      ...(input.capabilityCatalog === undefined
        ? {}
        : { capabilityCatalog: input.capabilityCatalog }),
      // 403 D-03: the live-view mint seam, conditionally spread on the same rule — an absent port
      // must be an ABSENT field, so `runs.liveurl` declares `unbound` where no origin is served.
      ...(input.liveView === undefined ? {} : { liveView: input.liveView }),
      // 390 D-12/D-13: the three quarantine verbs, bound HERE and therefore on BOTH hosts —
      // the CLI tail and 386's daemon compose the same root, which is the whole point of
      // 385 D-15 (a second binding site is a second answer to "what is quarantined").
      //
      // Present in every local composition for the same reason the knowledge WRITE half is: a
      // local host owns the committed knowledge root the ledger lives at. It stays an OPTIONAL
      // dep so a genuinely read-only or remote composition reports all three `unbound` BY NAME
      // rather than answering an empty list about a ledger it has never been able to open.
      //
      // The port takes the root as a FACTORY (the CLI resolves it asynchronously) and the clock
      // as an argument, so this composition supplies both and the implementation reads neither
      // of its own accord. Nothing opens here: the first byte is read when a verb is invoked.
      //
      // 390-09 / CR-03: the SAME `resolveWriterAuthority` the apply path consumes three bindings
      // above, and it is what lands each host on the correct lease arm with zero daemon changes.
      // The daemon supplies it (`cli/src/daemon/host.ts:1839`) because it acquired the lease at
      // startup and holds it for its lifetime, so the verbs ride that authority instead of asking
      // for a lease the process cannot be granted twice; the CLI in-process host supplies nothing,
      // so the verbs acquire and release per call. Conditionally spread like its neighbour rather
      // than assigned through: an absent authority must be an ABSENT field, not a present
      // `undefined` one, so the implementation's `?.()` arm distinguishes the two hosts.
      //
      // 390-12 / D-01: the identity mint is handed straight through, REQUIRED and unspread. The
      // verbs key the committed ledger on `filePath` and every reader compares those bytes with
      // `===`, so a host that supplied nothing would be back to storing whatever a human typed —
      // the round-2 regression. Unlike the authority above there is no host without a checkout
      // root, so the absent case is a compile error rather than a second posture.
      // 394-07 D-12 / WTST-05: the honesty funnel's reads, bound HERE and therefore on BOTH hosts,
      // which is the whole point of 385 D-15 — a second binding site would be a second answer to
      // "how many drafts did this session keep", and that number is the one WTST-05 exists to keep
      // honest.
      //
      // UNCONDITIONAL, unlike the loop's two halves above it, and the asymmetry is the point: the
      // funnel is a READ over records this host owns by owning `agentQaRoot`, so every local
      // composition can answer it whether or not it can author anything. An empty receipts
      // directory and an absent one are the same answer, and nothing opens here — the first byte
      // is read when the verb is invoked.
      //
      // THE RECEIPTS PORT IS THE READ HALF ONLY. The evaluator one binding below is handed the
      // same store's `put`; this bundle names `list` and nothing else, so the projection is
      // structurally unable to write the records it reports on. Two narrow mirrors over one store
      // rather than one wide port.
      //
      // 2026-10-01 (432-17, D-06): the bundle no longer reads the proposals inbox. 2026-10-02
      // (quick 261002-ctr): the terminal stage is `writeEligible`, read off the receipts this
      // bundle lists (see `projectAuthoringFunnel`).
      //
      // `outcomes` IS BOUND (394-17, step b): the port's two verbs now LEAD with `product`, so the
      // binding reads the run-outcome projection on its own primary key instead of guessing a
      // partition or serving every product's history under one file path.
      //
      // ASSEMBLED ABOVE rather than inline, because the gate-2 flip path is handed the SAME
      // bundle: one composition-level answer to "what does this project know about this suite",
      // reached by the funnel read op and by the evaluator's consultation alike.
      authoringFunnel,
      // 2026-10-01 (432-17, D-05/D-22): the proposals inbox (391 PROP-03) is not bound — it is deleted
      // with its ops. Old files under `<agentQaRoot>/proposals/` are never opened again.
      ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
      ...(input.feedbackReads === undefined ? {} : { feedbackReads: input.feedbackReads }),
      quarantine: createQuarantineOperations({
        resolveKnowledgeRoot: input.knowledgeRoot,
        now: () => clock.now(),
        mintIdentityPath: input.mintQuarantineIdentityPath,
        ...(input.resolveWriterAuthority === undefined
          ? {}
          : { resolveWriterAuthority: input.resolveWriterAuthority }),
      }),
      // 392 D-24: the turn engine assembled above. Bound HERE and therefore on BOTH hosts, so
      // `agent.ask` is a real capability wherever the composition root runs — and unbound nowhere,
      // which is what lets 397's parity suite read it off the registry with no chat-specific case.
      chatTurn: {
        // The engine also echoes authored clause text on receipts and refusal answers. Mask
        // the complete outward projection after execution, never the message it dispatches.
        runTurn: async turnInput =>
          projectChatMembers(await chatTurn.runTurn(turnInput), CHAT_TURN_RESULT_RULES, input.mask),
      },
      // 393 D-01 / D-15: the keep-gate evaluator's two host halves, bound HERE and therefore on
      // BOTH hosts — the CLI and 386's daemon compose this same root, which is the whole point of
      // 385 D-15 (a second binding site would be a second answer to "is this draft worth keeping",
      // and the two would disagree about a decision that gets written into a durable receipt).
      //
      // Conditionally spread on BOTH halves, because a capability that can parse but cannot run is
      // not a degraded evaluator — it is a host that must say `unbound` by name. `runs.start` is
      // dispatched through the registry this very call is about to produce, which is the same
      // deferred reference the chat engine takes and is safe for the same reason: no op can run
      // before the registry it is registered in has been built.
      ...(input.draftAuthoring === undefined || input.runExecution === undefined ? {} : {
        draftEvaluation: createDraftEvaluation({
          authoring: input.draftAuthoring,
          agentQaRoot: input.agentQaRoot,
          knowledgeRoot: input.knowledgeRoot,
          authoringFunnel,
          readRun: (runId) => runsReader.get(runId as RunId),
          startGateRun: async (request) => {
            if (composedRegistry === undefined) {
              throw new TypeError('a gate-run started before its registry finished composing')
            }
            return await invokeFunction(
              composedRegistry,
              RUNS_START_FUNCTION_ID,
              request,
              AUTHORING_GATE_RUN_CALLER,
            ) as RunStartAcknowledgement
          },
        }),
      }),
      // 394 D-01 / WTST-01: the authoring LOOP's two halves, bound HERE and therefore on BOTH
      // hosts, under the SAME condition the evaluator above is bound under — the loop's stage 4
      // dispatches `authoring.draft.verify`, so a host that cannot verify a draft cannot author
      // one either, and a third answer to "can this host author" would be a third thing to keep
      // in step.
      //
      // THE READ HALF IS `getAuthoringBrief`'S FIRST PRODUCTION CALLER. The port has been
      // implemented and unbound since v51 (`knowledge-local/src/serving/authoring-reader.ts`),
      // which means every field of its contract is crossing a real seam for the first time here;
      // a mismatch surfaces at this binding rather than in a surface. The reader is built PER
      // CALL over a freshly resolved knowledge root, on the standing-approval reader's stated
      // reasoning — the CLI resolves its root asynchronously and per call, and a root captured
      // once would serve a brief out of a knowledge tree the invocation is not serving from. No
      // `product` is bound: the composition does not own one, and the SCOPE arrives on the op's
      // input, which is the honest half of the pair the reader filters on.
      //
      // `suiteTextCorpus` is the SAME host walk gate 3's degraded lane already consumes, reached
      // here for stage 2's pre-authoring screen. One walk, one notion of what a suite test's text
      // is; a second enumeration would let the screen and the gate disagree about the same pair.
      //
      // THE WRITE HALF bundles the model, the shelf and the verify dispatch, because none of the
      // three is independently bindable: a host with a model and no shelf cannot author, one with
      // a shelf and no model has nothing to author with, and one that can do both but cannot
      // verify would produce a test and have nothing to say about whether it is worth keeping.
      // The model is a FACTORY, resolved at most once and only when a draft is actually compiled,
      // the same idiom `openJobs` uses — binding this capability must not construct a client for a
      // host that never authors.
      //
      // WHY THE ROUTER (plan 05) WILL READ `DraftRunPortLike.get`'s `CompletedRunHandoff` AND NOT
      // `runs.get`'s PROJECTION. D-08 routes on run EVIDENCE — step terminations, planning
      // failure, cycle flags, the per-step sub-action record — and `runs.get` projects a
      // `RunDetail` in which none of that survives (`stepCount` is its only step-shaped field).
      // This is `createDraftEvaluation`'s own posture, stated one layer out: the op is reached for
      // what an op owns, and the reader is read for evidence no projection carries. A router built
      // on the projection would have to infer a mechanics failure from a member verdict, and
      // inferring an app defect out of a bare member verdict is precisely the cardinal error D-08
      // exists to make unreachable.
      //
      // A NOTE FOR WHOEVER EDITS THIS PARAGRAPH. The arch dependency scan reads import specifiers
      // out of this file's RAW BYTES, comments included, so any prose shaped like an import's
      // trailing clause — the keyword, then a quoted phrase — is reported as an undeclared
      // external dependency of this package. Two drafts of this comment tripped it, once on a
      // sentence about verdicts and once on the sentence explaining the first. Keep quoted phrases
      // away from that keyword here.
      ...(authoringLoopHost === undefined ? {} : {
        authoringRead: {
          async getAuthoringBrief(intent: string, scope: ScopeKey): Promise<AuthoringBrief> {
            const knowledgeRoot = await input.knowledgeRoot()
            return createAuthoringReader({ knowledgeRoot }).getAuthoringBrief(intent, scope)
          },
          suiteTextCorpus: () => authoringLoopHost.suiteTextCorpus(),
          // 394-33 · WR-07: the `target` vocabulary stage 3's compile prompt serves. Bound off the
          // SAME port the brief and the corpus come from, so a host that can run the loop's read
          // stages can name its own targets by construction — see the port's own doc.
          configuredTargetNames: () => authoringLoopHost.configuredTargetNames(),
        },
        // 394-26 · WINDOWS 110: the scope an intent-only call is authored at, bound HERE and so on
        // BOTH hosts, off the same port the read and compile halves come from. Its own deps key
        // rather than a third verb on `authoringRead`, because deriving a scope needs the resolved
        // config and the workspace while the brief needs a knowledge index — a host can have one
        // without the other, and the op refuses on THIS key by name when a scope-less call arrives
        // at a composition that never bound it.
        authoringScope: {
          deriveDefault: () => authoringLoopHost.deriveDefaultScope(),
        },
        draftShelf: {
          model: async () => await input.model(),
          write: (contents: string) => authoringLoopHost.stageDraft(contents),
          // 394-06 D-09/D-20: the ONE RFC-6902 applier, reached at the host because it needs the
          // yaml CST and neither `agent` nor this package may depend on `core`. Same seam,
          // same reason and same shape as `stageDraft` right above it.
          applyPatches: (draft, patchSet) => authoringLoopHost.applyPatchesToDraft(draft, patchSet),
          // 432 D-06/D-07: the direct writer the loop's final write and the edit op reach. Same seam
          // and same reason as the two verbs above: the boundary check needs `core`.
          publish: (request) => authoringLoopHost.publishDraft(request),
          // 394-06: stage 5's evidence reader and the repair arm's probe runner. The reader is
          // the same `runsReader` the gate evaluator is bound to — a second reader would be a
          // second answer to what one run recorded — and the starter dispatches the REGISTERED
          // `runs.start` on the gate-run caller, so a probe is marker-stamped exactly as a gate
          // run is and is excluded from outcomes for the same reason.
          runs: {
            start: async (request): Promise<RunStartAcknowledgement> => {
              if (composedRegistry === undefined) {
                throw new TypeError('a repair probe started before its registry finished composing')
              }
              return await invokeFunction(
                composedRegistry,
                RUNS_START_FUNCTION_ID,
                request,
                AUTHORING_GATE_RUN_CALLER,
              ) as RunStartAcknowledgement
            },
            get: (runId: string) => runsReader.get(runId as RunId),
          },
          // 2026-10-01 (432-18/432-19, D-15): no dispatch-scoped grant exists. The authoring loop
          // runs its dispatch directly, and no gate run it starts consults any approval.
          verifyDraft: async (verifyInput: AuthoringVerifyDraftInput): Promise<DraftReceipt> => {
            if (composedRegistry === undefined) {
              throw new TypeError('a draft was verified before its registry finished composing')
            }
            return await invokeFunction(
              composedRegistry,
              AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
              verifyInput,
              AUTHORING_LOOP_VERIFY_CALLER,
            ) as DraftReceipt
          },
        },
        // 2026-10-01 (432-17, D-06): no authoring proposal writer is bound; an authored test is
        // written in its own call through the shelf's direct writer.
      }),
      // 432-16 (D-07): no test-draft or config commit port and no undo source is bound — agent-qa
      // makes no git commits. The final authored test is written through `draftShelf.publish`.
      //
      // 395-01 D-01/D-03/D-17 · CFGM-01/03/04: the config editor's host half, each spread on its
      // OWN condition rather than as one bundle, so a host missing one reports that one `unbound`.
      ...(input.configFiles === undefined ? {} : { configFiles: input.configFiles }),
      ...(input.configValidate === undefined ? {} : { configValidate: input.configValidate }),
      ...(input.scaffoldContent === undefined
        ? {}
        : { scaffoldContent: input.scaffoldContent }),
      ...(input.configWrite === undefined ? {} : { configWrite: input.configWrite }),
      // 2026-10-14 (441-39, D-15): a config change is not scanned for secrets, so no scan is bound.
      // 2026-10-01 (432-17, D-05): no config proposal filer is bound; the six config ops write in
      // the call through `configWrite`.
    },
    // 2026-10-15 (441-28, D-15): no audit sink; the guardrail audit went with the guardrails.
    // 432-13 (D-14/D-15): no standing-approval reader, confirm port or session deny overlay reaches
    // the registry — `invokeFunction` asks nobody. 432-18 deleted the grant reader with the ledger.
    // 2026-10-02 (432-39, D-12): the host's execution-context answer is no longer forwarded here.
    // The registry's option was retired and unread since 432-13 and is deleted; the same answer
    // still reaches the knowledge review above, which records a direct change under it.
  })
  // Closes the cycle the turn engine's dispatch binding was built against. It happens exactly
  // here, on the line after the registry exists, so there is no window in which a turn could run
  // against an unset reference — and the engine's own guard names that state if one ever appears.
  composedRegistry = registry

  let opened: LocalAgentJobs | undefined
  let opening: Promise<LocalAgentJobs> | undefined
  let closing: Promise<void> | undefined
  let lifecycleGeneration = 0
  let closed = false

  async function openJobs(openGeneration: number): Promise<LocalAgentJobs> {
    const model = await input.model()
    // Resolved ONCE at queue open, the same idiom as the model above: the post-run
    // capability members read synchronously, and the knowledge root is a process fact.
    const knowledgeRoot = await input.knowledgeRoot()
    const analysisTokenBudget = input.analysisTokenBudget === undefined
      ? undefined
      : await input.analysisTokenBudget()
    const store = createSqliteJobStore({
      path: join(input.agentQaRoot, AGENT_JOB_STORE_DB_FILE),
      clock,
      checkpoints: createJobCheckpointStore({ root: input.agentQaRoot }),
    })
    let jobs: LocalAgentJobs
    try {
      const kinds = input.jobKinds
        ?? createRealJobKindRegistry(
          postRunCapabilities(input, knowledgeRoot, analysisTokenBudget),
        )
      // Resolved ONCE and used for both the queue and the published field: the value a watcher
      // derives ids from has to be the value the queue mints them with, and two spellings of the
      // same default is how those two drift.
      const idSource = input.idSource ?? DIGEST_JOB_ID_SOURCE
      // Resolved ONCE from the one table, for the queue and the published field alike (388-10).
      //
      // A host with NO `postRun` folds to `'no-masker'` rather than to no exclusion (WR-12).
      // Silence is not a review: a host that never declared what its fold does with candidate
      // prose cannot have reviewed it, and the fail-safe reading of an undeclared posture is
      // the constrained one. 388-09's M-3 measured what the permissive reading costs — a
      // stand-in registry composed without `postRun` runs a `curate-memory` row to `done` and
      // publishes `bundle-committed`, a receipt no fold earned. Read through the same total
      // table as every other posture, so there is no fall-through here to drift from it.
      const unclaimableKinds: readonly JobKind[]
        = UNCLAIMABLE_BY_PROSE_POSTURE[input.postRun?.candidateProse ?? 'no-masker']
      jobs = {
        queue: createAgentJobQueue({
          store,
          registry: kinds,
          clock,
          idSource,
          model,
          ...(unclaimableKinds.length === 0 ? {} : { unclaimableKinds }),
        }),
        store,
        kinds,
        model,
        idSource,
        unclaimableKinds,
      }
    } catch (error) {
      store.close()
      throw error
    }
    if (closed || openGeneration !== lifecycleGeneration) {
      // The model can resolve after close. Constructing then invalidating here keeps the open
      // transactional: the late store proves it can initialize, but it never becomes reachable.
      store.close()
      throw new LocalAgentClosedError(input.agentQaRoot)
    }
    opened = jobs
    return jobs
  }

  return {
    registry,
    chat: {
      stateFor: (sessionId) => chatScopes.get(sessionId)?.state.read(),
      async abortActiveTurn(): Promise<void> {
        // D-19's GRACEFUL arm. The hard-kill arm needs nothing here — a torn tail is detected and
        // an `aborted` synthesized on the next open — but a Ctrl+C that got as far as running this
        // handler can say so explicitly, which is a better record than one reconstructed later.
        //
        // EVERY LIVE SESSION IS ASKED, AND EACH ANSWERS WITH ITS OWN TURN (392-12 shape, plan 13
        // state). Plan 12 could iterate the handles but had only ONE turn id to look for, because
        // `chatState` was per-composition — so on a host with two turns genuinely in flight, one
        // was nameable and the other was not. Each session now holds the id of the turn IT is
        // running, so graceful shutdown closes every conversation rather than the last one to
        // start. Between turns a session names nothing, and writing an `aborted` anyway would put
        // a row on a turn that already carries its `turn_complete` — which the next open's repair
        // would read as an interrupted turn and prune from the conversation.
        for (const [sessionId, entry] of liveChatSessions) {
          const turnId = chatScopes.get(sessionId)?.state.read().activeTurnId
          if (turnId === undefined) continue
          if (!entry.turnIds.has(turnId)) continue
          await entry.handle.append({
            kind: 'aborted',
            turnId,
            at: clock.now(),
            source: 'explicit',
          })
          // Fsynced immediately rather than at a turn boundary that is not coming: this is the
          // last thing this process writes, and an unflushed `aborted` is exactly the event the
          // repair it exists to make unnecessary would have to reconstruct.
          await entry.handle.turnBoundary()
        }
      },
    },
    curation: LOCAL_CURATION_CAPABILITIES,
    clock,
    jobs(): Promise<LocalAgentJobs> {
      if (closed) return Promise.reject(new LocalAgentClosedError(input.agentQaRoot))
      // Memoized on the PROMISE, not on the resolved value: two concurrent callers awaiting a
      // value-memoized opener would each run the factory and each open the database.
      opening ??= openJobs(lifecycleGeneration)
      return opening
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing
      closed = true
      lifecycleGeneration += 1
      const pending = opening
      const current = opened
      opened = undefined
      // Preserve the existing synchronous-close property for a fully opened composition. Callers
      // that historically did not await close still release the handle before returning.
      current?.store.close()
      closing = (async () => {
        if (pending !== undefined) {
          try {
            const late = await pending
            if (late !== current) late.store.close()
          } catch {
            // A superseded opener closes its own store; a model/open failure owns no live handle.
          }
        }
        opening = undefined
      })()
      return closing
    },
  }
}
