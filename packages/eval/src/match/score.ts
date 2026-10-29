import type { ScreenStateMetadata } from '@vostride/agent-qa-schema'

import type {
  Cassette,
  ProcedureEndState,
  ProcedureCassette,
} from '../cassette/cassette'
import type { CassetteSidecarLeg } from '../cassette/sidecar-leg'
import { projectActionGoldValue } from '../extract/sidecar-leg'
import { decisionIdentityKey } from '../replay/identity'
import type {
  DecisionReplayResult,
  ReplayCassetteOutcome,
  ReplayRefusal,
  ReplaySample,
} from '../replay/result'
import { MATCHER_CONFIG } from './config'
import {
  collectProcedurePriorIdentities,
  computeLoopVerdict,
} from './loop'
import type {
  LoopHistory,
  LoopVerdict,
  ProcedurePriorIdentity,
} from './loop'
import { runMatchTiers } from './tiers'
import type {
  ElementIdentityVerdict,
  OpClassVerdict,
} from './tiers'
import { tokenSetF1 } from './value'

// Value-axis result; absence and hard-gate short-circuits are never numeric.
export type ValueAxisVerdict =
  | { kind: 'not-applicable' }
  | { kind: 'not-evaluated' }
  | { kind: 'scored'; f1: number; band: 'full' | 'mid' | 'low' }

// The deliberately narrow deterministic tie vocabulary.
export type TieCause = 'partial-identity' | 'value-mid-band' | 'no-consensus'

// Categorical judge confidence; there is no numeric self-report.
export type JudgeConfidence = 'high' | 'medium' | 'low'

/** Typed-absent judge token usage: token fields stay absent when the provider omits them. */
export interface JudgeTokenUsage {
  calls: number
  inputTokens?: number
  outputTokens?: number
}

// Calibrated-abstention causes; each is a counted honesty outcome.
export type JudgeAbstentionCause =
  | 'unsure-verdict'
  | 'below-threshold'
  | 'swap-disagreement'
  | 'candidate-overflow'
  | 'missing-evidence'
  | 'residual-tie'
  | 'below-quorum'
  | 'panel-disagreement'

/** Governed persisted vocabulary, pinned independently by runtime and type instruments. */
export const JUDGE_ABSTENTION_CAUSES = [
  'unsure-verdict',
  'below-threshold',
  'swap-disagreement',
  'candidate-overflow',
  'missing-evidence',
  'residual-tie',
  'below-quorum',
  'panel-disagreement',
] as const satisfies readonly JudgeAbstentionCause[]

// Infra-failure reasons, kept apart from calibrated abstention.
export type JudgeErrorReason = 'provider-error' | 'unparseable-output'

// Reasons a judge never ran: unconfigured, or family eligibility refused it.
export type JudgeNotInvokedReason = 'no-judge-configured' | 'no-eligible-judge'

/** One member's swap-surviving result; errors remain distinct from abstentions. */
export type JudgePairwiseOutcome =
  | { kind: 'settled'; resolution: 'equivalent' | 'different'; confidence: JudgeConfidence }
  | { kind: 'abstained'; cause: JudgeAbstentionCause; confidence?: JudgeConfidence }
  | { kind: 'error'; reason: JudgeErrorReason; detail: string }

export interface JudgeMemberIdentity {
  judgeModelId: string
  judgeFamily: string
}

export interface JudgeMemberOutcome extends JudgeMemberIdentity {
  outcome: JudgePairwiseOutcome
  usage?: JudgeTokenUsage
}

export interface JudgeFamilyDisclosure {
  judge?: string
  replayed?: string
  recorded?: string
  members?: readonly { judgeModelId: string; judgeFamily?: string }[]
  offendingPair?: readonly [string, string]
}

// A judge-settled result stays `scored`, with the stamp on the exact axis it settled.
export interface JudgeSettled {
  axis: 'element-identity' | 'value'
  resolution: 'equivalent' | 'different'
  cause: TieCause
  judgeId: string
  judgeVersion: number
  confidence: JudgeConfidence
  usage?: JudgeTokenUsage
  members?: readonly JudgeMemberOutcome[]
}

