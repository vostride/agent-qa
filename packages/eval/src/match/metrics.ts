import { ORIGIN_PRIORS, sha256hex } from '@vostride/agent-qa-schema'

import { canonicalJson } from '../canonical-json'
import type { CassetteLabelLeg } from '../cassette/label-leg'
import type { LabelWeight } from '../labels/label-record'
import type { CorpusGenerator, CorpusSplit, HeldOutVisibility } from '../labels/corpus-entry'
// 422 D-05/D-08: ONE generation projection, asked by both populations that have one. The census
// counts committed membership and this file counts what a batch actually scored; the two sets are
// different and each assembles its own input, but "which generations are in here" is one question
// and two spellings of it would eventually answer it two ways. The edge is one-way: derive-census
// imports only the `EvalBatchReport` TYPE from here, which erases at build.
import { projectAdversarialGenerationMix } from '../census/derive-census'
import type { AdversarialGenerationMix } from '../census/derive-census'
import { BRIEF_SOURCES } from '../replay/brief-tiers'
import type { BriefSource } from '../replay/brief-tiers'
import { REPLAY_REFUSAL_REASONS } from '../replay/result'
import type {
  DecisionReplayResult,
  ReplayCassetteOutcome,
  ReplayRefusal,
} from '../replay/result'
import { MATCHER_CONFIG } from './config'
import { isDecisionFullMatch } from './score'
import type {
  CassetteScore,
  DecisionPartialBreakdown,
  DecisionScore,
  DecisionScoreEntry,
  JudgeIdentityBlock,
  JudgeNotInvokedReason,
  JudgeTokenUsage,
  TieCause,
} from './score'
import type { ElementIdentityVerdict } from './tiers'
import type { JudgeCalibrationGapReason } from '../judge/calibration'

/** Report-only copied disclosure; never part of a score or request identity. */
type ReportJudgeCalibration =
  | { status: 'calibrated'; n: number; pooledAgreement: number;
      wilson95: { lower: number; upper: number; halfWidth: number };
      perMember: readonly { judgeModelId: string; n: number; agreement?: number;
        wilson95?: { lower: number; upper: number; halfWidth: number } }[] }
  | { status: 'uncalibrated'; n: number; provenance?: 'unavailable' }
  | { status: 'capability-gap'; reason: JudgeCalibrationGapReason }

type UnscorableIdentityCause = Extract<
  ElementIdentityVerdict,
  { kind: 'unscorable' }
>['cause']
type NeverScoredReason = Extract<DecisionScoreEntry, { kind: 'never-scored' }>['reason']
type SkippedReason = Extract<DecisionScoreEntry, { kind: 'skipped' }>['reason']
type Counts<T extends string> = { [K in T]: number }

interface RateMetric {
  numerator: number
  denominator: number
  rate?: number
}

/** Summary copied from guarded calibration evidence; no correction or action payloads. */
type BatchCalibration =
  | { status: 'uncalibrated'; n_gold?: number; verifierFalsePassRate?: RateMetric }
  | { status: 'calibrated'; n_gold: number; verifierFalsePassRate: RateMetric }

interface TotalCost {
  sampleCount: number
  samplesMissingTokenUsage: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
}

interface PerDecisionCost {
  decisionCount: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
}

/**
 * D-04 distinct judge cost component. Judge calls are never replay samples, so their usage is
 * aggregated from the outcome stamps alone (Pitfall 8) and stays typed-absent-honest: stamps
 * lacking usage are counted in `outcomesMissingUsage` instead of being fabricated.
 */
interface JudgeCost {
  calls: number
  inputTokens: number
  outputTokens: number
  outcomesMissingUsage: number
}

/**
 * D-04/D-12 judge honesty counters: every judge disposition is a visible count per TieCause,
 * errors stay distinct from calibrated abstentions (D-11), and not-invoked is counted per
 * reason so the no-eligible-judge capability gap headlines loudly.
 */
interface JudgeHonesty {
  invoked: Counts<TieCause>
  settled: Counts<TieCause>
  abstained: Counts<TieCause>
  errors: Counts<TieCause>
  notInvoked: Counts<JudgeNotInvokedReason>
  cost: JudgeCost
}

