/** Unified completeness vocabulary extended only when a new missing-evidence kind appears. */
export type CompletenessStatus = 'complete' | 'evidence-incomplete' | 'anchor-unresolved'

/** Closed set of typed missing-evidence kinds; new kinds extend the enum, not the shape. */
export type MissingCassetteEvidenceKind = 'decision-screenshot-ref'

/** One coordinate-bearing missing-evidence fact keyed to a recorded decision. */
export interface MissingCassetteEvidence {
  /** Which required evidence role is absent. */
  kind: MissingCassetteEvidenceKind
  /** Recorded zero-based step position the missing evidence belongs to. */
  stepIndex: number
  /** Recorded zero-based decision position within the step. */
  decisionOrdinal: number
}

/** Structured facts explaining whether a cassette can replay and score completely. */
export interface CassetteCompleteness {
  // With blobs missing and an anchor unresolved, `evidence-incomplete` wins; both details stay.
  status: CompletenessStatus
  /** Referenced content digests whose bytes were unavailable at extraction. */
  missingBlobShas?: readonly string[]
  /** Evidence-only ref that could not resolve against the recorded observation. */
  unresolvedAnchorRef?: string
  /** Nonempty coordinate-bearing missing-evidence facts when any exist. */
  missingEvidence?: readonly MissingCassetteEvidence[]
}
