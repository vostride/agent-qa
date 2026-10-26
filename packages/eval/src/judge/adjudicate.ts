// D-12/D-14 eligibility assessment + the pure async adjudication orchestrator (370-05).
// ALL judgment law lives here, pure-side: per-tie dispatch on TieCause, the D-08 two
// order-swapped port calls with the swap-agreement rule, the D-09 minimum-category
// threshold, D-03 bounded pairwise no-consensus, and the typed stamping of every outcome.
// The port answers one order-tagged call; this module decides. The orchestrator is async
// only because the port is — no clock reads, no host IO, no randomness; awaits are
// sequential and the call volume is bounded by construction.
//
// Never-self-judge is a pure, total, two-sided check: disjointness is assessed against
// BOTH the replayed planner's family (the direct self-preference circuit) and the recorded
// model's family when one is supplied (the gold-familiarity bias). D-12 posture: validated
// ONCE at composition time by the caller, soft-but-loud — the refusal is data carried on
// every tie's stamp, never a thrown error, and the batch always proceeds deterministically.
// D-13 ratification note: the ratified "provider -> family" phrasing is implemented as
// model-id token matching because a ModelProfile provider value is a transport id
// ('openai-compatible' serves Llama, Qwen, and DeepSeek alike) and can never establish
// family; unknown resolves undefined and is treated as same-family, therefore forbidden —
// never a guess.
// Owner override of D-10 (2026-07-12): an EXPLICIT allowSameFamily opt-in lifts ONLY the
// known-equal-family refusal arms (judge===replayed; recorded===judge) and stamps the
// eligible result — and thence the D-16 identity block — with familyOverride:
// 'same-family-allowed' so the self-preference bias condition is disclosed on every scored
// entry. The DEFAULT is unchanged (opt-in absent/false refuses exactly as ratified), and
// the unknown-family arms are NEVER relaxed: unknown ⇒ forbidden, never a guess.

import type {
  Cassette,
  LeafCassette,
  ProcedureCassette,
} from '../cassette/cassette'
import type {
  CassetteSidecarLeg,
  GoldAnchorDescriptor,
} from '../cassette/sidecar-leg'
import { projectActionGoldValue } from '../extract/sidecar-leg'
import { collectProcedurePriorIdentities } from '../match/loop'
import {
  isDecisionFullMatch,
  representativeDecisionSample,
  scoreReplaySample,
} from '../match/score'
import type {
  CassetteScore,
  DecisionPartialBreakdown,
  DecisionScore,
  DecisionScoreEntry,
  JudgeAbstentionCause,
  JudgeConfidence,
  JudgeErrorReason,
  JudgeIdentityBlock,
  JudgeFamilyDisclosure,
  JudgeMemberOutcome,
  JudgePairwiseOutcome,
  JudgeOutcome,
  JudgeSettled,
  JudgeTokenUsage,
  ProcedureScoreSummary,
  ScoreDecisionContext,
} from '../match/score'
import { decisionIdentityKey } from '../replay/identity'
import type {
  DecisionReplayResult,
  LeafReplayResult,
  ProcedureReplayResult,
  ReplayCassetteOutcome,
  ReplaySample,
  ReplaySampleOutcome,
} from '../replay/result'
import { JUDGE_CONFIG } from './config'
import { displayJudgeFamilies, judgeFamiliesIntersect, resolveJudgeFamilies } from './family'
import { createPanelIdentity, poolPanel } from './panel'
import type { JudgePanelPort } from './panel'
import type { JudgeCallResult, JudgePort } from './port'
import { buildJudgePrompt } from './prompt'
import type {
  JudgeElementEvidence,
  JudgeQuestion,
  JudgeTieEvidence,
} from './prompt'

/**
 * Closed eligibility union. The no-eligible-judge variant carries every ATTEMPTED family
 * resolution as plain strings (undefined entries omitted, typed-absent) so the D-12 refusal
 * is loud enough to reconstruct exactly why the judge was refused.
 */
export type JudgeEligibility =
  | {
      eligible: true
      judgeModelId: string
      judgeFamily: string
      panelSize?: number
      members?: JudgeIdentityBlock['members']
      /** Present ONLY when the allowSameFamily opt-in lifted a refusal that would have fired. */
      familyOverride?: 'same-family-allowed'
    }
  | { eligible: false; reason: 'no-judge-configured' }
  | {
      eligible: false
      reason: 'no-eligible-judge'
      families: JudgeFamilyDisclosure
    }

