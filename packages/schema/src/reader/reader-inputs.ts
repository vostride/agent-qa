import type { Anchor } from '../identity/anchor'
import type { ScopeKey } from '../identity/scope-key'
import type { RecordId } from '../ids/record-id'
import type { Benefit } from '../knowledge/gate-receipt'

export interface BuildRange {
  from?: number
  to?: number
}

export interface SearchOptions {
  scope: ScopeKey
  kind?: string
  anchors?: Anchor[]
  asOfBuild?: number
  includeSuperseded?: boolean
  asOfRange?: BuildRange
  includeCandidates?: boolean
}

export interface ReadOptions {
  detailLevel?: string
  // The tool wrapper passes its remaining read-body budget for reader-side truncation.
  budget?: number
  /** Wrapper-fixed scope; never accepted from the planner-facing memory.read schema. */
  scope?: ScopeKey
  /** Wrapper-fixed build boundary; never accepted from the planner-facing memory.read schema. */
  asOfBuild?: number
}

export interface CanaryOutcome {
  /** Decided by the cli post-run tail: rode-along on a positive run, exercised-harmed on a
   * negative one. */
  benefit: Benefit
  /** Pin 3: the exact candidate whose served hypothesis was exercised. */
  candidateId: RecordId
  // Only attributed step verdicts move trust; ambiguous outcomes are never emitted.
  runOutcome: 'positive' | 'negative'
  /** Pin 3: run identity participates in the replay-safe evidence token. */
  runId: string
  // The containing test disambiguates step-local indices within one run.
  testId: string
  // A stable test ordinal used in replay identity and reporting.
  testIndex: number
  // A deterministic build ordinal; wall-clock time never decides attribution.
  buildOrdinal: number
  // Per-step granularity keeps run-level noise from moving trust.
  stepIndex: number
  // Binds attribution to the frozen `ServedBrief` the step used.
  briefDigest: string
  /** Human-readable attribution rationale; deliberately non-load-bearing. */
  attribution: string
  // The normalized candidate anchor the attributed step exercised.
  exercisedAnchor: Anchor
}
