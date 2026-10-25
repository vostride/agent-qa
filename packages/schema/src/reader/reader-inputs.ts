import type { Anchor } from '../identity/anchor'
import type { ScopeKey } from '../identity/scope-key'
import type { RecordId } from '../ids/record-id'
import type { Benefit, StateValidity } from '../knowledge/gate-receipt'

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
  /** D-11: the tool wrapper passes its remaining read-body budget for reader-side truncation. */
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
  stateValidity: StateValidity
  /** Distilled pre-action live-step state digest. */
  observedStateDigest?: string
  /** Pin 3: the exact candidate whose served hypothesis was exercised. */
  candidateId: RecordId
  /** D-21: only attributed step verdicts move trust; ambiguous outcomes are never emitted. */
  runOutcome: 'positive' | 'negative'
  /** Pin 3: run identity participates in the replay-safe evidence token. */
  runId: string
  /** D-21: containing test identity disambiguates step-local indices within one run. */
  testId: string
  /** D-21: stable test ordinal participates in replay identity and reporting. */
  testIndex: number
  /** D-21: deterministic build ordinal only; wall-clock time is never attribution authority. */
  buildOrdinal: number
  /** D-21: per-step granularity prevents run-level noise from moving trust. */
  stepIndex: number
  /** D-01/Pin 3: binds attribution to the frozen ServedBrief used by the step. */
  briefDigest: string
  /** Human-readable attribution rationale; deliberately non-load-bearing. */
  attribution: string
  /** D-21: the normalized candidate anchor actually exercised by the attributed step. */
  exercisedAnchor: Anchor
}