/**
 * Assess judge eligibility once for a scoring run. Pure and total: never throws for any
 * input combination. Forbidden when the judge family is unknown, the replayed family is
 * unknown, the two are equal, or a supplied recorded model resolves unknown or equal to the
 * judge family. An absent recorded model skips that side entirely (D-14 "when resolvable").
 *
 * allowSameFamily (owner override of D-10, 2026-07-12): an EXPLICIT default-off opt-in that
 * bypasses ONLY the known-equal-family arms; when it lifts a refusal that would otherwise
 * have fired, the eligible result carries familyOverride: 'same-family-allowed' so the
 * disclosure rides the D-16 identity block. The unknown arms (judge, replayed, or a supplied
 * recorded model resolving undefined) remain forbidden regardless — never a guess.
 */
export function assessJudgeEligibility(input: {
  judgeModelId?: string
  replayedModelId: string
  recordedModelId?: string
  allowSameFamily?: boolean
}): JudgeEligibility {
  const { judgeModelId, replayedModelId, recordedModelId, allowSameFamily } = input
  if (judgeModelId === undefined) {
    return { eligible: false, reason: 'no-judge-configured' }
  }

  const judgeSet = resolveJudgeFamilies(judgeModelId)
  const replayedSet = resolveJudgeFamilies(replayedModelId)
  const recordedSet = recordedModelId === undefined ? undefined : resolveJudgeFamilies(recordedModelId)
  const judge = displayJudgeFamilies(judgeSet)
  const replayed = displayJudgeFamilies(replayedSet)
  const recorded =
    recordedSet === undefined ? undefined : displayJudgeFamilies(recordedSet)

  const refusal = (): JudgeEligibility => ({
    eligible: false,
    reason: 'no-eligible-judge',
    families: {
      ...(judge === undefined ? {} : { judge }),
      ...(replayed === undefined ? {} : { replayed }),
      ...(recorded === undefined ? {} : { recorded }),
    },
  })

  // Unknown arms: NEVER relaxed by the opt-in (unknown ⇒ forbidden, never a guess).
  if (
    judge === undefined ||
    replayed === undefined ||
    (recordedModelId !== undefined && recorded === undefined)
  ) {
    return refusal()
  }

  // Known-equal arms: the ONLY refusals the explicit opt-in may lift.
  const knownSameFamily =
    judgeFamiliesIntersect(judgeSet, replayedSet) ||
    (recordedSet !== undefined && judgeFamiliesIntersect(recordedSet, judgeSet))
  if (knownSameFamily && allowSameFamily !== true) {
    return refusal()
  }

  return {
    eligible: true,
    judgeModelId,
    judgeFamily: judge,
    // The marker appears ONLY when the override changed the outcome.
    ...(knownSameFamily ? { familyOverride: 'same-family-allowed' as const } : {}),
  }
}

/** The adjudicated score plus the D-16 identity block when the eligible path ran. */
export interface AdjudicationResult {
  score: CassetteScore
  judge?: JudgeIdentityBlock
}

type UnresolvedTie = Extract<DecisionScore, { kind: 'unresolved-tie' }>
type DecisionSample = ReplaySample & {
  outcome: Extract<ReplaySampleOutcome, { kind: 'decision' }>
}

const CONFIDENCE_RANK: Record<JudgeConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
}

/** Mutable per-decision call accounting; token fields stay absent until a call reports them. */
export interface UsageAggregator {
  calls: number
  inputTokens?: number
  outputTokens?: number
  members?: JudgeMemberOutcome[]
}

function snapshotUsage(usage: UsageAggregator): JudgeTokenUsage | undefined {
  if (usage.calls === 0) return undefined
  return {
    calls: usage.calls,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  }
}

function isDecisionSample(sample: ReplaySample): sample is DecisionSample {
  return sample.outcome.kind === 'decision'
}

function anchorEvidence(anchor: GoldAnchorDescriptor): JudgeElementEvidence {
  return {
    role: anchor.role,
    nameNormalized: anchor.nameNormalized,
    ordinal: anchor.ordinal,
  }
}

function candidateTarget(
  sample: ReplaySample | undefined,
): JudgeElementEvidence | undefined {
  if (sample === undefined || sample.outcome.kind !== 'decision') return undefined
  return sample.outcome.identity.target
}

