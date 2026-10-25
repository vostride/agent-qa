// Neutral port type re-exports anchor the eval workspace dependency declared by this package.
export { retireStagedAdversarialBatch, AdversarialLifecycleBusyError } from './adversarial-composition.js'
export type { RetireStagedAdversarialBatchInput, AdversarialRetirementResult } from './adversarial-composition.js'
export { runJudgePanelCalibration, runJudgeCalibration, maskJudgeCalibrationText } from './judge-calibration-composition.js'
export { JUDGE_CALIBRATION_SCHEMA_VERSION, JUDGE_CALIBRATION_SUBDIR, judgeCalibrationPath,
  readJudgeCalibration, publishJudgeCalibration, createJudgeCalibrationArtifact, guardJudgeCalibration,
  judgeCalibrationGenerationId } from './judge-calibration-source.js'
export type { JudgeCalibrationArtifact, JudgeCalibrationReadInput, JudgeCalibrationRead, JudgeCalibrationPublication } from './judge-calibration-source.js'
export type { RunJudgePanelCalibrationInput, RunJudgeCalibrationResult } from './judge-calibration-composition.js'
export { loadJudgeCalibrationEvidence } from './judge-calibration-evidence-source.js'
export type { LoadJudgeCalibrationEvidenceInput, JudgeCalibrationEvidenceRead } from './judge-calibration-evidence-source.js'
export { readLabelCalibration, LABEL_CALIBRATION_PATH, LABEL_CALIBRATION_SCHEMA_VERSION } from './calibration-source.js'
export type { LabelCalibrationArtifact, LabelCalibrationRead } from './calibration-source.js'
export { runLabelCalibration } from './calibration-composition.js'
export type { RunLabelCalibrationInput, RunLabelCalibrationResult } from './calibration-composition.js'
export { loadLabelEvidence } from './label-evidence-source.js'
export type { LoadLabelEvidenceInput, LabelEvidenceRead } from './label-evidence-source.js'
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
} from './mark-ledger.js'
export type { ArtifactSource, HandoffSource } from '@vostride/agent-qa-eval'

export { FsHandoffSource } from './handoff-source.js'
export type { FsHandoffSourceConfig } from './handoff-source.js'

export { DirArtifactSource, FsRunArtifactSource, absentArtifactSource } from './artifact-source.js'
export type { DirArtifactSourceConfig, FsRunArtifactSourceConfig } from './artifact-source.js'

export {
  BLOBS_SUBDIR,
  CASSETTE_FILE,
  DEFAULT_EVAL_CASSETTES_SUBDIR,
  FsCassetteStore,
} from './cassette-store.js'
export type { FsCassetteStoreConfig, WrittenCassette } from './cassette-store.js'

export { loadCassetteBundle } from './cassette-loader.js'
export type { CassetteBundleLoad } from './cassette-loader.js'

export {
  listCassetteBundleDirs,
  listReplayRecordDirs,
  loadReplayRecord,
  loadScoreRecord,
} from './replay-read.js'
export type { ReplayRecordLoad, ScoreRecordLoad } from './replay-read.js'

export { computeReplayProfileFingerprintFor, runCassetteReplay, replayJudgeRequest } from './replay-composition.js'
export type { RunCassetteReplayInput } from './replay-composition.js'

export { resolveBaselineCache, listBaselineRunRoots } from './baseline-cache-read.js'
export type { BaselineCacheRow, BaselineCacheResolution } from './baseline-cache-read.js'
export { runReplayGate, removalFlipsOutcome, locateTargetCassettes, serializeReplayGateReceipt, GATE1_AUDIT_SUBDIR } from './replay-gate-composition.js'
export type { RunReplayGateInput, RunReplayGateResult, RemovalFlipsOutcomeInput, RemovalFlipsOutcomeResult } from './replay-gate-composition.js'

export { readCommittedCorpusDigest, FEEDBACK_STAGING_SUBDIR, listStagedFeedback, admitStagedFeedback } from './gate2-composition.js'
export type { CommittedCorpusDigestRead, StagedFeedbackEntry, AdmitStagedFeedbackResult } from './gate2-composition.js'

