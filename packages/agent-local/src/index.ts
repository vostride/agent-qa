import type { PersistencePort } from '@vostride/agent-qa-agent'

// Approvals and patches only; the job store stays off this barrel so the host owns its one opening.
export type LocalPersistenceStore = PersistencePort

// Published because every host shares it; a host that cannot reach it re-derives it.
export {
  buildMemberRunConfig,
  buildRunPorts,
  buildScreenshotCompressor,
  buildSuiteMemberExecutor,
  registerAdapterLiveStream,
  computeRunConfigDigests,
  createSuiteLifecycle,
  SUITE_LIFECYCLE_LANE,
  SuiteBoundaryWhileLiveError,
  openRunKnowledgeComposition,
  resolveBuildTagSetting,
  resolveRunBuildOrdinal,
  resolveRunExecutionContext,
  toMemberTest,
} from './composition/run-composition.js'
export type {
  BuildMemberRunConfigInput,
  OpenRunKnowledgeCompositionInput,
  RetrievalRungResolver,
  RunConfigDigests,
  RunDigestMemberInput,
  RunExecutionContext,
  RunKnowledgeComposition,
  RunPersistencePorts,
  SuiteLifecycle,
  SuiteLifecycleHooks,
  SuiteMemberLease,
  SuiteMemberBinding,
} from './composition/run-composition.js'

export type {
  AttachableRunSession,
  RunSubscriberHandle,
} from './composition/presentation-ports.js'

export {
  BRIEF_CEILING,
  BRIEF_FRACTION,
  CAUTION_FRACTION,
  computeKnowledgeBudgets,
  GLOBAL_RECORD_CAP,
  MIN_BRIEF,
  MIN_CAUTION,
  MIN_MEMORY_TOOL_CONTEXT_WINDOW,
  memoryToolGate,
  READ_BODY_FRACTION,
  scaledRecordCap,
  WEAK_MODEL_CAP_SCALE,
} from './composition/knowledge-budgets.js'
export type {
  ComputeKnowledgeBudgetsInput,
  KnowledgeBudgets,
} from './composition/knowledge-budgets.js'

export {
  constructKnowledgeReader,
  createFrozenKnowledgeReader,
} from './composition/knowledge-reader.js'
export type { ConstructKnowledgeReaderInput } from './composition/knowledge-reader.js'

// The one in-process run invocation core, and the typed refusals it can raise: an id it would not
// have minted, and an id that already belongs to a run, told apart without reading a message.
// Published for the reason the run composition is: it is the seam every host is supposed to share,
// and a host that cannot reach it composes a run of its own.
export {
  createRunInvocationCore,
  RunIdAlreadyInUseError,
  RunIdNotMintedError,
} from './composition/run-invocation-core.js'
export type {
  RunAssembler,
  RunAssemblyContext,
  RunInvocationCoreOptions,
} from './composition/run-invocation-core.js'
// Types re-exported so a host can write a `RunAssembler` without naming the runner package.
export type {
  BaselineProbeResult,
  ConfigDigests,
  MemberTestExecutor,
  // A host writing `postVerdict` needs this shape, so it travels the assembler's hop.
  PostVerdictOutcome,
  PostVerdictPort,
  PostVerdictStepInput,
  RunConfig,
  RunMemberDescriptor,
} from './composition/run-invocation-core.js'
// The CLI drive's two symbols; see the module for why they stay out of the core.
export { mapVerdictToExitCode, runSafetyScope } from './composition/run-drive-vocabulary.js'
// One reader over the runner's store, shared by the analysis job, `runs.artifact` and dashboard.
export { createEvidenceBlobReader, lookupEvidenceBlob, readEvidenceBlobBytes, statEvidenceBlob } from './composition/evidence-blob-reader.js'
export type { CreateEvidenceBlobReaderInput } from './composition/evidence-blob-reader.js'

// The run host calls it at both `startRun` sites and sees only the resolved plain data.
export { resolveRunQuarantineSnapshot } from './composition/quarantine-snapshot.js'
export type { RunQuarantineSnapshotInput } from './composition/quarantine-snapshot.js'

// The gate's tables, so the withheld-line render and `autoQuarantines` read one vocabulary.
export {
  QUARANTINE_CLASS_DISPOSITIONS,
  QUARANTINE_FLOOR_ELIGIBILITY,
} from './composition/quarantine-vocabulary.js'
export type {
  QuarantineDisposition,
  QuarantineFloorEligibility,
} from './composition/quarantine-vocabulary.js'

// Published so hosts call it instead of wiring their own; `host.jobs()` is the host's own store.
export {
  // An explicit knowledge change applied in the call, used by the mark host.
  applyKnowledgeChange,
  composeLocalAgent,
  createKnowledgeReader,
  createKnowledgeReview,
  createLocalRunInvocation,
  createRunsReader,
  DIGEST_JOB_ID_SOURCE,
  DRAIN_BUDGET_MS,
  EMBEDDER_WORKER_REGISTRATION_FILE,
  EMBEDDER_WORKER_START_TIMEOUT_MS,
  EMBEDDER_WORKER_TERM_GRACE_MS,
  EmbedderWorkerTimeoutError,
  ENTITY_INDEX_SWEEP_INTERVAL_MS,
  LOCAL_CURATION_CAPABILITIES,
  LOCAL_DAEMON_CAPABILITIES,
  // Read-only probes `doctor` grades its trust rows with; the CLI may not name knowledge-local.
  LOCAL_KNOWLEDGE_PROBES,
  LocalAgentClosedError,
  RunProducedNoEventsError,
  // The one retrieval-rung resolver, published so both CLI run doors can hand it in.
  resolveHostRetrievalRung,
  SYSTEM_CLOCK,
  sweepEntityIndexProjection,
  UNCLAIMABLE_BY_PROSE_POSTURE,
} from './composition/compose-local-agent.js'