function elementQuestion(
  sidecar: CassetteSidecarLeg,
  sample: ReplaySample | undefined,
): JudgeQuestion | undefined {
  const candidate = candidateTarget(sample)
  if (sidecar.goldAnchor === undefined || candidate === undefined) return undefined
  return {
    kind: 'element-equivalence',
    gold: anchorEvidence(sidecar.goldAnchor),
    candidate,
  }
}

function valueQuestion(
  sidecar: CassetteSidecarLeg,
  sample: ReplaySample | undefined,
): JudgeQuestion | undefined {
  if (
    sidecar.goldValue === undefined ||
    sample === undefined ||
    sample.outcome.kind !== 'decision'
  ) {
    return undefined
  }
  const candidateValue = projectActionGoldValue(sample.outcome.action)
  if (candidateValue === undefined) return undefined
  return {
    kind: 'value-equivalence',
    goldValue: sidecar.goldValue,
    candidateValue,
  }
}

// --- the ONE pairwise judgment procedure (shared by all tie causes) ----------

type PairwiseOutcome = JudgePairwiseOutcome
type AdjudicationPort = JudgePort | JudgePanelPort

async function callJudge(
  port: JudgePort,
  evidence: JudgeTieEvidence,
  order: 'ab' | 'ba',
  usage: UsageAggregator,
): Promise<JudgeCallResult> {
  const payload = buildJudgePrompt(evidence, order)
  usage.calls += 1
  let result: JudgeCallResult
  try {
    result = await port.call(payload)
  } catch {
    // A failing physical call must not skip its swap or disclose arbitrary transport text.
    return { kind: 'call-error', reason: 'provider-error', detail: 'judge provider call failed' }
  }
  if (result.kind === 'verdict' && result.usage !== undefined) {
    if (result.usage.inputTokens !== undefined) {
      usage.inputTokens = (usage.inputTokens ?? 0) + result.usage.inputTokens
    }
    if (result.usage.outputTokens !== undefined) {
      usage.outputTokens = (usage.outputTokens ?? 0) + result.usage.outputTokens
    }
  }
  return result
}

/**
 * One pairwise judgment: two physically order-swapped independent calls (D-08), then the
 * pure classification — infra error, explicit unsure, swap disagreement, minimum-category
 * threshold on the LOWER of the two confidences (D-09), else the swap-surviving verdict.
 */
export async function judgePairwise(
  port: JudgePort,
  evidence: JudgeTieEvidence,
  usage: UsageAggregator = { calls: 0 },
): Promise<PairwiseOutcome> {
  const first = await callJudge(port, evidence, 'ab', usage)
  const second = await callJudge(port, evidence, 'ba', usage)
  if (first.kind === 'call-error') {
    return { kind: 'error', reason: first.reason, detail: first.detail }
  }
  if (second.kind === 'call-error') {
    return { kind: 'error', reason: second.reason, detail: second.detail }
  }
  if (first.verdict === 'unsure' || second.verdict === 'unsure') {
    return { kind: 'abstained', cause: 'unsure-verdict' }
  }
  if (first.verdict !== second.verdict) {
    return { kind: 'abstained', cause: 'swap-disagreement' }
  }
  const confidence =
    CONFIDENCE_RANK[first.confidence] <= CONFIDENCE_RANK[second.confidence]
      ? first.confidence
      : second.confidence
  if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[JUDGE_CONFIG.confidenceThreshold]) {
    return { kind: 'abstained', cause: 'below-threshold', confidence }
  }
  return { kind: 'settled', resolution: first.verdict, confidence }
}

/** Pool the SAME question; an empty port has no comparison, a singleton uses the direct law. */
export async function adjudicatePanelComparison(port: AdjudicationPort, evidence: JudgeTieEvidence, usage: UsageAggregator = { calls: 0 }): Promise<PairwiseOutcome> {
  if (!('members' in port)) return judgePairwise(port, evidence, usage)
  if (port.members.length === 0) throw new TypeError('Cannot adjudicate a comparison without a judge')
  if (port.members.length === 1) return judgePairwise(port.members[0]!, evidence, usage)
  const members: JudgeMemberOutcome[] = []
  for (const member of port.members) {
    const memberUsage: UsageAggregator = { calls: 0 }
    const outcome = await judgePairwise(member, evidence, memberUsage)
    usage.calls += memberUsage.calls
    if (memberUsage.inputTokens !== undefined) usage.inputTokens = (usage.inputTokens ?? 0) + memberUsage.inputTokens
    if (memberUsage.outputTokens !== undefined) usage.outputTokens = (usage.outputTokens ?? 0) + memberUsage.outputTokens
    const snapshot = snapshotUsage(memberUsage)
    members.push({ judgeModelId: member.judgeModelId,
      judgeFamily: displayJudgeFamilies(resolveJudgeFamilies(member.judgeModelId)) ?? '', outcome,
      ...(snapshot === undefined ? {} : { usage: snapshot }) })
  }
  // Execution follows the declaration; stored comparison groups follow canonical identity.
  const identity = createPanelIdentity(members.map(member => member.judgeModelId))
  const canonicalMembers = identity.members!.map(expected => members.find(member => member.judgeModelId === expected.judgeModelId)!)
  usage.members = [...(usage.members ?? []), ...canonicalMembers]
  return poolPanel(members)
}

