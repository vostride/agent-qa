export type { ArtifactSource } from './ports'
export { prepareJudgeCalibrationProbe, summarizeJudgeCalibration } from './judge/calibration'
export type { JudgeCalibrationProbe, JudgeCalibrationProbeObservation } from './judge/calibration'
export { selectJudgeCalibrationGold, resolveJudgeCalibrationTruth, judgeCalibrationFullMatch, JUDGE_CALIBRATION_GAP_REASONS, JUDGE_CALIBRATION_STATUSES, JUDGE_CALIBRATION_MIN_N, resolveJudgeCalibrationMinimum } from './judge/calibration'
export type { JudgeCalibrationGapReason, JudgeCalibrationStatus, JudgeCalibrationMinimum, JudgeCalibrationEntryDiagnostic, JudgeCalibrationResult } from './judge/calibration'
export { projectJudgeTargetedCalibration, JUDGE_TARGETED_CALIBRATION_UNAVAILABLE_REASONS } from './judge/calibration'
export type { JudgeTargetedCalibrationDisclosure, JudgeTargetedCalibrationInput, JudgeTargetedCalibrationMember, JudgeTargetedCalibrationUnavailableReason, JudgeTargetedAuthorRow } from './judge/calibration'
export { judgeFamiliesIntersect } from './judge/family'
export type { JudgeCalibrationGold, JudgeCalibrationEvidence, JudgeCalibrationObservation, JudgeCalibrationTruth, JudgeCalibrationSkipReason, JudgeCalibrationDiagnostics } from './judge/calibration'
export { collectSoftPopulation } from './labels/soft-population'
export type { SoftPopulation, SoftObservation, SoftEvidenceSkip, SoftEvidenceSkipReason, CollectSoftPopulationInput } from './labels/soft-population'
export { parseStandaloneLabelRecord, selectEffectiveLabels, deriveLabelRevisionId, createLabelRevision } from './labels/effective-labels'
export type { LabelRecordParse, LabelHistoryRefusalReason, LabelHistoryRefusal, EffectiveLabelSelection } from './labels/effective-labels'
export type { LabelWeight } from './labels/label-record'
export { computeSoftWeight, SOFT_VERDICT_FACTORS, SOFT_TIER_FACTORS } from './labels/soft-weight'
export type { ComputeSoftWeightInput, SoftRecoveringDecisionEvidence } from './labels/soft-weight'

export { canonicalJson, canonicalValue } from './canonical-json'

export { computeReplayDrift } from './replay/drift'
export type { ReplayDrift } from './replay/drift'

export {
  rebuildKnowledgeTiers,
  UnrenderableBriefError,
  BRIEF_SOURCES,
  TURN_MATCHES,
} from './replay/brief-tiers'
export type { BriefSource, TurnMatch, RebuiltKnowledgeTiers } from './replay/brief-tiers'
export { REPLAY_REFUSAL_REASONS } from './replay/result'

export {
  computeDecisionIdentity,
  decisionIdentityKey,
  normalizeIdentityValue,
} from './replay/identity'
export type { DecisionIdentity } from './replay/identity'

export {
  ActionToolCollisionError,
  UnservableDivergenceError,
  buildRecordedExchangeServer,
} from './replay/exchange-server'
export type {
  BuildRecordedExchangeServerInput,
  RecordedExchangeServer,
} from './replay/exchange-server'
export { createNullAdapter, ReplayExecutionForbiddenError } from './replay/null-adapter'

export {
  MissingDecisionBlobError,
  UnsupportedBriefError,
  reconstructDecisionContext,
} from './replay/reconstruct'
export type {
  ReconstructDecisionContextInput,
  ReconstructedDecisionContext,
} from './replay/reconstruct'

export { replayCassette } from './replay/replay-run'
export type { ReplayCassetteInput } from './replay/replay-run'

export { neverEscalate } from './replay/ports'
export type {
  ReplayClock,
  ReplayEscalationContext,
  ReplayEscalationPredicate,
  ReplayPlannerFactory,
  ReplayPlannerHandle,
} from './replay/ports'
export type {
  DecisionReplayResult,
  LeafReplayResult,
  ProcedureReplayResult,
  ProcedureStepReplay,
  ReplayAgreement,
  ReplayCassetteOutcome,
  ReplayRefusal,
  ReplayResult,
  ReplaySample,
  ReplaySampleOutcome,
  UnconsumedExchange,
} from './replay/result'

