import { sha256hex } from '@vostride/agent-qa-schema'
import { canonicalJson } from '../canonical-json'
import type { LeafCassette } from '../cassette/cassette'
import type { CassetteReceipt } from '../cassette/receipt-leg'
import { projectAdversarialGenerationMix, type CommittedCorpusSnapshot } from '../census/derive-census'
import { computeCorpusDigest } from '../census/corpus-digest'
import { generatorProvenance } from '../labels/corpus-entry'
import type { CorpusGenerator, GeneratorKind, GeneratorProvenance } from '../labels/corpus-entry'
import { deriveRunSlug } from '../extract/ids'
import { effectiveGold } from '../labels/effective-gold'
import type { GoldMark } from '../labels/golden-plan'
import type { StandaloneLabelRecord } from '../labels/label-record'
import { computeDecisionIdentity } from '../replay/identity'
import type { ReplaySample } from '../replay/result'
import { isDecisionFullMatch, scoreReplaySample, type DecisionScore, type JudgeSettled, type ScoreDecisionContext } from '../match/score'
import { wilsonInterval } from '../stats/wilson'
import { projectActionGoldValue } from '../extract/sidecar-leg'
import type { JudgeTieEvidence } from './prompt'
import type { JudgeEligibility, UsageAggregator } from './adjudicate'
import type { JudgePairwiseOutcome } from '../match/score'

export type JudgeCalibrationGapReason = 'panel-not-configured' | 'no-credential' | 'single-family-host'
export const JUDGE_CALIBRATION_GAP_REASONS = [
  'panel-not-configured', 'no-credential', 'single-family-host',
] as const satisfies readonly JudgeCalibrationGapReason[]
export type JudgeCalibrationStatus = 'calibrated' | 'uncalibrated' | 'capability-gap'
export const JUDGE_CALIBRATION_STATUSES = [
  'calibrated', 'uncalibrated', 'capability-gap',
] as const satisfies readonly JudgeCalibrationStatus[]

/** Independent reporting floor: twenty decisions support a useful Wilson interval,
 * but do not establish population accuracy or replace disclosure of its uncertainty. */
export const JUDGE_CALIBRATION_MIN_N = 20
export interface JudgeCalibrationMinimum { value: number; source: 'default' | 'flag' }
export function resolveJudgeCalibrationMinimum(override?: number): JudgeCalibrationMinimum {
  if (override !== undefined && (!Number.isSafeInteger(override) || override < 2)) {
    throw new TypeError('min-n must be a safe integer at least 2')
  }
  return { value: override ?? JUDGE_CALIBRATION_MIN_N, source: override === undefined ? 'default' : 'flag' }
}

/** Safe, serializable entry diagnostics. No resolver messages or credential payloads. */
export interface JudgeCalibrationEntryDiagnostic {
  index: number
  name: string
  modelId?: string
  families: readonly string[]
  credential: 'present' | 'missing' | 'unauthenticated' | 'resolution-failed'
  failures: readonly ('config-unresolved' | 'no-credential' | 'unknown-family' | 'replay-family-collision' | 'member-family-collision')[]
}
/**
 * 2026-09-12, 422 D-11/D-12 — the circularity disclosure, and what it deliberately is not.
 *
 * A judge calibrated partly on cases the system itself authored TO FOOL JUDGES is measuring its
 * own reflection. Removing those cases is not the fix — they are legitimate committed corpus
 * members — so the mitigation is DISCLOSURE: state how much of the committed adversarial
 * population is model-authored bait aimed at a judge, name its authors, and say whether any of it
 * reached the measured population. A reader can then discount the number; nothing here discounts
 * it for them.
 *
 * Three separations are structural rather than documented, and all three came out of the same
 * failure mode — a number discounted for the WRONG population misleads exactly as much as an
 * undisclosed one:
 *
 *   - SELF-AUTHORED IS NOT ADVERSARIAL. A table-derived variant is drawn from a frozen,
 *     hash-pinned table by a seeded function; no model authored it. Only the `probe` provenance
 *     arm is self-authored, and only its `judge-targeted` kind is aimed at a judge. The arms are
 *     counted apart (`byProvenance`, 422-19's vocabulary) and are never summed.
 *   - UNAVAILABLE IS NOT ZERO. `source: 'unavailable'` carries no count at all. A run that could
 *     not read its corpus must SAY it could not, because a disclosure that silently reads zero
 *     when its source is unreadable is worse than no disclosure at all.
 *   - RAW IS NOT ADJUSTED. `basis: 'raw'` is on the wire: the pooled agreement, its interval, the
 *     per-member rows, the counts and `minN` beside this block are untouched by it.
 */
