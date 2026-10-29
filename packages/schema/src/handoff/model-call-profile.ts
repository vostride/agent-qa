// Absent means the provider default; the output ceiling belongs to `executeClampedCall` alone.
export interface SamplingParams {
  temperature?: number
  topP?: number
  stop?: string[]
  seed?: number
}

export interface ModelIdentity {
  provider: string
  modelId: string
}

// Built once per role so the call site and the recorder share one source of declared values.
export interface DeclaredModelProfile {
  provider: string
  modelId: string
  vision: boolean
  maxOutputTokens?: number
  sampling?: SamplingParams
}

// Every enrichment is optional and recorded only when known, never fabricated.
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