/** One replay outcome plus its optional matcher and label projections (D-14/D-15). */
export interface ScoredBatchEntry {
  cassetteId: string
  /** Authoritative source decision identity, shared by its active gold clones. */
  logicalSourceId?: string
  softWeight?: LabelWeight
  /** Refused or quarantined label evidence; incurred work remains reportable. */
  scoringExcluded?: boolean
  split?: CorpusSplit
  heldOutVisibility?: HeldOutVisibility
  /**
   * 2026-09-12, 422 D-05/D-11: the committed entry's generator provenance, copied by the batch
   * assembler from this cassette's own corpus membership. Absent means the assembler could not
   * resolve the entry — a DIFFERENT fact from an entry that names no family, and reported as
   * `metadataUnavailable` rather than folded into `absent` provenance.
   */
  generator?: CorpusGenerator
  product?: string
  outcome: ReplayCassetteOutcome
  score?: CassetteScore
  /** Historical judge work excluded from current verdicts, retained only for incurred usage. */
  incurredJudgeScore?: CassetteScore
  label?: CassetteLabelLeg
}

/**
 * Pure D-14 report DTO. Accuracy exposes its denominator, flags remain named distributions,
 * and no field combines the independent matcher axes into a fitness-like scalar.
 */
export interface EvalBatchReport {
  matcherVersion: number
  batchKey: string
  /** Actual fresh-run inputs, never reconstructed from a later profile or corpus snapshot. */
  runIdentity?: { fingerprint: string; corpusDigest: string }
  headline: {
    firstAttemptDecisionAccuracy: RateMetric
    verifierFalsePassRate: RateMetric
    perDecisionCost: PerDecisionCost
  }
  calibration: BatchCalibration
  perSplit: {
    natural: SplitMetricCell
    'held-out': { shared: SplitMetricCell; private: SplitMetricCell }
    adversarial: SplitMetricCell
    /** Entries lacking a complete recorded split assignment, including staged entries. */
    unassignedCount: number
  }
  /**
   * 2026-09-12, 422 D-05/D-08/D-11: how the SCORED adversarial population was generated.
   *
   * Additive-optional, and deliberately the opposite kind of field from `perSplit.adversarial`
   * beside it. The cell is ALWAYS present — a batch with no adversarial member states four
   * complete zero cells rather than omitting one (420 D-05) — because an empty scored population
   * is a measurement. The mix is present ONLY when that population is non-empty, because a
   * histogram of zeros beside an empty cell would read as "adversarial cases were scored and
   * none came from anywhere". A report written before 422 carries no mix and never acquires one.
   *
   * The population is this batch's own adversarial entries, exactly the set `perSplit.adversarial`
   * measures. It is NEVER the corpus census — the committed corpus and a scored batch are
   * different sets, and silently substituting one for the other would attribute generations to a
   * run that did not replay them.
   */
  adversarialGenerationMix?: AdversarialGenerationMix
  honesty: {
    tieCounts: Counts<TieCause>
    unscorableIdentityCounts: Counts<UnscorableIdentityCause>
    refusalCounts: Counts<ReplayRefusal['reason']>
    missByFailureCounts: Readonly<Record<string, number>>
    harnessErrorCount: number
    neverScoredCounts: Counts<NeverScoredReason>
    skippedCounts: Counts<SkippedReason>
    judge: JudgeHonesty
  }
  promptDriftRate: RateMetric
  /** Counts recorded stamps only; historical unstamped replays retain unknown provenance. */
  briefSourceCounts: Counts<BriefSource>
  /** Present only for a declared seed; false iff any sample of any decision listed seed. */
  seedHonored?: boolean
  /**
   * Sorted distinct provider-reported fingerprints across every sample of every decision.
   * Absent when none were reported. Disclosure only (D-11); never keys a profile.
   */
  providerFingerprints?: readonly string[]
  kEscalation: {
    decisionCount: number
    escalatedCount: number
    noConsensusCount: number
    meanAgreementRate?: number
  }
  modelMismatchCount: number
  axisDistributions: {
    elementIdentity: Counts<
      | 'full'
      | 'ordinal-only-differs'
      | 'role-matches-name-differs'
      | 'name-matches-role-differs'
      | 'within-tolerance'
      | 'miss'
    >
    value: Counts<'full' | 'mid' | 'low' | 'not-applicable' | 'not-evaluated'>
    opClass: Counts<'match' | 'mismatch'>
    loop: Counts<'not-applicable' | 'none' | 'flagged'>
  }
  recovery: {
    /** Always present; pairless corpora state zero instead of implying recovery evidence. */
    selfHealPairCount: number
    recoveredPositiveCount: number
    eligiblePositiveCount: number
    recoveryAccuracy?: number
    weightSum: number
    weightedAccuracy?: number
    pairsWithoutWeight: number
    /**
     * D-08 bucket: a full match on a contrastive-negative repeats the recorded mistake and is
     * excluded from the headline accuracy numerator AND denominator; counted here so the
     * channel is never invisible. Always present; label-free batches state zero.
     */
    negativeDecisionCount: number
    /** Excluded negative decisions whose replay fully matched the recorded mistaken action. */
    negativeFullMatchCount: number
  }
  totalCost: TotalCost
  /** D-16 report-level judge identity receipt; absent when no judge existed for the batch. */
  judge?: JudgeIdentityBlock & { calibration?: ReportJudgeCalibration }
  /**
   * 413-15 mixed-identity marker — the D-16 receipt's sibling for the case where one report's
   * persisted score records carried canonically DIFFERING judge identity blocks. Present ONLY
   * then; every non-mixed report carries neither this nor `mixedJudgeModelIds`, so already
   * committed report bytes are unchanged. A mixed batch has no single identity to receipt, and
   * one is never synthesized (T-372-20) — so `judge` is absent whenever this is present.
   */
  judgeIdentity?: 'mixed'
  /**
   * The distinct `judgeModelId`s actually seen across the batch's persisted score records,
   * sorted and deduped. Data copied off the blocks, never a fabricated single identity.
   */
  mixedJudgeModelIds?: readonly string[]
}

