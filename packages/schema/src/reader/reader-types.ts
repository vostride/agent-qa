import type { BriefLine, CautionLine } from '../brief/served-brief'
import type { Anchor } from '../identity/anchor'
import type { ScopeKey } from '../identity/scope-key'
import type { RecordId } from '../ids/record-id'
import type { CuratorTier, ProcedureParamType } from '../knowledge/curator-tier'
import type { ServingRecordMetadata } from './serving-admission'

export interface IndexEntry {
  id: RecordId
  kind: string
  subtype?: string
  title: string
  summary: string
  trust: number
  anchors: Anchor[]
  status: string
  servedAsCanary: boolean
  // Temporal serving role, distinct from whether the entry was served to a canary.
  servedAs?: 'current' | 'prior-build-hypothesis'
  // Present once the confirmation gap exceeds the volatility-tier threshold.
  unconfirmedSinceOrdinal?: number
  // A vetted candidate served at discounted trust through the always-on sub-cap.
  unverified?: boolean
  // Links the surviving peer and the minted unknown record of an active conflict.
  conflict?: { peerRecordId: RecordId; unknownRecordId: RecordId }
  // Audit-read state; absent from ordinary serving-path reads.
  audit?: { status: string; openedAtOrdinal: number; closedAtOrdinal: number | null }
  scope: ScopeKey
  validity: string
}

export interface RecordBody {
  id: RecordId
  title: string
  body: string
  anchors: Anchor[]
  evidenceDigest: string
  measurement?: string
  relations: { kind: string; targetId: RecordId }[]
}

export interface BriefBlock {
  tiers: { L0: string; L1: string; L2: string }
  lines: BriefLine[]
  truncation: string
  /** Exact Channel-1 admission material retained for the shared turn authority. */
  admissions: ServingRecordMetadata[]
}

export interface CautionBlock {
  cautions: CautionLine[]
  budgetUsed: number
  /** Exact Channel-3 material; reserved truncation lines intentionally have no entry. */
  admissions: ServingRecordMetadata[]
}

export interface ProcedureMatch {
  id: RecordId
  flowAnchor: Anchor
  confidence: number
  // A closed capability tier, never a widened string.
  authoringModelTier: CuratorTier
  parameterSchema: { name: string; type: ProcedureParamType; required: boolean }[]
  replayRecommendation: 'replay' | 'hint'
}
