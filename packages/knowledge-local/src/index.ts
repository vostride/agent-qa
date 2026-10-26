import type { KnowledgePort } from '@vostride/agent-qa-agent'
import type { KnowledgeHintReader } from '@vostride/agent-qa-runner'

export { foldCurationSnapshot, readCurationEffects } from './curator/curation-snapshot.js'
export type { ReadCurationEffectsOptions } from './curator/curation-snapshot.js'

export {
  readQueuedCanaryPayload,
  PAYLOAD_BENEFITS,
} from './canary-emit.js'
export type { QueuedCanaryPayloadRead } from './canary-emit.js'

// 387 ENTY-01 — entity addressing: the durable ledger and the tier-(a) resolver.
//
// The composition root is the only importer of this entry (the reader carve-out enforces
// that), so a surface reaching the resolver goes through composeLocalAgent and the function
// layer rather than around them.
export {
  ADDRESSING_LEDGER_BUSY_TIMEOUT_MS,
  ADDRESSING_LEDGER_DB_FILE,
  ADDRESSING_LEDGER_USER_VERSION,
  AddressingLedgerSchemaVersionError,
  openAddressingLedger,
} from './addressing/ledger.js'
export type {
  AddressingLedger,
  EntityAddress,
  OpenAddressingLedgerOptions,
  TargetRename,
} from './addressing/ledger.js'
export {
  describeAllEntities,
  getEntityDescriptor,
  resolveEntityRef,
  // 387 D-01: the sighting leg, published so the LIST-VERB sighting site mints through the
  // same mechanism the resolver's own hit does rather than through a second copy of it.
  sightEntity,
} from './resolver/resolve.js'
export {
  RESOLVER_CANDIDATE_K,
  RESOLVER_FUSED_SCORE_NORMALIZER,
  RESOLVER_LEG_WEIGHT_DENSE,
  RESOLVER_LEG_WEIGHT_LEXICAL,
  RESOLVER_LEXICAL_MIN_BM25,
  RESOLVER_STRONG_HIT_MARGIN,
  RESOLVER_STRONG_HIT_MIN_SCORE,
} from './resolver/constants.js'
export type {
  EntitySighting,
  EntitySightingSource,
  ResolveEntityRefDeps,
} from './resolver/resolve.js'
export { createMemorySightingSource } from './resolver/memory-source.js'
// The D-06 projection. Composed retrieval STAGES stay off this barrel (the D-13 rule the
// barrel-surface suite pins): what a composition root needs is the ability to open, maintain
// and rebuild the projection, never the legs the resolver runs over it.
export {
  ENTITY_INDEX_DB_FILE,
  ENTITY_INDEX_SWEEP_INTERVAL_MS,
  ENTITY_INDEX_USER_VERSION,
  EntityIndexSchemaVersionError,
  embedPendingEntities,
  entityIndexDbPath,
  openEntityIndex,
  rebuildEntityIndex,
  refreshEntity,
  sweepEntityIndex,
} from './entity-index/entity-index.js'
export type {
  EntityIndexHandle,
  EntityIndexSweepReport,
  OpenEntityIndexOptions,
} from './entity-index/entity-index.js'

