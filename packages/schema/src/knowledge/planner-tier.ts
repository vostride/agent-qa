import type { ModelIdentity } from '../handoff/model-call-profile'
import { matchesCapableFamily, type CuratorTier } from './curator-tier'

/** Evidence supplied by the recovering decision's producer, never another actor. */
export type PlannerCapabilityEvidence =
  | { kind: 'model-identity'; modelIdentity: ModelIdentity }
  | { kind: 'deterministic' }
  | { kind: 'missing' }

export interface PlannerCapability {
  tier: CuratorTier
  evidence: PlannerCapabilityEvidence
}

/**
 * Provisional capability from the recovering planner's own recorded identity.
 * The caller must establish that identity belongs to this decision. `deterministicPath`
 * means authentic recorded execution evidence; absence, a verifier or curator identity,
 * and a configured provider are never grounds to infer that flag. Family matching is
 * exactly the curator law, while curator repair/authorship rules remain curator-only.
 */
export function plannerCapabilityTier(
  modelIdentity: ModelIdentity | undefined,
  deterministicPath?: boolean,
): PlannerCapability {
  if (deterministicPath === true) return { tier: 'floor', evidence: { kind: 'deterministic' } }
  if (!modelIdentity?.modelId?.trim() || !modelIdentity.provider?.trim()) {
    return { tier: 'degraded', evidence: { kind: 'missing' } }
  }
  const { provider, modelId } = modelIdentity
  return {
    tier: matchesCapableFamily(modelId) ? 'full' : 'degraded',
    evidence: { kind: 'model-identity', modelIdentity: { provider, modelId } },
  }
}
