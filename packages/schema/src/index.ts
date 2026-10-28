export { asRef, type Ref, type Point, type BoundingBox, type Viewport } from './primitives/index'

export type {
  Action,
  AndroidAction,
  CommonAction,
  IosAction,
  MobileAction,
  Platform,
  RefTargeted,
  Surface,
  TabSelector,
  WebAction,
} from './action/index'
export type { ActionExecutor, ActionsFor } from './action/adapter'
export { ACTION_WIRE_SCHEMAS_BY_TYPE, actionWireSchema } from './action/wire-schema'
export {
  type ActionFamily,
  ACTION_FAMILIES,
  ActionFamilySchema,
  ACTION_FAMILY_BY_TYPE,
  actionFamilyOf,
} from './action/family'
export type {
  EmittedTargetDescriptor,
  Fill,
  PlannedFill,
  PlannedScroll,
  Scroll,
  SwipeByDirection,
  SwipeByPath,
  WaitFor,
  WithEmittedRef,
  WithEmittedTarget,
} from './action/params'
export type { ActionAnnotation, ActionResult } from './result/index'
export {
  elementOrdinal,
  normalizeAccessibleName,
  distilledScreenStateDigest,
  isToggleElement,
  TOGGLE_ROLES,
} from './screen/index'
export type { DistilledScreenStateInput } from './screen/index'
export type { ElementBounds, ScrollContext } from './screen/index'
export type { ElementInfo, ElementState, ElementLabels, ElementHierarchy } from './screen/index'
export type { ScreenState } from './screen/index'
export type { ScreenStateMetadata, ScreenStateMetadataBase } from './screen/index'
export type { TargetDescriptor, GroundingAttempt, GroundingEvidence } from './screen/index'
export type { ModelCapabilities } from './capability/index'
export type { ModelProfile, ModelProviderId, ModelAuthDeclaration } from './model-profile/index'
export type { EmbeddingProfile } from './embedding-profile/index'
export {
  DEFAULT_EMBEDDING_PROFILE,
  STATIC_FLOOR_EMBEDDING_PROFILE,
} from './embedding-profile/index'
export type {
  BrowserConfig,
  ConfigActionRefusal,
  ConfigChange,
  ConfigLeafPattern,
  ConfigNamedArray,
  ConfigPathSegment,
  ConfigUndoRequest,
  ConfigUndoResult,
  // 2026-09-27, 429-44 WR-01
  ConfigWriteDeniedRoot,
  ConfigWriteIssue,
  ConfigWriteOp,
  ConfigWriteRefusal,
  ConfigWriteRequest,
  ConfigWriteResult,
  DeviceConfig,
  EffectiveWorkersInput,
  PlatformBase,
  // 2026-10-07 (436-04, D-01..D-03)
  PlannerLimits,
  PlannerLimitsPerTest,
  PlannerLimitsRecord,
  TimeoutConfig,
} from './config/index'
export {
  appStateSchema,
  browserConfigSchema,
  CONFIG_ACTION_REFUSALS,
  CONFIG_NAMED_ARRAYS,
  CONFIG_REVISION_ABSENT,
  CONFIG_SCHEMA_LEAVES,
  // 2026-09-27, 429-44 WR-01: the page write door's denied roots and path policy.
  CONFIG_WRITE_DENIED_ROOTS,
  CONFIG_WRITE_OPS,
  CONFIG_WRITE_REFUSALS,
  ConfigChangeSchema,
  configLeafOwner,
  ConfigPathSegmentSchema,
  ConfigUndoRequestSchema,
  ConfigWriteRequestSchema,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_PARALLEL_WORKERS,
  // 2026-10-07 (436-04, D-01..D-03): the one default pair and resolver every door calls.
  DEFAULT_PLANNER_LIMITS,
  deviceConfigSchema,
  isConfigSchemaPath,
  isPageWritableConfigPath,
  // 441 GAP2-D4: the marker_written_back refusal's one sentence.
  MARKER_WRITTEN_BACK_SENTENCE,
  platformBase,
  PLANNER_LIMIT_KEYS,
  resolveEffectiveWorkers,
  resolvePlannerLimits,
  timeoutConfigSchema,
  viewportSchema,
} from './config/index'
export {
  canonicalJson,
  canonicalValue,
  committedFileText,
  sha256hex,
  sha256hex16,
  sha256hexBytes,
} from './determinism/index'
export type {
  ScopeKey,
  ScopeTier,
  Anchor,
  GraphNodeType,
  GraphEdgeType,
  GraphNodeNaturalKey,
} from './identity/index'
export {
  normalizeAnchor,
  identityTupleKey,
  graphNodeId,
  anchorGraphNode,
  recordGraphNode,
} from './identity/index'
// 389 D-13: the exercised-anchors walk, promoted from the CLI curation tail so the agent
// cluster function, 390's recurrence window and the tail all consume ONE spelling.
export {
  actionRefs,
  classifySubActionRoute,
  elementAnchor,
  exercisedAnchors,
  resolvedElementEvidence,
  uniqueAnchors,
} from './identity/exercised-anchors'
export type {
  ClassifiedRoute,
  ResolvedElementEvidence,
} from './identity/exercised-anchors'
export { supersessionKey } from './identity/supersession-key'
export {
  screenIdentityHash,
  screenStateHash,
  relevantEnvDigest,
  computeCacheKey,
  computeToolSchemaDigest,
} from './determinism/index'
export type {
  CacheKey,
  CacheableStepInput,
  NonCacheableStepInput,
  RedactedEnvVar,
  ToolSurfaceEntry,
} from './determinism/index'

// 367 D-13: one shared version-guard rule for every versioned document contract.
export { createVersionGuard, VersionGuardError } from './versioning/create-version-guard'
export type {
  MigrationRegistry,
  VersionGuardConfig,
} from './versioning/create-version-guard'