interface SplitMetricCell {
  firstAttemptDecisionAccuracy: RateMetric
  verifierFalsePassRate: RateMetric
  recovery: EvalBatchReport['recovery']
  perDecisionCost: PerDecisionCost
}

function isReplayRefusal(outcome: ReplayCassetteOutcome): outcome is ReplayRefusal {
  return 'kind' in outcome && outcome.kind === 'integrity-refusal'
}

function decisionResults(outcome: ReplayCassetteOutcome): readonly DecisionReplayResult[] {
  if (isReplayRefusal(outcome)) return []
  if (outcome.granularity === 'leaf') return [outcome]
  return outcome.steps.flatMap(step => (step.kind === 'decision' ? [step.result] : []))
}

export function scoreEntries(score: CassetteScore | undefined): readonly DecisionScoreEntry[] {
  if (score === undefined || score.kind === 'replay-refusal' || score.kind === 'shape-mismatch') {
    return []
  }
  return score.kind === 'leaf' ? [score.entry] : score.entries
}

function decisionScores(score: CassetteScore | undefined): readonly DecisionScore[] {
  return scoreEntries(score).flatMap(entry => (entry.kind === 'decision' ? [entry.score] : []))
}

export function breakdownFor(score: DecisionScore): DecisionPartialBreakdown | undefined {
  if (score.kind === 'scored') return score
  if (score.kind === 'unresolved-tie') return score.partial
  return undefined
}

/** One headline denominator rule for reports and pairing: unresolved ties remain excluded. */
export function isHeadlineApplicable(score: DecisionScore, isContrastiveNegative: boolean): boolean {
  return (
    !isContrastiveNegative &&
    (score.kind === 'miss-by-failure' ||
      (score.kind === 'scored' && score.axes.elementIdentity.kind !== 'unscorable'))
  )
}

function addJudgeUsage(cost: JudgeCost, usage: JudgeTokenUsage | undefined): void {
  if (usage === undefined) {
    cost.outcomesMissingUsage++
    return
  }
  cost.calls += usage.calls
  cost.inputTokens += usage.inputTokens ?? 0
  cost.outputTokens += usage.outputTokens ?? 0
}

function zeroTieCauseCounts(): Counts<TieCause> {
  return {
    'partial-identity': 0,
    'value-mid-band': 0,
    'no-consensus': 0,
  }
}

function rateMetric(numerator: number, denominator: number): RateMetric {
  return {
    numerator,
    denominator,
    ...(denominator === 0 ? {} : { rate: numerator / denominator }),
  }
}

function sortedCounts(counts: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const key of [...counts.keys()].sort()) result[key] = counts.get(key) ?? 0
  return result
}

function pairKey(first: string, second: string): string {
  return canonicalJson([first, second].sort())
}