// `not-invoked` families are plain strings so match never imports from judge.
export type JudgeOutcome =
  | {
      kind: 'abstained'
      cause: JudgeAbstentionCause
      confidence?: JudgeConfidence
      judgeId: string
      judgeVersion: number
      usage?: JudgeTokenUsage
      members?: readonly JudgeMemberOutcome[]
    }
  | {
      kind: 'judge-error'
      reason: JudgeErrorReason
      detail: string
      judgeId: string
      judgeVersion: number
      usage?: JudgeTokenUsage
      members?: readonly JudgeMemberOutcome[]
    }
  | {
      kind: 'not-invoked'
      reason: JudgeNotInvokedReason
      families?: JudgeFamilyDisclosure
    }

// The full judge identity behind any stamp; the scorer never writes back into the cassette.
export interface JudgeIdentityBlock {
  judgeModelId: string
  judgeFamily: string
  judgeVersion: number
  confidenceThreshold: JudgeConfidence
  panelSize?: number
  members?: readonly JudgeMemberIdentity[]
  // Present only when `allowSameFamily` lifted a known same-family refusal.
  familyOverride?: 'same-family-allowed'
}

// The primary score axes; no combined numeric field exists.
export interface DecisionAxes {
  elementIdentity: ElementIdentityVerdict
  opClass: OpClassVerdict
  value: ValueAxisVerdict
}

/** The attribution-grade breakdown carried by settled scores and unresolved ties. */
export interface DecisionPartialBreakdown {
  axes: DecisionAxes
  loop: LoopVerdict
  tierReached: 1 | 2 | 3
}

// Failures have no fabricated axes; unresolved ties keep the partial breakdown of a real sample.
export type DecisionScore =
  | ({
      kind: 'scored'
      matcherVersion: number
      // Optional provenance stamp; absent whenever no judge settled an axis.
      judgeSettled?: JudgeSettled
    } & DecisionPartialBreakdown)
  | { kind: 'miss-by-failure'; reason: string; matcherVersion: number }
  | {
      kind: 'unresolved-tie'
      cause: TieCause
      partial?: DecisionPartialBreakdown
      matcherVersion: number
      // Optional typed judge outcome; the deterministic shape is the same without it.
      judgeOutcome?: JudgeOutcome
    }

/** Typed exclusion returned when no decision or scoreable failure outcome exists. */
export interface NeverScoredDecision {
  kind: 'never-scored'
  reason: 'all-samples-harness-error' | 'modal-representative-missing'
  matcherVersion: number
}

// Direct decision-scoring outcome, including the harness-only exclusion.
export type ScoreDecisionOutcome = DecisionScore | NeverScoredDecision

/** Context that binds a score to its recorded screen and procedure prefix. */
export interface ScoreDecisionContext {
  priorIdentities: LoopHistory
  screenStateHash: string
  stateMetadata?: ScreenStateMetadata
}

/** One counted cassette entry: a decision score, a never-scored exclusion, or a typed skip. */
export type DecisionScoreEntry =
  | {
      kind: 'decision'
      decisionOrdinal: number
      stepIndex?: number
      score: DecisionScore
    }
  | {
      kind: 'never-scored'
      decisionOrdinal: number
      stepIndex?: number
      reason:
        | NeverScoredDecision['reason']
        | 'missing-cassette-decision'
        | 'stale-scoring-context'
      matcherVersion: number
    }
  | {
      kind: 'skipped'
      stepIndex: number
      decisionOrdinal?: number
      reason: 'cache-served' | 'synthesized'
    }

// Procedure context only; not a procedure-level pass or fail verdict.
export interface ProcedureScoreSummary {
  stepsMatchedFraction: number
  firstDivergentStepIndex?: number
  endState: ProcedureEndState
}