export type JudgeTargetedCalibrationUnavailableReason = 'not-read' | 'corpus-unreadable'
/** Declaration-order projection of `JudgeTargetedCalibrationUnavailableReason` (D-22). */
export const JUDGE_TARGETED_CALIBRATION_UNAVAILABLE_REASONS = [
  'not-read', 'corpus-unreadable',
] as const satisfies readonly JudgeTargetedCalibrationUnavailableReason[]

/** One committed adversarial member. `generator` absent means the CALLER could not resolve it. */
export interface JudgeTargetedCalibrationMember {
  cassetteId: string
  generator?: CorpusGenerator
}

/** One authoring identity, with the fact that makes its bait SELF-authored stated on the row. */
export interface JudgeTargetedAuthorRow {
  /** Configured model identity exactly as the committed entry records it. */
  authoringModel: string
  /** Resolved provider family, as the judge-family resolver spells it. */
  authoringFamily: string
  /** This author is a member of the panel this calibration measured. */
  panelMember: boolean
  /** Every probe-authored member this author wrote, judge-targeted or not. */
  probeAuthored: number
  /** The judge-targeted subset of those. */
  judgeTargeted: number
}

export type JudgeTargetedCalibrationDisclosure =
  | { basis: 'raw'; source: 'unavailable'; reason: JudgeTargetedCalibrationUnavailableReason }
  | {
      basis: 'raw'
      source: 'resolved'
      /** Committed adversarial members this disclosure speaks for. */
      total: number
      /** Members whose generator the caller could not supply. Never folded into a zero arm. */
      metadataUnavailable: number
      /** Derivation path of each stamp (422-04). Closed set; a path nobody used reads `0`. */
      byProvenance: Record<GeneratorProvenance, number>
      /** The perturbed FIELD over every member naming a generator. Closed set; zeros retained. */
      byKind: Record<GeneratorKind, number>
      /** Probe-authored members whose kind targets a judge. */
      judgeTargeted: number
      /** Of those, written by a model on THIS panel. The circularity number. */
      selfAuthored: number
      /** Per author, sorted by identity. Open value space: an unused author is absent, not zero. */
      byAuthoringModel: readonly JudgeTargetedAuthorRow[]
      /** Judge-targeted members that reached the measured independent-gold population. */
      observedInCalibration: number
    }

export interface JudgeTargetedCalibrationInput {
  /** The committed adversarial population. ABSENT means the caller could not read it. */
  members?: readonly JudgeTargetedCalibrationMember[]
  /** Which unavailability to disclose when `members` is absent. */
  unavailable?: JudgeTargetedCalibrationUnavailableReason
  /** The panel being calibrated; membership is what makes authored bait SELF-authored. */
  memberModelIds: readonly string[]
  /** Cassette ids that entered the independent-gold population this summary measured. */
  observedCassetteIds?: readonly string[]
}

/**
 * Fold a committed adversarial population into the judge-targeted self-authorship disclosure.
 *
 * The provenance and kind arms are 422-19's projection, called rather than re-spelled: one
 * generation projection, asked here by a third population. Everything this function adds on top
 * is the CALIBRATION fact that projection cannot know — which authors are on the panel being
 * measured, and whether any judge bait reached the measured population.
 */
