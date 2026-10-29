import type { Action, ModelIdentity } from '@vostride/agent-qa-schema'
import type { TokenUsage } from '@vostride/agent-qa-runner'
import type { ProcedureEndState } from '../cassette/cassette'
import type { CompletenessStatus } from '../cassette/completeness'
import type { ReplayDrift } from './drift'
import type { DecisionIdentity } from './identity'
import type { BriefSource, TurnMatch } from './brief-tiers'

/**
 * A recorded exchange the replayed planner never consumed — a D-07 divergence signal.
 * Tool name plus canonically-serialized args; the args are opaque evidence data, never executed.
 */
export interface UnconsumedExchange {
  tool: string
  args: Record<string, unknown>
}

/**
 * The four typed per-sample outcomes. Every outcome is reported; nothing is silent
 * and no single sample aborts the batch.
 *  - `decision`: a grounded wire-shape action plus its normalized DecisionIdentity.
 *  - `planner-failure`: a scoreable structured planner failure (reason produced via
 *    PlanningTurnError classification in the engine, plan 368-04 — never string-matched here).
 *  - `unservable-divergence`: the recorded turn requested a tool the null adapter cannot serve
 *    (tool name + canonical args) — a D-08 divergence, not an infra failure.
 *  - `harness-error`: infrastructure-only failure; never scored.
 */
export type ReplaySampleOutcome =
  | { kind: 'decision'; action: Action; identity: DecisionIdentity }
  | { kind: 'planner-failure'; reason: string; message: string }
  | { kind: 'unservable-divergence'; tool: string; args: Record<string, unknown> }
  | { kind: 'harness-error'; message: string }

/** One replayed sample of a single recorded decision. */
export interface ReplaySample {
  sampleIndex: number
  outcome: ReplaySampleOutcome
  /** Typed-absent when the provider omits usage; never fabricated. */
  tokenUsage?: TokenUsage
  /** Typed-absent when no unsupported provider feature was reported for this sample. */
  unsupportedFeatures?: readonly string[]
  /** Provider-reported identifier, absent when unreported. Disclosure only; never keys a profile. */
  providerFingerprint?: string
  durationMs: number
}

/**
 * k-sample agreement summary. `agreementRate` is the modal identity class size over k.
 * `noConsensus` is deterministic (doc-commented rule): true when k > 1 and the largest identity
 * class has size 1, or when the largest classes tie for first. `modal` is absent on no consensus.
 */
export interface ReplayAgreement {
  k: number
  agreementRate: number
  modal?: { identity: DecisionIdentity; count: number }
  noConsensus: boolean
  harnessErrorCount: number
}

/** The replay result core for one recorded decision (leaf, or one procedure step). */
export interface DecisionReplayResult {
  cassetteId: string
  samples: ReplaySample[]
  agreement: ReplayAgreement
  /** Absent on no consensus (mirrors agreement.noConsensus). */
  modalDecision?: DecisionIdentity
  promptDrift: ReplayDrift
  /** Recorded proof, approximate rendering, or an empty brief; counted per decision. */
  briefSource: BriefSource
  /** Proof-turn selection is explicit, including the uniform-tier fallback. */
  turnMatch?: TurnMatch
  /** Recorded model identity from the receipt (declared/resolvedModelId); typed-absent, never fabricated. */
  recordedModel?: ModelIdentity
  /** The model actually invoked this replay (D-03 id stamp). */
  replayedModel: { provider: string; modelId: string }
  /** D-07 divergence: recorded exchanges the replayed planner never consumed. */
  unconsumedExchanges: UnconsumedExchange[]
  totalDurationMs: number
}

/** A single-decision (leaf-granularity) replay result. */
export interface LeafReplayResult extends DecisionReplayResult {
  granularity: 'leaf'
}

/**
 * One procedure step's replay: a full decision result, or a typed skipped entry for the
 * cache-served / synthesized steps that carry no live planner decision.
 */
export type ProcedureStepReplay =
  | { kind: 'decision'; stepIndex: number; decisionOrdinal: number; result: DecisionReplayResult }
  | { kind: 'skipped'; stepIndex: number; reason: 'cache-served' | 'synthesized'; decisionOrdinal?: number }

/** A procedure-granularity replay result; the recorded endState is carried through untouched for 369. */
export interface ProcedureReplayResult {
  granularity: 'procedure'
  cassetteId: string
  steps: ProcedureStepReplay[]
  endState: ProcedureEndState
  totalDurationMs: number
}

/** A replayed cassette result — leaf or procedure. */
export type ReplayResult = LeafReplayResult | ProcedureReplayResult

/**
 * A typed integrity refusal: the cassette could not be replayed at all. Every refusal is
 * reported — a refusal never aborts the surrounding batch.
 */
export interface ReplayRefusal {
  kind: 'integrity-refusal'
  cassetteId: string
  reason:
    | 'guard-failed'
    | 'completeness'
    | 'missing-blob'
    | 'action-tool-collision'
    | 'unsupported-brief'
    | 'unrenderable-brief'
    | 'parse-failed'
  detail: string
  completenessStatus?: CompletenessStatus
}

// prettier-ignore
export const REPLAY_REFUSAL_REASONS = ['guard-failed', 'completeness', 'missing-blob', 'action-tool-collision', 'unsupported-brief', 'unrenderable-brief', 'parse-failed'] as const satisfies readonly ReplayRefusal['reason'][]

/** The per-cassette replay outcome: a replay result or a typed refusal. */
export type ReplayCassetteOutcome = ReplayResult | ReplayRefusal
