export type {
  AuthoringReadPort,
  KnowledgePort,
  PersistencePort,
  ClockPort,
} from './ports/index.js'

// `invokeFunction` is the only exported way to run a capability; the arch barrel lint pins the set.
export { createFunctionRegistry, DuplicateFunctionIdError } from './functions/registry.js'
// Published for the composition root; it runs a spec's folds and dispatches nothing.
export { foldFunctionResult } from './functions/classify.js'
export type { FunctionResultFold } from './functions/classify.js'
export type { CreateFunctionRegistryOptions, FunctionRegistry } from './functions/registry.js'
// A two-field data type; the classifier itself stays on the spec.
export type { ClauseVerdict } from './functions/spec.js'
// The optional dep vocabulary is data and carries no dispatch capability.
export { OPTIONAL_FUNCTION_DEP_KEYS } from './functions/spec.js'
export {
  invokeFunction,
  FunctionInputError,
  FunctionNotBoundError,
  UnknownFunctionError,
} from './functions/invoke.js'
// Keep comments above an export clause: the arch barrel pin ends a clause at a blank line.
export type {
  AnalysisArtifactReaderPort,
  ConfigReaderPort,
  EntityDirectoryPort,
  FunctionBindingStatus,
  FunctionDeclaration,
  FunctionDeps,
  FunctionResultKind,
  FunctionStream,
  KnowledgeReaderPort,
  KnowledgeReviewPort,
  OptionalFunctionDepKey,
  PostProcessingChainState,
  PostProcessingJobRow,
  PostProcessingReaderPort,
  ReplayedRunEvent,
  RunInvocationPort,
  RunsReaderPort,
  StartedRun,
  StepEvidenceAddress,
  StepEvidenceLookup,
} from './functions/spec.js'
// A separate statement: the arch pin's clause scanner stops after 24 continuation lines.
export type { LiveViewPort } from './functions/spec.js'
// A separate statement, for the same clause-length reason; a type, so no database crosses here.
export type { RunDetailReaderPort } from './functions/spec.js'
// A separate statement, for the same reason; a type, so no filesystem crosses this barrel.
export type { EvidenceBlobReaderPort } from './functions/spec.js'
// Caller-facing refusals a surface may legitimately catch and report. Op-level errors live
// with the op that throws them; only the error CLASS crosses the barrel, never the spec.
export {
  RunEndedWithoutVerdictError,
  RunNotFinishedError,
  RunNotFoundError,
} from './functions/ops/runs-get.js'
// Identity data only; the spec stays behind `invokeFunction`.
export { RUNS_MARK_FUNCTION_ID } from './functions/ops/runs-mark.js'
// Identity only; the history spec stays behind `invokeFunction`.
export { RUNS_MARKS_HISTORY_FUNCTION_ID } from './functions/ops/runs-marks-history.js'
// Identity only; the preview spec stays behind `invokeFunction`.
export { RUNS_MARK_PREVIEW_FUNCTION_ID } from './functions/ops/runs-mark-preview.js'
// The gate-history op identity and its named unbound refusal.
export { KNOWLEDGE_GATES_LIST_FUNCTION_ID, KnowledgeGatesUnboundError } from './functions/ops/knowledge-gates-list.js'
export { RunNotRecordedError } from './functions/ops/runs-start.js'
export { StreamReplayFloorError } from './functions/ops/runs-events.js'
// `validateLiveUrlToken` is bound by reference, so a liveUrl token has exactly one parse.
export {
  LIVE_EMBED_PATH_PREFIX,
  LIVE_URL_TOKEN_VERSION,
  LIVE_URL_TTL_MS,
  decodeBase64Url,
  encodeBase64Url,
  liveUrlOf,
  mintLiveUrlToken,
  validateLiveUrlToken,
} from './functions/live-url.js'
export {
  LiveViewUnavailableError,
  RUNS_LIVE_URL_FUNCTION_ID,
  UnknownRunError,
} from './functions/ops/runs-live-url.js'
// The editor subject's mint id and its named refusal; the spec stays behind `invokeFunction`.
export {
  EDITOR_LIVE_URL_FUNCTION_ID,
  UnknownLiveEditorSessionError,
} from './functions/ops/editor-live-url.js'
// For an address nothing minted; a tombstoned entity's minted address still resolves.
export { EntityNotFoundError } from './functions/ops/entities-get.js'
// `stepIndex` is per member test, so an address naming no test can match two steps and is refused.
export { AmbiguousStepAddressError } from './functions/ops/knowledge-brief-why.js'
// Op ids a surface must name: an id is not a dispatch handle, and the spec stays in `functions/`.
export { RUNS_POST_PROCESSING_FUNCTION_ID } from './functions/ops/runs-post-processing.js'
// `dashboard-server` may not import this package, so the composition hands it the id.
export { RUNS_EVENTS_FUNCTION_ID } from './functions/ops/runs-events.js'
export { RUNS_DETAIL_FUNCTION_ID } from './functions/ops/runs-detail.js'
export { RUNS_EVIDENCE_FUNCTION_ID } from './functions/ops/runs-evidence.js'
// The refusal class travels beside the id so a surface tells no such run from no such blob.
export {
  EvidenceBlobAbsentError,
  RUNS_ARTIFACT_FUNCTION_ID,
} from './functions/ops/runs-artifact.js'
export { ANALYSIS_GET_FUNCTION_ID } from './functions/ops/analysis-get.js'
export { RUNS_DIGEST_FUNCTION_ID } from './functions/ops/runs-digest.js'
export { RUNS_KNOWLEDGE_FUNCTION_ID } from './functions/ops/runs-knowledge.js'
export { RUNS_OVERVIEW_FUNCTION_ID } from './functions/ops/runs-overview.js'
export { RUNS_LIST_FUNCTION_ID } from './functions/ops/runs-list.js'
export { QUARANTINE_ADD_FUNCTION_ID } from './functions/ops/quarantine-add.js'
export { QUARANTINE_LIST_FUNCTION_ID } from './functions/ops/quarantine-list.js'
export { QUARANTINE_RELEASE_FUNCTION_ID } from './functions/ops/quarantine-release.js'
// `agent-qa ask` and the REPL reach the turn engine through `invokeFunction` with this id.
export { AGENT_ASK_FUNCTION_ID } from './functions/ops/agent-ask.js'
// Types only, so a host can implement the port without a way to compose an explain answer.
export { EXPLAIN_FUNCTION_ID } from './functions/ops/explain.js'
export type { CapabilityCatalogPort, ExplainAbstentionRecord } from './explain/index.js'
// Imported by `composeLocalAgent()`, so renaming `runs.start` breaks the gate-run binding.
export { AUTHORING_DRAFT_VERIFY_FUNCTION_ID } from './functions/ops/authoring-verify-draft.js'
export { RUNS_START_FUNCTION_ID } from './functions/ops/runs-start.js'
export { AUTHORING_DRAFT_WRITE_FUNCTION_ID } from './functions/ops/authoring-draft-write.js'
export { AUTHORING_DRAFT_EDIT_FUNCTION_ID } from './functions/ops/authoring-draft-edit.js'
// Published so tests drive the real loop and compare against `authoringFanOutBound`, not a literal.
export { AUTHORING_LOOP_STAGES, authoringFanOutBound, runAuthoringLoop } from './authoring/loop.js'
export type {
  AuthoringLoopDeps,
  AuthoringLoopInput,
  AuthoringLoopOutcome,
  AuthoringLoopResult,
  AuthoringLoopStage,
} from './authoring/loop.js'
export type {
  AuthoringReadPortLike,
  DraftReceiptsReadPortLike,
  DraftShelfPortLike,
  DraftStageOutcome,
} from './authoring/ports.js'
// The config editor's host ports, which `composeLocalAgent()` and the CLI host implement.
export type {
  ConfigFieldSetResult,
  ConfigFieldValue,
  ConfigFileBytes,
  ConfigFileSet,
  ConfigFilesPortLike,
  ConfigPathFacts,
  ConfigScaffoldContentPortLike,
  ConfigStructuredValue,
  ConfigValidatePortLike,
  ConfigValidation,
  ConfigValidationIssue,
} from './config-mutation/ports.js'
export {
  CONFIG_FIELD_SET_FUNCTION_ID,
} from './functions/ops/config-field-set.js'
export { CONFIG_AUTH_SET_FUNCTION_ID } from './functions/ops/config-auth-set.js'
export { CONFIG_HOOK_ADD_FUNCTION_ID } from './functions/ops/config-hook-add.js'
export { CONFIG_TARGET_CREATE_FUNCTION_ID } from './functions/ops/config-target-create.js'
export { CONFIG_TARGET_EDIT_FUNCTION_ID } from './functions/ops/config-target-edit.js'
export { AUTHORING_FUNNEL_GET_FUNCTION_ID } from './functions/ops/authoring-funnel-get.js'
// Pure over injected reads, so the port's shape itself reaches no host API and no run capability.
export {
  gatherSuiteStability,
  projectAuthoringFunnel,
  scopeReceiptsToWindow,
} from './authoring/funnel.js'
export type {
  AuthoringFunnelPortLike,
  SuiteOutcomeHistoryPortLike,
} from './authoring/funnel.js'
export { createTurnEngine } from './chat/turn-engine.js'
// `CHAT_DIRECTIVES` and `CHAT_HELP_ENTRIES` join the two that were already here
// because the help ↔ catalog census lives in `packages/cli` and has to be able to NAME the three
// classes a help line can belong to — a capability alias, a session directive, the passthrough —
// without re-spelling any of them. Both are frozen data and neither dispatches anything.
export {
  CHAT_DIRECTIVES,
  CHAT_HELP_ENTRIES,
  CHAT_HELP_TEXT,
  CHAT_RESOLVER_TABLE,
  resolveClause,
} from './chat/resolver-table.js'
export { deterministicOverrideStrategy, unhandledReason } from './chat/reconcile.js'
// Published so a differential can map tool names back to ids without a second rename table.
export { ANSWER_ONLY_TOOL_NAME, fromToolName, isChatMetaToolName } from './chat/tool-names.js'
// The composition root binds this as the engine's `ClauseSplitter`.
export { splitClauses } from './chat/clause-split.js'
// Every storage adapter calls these, so all reach the same verdict about a half-written log.
export { repairSession, replaySession } from './chat/session-repair.js'
// A plain in-memory container the composition root creates and the REPL renders from.
export { createChatState } from './chat/chat-state.js'
export type {
  ChatLastTurn,
  ChatStateContainer,
  ChatStateSnapshot,
  CreateChatStateInput,
} from './chat/chat-state.js'
// Published for the REPL in `cli`; it composes registered reads through the binding it is handed.
export { composeBanner } from './chat/banner.js'
// Both lane runners live outside this package and must iterate the same admitted list.
export { parseScenario, scenarioRelativePath } from './chat/scenario-loader.js'
// One projection serves the corpus rate and the field rate, so a refusal has one definition.
export { MARK_UNHANDLED_CEILING, ceilingExceeded, computeMarkUnhandledRate } from './chat/ceiling.js'
export type { MarkUnhandledCounts } from './chat/ceiling.js'
export { SCENARIO_CORPUS, SCENARIO_CORPUS_VERSION } from './chat/scenarios/manifest.js'
export type { ScenarioCorpusEntry } from './chat/scenarios/manifest.js'
// Only the composition root, which holds a `TokenAccounting` and a session log, can bind the hook.
export {
  CHAT_MINIMUM_CONTEXT,
  COMPACTION_RATIO,
  createChatCompactionHook,
  maybeCompact,
  replayToModelMessages,
} from './chat/compaction.js'
export type {
  ChatCompactionHookDeps,
  ChatDegradeOptions,
  ChatDegradeOutcome,
  ChatTokenAccounting,
  CompactionPass,
  CompactionPassInput,
} from './chat/compaction.js'
export type { TurnEngine, TurnEngineDeps } from './chat/turn-engine.js'
// Types only: the diff stays internal, so a `model_change` has one place it is born.
export type { ChatConfigState, ChatToolsetFingerprint } from './chat/config-drift.js'
// Bound by the composition root; the tools carry no execute callback and the model arrives built.
export { createPlannerStage } from './chat/planner-stage.js'
export { projectPlannerTools } from './chat/planner-tools.js'
export type { ChatLanguageModel } from './chat/planner-stage.js'
// The repair contract's types, so a caller need not spell the shapes again locally.
export type {
  ChatReplayMessage,
  RepairSessionOptions,
  SessionLogLine,
  SessionRepair,
  SessionReplay,
} from './chat/session-repair.js'
// `ChatResolution` joins the three plan-01 shapes because it is what the published
// `resolveClause` now RETURNS — a two-variant union with no confidence member, and pinning it on
// the barrel is what makes a third variant (or a number) a visible edit rather than an incidental
// one. `ChatDirectiveName` rides along because the entry union names it.
export type {
  ChatDirectiveName,
  ChatHelpEntry,
  ChatResolution,
  ChatResolverEntry,
  ChatResolverRule,
  ChatResolverTable,
} from './chat/resolver-table.js'
// Stage 2's plan vocabulary, the verdict step type and the seats a composition fills; types only.
export type {
  CallerMint,
  ChatBindingStage,
  ChatClause,
  ChatDirectiveHandlers,
  ChatInvokeAnswer,
  ChatInvokeBinding,
  ChatModelDirectiveOutcome,
  ChatTurnStateSink,
  ClauseAction,
  ClauseSplitter,
  CompactionHook,
  PlannerStageFailure,
  PlannerStageOutcome,
  PlannerStagePort,
  PlannerToolCall,
  ReconcileInput,
  ReconcileStrategy,
  ReconcileVerdict,
  ResolvedClause,
} from './chat/ports.js'
export type { ChatTurnPort } from './functions/spec.js'