// --- typed stamping ----------------------------------------------------------

function settleScore(
  tie: UnresolvedTie,
  breakdown: DecisionPartialBreakdown,
  axis: JudgeSettled['axis'],
  resolution: JudgeSettled['resolution'],
  confidence: JudgeConfidence,
  port: AdjudicationPort,
  usage: UsageAggregator,
): DecisionScore {
  const snapshot = snapshotUsage(usage)
  return {
    kind: 'scored',
    ...breakdown,
    matcherVersion: tie.matcherVersion,
    judgeSettled: {
      axis,
      resolution,
      cause: tie.cause,
      judgeId: port.judgeModelId,
      judgeVersion: JUDGE_CONFIG.judgeVersion,
      confidence,
      ...(snapshot === undefined ? {} : { usage: snapshot }),
      ...(usage.members === undefined ? {} : { members: usage.members }),
    },
  }
}

function stampAbstention(
  tie: UnresolvedTie,
  port: AdjudicationPort,
  usage: UsageAggregator,
  cause: JudgeAbstentionCause,
  confidence?: JudgeConfidence,
): DecisionScore {
  const snapshot = snapshotUsage(usage)
  return {
    ...tie,
    judgeOutcome: {
      kind: 'abstained',
      cause,
      ...(confidence === undefined ? {} : { confidence }),
      judgeId: port.judgeModelId,
      judgeVersion: JUDGE_CONFIG.judgeVersion,
      ...(snapshot === undefined ? {} : { usage: snapshot }),
      ...(usage.members === undefined ? {} : { members: usage.members }),
    },
  }
}

function stampError(
  tie: UnresolvedTie,
  port: AdjudicationPort,
  usage: UsageAggregator,
  reason: JudgeErrorReason,
  detail: string,
): DecisionScore {
  const snapshot = snapshotUsage(usage)
  return {
    ...tie,
    judgeOutcome: {
      kind: 'judge-error',
      reason,
      detail,
      judgeId: port.judgeModelId,
      judgeVersion: JUDGE_CONFIG.judgeVersion,
      ...(snapshot === undefined ? {} : { usage: snapshot }),
      ...(usage.members === undefined ? {} : { members: usage.members }),
    },
  }
}

function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function extractBreakdown(
  score: Extract<DecisionScore, { kind: 'scored' }>,
): DecisionPartialBreakdown {
  return {
    axes: score.axes,
    loop: score.loop,
    tierReached: score.tierReached,
  }
}

// --- per-tie adjudication ------------------------------------------------------

interface TieContext {
  sidecar: CassetteSidecarLeg
  stepText: string
  result: DecisionReplayResult
  sampleContext: ScoreDecisionContext
}

function resolvePairwise(
  pairwise: PairwiseOutcome,
  tie: UnresolvedTie,
  breakdown: DecisionPartialBreakdown,
  axis: JudgeSettled['axis'],
  port: AdjudicationPort,
  usage: UsageAggregator,
): DecisionScore {
  switch (pairwise.kind) {
    case 'settled':
      return settleScore(
        tie,
        breakdown,
        axis,
        pairwise.resolution,
        pairwise.confidence,
        port,
        usage,
      )
    case 'abstained':
      return stampAbstention(tie, port, usage, pairwise.cause, pairwise.confidence)
    case 'error':
      return stampError(tie, port, usage, pairwise.reason, pairwise.detail)
  }
}