/** Per-cassette scoring result with refusals and shape failures kept as typed outcomes. */
export type CassetteScore =
  | { kind: 'leaf'; cassetteId: string; entry: DecisionScoreEntry }
  | {
      kind: 'procedure'
      cassetteId: string
      entries: readonly DecisionScoreEntry[]
      summary: ProcedureScoreSummary
    }
  | { kind: 'replay-refusal'; cassetteId: string; refusal: ReplayRefusal }
  | {
      kind: 'shape-mismatch'
      cassetteId: string
      reason: 'granularity-mismatch'
      matcherVersion: number
    }

function valueBand(f1: number): 'full' | 'mid' | 'low' {
  if (f1 >= MATCHER_CONFIG.valueMidBand.high) return 'full'
  if (f1 >= MATCHER_CONFIG.valueMidBand.low) return 'mid'
  return 'low'
}

function scoreValueAxis(
  sidecar: CassetteSidecarLeg,
  action: Extract<ReplaySample['outcome'], { kind: 'decision' }>['action'],
  opClass: OpClassVerdict,
): ValueAxisVerdict {
  if (opClass.kind === 'mismatch') return { kind: 'not-evaluated' }
  if (sidecar.goldValue === undefined) return { kind: 'not-applicable' }
  const candidateValue = projectActionGoldValue(action) ?? ''
  const f1 = tokenSetF1(sidecar.goldValue, candidateValue)
  return { kind: 'scored', f1, band: valueBand(f1) }
}

function buildBreakdown(
  sidecar: CassetteSidecarLeg,
  sample: ReplaySample,
  context: ScoreDecisionContext,
): DecisionPartialBreakdown | undefined {
  if (sample.outcome.kind !== 'decision') return undefined
  const tierResult = runMatchTiers(
    sidecar,
    { action: sample.outcome.action, identity: sample.outcome.identity },
    context.stateMetadata,
  )
  return {
    axes: {
      elementIdentity: tierResult.elementIdentity,
      opClass: tierResult.opClass,
      value: scoreValueAxis(sidecar, sample.outcome.action, tierResult.opClass),
    },
    loop: computeLoopVerdict(
      sample.outcome.identity,
      context.screenStateHash,
      context.priorIdentities,
    ),
    tierReached: tierResult.tierReached,
  }
}

function partialIdentity(elementIdentity: ElementIdentityVerdict): boolean {
  return (
    elementIdentity.kind === 'scored' &&
    elementIdentity.level !== 'full' &&
    elementIdentity.level !== 'miss'
  )
}

function scoreBreakdown(breakdown: DecisionPartialBreakdown): DecisionScore {
  if (partialIdentity(breakdown.axes.elementIdentity)) {
    return {
      kind: 'unresolved-tie',
      cause: 'partial-identity',
      partial: breakdown,
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    }
  }
  if (
    breakdown.axes.elementIdentity.kind === 'scored' &&
    breakdown.axes.elementIdentity.level === 'full' &&
    breakdown.axes.value.kind === 'scored' &&
    breakdown.axes.value.band === 'mid'
  ) {
    return {
      kind: 'unresolved-tie',
      cause: 'value-mid-band',
      partial: breakdown,
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    }
  }
  return {
    kind: 'scored',
    ...breakdown,
    matcherVersion: MATCHER_CONFIG.matcherVersion,
  }
}

function firstDecisionSample(result: DecisionReplayResult): ReplaySample | undefined {
  return result.samples.find(sample => sample.outcome.kind === 'decision')
}