export function projectJudgeTargetedCalibration(
  input: JudgeTargetedCalibrationInput,
): JudgeTargetedCalibrationDisclosure {
  const { members } = input
  if (members === undefined) return { basis: 'raw', source: 'unavailable', reason: input.unavailable ?? 'not-read' }
  const mix = projectAdversarialGenerationMix(members.map(member => member.generator))
  const panel = new Set(input.memberModelIds)
  const observed = new Set(input.observedCassetteIds ?? [])
  const authors = new Map<string, { authoringFamily: string; probeAuthored: number; judgeTargeted: number }>()
  let judgeTargeted = 0, selfAuthored = 0, observedInCalibration = 0
  for (const member of members) {
    const generator = member.generator
    // Only the `probe` arm was AUTHORED. A table draw is a pure function of its inputs and a
    // legacy or malformed stamp names no author at all — neither may acquire one here.
    if (generator === undefined || generatorProvenance(generator) !== 'probe') continue
    const authoringModel = generator.authoringModel!
    const row = authors.get(authoringModel.id)
      ?? { authoringFamily: authoringModel.family, probeAuthored: 0, judgeTargeted: 0 }
    row.probeAuthored += 1
    if (generator.kind === 'judge-targeted') {
      row.judgeTargeted += 1
      judgeTargeted += 1
      if (panel.has(authoringModel.id)) selfAuthored += 1
      if (observed.has(member.cassetteId)) observedInCalibration += 1
    }
    authors.set(authoringModel.id, row)
  }
  return {
    basis: 'raw', source: 'resolved', total: mix.total, metadataUnavailable: mix.metadataUnavailable,
    byProvenance: mix.byProvenance, byKind: mix.byKind, judgeTargeted, selfAuthored,
    byAuthoringModel: [...authors.keys()].sort().map(authoringModel => {
      const row = authors.get(authoringModel)!
      return { authoringModel, authoringFamily: row.authoringFamily, panelMember: panel.has(authoringModel),
        probeAuthored: row.probeAuthored, judgeTargeted: row.judgeTargeted }
    }),
    observedInCalibration,
  }
}

export type JudgeCalibrationResult = { judgeTargeted: JudgeTargetedCalibrationDisclosure } & (
  | { status: 'calibrated'; n: number; pooledAgreement: number;
      wilson95: NonNullable<ReturnType<typeof wilsonInterval>>;
      perMember: readonly { judgeModelId: string; n: number; agreement: number;
        wilson95: NonNullable<ReturnType<typeof wilsonInterval>> }[] }
  | { status: 'uncalibrated'; n: number }
  | { status: 'capability-gap'; reason: JudgeCalibrationGapReason }
)

export type JudgeCalibrationSkipReason = 'invalid-gold' | 'missing-source' | 'conflicting-gold'
  | 'missing-executable-correction' | 'invalid-executable-correction' | 'invalid-recorded-model'
  | 'corpus-refused' | 'path-refused' | 'handoff-refused'
  | 'missing-replay' | 'malformed-replay' | 'foreign-replay' | 'stale-replay' | 'ambiguous-replay'
  | 'missing-profile-proof' | 'foreign-profile' | 'missing-candidate'
export type JudgeCalibrationDiagnostics = Partial<Record<JudgeCalibrationSkipReason, number>>
export interface JudgeCalibrationGold {
  sourceCassetteId: string
  goldCassetteId: string
  decisionId: string
  markId: string
  markOrdinal: number
  cassette: LeafCassette
  labelRecord: StandaloneLabelRecord
  recordedModelId?: string
  recordedReceipt: { cassetteId: string; receipt: CassetteReceipt }
}
export type JudgeCalibrationTruth =
  | { kind: 'resolved'; fullMatch: boolean; provenance: 'deterministic-full-match' | 'grounded-correction' }
  | { kind: 'unresolved'; reason: 'truth-unresolved' }
export interface JudgeCalibrationEvidence extends JudgeCalibrationGold {
  candidate: ReplaySample
  replayedModelId: string
  profileKey: string
  replayDigest: string
  truth: JudgeCalibrationTruth
}
/** One source decision, never one copy per panel member. Unresolved truth is still probed. */
export interface JudgeCalibrationObservation extends JudgeCalibrationEvidence {
  fullMatch?: boolean
}