export {
  collectProcedurePriorIdentities,
  computeLoopVerdict,
} from './match/loop'
export type {
  LoopHistory,
  LoopVerdict,
  ProcedurePriorIdentity,
} from './match/loop'
export { runMatchTiers } from './match/tiers'
export type {
  ElementIdentityVerdict,
  MatchTierCandidate,
  OpClassVerdict,
  TierMatchResult,
} from './match/tiers'
export {
  isDecisionFullMatch,
  representativeDecisionSample,
  scoreCassetteReplay,
  scoreDecision,
} from './match/score'
export { effectiveGold } from './labels/effective-gold'
export { createScoringContext, resolveScoringContext, scoringContextSchema, isUnjudgedPanelRefusal } from './match/scoring-context'
export { judgeIdentitySchema, judgeUsageSchema, judgeMemberOutcomeSchema, hasValidScoreJudgeMetadata } from './match/scoring-context'
export type { ScoringContext, ScoringJudgeRequest } from './match/scoring-context'
export type { EffectiveGold } from './labels/effective-gold'
export type {
  CassetteScore,
  DecisionAxes,
  DecisionPartialBreakdown,
  DecisionScore,
  DecisionScoreEntry,
  JudgeAbstentionCause,
  JudgeConfidence,
  JudgeErrorReason,
  JudgeIdentityBlock,
  JudgeNotInvokedReason,
  JudgeOutcome,
  JudgeSettled,
  JudgeTokenUsage,
  NeverScoredDecision,
  ProcedureScoreSummary,
  ScoreDecisionContext,
  ScoreDecisionOutcome,
  TieCause,
  ValueAxisVerdict,
} from './match/score'
export { buildDecisionDiff } from './match/diff'
export type {
  BuildDecisionDiffInput,
  DecisionDiff,
  DecisionDiffReplayContext,
} from './match/diff'
export { tiersSettlePredicate } from './match/predicate'
export { buildEvalReport, computeBatchKey } from './match/metrics'
export type { EvalBatchReport, ScoredBatchEntry } from './match/metrics'

export type {
  JudgeCallRequest,
  JudgeCallResult,
  JudgeOrder,
  JudgePort,
  JudgeVerdictCategory,
} from './judge/port'
export { JUDGE_CONFIG } from './judge/config'
export type { JudgeConfig } from './judge/config'
export { JUDGE_FAMILY_MAP, JUDGE_LINEAGE_OVERRIDES, resolveJudgeFamily, resolveJudgeFamilies } from './judge/family'
export { assessPanelEligibility, createPanelIdentity, poolPanel, PANEL_POOLING_MODES } from './judge/panel'
export { JUDGE_ABSTENTION_CAUSES } from './match/score'
export type { JudgePanelPort, PanelMemberOutcome, PanelPoolingMode } from './judge/panel'
export type { JudgePairwiseOutcome, JudgeMemberIdentity, JudgeMemberOutcome, JudgeFamilyDisclosure } from './match/score'
export type { JudgeFamily } from './judge/family'
export { buildJudgePrompt } from './judge/prompt'
export type {
  JudgeElementEvidence,
  JudgePromptPayload,
  JudgeQuestion,
  JudgeTieEvidence,
} from './judge/prompt'
export { adjudicateCassetteScore, adjudicatePanelComparison, assessJudgeEligibility, judgePairwise } from './judge/adjudicate'
export type { UsageAggregator } from './judge/adjudicate'
export type { AdjudicationResult, JudgeEligibility } from './judge/adjudicate'

