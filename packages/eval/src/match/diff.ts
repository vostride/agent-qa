import type { ElementInfo, ModelIdentity } from '@vostride/agent-qa-schema'

import type { CassetteSidecarLeg } from '../cassette/sidecar-leg'
import {
  computeDecisionIdentity,
} from '../replay/identity'
import type { DecisionIdentity } from '../replay/identity'
import type { ReplayDrift } from '../replay/drift'
import type {
  DecisionReplayResult,
  ReplayAgreement,
} from '../replay/result'
import {
  representativeDecisionSample,
} from './score'
import type {
  DecisionAxes,
  DecisionPartialBreakdown,
  DecisionScore,
  TieCause,
} from './score'
import type { LoopVerdict } from './loop'

/** Replay attribution copied into every D-16 decision diff. */
export interface DecisionDiffReplayContext {
  promptDrift: ReplayDrift
  agreement: ReplayAgreement
  recordedModel?: ModelIdentity
  replayedModel: { provider: string; modelId: string }
}

interface DecisionDiffBase {
  /** Cassette owning this decision. */
  cassetteId: string
  /** Procedure step when this is not a leaf decision. */
  stepIndex?: number
  /** Decision position within the recorded step. */
  decisionOrdinal: number
  /** Gold identity resolved against the exact recorded element list; raw refs never survive. */
  goldIdentity: DecisionIdentity
  /** Representative replay identity; absent when no decision was produced. */
  candidateIdentity?: DecisionIdentity
  /** Replay drift, agreement, and model attribution for this decision. */
  replay: DecisionDiffReplayContext
  /** Matcher constitution that minted the verdict. */
  matcherVersion: number
}

/** Pure JSON D-16 per-decision diff; rendering belongs exclusively to Phase 372. */
export type DecisionDiff =
  | (DecisionDiffBase & {
      kind: 'scored'
      tierReached: 1 | 2 | 3
      axes: DecisionAxes
      loop: LoopVerdict
    })
  | (DecisionDiffBase & {
      kind: 'miss-by-failure'
      reason: string
    })
  | (DecisionDiffBase & {
      kind: 'unresolved-tie'
      cause: TieCause
      partial?: DecisionPartialBreakdown
    })

/** Input to the pure D-16 projection. */
export interface BuildDecisionDiffInput {
  cassetteId: string
  stepIndex?: number
  decisionOrdinal: number
  sidecar: CassetteSidecarLeg
  elements: readonly ElementInfo[]
  result: DecisionReplayResult
  score: DecisionScore
}

function candidateIdentity(
  result: DecisionReplayResult,
  score: DecisionScore,
): DecisionIdentity | undefined {
  if (score.kind === 'miss-by-failure') return undefined
  if (score.kind === 'unresolved-tie' && score.cause === 'no-consensus') {
    const first = result.samples.find(sample => sample.outcome.kind === 'decision')
    return first?.outcome.kind === 'decision' ? first.outcome.identity : undefined
  }
  const representative = representativeDecisionSample(result)
  return representative?.outcome.kind === 'decision'
    ? representative.outcome.identity
    : undefined
}

/** Build one attribution-grade plain-data diff with typed absence and no string renderer. */
export function buildDecisionDiff(input: BuildDecisionDiffInput): DecisionDiff {
  const goldIdentity = computeDecisionIdentity(
    input.sidecar.goldAction,
    input.elements,
  )
  const candidate = candidateIdentity(input.result, input.score)
  const replay: DecisionDiffReplayContext = {
    promptDrift: input.result.promptDrift,
    agreement: input.result.agreement,
    ...(input.result.recordedModel === undefined
      ? {}
      : { recordedModel: input.result.recordedModel }),
    replayedModel: input.result.replayedModel,
  }
  const base: DecisionDiffBase = {
    cassetteId: input.cassetteId,
    ...(input.stepIndex === undefined ? {} : { stepIndex: input.stepIndex }),
    decisionOrdinal: input.decisionOrdinal,
    goldIdentity,
    ...(candidate === undefined ? {} : { candidateIdentity: candidate }),
    replay,
    matcherVersion: input.score.matcherVersion,
  }

  if (input.score.kind === 'miss-by-failure') {
    return {
      ...base,
      kind: 'miss-by-failure',
      reason: input.score.reason,
    }
  }
  if (input.score.kind === 'unresolved-tie') {
    return {
      ...base,
      kind: 'unresolved-tie',
      cause: input.score.cause,
      ...(input.score.partial === undefined ? {} : { partial: input.score.partial }),
    }
  }
  return {
    ...base,
    kind: 'scored',
    tierReached: input.score.tierReached,
    axes: input.score.axes,
    loop: input.score.loop,
  }
}