// 2026-10-01 (432-18, D-14/D-15/D-22): the committed standing-grant ledger, its reader and the grant
// verbs are deleted. An old `grants.jsonl` stays on disk and nothing in this package opens it.
// 390 D-01/D-03/D-11: the committed quarantine ledger — read, pure state fold. The event DTOs and
// the state vocabulary live in schema; this package owns the bytes and the fold over them.
// The APPEND is deliberately NOT published (390-11 / WR-07): it writes a committed artifact whose
// unserialized-third-caller residual is real, and a smaller public write surface is a smaller
// residual. The three in-package writers — the verbs, detection, and the run-outcome projection —
// import it from './quarantine/ledger.js' directly, so nothing outside was withheld from anyone.
export {
  QUARANTINE_LEDGER_FILENAME,
  foldQuarantineLedgerState,
  quarantineLedgerPath,
  readQuarantineLedger,
} from './quarantine/ledger.js'
export type {
  QuarantineAppendOutcome,
  QuarantineLedgerRead,
  RefusedQuarantineLine,
} from './quarantine/ledger.js'
// 390 D-05/D-06/D-07/D-10: the detection ladder's pure rule and its pinned thresholds. Plan 06's
// provider composes these; QUARANTINE_WINDOW_ORDINALS is deliberately absent here because it is
// already published below from the window read that declares it — one symbol, one export site.
export {
  AUTO_QUARANTINE_CLASSES,
  QUARANTINE_AUTO_EXIT_PASSES,
  QUARANTINE_CLASS_DISPOSITIONS,
  QUARANTINE_DEFAULT_EXPIRY_DAYS,
  QUARANTINE_ESCALATE_THRESHOLD,
  QUARANTINE_FLAG_FLOOR,
  evaluateQuarantineDetection,
} from './quarantine/detection.js'
export type {
  EvaluateQuarantineDetectionInput,
  QuarantineDetectionFailure,
  QuarantineDetectionResult,
  QuarantineDetectionSighting,
  QuarantineDetectionTestWindow,
  QuarantineDisposition,
  QuarantineOrdinalOutcome,
} from './quarantine/detection.js'
// 390 D-12/D-13: the three verbs' one implementation. The PORT type lives in schema (both `agent`
// and this package consume it and neither may import the other); what is published here is the
// factory the composition root binds, plus the two literals a manual entry records where an auto
// entry records a real fingerprint.
// `QuarantineIdentityRefusedError` is on the barrel (390-12) because a surface rendering
// `quarantine.add` needs to tell an operator WHY a path was refused, and an error it cannot name
// is an error it renders as "unknown". Its blocked-write sibling went with the committed-egress
// check (441-41, D-15). This is an
// error type, not a power — `underWriterLease` and `appendQuarantineEvents` stay off the barrel,
// where 390-11 put the second one, because the committed-write surface only ever shrinks.
export {
  QUARANTINE_MANUAL_ENTRY_CLASS,
  QUARANTINE_MANUAL_ENTRY_FINGERPRINT,
  QuarantineIdentityRefusedError,
  createQuarantineOperations,
} from './quarantine/operations.js'
export type { QuarantineOperationsOptions } from './quarantine/operations.js'
export {
  ARTIFACT_RUN_CAP_BYTES,
  ARTIFACT_STEP_CAP_BYTES,
  copyArtifacts,
} from './artifact-copy.js'
export type {
  ArtifactCopyInput,
  ArtifactCopyResult,
  CopiedArtifact,
  SkippedArtifact,
} from './artifact-copy.js'
export { renderBundleParts } from './bundle-parts.js'
export type {
  BundleProvenanceInput,
  RenderBundlePartsInput,
  RenderedBundlePart,
} from './bundle-parts.js'
export type {
  BundleStoreConfig,
  PublishBundleInput,
  PublishBundleOutcome,
} from './bundle-publish.js'
/** @internal Test-fixture seeding only; production mutation paths must use fenced commit APIs. */
export { publishBundle as publishBundleForTest } from './bundle-publish.test-helper.js'
export {
  MEASUREMENTS_REL_PATH,
  appendMeasurementObservation,
  appendOutcomeEvent,
  appendRelation,
  writeMeasurementBaseline,
} from './bundle-append.js'
export type { AppendOutcome } from './bundle-append.js'
export {
  deriveBundleTrust,
  loadBundle,
  readMeasurements,
  verifyBundleIntegrity,
} from './bundle-read.js'
export type {
  IntegrityReport,
  LoadedBundle,
  LoadBundleOutcome,
  Measurements,
} from './bundle-read.js'
export {
  enumerateBundleDirs,
  isServable,
  readCanonicalBundleAnchors,
  scanBundleById,
  scanBundles,
} from './bundle-scan.js'
export type {
  CanonicalBundleAnchorLookup,
  EnumeratedBundleDir,
  KnowledgeHit,
  ScanBundleByIdOptions,
  ScanBundlesOptions,
} from './bundle-scan.js'
export {
  CHECKPOINT_EVERY_N_BUNDLES,
  embeddingProfileKey,
  INDEX_DB_FILE,
  INDEX_RENDERING_SCHEMA_VERSION,
  INDEX_SCHEMA_VERSION,
  indexDbPath,
  openIndexReaderConnection,
  openIndexWriter,
  probeIndexHealth,
  READER_BUSY_TIMEOUT_MS,
  REQUIRED_INDEX_TABLES,
  resolveActiveProfile,
  resolveVecCapability,
  vecTableName,
  WRITER_BUSY_TIMEOUT_MS,
} from './index-open.js'
export type {
  IndexHealth,
  IndexReaderConnection,
  IndexWriterHandle,
  VecCapability,
} from './index-open.js'
export {
  KnowledgeRecordNotFoundError,
  openKnowledgeReader,
} from './serving/reader.js'
export type { OpenServingKnowledgeReaderConfig } from './serving/reader.js'
export {
  AUTHORING_BRIEF_DEFAULT_BUDGET,
  AUTHORING_DENSE_K,
  createAuthoringReader,
} from './serving/authoring-reader.js'
export type { AuthoringReaderDependencies } from './serving/authoring-reader.js'
export {
  assembleAuthoringBrief,
  AUTHORING_EXCERPT_CHAR_BUDGET,
  AUTHORING_EXEMPLAR_CAP,
  AUTHORING_PROCEDURE_CAP,
} from './serving/get-authoring-brief.js'
export type {
  AssembleAuthoringBriefInput,
  AssembledAuthoringBrief,
  AuthoringEntryCandidate,
  AuthoringExemplarRow,
  AuthoringTestRef,
} from './serving/get-authoring-brief.js'
export {
  CHANNEL_1_SERVING_LEG,
  CHANNEL_3_CAUTION_LEG,
  SERVING_TRACE_LEGS,
} from './serving/serve-trace.js'
export { classifyIndexFace } from './index-reader.js'
export type {
  DenseHit,
  DenseSearchOptions,
  IndexFace,
  KnowledgeReader,
  KnowledgeSearchOptions,
  OpenKnowledgeReaderOptions,
} from './index-reader.js'
// Main entry only. The resolver opens an index probe and may load a model, so it is not
// reader-entry material — the `./reader` subpath stays the cheap read face.
export { foldRetrievalRung, resolveRetrievalRung } from './retrieval-rung.js'
export type {
  EmbedderAxis,
  IndexAxis,
  ResolveRetrievalRungOptions,
} from './retrieval-rung.js'
export { buildRetrievalQuery } from './query-helper.js'
export type { RetrievalQuery, RetrievalQueryInput } from './query-helper.js'
export { retrieve } from './retrieve.js'
export type { RetrieveOptions, RetrieveResult } from './retrieve.js'
export { rebuildIndex } from './index-rebuild.js'
export type {
  RebuildIndexHooks,
  RebuildIndexOptions,
  RebuildMutationFamily,
  RebuildReport,
} from './index-rebuild.js'
export { readLatestBuildOrdinal } from './build-ordinal-read.js'
export {
  applyRunOutcomes,
  foldRunOutcomes,
  LAST_OUTCOMES_LIMIT,
  projectRunOutcomes,
  rebuildRunOutcomes,
  reconcileRunOutcomesProjection,
  RUN_OUTCOMES_PROJECTION_VERSION,
} from './projection/run-outcomes.js'
export type {
  ApplyRunOutcomesResult,
  ExtractStepAnchors,
  FoldRunOutcomesOptions,
  FoldRunOutcomesReport,
  ProjectRunOutcomesOptions,
  QuarantineDetectionOptions,
  QuarantineFoldOutcome,
  RebuildRunOutcomesOptions,
  RebuildRunOutcomesReport,
  ReconcileRunOutcomesProjectionOptions,
  ReconcileRunOutcomesProjectionResult,
  RunOutcomeFailureKey,
  RunOutcomesProjection,
  RunOutcomeTestDelta,
} from './projection/run-outcomes.js'
// 389 ANLZ-03 — the run-outcome projection's read side: per-test failure history keyed
// (product, filePath, testName), plus the two pure derivations 389's consumers compose
// (D-02 prior-build discriminator channel; D-08 live kth-failure recurrence join).
export {
  failureRecurrence,
  listTestsInFile,
  priorBuildOutcome,
  readTestOutcomeHistory,
} from './projection/run-outcome-read.js'
export type {
  FailureRecurrence,
  TestOutcomeEntry,
  TestOutcomeHistory,
  TestOutcomeIdentity,
} from './projection/run-outcome-read.js'
// 390 FLAK-01 — the fingerprint-keyed recurrence window: detection's substrate, read per query
// over the sliding ordinal window (D-07). Keyed by (product, fingerprint), never testId.
export {
  fingerprintRecurrence,
  QUARANTINE_WINDOW_ORDINALS,
  readFingerprintWindow,
} from './projection/fingerprint-window-read.js'
export type {
  FingerprintRecurrence,
  FingerprintWindowIdentity,
  FingerprintWindowRow,
} from './projection/fingerprint-window-read.js'
// 393 D-15 WTST-06 — the suite-fingerprint table: gate 3's comparison substrate, folded by the
// same pass as the run-outcome projection and read through `createSuiteFingerprintIndex`. Keyed
// by the stable (filePath, testName) identity, never testId; gate-run handoffs never enter it.
export {
  applySuiteFingerprints,
  createSuiteFingerprintIndex,
  foldSuiteFingerprints,
  SUITE_FINGERPRINTS_TABLE,
  suiteFingerprintDeltas,
  testFingerprintElements,
} from './projection/suite-fingerprints.js'
export type {
  FoldSuiteFingerprintsOptions,
  SuiteFingerprintIndex,
  SuiteFingerprintIndexOptions,
  SuiteFingerprintsProjection,
  SuiteFingerprintTestDelta,
} from './projection/suite-fingerprints.js'
export { GC_SUPERSEDED_RETAIN_K, runKnowledgeGc } from './gc.js'
export type {
  GateHorizon,
  GcSummary,
  RunKnowledgeGcHooks,
  RunKnowledgeGcInput,
} from './gc.js'
export { setActiveEmbeddingProfile } from './profile-migration.js'
export type {
  MigrationOutcome,
  SetActiveEmbeddingProfileOptions,
} from './profile-migration.js'
export {
  dropEmbedCacheForModel,
  ensureEmbedCacheTable,
  getCachedEmbedding,
  putCachedEmbedding,
  wrapEmbedderWithCache,
} from './embed-cache.js'
export type {
  EmbedCacheLeg,
  EmbedCacheLookup,
  EmbedCacheMode,
  EmbedCachePut,
  EmbedCacheWrapperOptions,
} from './embed-cache.js'
export {
  createFloorEmbedder,
  FloorAssetLoadError,
  FloorEmbeddingError,
  loadFloorAssets,
} from './embedder-floor.js'
export type {
  FloorAssetLoadErrorCode,
  FloorAssetLoadOptions,
  FloorAssets,
  FloorEmbeddingErrorCode,
} from './embedder-floor.js'
export {
  createNativeEmbedder,
  NativeEmbeddingDimensionError,
  NativeEmbeddingModuleLoadError,
} from './embedder-native.js'
export {
  MODEL_CACHE_DIR_ENV_VAR,
  resolveModelCacheDir,
} from './model-cache-dir.js'
export {
  acquireEmbedder,
  discoverEmbedderWorker,
  resetEmbedderCapability,
  resolveEmbedderCapability,
} from './embedder-acquire.js'
export type {
  AcquireEmbedderOptions,
  AcquireEmbedderOutcome,
  DeferReason,
  DiscoverEmbedderWorkerOptions,
  EmbedderProbes,
  EmbedderRung,
  EmbedderWorkerPolicy,
  ResolveEmbedderCapabilityOptions,
  WorkerDiscoveryResult,
} from './embedder-acquire.js'
export type { EmbedderPort } from './embedder-port.js'
export {
  EMBEDDER_WORKER_REQUEST_TIMEOUT_MS,
  EMBEDDER_WORKER_REGISTRATION_FILE,
  EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION,
  EMBEDDER_WORKER_START_TIMEOUT_MS,
  EMBEDDER_WORKER_TERM_GRACE_MS,
  EMBEDDER_WORKER_UNVERIFIABLE_INCARNATION,
  EmbedderWorkerTimeoutError,
  embedderWorkerProcessIsAlive,
  embedderWorkerSocketPath,
  probeEmbedderWorkerSocket,
  readEmbedderWorkerRegistration,
  removeEmbedderWorkerRegistration,
  writeEmbedderWorkerRegistration,
} from './embedder-worker/worker-registration.js'
export { verifyEmbedderWorkerIncarnation } from './embedder-worker/worker-incarnation.js'
export type {
  EmbedderWorkerIncarnationVerdict,
  EmbedderWorkerTimeoutPhase,
  EmbedderWorkerRegistration,
  ReadEmbedderWorkerRegistrationOutcome,
} from './embedder-worker/worker-registration.js'
export {
  clearRebuildRequest,
  readRebuildRequest,
  REBUILD_MARKER_FILE,
  requestRebuild,
} from './rebuild-marker.js'
export type {
  ReadRebuildRequestOutcome,
  RebuildReason,
  RebuildRequest,
  RequestRebuildOptions,
} from './rebuild-marker.js'
export {
  CURATION_QUEUE_SCHEMA_VERSION,
  buildCurationCandidateAddressFields,
  candidateContentAddress,
  curationArtifactDescriptorSchema,
  curationArtifactRoleSchema,
  curationCandidatePayloadSchema,
  curationCandidateProjectionSchema,
} from './queue/queue-payload.js'
export type {
  BuildCurationCandidateAddressFieldsInput,
  CurationArtifactDescriptor,
  CurationArtifactRole,
  CurationCandidateAddressFields,
  CurationCandidateArtifact,
  CurationCandidatePayload,
  CurationCandidateProjection,
} from './queue/queue-payload.js'
export {
  CLAIMED_SUBDIR,
  claimedCandidateDir,
  claimedLeaseDir,
  claimedRoot,
  JOBS_SUBDIR,
  jobStatePath,
  jobsRoot,
  QUEUE_DIR,
  QUEUE_MAX_EMITS_PER_RUN,
  QUEUE_MAX_JOBS_PER_SCOPE,
  queueRoot,
  queueStagingRoot,
  QUEUED_SUBDIR,
  queuedCandidateDir,
  queuedRoot,
} from './queue/queue-layout.js'
export {
  claimNextJob,
  countPendingCurationJobs,
  countRemainingCurationWork,
  enqueueCurationCandidate,
  enqueueCurationCandidateProjection,
  inspectDrainableCurationWork,
  listClaimedLeases,
  listQueuedCandidates,
  readCurationCandidatePayload,
  quarantineClaimed,
  requeueClaimed,
} from './queue/curation-queue.js'
export type {
  ClaimedCurationJob,
  ClaimNextJobOptions,
  CountRemainingCurationWorkOptions,
  CurationQuarantineReason,
  CurationRemainingWork,
  ClaimNextJobOutcome,
  CurationEnqueueRefusalReason,
  CurationProjectionArtifactSource,
  DrainableCurationWork,
  EnqueueCurationCandidateProjectionOptions,
  EnqueueCurationCandidateProjectionOutcome,
  InspectDrainableCurationWorkOptions,
  MalformedClaimedCurationJob,
  ReadCurationCandidatePayloadOutcome,
  QuarantineClaimedOptions,
  RequeueClaimedOptions,
} from './queue/curation-queue.js'
export {
  CURATION_JOB_STATE_SCHEMA_VERSION,
  curationJobStateSchema,
  persistAuthoredCheckpoint,
  readJobState,
  writeJobState,
} from './queue/job-state.js'
export type {
  CurationJobLifecycle,
  CurationJobState,
  PersistAuthoredCheckpointOptions,
  PersistAuthoredCheckpointOutcome,
  ReadJobStateOutcome,
  WriteJobStateOptions,
} from './queue/job-state.js'
export { COMMIT_INTENT_SCHEMA_VERSION } from './journal/intent-journal.js'
export {
  AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  authoredCheckpointSchema,
  parseAuthoredCheckpoint,
  resolveDispositionProfile,
  sliceAuthoredCheckpoint,
  widenAuthoredDeltaCheckpoint,
} from './curator/author-contract.js'
export type {
  AuthoredCheckpoint,
  AuthoredDeltaCheckpoint,
  AuthorOutcome,
  CurationJobView,
  CuratorAuthor,
  DispositionProfile,
  NeighborRecord,
} from './curator/author-contract.js'
export {
  applyIndexDeltaForBundle,
  commitCurationDelta,
  deriveIndexRowFromBundle,
} from './curator/commit.js'
export type {
  ApplyIndexDeltaForBundleInput,
  CommitCurationDependencies,
  CommitCurationJob,
  CommitCurationOutcome,
  EmptyDeltaCause,
} from './curator/commit.js'
export {
  BLAST_RADIUS_MAX_SUPERSEDES_PER_ANCHOR_PER_DRAIN,
  CITED_ID_INTEGRITY_CONDITIONS,
  UserDeltaCitationIntegrityError,
  disposeDelta,
} from './curator/disposition.js'
export type {
  CitedIdIntegrityCondition,
  DisposeDeltaInput,
  DispositionCandidateContext,
  DispositionDrainState,
  DispositionOutcome,
  ProcedureDispositionEvidence,
  RelationIntent,
} from './curator/disposition.js'
export {
  DRAIN_BUDGET_MS,
  EMBED_CRASH_VECTORLESS_THRESHOLD,
  SEARCH_BEFORE_CREATE_MAX_QUERIES,
  drainQueue,
} from './curator/drain.js'
export type {
  CurationDrainLifecycleEvent,
  DrainFailure,
  DrainFailureStage,
  DrainNoop,
  DrainOptions,
  DrainPromotionOutcome,
  DrainReport,
  GcPassReport,
  WriterPassReport,
} from './curator/drain.js'
export { runMaintenanceTail } from './curator/maintenance.js'
export type {
  MaintenanceBudget,
  MaintenanceOperations,
  MaintenanceSkipReason,
  MaintenanceTailFailure,
  MaintenanceTailResult,
  RunMaintenanceTailOptions,
} from './curator/maintenance.js'
/**
 * IN-04: `ACQUIRE_WRITER_LEASE_DEADLINE_MS` and `WriterLeaseUnreclaimableError` are deliberately
 * NOT re-exported here. Nothing outside `lease/writer-lease.ts` imported either one, and the CLI —
 * the only surface that renders the refusal — reaches this package through `agent-local`'s
 * composition edge, so binding them would have meant widening a second package's surface to keep a
 * symbol company. The refusal is still fully legible to consumers: `AcquireWriterLeaseOutcome`
 * carries the error instance and its `reason` literal, which is what every call site renders.
 */
