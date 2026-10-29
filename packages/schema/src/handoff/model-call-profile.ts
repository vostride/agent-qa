/**
 * Optional sampling intent/effective values. An absent field means the provider
 * default and is never fabricated. `maxOutputTokens` is deliberately excluded:
 * the output ceiling is owned exclusively by `executeClampedCall`.
 */
export interface SamplingParams {
  temperature?: number
  topP?: number
  stop?: string[]
  seed?: number
}

/**
 * The verifier identity projection recorded beside its verdict.
 */
export interface ModelIdentity {
  provider: string
  modelId: string
}

/**
 * Root-declared decision-context intent, constructed once per role and threaded
 * to both the call site and recorder so declared, applied, and recorded values share one
 * source. `maxOutputTokens` is the declared ceiling that feeds the clamp's default
 * input, not a second writer. This evidence vocabulary is deliberately distinct from
 * `model-profile/model-profile.ts`'s `ModelProfile`, which describes model configuration.
 */
export interface DeclaredModelProfile {
  provider: string
  modelId: string
  vision: boolean
  maxOutputTokens?: number
  sampling?: SamplingParams
}

/**
 * Per-call observed reality for the final, decision-producing response of a planning
 * turn. Every enrichment is optional: providers may omit the resolved id
 * or fingerprint, and effective values are recorded only when known, never fabricated.
 */
export interface ModelCallRecord {
  resolvedModelId?: string
  fingerprint?: string
  effectiveMaxOutputTokens?: number
  effectiveSampling?: SamplingParams
  /**
   * Sorted, deduplicated feature names from typed unsupported provider warnings across the
   * planning turn. Absent when the provider warned about no unsupported feature.
   */
  unsupportedFeatures?: readonly string[]
}