// It sits ahead of its sibling because the barrel pin compares in the barrel's own order.
export { renderAnalysisClusterBlock } from './analysis/render-cluster-block.js'

// One sentence renderer every surface imports, plus the port types that bind its recurrence seam.
export { renderVerdictSentence } from './analysis/render-sentence.js'
export type {
  RecurrenceAnswer,
  RecurrenceLadder,
  RecurrenceProvider,
  RecurrenceQuery,
} from './analysis/render-sentence.js'

// One clustering function every surface folds through; a cluster mints no identity.
export { clusterVerdicts } from './analysis/cluster.js'
export type { AnalysisCluster, AnalysisClusterMember } from './analysis/cluster.js'

// Contract and constructors only: the store lives in `agent-local` and arrives as a port.
export {
  JobCancellationNotRequestedError,
  QuarantinedJobRequeueError,
  StaleJobStoreEpochError,
} from './ports/index.js'
export type {
  ChainTerminalRecord,
  ClaimNextOptions,
  JobCancelOutcome,
  JobCheckpointRecord,
  JobCheckpointReadOutcome,
  JobClaimOutcome,
  JobCompleteOutcome,
  JobEnqueueOutcome,
  JobFailureDisposition,
  JobInsert,
  JobRequeueOutcome,
  JobStoreDump,
  JobStoreDumpRow,
  JobStoreFence,
  JobStorePort,
} from './ports/index.js'
export {
  createJobKindRegistry,
  DuplicateJobKindError,
  IncompleteJobKindDeclarationError,
  InconsistentJobKindDeclarationError,
  UnknownJobKindError,
} from './jobs/kind-registry.js'
export type {
  FallbackContinuationInput,
  FallbackContinuationProducer,
  JobBackoffPolicy,
  JobHandler,
  JobHandlerContext,
  JobKindDeclaration,
  JobKindRegistry,
  JobPermanentFailureDisposition,
} from './jobs/kind-registry.js'
// The real job kinds. A composition root registers THESE; the declarations are the contract
// the crash matrix iterates.
export { createRealJobKindRegistry, REAL_JOB_KIND_DECLARATIONS } from './jobs/kinds.js'
export type { PostRunJobCapabilities, StandInJobScript } from './jobs/kinds.js'
// Every reader addresses the chain's two rows from a `runId` through this one derivation.
export { chainJobIdsForRun } from './jobs/chain-identity.js'
export type { ChainJobIds } from './jobs/chain-identity.js'
export {
  createAgentJobQueue,
  JobCancelledError,
  MissingIdempotencyKeyError,
  UndeclaredJobCheckpointError,
  UndeclaredJobSuccessorError,
} from './jobs/engine.js'
export type {
  AgentJobQueue,
  CancelJobInput,
  CreateAgentJobQueueOptions,
  JobIdSource,
  RanJobOutcomeBase,
  RecoverAbandonedClaimsInput,
  RecoverAbandonedClaimsOutcome,
  RunNextJobInput,
  RunNextJobOutcome,
} from './jobs/engine.js'
// Published so every handler binds this contract; no accessor here hands out a model.
export { recordLlmAuthorship } from './jobs/record-llm-authorship.js'
export type {
  BoundRecordLlmAuthorship,
  JobAuthorCallback,
  JobCheckpointContext,
  JobModelCapability,
  JobModelOutput,
  JobModelRequest,
  JobRecordedValueOutcome,
} from './jobs/record-llm-authorship.js'

// Only the evaluator is published; the lexicons stay internal so no package can widen them.
export { evaluateAssertionStrength } from './authoring/assertion-strength.js'