export {
  acquireWriterLease,
  CorruptEpochStateError,
  deriveWriterLeaseFreshness,
  EPOCH_FILE,
  heartbeatLease,
  isLeaseStale,
  LEASE_FILE,
  LEASE_GUARD_DIR,
  LEASE_HEARTBEAT_TTL_MS,
  MUTATION_LOCK_BUSY_TIMEOUT_MS,
  MUTATION_LOCK_TAKEOVER_MS,
  readWriterLease,
  refreshWriterLeaseAuthority,
  releaseLease,
  resolveProcessIncarnation,
  withCurrentWriterAuthority,
  WRITER_AUTHORITY_DB_FILE,
  WriterAuthorityLostError,
} from './lease/writer-lease.js'
export type {
  AcquireWriterLeaseOptions,
  AcquireWriterLeaseOutcome,
  UnreclaimableMutationLockOwner,
  CorruptEpochStateReason,
  CurrentWriterAuthority,
  CurrentWriterAuthorityHooks,
  HeartbeatLeaseOutcome,
  LeaseOperationOptions,
  ReadWriterLeaseOutcome,
  ReleaseLeaseOutcome,
  WriterLease,
  WriterAuthorityLostReason,
  WriterLeaseAuthority,
  WriterLeaseFreshness,
} from './lease/writer-lease.js'
export {
  guardPurgeReceipt,
  PurgeChronologyRequiredError,
  PurgeCompletionVerificationError,
  PurgeQueueIdentityError,
  PURGE_RECEIPT_SCHEMA_VERSION,
  PurgeReceiptSchema,
  PurgeTargetChangedError,
  PurgeTargetIntegrityError,
  purgeAffectedSetFingerprint,
  purgeReceiptSchema,
  purgeRecord,
  resolvePurgeAffectedSet,
} from './purge.js'
export type {
  PurgeAffectedSet,
  PurgeReceipt,
  PurgeRecordInput,
  PurgeRecordOutcome,
} from './purge.js'
export { inspectRecords, toInspectRecordView } from './inspect.js'
export type { InspectRecordsOptions } from './inspect.js'
export { diffSince } from './diff-since.js'
export type { DiffSinceOptions } from './diff-since.js'
export { showRecord } from './show-record.js'
export type { ShowRecordOptions } from './show-record.js'