// 314 async-seam
export { asRunId } from './run/index'
export { MODEL_USAGE_ROLES, ModelUsageRoleSchema, ModelUsageIdentitySchema, ModelUsageSchema } from './run/model-usage'
export type { ModelUsageRole, ModelUsage, ModelTokenUsage, ModelUsageObservations } from './run/model-usage'
export { RunModelSummarySchema } from './functions/runs'
export type { RunModelSummary } from './functions/runs'
// 431 D-06: the runs.overview read's contracts.
export {
  RUN_OVERVIEW_TEXT_MAX_CODE_POINTS,
  RUN_OVERVIEW_TRUNCATION_INDICATOR,
  RunOverviewArtifactAddressSchema,
  RunOverviewAriaSchema,
  RunOverviewBriefAddressSchema,
  RunOverviewBriefSchema,
  RunOverviewEvidenceAddressSchema,
  RunOverviewLearnedSchema,
  RunOverviewProjectionSchema,
  RunOverviewRecordingSchema,
  RunOverviewRecordSchema,
  RunOverviewScreenshotSchema,
  RunOverviewStepEvidenceSchema,
  RunOverviewStepSchema,
  RunOverviewTestSchema,
  RunOverviewTextSchema,
  RunsOverviewInputSchema,
} from './functions/runs-overview'
export type {
  RunOverviewArtifactAddress,
  RunOverviewAria,
  RunOverviewBriefAddress,
  RunOverviewEvidenceAddress,
  RunOverviewLearned,
  RunOverviewProjection,
  RunOverviewRecord,
  RunOverviewRecording,
  RunOverviewScreenshot,
  RunOverviewStep,
  RunOverviewStepEvidence,
  RunOverviewTest,
  RunOverviewText,
  RunsOverviewInput,
} from './functions/runs-overview'
export {
  EVIDENCE_REF_PREFIXES,
  EvidenceArtifactRefSchema,
} from './ids/artifact-ref'
export type { EvidenceRefPrefix, EvidenceArtifactRef } from './ids/artifact-ref'
export {
  RECORDING_STATES,
  RECORDING_CONTENT_TYPES,
  RECORDING_REF_PREFIX,
  RecordingRefSchema,
  RecordingEntrySchema,
} from './run/recording'
export type {
  RecordingState,
  RecordingContentType,
  RecordingRef,
  RecordingEntry,
} from './run/recording'
export {
  EVIDENCE_KINDS,
  NETWORK_BODY_CONTENT_TYPES,
  NETWORK_BODY_MAX_BYTES,
  EVIDENCE_ABSENCE_REASONS,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
  EvidenceKindSchema,
  EvidenceAbsenceReasonSchema,
  EvidenceDocumentSchema,
  EvidenceEntrySchema,
  ConsoleEvidenceRecordSchema,
  NetworkEvidenceRecordSchema,
  A11yEvidenceRecordSchema,
  ConsoleEvidenceDocumentSchema,
  NetworkEvidenceDocumentSchema,
  A11yEvidenceDocumentSchema,
  AriaEvidenceDocumentSchema,
  VariablesEvidenceDocumentSchema,
  VariableSnapshotSchema,
} from './run/evidence'
export type {
  EvidenceKind,
  NetworkBodyContentType,
  EvidenceAbsenceReason,
  EvidenceDocument,
  EvidenceEntry,
  AriaEvidenceEntry,
  StepEvidenceEntries,
  VariableSnapshot,
} from './run/evidence'
export {
  BUNDLE_ID_HASH_SUFFIX_LENGTH,
  BUNDLE_SLUG_MAX_LENGTH,
  asRecordId,
  asEvidenceToken,
  bundleSlug,
  computeBundleIdentityHash,
  computeStepSequenceSignature,
  deriveDiscriminantKey,
  mintBundleId,
  slugBranch,
} from './ids/index'
export {
  LosslessServedBriefError,
  LosslessServedBriefSchema,
  SERVED_BRIEF_PROOF_SCHEMA_VERSION,
  computeBriefDigest,
  guardLosslessServedBrief,
} from './brief/index'
// 387 KREV-02 D-13/D-14: the serve-time retrieval trace, persisted beside ServedBrief.
export {
  RETRIEVAL_TRACE_LEGS,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  ServedRetrievalTraceV1Schema,
  TRACE_TRUNCATION_TOP_K,
  TraceLineSchema,
} from './brief/index'
// 407 TRST-01 D-13/D-17: the closed retrieval-rung vocabulary and its recorded form, plus the
// durable D-16 marker that says no knowledge reader was bound at all. One spelling for the
// runner that records, the banner that prints and the doctor row that grades.
export {
  NO_KNOWLEDGE_READER_TRUNCATION,
  RETRIEVAL_RUNGS,
  RETRIEVAL_RUNG_REASONS,
  RecordedRetrievalRungSchema,
} from './brief/index'
export { CURRENT_HANDOFF_SCHEMA_VERSION } from './handoff/index'
// 361 D-19: the one handoff version guard (SESSION-05 read-side discipline).
export { guardCompletedRunHandoff, HandoffVersionError, HANDOFF_MIGRATIONS } from './handoff/index'
// 388 D-09/D-11/D-14/D-15: the chain-terminal notification record and THE one chip-status
// vocabulary. Both are minted here rather than beside a consumer because each has several —
// the notification row is read by chat and by the dashboard, and the chip words are spoken by
// the bus, the read op and the CLI's summary line.
// 391 D-16/D-18: the per-run digest's read-time contract, minted beside the frozen row it
// deliberately does not widen. Nothing persists a digest — it is composed live, keyed by runId,
// which is what makes "exactly one digest per run" structural rather than throttled.
export {
  CURATION_SNAPSHOT_WITHHELD_REASONS,
  CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
  CurationSnapshotWithheldSchema,
  POST_PROCESSING_CHIP_STATUSES,
  POST_PROCESSING_DETAIL_STAGES,
  POST_PROCESSING_SKIP_REASON_WORDS,
  POST_PROCESSING_SKIP_REASONS,
  PostProcessingSkippedSchema,
  PostProcessingStageDetailSchema,
  RunDigestCandidateReportSchema,
  RunDigestChainOutcomesSchema,
  RunDigestMarkChangeSchema,
  RunDigestQuarantineReportSchema,
  RunDigestSchema,
  RUN_NOTIFICATION_VIEW_STATUSES,
  RunNotificationSchemaError,
  RunsDigestInputSchema,
  guardRunNotification,
  isPostProcessingChipStatus,
  toRunNotificationView,
} from './notification/index'
export type {
  CurationSnapshotWithheldReason,
  PostProcessingChipStatus,
  PostProcessingChips,
  PostProcessingDetailStage,
  PostProcessingSkipReason,
  PostProcessingStageDetail,
  PostProcessingStatus,
  RunDigest,
  RunDigestCandidateReport,
  RunDigestChainOutcomes,
  RunDigestMarkChange,
  RunDigestQuarantineReport,
  RunNotification,
  RunNotificationOutcome,
  RunNotificationStageStatus,
  RunNotificationStages,
  RunNotificationVerdictSummary,
  RunNotificationView,
  RunNotificationViewStages,
  RunNotificationViewStatus,
  RunsDigestInput,
} from './notification/index'
export type { RunStatus, ExecutionContext, RunId } from './run/index'
export {
  CURATION_BREAKDOWN_BUCKETS,
  CURATION_BUCKET_PRECEDENCE,
  CURATION_SNAPSHOT_SCHEMA_VERSION,
  CurationBucketSchema,
  CurationSnapshotChangeSchema,
  CurationSnapshotRowSchema,
  CurationBreakdownSchema,
  CurationSnapshotSchema,
} from './notification/curation-snapshot'
export type {
  CurationBucket,
  CurationSnapshotChange,
  CurationSnapshotRow,
  CurationBreakdown,
  CurationSnapshot,
} from './notification/curation-snapshot'
export type {
  ArtifactRef,
  BundleDiscriminant,
  BundleIdentityCore,
  BundleIdentityInput,
  EvidenceToken,
  RecordId,
} from './ids/index'
export type { Verdict, VerdictClass, VerdictEvidence } from './verdict/index'
export { VERDICT_CLASSES, isVerdictClass } from './verdict/index'
// 390 D-01/D-03/D-11/D-12: the committed quarantine ledger's event contract and the state
// vocabulary every quarantine surface speaks — the fold, the list verb, the entity card and the
// recurrence clause's ladder arms. `'expired'` is a COMPUTED state, never an event.
export {
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  QUARANTINE_ENTRY_STATE_NAMES,
  QUARANTINE_EVENT_KINDS,
  QUARANTINE_LEDGER_MIGRATIONS,
  QUARANTINE_UNASSIGNED_OWNER,
  QuarantineLedgerVersionError,
  guardQuarantineLedgerEvent,
  hasQuarantineEventShape,
  isQuarantineEventKind,
  quarantineAppliesToTest,
} from './quarantine/index'
export type {
  QuarantineAppliedEntry,
  QuarantineEnteredEvent,
  QuarantineEntryState,
  QuarantineEntryStateName,
  QuarantineEventKind,
  QuarantineLadderState,
  QuarantineLedgerEvent,
  QuarantineOwner,
  QuarantineReleasedEvent,
  QuarantineRenewedEvent,
  QuarantineSnapshotMatch,
} from './quarantine/index'
// 390 D-12/D-13: the three verbs' wire contract and the port they dispatch through. Minted
// here rather than beside the op specs because two packages consume it and neither may import
// the other — `agent` declares the specs against these validators, knowledge-local implements
// the port over the committed ledger. `release`'s no-entry and `add`'s renewed are result
// ARMS, never throws.
export {
  QuarantineAddInputSchema,
  QuarantineAddOutputSchema,
  QuarantineEntrySchema,
  QuarantineListInputSchema,
  QuarantineListOutputSchema,
  QuarantineReleaseInputSchema,
  QuarantineReleaseOutputSchema,
} from './quarantine/index'
export type {
  QuarantineAddInput,
  QuarantineAddOutput,
  QuarantineListInput,
  QuarantineListOutput,
  QuarantineOperationsPort,
  QuarantineReleaseInput,
  QuarantineReleaseOutput,
} from './quarantine/index'
// 389 D-05/D-07/D-09/D-10: the verdict truth vocabulary — sentence parts joined to Verdict
// by perTest (beside, never inside the frozen §A9 union), the version-guarded run analysis
// artifact, and the ONE resolved-verdict accessor every consumer routes through. 390 FLAK-01
// adds the fingerprint's INPUT stage (`failingStepOf`/`errorTextOf`) beside the frozen recipe,
// hoisted out of agent so knowledge-local's recurrence windows can key the same way.
export {
  admitAnalysisArtifactForRun,
  ANALYSIS_FILE,
  ANALYSIS_MIGRATIONS,
  AnalysisVersionError,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  errorTextOf,
  failingStepOf,
  failureFingerprint,
  guardRunAnalysisArtifact,
  QUOTE_SEARCHED_STEP_FIELDS,
  QUOTE_SEARCHED_TEST_OUTCOME_FIELDS,
  resolveRunVerdicts,
  searchedQuoteTexts,
  searchedTestOutcomeTexts,
  validateAnalysisAgainstHandoff,
  VerdictSentencePartsSchema,
  // 393 D-13: the sibling anchor-coverage recipe (gate 3), beside the frozen failure recipe.
  // `testFingerprintElements` is the ONE walk both sides of gate 3's comparison go through —
  // knowledge-local's suite fold and the agent's draft side alike (393-06).
  ACTION_ANCHOR_FINGERPRINT_VERSION,
  ASSERT_ACTION_TYPES,
  actionAnchorElement,
  actionAnchorSequence,
  testFingerprintElements,
} from './verdict/index'
export type {
  ActionAnchorElementInput,
  FingerprintEvidenceLike,
  AnalysisArtifactAdmission,
  AnalysisValidationReject,
  AnalysisValidationResult,
  FailureFingerprintInput,
  RunAnalysisArtifact,
  VerdictGroundingQuote,
  VerdictSentenceParts,
} from './verdict/index'
export {
  deriveMemoryOnPath,
  deriveMemoryOnPathSites,
  MEMORY_ON_PATH_TRUSTS,
  MemoryOnPathEntrySchema,
  memoryOnPathTrustOf,
} from './verdict/index'
export type { MemoryOnPathEntry, MemoryOnPathSite, MemoryOnPathTrust } from './verdict/index'
export type {
  DeltaEnvelope,
  CompareAndSet,
  BundleDraft,
  CurationAuthorship,
  CurationAuthorshipPath,
  CurationFallbackReason,
  Delta,
  DeltaKind,
  DeltaOrigin,
} from './delta/index'
// 387 D-17: runtime projections of the §7.3 discriminant and origin vocabularies, so a
// proposal boundary can name what a delta is without re-declaring the union.
export { DELTA_KINDS, DELTA_ORIGINS } from './delta/index'
export type {
  BriefLine,
  CautionLine,
  LosslessServedBrief,
  LosslessServedBriefProofV1,
  ReadTrace,
  RecordedRetrievalRung,
  RetrievalRung,
  RetrievalRungReason,
  RetrievalTraceLeg,
  ServedAdmissionEvent,
  ServedAdmissionSurface,
  ServedBrief,
  ServedPromptTurn,
  ServedRetrievalTraceV1,
  TraceLine,
} from './brief/index'
export type {
  CacheMissReason,
  CompletedRunHandoff,
  CycleEvidence,
  DeclaredModelProfile,
  LocalEffectEvidence,
  InterpolatedVariable,
  ModelCallRecord,
  ModelIdentity,
  PerTestOutcome,
  PlanningFailureEvidence,
  SamplingParams,
  StagnationClass,
  StagnationEvidence,
  StepEvidence,
  StepPlanSource,
  SubActionEvidence,
  ToolExchangeEvidence,
} from './handoff/index'
export { actedPair } from './handoff/index'
// 360 termination-verb & AI-assertion evidence vocabulary (EXEC-05/EXEC-07)
export type {
  AiJudgmentEvidence,
  AssertValueEvidence,
  AssertValueOp,
  ReportedValueEvidence,
  TerminationEvidence,
  VerdictSource,
} from './handoff/index'
// 2026-10-07 (436-04, D-11..D-13): the per-step limit stop and usage.
export type { CompoundInputCount, LimitStopEvidence, StepLimitUsage } from './handoff/index'
export { formatLimitStopReason, LIMIT_STOP_EVIDENCE_KEYS, STEP_LIMIT_USAGE_KEYS } from './handoff/index'
export type {
  CitationSource,
  ConditionCitation,
  ConditionEnding,
  ConditionFileCheck,
  ConditionGuard,
  ConditionNeed,
  ConditionRecord,
  ConditionVerdict,
  ConditionVerdictsEvidence,
  OpenDialogAccount,
} from './handoff/index'
export {
  CITATION_SOURCES,
  CONDITION_ENDINGS,
  CONDITION_GUARDS,
  CONDITION_NEEDS,
  CONDITION_RECORD_KEYS,
  CONDITION_VERDICTS,
  CONDITION_VERDICTS_EVIDENCE_KEYS,
  stepOutcomeUnproven,
} from './handoff/index'
// 2026-10-07 (436-10, D-19..D-23): operation-specific evidence on the triggering action.
export type {
  ClipboardEvidence,
  DownloadEvidence,
  OperationCaptureAvailability,
  OperationEvidence,
} from './handoff/index'
export {
  CLIPBOARD_EVIDENCE_KEYS,
  DOWNLOAD_EVIDENCE_KEYS,
  OPERATION_CAPTURE_AVAILABILITY_KEYS,
} from './handoff/index'
// 2026-10-08 (437-02, D-05): what an action's input delivered, on the same evidence.
export type {
  FillVerdict,
  InputEvidence,
  InputPath,
  SubmitOutcome,
  SubmitReason,
} from './handoff/index'
export { INPUT_EVIDENCE_KEYS } from './handoff/index'

