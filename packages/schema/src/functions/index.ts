// 2026-10-02 (432-39, D-10/D-12): the capability-scope union (`FunctionScopeSchema`,
// `FunctionScope`) is deleted with every field that named it. Nothing gates on a scope.
// 391 D-06: the actor-origin axis. The vocabulary is a VALUE so a composition root can iterate
// it and a test can pin its closure; the caller record's `origin` field is required.
export { FUNCTION_CALLER_ORIGINS } from './function-caller'
export type { FunctionCaller, FunctionCallerOrigin } from './function-caller'
export {
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
  // 405 D-03: the run-detail read op's contracts — the input, the three row schemas, the D-06
  // token sum and the whole projection. They live beside `runs.postprocessing`'s because they
  // answer the same question about the same noun: what is durably true of ONE run.
  RunsDetailInputSchema,
  RunDetailMemberSchema,
  RunStepTokenUsageSchema,
  RunDetailStepSchema,
  RunDetailSubActionSchema,
  RunTokenTotalsSchema,
  RunDetailProjectionSchema,
  // 405-05 D-12/D-13: the ref-resolving read op's two contracts. Beside the run-detail block
  // because they are the two halves of one claim — the projection carries a ref, and this is how
  // that ref becomes bytes.
  RunsArtifactInputSchema,
  RunsArtifactResultSchema,
  RunsEvidenceInputSchema,
  RunsEvidenceResultSchema,
  // 407 D-05: the `runs.knowledge` panel read's contracts — one input and one two-armed
  // projection carrying what a run USED (served channels, trace arms, plan source, rung) and
  // what it LEARNED (curation counts, attributable record changes, canary outcomes). They live
  // beside `runs.detail`'s because they answer the same question about the same noun.
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
} from './runs'
export type {
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
  // 405 D-03: the run-detail shapes. `RunDetailRows` is the PORT's answer (rows only); the
  // projection adds the token sum the op computes, so the two names keep "what a store holds" and
  // "what a caller receives" separately sayable.
  RunsDetailInput,
  RunDetailMember,
  RunStepTokenUsage,
  RunDetailStep,
  RunDetailSubAction,
  RunTokenTotals,
  RunDetailRows,
  RunDetailProjection,
  // 406-03 D-17: the detail-side ref with read-time presence. The runner's own `ArtifactRef` is
  // untouched — a producer has nothing to say about whether the bytes survive to be read.
  RunDetailArtifactRef,
  // 405-05 D-12/D-13/D-15: the artifact read's shapes. `EvidenceBlobLookup` is the PORT's answer
  // and its two absences are kept APART on purpose — see the type's own doc.
  RunsArtifactInput,
  RunsArtifactResult,
  RunsEvidenceInput,
  RunsEvidenceResult,
  // 407 D-05: the panel projection's inferred shapes. `RunKnowledgeStep` is the row a surface
  // renders; `RunKnowledgeProjection` is the whole answer including the `evidence-incomplete`
  // arm, which is a RESULT and not a refusal (D-06).
  RunsKnowledgeInput,
  RunKnowledgeProjection,
  RunKnowledgeStep,
  RunKnowledgeTrace,
  RunKnowledgePlanSource,
  RunKnowledgeCanaryAttribution,
  EvidenceBlobLookup,
  // 406-03 D-17: the same three words asked as a stat, for read-time presence annotation.
  EvidenceBlobPresence,
} from './runs'
// 389 D-11: the analysis.get op's contracts — verdicts + sentences + clusters, one producer.
export {
  AnalysisGetInputSchema,
  AnalysisGetOutputSchema,
  AnalysisCitedArtifactSchema,
  AnalysisVerdictEvidenceSchema,
  AnalysisResolvedVerdictSchema,
  AnalysisSentenceSchema,
  AnalysisClusterViewSchema,
  AnalysisMemoryOnPathEntrySchema,
} from './analysis-get'
export type {
  AnalysisGetInput,
  AnalysisGetOutput,
  AnalysisCitedArtifact,
  AnalysisVerdictEvidence,
  AnalysisResolvedVerdict,
  AnalysisSentence,
  AnalysisClusterMemberRef,
  AnalysisClusterView,
  AnalysisMemoryOnPathEntry,
} from './analysis-get'
export {
  KNOWLEDGE_BUNDLE_SUMMARY_SCHEMA_VERSION,
  KnowledgeBundleSummarySchema,
  KnowledgeBundlesListInputSchema,
  KnowledgeBundlesListOutputSchema,
} from './knowledge'
export type {
  KnowledgeBundleSummary,
  KnowledgeBundlesListInput,
} from './knowledge'
export {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  MaskedConfigEntrySchema,
  MaskedResolvedConfigSchema,
  ConfigGetInputSchema,
} from './config'
export type {
  ConfigValueSource,
  MaskedConfigEntry,
  MaskedResolvedConfig,
  ConfigGetInput,
} from './config'
// 393 D-01: the `authoring.draft.verify` op's contracts (D-01 sketches the verb as
// `verify_draft`; that spelling is unrepresentable — see ./authoring.ts). The output IS the receipt
// (D-19) rather than a summary of it, so the schema is re-exported here under an op-shaped
// name instead of being re-declared.
export {
  AuthoringVerifyDraftInputSchema,
  AuthoringVerifyDraftOutputSchema,
} from './authoring'
export type {
  AuthoringVerifyDraftInput,
  AuthoringVerifyDraftOutput,
} from './authoring'
// 394 D-01: `authoring.draft.write`'s contracts and the closed loop-outcome vocabulary. The
// vocabulary is declared WHOLE here in the tracer so plans 04-06 add a branch behind a
// discriminant every consumer already reads, never a member to the shape.
export {
  AUTHORING_DEDUP_CONTINUATIONS,
  AUTHORING_LOOP_OUTCOMES,
  AUTHORING_REPAIR_ABANDONMENTS,
  AUTHORING_STATED_VALUE_STAGES,
  AUTHORING_STOP_SIGNAL_CLASSES,
  AuthoringDedupRefusalSchema,
  AuthoringDraftWriteInputSchema,
  AuthoringDraftWriteOutputSchema,
  AuthoringStatedValueRefusalSchema,
  AuthoringStopFailurePointSchema,
  AuthoringStopSchema,
} from './authoring'
export type {
  AuthoringDedupContinuation,
  AuthoringDedupRefusal,
  AuthoringDraftWriteInput,
  AuthoringDraftWriteOutput,
  AuthoringLoopOutcomeKind,
  AuthoringRepairAbandonment,
  AuthoringStatedValueRefusal,
  AuthoringStatedValueStage,
  AuthoringStop,
  AuthoringStopFailurePoint,
  AuthoringStopSignalClass,
} from './authoring'
// 394-07 D-12/D-13: `authoring.funnel.get`'s contracts. The output IS the funnel the ONE
// computation produces (see ../authoring/funnel.ts) rather than a re-shaping of it, so the
// schema is re-exported under an op-shaped name instead of being re-declared. The window is a
// SCOPE — which invocations the projection is over — not a filter over rows already in hand.
export {
  AuthoringFunnelGetInputSchema,
  AuthoringFunnelGetOutputSchema,
  AuthoringFunnelWindowSchema,
} from './authoring'
export type {
  AuthoringFunnelGetInput,
  AuthoringFunnelGetOutput,
  AuthoringFunnelWindow,
} from './authoring'
// 394-09 D-21: `authoring.draft.edit`'s contracts. The op proposes and nothing more — plan 10's
// one-commit apply is what turns an accepted proposal into a repository change — so the output
// carries the staged draft, what it was edited FROM, and the RFC-6902 ops that produced it.
export {
  AuthoringDraftEditInputSchema,
  AuthoringDraftEditOutputSchema,
} from './authoring'
export type {
  AuthoringDraftEditInput,
  AuthoringDraftEditOutput,
} from './authoring'
// 396-04 (D-16): `runs.list`'s output contract, named rather than composed inline in the op, so a
// surface can advertise the same object `invokeFunction` validates with.
export { RunsListOutputSchema } from './runs'
export type { RunsListOutput } from './runs'
// 431-03 (D-03/D-07): the canonical output contracts — the runtime schema as validator, with an
// explicit output document derived from the wire terminals the runtime schema transforms.
export {
  createOutputContract,
  deriveWireOutputRepresentation,
  wireOutputContract,
} from './output-contract'
export type { JsonSchemaDocument, OutputContract } from './output-contract'
export {
  RunsArtifactOutputContract,
  RunsEvidenceOutputContract,
  RunsListOutputContract,
} from './runs'
// 431 D-08: the list's bounds and its per-row test identity and recorded-target vocabulary.
export { RUNS_LIST_DEFAULT_LIMIT, RUNS_LIST_MAX_LIMIT } from './runs'
export type { RecordedTargets, RunSummaryTest } from './runs'
// 396-04 (D-01 · MCPS-02): the three declared fold contracts the MCP catalogue advertises. Minted
// here because they are composed with zod and `packages/mcp` may not name a validator library
// (D-20); see the module header for why a JSON-Schema-level composition cannot work at all.
export {
  TOOL_FOLD_DISCRIMINANT,
  AuthoringRefineFoldInputSchema,
  AuthoringRefineFoldOutputSchema,
  ConfigChangeFoldInputSchema,
  ConfigChangeFoldOutputSchema,
  KnowledgeChangeFoldInputSchema,
  KnowledgeChangeFoldOutputSchema,
  RunsEvidenceFoldInputSchema,
  RunsEvidenceFoldOutputContract,
} from './tool-folds'
export type {
  AuthoringRefineFoldInput,
  ConfigChangeFoldInput,
  KnowledgeChangeFoldInput,
  RunsEvidenceFoldInput,
} from './tool-folds'
// 402-01 (D-06/D-13/D-15 · INVK-03): the authed run service's wire vocabulary — the two-arm
// header verdict, the one error body every refusal answers with, the request shape, the readiness
// DTO, and the door's own contract version. The EVENT vocabulary is deliberately absent: the SSE
// stream serves `RunEventEnvelopeSchema` verbatim (D-13).
export {
  RUN_SERVICE_CONTRACT_VERSION,
  RUN_SERVICE_ERROR_CODES,
  RUN_SERVICE_REFUSED_REQUEST_FIELDS,
  RunServiceErrorBodySchema,
  RunServiceReadinessSchema,
  RunServiceReplayFloorBodySchema,
  RunServiceStartRequestSchema,
} from './run-service'
export type {
  RunServiceErrorBody,
  RunServiceErrorCode,
  RunServiceReadiness,
  RunServiceReplayFloorBody,
  RunServiceStartRequest,
} from './run-service'