export { loadCassetteBundles, sweepCassetteReplays } from './replay-sweep.js'
export type {
  LoadedCassetteBundle,
  SweepCassetteReplaysInput,
  SweepCassetteReplaysResult,
} from './replay-sweep.js'

export { assembleScoredBatch, cassetteProductPartition, copyJudgeCalibrationToReport, readReportProfileProof } from './replay-batch-assembly.js'

export { FloorProtocolError, replayCorpusOnce, runNoiseFloorMeasurement } from './aa-floor-composition.js'
export type {
  ReplayCorpusOnceInput,
  ReplayCorpusOnceResult,
  RunNoiseFloorMeasurementInput,
  RunNoiseFloorMeasurementResult,
} from './aa-floor-composition.js'

export { runReleaseGate } from './release-gate-composition.js'
export type { ReleaseGateMode, RunReleaseGateInput, RunReleaseGateResult } from './release-gate-composition.js'

export { bindJudgePort, bindJudgePanel } from './judge-binding.js'
export type { JudgeBindingInput } from './judge-binding.js'

export {
  DEFAULT_EVAL_REPLAYS_SUBDIR,
  FsReplayRecordStore,
  REPLAY_RECORD_FILE,
} from './replay-record-store.js'
export type {
  FsReplayRecordStoreConfig,
  WrittenReplayRecord,
} from './replay-record-store.js'

export { FsScoreStore, SCORE_FILE } from './score-store.js'
export type { FsScoreStoreConfig, ScoreRecord, WrittenScoreRecord } from './score-store.js'

export { DEFAULT_EVAL_REPORTS_SUBDIR, FsReportStore, loadStagedReport } from './report-store.js'
export type { FsReportStoreConfig, StagedReportLoad, WrittenReport } from './report-store.js'

export {
  seedCommittedCorpus,
  writePartitionManifest,
  writeRunExclusion,
} from './seeding-composition.js'
export type {
  SeedCommittedCorpusInput,
  SeedingRefusal,
  SeedingReport,
  WritePartitionManifestInput,
  WritePartitionManifestOutcome,
  WriteRunExclusionInput,
  WriteRunExclusionOutcome,
} from './seeding-composition.js'

export {
  COMMITTED_REPORT_DECISIONS_FILE,
  COMMITTED_REPORT_JSON_FILE,
  COMMITTED_REPORT_MARKDOWN_FILE,
  commitEvalReport,
} from './report-committing.js'
export type {
  CommitEvalReportInput,
  CommitEvalReportOutcome,
} from './report-committing.js'

export { writeBaselinePointer } from './baseline-pointer.js'
export type {
  WriteBaselinePointerInput,
  WriteBaselinePointerOutcome,
} from './baseline-pointer.js'

export { writeNoiseFloorArtefact } from './noise-floor-writer.js'
export type {
  WriteNoiseFloorArtefactInput,
  WriteNoiseFloorArtefactOutcome,
} from './noise-floor-writer.js'

export {
  COMMITTED_CENSUS_JSON_FILE,
  COMMITTED_CENSUS_MARKDOWN_FILE,
  commitCensus,
} from './census-committing.js'
export type { CommitCensusInput, CommitCensusOutcome } from './census-committing.js'

export {
  COMMITTED_BASELINES_SUBDIR,
  COMMITTED_CASSETTES_DIR,
  COMMITTED_CENSUS_SUBDIR,
  COMMITTED_CONTRACTS_DIR,
  COMMITTED_CORPUS_DIR,
  COMMITTED_EXCLUSIONS_DIR,
  COMMITTED_GITIGNORE_TEXT,
  COMMITTED_LABELS_DIR,
  COMMITTED_NOISE_FLOOR_SUBDIR,
  COMMITTED_REPORTS_DIR,
  COMMITTED_ROOT_MARKER_FILE,
  COMMITTED_ROOT_SCHEMA_VERSION,
  FsCommittedRootStore,
  PARTITION_MANIFEST_FILE_PREFIX,
  buildRootMarkerValue,
  committedBlobPath,
  committedCassettePath,
  committedContractPath,
  committedBaselinePointerPath,
  committedCensusPath,
  committedCorpusPath,
  committedExclusionPath,
  committedLabelPath,
  committedLabelRevisionPath,
  committedNoiseFloorPath,
  committedPartitionManifestPath,
  committedReportPath,
} from './committed-root-store.js'
export type {
  CommittedRootStoreConfig,
  CommittedWriteOutcome,
} from './committed-root-store.js'