// 358 working-memory vocabulary (WM-01)
export type { WorkingMemoryEntry } from './memory/index'
export { workingMemoryEntrySchema } from './memory/index'

// 315 run+agent DTOs
export type { RunSession } from './run/index'
// 403 D-05/D-08: live-view frame vocabulary — frames as data, capability declared per handle.
export { LIVE_FRAME_END_REASONS, LIVE_STREAM_KINDS, LiveStreamDeclarationSchema } from './run/index'
// 403 D-01..D-04: the liveUrl capability-token vocabulary (types + refusal names only).
export { LIVE_URL_REFUSAL_REASONS, LIVE_URL_SCOPE, LIVE_VIEW_SUBJECT_KINDS } from './run/index'
export type {
  LiveUrlClaims,
  LiveUrlRefusalReason,
  LiveUrlSigner,
  LiveUrlVerdict,
  LiveViewSubject,
  LiveViewSubjectKind,
  LiveViewSubjectRef,
} from './run/index'
export type {
  LiveFrame,
  LiveFrameEndReason,
  LiveFrameMetadata,
  LiveFrameSubscription,
  LiveStreamDeclaration,
  LiveStreamKind,
} from './run/index'
// 363 D-08: run-artifact payload type family (relocated from core/src/artifacts).
export { RUN_ARTIFACT_SCHEMA_VERSION } from './run/index'
export type {
  ArtifactRecord,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  RunArtifactConfigSnapshot,
  RunArtifactFinalizeInput,
  RunArtifactKind,
  RunArtifactMetadata,
  RunArtifactPayload,
  RunArtifactReporterContext,
  RunArtifactRuntimeSnapshot,
  RunArtifactStageInput,
  RunArtifactSuiteMemberSnapshot,
  RunArtifactSuiteSourceSnapshot,
  RunArtifactTerminalError,
  RunArtifactTestSourceSnapshot,
  RunArtifactTestsSourceSnapshot,
} from './run/index'
// The bus schema version and the session vocabulary
export { CURRENT_BUS_SCHEMA_VERSION, RUN_EVENT_TYPES } from './run/index'
// 361 D-10/D-09: pure masked payload projections (SESSION-03 projection layer).
export {
  maskPayloadStrings,
  maskPayloadTree,
  projectStepFinalized,
  projectSubActionRecorded,
  projectTestFinished,
  // 363 D-01 parity appends: hook lifecycle + retry projections (masked at the sink).
  projectHookStarted,
  projectHookFinished,
  projectTestRetryScheduled,
} from './run/index'
export type { MaskFn } from './run/index'
// 402-04 D-10/D-14: handle identity — the TOTAL event-scope classification, the one filter
// predicate, the composite id spelling and the additive runStarted roster reader.
export {
  HANDLE_ID_SEPARATOR,
  RUN_EVENT_SCOPE,
  RUN_EVENT_SCOPE_TYPES,
  handleId,
  handleRosterOf,
  memberIndexOf,
  parseHandleId,
  parseHandleParam,
  passesHandleFilter,
} from './run/index'
export type { HandleParamParse, RunEventScope } from './run/index'
export type {
  MemberTestOutcome,
  RunCompletion,
  RunEvent,
  RunEventEnvelope,
  RunEventPayload,
  RunEventType,
  RunStartedPayload,
  RunFinishedPayload,
  // 404-01 (D-09): the ratified post-processing posture union `runFinished.disposition` carries.
  PostProcessingDisposition,
  VerdictPayload,
  RunWarningPayload,
  RunErrorPayload,
  HeartbeatPayload,
  TestStartedPayload,
  TestFinishedPayload,
  StepStartedPayload,
  StepFinalizedPayload,
  SubActionRecordedPayload,
  ChipEventPayload,
  // 363 D-01 parity appends: hook lifecycle + retry payloads.
  HookStartedPayload,
  HookFinishedPayload,
  TestRetryScheduledPayload,
} from './run/index'
export type { Job, JobKind, JobStatus, JobConclusionKind, JobId } from './job/index'
export { asJobId, isJobKind, jobSchema } from './job/index'
// 385 plan 02 (JOBQ-01/JOBQ-02/JOBQ-05): the agent job queue's DTO vocabulary.
export type {
  ChainedJobRequest,
  JobCheckpointEnvelope,
  JobEnqueueRequest,
  JobHandlerOutcome,
} from './job/index'
export {
  JOB_CHECKPOINT_SCHEMA_VERSION,
  chainedJobRequestSchema,
  jobCheckpointEnvelopeSchema,
  jobEnqueueRequestSchema,
  jobHandlerOutcomeSchema,
  // 393 D-20 (WTST-06): the analyze-run payload mirror, validated producer-side at enqueue.
  AnalyzeRunPayloadSchema,
} from './job/index'
export type { AnalyzeRunPayload } from './job/index'
export type { Patch, FileChange, Hunk, PatchStatus, PatchId } from './patch/index'
export { asPatchId, patchSchema } from './patch/index'
// 395 D-01/D-17 · CFGM-01/03/04: the config editor's DTOs, and THE diff/digest primitive both
// halves of a config change call — construction in `agent`, the write in `cli`. The primitive is
// exported from here and from nowhere else for the reason its own header states: two recipes for
// one digest contract is 394's CR-02 defect class, and this phase's whole freshness guarantee is
// the two halves agreeing byte for byte.
export {
  CONFIG_BLOCKED_REASONS,
  CONFIG_DIFF_OUTCOMES,
  CONFIG_FILE_CHANGE_KINDS,
  CONFIG_HOOK_RUNTIMES,
  CONFIG_CHANGE_REFUSAL_REASONS,
  CONFIG_REFERENCE_KINDS,
  CONFIG_SET_DEFAULT_HOOKS_FILE,
  CONFIG_SET_GITIGNORE,
  CROSS_BOUNDARY_REASONS,
  ConfigAuthSetInputSchema,
  ConfigChangeFileSchema,
  ConfigChangeOutputSchema,
  ConfigFieldSetInputSchema,
  ConfigHookAddInputSchema,
  ConfigProjectScaffoldInputSchema,
  ConfigTargetCreateInputSchema,
  ConfigTargetEditInputSchema,
  EmptyConfigDiffFileError,
  MAX_CONFIG_REFERENCE_LENGTH,
  SECRET_ADJACENT_CONFIG_FIELDS,
  UnrenderableConfigDiffError,
  base64Decode,
  base64Encode,
  enumerateConfigFileSet,
  isLegalConfigReference,
  isSecretAdjacentConfigField,
  renderConfigDiff,
  utf8Decode,
  utf8Encode,
} from './config-mutation/index'
export type {
  ConfigAuthSetInput,
  ConfigBlockedReason,
  ConfigChangeFile,
  ConfigChangeOutput,
  ConfigChangeRefusalReason,
  ConfigDiffChanged,
  ConfigDiffFileInput,
  ConfigDiffOutcome,
  ConfigDiffResult,
  ConfigDiffUnchanged,
  ConfigFieldSetInput,
  ConfigFileChangeKind,
  ConfigFileDigest,
  ConfigHookAddInput,
  ConfigHookRuntime,
  ConfigProjectScaffoldInput,
  ConfigReferenceKind,
  ConfigTargetCreateInput,
  ConfigTargetEditInput,
  CrossBoundaryReason,
  SecretAdjacentConfigField,
} from './config-mutation/index'

