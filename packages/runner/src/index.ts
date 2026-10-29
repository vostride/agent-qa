export type {
  PlatformAdapter,
  ActionsFor,
  Action,
  ActionResult,
  PlatformConfig,
  BrowserConfig,
  DeviceConfig,
  TimeoutConfig,
  RuntimeAuthStateConfig,
  LiveStreamCapability,
  RecordingStart,
  RecordingStop,
  RecordingCapability,
  OperationCaptureSupport,
  ExecuteOptions,
} from './platform.js'
export type {
  KnowledgeHintReader,
  ServedCautions,
  ServedRunBrief,
} from './knowledge-hint-reader.js'
export { assertNever } from './platform.js'
// Lets runner consumers build branded refs without a direct schema dependency.
export { asRef } from '@vostride/agent-qa-schema'
export type { Ref } from '@vostride/agent-qa-schema'

export { buildScreenState, renderScreenTree, stampCaptureMode } from './screen-builder.js'
export type {
  InterimNode,
  BuildScreenStateInput,
  BuildScreenStateResult,
  RefBinding,
  CaptureStamp,
} from './screen-builder.js'

export {
  judgeStatedTarget,
  ROW_CONTAINER_ROLES,
  rowContains,
  rowTextOf,
  wordTokens,
} from './grounding/index.js'
export type { StatedTarget, StatedTargets } from './grounding/index.js'

// Pure compound helpers the adapters import through the runner barrel.
export * from './compound/index.js'
export { compareSavedFile, FILE_DIFFERENCE_WINDOW } from './compound/file-compare.js'
export type { SavedFileComparison, SavedFileExpectation } from './compound/file-compare.js'

export { makeScreenState, makeInterimNodes } from './testing/screen-fixtures.js'
export type { InterimFixture, InterimFixtureKind } from './testing/screen-fixtures.js'
export {
  metVerification,
  notMetVerification,
  scriptedVerification,
  toVerificationResult,
} from './testing/condition-verdicts.js'
export type { ScriptedVerdict } from './testing/condition-verdicts.js'
export { screenConformanceCases } from './testing/conformance.js'
export type { ConformanceInput, ScreenConformanceCase } from './testing/conformance.js'

export type {
  StepStatus,
  TestStatus,
  StepAnnotation,
  TokenUsage,
  SubActionTrace,
  StepTrace,
  StepPhaseEvent,
  AccessibilityViolation,
  ConsoleLogEntry,
  NetworkLogEntry,
  StepResult,
  TestResult,
} from './result.js'