// The escalation predicate uses this, so the tie vocabulary has one owner.
export function scoreReplaySample(
  sidecar: CassetteSidecarLeg,
  sample: ReplaySample,
  context: ScoreDecisionContext = {
    priorIdentities: 'leaf-no-history',
    screenStateHash: '',
  },
): ScoreDecisionOutcome {
  if (sample.outcome.kind === 'planner-failure') {
    return {
      kind: 'miss-by-failure',
      reason: sample.outcome.reason,
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    }
  }
  if (sample.outcome.kind === 'unservable-divergence') {
    return {
      kind: 'miss-by-failure',
      reason: `unservable-divergence:${sample.outcome.tool}`,
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    }
  }
  if (sample.outcome.kind === 'harness-error') {
    return {
      kind: 'never-scored',
      reason: 'all-samples-harness-error',
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    }
  }

  const breakdown = buildBreakdown(sidecar, sample, context)
  if (breakdown === undefined) {
    return {
      kind: 'never-scored',
      reason: 'modal-representative-missing',
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    }
  }
  return scoreBreakdown(breakdown)
}

// Agreement identities carry no geometry or raw value, so a real modal Action is scored instead.
export function representativeDecisionSample(
  result: DecisionReplayResult,
): ReplaySample | undefined {
  const modal = result.agreement.modal
  if (modal === undefined) return firstDecisionSample(result)
  const modalKey = decisionIdentityKey(modal.identity)
  return result.samples.find(
    sample =>
      sample.outcome.kind === 'decision' &&
      decisionIdentityKey(sample.outcome.identity) === modalKey,
  )
}

export function scoreDecision(
  sidecar: CassetteSidecarLeg,
  result: DecisionReplayResult,
  context: ScoreDecisionContext = {
    priorIdentities: 'leaf-no-history',
    screenStateHash: '',
  },
): ScoreDecisionOutcome {
  const nonHarnessSamples = result.samples.filter(
    sample => sample.outcome.kind !== 'harness-error',
  )
  if (nonHarnessSamples.length === 0) {
    return {
      kind: 'never-scored',
      reason: 'all-samples-harness-error',
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    }
  }

  if (result.agreement.noConsensus) {
    const partial = firstDecisionSample(result)
    const breakdown = partial === undefined ? undefined : buildBreakdown(sidecar, partial, context)
    return {
      kind: 'unresolved-tie',
      cause: 'no-consensus',
      ...(breakdown === undefined ? {} : { partial: breakdown }),
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    }
  }

  const selected =
    result.agreement.modal === undefined
      ? nonHarnessSamples[0]
      : representativeDecisionSample(result)
  if (selected === undefined) {
    return {
      kind: 'never-scored',
      reason: 'modal-representative-missing',
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    }
  }

  return scoreReplaySample(sidecar, selected, context)
}

function decisionEntry(
  decisionOrdinal: number,
  result: DecisionReplayResult,
  sidecar: CassetteSidecarLeg,
  context: ScoreDecisionContext,
  stepIndex?: number,
): DecisionScoreEntry {
  const outcome = scoreDecision(sidecar, result, context)
  if (outcome.kind === 'never-scored') {
    return {
      kind: 'never-scored',
      decisionOrdinal,
      ...(stepIndex === undefined ? {} : { stepIndex }),
      reason: outcome.reason,
      matcherVersion: outcome.matcherVersion,
    }
  }
  return {
    kind: 'decision',
    decisionOrdinal,
    ...(stepIndex === undefined ? {} : { stepIndex }),
    score: outcome,
  }
}

// The one full-match rule; an `equivalent` judge stamp upgrades only the stamped axis.
export function isDecisionFullMatch(score: DecisionScore): boolean {
  if (score.kind !== 'scored') return false
  const { axes, loop, judgeSettled } = score
  const equivalentAxis =
    judgeSettled?.resolution === 'equivalent' ? judgeSettled.axis : undefined
  const identityFull =
    axes.elementIdentity.kind === 'scored' &&
    (axes.elementIdentity.level === 'full' || equivalentAxis === 'element-identity')
  const valueFull =
    axes.value.kind === 'not-applicable' ||
    (axes.value.kind === 'scored' &&
      (axes.value.band === 'full' || equivalentAxis === 'value'))
  return (
    axes.opClass.kind === 'match' &&
    identityFull &&
    valueFull &&
    loop.kind !== 'flagged'
  )
}

function isSettledFull(entry: DecisionScoreEntry): boolean {
  return entry.kind === 'decision' && isDecisionFullMatch(entry.score)
}