// 316 seam helpers
export type { RecordedActionResult } from './result/index'
export type { VerifierVerdict, Decision } from './handoff/index'
export type { BundleKind, FactSubtype, OriginStage } from './delta/index'
export { toRecordedActionResult } from './result/index'
export { validRecordingAnnotation, validRecordedAnnotation } from './result/index'
export type { RecordingAnnotationWitness } from './result/index'
export type { IdempotentNoopMeta } from './result/index'
export { actionDidNotFail, readIdempotentNoopMeta } from './result/index'
export type { TargetIdentity, TargetMismatchReason, TargetRefusalMeta } from './result/index'
export { readTargetRefusalMeta, TARGET_IDENTITY_KEYS, TARGET_REFUSAL_KEYS } from './result/index'
export type { BindingOutcome, BindingOutcomeMeta } from './result/index'
export { BINDING_OUTCOME_KEYS, readBindingOutcomeMeta } from './result/index'
export { computeEvidenceToken } from './ids/index'

// 338 reader DTOs (PORT-03)
export type { IndexEntry, RecordBody, BriefBlock, CautionBlock, ProcedureMatch } from './reader/index'
// 381 authoring-brief contracts (D-13/D-16/ABRF-01)
export type { AuthoringBrief, CoverageMap, ExemplarTest } from './reader/index'
export type { SearchOptions, ReadOptions, BuildRange, CanaryOutcome } from './reader/index'
export {
  createServingAdmissionState,
  inspectServingRecord,
  servingClusterKey,
  servingRecordMetadata,
  tryAdmitServingRecord,
} from './reader/index'
export type {
  ServingAdmissionDecision,
  ServingAdmissionInput,
  ServingAdmissionRejectionReason,
  ServingAdmissionState,
  ServingRecordMetadata,
} from './reader/index'

// 374 D-03/BNDL-03: pure event vocabulary and derivations stay storage-neutral.
export {
  BundleOutcomeEventSchema,
  dedupeEvents,
  eventDedupKey,
  survivingOutcomeEvents,
} from './knowledge/index'
export type { BundleOutcomeEvent, OriginClass } from './knowledge/index'
export {
  EVIDENCE_INCOMPLETE_ALPHA_DISCOUNT,
  ORIGIN_PRIORS,
  SERVING_ATTRIBUTION_WEIGHT,
  foldBundleTrust,
} from './knowledge/index'
export type { BundleStatus, DerivedTrustState } from './knowledge/index'
export {
  INSPECT_RECORD_VIEW_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
  InspectFilterSchema,
  InspectRecordViewSchema,
  RecordChangeSchema,
  guardInspectRecordView,
  guardRecordChange,
} from './knowledge/index'
export type {
  InspectFilter,
  InspectRecordView,
  RecordChange,
} from './knowledge/index'
export {
  BIMODAL_GAP_THRESHOLD,
  BIMODAL_MIN_MODE_N,
  CI_SEPARATION_Z,
  CUSUM_DECISION_H,
  CUSUM_SLACK_K,
  DRIFT_RELATIVE_THRESHOLD,
  DRIFT_SIGMA_K,
  KIND_CV_FLOOR,
  KIND_DEFAULT_CV,
  MEASUREMENT_MIN_N,
  MULTIMODAL_TRAILING_BUILDS,
  SHRINKAGE_PSEUDO_N,
  decideMeasurementDrift,
  foldMeasurements,
  measurementBaselineSchema,
  measurementObservationSchema,
  shrunkSigma,
} from './knowledge/index'
export type {
  MeasurementBaseline,
  MeasurementObservation,
} from './knowledge/index'
export { evaluatePromotionGate } from './knowledge/index'
export type {
  PromotionGateHoldReason,
  PromotionGateInput,
  PromotionGateObservation,
  PromotionGateVerdict,
} from './knowledge/index'
export {
  COLD_START_MAX_BUDGET_FRACTION,
  COLD_START_MAX_RECORDS,
  COLD_START_TRUST_DISCOUNT,
  applyColdStartSubCap,
  isVettedCandidate,
} from './knowledge/index'
export type {
  ColdStartBudgetEntry,
  VettedCandidateInput,
} from './knowledge/index'
export {
  cautionRootCauseClassSchema,
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  distilledObservationSchema,
  guardDistilledObservation,
} from './knowledge/distilled-observation'
export type {
  CautionRootCauseClass,
  DistilledObservation,
} from './knowledge/distilled-observation'
export {
  ArtifactsIndexSchema,
  BUNDLE_SCHEMA_VERSION,
  BundleManifestSchema,
  BundleProvenanceSchema,
  BundleRelationsSchema,
  computeMutableStateHash,
  deriveEvidenceToken,
  guardArtifactsIndex,
  guardBundleManifest,
  guardBundleProvenance,
  guardBundleRelations,
  verifyManifestIdentity,
} from './knowledge/index'
export type {
  ArtifactsIndex,
  BundleManifest,
  BundleProvenance,
  BundleRelation,
  BundleRelations,
  MutableStateHashInput,
} from './knowledge/index'
export {
  emitRecordMarkdown,
  parseRecordMarkdown,
  renderEmbeddingInput,
  screenStateSnapshotRelPath,
} from './knowledge/index'
export type { RecordFrontmatter } from './knowledge/index'