export interface JudgeCalibrationProbe {
  evidence: JudgeTieEvidence
  axis: JudgeSettled['axis']
  score: DecisionScore
}
export type JudgeCalibrationProbeObservation = {
  decisionId: string
  replayedModelId: string
  recordedModelId?: string
  truth: JudgeCalibrationTruth
  eligibility: JudgeEligibility
} & (
  | { kind: 'not-invoked'; reason: 'no-eligible-judge' }
  | { kind: 'skipped'; reason: 'missing-evidence' }
  | { kind: 'attempted'; probe: JudgeCalibrationProbe; outcome: JudgePairwiseOutcome; usage: UsageAggregator }
)

/** Select one existing question; all scoring and evidence projection stays neutral. */
export function prepareJudgeCalibrationProbe(row: JudgeCalibrationEvidence): JudgeCalibrationProbe | undefined {
  if (row.candidate.outcome.kind !== 'decision') return undefined
  const { cassette, candidate } = row
  const target = row.candidate.outcome.identity.target
  const anchor = cassette.sidecar.goldAnchor
  const candidateValue = projectActionGoldValue(row.candidate.outcome.action)
  const question = anchor && target ? { kind: 'element-equivalence' as const,
    gold: { role: anchor.role, nameNormalized: anchor.nameNormalized, ordinal: anchor.ordinal }, candidate: target }
    : cassette.sidecar.goldValue !== undefined && candidateValue !== undefined
      ? { kind: 'value-equivalence' as const, goldValue: cassette.sidecar.goldValue, candidateValue }
      : undefined
  if (!question) return undefined
  const score = scoreReplaySample(cassette.sidecar, candidate, { priorIdentities: 'leaf-no-history',
    screenStateHash: cassette.receipt.screenStateHash, stateMetadata: cassette.input.stateBefore.metadata })
  if (score.kind === 'never-scored') return undefined
  return { evidence: { stepText: cassette.input.stepText, question },
    axis: question.kind === 'element-equivalence' ? 'element-identity' : 'value',
    score }
}

function calibrationRate(numerator: number, denominator: number) {
  return { numerator, denominator, ...(denominator ? { rate: numerator / denominator } : {}) }
}