// 387-08 KREV-01 D-17/D-18/D-19: the knowledge review write path. Published through the WRITER
// entry and deliberately not through `/reader`: this is the one path a change's bytes take.
// 2026-10-01 (432-17, D-05/D-22): the propose half, the proposals store, its claim/rename machinery
// and the inbox are deleted; a change applies in the call and old proposal files are never read.
export { FORGET_SCRUBBED_PROJECTIONS } from './review/propose-review.js'
export type { ResolveBundleShortId, ReviewChangeRequest } from './review/propose-review.js'
export {
  APPLY_DELEGATE_TIMEOUT_MS,
  ApplyDelegateTimeoutError,
  ApplyDelegateUnavailableError,
  ReviewTargetVanishedError,
  // 432-06 D-04/D-05: the direct door — a validated explicit change applied in the call, with
  // no envelope, in every execution context. The explicit store entry beneath it stays internal.
  applyExplicitReview,
} from './review/apply-review.js'
export type {
  ApplyExplicitReviewInput,
  ExplicitReviewDelegate,
  ExplicitReviewDelegation,
  ExplicitReviewRequest,
  ExplicitReviewResult,
} from './review/apply-review.js'
// 393 D-19 WTST-02 — the draft-receipts store: the atomic-file store idiom applied to keep-gate
// receipts. One schema-versioned `<contentDigest>.json` per draft under the gitignored
// `<agentQaRoot>/draft-receipts/`, written atomically, refs never run payloads.
export {
  createDraftReceiptsStore,
  DRAFT_RECEIPTS_DIR_NAME,
  DraftReceiptDigestError,
  DraftReceiptSchemaVersionError,
  draftReceiptsDir,
} from './authoring/draft-receipts-store.js'
export type {
  DraftReceiptsStore,
  DraftReceiptsStoreOptions,
} from './authoring/draft-receipts-store.js'
export { KnowledgeMaintenanceScanError } from './maintenance-scan.js'
export type { KnowledgeMaintenanceScanIssue } from './maintenance-scan.js'
export {
  resolveRollbackAffectedSet,
  rollbackAffectedSetFingerprint,
  rollbackCampaign,
  RollbackCausalityError,
  rollbackCurationJob,
  RollbackPlanChangedError,
  rollbackReceiptId,
} from './rollback.js'
export type {
  RollbackAffectedSet,
  RollbackCampaignInput,
  RollbackCounterEvent,
  RollbackCurationJobInput,
  RollbackKind,
  RollbackPlannedEffect,
  RollbackReport,
  ResolveRollbackAffectedSetInput,
} from './rollback.js'
export {
  createLocalKnowledgeStore,
  KnowledgeCommitError,
  KnowledgePromotionError,
  KnowledgeStoreNotImplementedError,
  KnowledgeUnsupportedDeltaError,
} from './curator/knowledge-store.js'
export type {
  CreateLocalKnowledgeStoreConfig,
  KnowledgePromotionErrorReason,
  PromotionOutcomeReport,
} from './curator/knowledge-store.js'