// 387 KREV-01 D-17/D-19: the review-verb read contracts every 387-06/387-08 op imports rather than
// re-minting. 2026-10-01 (432-17, D-05): with the direct knowledge change contracts that replaced the
// propose+apply seam (`knowledge/change.ts`); the proposal payload and its apply contracts are gone.
export {
  BRIEF_WHY_NO_TRACE_REASONS,
  BRIEF_WHY_RESULT_KINDS,
  BriefWhyInputSchema,
  BriefWhyResultSchema,
  DeltaSchema,
  FORGET_RECEIPT_SCHEMA_VERSION,
  ForgetReceiptV1Schema,
  ForgetTargetRefSchema,
  KNOWLEDGE_CHANGE_VERBS,
  KNOWLEDGE_PROJECTIONS,
  KNOWLEDGE_REVIEW_VERBS,
  KnowledgeChangeIdSchema,
  KnowledgeChangeOperationIdSchema,
  KnowledgeAcceptInputSchema,
  KnowledgeAcceptChangeInputSchema,
  KnowledgeChangeOutputSchema,
  KNOWLEDGE_CHANGE_REFUSAL_REASONS,
  KnowledgeForgetInputSchema,
  KnowledgeForgetChangeInputSchema,
  KnowledgeRecordShowInputSchema,
  KnowledgeRecordShowOutputSchema,
  KnowledgeRecordShowResultSchema,
  KnowledgeRecordsDiffInputSchema,
  KnowledgeRecordsDiffOutputSchema,
  KnowledgeRecordsInspectInputSchema,
  KnowledgeRecordsInspectOutputSchema,
  KnowledgeRejectInputSchema,
  KnowledgeRejectChangeInputSchema,
  KnowledgeTargetRefSchema,
  MarkChangeStampSchema,
  TombstonedRecordSchema,
} from './knowledge/index'
export type {
  BriefWhyInput,
  BriefWhyNoTraceReason,
  BriefWhyResult,
  BriefWhyResultKind,
  ForgetReceiptV1,
  ForgetTargetRef,
  KnowledgeAcceptInput,
  KnowledgeAcceptChangeInput,
  KnowledgeChangeVerb,
  KnowledgeChangeOutput,
  KnowledgeChangeRefusalReason,
  KnowledgeForgetInput,
  KnowledgeForgetChangeInput,
  KnowledgeProjection,
  KnowledgeRecordShowInput,
  KnowledgeRecordShowOutput,
  KnowledgeRecordShowResult,
  KnowledgeRecordsDiffInput,
  KnowledgeRecordsDiffOutput,
  KnowledgeRecordsInspectInput,
  KnowledgeRecordsInspectOutput,
  KnowledgeRejectInput,
  KnowledgeRejectChangeInput,
  KnowledgeReviewVerb,
  KnowledgeTargetRef,
  MarkChangeStamp,
} from './knowledge/index'

// 381 procedure & guarded-replay contracts (D-03/D-04/D-06, Pitfall 6)
export { curatorTier } from './knowledge/curator-tier'
export type { CuratorTier, ProcedureParamType } from './knowledge/curator-tier'
export { plannerCapabilityTier } from './knowledge/planner-tier'
export type { PlannerCapability, PlannerCapabilityEvidence } from './knowledge/planner-tier'
export {
  PROCEDURE_BODY_SCHEMA_VERSION,
  parseProcedureBody,
  procedureJsonValueSchema,
  procedureStepKeys,
  serializeProcedureBody,
} from './knowledge/procedure-steps'
export type {
  ProcedureBodyPayload,
  ProcedureGuardDescriptor,
  ProcedureGuardTarget,
  ProcedureJsonValue,
  ProcedureParameterSpec,
  ProcedureStepSpec,
  ProcedureValueSlot,
} from './knowledge/procedure-steps'
export {
  EMPTY_PROCEDURE_BINDING_AVAILABILITY,
  procedureParameterFillability,
} from './knowledge/procedure-fillability'
export type { ProcedureBindingAvailability } from './knowledge/procedure-fillability'
export {
  coerceProcedureBindingValue,
  procedureSourceBinding,
} from './knowledge/procedure-binding-coercion'
export type { ProcedureSourceBinding } from './knowledge/procedure-binding-coercion'
export {
  COORDINATE_ACTION_KEYS,
  NON_REPLAYABLE_ACTION_TYPES,
  isReplayableActionShape,
} from './action/replayability'