export { readGatePostureFor } from './gate-posture-composition.js'
export type {
  ReadGatePostureForInput,
  ReadGatePostureForResult,
} from './gate-posture-composition.js'

export {
  listBaselinePointers,
  listCommittedReports,
  listNoiseFloorArtefacts,
  readCommittedCorpus,
  readActiveCommittedCorpus,
  readCommittedDecisionVectors,
  readPartitionManifests,
  readRunExclusions,
  resolveMinimumGateSet,
} from './committed-corpus-source.js'
export type {
  BaselinePointerEntry,
  CommittedCorpusRead,
  CommittedDecisionVectorsLoad,
  CommittedReadRefusal,
  CommittedReportEntry,
  NoiseFloorArtefactEntry,
  PartitionManifestRead,
  ResolveMinimumGateSetOutcome,
  RunExclusionRead,
} from './committed-corpus-source.js'
// 2026-09-11, 422 D-01/D-02/D-03: the adversarial staging + operator-admission composition.
// The MAIN entry publishes it because the CLI's operator verb composes it; nothing here is
// reachable from the proposer's `/reader` door.
export {
  ADVERSARIAL_DEFAULT_MAX_PROBE_CALLS,
  ADVERSARIAL_MANIFEST_FILE,
  ADVERSARIAL_STAGING_SUBDIR,
  adversarialProbeTupleKey,
  computeAdversarialBatchDigest,
  listStagedAdversarial,
  refreshAdversarialSplit,
  resolveAdversarialProbeCallCap,
  stageAdversarialProposal,
} from './adversarial-composition.js'
export type {
  AdversarialBatchManifest,
  AdversarialBatchManifestCase,
  AdversarialProbeCallCap,
  AdversarialProbeRefusal,
  AdversarialProbeSkip,
  AdversarialProbeSkipReason,
  AdversarialRefusal,
  AdversarialSpend,
  AdversarialStagingSkip,
  RefreshAdversarialSplitInput,
  RefreshAdversarialSplitResult,
  StageAdversarialProposalInput,
  StageAdversarialProposalResult,
  StagedAdversarialBatch,
  StagedAdversarialCase,
} from './adversarial-composition.js'
// 2026-09-11, 422 D-04/D-08: the durable refresh record a capped refresh reads to avoid
// re-deciding what it already decided. Published beside the staging composition for the same
// reason — the CLI's operator verb resolves the cap and renders the overflow.
export {
  ADVERSARIAL_PROBE_SCHEMA_VERSION,
  ADVERSARIAL_PROBE_SUBDIR,
  ADVERSARIAL_STATE_SCHEMA_VERSION,
  ADVERSARIAL_STATE_SUBDIR,
  adversarialRefreshRecordDigest,
  adversarialTupleKey,
  completeProbeCall,
  derivedAdversarialCassetteIds,
  probeReservationOf,
  publishAdversarialRefreshRecord,
  readAdversarialRefreshRecords,
  readProbeAttempt,
  readProbeAttempts,
  reserveProbeCall,
  resolveAdversarialSeedCap,
  settledAdversarialTuples,
} from './adversarial-state.js'
export type {
  AdversarialRefreshRecord,
  AdversarialRefreshTuple,
  AdversarialSeedCap,
  AdversarialTupleOutcome,
  ProbeAttemptState,
  ProbeCompletion,
  ProbeCompletionOutcome,
  ProbeReservation,
  ProbeReservationKey,
} from './adversarial-state.js'

export { loadCalibrationEvidence, readCalibrationGoldIdentity } from './calibration-evidence-source.js'
export type { CalibrationEvidenceRead, CalibrationEvidenceMissingReason } from './calibration-evidence-source.js'
