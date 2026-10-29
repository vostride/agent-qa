import type { ModelIdentity, SamplingParams } from '@vostride/agent-qa-schema'

/** Declared and observed model identity pins for one decision. */
export interface CassetteModelReceipt {
  /** Declared provider and model identifier, when recorded. */
  declared?: ModelIdentity
  /** Provider-resolved model identifier, when exposed. */
  resolvedModelId?: string
  /** Provider-observed model fingerprint, when exposed. */
  fingerprint?: string
}

/** Declared and effective sampling pins for one decision. */
export interface CassetteSamplingReceipt {
  /** Declared sampling intent; absence means provider defaults. */
  declared?: SamplingParams
  /** Effective sampling values observed at the call boundary, when known. */
  effective?: SamplingParams
}

/** Identity of the label-producing judge paths. */
export interface CassetteJudgeReceipt {
  /** Recorded verifier identity that produced the current label, when present. */
  recordedVerifier?: ModelIdentity
  // Reserved judge identifier; nothing writes it.
  tier4JudgeId?: string
}

// Reproducibility receipt for a cassette decision.
export interface CassetteReceipt {
  /** Full digest of the canonical serialized cassette input leg. */
  promptInputHash: string
  /** Declared and observed model identity component. */
  model: CassetteModelReceipt
  /** Declared and effective sampling component. */
  sampling: CassetteSamplingReceipt
  /** Recorded bound-tool-surface digest, when available. */
  toolSchemaDigest?: string
  /** Recomputed deterministic hash of the recorded observation. */
  screenStateHash: string
  /** Digest already carried by the exact served brief, when available. */
  memoryBriefDigest?: string
  /** Recorded verifier identity and reserved tier-4 judge slot. */
  judge: CassetteJudgeReceipt
  /** Monotonic build ordinal copied from the handoff root. */
  buildOrdinal: number
}