// 384 function-layer contract vocabulary (D-13/D-16): the caller record and the seed op DTOs
// surfaces type against under the import firewall. 2026-10-02 (432-39, D-10/D-12): the
// capability-scope union is deleted.
export {
  FUNCTION_CALLER_ORIGINS,
  RUN_SUMMARY_SCHEMA_VERSION,
  RUN_DETAIL_SCHEMA_VERSION,
  RunSummarySchema,
  RunDetailSchema,
  RunTestDetailSchema,
  RunsListInputSchema,
  RunsGetInputSchema,
  RunsStartInputSchema,
  RunsEventsInputSchema,
  // 403 D-03: the runs.liveurl mint op's two contracts.
  RunsLiveUrlInputSchema,
  RunsLiveUrlResultSchema,
  // 428 D-07: the editor subject's mint op contracts.
  EditorLiveUrlInputSchema,
  EditorLiveUrlResultSchema,
  // 388 D-14: the chip-truth read op's two contracts, and the notification's wire shape.
  RunsPostProcessingInputSchema,
  RunNotificationViewSchema,
  PostProcessingStatusSchema,
  // 405 D-03: the run-detail read op's contracts.
  RunsDetailInputSchema,
  RunDetailMemberSchema,
  RunStepTokenUsageSchema,
  RunDetailStepSchema,
  RunDetailSubActionSchema,
  RunTokenTotalsSchema,
  RunDetailProjectionSchema,
  // 405-05 D-12/D-13: the artifact read op's two contracts.
  RunsArtifactInputSchema,
  RunsArtifactResultSchema,
  RunsEvidenceInputSchema,
  RunsEvidenceResultSchema,
  // 407 LERN-01/LERN-02 D-05: the `runs.knowledge` panel read's contracts.
  RunsKnowledgeInputSchema,
  RunKnowledgeBriefLineSchema,
  RunKnowledgeReadTraceSchema,
  RunKnowledgeCautionLineSchema,
  RunKnowledgeTraceSchema,
  RunKnowledgePlanSourceSchema,
  RunKnowledgeStepSchema,
  RunKnowledgeCanaryAttributionSchema,
  RunKnowledgeProjectionSchema,
  RUN_START_ACKNOWLEDGEMENT_SCHEMA_VERSION,
  RunStartAcknowledgementSchema,
  PlannerLimitsRecordSchema,
  RUN_EVENT_ENVELOPE_SCHEMA_VERSION,
  RunEventEnvelopeSchema,
  // 389 D-11: the analysis.get op's contracts.
  AnalysisGetInputSchema,
  AnalysisGetOutputSchema,
  AnalysisCitedArtifactSchema,
  AnalysisVerdictEvidenceSchema,
  AnalysisResolvedVerdictSchema,
  AnalysisSentenceSchema,
  AnalysisClusterViewSchema,
  AnalysisMemoryOnPathEntrySchema,
  KNOWLEDGE_BUNDLE_SUMMARY_SCHEMA_VERSION,
  KnowledgeBundleSummarySchema,
  KnowledgeBundlesListInputSchema,
  KnowledgeBundlesListOutputSchema,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  MaskedConfigEntrySchema,
  MaskedResolvedConfigSchema,
  ConfigGetInputSchema,
  // 393 D-01: the authoring.draft.verify op contracts (D-01 sketches the verb as
  // `verify_draft`; that spelling is unrepresentable — see functions/authoring.ts).
  AuthoringVerifyDraftInputSchema,
  AuthoringVerifyDraftOutputSchema,
  // 394 D-01: the authoring.draft.write op contracts and the closed loop-outcome vocabulary.
  AUTHORING_LOOP_OUTCOMES,
  AuthoringDraftWriteInputSchema,
  AuthoringDraftWriteOutputSchema,
  // 394 D-04: the stage-2 dedup refusal's payload and its two named continuations.
  AUTHORING_DEDUP_CONTINUATIONS,
  AuthoringDedupRefusalSchema,
  // 440 D-09: the stated-value refusal's payload and its two stages.
  AUTHORING_STATED_VALUE_STAGES,
  AuthoringStatedValueRefusalSchema,
  // 411 D-05..D-08: the stop payload a `stopped` invocation reports its verdict on.
  AUTHORING_REPAIR_ABANDONMENTS,
  AUTHORING_STOP_SIGNAL_CLASSES,
  AuthoringStopFailurePointSchema,
  AuthoringStopSchema,
  // 394-09 D-21: the authoring.draft.edit op contracts — the patch contract's second consumer.
  AuthoringDraftEditInputSchema,
  AuthoringDraftEditOutputSchema,
  // 394-07 D-12: the authoring.funnel.get op contracts and the closed window scope.
  AuthoringFunnelGetInputSchema,
  AuthoringFunnelGetOutputSchema,
  AuthoringFunnelWindowSchema,
  // 402-01 (D-06/D-13/D-15 · INVK-03): the authed run service's wire vocabulary.
  RUN_SERVICE_CONTRACT_VERSION,
  RUN_SERVICE_ERROR_CODES,
  RUN_SERVICE_REFUSED_REQUEST_FIELDS,
  RunServiceErrorBodySchema,
  RunServiceReadinessSchema,
  RunServiceReplayFloorBodySchema,
  RunServiceStartRequestSchema,
} from './functions/index'
export type {
  FunctionCaller,
  FunctionCallerOrigin,
  RunSummary,
  RunDetail,
  RunTestDetail,
  RunsListInput,
  RunsGetInput,
  RunsStartInput,
  RunsEventsInput,
  RunsLiveUrlInput,
  RunsLiveUrlResult,
  EditorLiveUrlInput,
  EditorLiveUrlResult,
  RunsPostProcessingInput,
  RunStartAcknowledgement,
  // 405 D-03: the run-detail shapes — the port's rows and the op's projection over them.
  RunsDetailInput,
  RunDetailMember,
  RunStepTokenUsage,
  RunDetailStep,
  RunDetailSubAction,
  RunTokenTotals,
  RunDetailRows,
  RunDetailProjection,
  // 405-05 D-12/D-13/D-15: the artifact read's shapes and the port's three-arm lookup answer.
  RunsArtifactInput,
  RunsArtifactResult,
  RunsEvidenceInput,
  RunsEvidenceResult,
  // 407 D-05: the panel projection's inferred shapes.
  RunsKnowledgeInput,
  RunKnowledgeProjection,
  RunKnowledgeStep,
  RunKnowledgeTrace,
  RunKnowledgePlanSource,
  RunKnowledgeCanaryAttribution,
  EvidenceBlobLookup,
  EvidenceBlobPresence,
  RunDetailArtifactRef,
  AnalysisGetInput,
  AnalysisGetOutput,
  AnalysisCitedArtifact,
  AnalysisVerdictEvidence,
  AnalysisResolvedVerdict,
  AnalysisSentence,
  AnalysisClusterMemberRef,
  AnalysisClusterView,
  AnalysisMemoryOnPathEntry,
  KnowledgeBundleSummary,
  KnowledgeBundlesListInput,
  ConfigValueSource,
  MaskedConfigEntry,
  MaskedResolvedConfig,
  ConfigGetInput,
  AuthoringVerifyDraftInput,
  AuthoringVerifyDraftOutput,
  AuthoringDraftWriteInput,
  AuthoringDraftWriteOutput,
  AuthoringLoopOutcomeKind,
  AuthoringDedupContinuation,
  AuthoringDedupRefusal,
  AuthoringStatedValueRefusal,
  AuthoringStatedValueStage,
  AuthoringRepairAbandonment,
  AuthoringStop,
  AuthoringStopFailurePoint,
  AuthoringStopSignalClass,
  AuthoringDraftEditInput,
  AuthoringDraftEditOutput,
  AuthoringFunnelGetInput,
  AuthoringFunnelGetOutput,
  AuthoringFunnelWindow,
  RunServiceErrorBody,
  RunServiceErrorCode,
  RunServiceReadiness,
  RunServiceReplayFloorBody,
  RunServiceStartRequest,
} from './functions/index'

// 393 (WTST-02, D-18/D-19): the keep-gate authoring vocabulary. `computeDraftDisposition` is
// the ONE derivation of a draft's disposition — 394 consumes it and must not re-derive its own.
export {
  computeDraftDisposition,
  DRAFT_DISPOSITIONS,
  DRAFT_GATE_NAMES,
  DRAFT_STABILITY_RUNS_N,
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  AddsValueFindingSchema,
  DraftGateResultsSchema,
  DraftReceiptSchema,
  DraftRefSchema,
  GateRunRecordSchema,
  StepClassificationRowSchema,
} from './authoring/index'
export type {
  AddsValueFinding,
  DraftDisposition,
  DraftDispositionInput,
  DraftGateBooleans,
  DraftGateName,
  DraftGateResults,
  DraftReceipt,
  DraftRef,
  GateRunRecord,
  StepClassificationRow,
} from './authoring/index'

// 432 D-06/D-07: the direct write of a final authored test. Which dispositions are written, what
// the writer reports for one file, and the written-test receipt with the four gate booleans.
export {
  DRAFT_WRITTEN_DISPOSITIONS,
  DraftGateBooleansSchema,
  TEST_FILE_NOT_WRITTEN_REASONS,
  TEST_FILE_WRITE_REFUSALS,
  TestFileWriteSchema,
  WrittenTestReceiptSchema,
  draftDispositionWritesTarget,
  draftGateBooleans,
} from './authoring/index'
export type {
  DraftWrittenDisposition,
  TestFileWrite,
  WrittenTestReceipt,
} from './authoring/index'

// 394 (WTST-07, D-20): the RFC-6902 `{thoughts, patches}` edit vocabulary and the pinned
// editable-region fence. The CST applier in `core` is its only mutating consumer.
export {
  EDITABLE_POINTER_ROOTS,
  PATCH_OP_KINDS,
  PatchOpSchema,
  TestEditPatchSetSchema,
  isEditablePointer,
  parseJsonPointer,
  pointerRootOf,
} from './authoring/index'
export type {
  EditablePointerRoot,
  PatchOp,
  PatchOpKind,
  TestEditPatchSet,
} from './authoring/index'

// 394-06 (WTST-01, D-05): the ONE envelope payload arm — a verified draft awaiting a human
// decision — plus the ONE run-evidence coordinate vocabulary the router builds and the stop arm
// carries.
export {
  AUTHORED_SUITE_SLUG_MAX_LENGTH,
  RUN_EVIDENCE_CHANNELS,
  RunEvidenceRefSchema,
  authoredSuiteTargetPath,
} from './authoring/index'
export type {
  RunEvidenceChannel,
  RunEvidenceRef,
} from './authoring/index'

// 394-07 (WTST-05, D-13/D-15): the honesty funnel. `computeAuthoringFunnel` is the ONE
// derivation of the four frozen stages, the keep rate and the acceptance-failure flag —
// every caller renders what it returns and derives nothing. Today that is `authoring.funnel.get`.
// `successFramingViolations` is the prohibition made mechanical: it is exported so a surface
// composing a BLOCK around the funnel's line screens its own wording through the same words.
export {
  AUTHORING_FUNNEL_STAGES,
  AuthoringFunnelSchema,
  FUNNEL_MIN_DRAFTS_FLOOR,
  FUNNEL_PHRASES,
  FUNNEL_SUCCESS_FRAMING_LEXICON,
  FunnelSuccessFramingError,
  KEEP_RATE_CEILING,
  computeAuthoringFunnel,
  renderFunnelLine,
  successFramingViolations,
} from './authoring/index'
export type {
  AuthoringFunnel,
  AuthoringFunnelInput,
  AuthoringFunnelStage,
  FunnelRenderParts,
  FunnelSideCounters,
} from './authoring/index'

// 394-07 (WTST-05, D-14): the mixed-verdict suite-stability read. PURE and it starts zero runs —
// D-14 is read-side precisely so WTST-08's fan-out preview stays a number somebody can honour.
export {
  NEIGHBOUR_INSTABILITY_REASONS,
  SUITE_STABILITY_POSTURES,
  assessSuiteStability,
  suiteTestRef,
} from './authoring/index'
export type {
  FlakyNeighbour,
  NeighbourInstabilityReason,
  SuiteNeighbourRow,
  SuiteStabilityAssessment,
  SuiteStabilityInput,
  SuiteStabilityPosture,
} from './authoring/index'