export { executeStep } from './loop/index.js'
// The CLI composition root builds one per run and threads it into `LoopPorts.workingMemory`.
export { WorkingMemoryStore } from './loop/working-memory/index.js'
export type { WorkingMemoryProvenanceContext } from './loop/working-memory/index.js'
export {
  createTimeoutAbortReason,
  getTimeoutAbortReason,
  withAbort,
} from './loop/abort.js'
export type { AgentAbortScope, AgentTimeoutAbortReason } from './loop/abort.js'
export type {
  ActionPlan,
  PlannerConfig,
  PlanningCallGate,
  PlanResult,
  VerificationResult,
  ConditionJudgment,
  DialogAccount,
  VerifyResult,
  StepContext,
  Planner,
  Verifier,
  AiJudgment,
  AiExtraction,
  AssertAiMode,
  ExtractField,
  Asserter,
  AssertionInput,
  AssertionResult,
  AssertionType,
  ExtractionMethod,
  ExtractorInput,
  CaptureResult,
  VariableExtractor,
} from './loop/types.js'
// A class value, so the replay engine classifies planner failures by identity, not message.
export { LLMPlanner, PlanningLimitReachedError, PlanningTurnError } from './loop/planner.js'
export {
  executePlanningTurn,
  DEFAULT_NON_ACTION_TOOL_BUDGET,
} from './loop/planning-turn.js'
export type {
  NonActionToolHandler,
  NonActionToolMap,
  ToolExchange,
  PlanningTurnResult,
  PlanningTurnSuccess,
  PlanningTurnFailure,
  PlanningTurnFailureReason,
  ExecutePlanningTurnOptions,
} from './loop/planning-turn.js'
export { LLMVerifier, VerificationResultSchema, AiJudgmentResultSchema } from './loop/verifier.js'
export { AssertionEvaluator, LLMAssertionEvaluator, createAsserter } from './loop/asserter.js'
// The variables subsystem: store, interpolation and extractors.
export * from './variables/index.js'
export {
  buildSystemPrompt,
  buildContextTier,
  buildVolatileTier,
  renderBriefAsHypotheses,
  composeTurnMessages,
  buildVerifierStableTier,
  buildVerificationPrompt,
  buildAssertionPrompt,
  buildExtractionPrompt,
  formatAction,
  estimateTokens,
} from './loop/prompts.js'
export {
  StepRecordAccumulator,
  renderStepRecord,
  RECORD_ACTION_LINE_CAP,
  RECORD_LINE_CHAR_CAP,
  RECORD_LIST_CAP,
} from './loop/step-record.js'
export type {
  CarriedLine,
  RecordedAction,
  RecordedActionOutcome,
  RecordedRead,
  RecordedReadKind,
  RenderedStepRecord,
  VerifierStepRecord,
} from './loop/step-record.js'
export {
  CHARS_PER_TOKEN_ESTIMATE,
  OBSERVATION_LINE_PREFIX,
  assembleBriefTiers,
  estimateRenderedServingCost,
  renderBriefLine,
  renderCautionLine,
  renderCautionSummary,
  renderObservationLine,
  tierForEntry,
} from './knowledge-brief-render.js'
export type { RenderedCautionLine } from './knowledge-brief-render.js'
export {
  EvidenceRecorder,
  collapseAnnotation,
  makeEmptyServedBrief,
  foldCacheStatus,
  projectLegacyTrace,
} from './loop/evidence.js'
export type { RecordSubActionInput } from './loop/evidence.js'
export type {
  CompressedScreenshot,
  ScreenshotCompressor,
  SecretResolver,
  SecretRedactorPort,
  LoopScopedLogger,
  LoopLogger,
  LoopPorts,
  CarriedArtifacts,
  CarriedClipboard,
  CarriedDownload,
  EvidenceArtifactStorePort,
  PersistedRecording,
  WorkingMemoryPort,
  TokenAccounting,
  RunnerDegradeOptions,
  RunnerDegradeOutcome,
} from './loop/ports.js'

export type {
  ActionPlanCache,
  CacheablePlannedAction,
  CachedPlanValue,
  GroundedLocator,
  GroundingStrategy,
  CacheableClassification,
  ClassifyStepInput,
  BuildCacheableStepInputArgs,
  BuildCachedPlanValueInput,
} from './cache/index.js'

// Runner stays storage-neutral; runner-local FsStorageStateStore implements this port.
export type {
  StorageStatePort,
  StorageStateReference,
  StorageStateBlob,
} from './storage-state/port.js'

