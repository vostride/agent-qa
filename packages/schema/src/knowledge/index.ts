export {
  BundleOutcomeEventSchema,
  dedupeEvents,
  eventDedupKey,
  survivingOutcomeEvents,
} from './outcome-event'
export type { BundleOutcomeEvent, OriginClass } from './outcome-event'
export {
  EVIDENCE_INCOMPLETE_ALPHA_DISCOUNT,
  ORIGIN_PRIORS,
  SERVING_ATTRIBUTION_WEIGHT,
  foldBundleTrust,
} from './trust-fold'
export type { BundleStatus, DerivedTrustState } from './trust-fold'
export { cautionRootCauseClassSchema } from './distilled-observation'
export type { CautionRootCauseClass } from './distilled-observation'
export { PROMOTION_GATE_HOLD_REASONS, evaluatePromotionGate } from './promotion-gate'
export type {
  PromotionGateHoldReason,
  PromotionGateInput,
  PromotionGateObservation,
  PromotionGateVerdict,
} from './promotion-gate'
export {
  COLD_START_MAX_BUDGET_FRACTION,
  COLD_START_MAX_RECORDS,
  COLD_START_TRUST_DISCOUNT,
  applyColdStartSubCap,
  isVettedCandidate,
} from './cold-start'
export type {
  ColdStartBudgetEntry,
  VettedCandidateInput,
} from './cold-start'
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
  bimodalSplit,
  cusumStep,
  decideMeasurementDrift,
  foldMeasurements,
  measurementBaselineSchema,
  measurementObservationSchema,
  shrunkSigma,
} from './measurement-fold'
export type {
  BimodalSplit,
  CusumState,
  CusumStepResult,
  DecideMeasurementDriftInput,
  DerivedMeasurementState,
  MeasurementBand,
  MeasurementBaseline,
  MeasurementDriftDecision,
  MeasurementDriftWindowBuilds,
  MeasurementFoldState,
  MeasurementObservation,
} from './measurement-fold'
export {
  ArtifactsIndexSchema,
  BUNDLE_SCHEMA_VERSION,
  BundleManifestSchema,
  BundleProvenanceSchema,
  BundleRelationsSchema,
  computeMutableStateHash,
  guardArtifactsIndex,
  guardBundleManifest,
  guardBundleProvenance,
  guardBundleRelations,
} from './bundle-files'
export type {
  ArtifactsIndex,
  BundleManifest,
  BundleProvenance,
  BundleRelation,
  BundleRelations,
  MutableStateHashInput,
} from './bundle-files'
export { verifyManifestIdentity } from './manifest-identity'
export { emitRecordMarkdown, parseRecordMarkdown } from './record-frontmatter'
export type { RecordFrontmatter } from './record-frontmatter'
export { PROCEDURE_BODY_SCHEMA_VERSION } from './procedure-steps'
export { renderEmbeddingInput, screenStateSnapshotRelPath } from './embedding-input'
export { deriveEvidenceToken } from './evidence-token'
export {
  INSPECT_RECORD_VIEW_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
  InspectFilterSchema,
  InspectRecordViewSchema,
  RecordChangeSchema,
  guardInspectRecordView,
  guardRecordChange,
} from './maintenance-views'
export type {
  InspectFilter,
  InspectRecordView,
  RecordChange,
} from './maintenance-views'
// 2026-10-01, 432-17 (D-05): the direct knowledge change contracts — the review vocabulary, the
// change identity, the target refs, the forget and commit receipts, the change inputs and the change
// output. The proposal payload and its apply contracts are deleted with the inbox.
export {
  DeltaSchema,
  FORGET_RECEIPT_SCHEMA_VERSION,
  ForgetReceiptV1Schema,
  ForgetTargetRefSchema,
  KNOWLEDGE_CHANGE_REFUSAL_REASONS,
  KNOWLEDGE_CHANGE_VERBS,
  KNOWLEDGE_PROJECTIONS,
  KNOWLEDGE_REVIEW_VERBS,
  KnowledgeAcceptChangeInputSchema,
  KnowledgeAcceptInputSchema,
  KnowledgeChangeIdSchema,
  KnowledgeChangeOperationIdSchema,
  KnowledgeChangeOutputSchema,
  KnowledgeForgetChangeInputSchema,
  KnowledgeForgetInputSchema,
  KnowledgeRejectChangeInputSchema,
  KnowledgeRejectInputSchema,
  KnowledgeTargetRefSchema,
  MarkChangeStampSchema,
  TombstonedRecordSchema,
} from './change'
export type {
  ForgetReceiptV1,
  ForgetTargetRef,
  KnowledgeAcceptChangeInput,
  KnowledgeAcceptInput,
  KnowledgeChangeOutput,
  KnowledgeChangeRefusalReason,
  KnowledgeChangeVerb,
  KnowledgeForgetChangeInput,
  KnowledgeForgetInput,
  KnowledgeProjection,
  KnowledgeRejectChangeInput,
  KnowledgeRejectInput,
  KnowledgeReviewVerb,
  KnowledgeTargetRef,
  MarkChangeStamp,
  TombstonedRecord,
} from './change'
// 387 KREV-01/KREV-02 D-15: the review-verb read contracts.
export {
  BRIEF_WHY_NO_TRACE_REASONS,
  BRIEF_WHY_RESULT_KINDS,
  BriefWhyInputSchema,
  BriefWhyResultSchema,
  KnowledgeRecordShowInputSchema,
  KnowledgeRecordShowOutputSchema,
  KnowledgeRecordShowResultSchema,
  KnowledgeRecordsDiffInputSchema,
  KnowledgeRecordsDiffOutputSchema,
  KnowledgeRecordsInspectInputSchema,
  KnowledgeRecordsInspectOutputSchema,
} from './review-verbs'
export type {
  BriefWhyInput,
  BriefWhyNoTraceReason,
  BriefWhyResult,
  BriefWhyResultKind,
  KnowledgeRecordShowInput,
  KnowledgeRecordShowOutput,
  KnowledgeRecordShowResult,
  KnowledgeRecordsDiffInput,
  KnowledgeRecordsDiffOutput,
  KnowledgeRecordsInspectInput,
  KnowledgeRecordsInspectOutput,
} from './review-verbs'
// 416 receipt vocabulary and the promotion result seam.
export { GATE_RECEIPT_SCHEMA_VERSION, GATE_NUMBERS, GATE_VERDICTS, GateReceiptSchema,
  PromotionReceiptSchema, GateLineSchema, receiptDigestOf, stampReceiptDigest,
  isPromotionReceipt, standingReceiptsByGate, strongestPromotionPath } from './gate-receipt'
