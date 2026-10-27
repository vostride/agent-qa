export type {
  PlatformAdapter,
  ActionsFor,
  ObserveOptions,
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
// D-15 (Phase 360): re-export the schema Ref brand helper so runner consumers (dashboard,
// core, adapters) can construct branded refs for the schema-projected Action world without a
// direct schema dependency.
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

// Pure, provider-neutral compound helpers the three adapters ride (Phase 359 · D-02).
// Adapter packages import these via the runner barrel (352 buildScreenState precedent).
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

// Step-execution loop spine (re-derived into runner, Phase 353).
export { executeStep } from './loop/index.js'
// Run-scoped working-memory store (Phase 358 · WM-01/WM-02). Exported so the CLI composition
// root constructs one per run and threads it into LoopPorts.workingMemory (the 361 rebind seam).
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
// PlanningTurnError is exported as a class value (not type-only): the Phase 368 replay
// engine (plan 368-04) must instanceof-classify structured planner failures by identity,
// never string-match the message (D-09). NonActionToolHandler/NonActionToolMap are already
// re-exported from ./loop/planning-turn.js below (eval core's ports import them in 368-02).
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
// Phase 363 D-07 — runner-owned variables subsystem (store / interpolation / extractors).
// LLMVariableExtractor rides the injected-model idiom in loop/; the sub-barrel re-exports it.
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
// Phase 356 redesigned cache port (D-03): the new per-key ActionPlanCache is the
// single public cache surface. The v1 StepKeyInput / v1 sub-action ActionPlanCache
// are intentionally no longer exported here — they survive internally in
// loop/ports.ts until Plan 04 rewires the loop and Plan 06 retires the v1 adapter.
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

// Redesigned pure cache core (Phase 356, CACHE-01/02/03).
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

// Storage-state persistence port (Phase 360, D-14). Runner stays storage-neutral — the
// runner-local FsStorageStateStore implements this; the loop records only the reference.
export type {
  StorageStatePort,
  StorageStateReference,
  StorageStateBlob,
} from './storage-state/port.js'

// Run layer (Phase 361, SESSION-01/02 · D-01/D-02/D-04/D-05). The in-memory §2.2 event bus
// (pure runner logic) plus every new run-layer port contract, declared interface-first so
// runner-local (Plan 07), core, and cli build against them. The LoopEventEmitPort lives on
// LoopPorts (loop/ports.js) and is re-exported there.
export { createRunEventBus, ReplayIncompleteError } from './run/bus.js'
export type { RunEventBus, CreateRunEventBusOptions } from './run/bus.js'
// 403 D-05/D-07: the per-run live-frame hub (lazy start, graced stop, bounded ack).
export {
  createLiveStreamHub,
  defaultLiveStreamTimer,
  LIVE_STREAM_ACK_BOUND_MS,
  LIVE_STREAM_STOP_GRACE_MS,
} from './run/live-stream-hub.js'
export type { LiveStreamHub, CreateLiveStreamHubOptions } from './run/live-stream-hub.js'
// 428 D-11/D-13: the labelled 1s snapshot producer behind the same capability contract.
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
  // 404-01 (D-10): the post-verdict step the shell awaits between `verdict` and `runFinished`.
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
// Phase 363 D-06 — runner-owned hook contracts + orchestration. The Docker impl
// (DockerHookExecutor) lives in runner-local behind the HookExecutorPort above.
export * from './hooks/index.js'
// SESSION-01/02/04/05 run shell (Plan 06) — the run lifecycle owner every later surface
// (362 seams, 363 reporters, M1b/M2 handoff readers) attaches to. The projection/mask sink
// and §A8 handoff assembly are exported for CLI/core composition roots (Plans 09–11).
export { startRun } from './run/shell.js'
export { createMemberEventSink } from './run/event-sink.js'
// Phase 363 D-05 — the runner-owned member-runner (dissolution target for core's
// runTest/runTestWithRetry) + the pure inline-DSL parsing + the moved failure-summary.
// Built + tested against fakes here; Plan 11 cuts the CLI over and deletes the core side.
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
// SESSION-04 verdict-derivation core (Plan 05) — the shell (Plan 06, via src) and the CLI
// (Plans 10/11, via dist) resolve these pure functions from the barrel.
export {
  deriveMemberOutcome,
  deriveAggregateVerdict,
  mapVerdictToExitCode,
  isTestTimeoutMessage,
} from './run/verdict.js'
// 388 D-02: the analyze-run bridge fills a member the classifier declined to classify with
// the SAME 'unknown' verdict the classifier itself would have minted. It resolves that value
// from here rather than restating the six fields, because a second spelling of a verdict's
// base is free to drift from the one 389 supersedes — and the drift would be silent, since
// both spellings would still typecheck as a Verdict.
export { deterministicVerdict, UNKNOWN_SIGNAL_RATIONALE } from './run/root-cause.js'
// 390-21: the classifier itself, beside the verdict base it mints, for the same reason. A
// downstream corpus that needs a floor verdict must be able to build it THE WAY THE SHELL DOES —
// from a member's TestResult, its derived outcome and its index — instead of writing one out by
// hand. A hand-written floor verdict is free to carry a (class, producer) pair `classifyRootCause`
// cannot emit for any input, and 390-16 shipped green over exactly that: the tests passed, the
// mutation differential reddened only the impossible fixtures, and nobody could tell.
export { classifyRootCause } from './run/root-cause.js'
export type { DeterministicRootCauseClass, RootCauseInput } from './run/root-cause.js'
export type { LoopEventEmitPort } from './loop/ports.js'
export { createRecordLedger } from './loop/record-ledger.js'
export type { RecordAdmission, RecordLedger } from './loop/record-ledger.js'
// Phase 380 composition seam: the CLI owns capability gating and binds these runner-owned,
// provider-neutral tool handlers into LLMPlanner's optional non-action surface.
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

// v45 tool registry — the planned-actions-as-tools substrate (moved from core,
// Phase 353; D-09 frozen envelope). Re-exporting from ./tools/index.js runs its
// top-level registerAllActions side-effect on defaultRegistry. Always-send-all law:
// nothing here gates or shrinks the tool slice.
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