// 394-08 (WTST-08, D-03/D-10): the ONE fan-out arithmetic. `computeFanOutBound` is the only place
// `initial N + K probes + final N` is added up — the dispatch confirm renders it and the finished
// proposal reports against it, so a preview that understated what the loop would spend cannot be
// produced by one surface disagreeing with the other.
export {
  ConsumedRunSchema,
  FAN_OUT_PHRASES,
  FAN_OUT_RUN_PURPOSES,
  FanOutBoundError,
  FanOutBoundInputSchema,
  FanOutBoundSchema,
  FanOutReportSchema,
  NO_RUNS_FAN_OUT_BOUND,
  buildFanOutReport,
  computeFanOutBound,
  renderFanOutPreview,
  renderFanOutReport,
} from './authoring/index'
export type {
  ConsumedRun,
  FanOutBound,
  FanOutBoundInput,
  FanOutReport,
  FanOutRunPurpose,
} from './authoring/index'

// 394-09 (WTST-01, D-17): procedure-by-reference. A served procedure reaches a compiled draft as
// an ordinary NL step written in the procedure's own anchor vocabulary, matched and replayed at run
// time against the LIVE record — so a later procedure fix propagates and the committed test carries
// no learned-shelf record id that supersession or collection could rot.
export { procedureStepVocabulary } from './authoring/index'

// 387 ENTY-01/ENTY-02 — entity addressing: short-IDs, the agentqa:// URI scheme, the one
// card shape and the two resolution unions.
export {
  ENTITY_CARD_MAX_ACTIONS,
  ENTITY_CARD_MAX_KEY_FACTS,
  ENTITY_DASHBOARD_ROUTES,
  ENTITY_DASHBOARD_ROUTE_GRAINS,
  ENTITY_EXACT_MATCH_SCORE,
  ENTITY_FIRST_ORDINAL,
  ENTITY_IDENTITY_FACT_LABELS,
  ENTITY_KINDS,
  ENTITY_NO_MATCH_REASONS,
  ENTITY_ORDINAL_MIN_DIGITS,
  ENTITY_RESOLUTION_MAX_CANDIDATES,
  ENTITY_STATUSES,
  ENTITY_URI_SCHEME,
  ENTITY_URI_SEGMENTS,
  ENTITY_URL_ROUTE,
  ENTITY_URL_ROUTE_PARAMS,
  ENTITY_URL_SLUG_MAX_LENGTH,
  SLUG_ADDRESSED_ENTITY_KINDS,
  ActionRefSchema,
  EntitiesGetInputSchema,
  EntitiesResolveInputSchema,
  EntityCardResolutionSchema,
  EntityCardSchema,
  EntityDescriptorSchema,
  EntityResolutionSchema,
  EntityUriSchema,
  KeyFactSchema,
  canonicalShortId,
  entityKindForUriSegment,
  entityTitleSlug,
  entityUriSegmentFor,
  formatEntityOrdinal,
  formatEntityUri,
  formatEntityUrl,
  formatOrdinalShortId,
  formatSlugShortId,
  isEntityKind,
  isEntityUri,
  isRoutedEntityKind,
  isSlugAddressedKind,
  parseEntityUri,
  parseShortId,
} from './entity/index'
export type {
  ActionRef,
  EntitiesGetInput,
  EntitiesResolveInput,
  EntityCard,
  EntityCardResolution,
  EntityDashboardRoute,
  EntityDashboardRouteGrain,
  EntityDescriptor,
  EntityKind,
  EntityNoMatchReason,
  EntityResolution,
  EntityStatus,
  EntityStatusFor,
  EntityUriSegment,
  EntityUrlInput,
  KeyFact,
  ParsedEntityUri,
  ParsedShortId,
} from './entity/index'

// 342 safety contracts
// 2026-10-15 (441-45, D-12/D-15): the guardrail policy schema, the masking context, the scan, the
// content origin and the hook results are deleted; the risk tier and the disclosure scrub remain.
// 2026-10-01 (432-18, D-14/D-15/D-22): the standing-grant ledger's event vocabulary and guards are
// deleted with the ledger. `STANDING_APPROVAL_SCOPE` moved to `trust-credential.ts` (432-18) and was
// deleted with the MCP bearer credential that carried it (432-21, D-12).
// 2026-10-02 (432-42, D-12): the scope key set (391-11) is deleted with its module; no caller,
// credential or projection ranges it any more.
// The disclosure fragment scrub: one untrusted fragment made safe to read on a single line.
export {
  DISCLOSURE_FRAGMENT_MAX_LENGTH,
  DISCLOSURE_REPLACEMENT_CHARACTER,
  DISCLOSURE_TRUNCATION_MARK,
  scrubDisclosureFragment,
} from './safety/index'
// 2026-10-01 (432-19, D-15): the remedy vocabulary, the execution-policy verdict and result, and the
// standing-approval contract are deleted with the gate. A refusal is a plain reason.
// 2026-10-01 (432-18): the grant verbs' contracts, the protected-class set and the standing-grants
// port are deleted. 2026-10-01 (432-22, D-12): the trust-scope wire projection leaves with its last
// consumer, the run-service token DTO. 2026-10-02 (432-39, D-12): the `TrustScope` and
// `TrustCredential` caller types are deleted with the caller's `credential` member.
export type { RiskActionDescriptor } from './safety/index'
// 392 CHAT-01/CHAT-05, D-14/D-18/D-24: the conversational surface's whole vocabulary — the session
// log's event grammar and header, the per-clause turn receipts, the `agent.ask` contracts, and the
// session-log port. Minted here rather than beside the turn engine because every one of them has
// several consumers that may not import each other: `agent` emits, `agent-local` persists, `cli`
// renders, and 396's MCP projection plus M5's dashboard read the same bytes (388 C13).
export {
  AgentAskInputSchema,
  AgentAskResultSchema,
  CHAT_SESSION_EVENT_KINDS,
  CHAT_STAGE_OUTCOMES,
  CHAT_TURN_STAGES,
  CHAT_TURN_STATUSES,
  CLAUSE_RECEIPT_STATUSES,
  CURRENT_CHAT_SESSION_SCHEMA_VERSION,
  ChatScenarioSchema,
  ChatSessionEventSchemaError,
  ClauseReceiptSchema,
  ClauseResultSchema,
  SCENARIO_CLASSES,
  SCENARIO_EXPECTATIONS,
  SCENARIO_LANES,
  ScenarioExpectationSchema,
  clauseReachedCapability,
  guardChatSessionEvent,
} from './chat/index'
export type {
  AgentAskInput,
  AgentAskResult,
  ChatAbortedEvent,
  ChatActiveToolsChangeEvent,
  ChatApprovalDecisionEvent,
  ChatClauseReceiptEvent,
  ChatClauseResultEvent,
  ChatCompactionEvent,
  ChatMarkUnhandledEvent,
  ChatModelChangeEvent,
  ChatScenario,
  ChatSessionEvent,
  ChatSessionEventBase,
  ChatSessionEventKind,
  ChatSessionHandle,
  ChatSessionHeader,
  ChatStageOutcome,
  ChatStageOutcomeEvent,
  ChatTurnCompleteEvent,
  ChatTurnStage,
  ChatTurnStatus,
  ChatUserMessageEvent,
  ClauseReceipt,
  ClauseReceiptStatus,
  ClauseResult,
  OpenedChatSession,
  RefusedChatSessionLine,
  ScenarioClass,
  ScenarioExpectation,
  ScenarioExpectationKind,
  ScenarioLane,
  SessionLogPort,
} from './chat/index'

// 396-04 (D-01 / D-16 · MCPS-02): `runs.list`'s named output contract and the three declared fold
// contracts the MCP catalogue advertises. Published on the barrel because `packages/mcp` is their
// consumer and it reaches this package only through here. 431-03 adds the canonical output
// contracts beside them.
export {
  RunsListOutputSchema,
  RunsListOutputContract,
  RunsArtifactOutputContract,
  RunsEvidenceOutputContract,
  createOutputContract,
  deriveWireOutputRepresentation,
  wireOutputContract,
  RUNS_LIST_DEFAULT_LIMIT,
  RUNS_LIST_MAX_LIMIT,
  TOOL_FOLD_DISCRIMINANT,
  AuthoringRefineFoldInputSchema,
  AuthoringRefineFoldOutputSchema,
  ConfigChangeFoldInputSchema,
  ConfigChangeFoldOutputSchema,
  KnowledgeChangeFoldInputSchema,
  KnowledgeChangeFoldOutputSchema,
  RunsEvidenceFoldInputSchema,
  RunsEvidenceFoldOutputContract,
} from './functions/index'
export type {
  RunsListOutput,
  JsonSchemaDocument,
  OutputContract,
  RecordedTargets,
  RunSummaryTest,
  AuthoringRefineFoldInput,
  ConfigChangeFoldInput,
  KnowledgeChangeFoldInput,
  RunsEvidenceFoldInput,
} from './functions/index'