export type { CassetteInputLeg } from './cassette/input-leg'
export type { CassetteSidecarLeg, GoldAnchorDescriptor } from './cassette/sidecar-leg'
export type {
  CassetteLabelLeg,
  ContrastivePairing,
  LabelSourceChannel,
  LabelTier,
  RecordedFailureContext,
} from './cassette/label-leg'
export type {
  CassetteJudgeReceipt,
  CassetteModelReceipt,
  CassetteReceipt,
  CassetteSamplingReceipt,
} from './cassette/receipt-leg'
export type {
  CassetteCompleteness,
  CompletenessStatus,
  MissingCassetteEvidence,
  MissingCassetteEvidenceKind,
} from './cassette/completeness'
export { CASSETTE_SCHEMA_VERSION } from './cassette/cassette'
export type {
  Cassette,
  CassetteGranularity,
  DecisionRecord,
  LeafCassette,
  ProcedureCacheServedStepRecord,
  ProcedureCassette,
  ProcedureDecisionStepRecord,
  ProcedureEndState,
  ProcedureStepRecord,
  ProcedureSynthesizedStepRecord,
} from './cassette/cassette'
export { cassetteSchema } from './cassette/schema'
export { ACTION_WIRE_SCHEMAS_BY_TYPE, actionWireSchema } from './cassette/action-wire-schema'
export {
  CASSETTE_MIGRATIONS,
  CassetteVersionError,
  guardCassette,
} from './cassette/guard'

export { classifySubAction, collectStepSelections } from './extract/select'
export type {
  CollectStepSelectionsInput,
  SelectionSkip,
  SelectionSkipReason,
  StepSelections,
  SubActionClassification,
  SubActionSelection,
} from './extract/select'
export { projectInputLeg } from './extract/input-leg'
export type { ProjectInputLegInput } from './extract/input-leg'
export { projectLabelLeg } from './extract/label-leg'
export type { ProjectLabelLegInput } from './extract/label-leg'
export { projectSidecarLeg } from './extract/sidecar-leg'
export type {
  ProjectSidecarLegInput,
  ProjectSidecarLegResult,
} from './extract/sidecar-leg'
export { assembleReceipt, canonicalizeInputLeg } from './extract/receipt'
export type { AssembleReceiptInput } from './extract/receipt'
export {
  deriveLeafCassetteId,
  deriveGoldCassetteId,
  deriveProcedureCassetteId,
  deriveRunSlug,
} from './extract/ids'
export type {
  DeriveLeafCassetteIdInput,
  DeriveProcedureCassetteIdInput,
} from './extract/ids'
export {
  buildCompleteness,
  collectBlobShas,
  missingRequiredEvidence,
  resolveBlobClosure,
} from './extract/blob-closure'
export type {
  BuildCompletenessInput,
  ExtractedBlob,
  ResolvedBlobClosure,
} from './extract/blob-closure'
export { buildProcedureCassette } from './extract/procedure'
export type {
  BuildProcedureCassetteInput,
  BuiltProcedureCassette,
  ProcedureDecisionInput,
} from './extract/procedure'
export { extractRunCassettes } from './extract/extract-run'
export { maskCorpusText } from './extract/corpus-text-mask'
export type { MaskCorpusTextOptions } from './extract/corpus-text-mask'
export type {
  EmittedCassetteSummary,
  ExtractedCassette,
  ExtractionReport,
  ExtractionResult,
  ExtractRunCassettesInput,
} from './extract/extract-run'

export { collectSelfHealPairs } from './labels/pair-matching'
export type {
  CollectSelfHealPairsInput,
  MintedContrastivePair,
  PairSkip,
  PairSkipReason,
} from './labels/pair-matching'
export { DEFAULT_SILVER_PER_TEST_CAP, selectSilverCassettes } from './labels/silver-sampling'
export type {
  SilverExclusion,
  SilverExclusionReason,
  SilverSamplingInput,
  SilverSelection,
} from './labels/silver-sampling'
export {
  LABEL_RECORD_SCHEMA_VERSION,
  deriveAdversarialLabel,
  projectPairLabelRecords,
  projectSilverLabelRecord,
  projectUserMarkLabelRecord,
  projectOverturnedVerdictLabelRecord,
} from './labels/label-record'
export type {
  DeriveAdversarialLabelInput,
  LabelDerivation,
  LabelProvenance,
  LabelCorrection,
  ProjectUserMarkLabelRecordInput,
  ProjectOverturnedVerdictLabelRecordInput,
  PairStateStamp,
  StandaloneLabelRecord,
} from './labels/label-record'

