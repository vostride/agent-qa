import type { ArtifactRef } from '../ids/artifact-ref'
import type { RecordId } from '../ids/record-id'
import type { Anchor } from '../identity/anchor'
import type { ScopeKey } from '../identity/scope-key'
import type { ExecutionContext } from '../run/run-status'

export type BundleKind = 'fact' | 'procedure' | 'caution' | 'unknown' | 'policy'
export type FactSubtype =
  | 'selector'
  | 'behavioral'
  | 'navigational'
  | 'measurement'
  | 'content'

// The one-shot Curator drainer is the only producer.
export type OriginStage = 'run-curation'

export type CurationAuthorshipPath = 'llm' | 'llm-repaired' | 'deterministic-fallback'

// Why the author fell back, so a delta-noop drain report can name its cause.
export type CurationFallbackReason = 'malformed' | 'no-model' | 'token-budget' | 'model-error'

export interface CurationAuthorship {
  path: CurationAuthorshipPath
  model?: {
    id: string
    family?: string
    fingerprint?: string
  }
  executionContext: ExecutionContext
  // Read only to derive a drain-noop cause, never as a trust or tier input.
  fallbackReason?: CurationFallbackReason
}

export interface CompareAndSet {
  recordId: RecordId
  observedStatus: string
  observedOrdinal: number
}

// `origin` decides whether a committed change is attributed to a person or to the agent.
export const DELTA_ORIGINS = ['agent', 'user', 'import', 'system'] as const

export type DeltaOrigin = (typeof DELTA_ORIGINS)[number]

export interface DeltaEnvelope {
  origin: DeltaOrigin
  scope: ScopeKey
  citedIds: RecordId[]
  precondition?: CompareAndSet[]
  authorship?: CurationAuthorship
}

export interface BundleDraft {
  kind: BundleKind
  subtype?: FactSubtype
  anchors: Anchor[]
  scope: ScopeKey
  summary: string
  body: string
  distilledEvidenceRef: ArtifactRef
  originStage: OriginStage
}