/** Independent decision denominators; refusal is selection data, never a measured abstention. */
export function summarizeJudgeCalibration(input: {
  observations: readonly JudgeCalibrationProbeObservation[]
  memberModelIds: readonly string[]
  minN?: JudgeCalibrationMinimum
  selected?: number
  /** 422 D-12: the committed adversarial population, for the raw self-authorship disclosure. */
  judgeTargeted?: Omit<JudgeTargetedCalibrationInput, 'memberModelIds'>
}) {
  const minimum = input.minN ?? resolveJudgeCalibrationMinimum()
  resolveJudgeCalibrationMinimum(minimum.value)
  const rows = input.observations
  const selected = input.selected ?? rows.length
  if (!Number.isSafeInteger(selected) || selected < rows.length) throw new TypeError('Invalid selected calibration count.')
  if (new Set(rows.map(row => row.decisionId)).size !== rows.length) {
    throw new TypeError('Calibration requires independent source decisions, not repeated observations.')
  }
  const attempted = rows.filter(row => row.kind === 'attempted')
  const eligibilityRefused = rows.filter(row => row.kind === 'not-invoked').length
  const counts = { selected, admitted: rows.length, eligible: rows.length - eligibilityRefused,
    attempted: attempted.length, eligibilityRefused,
    evidenceSkipped: selected - rows.length + rows.filter(row => row.kind === 'skipped').length,
    truthComparable: attempted.filter(row => row.truth.kind === 'resolved').length,
    unresolvedTruth: attempted.filter(row => row.truth.kind === 'unresolved').length }
  const tally = (outcomes: { row: (typeof attempted)[number]; outcome: JudgePairwiseOutcome }[]) => {
    let settled = 0, abstained = 0, errors = 0, numerator = 0, n = 0
    for (const { row, outcome } of outcomes) {
      if (outcome.kind === 'abstained') { abstained++; continue }
      if (outcome.kind === 'error') { errors++; continue }
      settled++
      if (row.truth.kind !== 'resolved') continue
      n++
      if (judgeCalibrationFullMatch(row.probe.score, { axis: row.probe.axis, resolution: outcome.resolution }) === row.truth.fullMatch) numerator++
    }
    const wilson95 = wilsonInterval(numerator, n)
    return { settled, abstained, errors, n, numerator, denominator: n,
      ...(n ? { agreement: numerator / n, wilson95: wilson95! } : {}) }
  }
  const pooled = tally(attempted.map(row => ({ row, outcome: row.outcome })))
  const perMember = input.memberModelIds.map(judgeModelId => ({ judgeModelId,
    ...tally(attempted.flatMap(row => (row.usage.members ?? []).filter(member => member.judgeModelId === judgeModelId)
      .map(member => ({ row, outcome: member.outcome })))) }))
  const pairs = []
  for (let a = 0; a < input.memberModelIds.length; a++) for (let b = a + 1; b < input.memberModelIds.length; b++) {
    const memberModelIds = [input.memberModelIds[a]!, input.memberModelIds[b]!] as const
    let numerator = 0, denominator = 0
    for (const row of attempted) {
      const left = row.usage.members?.find(member => member.judgeModelId === memberModelIds[0])?.outcome
      const right = row.usage.members?.find(member => member.judgeModelId === memberModelIds[1])?.outcome
      if (left?.kind !== 'settled' || right?.kind !== 'settled') continue
      denominator++
      if (left.resolution !== right.resolution) numerator++
    }
    pairs.push({ memberModelIds, ...calibrationRate(numerator, denominator) })
  }
  const usage: Omit<UsageAggregator, 'members'> = { calls: 0 }
  for (const row of attempted) {
    usage.calls += row.usage.calls
    if (row.usage.inputTokens !== undefined) usage.inputTokens = (usage.inputTokens ?? 0) + row.usage.inputTokens
    if (row.usage.outputTokens !== undefined) usage.outputTokens = (usage.outputTokens ?? 0) + row.usage.outputTokens
  }
  // RAW, always present: every summary states its bait content or states that it could not.
  const judgeTargeted = projectJudgeTargetedCalibration({ ...input.judgeTargeted, memberModelIds: input.memberModelIds })
  return { status: pooled.n >= minimum.value ? 'calibrated' as const : 'uncalibrated' as const,
    n: pooled.n, minN: minimum.value, minNSource: minimum.source, counts, perMember, pooled, judgeTargeted,
    ...(pooled.n ? { pooledAgreement: pooled.agreement!, wilson95: pooled.wilson95! } : {}),
    abstention: calibrationRate(pooled.abstained, attempted.length),
    disagreement: { ...calibrationRate(pairs.reduce((sum, pair) => sum + pair.numerator, 0),
      pairs.reduce((sum, pair) => sum + pair.denominator, 0)), pairs },
    cost: { callBound: attempted.length * input.memberModelIds.length * 2, usage } }
}
const hash = (value: unknown) => sha256hex(canonicalJson(value))
const compare = (a: unknown, b: unknown) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0