function hasDecisionScore(entry: ScoredBatchEntry | undefined): boolean {
  return entry !== undefined && isScoringIncluded(entry) && decisionScores(entry.score).length > 0
}

function isScoringIncluded(entry: ScoredBatchEntry): boolean {
  return entry.scoringExcluded !== true && !isReplayRefusal(entry.outcome)
}

/** Resolve only the verifier population; other metric populations keep their own grain. */
function verifierRepresentatives(entries: readonly ScoredBatchEntry[]): ScoredBatchEntry[] {
  const bySource = new Map<string, ScoredBatchEntry>()
  const rank = (entry: ScoredBatchEntry) => entry.label?.sourceChannel === 'overturned-verdict'
    ? 2 : entry.label?.sourceChannel === 'user-mark' ? 1 : 0
  for (const entry of entries) {
    if (!isScoringIncluded(entry) || entry.label === undefined) continue
    const key = entry.logicalSourceId ?? entry.cassetteId, previous = bySource.get(key)
    if (previous === undefined || rank(entry) > rank(previous)
      || (rank(entry) === rank(previous) && entry.cassetteId < previous.cassetteId)) {
      bySource.set(key, entry)
    }
  }
  return [...bySource.values()]
}

function verifierRate(representatives: readonly ScoredBatchEntry[]): RateMetric {
  const passes = representatives.filter(entry => entry.label?.verdict?.pass === true)
  return rateMetric(passes.filter(entry => entry.label?.sourceChannel === 'overturned-verdict').length, passes.length)
}

function copyCalibration(calibration: BatchCalibration | undefined): BatchCalibration {
  if (calibration === undefined) return { status: 'uncalibrated' }
  const { status, n_gold, verifierFalsePassRate: rate } = calibration
  if (!['uncalibrated', 'calibrated'].includes(status)
    || (n_gold !== undefined && (!Number.isSafeInteger(n_gold) || n_gold < 0))
    || (status === 'calibrated' && (n_gold === undefined || rate === undefined))) {
    throw new TypeError('invalid calibration summary')
  }
  if (rate !== undefined && (!Number.isSafeInteger(rate.numerator) || rate.numerator < 0
    || !Number.isSafeInteger(rate.denominator) || rate.denominator < rate.numerator
    || (rate.denominator === 0 ? rate.rate !== undefined : rate.rate !== rate.numerator / rate.denominator))) {
    throw new TypeError('invalid calibration rate')
  }
  const copiedRate = rate === undefined ? undefined : {
    numerator: rate.numerator, denominator: rate.denominator,
    ...(rate.rate === undefined ? {} : { rate: rate.rate }),
  }
  if (status === 'calibrated') return { status, n_gold: n_gold!, verifierFalsePassRate: copiedRate! }
  return { status, ...(n_gold === undefined ? {} : { n_gold }),
    ...(copiedRate === undefined ? {} : { verifierFalsePassRate: copiedRate }) }
}

function accuracyMetrics(entries: readonly ScoredBatchEntry[]) {
  let numerator = 0, denominator = 0, negativeDecisionCount = 0, negativeFullMatchCount = 0
  for (const entry of entries) {
    if (!isScoringIncluded(entry)) continue
    const negative = entry.label?.pairing?.relation === 'contrastive-negative'
    for (const score of decisionScores(entry.score)) {
      if (!isHeadlineApplicable(score, false)) continue
      if (negative) {
        negativeDecisionCount++
        if (isDecisionFullMatch(score)) negativeFullMatchCount++
      } else {
        denominator++
        if (isDecisionFullMatch(score)) numerator++
      }
    }
  }
  return { accuracy: rateMetric(numerator, denominator), negativeDecisionCount, negativeFullMatchCount }
}

/** Sample-only totals and distinct judge usage fold once over actual replay decisions. */
function decisionCost(total: TotalCost, judge: JudgeCost, decisionCount: number): PerDecisionCost {
  return {
    decisionCount,
    promptTokens: decisionCount === 0 ? 0 : (total.promptTokens + judge.inputTokens) / decisionCount,
    completionTokens: decisionCount === 0 ? 0 : (total.completionTokens + judge.outputTokens) / decisionCount,
    totalTokens: decisionCount === 0 ? 0 : (total.totalTokens + judge.inputTokens + judge.outputTokens) / decisionCount,
    durationMs: decisionCount === 0 ? 0 : total.durationMs / decisionCount,
  }
}