// The chat stage callers, published so the parity suite names them rather than spelling its own.
export {
  CHAT_PLANNER_CALLER,
  CHAT_RESOLVER_CALLER,
} from './composition/compose-local-agent.js'

export type {
  ApplyKnowledgeChangeInput,
  CandidateProsePosture,
  ExplicitReviewDelegate,
  ExplicitReviewDelegation,
  ExplicitReviewRequest,
  ExplicitReviewResult,
  ComposeLocalAgentInput,
  // Host-side types the CLI implements over `parseTestFile`, so it can name the shapes it fills.
  DraftAuthoringPort,
  DraftParseOutcome,
  // Joins the three above: the CLI implements `stageDraft` and needs this type.
  DraftStageOutcome,
  ParsedDraftDescriptor,
  SuiteTextEntry,
  CreateKnowledgeReviewInput,
  LocalAgentHost,
  LocalAgentJobs,
  LocalCurationCapabilities,
  ServedRecordFacts,
  MarkTriage,
  ApplyFeedbackInput,
  RecordGateReceiptInput,
  PromoteWithReceiptsInput,
  LocalDaemonCapabilities,
  LocalKnowledgeProbeCapabilities,
  LocalKnowledgeMaintenanceCapabilities,
  RunExecutionPort,
  SweepEntityIndexInput,
  SweepEntityIndexOutcome,
} from './composition/compose-local-agent.js'
// Knowledge vocabulary types, erased at runtime, through the edge that names the writer entry.
export type {
  AuthoringTestRef,
  AuthorOutcome,
  CurationCandidateProjection,
  CurationJobView,
  CurationProjectionArtifactSource,
  CuratorAuthor,
  EnqueueCurationCandidateProjectionOutcome,
  NeighborRecord,
  OpenServingKnowledgeReaderConfig,
  PurgeAffectedSet,
  PurgeReceipt,
  RebuildReport,
  RollbackAffectedSet,
  RollbackCampaignInput,
  RollbackCurationJobInput,
  RollbackReport,
  WriterLeaseAuthority,
  AcquireWriterLeaseOutcome,
  HeartbeatLeaseOutcome,
  LeaseOperationOptions,
  ReadWriterLeaseOutcome,
  // The doctor rows' probe vocabulary, beside its lease vocabulary.
  AcquireEmbedderOutcome,
  IndexFace,
  ReadEmbedderWorkerRegistrationOutcome,
  ReleaseLeaseOutcome,
  WriterLease,
  WriterLeaseFreshness,
} from './composition/compose-local-agent.js'

// Published so a surface never names `runner-local` itself; see `build-ordinals.ts`.
export {
  BuildOrdinalReservationError,
  reserveBuildOrdinalForProducts,
  latestBuildOrdinal,
  resolveBuildTag,
} from './composition/build-ordinals.js'

export {
  FsMarkLedger,
  MARKS_LEDGER_FILE,
  MARKS_LEDGER_LOCK_FILE,
  MARK_INTENT_FILE,
  MarkIntentUnusableError,
  MarkLedgerBusyError,
  MarkLedgerCorruptError,
  MarkLedgerNoRunError,
  latestMarkReceiptFor,
  latestMarkReceiptsPerAddress,
} from './store/mark-ledger.js'

export { HANDOFF_FILE, RUNS_SUBDIR, loadCompletedRunHandoff } from './composition/run-layout.js'

export { purgeActionCache } from './composition/action-cache.js'

// A standing host adopts the durable queue through this recovery entry before it opens the
// ordinary local-agent composition. Publishing the entry keeps that ordering shared instead of
// making each surface reach into agent-local's private source tree and re-create the recovery law.
export {
  composeJobRecovery,
  JOB_RECOVERY_MAX_RESUMED_JOBS,
} from './composition/compose-job-recovery.js'
export type {
  ComposeJobRecoveryInput,
  JobRecoveryHost,
} from './composition/compose-job-recovery.js'

// Storage is a port and this package holds its local implementations; the test seam stays off it.
export {
  CHAT_SESSIONS_SUBDIR,
  // Published so a caller waiting on a session's holder can name the refusal, not parse a message.
  ChatSessionBusyError,
  ChatSessionHeaderError,
  InvalidChatSessionIdError,
  UnknownChatSessionError,
  createJsonlSessionLog,
  listSessions,
  mintChatSessionId,
} from './session/jsonl-session-log.js'
export type {
  ChatSessionListEntry,
  ChatSessionListing,
  CreateJsonlSessionLogOptions,
  RefusedChatSessionFile,
} from './session/jsonl-session-log.js'
export { createMemorySessionLog } from './session/memory-session-log.js'
export type {
  CreateMemorySessionLogOptions,
  MemorySessionLog,
} from './session/memory-session-log.js'