function missingDecisionEntry(
  stepIndex: number,
  decisionOrdinal: number,
): DecisionScoreEntry {
  return {
    kind: 'never-scored',
    stepIndex,
    decisionOrdinal,
    reason: 'missing-cassette-decision',
    matcherVersion: MATCHER_CONFIG.matcherVersion,
  }
}

function scoreProcedure(
  cassette: ProcedureCassette,
  outcome: Extract<ReplayCassetteOutcome, { granularity: 'procedure' }>,
): CassetteScore {
  const history = collectProcedurePriorIdentities(cassette)
  const entries: DecisionScoreEntry[] = outcome.steps.map(step => {
    if (step.kind === 'skipped') {
      return {
        kind: 'skipped',
        stepIndex: step.stepIndex,
        ...(step.decisionOrdinal === undefined
          ? {}
          : { decisionOrdinal: step.decisionOrdinal }),
        reason: step.reason,
      }
    }

    const record = cassette.steps.find(
      candidate =>
        candidate.kind === 'decision' &&
        candidate.stepIndex === step.stepIndex &&
        candidate.decisionOrdinal === step.decisionOrdinal,
    )
    if (record === undefined || record.kind !== 'decision') {
      return missingDecisionEntry(step.stepIndex, step.decisionOrdinal)
    }
    const priorIdentities: readonly ProcedurePriorIdentity[] = history.filter(
      prior => prior.stepIndex < step.stepIndex,
    )
    return decisionEntry(
      step.decisionOrdinal,
      step.result,
      record.record.sidecar,
      {
        priorIdentities,
        screenStateHash: record.record.receipt.screenStateHash,
        stateMetadata: record.record.input.stateBefore.metadata,
      },
      step.stepIndex,
    )
  })

  const decisionEntries = entries.filter(entry => entry.kind !== 'skipped')
  const matched = decisionEntries.filter(isSettledFull).length
  const stepsMatchedFraction =
    decisionEntries.length === 0 ? 0 : matched / decisionEntries.length
  const firstDivergent = decisionEntries.find(entry => !isSettledFull(entry))
  return {
    kind: 'procedure',
    cassetteId: cassette.id,
    entries,
    summary: {
      stepsMatchedFraction,
      ...(firstDivergent === undefined || firstDivergent.stepIndex === undefined
        ? {}
        : { firstDivergentStepIndex: firstDivergent.stepIndex }),
      endState: outcome.endState,
    },
  }
}

function isReplayRefusal(outcome: ReplayCassetteOutcome): outcome is ReplayRefusal {
  return 'kind' in outcome && outcome.kind === 'integrity-refusal'
}

/** Score a replay result against its exact cassette without collapsing any axis to a scalar. */
export function scoreCassetteReplay(
  cassette: Cassette,
  outcome: ReplayCassetteOutcome,
): CassetteScore {
  if (isReplayRefusal(outcome)) {
    return { kind: 'replay-refusal', cassetteId: outcome.cassetteId, refusal: outcome }
  }

  if (cassette.granularity === 'leaf') {
    if (outcome.granularity !== 'leaf') {
      return {
        kind: 'shape-mismatch',
        cassetteId: cassette.id,
        reason: 'granularity-mismatch',
        matcherVersion: MATCHER_CONFIG.matcherVersion,
      }
    }
    return {
      kind: 'leaf',
      cassetteId: cassette.id,
      entry: decisionEntry(
        cassette.decisionOrdinal,
        outcome,
        cassette.sidecar,
        {
          priorIdentities: 'leaf-no-history',
          screenStateHash: cassette.receipt.screenStateHash,
          stateMetadata: cassette.input.stateBefore.metadata,
        },
      ),
    }
  }

  if (outcome.granularity !== 'procedure') {
    return {
      kind: 'shape-mismatch',
      cassetteId: cassette.id,
      reason: 'granularity-mismatch',
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    }
  }
  return scoreProcedure(cassette, outcome)
}