export type { GateNumber, GateVerdict, GateReceipt, PromotionReceipt, GateLine } from './gate-receipt'
export { PROMOTION_PATHS, PROMOTION_PATH_STRENGTH, strongerPromotionPath } from './promotion-path'
export type { PromotionPath } from './promotion-path'
export type { PromotionOutcome, GateReceiptRecordOutcome, PromotionCandidateProvenance } from './promotion-gate'

export { PER_AXIS_SCORE_AXES, CROSS_CHECKS, DEGRADATIONS, BENEFITS, MARKS, STATE_VALIDITIES,
  axisScoreSchema, perAxisScoreSchema, corpusVersionSchema, samplesSchema, noiseFloorRefSchema,
  gate1ArmSchema, gate3ArmSchema } from './gate-receipt'
export type { PerAxisScoreAxis, CrossCheck, Degradation, Benefit, Mark, StateValidity,
  Gate1Receipt, Gate3Receipt } from './gate-receipt'
// 2026-09-07, 417: neutral replay receipt and candidate DATA contracts.
export { GATE1_REASONS, GATE1_TARGET_SOURCES, GATE1_K_SOURCES, GATE1_HARM_ORIGINS,
  gate1CapSchema, gate1SpendSchema, gate1TargetSchema, gate1HarmedSchema } from './gate-receipt'
export type { Gate1Reason, Gate1TargetSource, Gate1KSource, Gate1HarmOrigin } from './gate-receipt'
export { CandidateInjectionSchema, KnowledgeCandidateInjectionResultSchema } from './candidate-injection'
export type { CandidateInjection, KnowledgeCandidateInjectionResult } from './candidate-injection'
export { RecordAnchorsSchema, RecordScopeSchema } from './record-frontmatter'
export { BundleKindSchema, BundleStatusSchema } from '../functions/knowledge'
export { BriefLineSchema } from '../brief/guard-lossless-served-brief'