/**
 * D-03 bounded pairwise no-consensus: distinct candidates grouped by the ONE decision
 * identity key, judged against gold in first-appearance order. The first swap-surviving
 * equivalent settles on that sample's own deterministic breakdown; all confidently
 * different is a judged miss; mixed outcomes abstain carrying the first non-different
 * pairwise cause; overflow abstains with zero port calls.
 */
async function adjudicateNoConsensus(
  tie: UnresolvedTie,
  context: TieContext,
  port: AdjudicationPort,
  usage: UsageAggregator,
): Promise<DecisionScore> {
  const seen = new Set<string>()
  const distinct: DecisionSample[] = []
  for (const sample of context.result.samples.filter(isDecisionSample)) {
    const key = decisionIdentityKey(sample.outcome.identity)
    if (seen.has(key)) continue
    seen.add(key)
    distinct.push(sample)
  }
  if (distinct.length === 0) {
    return stampAbstention(tie, port, usage, 'missing-evidence')
  }
  if (distinct.length > JUDGE_CONFIG.maxDistinctCandidates) {
    return stampAbstention(tie, port, usage, 'candidate-overflow')
  }
  const gold = context.sidecar.goldAnchor
  if (gold === undefined) {
    return stampAbstention(tie, port, usage, 'missing-evidence')
  }

  const nonSurviving: PairwiseOutcome[] = []
  for (const sample of distinct) {
    const candidate = sample.outcome.identity.target
    if (candidate === undefined) {
      nonSurviving.push({ kind: 'abstained', cause: 'missing-evidence' })
      continue
    }
    const evidence: JudgeTieEvidence = {
      stepText: context.stepText,
      question: {
        kind: 'element-equivalence',
        gold: anchorEvidence(gold),
        candidate,
      },
    }
    const pairwise = await adjudicatePanelComparison(port, evidence, usage)
    if (pairwise.kind === 'error') {
      return stampError(tie, port, usage, pairwise.reason, pairwise.detail)
    }
    if (pairwise.kind === 'settled' && pairwise.resolution === 'equivalent') {
      const candidateScore = scoreReplaySample(
        context.sidecar,
        sample,
        context.sampleContext,
      )
      if (candidateScore.kind !== 'scored') {
        return stampAbstention(tie, port, usage, 'residual-tie', pairwise.confidence)
      }
      return settleScore(
        tie,
        extractBreakdown(candidateScore),
        'element-identity',
        'equivalent',
        pairwise.confidence,
        port,
        usage,
      )
    }
    nonSurviving.push(pairwise)
  }

  const firstNonDifferent = nonSurviving.find(
    pairwise => !(pairwise.kind === 'settled' && pairwise.resolution === 'different'),
  )
  if (firstNonDifferent === undefined) {
    // Every distinct candidate is confidently different from gold: a judged miss minted
    // on the first candidate's own deterministic breakdown (D-03).
    const settledDifferent = nonSurviving.find(
      (pairwise): pairwise is Extract<PairwiseOutcome, { kind: 'settled' }> =>
        pairwise.kind === 'settled',
    )
    const firstScore = scoreReplaySample(
      context.sidecar,
      distinct[0],
      context.sampleContext,
    )
    const breakdown =
      firstScore.kind === 'scored'
        ? extractBreakdown(firstScore)
        : firstScore.kind === 'unresolved-tie'
          ? firstScore.partial
          : undefined
    if (breakdown === undefined || settledDifferent === undefined) {
      return stampAbstention(tie, port, usage, 'missing-evidence')
    }
    return settleScore(
      tie,
      breakdown,
      'element-identity',
      'different',
      settledDifferent.confidence,
      port,
      usage,
    )
  }
  if (firstNonDifferent.kind === 'abstained') {
    return stampAbstention(
      tie,
      port,
      usage,
      firstNonDifferent.cause,
      firstNonDifferent.confidence,
    )
  }
  return stampAbstention(tie, port, usage, 'residual-tie')
}

async function dispatchTie(
  tie: UnresolvedTie,
  context: TieContext,
  port: AdjudicationPort,
  usage: UsageAggregator,
): Promise<DecisionScore> {
  if (tie.cause === 'no-consensus') {
    return adjudicateNoConsensus(tie, context, port, usage)
  }
  const sample = representativeDecisionSample(context.result)
  const question =
    tie.cause === 'partial-identity'
      ? elementQuestion(context.sidecar, sample)
      : valueQuestion(context.sidecar, sample)
  if (tie.partial === undefined || question === undefined) {
    return stampAbstention(tie, port, usage, 'missing-evidence')
  }
  const evidence: JudgeTieEvidence = { stepText: context.stepText, question }
  const pairwise = await adjudicatePanelComparison(port, evidence, usage)
  const axis = tie.cause === 'partial-identity' ? 'element-identity' : 'value'
  return resolvePairwise(pairwise, tie, tie.partial, axis, port, usage)
}

