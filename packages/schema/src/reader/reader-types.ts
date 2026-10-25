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
  /** D-14 temporal serving role; distinct from whether this entry was served to a canary. */
  servedAs?: 'current' | 'prior-build-hypothesis'
  /**
   * 379 D-05 read-side staleness annotation; present once the confirmation gap exceeds the
   * volatility-tier threshold so Phase 380 can frame "unconfirmed since build N" as a hypothesis.
   */
  unconfirmedSinceOrdinal?: number
  /** 379 D-20 vetted candidate served at discounted trust through the always-on sub-cap. */
  unverified?: boolean
  /** D-16 active-conflict annotation linking the surviving peer and minted unknown record. */
  conflict?: { peerRecordId: RecordId; unknownRecordId: RecordId }
  /** D-15 audit-read state; absent from ordinary serving-path reads. */
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
  /** D-06 closed capability tier — never a widened string. */
  authoringModelTier: CuratorTier
  parameterSchema: { name: string; type: ProcedureParamType; required: boolean }[]
  replayRecommendation: 'replay' | 'hint'
}
