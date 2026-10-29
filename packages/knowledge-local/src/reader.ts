export {
  KnowledgeRecordNotFoundError,
  hydrateRows,
  openKnowledgeReader,
  readIndexRows,
} from './serving/reader.js'
export type {
  HydratedEntry,
  IndexRow,
  OpenServingKnowledgeReaderConfig,
} from './serving/reader.js'
export {
  AUTHORING_BRIEF_DEFAULT_BUDGET,
  AUTHORING_DENSE_K,
  createAuthoringReader,
} from './serving/authoring-reader.js'
export type { AuthoringReaderDependencies } from './serving/authoring-reader.js'
export { inspectRecords } from './inspect.js'
export type { InspectRecordsOptions } from './inspect.js'
export { diffSince } from './diff-since.js'
export type { DiffSinceOptions } from './diff-since.js'
export { listBundles } from './list-bundles.js'
// On the reader entry because it opens nothing, writes nothing and holds no lease.
export { showRecord } from './show-record.js'
export type { ShowRecordOptions } from './show-record.js'
export { showRecords } from './show-records.js'
export type { ShowRecordsOptions } from './show-records.js'
// The append half stays on the main entry, because it performs a committed write.
export {
  QUARANTINE_LEDGER_FILENAME,
  foldQuarantineLedgerState,
  quarantineLedgerPath,
  readQuarantineLedger,
} from './quarantine/ledger.js'
export type { QuarantineLedgerRead, RefusedQuarantineLine } from './quarantine/ledger.js'
// Published so the withheld-line render and the gate read one vocabulary and cannot drift.
export {
  QUARANTINE_CLASS_DISPOSITIONS,
  QUARANTINE_FLOOR_ELIGIBILITY,
} from './quarantine/detection.js'
export type {
  QuarantineDisposition,
  QuarantineFloorEligibility,
} from './quarantine/detection.js'
// The append half stays behind the writer lease; a read that could mint its outcome could tamper.
export { canaryAttributionsFor } from './serving/canary-attribution.js'
export type {
  CanaryAttributionOutcome,
  CanaryAttributionRow,
  CanaryAttributionTuple,
  CanaryAttributionsForOptions,
  CanaryAttributionsResult,
} from './serving/canary-attribution.js'
// One implementation: the reader recomputes this id, and a harness planting an outcome must too.
export { canaryOutcomeObservationId } from './serving/canary-observation-id.js'
export { KnowledgeMaintenanceScanError } from './maintenance-scan.js'
export type { KnowledgeMaintenanceScanIssue } from './maintenance-scan.js'
export type { BuildRange, ReadOptions, SearchOptions } from '@vostride/agent-qa-schema'
// Walks committed bundle files, opening no write authority or derived index.
export { gateReceiptsFor } from './gates/gate-receipt-read.js'
export type { GateReceiptsForOptions } from './gates/gate-receipt-read.js'
// The planning half takes no lease and mints no `markId`; `appendMarkEvidence` executes the plan.
export { MARK_EVIDENCE_TOKEN_PREFIX, markEvidenceEvent, planMarkEvidence, projectMarkEvidenceOutcome }
  from './feedback/mark-evidence-plan.js'
export type { MarkEvidenceEffect, MarkEvidencePlan, MarkEvidenceTarget, PlanMarkEvidenceInput }
  from './feedback/mark-evidence-plan.js'