/**
 * Adjudicate one tie with per-decision severity: an unexpected throw anywhere inside the
 * dispatch mints judge-error on this tie alone and the surrounding walk continues (D-11,
 * the 368 batch-survival law).
 */
async function adjudicateTie(
  tie: UnresolvedTie,
  context: TieContext,
  port: AdjudicationPort,
): Promise<DecisionScore> {
  const usage: UsageAggregator = { calls: 0 }
  try {
    return await dispatchTie(tie, context, port, usage)
  } catch (error) {
    return stampError(tie, port, usage, 'provider-error', describeThrown(error))
  }
}

// --- the unconditional not-invoked stamping path ------------------------------

function notInvokedOutcome(eligibility: JudgeEligibility): JudgeOutcome {
  if (eligibility.eligible === false && eligibility.reason === 'no-eligible-judge') {
    return {
      kind: 'not-invoked',
      reason: 'no-eligible-judge',
      families: eligibility.families,
    }
  }
  return { kind: 'not-invoked', reason: 'no-judge-configured' }
}

function stampEntryNotInvoked(
  entry: DecisionScoreEntry,
  outcome: JudgeOutcome,
): DecisionScoreEntry {
  if (entry.kind !== 'decision' || entry.score.kind !== 'unresolved-tie') return entry
  return { ...entry, score: { ...entry.score, judgeOutcome: outcome } }
}

function stampNotInvoked(
  score: Extract<CassetteScore, { kind: 'leaf' | 'procedure' }>,
  outcome: JudgeOutcome,
): CassetteScore {
  if (score.kind === 'leaf') {
    const entry = stampEntryNotInvoked(score.entry, outcome)
    return entry === score.entry ? score : { ...score, entry }
  }
  const entries = score.entries.map(entry => stampEntryNotInvoked(entry, outcome))
  const changed = entries.some((entry, index) => entry !== score.entries[index])
  return changed ? { ...score, entries } : score
}

// --- the eligible walk ---------------------------------------------------------

function leafResult(outcome: ReplayCassetteOutcome): LeafReplayResult | undefined {
  return 'granularity' in outcome && outcome.granularity === 'leaf'
    ? outcome
    : undefined
}

function procedureResult(
  outcome: ReplayCassetteOutcome,
): ProcedureReplayResult | undefined {
  return 'granularity' in outcome && outcome.granularity === 'procedure'
    ? outcome
    : undefined
}

function recomputeSummary(
  entries: readonly DecisionScoreEntry[],
  endState: ProcedureScoreSummary['endState'],
): ProcedureScoreSummary {
  const decisionEntries = entries.filter(entry => entry.kind !== 'skipped')
  const isFull = (entry: DecisionScoreEntry): boolean =>
    entry.kind === 'decision' && isDecisionFullMatch(entry.score)
  const matched = decisionEntries.filter(isFull).length
  const stepsMatchedFraction =
    decisionEntries.length === 0 ? 0 : matched / decisionEntries.length
  const firstDivergent = decisionEntries.find(entry => !isFull(entry))
  return {
    stepsMatchedFraction,
    ...(firstDivergent === undefined || firstDivergent.stepIndex === undefined
      ? {}
      : { firstDivergentStepIndex: firstDivergent.stepIndex }),
    endState,
  }
}

async function adjudicateLeaf(
  cassette: LeafCassette,
  outcome: ReplayCassetteOutcome,
  score: Extract<CassetteScore, { kind: 'leaf' }>,
  port: AdjudicationPort,
): Promise<CassetteScore> {
  const entry = score.entry
  if (entry.kind !== 'decision' || entry.score.kind !== 'unresolved-tie') return score
  const result = leafResult(outcome)
  if (result === undefined) {
    return {
      ...score,
      entry: {
        ...entry,
        score: stampAbstention(entry.score, port, { calls: 0 }, 'missing-evidence'),
      },
    }
  }
  const adjudicated = await adjudicateTie(
    entry.score,
    {
      sidecar: cassette.sidecar,
      stepText: cassette.input.stepText,
      result,
      sampleContext: {
        priorIdentities: 'leaf-no-history',
        screenStateHash: cassette.receipt.screenStateHash,
        stateMetadata: cassette.input.stateBefore.metadata,
      },
    },
    port,
  )
  return { ...score, entry: { ...entry, score: adjudicated } }
}