/** Governing marks and executable actions only; verifier verdicts are never equivalence truth. */
export function selectJudgeCalibrationGold(input: { snapshot: CommittedCorpusSnapshot; marks: readonly GoldMark[] }) {
  const { snapshot } = input
  const skippedCounts: JudgeCalibrationDiagnostics = {}
  const skip = (reason: JudgeCalibrationSkipReason) => { skippedCounts[reason] = (skippedCounts[reason] ?? 0) + 1 }
  const latest = new Map<string, GoldMark[]>()
  for (const mark of input.marks) {
    const key = canonicalJson([mark.runId, mark.testIndex, mark.stepIndex ?? null])
    const previous = latest.get(key)
    if (!previous || mark.ordinal > previous[0]!.ordinal) latest.set(key, [mark])
    else if (mark.ordinal === previous[0]!.ordinal && !previous.some(row => canonicalJson(row) === canonicalJson(mark))) previous.push(mark)
  }
  const active = (id: string) => snapshot.entries.some(entry => entry.cassetteId === id)
    && !snapshot.excludedLabelIds?.has(id) && !snapshot.labelsById.get(id)?.quarantine
  const rows = new Map<string, JudgeCalibrationGold[]>()
  const semanticExclusions: unknown[] = []
  const governing = [...latest.values()].flat().sort(compare)
  for (const mark of governing) for (const ref of [...mark.gold].sort(compare)) {
    const cassette = snapshot.cassettesById.get(ref.cassetteId), label = snapshot.labelsById.get(ref.cassetteId)
    const entries = snapshot.entries.filter(entry => entry.cassetteId === ref.cassetteId)
    if (!cassette || !label || !active(ref.cassetteId) || cassette.id !== ref.cassetteId
      || cassette.granularity !== 'leaf' || label.cassetteId !== cassette.id
      || cassette.runId !== mark.runId || cassette.testIndex !== mark.testIndex
      || (mark.stepIndex !== undefined && cassette.stepIndex !== mark.stepIndex)
      || label.provenance.sourceCassetteId !== ref.sourceCassetteId || label.provenance.runId !== mark.runId
      || label.provenance.runSlug !== deriveRunSlug(mark.runId) || label.label.sourceChannel !== ref.channel
      || !entries.every(entry => entry.split === 'held-out' && entry.heldOutVisibility === 'private'
        && entry.run_links.runId === mark.runId && entry.run_links.runSlug === deriveRunSlug(mark.runId))) {
      skip('invalid-gold'); continue
    }
    const source = snapshot.cassettesById.get(ref.sourceCassetteId), sourceLabel = snapshot.labelsById.get(ref.sourceCassetteId)
    if (!source || !sourceLabel || !active(ref.sourceCassetteId) || source.id !== ref.sourceCassetteId
      || sourceLabel.cassetteId !== source.id || sourceLabel.provenance.sourceCassetteId !== undefined
      || source.runId !== cassette.runId || source.testIndex !== cassette.testIndex || source.testId !== cassette.testId
      || source.stepIndex !== cassette.stepIndex || source.decisionOrdinal !== cassette.decisionOrdinal
      || canonicalJson(source.input) !== canonicalJson(cassette.input)
      || canonicalJson(source.sidecar) !== canonicalJson(cassette.sidecar)
      || sourceLabel.provenance.runId !== mark.runId || sourceLabel.provenance.runSlug !== deriveRunSlug(mark.runId)
      || !snapshot.entries.filter(entry => entry.cassetteId === source.id).every(entry =>
        entry.run_links.runId === mark.runId && entry.run_links.runSlug === deriveRunSlug(mark.runId))) {
      skip('missing-source'); continue
    }
    if (mark.kind !== 'confirmed-bug' && label.correction?.correctedAction === undefined) {
      semanticExclusions.push({ cassette, label, source, sourceLabel })
      skip('missing-executable-correction'); continue
    }
    const effective = effectiveGold(cassette, label)
    if (effective.kind === 'refused') {
      if (effective.reason === 'missing-executable-correction') semanticExclusions.push({ cassette, label, source, sourceLabel })
      skip(effective.reason === 'missing-executable-correction' ? effective.reason : 'invalid-executable-correction'); continue
    }
    const recordedModelId = source.receipt.model.declared?.modelId ?? source.receipt.model.resolvedModelId
    if (recordedModelId !== undefined && (typeof recordedModelId !== 'string' || !recordedModelId.trim() || /[\u0000-\u001f\u007f]/.test(recordedModelId))) {
      skip('invalid-recorded-model'); continue
    }
    const row: JudgeCalibrationGold = {
      sourceCassetteId: source.id, goldCassetteId: cassette.id,
      decisionId: canonicalJson([source.id, source.runId, source.testIndex, source.stepIndex, source.decisionOrdinal]),
      markId: mark.markId, markOrdinal: mark.ordinal, cassette: effective.cassette, labelRecord: label,
      ...(recordedModelId === undefined ? {} : { recordedModelId }),
      recordedReceipt: { cassetteId: source.id, receipt: source.receipt },
    }
    rows.set(source.id, [...(rows.get(source.id) ?? []), row])
  }
  const gold: JudgeCalibrationGold[] = []
  for (const group of rows.values()) {
    if (new Set(group.map(row => canonicalJson(row.cassette.sidecar))).size > 1) { skip('conflicting-gold'); continue }
    // User-mark wins over its overturned sibling, then stable canonical identity.
    group.sort((a, b) => Number(a.labelRecord.label.sourceChannel !== 'user-mark') - Number(b.labelRecord.label.sourceChannel !== 'user-mark') || compare(a.goldCassetteId, b.goldCassetteId))
    gold.push(group[0]!)
  }
  gold.sort((a, b) => compare(a.decisionId, b.decisionId))
  const goldSetDigest = hash({ governing: governing.map(mark => ({ runId: mark.runId, testIndex: mark.testIndex,
    stepIndex: mark.stepIndex ?? null, markId: mark.markId, ordinal: mark.ordinal, kind: mark.kind,
    gold: [...mark.gold].sort(compare) })), gold,
    ...(semanticExclusions.length ? { semanticExclusions: semanticExclusions.sort(compare) } : {}) })
  return { gold, skippedCounts, goldSetDigest, corpusDigest: computeCorpusDigest(snapshot.entries) }
}

