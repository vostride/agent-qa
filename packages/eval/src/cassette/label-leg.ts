import type { VerifierVerdict, Verdict } from '@vostride/agent-qa-schema'

/** Quality vocabulary reserved for every current and later label source (D-16). */
export type LabelTier = 'gold' | 'near-gold' | 'silver'

/** 420 D-01: reserved tiers, pinned independently by runtime and type oracles. */
export const LABEL_TIERS = ['gold', 'near-gold', 'silver'] as const satisfies readonly LabelTier[]

/** Channel that supplied the cassette label (D-16). */
export type LabelSourceChannel =
  | 'recorded-verdict'
  | 'user-mark'
  | 'overturned-verdict'
  | 'self-heal-pair'

/** 420 D-01: existing channels only; sovereign gold producers retain their identities. */
export const LABEL_SOURCE_CHANNELS = [
  'recorded-verdict',
  'user-mark',
  'overturned-verdict',
  'self-heal-pair',
] as const satisfies readonly LabelSourceChannel[]

/** Optional relationship to the sibling in a contrastive example (D-17). */
export interface ContrastivePairing {
  /** Deterministic cassette identity of the paired example (D-17). */
  pairedCassetteId: string
  /** Whether this member is the successful or unsuccessful side of the pair (D-17). */
  relation: 'contrastive-positive' | 'contrastive-negative'
}

/** Recorded failure-only context available without synthesizing new facts (D-16). */
export interface RecordedFailureContext {
  /** Verifier-authored reasoning copied from recorded evidence when present (D-16). */
  verifierReasoning?: string
  /** Structured planning failure message copied when a turn failed (D-16). */
  planningFailureReason?: string
  /** Typed termination reason copied when the runner recorded infeasibility (D-16). */
  termination?: string
}

/** Outcome label and provenance for one recorded decision (D-16/D-17). */
export interface CassetteLabelLeg {
  /** Recorded verifier outcome; structurally absent when no verdict was recorded (D-16). */
  verdict?: VerifierVerdict
  /** Provenance channel for this label (D-16). */
  sourceChannel: LabelSourceChannel
  /** Confidence tier assigned from the channel vocabulary (D-16). */
  tier: LabelTier
  /** Recorded failure projections only; unavailable fields remain absent (D-16). */
  recordedFailure?: RecordedFailureContext
  /**
   * The member test's recorded root cause, copied verbatim from the handoff, `memoryOnPath`
   * included. Absent when the member recorded no root cause.
   */
  rootCause?: Verdict
  /** Reserved contrastive-pair slot populated by the later label factory (D-17). */
  pairing?: ContrastivePairing
}
