export { computeBriefDigest } from './compute-brief-digest'
export {
  LosslessServedBriefError,
  LosslessServedBriefSchema,
  SERVED_BRIEF_PROOF_SCHEMA_VERSION,
  guardLosslessServedBrief,
} from './guard-lossless-served-brief'
export type { LosslessServedBrief } from './guard-lossless-served-brief'
export {
  RETRIEVAL_TRACE_LEGS,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  ServedRetrievalTraceV1Schema,
  TRACE_TRUNCATION_TOP_K,
  TraceLineSchema,
} from './retrieval-trace'
export type {
  RetrievalTraceLeg,
  ServedRetrievalTraceV1,
  TraceLine,
} from './retrieval-trace'
// the closed rung vocabulary and its recorded form, beside the trace
// they are persisted next to.
export {
  RETRIEVAL_RUNGS,
  RETRIEVAL_RUNG_REASONS,
  RecordedRetrievalRungSchema,
} from './retrieval-rung'
export type {
  RecordedRetrievalRung,
  RetrievalRung,
  RetrievalRungReason,
} from './retrieval-rung'
// the durable "no knowledge reader was bound" marker, owned here and imported by the
// runner that writes it and by every reader that derives an unbound store from it.
export { NO_KNOWLEDGE_READER_TRUNCATION } from './served-brief'
export type {
  BriefLine,
  CautionLine,
  LosslessServedBriefProofV1,
  ReadTrace,
  ServedAdmissionEvent,
  ServedAdmissionSurface,
  ServedBrief,
  ServedPromptTurn,
} from './served-brief'