/** Always recompute judge-free truth from the action and its recorded screen. */
export function resolveJudgeCalibrationTruth(input: { gold: JudgeCalibrationGold; candidate: ReplaySample; context?: ScoreDecisionContext }): JudgeCalibrationTruth {
  const { cassette } = input.gold
  const candidate = input.candidate.outcome.kind !== 'decision' ? input.candidate : {
    ...input.candidate, outcome: { ...input.candidate.outcome,
      identity: computeDecisionIdentity(input.candidate.outcome.action, cassette.input.stateBefore.elements) },
  }
  const score = scoreReplaySample(cassette.sidecar, candidate, input.context ?? {
    priorIdentities: 'leaf-no-history', screenStateHash: cassette.receipt.screenStateHash,
    stateMetadata: cassette.input.stateBefore.metadata,
  })
  if (candidate.outcome.kind === 'decision'
    && input.gold.labelRecord.correction?.correctedAction !== undefined
    && candidate.outcome.identity.target !== undefined
    && canonicalJson(candidate.outcome.action) === canonicalJson(cassette.sidecar.goldAction)) {
    const fullMatch = score.kind === 'scored' ? isDecisionFullMatch(score)
      : score.kind === 'unresolved-tie' && judgeCalibrationFullMatch(score, {
        axis: score.cause === 'value-mid-band' ? 'value' : 'element-identity', resolution: 'equivalent',
      })
    if (fullMatch) return { kind: 'resolved', fullMatch, provenance: 'grounded-correction' }
  }
  if (score.kind === 'scored' || score.kind === 'miss-by-failure') return {
    kind: 'resolved', fullMatch: isDecisionFullMatch(score), provenance: 'deterministic-full-match',
  }
  return { kind: 'unresolved', reason: 'truth-unresolved' }
}

/** Use the production full-match predicate for the panel's one-axis prediction too. */
export function judgeCalibrationFullMatch(score: DecisionScore, result: Pick<JudgeSettled, 'axis' | 'resolution'>): boolean {
  // Forced probes can disagree with a deterministic full match. A negative prediction
  // must not inherit the already-full axis (production tie stamps only upgrade ties).
  if (result.resolution === 'different') return false
  const partial = score.kind === 'scored' ? score : score.kind === 'unresolved-tie' ? score.partial : undefined
  if (!partial) return false
  return isDecisionFullMatch({ ...partial, kind: 'scored', matcherVersion: score.matcherVersion,
    judgeSettled: { ...result, cause: score.kind === 'unresolved-tie' ? score.cause : 'partial-identity',
      judgeId: 'calibration-prediction', judgeVersion: 0, confidence: 'high' } })
}