// 398-01 (D-05 / D-08 · XPLN-01): the capability-catalog row DTOs. Minted here per 384 D-16 —
// the artifact is produced in `packages/cli` and read back by the CLI's runtime loader, so the
// contract between the producer and every consumer belongs in the package neither of them owns.
export {
  AgentManifestPostureSchema,
  AgentManifestSchema,
  CapabilityCatalogSchema,
  CatalogAliasRowSchema,
  CatalogExampleCallSchema,
  CatalogOpRowSchema,
  CatalogRowSchema,
  CatalogSkillRowSchema,
  CatalogSurfaceSchema,
  catalogRowKey,
} from './capability-catalog'
export type {
  AgentManifest,
  AgentManifestPosture,
  CapabilityCatalog,
  CatalogAliasRow,
  CatalogExampleCall,
  CatalogOpRow,
  CatalogRow,
  CatalogSkillRow,
  CatalogSurface,
} from './capability-catalog'

// 398-04 (D-10 / D-11 · XPLN-02): the `explain` contract — the binary answer|abstention union with
// no confidence member, and the closed citation shape that is the whole of the model's output
// contract. Minted here per 384 D-16: the deterministic renderer lives in `packages/agent` and the
// op's host binding in `packages/agent-local`, so the shape they agree on belongs to neither.
export {
  ExplainAbstentionSchema,
  ExplainAnswerSchema,
  ExplainCitationSchema,
  ExplainCitedCapabilitySchema,
  ExplainCitedRowKindSchema,
  ExplainInputSchema,
  ExplainOutputSchema,
  ExplainProseSegmentSchema,
} from './explain'
export type {
  ExplainAbstention,
  ExplainAnswer,
  ExplainCitation,
  ExplainCitedCapability,
  ExplainCitedRowKind,
  ExplainInput,
  ExplainOutput,
  ExplainProseSegment,
} from './explain'
// 416 receipt vocabulary and the promotion result seam.
export { GATE_RECEIPT_SCHEMA_VERSION, GATE_NUMBERS, GATE_VERDICTS, GateReceiptSchema,
  PromotionReceiptSchema, GateLineSchema, receiptDigestOf, stampReceiptDigest,
  isPromotionReceipt, standingReceiptsByGate, strongestPromotionPath } from './knowledge/gate-receipt'
export type { GateNumber, GateVerdict, GateReceipt, PromotionReceipt, GateLine } from './knowledge/gate-receipt'
export { PROMOTION_PATHS, PROMOTION_PATH_STRENGTH, strongerPromotionPath } from './knowledge/promotion-path'
export type { PromotionPath } from './knowledge/promotion-path'
export type { PromotionOutcome, GateReceiptRecordOutcome, PromotionCandidateProvenance } from './knowledge/promotion-gate'
export { KnowledgeGatesListInputSchema, KnowledgeGatesListResultSchema,
  PromotionGateVerdictSchema } from './functions/knowledge'
export type { KnowledgeGatesListInput, KnowledgeGatesListResult } from './functions/knowledge'

export { BENEFITS, MARKS, gate3ArmSchema } from './knowledge/gate-receipt'
export type { Benefit, Mark, Gate3Receipt } from './knowledge/gate-receipt'
export { RecordAnchorsSchema, RecordScopeSchema } from './knowledge/record-frontmatter'
export { BundleKindSchema, BundleStatusSchema } from './functions/knowledge'
export { BriefLineSchema } from './brief/guard-lossless-served-brief'

// 2026-09-08, 419 D-06: the Gate-3 feedback contracts
export {
  MARK_QUARANTINE_CLASSES, MARK_FIX_KINDS, MARK_DISPOSITIONS, MARK_FIX_REFUSALS,
  // 2026-09-30, 432-09: the applied fix and the historical drafted receipt (the plain mark refusal,
  // MarkRefusalSchema, was deleted by 432-42)
  MARK_HISTORICAL_DISPOSITIONS, MARK_APPLIED_CHANGE_KINDS, MarkAppliedChangeSchema,
  MARK_RECEIPT_SCHEMA_VERSION, IMPROVEMENT_PLAN_SCHEMA_VERSION, COMMIT_RECEIPT_SCHEMA_VERSION,
  NoDraftableFixCheckedSchema, MarkDispositionSchema, MarkAddressSchema, MarkReceiptSchema,
  RunsMarkInputSchema, RunsMarkOutcomeSchema, ImprovementPlanKnowledgeSchema,
  ImprovementPlanSchema, CommitReceiptSchema, RunDetailMemberMarkSchema, deriveMarkStepId,
  // 2026-09-15, 423 D-19: marks history
  markAddressKey, MARKS_HISTORY_OUTCOMES, MarkHistoryChangedRecordSchema,
  RunsMarksHistoryInputSchema, MarkHistoryEntrySchema, RunsMarksHistoryResultSchema,
  // 2026-09-15, 423 D-16/D-17: mark consequence preview
  MARK_PREVIEW_REFUSALS, MARK_PREVIEW_OUTCOMES, MARK_TARGET_REASONS,
  MARK_PREVIEW_LATEST_KINDS, MARK_PREVIEW_DRAFT_KINDS, MarkPreviewBasisSchema, MarkPreviewLatestSchema,
  MarkPreviewKnowledgeSchema, MarkPreviewDraftSchema,
  RunsMarkPreviewResultSchema,
  MARK_PREVIEW_EVIDENCE_DIRECTIONS, MARK_PREVIEW_RECORD_EVIDENCE_KINDS, MarkPreviewEvidenceEffectSchema,
  MarkPreviewKnowledgeRecordSchema,
} from './functions/feedback'
export type {
  MarkQuarantineClass, MarkFixKind, MarkFixRefusal, MarkDisposition, NoDraftableFixChecked, MarkAddress,
  MarkReceipt, RunsMarkInput, RunsMarkOutcome, ImprovementPlanKnowledge, ImprovementPlan,
  CommitReceipt, RunDetailMemberMark, FeedbackPort, MarkAppliedChange,
  MarkHistoryChangedRecord, RunsMarksHistoryInput, MarkHistoryEntry,
  RunsMarksHistoryResult, MarkHistoryReadEntry, MarkHistoryRead, FeedbackReadsPort,
  MarkPreviewBasis, MarkPreviewLatest, MarkPreviewKnowledge,
  MarkPreviewDraft, RunsMarkPreviewResult, MarkPreviewEvidenceEffect,
  MarkPreviewKnowledgeRecord,
} from './functions/feedback'
// 2026-09-15, 423 D-20/D-17: the one read-time record join, shared by runs.knowledge and runs.mark.preview
export { projectRecordContent, maskRecordContent } from './functions/record-join'
export type { RunKnowledgeRecordContent, RunKnowledgeContentAbsence } from './functions/record-join'
export { KnowledgeMarkInputSchema } from './knowledge/review-verbs'
export type { KnowledgeMarkInput } from './knowledge/review-verbs'
export { OVERTURNED_EVENT_TYPE } from './knowledge/outcome-event'
// 2026-09-26, 429-04 D-18: the one provider-error classifier the CLI, the dashboard server and
// the UI share, with the CLI's order and sentences.
export {
  classifyProviderError,
  extractProviderError,
  PROVIDER_ERROR_CLASSES,
  providerErrorSentence,
} from './llm/provider-error'
export type { ProviderErrorClass } from './llm/provider-error'
// 2026-09-26, 429-04 D-15/D-09/D-24: the draft connect, credential save and move DTOs.
export {
  LLM_SETUP_REFUSALS,
  LlmConnectRequestSchema,
  LlmCredentialMoveRequestSchema,
} from './llm/connect'
export type {
  LlmConnectRequest,
  LlmConnectResult,
  LlmCredentialMoveRequest,
  LlmCredentialSaveResult,
  LlmSetupRefusal,
} from './llm/connect'