export {
  ADVERSARIAL_MUTATORS,
  CORPUS_ENTRY_SCHEMA_VERSION,
  CORPUS_SPLITS,
  GENERATOR_KINDS,
  GENERATOR_PROVENANCES,
  generatorProvenance,
  HELD_OUT_VISIBILITIES,
  isProbeGeneratorKind,
  isProposerVisibleEntry,
  PROBE_GENERATOR_KINDS,
  projectCorpusEntry,
  resolveProductPartition,
} from './labels/corpus-entry'
export type {
  AdversarialCorpusEntry,
  AdversarialMutator,
  AuthoringModel,
  CorpusEntry,
  CorpusEntryBase,
  CorpusGenerator,
  CorpusRunLinks,
  CorpusSplit,
  GeneratorKind,
  GeneratorProvenance,
  HeldOutVisibility,
  NaturalCorpusEntry,
  PrivateHeldOutCorpusEntry,
  ProbeGeneratorKind,
  ProjectCorpusEntryInput,
  ProposerVisibleCorpusEntry,
  SharedHeldOutCorpusEntry,
  SplitAssignment,
  TargetEnvironment,
} from './labels/corpus-entry'
export { assignSplit, BUCKET_BITS, bucketOf, PARTITION_VERSION } from './labels/split-assignment'
export type { AssignSplitInput, PartitionParams } from './labels/split-assignment'

export { Z_95, wilsonInterval } from './stats/wilson'

export {
  guardPartitionManifest,
  PARTITION_MANIFEST_SCHEMA_VERSION,
  partitionManifestSchema,
  partitionParamsOf,
  projectPartitionManifest,
} from './labels/partition-manifest'
export type {
  PartitionManifest,
  ProjectPartitionManifestInput,
} from './labels/partition-manifest'
export {
  EXCLUSION_CLASSES,
  guardRunExclusionRecord,
  projectRunExclusion,
  RUN_EXCLUSION_SCHEMA_VERSION,
  runExclusionCore,
  runExclusionRecordSchema,
  VERDICT_PRODUCERS,
} from './labels/run-exclusion'
export type {
  ExclusionClass,
  ProjectRunExclusionInput,
  RunExclusionBackfill,
  RunExclusionRecord,
  VerdictProducer,
} from './labels/run-exclusion'
export { buildSeedingPlan, admitSeedMember } from './labels/seeding-plan'
export { activeMarkedCorpusEntries, buildGoldenTrajectoryPlan, markGoldChannels, markedDecisionCount, resolveMarkLabelTargets, resolveMarkedDecisions } from './labels/golden-plan'
export type { GoldenTrajectoryPlan, GoldenTrajectoryTarget, BuildGoldenTrajectoryPlanInput, GoldMark, MarkGoldChannel, MarkGoldClaim, MarkLabelIntent, MarkLabelTargetResolution } from './labels/golden-plan'
export type {
  BuildSeedingPlanInput,
  SeedingParams,
  SeedingPlan,
  SeedingPlanCase,
} from './labels/seeding-plan'

export {
  BASELINE_POINTER_SCHEMA_VERSION,
  composeBaselineProfileKey,
  computeReplayProfileFingerprint,
  guardBaselinePointer,
  projectBaselinePointer,
  SEED_POLICIES,
} from './baseline/profile-key'
export type {
  BaselinePointer,
  BaselinePointerLoad,
  BaselineProfileKeyInput,
  ReplayProfileFingerprintInput,
  SeedPolicy,
} from './baseline/profile-key'

export {
  countGateSet,
  emptyGateSetCounts,
  EXCLUSION_REASONS,
  selectGateSet,
} from './gate/gate-set'
export type {
  CandidateProvenance,
  ExclusionReason,
  GateSetCountPair,
  GateSetCounts,
  GateSetExclusion,
  GateSetVerdict,
  SelectGateSetInput,
} from './gate/gate-set'

export { computeCorpusDigest } from './census/corpus-digest'
export {
  CENSUS_SCHEMA_VERSION,
  classifyStaticScorability,
  deriveCensus,
  projectAdversarialGenerationMix,
} from './census/derive-census'
export type {
  AdversarialGenerationMix,
  CensusCampaignInput,
  CensusCampaignSummary,
  CensusCrossCheckLine,
  CensusProductBlock,
  CensusRung,
  CommittedCorpusSnapshot,
  CorpusCensus,
  DeriveCensusInput,
  ExclusionCensusBlock,
  PartitionCensusBlock,
  StaticScorability,
} from './census/derive-census'

export { renderCensusMarkdown } from './census/render-census'
