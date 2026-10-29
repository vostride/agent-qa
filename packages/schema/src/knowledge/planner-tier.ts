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

// `deterministicPath` needs authentic recorded execution evidence; nothing else may infer it.
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