function entryCosts(entries: readonly ScoredBatchEntry[]): PerDecisionCost {
  const total: TotalCost = { sampleCount: 0, samplesMissingTokenUsage: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0 }
  const judge: JudgeCost = { calls: 0, inputTokens: 0, outputTokens: 0, outcomesMissingUsage: 0 }
  let decisionCount = 0
  for (const entry of entries) {
    for (const result of decisionResults(entry.outcome)) {
      decisionCount++
      for (const sample of result.samples) {
        total.durationMs += sample.durationMs
        total.promptTokens += sample.tokenUsage?.promptTokens ?? 0
        total.completionTokens += sample.tokenUsage?.completionTokens ?? 0
        total.totalTokens += sample.tokenUsage?.totalTokens ?? 0
      }
    }
    for (const score of [...decisionScores(entry.score), ...decisionScores(entry.incurredJudgeScore)]) {
      if (score.kind === 'scored' && score.judgeSettled !== undefined) addJudgeUsage(judge, score.judgeSettled.usage)
      else if (score.kind === 'unresolved-tie' && score.judgeOutcome !== undefined
        && score.judgeOutcome.kind !== 'not-invoked') addJudgeUsage(judge, score.judgeOutcome.usage)
    }
  }
  return decisionCost(total, judge, decisionCount)
}

function splitKey(entry: ScoredBatchEntry): 'natural' | 'shared' | 'private' | 'adversarial' | undefined {
  if (entry.split === 'natural' || entry.split === 'adversarial') return entry.split
  if (entry.split === 'held-out') return entry.heldOutVisibility
  return undefined
}

function splitMetrics(entries: readonly ScoredBatchEntry[], representatives: readonly ScoredBatchEntry[]): EvalBatchReport['perSplit'] {
  const cell = (key: ReturnType<typeof splitKey>): SplitMetricCell => {
    const members = entries.filter(entry => splitKey(entry) === key)
    return {
      firstAttemptDecisionAccuracy: accuracyMetrics(members).accuracy,
      verifierFalsePassRate: verifierRate(representatives.filter(entry => splitKey(entry) === key)),
      recovery: recoveryMetrics(members),
      perDecisionCost: entryCosts(members),
    }
  }
  return { natural: cell('natural'), 'held-out': { shared: cell('shared'), private: cell('private') },
    adversarial: cell('adversarial'), unassignedCount: entries.filter(entry => splitKey(entry) === undefined).length }
}

/**
 * 422 D-05/D-08: the generation mix of the population `perSplit.adversarial` measures.
 *
 * `splitKey` is reused rather than re-testing `entry.split` so the mix's `total` cannot drift
 * from that cell's denominators. `undefined` is preserved into the projection: an entry whose
 * corpus membership the assembler could not resolve is `metadataUnavailable`, never a fabricated
 * `absent` stamp.
 */
function adversarialGenerationMix(
  entries: readonly ScoredBatchEntry[],
): AdversarialGenerationMix | undefined {
  const population = entries.filter(entry => splitKey(entry) === 'adversarial')
  if (population.length === 0) return undefined
  return projectAdversarialGenerationMix(population.map(entry => entry.generator))
}

function recoveryMetrics(entries: readonly ScoredBatchEntry[]): EvalBatchReport['recovery'] {
  const { negativeDecisionCount, negativeFullMatchCount } = accuracyMetrics(entries)
  const byCassetteId = new Map(entries.map(entry => [entry.cassetteId, entry]))
  const scoredPairs = new Set<string>()
  for (const entry of entries) {
    const pairing = entry.label?.pairing
    if (pairing === undefined) continue
    const paired = byCassetteId.get(pairing.pairedCassetteId)
    if (hasDecisionScore(entry) && hasDecisionScore(paired)) {
      scoredPairs.add(pairKey(entry.cassetteId, pairing.pairedCassetteId))
    }
  }

  let eligiblePositiveCount = 0
  let recoveredPositiveCount = 0
  let weightSum = 0
  let recoveredWeight = 0
  let pairsWithoutWeight = 0
  for (const entry of entries) {
    const pairing = entry.label?.pairing
    if (
      pairing?.relation !== 'contrastive-positive' ||
      !scoredPairs.has(pairKey(entry.cassetteId, pairing.pairedCassetteId))
    ) {
      continue
    }
    eligiblePositiveCount++
    const prior = ORIGIN_PRIORS['agent-verified']
    const weight = entry.softWeight?.value ?? prior.alpha / (prior.alpha + prior.beta)
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new TypeError('invalid recovery weight')
    if (entry.softWeight === undefined) pairsWithoutWeight++
    weightSum += weight
    if (decisionScores(entry.score).some(isDecisionFullMatch)) {
      recoveredPositiveCount++
      recoveredWeight += weight
    }
  }

  return {
    selfHealPairCount: scoredPairs.size,
    recoveredPositiveCount,
    eligiblePositiveCount,
    negativeDecisionCount,
    negativeFullMatchCount,
    weightSum,
    pairsWithoutWeight,
    ...(weightSum === 0 ? {} : { weightedAccuracy: recoveredWeight / weightSum }),
    ...(eligiblePositiveCount === 0
      ? {}
      : { recoveryAccuracy: recoveredPositiveCount / eligiblePositiveCount }),
  }
}

