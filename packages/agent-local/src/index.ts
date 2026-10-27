import type { PersistencePort } from '@vostride/agent-qa-agent'

/**
 * The local implementation of the neutral persistence port.
 *
 * 2026-07-29 (Phase 385 plan 02, D-06): this alias now covers approvals and patches ONLY.
 * Job rows and checkpoints left the port for the agent job queue's own store, whose verbs are
 * compound and transactional rather than generic CRUD, and the conversation surface left it
 * entirely. The alias is deliberately narrower than the package's name suggests, and saying
 * so here is cheaper than letting a later reader infer that anything job-shaped belongs
 * behind it.
 *
 * The job store itself is not on this barrel. It is reachable by relative path within the
 * package and is published, if at all, by the composition root — a store that any importer
 * can construct is a second way to open the database beside the one the host owns.
 */
export type LocalPersistenceStore = PersistencePort

// 2026-07-29 (Phase 385 plan 08, D-13): the host-neutral run composition. Unlike the job store,
// this IS published — it is the thing every host is supposed to share, and a host that cannot
// reach it re-derives it, which is the divergence the one-composition-root decision exists to
// prevent. What stays unpublished is unchanged: the store, because a second way to open the
// database is a second writer nobody arbitrated.
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

// The one in-process run invocation core, and the typed refusals it can raise: a request field it
// cannot honour, an id it would not have minted, and an id that already belongs to a run, each
// told apart without reading a message. Published for the reason the run composition is: it is the
// seam every host is supposed to share, and a host that cannot reach it composes a run of its own.
export {
  createRunInvocationCore,
  REFUSED_RUN_REQUEST_FIELDS,
  RunIdAlreadyInUseError,
  RunIdNotMintedError,
  RunRequestFieldRefusedError,
} from './composition/run-invocation-core.js'
export type {
  RunAssembler,
  RunAssemblyContext,
  RunInvocationCoreOptions,
} from './composition/run-invocation-core.js'
// The assembler port's own vocabulary, re-exported from the package that declares it.
//
// THE PORT AND ITS TYPES TRAVEL TOGETHER, and that is what makes this hop principled rather than a
// convenience. A host writes a `RunAssembler`; a `RunAssembler` returns a `RunConfig` built out of
// runner descriptors. A surface that had to name `@vostride/agent-qa-runner` to write one would be
// reaching past its composition root for the vocabulary of a port that root defined — which is the
// firewall's (FUNC-02) whole subject. These are TYPES: erased before anything runs, granting no
// power the barrel does not already publish.
export type {
  BaselineProbeResult,
  ConfigDigests,
  MemberTestExecutor,
  // 404-01 (D-10): a host composing `RunInvocationCoreOptions.postVerdict` writes a port of this
  // shape, so its vocabulary travels the same hop the assembler's does.
  PostVerdictOutcome,
  PostVerdictPort,
  PostVerdictStepInput,
  RunConfig,
  RunMemberDescriptor,
} from './composition/run-invocation-core.js'
// 401-11: the two symbols the CLI's one in-process run drive needs and could not legally name.
// They live in their own composition module — see its header for why not in the core.
export { mapVerdictToExitCode, runSafetyScope } from './composition/run-drive-vocabulary.js'
// 405-05 (D-12/D-13): the evidence-blob read port's binding — ONE lambda over the store the
// runner wrote through, shared by the analysis job and by `runs.artifact`. Published because the
// dashboard's own suite composes it directly: a reader written there would be a second answer to
// where a run's blobs live.
export { createEvidenceBlobReader, lookupEvidenceBlob, readEvidenceBlobBytes, statEvidenceBlob } from './composition/evidence-blob-reader.js'
export type { CreateEvidenceBlobReaderInput } from './composition/evidence-blob-reader.js'
// 401-08 (D-08) published the dispatch-scoped grant overlay here. 2026-10-01 (432-18, D-15): it is
// deleted with the grant ledger it sat in front of.

// 390 D-16: the run-start quarantine snapshot. Published because the run host calls it at both of
// its startRun composition sites — the fold happens here, on the reader entry, and the host only
// ever sees the resolved plain data it hands to the runner.
export { resolveRunQuarantineSnapshot } from './composition/quarantine-snapshot.js'
export type { RunQuarantineSnapshotInput } from './composition/quarantine-snapshot.js'

// 390-30: the quarantine gate's TWO TOTAL TABLES, re-exported verbatim from the package that
// declares them. The CLI's withheld-line render must branch its remedy on ADMISSIBILITY — an
// escalate-only class is told no run admits it, an authored-required class is told it needs an
// analyst, and only the floor-eligible classes are told the next applied run may admit them. That
// render and `autoQuarantines` must read one vocabulary or the line's promise and the gate's
// refusal drift apart per class, which is exactly how the shipped line came to promise relief no
// fold grants.
//
// THROUGH THIS BARREL AND NOT DIRECTLY, on three measured refusals (390-30). A surface naming
// `@vostride/agent-qa-knowledge-local` fails validate:arch three separate ways: 387 D-20 removed it
// from the CLI's dependency contract ("unexpected internal dep"), the reader carve-out admits only
// the `/reader` subpath without a writer allowlist, and the FUNC-02 surface firewall ledger only
// ever SHRINKS — new surface code is fixed, never waived. The composition root is the sanctioned
// way a host acquires what a private package holds, so these travel here. They are frozen constant
// tables, not powers: no store, no writer, no new reach. The hop's own reasoning — including why it
// holds to `/reader` rather than spending SC5's single main-entry importer — lives on the module.
export {
  QUARANTINE_CLASS_DISPOSITIONS,
  QUARANTINE_FLOOR_ELIGIBILITY,
} from './composition/quarantine-vocabulary.js'
export type {
  QuarantineDisposition,
  QuarantineFloorEligibility,
} from './composition/quarantine-vocabulary.js'

