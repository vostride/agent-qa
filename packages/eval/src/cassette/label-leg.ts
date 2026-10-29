import type { VerifierVerdict, Verdict } from '@vostride/agent-qa-schema'

/** Quality vocabulary reserved for every current and later label source. */
export type LabelTier = 'gold' | 'near-gold' | 'silver'

/** reserved tiers, pinned independently by runtime and type oracles. */
export const LABEL_TIERS = ['gold', 'near-gold', 'silver'] as const satisfies readonly LabelTier[]

/** Channel that supplied the cassette label. */
export type LabelSourceChannel =
  | 'recorded-verdict'
  | 'user-mark'
  | 'overturned-verdict'
  | 'self-heal-pair'

/** existing channels only; sovereign gold producers retain their identities. */
export const LABEL_SOURCE_CHANNELS = [
  'recorded-verdict',
  'user-mark',
  'overturned-verdict',
  'self-heal-pair',
] as const satisfies readonly LabelSourceChannel[]

/** Optional relationship to the sibling in a contrastive example. */
export interface ContrastivePairing {
  /** Deterministic cassette identity of the paired example. */
  pairedCassetteId: string
  /** Whether this member is the successful or unsuccessful side of the pair. */
  relation: 'contrastive-positive' | 'contrastive-negative'
}

/** Recorded failure-only context available without synthesizing new facts. */
export interface RecordedFailureContext {
  /** Verifier-authored reasoning copied from recorded evidence when present. */
  verifierReasoning?: string
  /** Structured planning failure message copied when a turn failed. */
  planningFailureReason?: string
  /** Typed termination reason copied when the runner recorded infeasibility. */
  termination?: string
}

/** Outcome label and provenance for one recorded decision. */
export interface CassetteLabelLeg {
  /** Recorded verifier outcome; structurally absent when no verdict was recorded. */
  verdict?: VerifierVerdict
  /** Provenance channel for this label. */
  sourceChannel: LabelSourceChannel
  /** Confidence tier assigned from the channel vocabulary. */
  tier: LabelTier
  /** Recorded failure projections only; unavailable fields remain absent. */
  recordedFailure?: RecordedFailureContext
  /**
   * The member test's recorded root cause, copied verbatim from the handoff, `memoryOnPath`
   * included. Absent when the member recorded no root cause.
   */
  rootCause?: Verdict
  /** Reserved contrastive-pair slot populated by the later label factory. */
  pairing?: ContrastivePairing
}