export type LocalKnowledgeStore = KnowledgePort
export type LocalKnowledgeReader = KnowledgeHintReader
// 416 D-03/D-04: committed gate part read/write seams (writer entry only).
export { GATES_REL_PATH, readGateReceipts } from './bundle-read.js'
export { appendGateReceipt, appendPromotionReceipt } from './bundle-append.js'
export { MUTABLE_BUNDLE_TARGETS } from './journal/bundle-mutation.js'

// 2026-09-08, 419: deterministic user-mark drafting (writer entry only).
export { applyFeedback, triageMark, selectFixKind, assertionDrift, procedureReadOn,
  servedIdsOn, type ApplyFeedbackInput, type ServedRecordFacts, type MarkTriage,
  type FixSelection } from './feedback/apply-feedback.js'
export { floorProse, type FloorProseInput } from './feedback/floor-prose.js'
export { MarkPlanIntegrityError } from './review/propose-review.js'
export { appendMarkEvidence, MARK_EVIDENCE_TOKEN_PREFIX, type AppendMarkEvidenceInput,
  type AppendMarkEvidenceOutcome } from './feedback/mark-evidence.js'
export { markEvidenceEvent, planMarkEvidence, projectMarkEvidenceOutcome, type MarkEvidenceEffect,
  type MarkEvidencePlan, type MarkEvidenceTarget, type PlanMarkEvidenceInput } from './feedback/mark-evidence-plan.js'
export { materializePolicy, policySectionMarkers, policyShelfPath, PolicyTextRefusedError } from './policy/materialize.js'
export type { MaterializePolicyInput, MaterializeOutcome } from './policy/materialize.js'