// 2026-07-29 (Phase 385 plan 09, D-15): the one local composition root. `composeLocalAgent` is
// what a host calls instead of wiring a registry of its own, so it is published for the same
// reason the run composition is: a host that cannot reach it re-derives it.
//
// The store rule above is unchanged and this does not bend it. No store CONSTRUCTOR joins the
// barrel; `host.jobs()` hands back the store the host itself opened, which is the one arbitrated
// opening rather than a second one.
export {
  // 432-09 (D-04): an explicit knowledge change applied in the call, used by the mark host.
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
  // 407 D-18/D-20: the READ-ONLY knowledge probes `doctor` grades its three trust rows with.
  // Published for the same reason the resolver above is: the CLI may not name knowledge-local,
  // and a surface that could not reach these two axes separately would have to re-derive them.
  LOCAL_KNOWLEDGE_PROBES,
  LocalAgentClosedError,
  RunProducedNoEventsError,
  // 407 D-13/D-17: the ONE retrieval-rung resolver, published from the one edge allowed to name
  // knowledge-local's writer entry so both CLI run doors can hand it to the composition.
  resolveHostRetrievalRung,
  SYSTEM_CLOCK,
  sweepEntityIndexProjection,
  UNCLAIMABLE_BY_PROSE_POSTURE,
} from './composition/compose-local-agent.js'

// 2026-08-16 (Phase 397 plan 01, D-03): the two callers the chat surface's stages run under, and the
// scope set behind them. Published because 397's parity suite enumerates what the chat surface can
// REACH, and the planner's vocabulary is whatever the registry lists to the planner's own caller —
// so a suite that could not name that caller would have to spell an equivalent one, which is the
// second catalogue this phase exists to make impossible. None of the three is a power: two frozen
// caller records and a frozen scope list, carrying no dispatch and no host reach, and the layer
// re-checks a caller's grants at the gate no matter who assembled the record.
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
  // 393 D-01: the keep-gate evaluator's HOST-side vocabulary. Three types and no value: what a
  // host must be able to say about a draft path, what a parsed draft looks like when it hands one
  // over, and what one authored suite test looks like as text. Published because the CLI
  // implements all three over `parseTestFile` and the daemon reaches that implementation through
  // the same deferred import it already uses — and neither could name the shape it is filling
  // otherwise.
  DraftAuthoringPort,
  DraftParseOutcome,
  // 394 D-01: the fourth, joining for the reason the three above did — the CLI implements
  // `stageDraft` over `parseTestFile` and the shelf, and cannot name what it is filling without
  // this type.
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
// The knowledge vocabulary the curation surfaces are typed against, re-exported through the one
// edge that names the writer entry (D-14). Types are erased, so this hands a caller no power it
// could not already ask the capabilities above for.
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
  // 407 D-18: the doctor rows' probe vocabulary, beside the lease vocabulary it sits with.
  AcquireEmbedderOutcome,
  IndexFace,
  ReadEmbedderWorkerRegistrationOutcome,
  ReleaseLeaseOutcome,
  WriterLease,
  WriterLeaseFreshness,
} from './composition/compose-local-agent.js'

// 2026-08-02 (Phase 387 plan 09, D-20): the build-ordinal edge. Published for the same reason
// the composition root is — a surface that cannot reach it names `runner-local` itself, which is
// the firewall leak this phase clears. See composition/build-ordinals.ts for why these are
// re-exports rather than wrappers.
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

// 392 CHAT-05 / D-14 / D-17 / D-19: the session log's two adapters, its listing, and its refusal
// vocabulary.
//
// Published because storage is a PORT and this package is where its local implementations live —
// the same footing every other store here is on.
//
// 392 plan 03 REMOVES the observation seam from this list, and the removal is the point. Plan 01
// published `createJsonlSessionLogOn` and the filesystem facade beside the production factory,
// reasoning that publishing the pair in full made the seam legible. It makes it REACHABLE: a seam
// every package can import is not a seam, and "append without the fsync" stops being impossible
// the moment another surface can construct the log over a facade of its own. The mandated
// precedent already settled this — `createJobCheckpointStore` and its `On` sibling appear nowhere
// on this barrel — and a durability test now asserts both halves: nothing outside `__tests__`
// calls the seam, and this file does not carry it.
export {
  CHAT_SESSIONS_SUBDIR,
  // 392-12: published beside its siblings because a caller that must WAIT for the holder of a
  // session has to be able to name what it is waiting on — a refusal only recognisable by its
  // message is one every surface re-parses differently.
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
