// 393: the keep-gate authoring vocabulary — the four separately-reported
// gate booleans, the ONE disposition derivation, and the durable per-draft receipt.

export { computeDraftDisposition, DRAFT_DISPOSITIONS, DRAFT_STABILITY_RUNS_N } from './disposition'
export type {
  DraftDisposition,
  DraftDispositionInput,
  DraftGateBooleans,
} from './disposition'
export {
  AddsValueFindingSchema,
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  DRAFT_GATE_NAMES,
  DraftGateResultsSchema,
  DraftReceiptSchema,
  DraftRefSchema,
  GateRunRecordSchema,
  StepClassificationRowSchema,
} from './draft-receipt'
export type {
  AddsValueFinding,
  DraftGateName,
  DraftGateResults,
  DraftReceipt,
  DraftRef,
  GateRunRecord,
  StepClassificationRow,
} from './draft-receipt'

// the direct write of a final authored test.
export {
  DRAFT_WRITTEN_DISPOSITIONS,
  draftDispositionWritesTarget,
} from './disposition'
export type { DraftWrittenDisposition } from './disposition'
export {
  DraftGateBooleansSchema,
  TEST_FILE_NOT_WRITTEN_REASONS,
  TEST_FILE_WRITE_REFUSALS,
  TestFileWriteSchema,
  WrittenTestReceiptSchema,
  draftGateBooleans,
} from './draft-receipt'
export type { TestFileWrite, WrittenTestReceipt } from './draft-receipt'

// 394: the RFC-6902 edit vocabulary. Deliberately NOT the unified-diff `patch/`
// vocabulary — see the header of `patch-ops.ts` for why the two are not unified.
export {
  EDITABLE_POINTER_ROOTS,
  PATCH_OP_KINDS,
  PatchOpSchema,
  TestEditPatchSetSchema,
  isEditablePointer,
  parseJsonPointer,
  pointerRootOf,
} from './patch-ops'
export type {
  EditablePointerRoot,
  PatchOp,
  PatchOpKind,
  TestEditPatchSet,
} from './patch-ops'

// the ONE evidence-ref vocabulary the router builds and the stop arm
// carries, and where an authored test is written. 2026-10-01: the test-draft
// envelope arm is deleted; an authored test is written in its own call.
export {
  AUTHORED_SUITE_SLUG_MAX_LENGTH,
  authoredSuiteTargetPath,
  RUN_EVIDENCE_CHANNELS,
  RunEvidenceRefSchema,
} from './proposal-arms'
export type {
  RunEvidenceChannel,
  RunEvidenceRef,
} from './proposal-arms'

// the honesty funnel — the frozen four stages, the pinned ceiling
// and floor, the ONE computation, and the mechanical no-success-framing screen.
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
} from './funnel'
export type {
  AuthoringFunnel,
  AuthoringFunnelInput,
  AuthoringFunnelStage,
  FunnelRenderParts,
  FunnelSideCounters,
} from './funnel'

// the ONE fan-out arithmetic. The preview and the written report both
// read it, so the number announced before the runs and the number shown afterwards cannot be two
// answers. 2026-10-01: no confirm reads it and no proposal arm is exported; an
// authored test is written in its own call.
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
} from './fan-out'
export type {
  ConsumedRun,
  FanOutBound,
  FanOutBoundInput,
  FanOutReport,
  FanOutRunPurpose,
} from './fan-out'

// the mixed-verdict suite-stability read — pure, and it starts ZERO runs.
export {
  NEIGHBOUR_INSTABILITY_REASONS,
  SUITE_STABILITY_POSTURES,
  assessSuiteStability,
  suiteTestRef,
} from './suite-stability'
export type {
  FlakyNeighbour,
  NeighbourInstabilityReason,
  SuiteNeighbourRow,
  SuiteStabilityAssessment,
  SuiteStabilityInput,
  SuiteStabilityPosture,
} from './suite-stability'

// procedure-by-reference. The vocabulary a compiled step is authored in,
// derived out of the anchor alone so no learned-shelf record id can reach a committed test.
export { procedureStepVocabulary } from './procedure-reference'
