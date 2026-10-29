import type {
  AssertValueEvidence,
  MemberTestOutcome,
  VerifierVerdict,
} from '@vostride/agent-qa-schema'
import type { CassetteCompleteness } from './completeness'
import type { CassetteInputLeg } from './input-leg'
import type { CassetteLabelLeg } from './label-leg'
import type { CassetteReceipt } from './receipt-leg'
import type { CassetteSidecarLeg } from './sidecar-leg'

/** The single schema version shared by the envelope and all four legs. */
export const CASSETTE_SCHEMA_VERSION = 2

/** One complete live planner decision assembled from the four cassette legs. */
export interface DecisionRecord {
  /** Reconstructable planner input. */
  input: CassetteInputLeg
  /** Matcher-owned gold action and target context. */
  sidecar: CassetteSidecarLeg
  /** Recorded outcome plus label provenance. */
  label: CassetteLabelLeg
  /** Reproducibility pins for attribution. */
  receipt: CassetteReceipt
}

/** A procedure entry backed by a live planner decision. */
export interface ProcedureDecisionStepRecord {
  /** Discriminator for a fully replayable decision entry. */
  kind: 'decision'
  stepIndex: number
  decisionOrdinal: number
  /** Fully self-contained four-leg decision record. */
  record: DecisionRecord
}

/** A truthful procedure entry for an action served from cache. */
export interface ProcedureCacheServedStepRecord {
  /** Discriminator for a non-replayable cache-served entry. */
  kind: 'cache-served'
  stepIndex: number
  /** Recorded cached-action position within the step. */
  decisionOrdinal: number
}

/** A truthful procedure entry for a step whose outcome was synthesized. */
export interface ProcedureSynthesizedStepRecord {
  /** Discriminator for a step with no recorded action decision. */
  kind: 'synthesized'
  stepIndex: number
}

/** Ordering-faithful union of procedure entries. */
export type ProcedureStepRecord =
  | ProcedureDecisionStepRecord
  | ProcedureCacheServedStepRecord
  | ProcedureSynthesizedStepRecord

/** Purely recorded terminal state for one procedure cassette. */
export interface ProcedureEndState {
  outcome: MemberTestOutcome
  /** Final recorded verifier outcome, when one exists. */
  finalVerdict?: VerifierVerdict
  /** Final recorded deterministic assertion outcome, when the last decision was one. */
  finalAssert?: AssertValueEvidence
}

interface CassetteEnvelopeBase {
  /** Single version gate for the complete cassette document. */
  schemaVersion: number
  /** Deterministic run-derived cassette identity. */
  id: string
  /** Source run identity copied as a plain wire string. */
  runId: string
  testId: string
  testIndex: number
  /** Complete ordered closure of required content digests. */
  blobs: readonly string[]
  /** Unified status and structured missing-evidence details. */
  completeness: CassetteCompleteness
}

/** Self-contained single-decision cassette. */
export interface LeafCassette extends CassetteEnvelopeBase {
  granularity: 'leaf'
  stepIndex: number
  decisionOrdinal: number
  input: CassetteInputLeg
  sidecar: CassetteSidecarLeg
  label: CassetteLabelLeg
  receipt: CassetteReceipt
}

/** Self-contained procedure cassette scored as independent recorded decisions. */
export interface ProcedureCassette extends CassetteEnvelopeBase {
  granularity: 'procedure'
  /** Ordered decision, cache-served, and synthesized entries. */
  steps: readonly ProcedureStepRecord[]
  /** Purely recorded procedure outcome and terminal assertions. */
  endState: ProcedureEndState
}

/** Supported cassette granularities. */
export type CassetteGranularity = 'leaf' | 'procedure'

/** Complete versioned cassette wire contract. */
export type Cassette = LeafCassette | ProcedureCassette