/** sha256hex over the canonical sorted cassette-id list (D-13). */
export function computeBatchKey(cassetteIds: readonly string[]): string {
  return sha256hex(canonicalJson([...cassetteIds].sort()))
}

/**
 * Aggregate a scored replay batch without recomputing score, drift, or agreement signals.
 *
 * `identity` (413-15) states that the batch mixed judge identities. A caller may not supply both
 * `judge` and `identity` — a mixed batch by definition has no single block — and if both arrive
 * the identity wins and `judge` is dropped, so the report can never claim one identity while
 * disclosing several.
 */
export function buildEvalReport(
  entries: readonly ScoredBatchEntry[],
  judge?: JudgeIdentityBlock,
  identity?: { judgeIdentity: 'mixed'; judgeModelIds: readonly string[] },
  opts: {
    declaredSeed?: number
    /** Observed failures outside replay outcomes; these do not invent samples or refusals. */
    additionalHarnessErrorCount?: number
    /** Observed load refusals excluded from entries; returned replay refusals stay in entries. */
    additionalRefusalCounts?: Readonly<Partial<EvalBatchReport['honesty']['refusalCounts']>>
    runIdentity?: EvalBatchReport['runIdentity']
    calibration?: BatchCalibration
  } = {},
): EvalBatchReport {
  const additionalHarnessErrorCount = opts.additionalHarnessErrorCount ?? 0
  if (!Number.isSafeInteger(additionalHarnessErrorCount) || additionalHarnessErrorCount < 0) {
    throw new TypeError('additional harness error count must be a nonnegative safe integer')
  }
  const tieCounts: Counts<TieCause> = {
    'partial-identity': 0,
    'value-mid-band': 0,
    'no-consensus': 0,
  }
  const judgeHonesty: JudgeHonesty = {
    invoked: zeroTieCauseCounts(),
    settled: zeroTieCauseCounts(),
    abstained: zeroTieCauseCounts(),
    errors: zeroTieCauseCounts(),
    notInvoked: { 'no-judge-configured': 0, 'no-eligible-judge': 0 },
    cost: { calls: 0, inputTokens: 0, outputTokens: 0, outcomesMissingUsage: 0 },
  }
  const unscorableIdentityCounts: Counts<UnscorableIdentityCause> = {
    'no-gold-evidence': 0,
    'no-candidate-geometry': 0,
    'coordspace-mismatch': 0,
  }
  const refusalCounts: Counts<ReplayRefusal['reason']> = {
    'guard-failed': 0,
    completeness: 0,
    'missing-blob': 0,
    'action-tool-collision': 0,
    'unsupported-brief': 0,
    'unrenderable-brief': 0,
    'parse-failed': 0,
  }
  for (const [reason, count] of Object.entries(opts.additionalRefusalCounts ?? {})) {
    const canonicalReason = REPLAY_REFUSAL_REASONS.find(candidate => candidate === reason)
    if (canonicalReason === undefined || !Number.isSafeInteger(count) || count < 0) {
      throw new TypeError('additional refusal count requires a canonical reason and a nonnegative safe integer')
    }
    refusalCounts[canonicalReason] = count
  }
  const neverScoredCounts: Counts<NeverScoredReason> = {
    'all-samples-harness-error': 0,
    'modal-representative-missing': 0,
    'missing-cassette-decision': 0,
    'missing-executable-correction': 0,
    'invalid-executable-correction': 0,
    'label-identity-mismatch': 0,
    'stale-scoring-context': 0,
  }
  const skippedCounts: Counts<SkippedReason> = { 'cache-served': 0, synthesized: 0 }
  const missByFailure = new Map<string, number>()
  const axisDistributions: EvalBatchReport['axisDistributions'] = {
    elementIdentity: {
      full: 0,
      'ordinal-only-differs': 0,
      'role-matches-name-differs': 0,
      'name-matches-role-differs': 0,
      'within-tolerance': 0,
      miss: 0,
    },
    value: { full: 0, mid: 0, low: 0, 'not-applicable': 0, 'not-evaluated': 0 },
    opClass: { match: 0, mismatch: 0 },
    loop: { 'not-applicable': 0, none: 0, flagged: 0 },
  }
  const totalCost: TotalCost = {
    sampleCount: 0,
    samplesMissingTokenUsage: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    durationMs: 0,
  }
  for (const entry of entries) {
    for (const historical of scoreEntries(entry.incurredJudgeScore)) {
      if (historical.kind !== 'decision') continue
      const score = historical.score
      const stamp = score.kind === 'scored' ? score.judgeSettled : undefined
      if (stamp !== undefined) {
        judgeHonesty.invoked[stamp.cause]++
        addJudgeUsage(judgeHonesty.cost, stamp.usage)
      } else if (score.kind === 'unresolved-tie' && score.judgeOutcome !== undefined &&
        score.judgeOutcome.kind !== 'not-invoked') {
        judgeHonesty.invoked[score.cause]++
        addJudgeUsage(judgeHonesty.cost, score.judgeOutcome.usage)
      }
    }
    if (isReplayRefusal(entry.outcome)) {
      refusalCounts[entry.outcome.reason]++
    }
    for (const scoreEntry of scoreEntries(entry.score)) {
      if (scoreEntry.kind === 'never-scored') {
        neverScoredCounts[scoreEntry.reason]++
        continue
      }
      if (scoreEntry.kind === 'skipped') {
        skippedCounts[scoreEntry.reason]++
        continue
      }

      const score = scoreEntry.score
      if (!isScoringIncluded(entry)) {
        if (score.kind === 'scored' && score.judgeSettled !== undefined) {
          judgeHonesty.invoked[score.judgeSettled.cause]++
          addJudgeUsage(judgeHonesty.cost, score.judgeSettled.usage)
        } else if (score.kind === 'unresolved-tie' && score.judgeOutcome !== undefined
          && score.judgeOutcome.kind !== 'not-invoked') {
          judgeHonesty.invoked[score.cause]++
          addJudgeUsage(judgeHonesty.cost, score.judgeOutcome.usage)
        }
        continue
      }
      if (score.kind === 'miss-by-failure') {
        missByFailure.set(score.reason, (missByFailure.get(score.reason) ?? 0) + 1)
      } else if (score.kind === 'unresolved-tie') {
        tieCounts[score.cause]++
        const outcome = score.judgeOutcome
        if (outcome !== undefined) {
          if (outcome.kind === 'abstained') {
            judgeHonesty.abstained[score.cause]++
            judgeHonesty.invoked[score.cause]++
            addJudgeUsage(judgeHonesty.cost, outcome.usage)
          } else if (outcome.kind === 'judge-error') {
            judgeHonesty.errors[score.cause]++
            judgeHonesty.invoked[score.cause]++
            addJudgeUsage(judgeHonesty.cost, outcome.usage)
          } else {
            judgeHonesty.notInvoked[outcome.reason]++
          }
        }
      } else {
        const settledStamp = score.judgeSettled
        if (settledStamp !== undefined) {
          judgeHonesty.settled[settledStamp.cause]++
          judgeHonesty.invoked[settledStamp.cause]++
          addJudgeUsage(judgeHonesty.cost, settledStamp.usage)
        }
      }

      const breakdown = breakdownFor(score)
      if (breakdown === undefined) continue
      const elementIdentity = breakdown.axes.elementIdentity
      if (elementIdentity.kind === 'scored') {
        axisDistributions.elementIdentity[elementIdentity.level]++
      } else if (elementIdentity.kind === 'unscorable') {
        unscorableIdentityCounts[elementIdentity.cause]++
      }

      const value = breakdown.axes.value
      if (value.kind === 'scored') axisDistributions.value[value.band]++
      else axisDistributions.value[value.kind]++
      axisDistributions.opClass[breakdown.axes.opClass.kind]++
      axisDistributions.loop[breakdown.loop.kind]++
    }
  }

  const replayDecisions = entries.flatMap(entry => decisionResults(entry.outcome))
  const briefSourceCounts = Object.fromEntries(
    BRIEF_SOURCES.map(source => [source, 0]),
  ) as Counts<BriefSource>
  let harnessErrorCount = additionalHarnessErrorCount
  let driftedCount = 0
  let escalatedCount = 0
  let noConsensusCount = 0
  let escalatedAgreementTotal = 0
  let modelMismatchCount = 0
  let seedUnsupported = false
  const providerFingerprints = new Set<string>()

  for (const result of replayDecisions) {
    if (BRIEF_SOURCES.includes(result.briefSource)) briefSourceCounts[result.briefSource]++
    harnessErrorCount += result.agreement.harnessErrorCount
    // Historical persisted replays predate harnessDrift; an explicit false still wins.
    if (result.promptDrift.harnessDrift ?? result.promptDrift.drift) driftedCount++
    if (result.agreement.k > 1) {
      escalatedCount++
      escalatedAgreementTotal += result.agreement.agreementRate
    }
    if (result.agreement.noConsensus) noConsensusCount++
    if (
      result.recordedModel !== undefined &&
      (result.recordedModel.provider !== result.replayedModel.provider ||
        result.recordedModel.modelId !== result.replayedModel.modelId)
    ) {
      modelMismatchCount++
    }

    for (const replaySample of result.samples) {
      if (replaySample.unsupportedFeatures?.includes('seed')) seedUnsupported = true
      if (replaySample.providerFingerprint !== undefined) {
        providerFingerprints.add(replaySample.providerFingerprint)
      }
      totalCost.sampleCount++
      totalCost.durationMs += replaySample.durationMs
      if (replaySample.tokenUsage === undefined) {
        totalCost.samplesMissingTokenUsage++
      } else {
        totalCost.promptTokens += replaySample.tokenUsage.promptTokens
        totalCost.completionTokens += replaySample.tokenUsage.completionTokens
        totalCost.totalTokens += replaySample.tokenUsage.totalTokens
      }
    }
  }

  const decisionCount = replayDecisions.length
  const recovery = recoveryMetrics(entries)

  const representatives = verifierRepresentatives(entries)

  return {
    matcherVersion: MATCHER_CONFIG.matcherVersion,
    batchKey: computeBatchKey(entries.map(entry => entry.cassetteId)),
    ...(opts.runIdentity === undefined ? {} : { runIdentity: { ...opts.runIdentity } }),
    headline: {
      firstAttemptDecisionAccuracy: accuracyMetrics(entries).accuracy,
      verifierFalsePassRate: verifierRate(representatives),
      perDecisionCost: decisionCost(totalCost, judgeHonesty.cost, decisionCount),
    },
    calibration: copyCalibration(opts.calibration),
    perSplit: splitMetrics(entries, representatives),
    // Absent for an empty adversarial population; the always-present cell above already states
    // that emptiness, and a zero histogram beside it would state something else entirely.
    ...(() => {
      const mix = adversarialGenerationMix(entries)
      return mix === undefined ? {} : { adversarialGenerationMix: mix }
    })(),
    honesty: {
      tieCounts,
      unscorableIdentityCounts,
      refusalCounts,
      missByFailureCounts: sortedCounts(missByFailure),
      harnessErrorCount,
      neverScoredCounts,
      skippedCounts,
      judge: judgeHonesty,
    },
    promptDriftRate: rateMetric(driftedCount, decisionCount),
    briefSourceCounts,
    ...(opts.declaredSeed !== undefined ? { seedHonored: !seedUnsupported } : {}),
    ...(providerFingerprints.size > 0
      ? { providerFingerprints: [...providerFingerprints].sort() }
      : {}),
    kEscalation: {
      decisionCount,
      escalatedCount,
      noConsensusCount,
      ...(escalatedCount === 0
        ? {}
        : { meanAgreementRate: escalatedAgreementTotal / escalatedCount }),
    },
    modelMismatchCount,
    axisDistributions,
    recovery,
    totalCost,
    ...(judge === undefined || identity !== undefined ? {} : { judge }),
    ...(identity === undefined
      ? {}
      : {
          judgeIdentity: identity.judgeIdentity,
          mixedJudgeModelIds: [...new Set(identity.judgeModelIds)].sort(),
        }),
  }
}