async function adjudicateProcedure(
  cassette: ProcedureCassette,
  outcome: ReplayCassetteOutcome,
  score: Extract<CassetteScore, { kind: 'procedure' }>,
  port: AdjudicationPort,
): Promise<CassetteScore> {
  const result = procedureResult(outcome)
  const history = collectProcedurePriorIdentities(cassette)
  const entries: DecisionScoreEntry[] = []
  let changed = false

  for (const entry of score.entries) {
    if (entry.kind !== 'decision' || entry.score.kind !== 'unresolved-tie') {
      entries.push(entry)
      continue
    }
    const tie = entry.score
    const step =
      result === undefined || entry.stepIndex === undefined
        ? undefined
        : result.steps.find(
            candidate =>
              candidate.kind === 'decision' &&
              candidate.stepIndex === entry.stepIndex &&
              candidate.decisionOrdinal === entry.decisionOrdinal,
          )
    const record =
      entry.stepIndex === undefined
        ? undefined
        : cassette.steps.find(
            candidate =>
              candidate.kind === 'decision' &&
              candidate.stepIndex === entry.stepIndex &&
              candidate.decisionOrdinal === entry.decisionOrdinal,
          )
    if (
      step === undefined ||
      step.kind !== 'decision' ||
      record === undefined ||
      record.kind !== 'decision'
    ) {
      entries.push({
        ...entry,
        score: stampAbstention(tie, port, { calls: 0 }, 'missing-evidence'),
      })
      changed = true
      continue
    }
    const adjudicated = await adjudicateTie(
      tie,
      {
        sidecar: record.record.sidecar,
        stepText: record.record.input.stepText,
        result: step.result,
        sampleContext: {
          priorIdentities: history.filter(prior => prior.stepIndex < step.stepIndex),
          screenStateHash: record.record.receipt.screenStateHash,
          stateMetadata: record.record.input.stateBefore.metadata,
        },
      },
      port,
    )
    entries.push({ ...entry, score: adjudicated })
    changed = true
  }

  if (!changed) return score
  return {
    ...score,
    entries,
    summary: recomputeSummary(entries, score.summary.endState),
  }
}

/**
 * The tier-4 adjudication orchestrator. Refusal and shape-mismatch scores pass through
 * unchanged. When no eligible judge or no port exists, every unresolved tie is stamped
 * not-invoked UNCONDITIONALLY so the report's dispositions are uniform (D-06/D-10/D-12).
 * On the eligible path, every tie exits with a typed disposition — settled, abstained, or
 * judge-error — never silent, and the D-16 identity block rides the result.
 */
export async function adjudicateCassetteScore(input: {
  cassette: Cassette
  outcome: ReplayCassetteOutcome
  score: CassetteScore
  eligibility: JudgeEligibility
  port?: AdjudicationPort
}): Promise<AdjudicationResult> {
  const { cassette, outcome, score, eligibility, port } = input
  if (score.kind === 'replay-refusal' || score.kind === 'shape-mismatch') {
    return { score }
  }

  if (eligibility.eligible === false || port === undefined) {
    return { score: stampNotInvoked(score, notInvokedOutcome(eligibility)) }
  }

  const adjudicated =
    score.kind === 'leaf' && cassette.granularity === 'leaf'
      ? await adjudicateLeaf(cassette, outcome, score, port)
      : score.kind === 'procedure' && cassette.granularity === 'procedure'
        ? await adjudicateProcedure(cassette, outcome, score, port)
        : score

  return {
    score: adjudicated,
    judge: {
      judgeModelId: eligibility.judgeModelId,
      judgeFamily: eligibility.judgeFamily,
      ...(eligibility.panelSize === undefined ? {} : { panelSize: eligibility.panelSize, members: eligibility.members }),
      judgeVersion: JUDGE_CONFIG.judgeVersion,
      confidenceThreshold: JUDGE_CONFIG.confidenceThreshold,
      // Owner override of D-10 (2026-07-12): the disclosure rides every scored entry.
      ...(eligibility.familyOverride === undefined
        ? {}
        : { familyOverride: eligibility.familyOverride }),
    },
  }
}
