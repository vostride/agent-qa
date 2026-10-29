import type { Anchor } from '../identity/anchor'
import type { ScopeKey } from '../identity/scope-key'
import type { RecordId } from '../ids/record-id'
import type { SERVED_BRIEF_PROOF_SCHEMA_VERSION } from './guard-lossless-served-brief'

// The only durable marker telling no configured store apart from a retrieval that served nothing.
export const NO_KNOWLEDGE_READER_TRUNCATION = 'no brief served (no knowledge reader bound)'

export interface BriefLine {
  id: RecordId
  kind: string
  summary: string
  trust: number
  status: string
  servedAsCanary: boolean
  tier: string
}

export interface ReadTrace {
  id: RecordId
  detailLevel: string
  bodyDigest: string
}

export interface CautionLine {
  id: RecordId
  anchors: Anchor[]
  summary: string
}

export type ServedAdmissionSurface =
  | 'brief-line'
  | 'search-result'
  | 'read-body'
  | 'caution'
  | 'procedure-hint'

/** One chronological exposure evaluated by the production serving authority. */
export interface ServedAdmissionEvent {
  ordinal: number
  turnOrdinal: number
  surface: ServedAdmissionSurface
  id: RecordId
  sourceId: string
  clusterKey: string
  renderedCost: number
  chargeRepeated: boolean
}

/** Exact model-visible prompt material captured when a production turn is assembled. */
export interface ServedPromptTurn {
  ordinal: number
  turnOrdinal: number
  runDate: string
  policyL0: string
  learnedL1: string
  learnedL2: string
  contextTier: string
  volatileTier: string
  policyDigest: string
  contextTierDigest: string
  volatileTierDigest: string
}

export interface LosslessServedBriefProofV1 {
  schemaVersion: typeof SERVED_BRIEF_PROOF_SCHEMA_VERSION
  completeness: 'lossless'
  recordCap: number
  combinedBudget: number
  admissionEvents: ServedAdmissionEvent[]
  promptTurns: ServedPromptTurn[]
}

export interface ServedBrief {
  scope: ScopeKey
  asOfBuild: number
  budget: number
  truncation: string
  channel1: BriefLine[]
  channel2: ReadTrace[]
  channel3: CautionLine[]
  briefDigest: string
  /** Absent on historical values that predate acceptance-grade byte evidence. */
  proof?: LosslessServedBriefProofV1
}