// The in-memory event bus and the run-layer port contracts, declared interface-first.
export { createRunEventBus, ReplayIncompleteError } from './run/bus.js'
export type { RunEventBus, CreateRunEventBusOptions } from './run/bus.js'
// The per-run live-frame hub: lazy start, graced stop, bounded ack.
export {
  createLiveStreamHub,
  defaultLiveStreamTimer,
  LIVE_STREAM_ACK_BOUND_MS,
  LIVE_STREAM_STOP_GRACE_MS,
} from './run/live-stream-hub.js'
export type { LiveStreamHub, CreateLiveStreamHubOptions } from './run/live-stream-hub.js'
// The labelled 1s snapshot producer behind the same capability contract.
export {
  createSnapshotLiveStream,
  imageSizeOf,
  LIVE_KEEPALIVE_QUIET_MS,
  LIVE_SNAPSHOT_INTERVAL_MS,
  liveStreamFor,
} from './run/snapshot-live-stream.js'
export type { LiveStreamRegistration } from './run/snapshot-live-stream.js'
export type {
  BaselineProbeResult,
  ConfigDigests,
  EventLogPort,
  HandoffStorePort,
  RunTimerPort,
  RunMemberDescriptor,
  MemberEventSink,
  MemberEvidenceContext,
  MemberTestRunContext,
  MemberTestExecutor,
  RunConfig,
  RunPorts,
  HookExecutorPort,
  HookExecuteOptions,
  RunArtifactStorePort,
  // The post-verdict step the shell awaits between `verdict` and `runFinished`.
  PostVerdictPort,
  PostVerdictStepInput,
  PostVerdictOutcome,
} from './run/ports.js'
export { POST_VERDICT_STEP_BUDGET_MS } from './run/ports.js'
export { createStepModelScope, withStepModelCall } from './run/step-model-observations.js'
export type {
  StepModelCallReport, StepModelCallEvent, StepModelObservation, StepModelScopeKey,
  StepModelRoleFacts, StepModelAttempt, StepModelSnapshot, StepModelConsumers,
  StepModelScope, StepModelScopeFactory, StepModelBinding, StepModelScopeOptions,
} from './run/ports.js'
// The Docker implementation lives in runner-local behind the HookExecutorPort above.
export * from './hooks/index.js'
// The run shell, owner of the run lifecycle every surface attaches to.
export { startRun } from './run/shell.js'
export { createMemberEventSink } from './run/event-sink.js'
// The member runner and the pure inline-DSL parsing, tested against fakes.
export { runMemberTest, memberStepText } from './run/member-runner.js'
export type {
  MemberTest,
  MemberStepSpec,
  MemberRunConfig,
  RunJsHandler,
  AppiumScriptHandler,
  AccessibilityCheckHandler,
  FailureScreenshotWriter,
} from './run/member-runner.js'
export {
  parseHookInline,
  stripHookInline,
  isCanonicalHookIdShape,
  parseRunJSInline,
  coerceRunJSResult,
  parseAppiumInline,
} from './run/inline-steps.js'
export type { InlineHookCall, RunJSMatch } from './run/inline-steps.js'
export { generateFailureSummary } from './run/failure-summary.js'
export {
  assemblePerTestOutcome,
  skippedPerTestOutcome,
  assembleHandoff,
} from './run/handoff-assembly.js'
// Pure verdict derivation, resolved from the barrel by the shell and the CLI.
export {
  deriveMemberOutcome,
  deriveAggregateVerdict,
  mapVerdictToExitCode,
  isTestTimeoutMessage,
} from './run/verdict.js'
// One spelling of the `unknown` verdict; a second would drift silently and still typecheck.
export { deterministicVerdict, UNKNOWN_SIGNAL_RATIONALE } from './run/root-cause.js'
// Downstream corpora build floor verdicts as the shell does, so no impossible pair slips in.
export { classifyRootCause } from './run/root-cause.js'
export type { DeterministicRootCauseClass, RootCauseInput } from './run/root-cause.js'
export type { LoopEventEmitPort } from './loop/ports.js'
export { createRecordLedger } from './loop/record-ledger.js'
export type { RecordAdmission, RecordLedger } from './loop/record-ledger.js'
// The CLI owns capability gating and binds these tool handlers into LLMPlanner.
export { createMemoryTools } from './loop/memory-tools.js'
export {
  buildCacheableStepInput,
  CACHE_ENV_DIGEST_SALT,
  classifyStep,
  toGroundedLocator,
  buildCachedPlanValue,
  deterministicDescriptorMatcher,
} from './cache/index.js'
export {
  SecretStore,
  SecretRedactor,
  SecretConfigError,
  MissingSecretError,
  findSecretTemplates,
  interpolateSecretTemplates,
  resolveSecretTemplatesInValue,
  redactSecretValue,
  containsRedactedSecretMarker,
  literalSecretMarkerRefusal,
} from './loop/secrets.js'
export type { SecretTemplate, SecretFileMetadata } from './loop/secrets.js'

// Re-exporting runs registerAllActions on defaultRegistry; nothing here shrinks the tool slice.
export {
  ToolRegistry,
  defaultRegistry,
  buildTools,
  toolCallToActionPlan,
} from './tools/index.js'
export type { ToolDefinition, ToolCategory } from './tools/index.js'
export { EXPOSURE } from './tools/registry.js'
export { normalizePointerActionForStep } from './tools/pointer-action-normalization.js'
export { convertKeysForPlatform, isMacPlatform } from './tools/actions/key-conversion.js'
