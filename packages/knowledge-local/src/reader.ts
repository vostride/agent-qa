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
// the show verb's read half. On the READER entry beside its three siblings
// because it opens nothing, writes nothing and holds no lease — it reads committed bundle
// files and projects them, which is the whole of what the read half of the review family is.
export { showRecord } from './show-record.js'
export type { ShowRecordOptions } from './show-record.js'
export { showRecords } from './show-records.js'
export type { ShowRecordsOptions } from './show-records.js'
// the committed quarantine ledger's READ half. On the reader entry beside its
// siblings because it opens nothing, writes nothing and holds no lease — it reads one committed
// text file and folds it purely. The append half stays on the main entry: it performs a committed
// write through the egress checkpoint, which is exactly the power this entry withholds.
export {
  QUARANTINE_LEDGER_FILENAME,
  foldQuarantineLedgerState,
  quarantineLedgerPath,
  readQuarantineLedger,
} from './quarantine/ledger.js'
export type { QuarantineLedgerRead, RefusedQuarantineLine } from './quarantine/ledger.js'
// the gate's TWO TOTAL TABLES, on this entry for the same reason the ledger's read half is
// here — they open nothing, write nothing and hold no lease. They are frozen constant maps from a
// closed verdict vocabulary to a decision, and reading them decides nothing on its own:
// `autoQuarantines` (main entry) is what turns them into an admission, and it stays there.
//
// The consumer is the curation tail's withheld-line render, which must branch its remedy on
// ADMISSIBILITY — an escalate-only class is told no run admits it, an authored-required class is
// told it needs an analyst, and only the floor-eligible classes are told the next applied run may
// admit them. That render and the gate must read ONE vocabulary or the line's promise and the
// refusal drift apart per class, which is how the shipped line came to promise relief no fold
// grants. Publishing the tables — rather than restating them at the render — is what makes the
// drift impossible rather than merely unlikely.
export {
  QUARANTINE_CLASS_DISPOSITIONS,
  QUARANTINE_FLOOR_ELIGIBILITY,
} from './quarantine/detection.js'
export type {
  QuarantineDisposition,
  QuarantineFloorEligibility,
} from './quarantine/detection.js'
// the attribution read — what became of the canary lines a run served. On the READER
// entry because it opens nothing, writes nothing and holds no lease: it walks committed bundle
// files, recomputes each served tuple's observation id and reports the surviving outcome carrying
// it. The append half of a canary outcome stays behind the writer lease on the main entry, which
// is exactly the power this entry withholds — a read that could mint the outcome it reports would
// be the tampering hazard rather than its mitigation.
export { canaryAttributionsFor } from './serving/canary-attribution.js'
export type {
  CanaryAttributionOutcome,
  CanaryAttributionRow,
  CanaryAttributionTuple,
  CanaryAttributionsForOptions,
  CanaryAttributionsResult,
} from './serving/canary-attribution.js'
// the JOIN KEY ITSELF, published beside the read that recomputes it.
//
// It belongs on this entry for the same reason `canaryAttributionsFor` does, and for one more.
// The reason it shares: it is a pure derivation over five fields of a served tuple — it opens
// nothing, writes nothing and holds no lease, so publishing it grants none of the power this
// entry withholds. The reason that is its own: the READ side recomputes this id
// rather than reading a stored copy, which is what makes the attribution join evidence instead
// of a claim — and a harness that must PLANT the outcome event the reader will find has to
// recompute it the same way. Reaching for a second spelling there would produce a plant the
// reader never finds, and a green agreement over an empty set. There is exactly one
// implementation; `curator/disposition.ts` re-exports it for the writer side.
export { canaryOutcomeObservationId } from './serving/canary-observation-id.js'
export { KnowledgeMaintenanceScanError } from './maintenance-scan.js'
export type { KnowledgeMaintenanceScanIssue } from './maintenance-scan.js'
export type { BuildRange, ReadOptions, SearchOptions } from '@vostride/agent-qa-schema'
// gate history and the live verdict. This read walks committed
// bundle files and folds their evidence, opening no write authority or derived index.
export { gateReceiptsFor } from './gates/gate-receipt-read.js'
export type { GateReceiptsForOptions } from './gates/gate-receipt-read.js'
// the mark evidence PLANNING half. It resolves and folds committed bundles,
// takes no lease and mints no markId; appendMarkEvidence executes the same plan on the main entry.
export { MARK_EVIDENCE_TOKEN_PREFIX, markEvidenceEvent, planMarkEvidence, projectMarkEvidenceOutcome }
  from './feedback/mark-evidence-plan.js'
export type { MarkEvidenceEffect, MarkEvidencePlan, MarkEvidenceTarget, PlanMarkEvidenceInput }
  from './feedback/mark-evidence-plan.js'
