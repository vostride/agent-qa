import {
  MARKS,
  ORIGIN_PRIORS,
  plannerCapabilityTier,
  type ModelIdentity,
  type VerifierVerdict,
} from '@vostride/agent-qa-schema'
import type { GoldMark } from './golden-plan'
import type { LabelWeight } from './label-record'

/**
 * Provisional monotone evidence discounts (420 D-03), never configuration or estimated
 * accuracies: sovereign evidence is unattenuated, ordinary verification modestly
 * discounted, incomplete verification most discounted. These are not empirically
 * measured recovery probabilities.
 */
export const SOFT_VERDICT_FACTORS = Object.freeze({
  'user-gold': 1,
  'stable-pass-silver': 0.8,
  unverified: 0.5,
} as const satisfies Record<LabelWeight['verdictSource'], number>)

/** Provisional capability discounts: full evidence, weaker evidence, deterministic floor. */
export const SOFT_TIER_FACTORS = Object.freeze({
  full: 1,
  degraded: 0.75,
  floor: 0.5,
} as const satisfies Record<LabelWeight['capabilityTier'], number>)

/** Caller resolves attribution and latest governing authority before constructing this data. */
export interface SoftRecoveringDecisionEvidence {
  modelIdentity?: ModelIdentity
  /** True only when this recovering decision actually executed a recorded deterministic path. */
  deterministicPath?: boolean
  /** Projection of the actual governing receipt, never a freshly minted label tier. */
  governingMark?: Pick<GoldMark, 'markId' | 'kind'>
  /** Recorded verification of the recovering decision; absence is unverified. */
  verifierVerdict?: Pick<VerifierVerdict, 'pass'>
}

export interface ComputeSoftWeightInput {
  k: number
  n: number
  corpusDigest: string
  evidenceDigest: string
  recoveringDecision: SoftRecoveringDecisionEvidence
}

function verdictSourceOf(evidence: SoftRecoveringDecisionEvidence): LabelWeight['verdictSource'] {
  const { governingMark, verifierVerdict, deterministicPath } = evidence
  if (deterministicPath !== undefined && typeof deterministicPath !== 'boolean') {
    throw new TypeError('SOFT deterministic evidence must be a recorded boolean')
  }
  if (verifierVerdict !== undefined && typeof verifierVerdict?.pass !== 'boolean') {
    throw new TypeError('SOFT verifier evidence must contain a recorded boolean verdict')
  }
  if (governingMark !== undefined) {
    if (!governingMark || typeof governingMark.markId !== 'string'
      || !governingMark.markId.trim() || !MARKS.includes(governingMark.kind)) {
      throw new TypeError('SOFT governing mark requires a receipt identity and known kind')
    }
    return 'user-gold'
  }
  return verifierVerdict?.pass === true ? 'stable-pass-silver' : 'unverified'
}

/**
 * Closed-form smoothed evidence weight, returned in the complete persisted contract.
 * Population selection, canonical action equality and source attribution belong to the
 * caller; the two supplied digests bind that population and its originating evidence.
 * No rounding, calibrated priors, caller-supplied factors or label tiers enter this fold.
 */
export function computeSoftWeight(input: ComputeSoftWeightInput): LabelWeight {
  const { k, n, corpusDigest, evidenceDigest, recoveringDecision } = input
  const { alpha: alpha0, beta: beta0 } = ORIGIN_PRIORS['agent-verified']
  if (!Number.isSafeInteger(k) || !Number.isSafeInteger(n) || k < 0 || n < 0 || k > n) {
    throw new RangeError('SOFT counts require safe integers with 0 <= k <= n')
  }
  if (![alpha0, beta0, alpha0 + beta0].every(Number.isFinite)
    || alpha0 < 0 || beta0 < 0 || alpha0 + beta0 <= 0) {
    throw new RangeError('SOFT prior requires finite nonnegative counts and positive mass')
  }
  if (![corpusDigest, evidenceDigest].every(value =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))) {
    throw new TypeError('SOFT population and evidence digests must be SHA-256 hex')
  }
  const verdictSource = verdictSourceOf(recoveringDecision)
  const capability = plannerCapabilityTier(
    recoveringDecision.modelIdentity, recoveringDecision.deterministicPath,
  )
  const verdictFactor = SOFT_VERDICT_FACTORS[verdictSource]
  const tierFactor = SOFT_TIER_FACTORS[capability.tier]
  const value = verdictFactor * tierFactor * (k + alpha0) / (n + alpha0 + beta0)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('SOFT weight must be finite and within [0, 1]')
  }
  return {
    value, k, n, verdictSource, verdictFactor, capabilityTier: capability.tier, tierFactor,
    alpha0, beta0, corpusDigest, evidenceDigest, capabilityEvidence: capability.evidence,
  }
}
