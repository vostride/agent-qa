import { ORIGIN_PRIORS, sha256hex, type OriginClass, type TrustPriorTable, type Verdict } from '@vostride/agent-qa-schema'
import { canonicalJson } from '../canonical-json'
import { computeCorpusDigest } from '../census/corpus-digest'
import type { CommittedCorpusSnapshot } from '../census/derive-census'
import type { LabelSourceChannel } from '../cassette/label-leg'
import { deriveRunSlug } from '../extract/ids'
import { wilsonInterval } from '../stats/wilson'
import type { GoldMark } from './golden-plan'

export type LabelCalibrationStatus = 'uncalibrated' | 'calibrated'
export const LABEL_CALIBRATION_STATUSES = ['uncalibrated', 'calibrated'] as const satisfies readonly LabelCalibrationStatus[]
export const CHANNEL_TO_ORIGIN_CLASS = {
  'recorded-verdict': 'agent-verified',
  'self-heal-pair': 'agent-observed',
  'user-mark': 'user',
  'overturned-verdict': 'user',
} as const satisfies Record<LabelSourceChannel, OriginClass>

export interface CalibrationObservation {
  runId: string
  testIndex: number
  producer: Verdict['producer']
  class: Verdict['class']
}
export interface LabelCalibrationInput {
  snapshot: CommittedCorpusSnapshot
  marks: readonly GoldMark[]
  observations?: readonly CalibrationObservation[]
  minGold?: { value: number; source: 'default' | 'flag' }
}
export type NoisyChannelCalibration =
  | { status: 'uncalibrated'; n: number; n_gold: number }
  | { status: 'calibrated'; n: number; n_gold: number; precision: number; wilson95: NonNullable<ReturnType<typeof wilsonInterval>> }
export type CalibrationSkipReason = 'missing-source' | 'invalid-gold' | 'conflicting-truth' | 'missing-verdict' | 'missing-pairing' | 'conflicting-observation'
interface Rate { numerator: number; denominator: number; rate?: number }
interface Accuracy { n: number; correct: number; accuracy?: number }
export interface LabelCalibrationReport {
  channels: {
    'recorded-verdict': NoisyChannelCalibration
    'self-heal-pair': NoisyChannelCalibration
    'user-mark': { n_gold: number; precision: 'by-construction' }
    'overturned-verdict': { n_gold: number; precision: 'by-construction' }
  }
  minGold: { value: number; source: 'default' | 'flag' }
  corpusDigest: string
  goldSetDigest: string
  priors: TrustPriorTable
  unchangedOrigins: readonly ['user', 'import']
  verifierFalsePassRate: Rate
  verifierFalseFailRate: Rate
  rootCauseClassifierAccuracy: Record<Verdict['producer'], Accuracy>
  rootCauseClassifierGrain: 'member/producer:app_bug-binary'
  skippedCounts: Partial<Record<CalibrationSkipReason, number>>
}

const memberKey = (runId: string, testIndex: number) => canonicalJson([runId, testIndex])
const ordered = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => {
  const first = canonicalJson(a), second = canonicalJson(b)
  return first < second ? -1 : first > second ? 1 : 0
})

/** Governing gold/source join shared by calibration and read-only identity inspection. */
function selectCalibrationGold(input: Pick<LabelCalibrationInput, 'snapshot' | 'marks'>) {
  const { snapshot } = input
  const skippedCounts: LabelCalibrationReport['skippedCounts'] = {}
  const skip = (reason: CalibrationSkipReason) => { skippedCounts[reason] = (skippedCounts[reason] ?? 0) + 1 }
  const latest = new Map<string, GoldMark[]>()
  for (const mark of input.marks) {
    const key = canonicalJson([mark.runId, mark.testIndex, mark.stepIndex ?? null])
    const previous = latest.get(key)
    if (!previous || mark.ordinal > previous[0]!.ordinal) latest.set(key, [mark])
    else if (mark.ordinal === previous[0]!.ordinal) previous.push(mark)
  }
  const entries = new Set(snapshot.entries.map(entry => entry.cassetteId))
  const active = (id: string) => entries.has(id) && !snapshot.excludedLabelIds?.has(id)
    && !snapshot.labelsById.get(id)?.quarantine
  const claims = new Map<string, GoldMark[]>()
  const goldIds = { 'user-mark': new Set<string>(), 'overturned-verdict': new Set<string>() }
  const evidence: unknown[] = []
  for (const marks of latest.values()) for (const mark of marks) {
    evidence.push({ runId: mark.runId, testIndex: mark.testIndex, stepIndex: mark.stepIndex ?? null,
      kind: mark.kind, ordinal: mark.ordinal, gold: ordered(mark.gold.map(ref => ({ cassetteId: ref.cassetteId, sourceCassetteId: ref.sourceCassetteId, channel: ref.channel }))) })
    for (const ref of mark.gold) {
      const gold = snapshot.labelsById.get(ref.cassetteId)
      const cassette = snapshot.cassettesById.get(ref.cassetteId)
      if (!active(ref.cassetteId) || !gold || gold.cassetteId !== ref.cassetteId
        || !cassette || cassette.id !== ref.cassetteId || cassette.runId !== mark.runId
        || cassette.testIndex !== mark.testIndex || (mark.stepIndex !== undefined && cassette.stepIndex !== mark.stepIndex)
        || gold.provenance.sourceCassetteId !== ref.sourceCassetteId
        || gold.provenance.runId !== mark.runId || gold.provenance.runSlug !== deriveRunSlug(mark.runId)
        || gold.label.sourceChannel !== ref.channel) { skip('invalid-gold'); continue }
      goldIds[ref.channel].add(ref.cassetteId)
      const group = claims.get(ref.sourceCassetteId) ?? []
      group.push(mark)
      claims.set(ref.sourceCassetteId, group)
    }
  }
  const sources: { source: NonNullable<ReturnType<typeof snapshot.labelsById.get>>; cassette: NonNullable<ReturnType<typeof snapshot.cassettesById.get>>; marks: GoldMark[]; truth: boolean; channel: 'recorded-verdict' | 'self-heal-pair' }[] = []
  for (const [sourceId, marks] of claims) {
    const source = snapshot.labelsById.get(sourceId), cassette = snapshot.cassettesById.get(sourceId)
    const sourceEntries = snapshot.entries.filter(entry => entry.cassetteId === sourceId)
    if (!active(sourceId) || !source || !cassette || source.provenance.sourceCassetteId
      || source.cassetteId !== sourceId || cassette.id !== sourceId
      || !sourceEntries.every(entry => entry.run_links.runId === cassette.runId && entry.run_links.runSlug === deriveRunSlug(cassette.runId))
      || !marks.every(mark => source.provenance.runId === mark.runId && cassette.runId === mark.runId
        && source.provenance.runSlug === deriveRunSlug(mark.runId) && cassette.testIndex === mark.testIndex
        && (mark.stepIndex === undefined || cassette.stepIndex === mark.stepIndex))) { skip('missing-source'); continue }
    const truths = new Set(marks.map(mark => mark.kind === 'false-fail'))
    if (truths.size !== 1) { skip('conflicting-truth'); continue }
    const truth = [...truths][0]!
    const channel = source.label.sourceChannel
    if (channel !== 'recorded-verdict' && channel !== 'self-heal-pair') { skip('missing-source'); continue }
    evidence.push({ sourceId, channel, verdict: source.label.verdict?.pass ?? null, relation: source.label.pairing?.relation ?? null })
    sources.push({ source, cassette, marks, truth, channel })
  }
  return { sources, goldIds, skippedCounts,
    goldSetDigest: sha256hex(canonicalJson([...new Set(evidence.map(value => canonicalJson(value)))].sort())) }
}

/** Current effective identity only; no precision, priors or refreshed records are derived. */
export function calibrationGoldSetDigest(input: Pick<LabelCalibrationInput, 'snapshot' | 'marks'>): string {
  return selectCalibrationGold(input).goldSetDigest
}

/** Selected committed marks measure their joined noisy sources, not all runtime traffic. */
export function calibrateLabels(input: LabelCalibrationInput): LabelCalibrationReport {
  const { snapshot } = input
  // Twenty held-out sources is the fixed global-by-channel reporting floor.
  const minGold = input.minGold ?? { value: 20, source: 'default' as const }
  if (!Number.isSafeInteger(minGold.value) || minGold.value < 2
    || !['default', 'flag'].includes(minGold.source)) throw new TypeError('Invalid minGold')
  const { sources, goldIds, skippedCounts, goldSetDigest } = selectCalibrationGold(input)
  const skip = (reason: CalibrationSkipReason) => { skippedCounts[reason] = (skippedCounts[reason] ?? 0) + 1 }
  const scores = { 'recorded-verdict': { n: 0, correct: 0 }, 'self-heal-pair': { n: 0, correct: 0 } }
  const falsePass: Rate = { numerator: 0, denominator: 0 }
  const falseFail: Rate = { numerator: 0, denominator: 0 }
  const members = new Map<string, Set<boolean>>()
  for (const { source, cassette, marks, truth, channel } of sources) {
    const prediction = channel === 'recorded-verdict' ? source.label.verdict?.pass
      : source.label.pairing ? source.label.pairing.relation === 'contrastive-positive' : undefined
    if (prediction === undefined) skip(channel === 'recorded-verdict' ? 'missing-verdict' : 'missing-pairing')
    else { scores[channel].n++; if (prediction === truth) scores[channel].correct++ }
    if (source.label.verdict) {
      const rate = source.label.verdict.pass ? falsePass : falseFail
      rate.denominator++
      if (source.label.verdict.pass !== truth) rate.numerator++
    }
    if (marks.some(mark => mark.kind !== 'false-pass')) {
      const key = memberKey(cassette.runId, cassette.testIndex), values = members.get(key) ?? new Set<boolean>()
      values.add(!truth)
      members.set(key, values)
    }
  }
  const priors: TrustPriorTable = {}
  const noisy = (channel: keyof typeof scores): NoisyChannelCalibration => {
    const { n, correct } = scores[channel]
    if (n < minGold.value) return { status: 'uncalibrated', n, n_gold: n }
    const precision = correct / n, origin = CHANNEL_TO_ORIGIN_CLASS[channel], prior = ORIGIN_PRIORS[origin]
    const mass = prior.alpha + prior.beta
    priors[origin] = { alpha: precision * mass, beta: (1 - precision) * mass }
    return { status: 'calibrated', n, n_gold: n, precision, wilson95: wilsonInterval(correct, n)! }
  }
  const observations = new Map<string, Set<Verdict['class']>>()
  for (const observation of input.observations ?? []) {
    const key = canonicalJson([memberKey(observation.runId, observation.testIndex), observation.producer])
    const values = observations.get(key) ?? new Set<Verdict['class']>()
    values.add(observation.class)
    observations.set(key, values)
  }
  const accuracies: LabelCalibrationReport['rootCauseClassifierAccuracy'] = {
    'analyze-run': { n: 0, correct: 0 }, 'deterministic-classifier': { n: 0, correct: 0 },
  }
  for (const [member, truths] of members) {
    if (truths.size !== 1) { skip('conflicting-truth'); continue }
    for (const producer of ['analyze-run', 'deterministic-classifier'] as const) {
      const values = observations.get(canonicalJson([member, producer]))
      if (!values) continue
      if (values.size !== 1) { skip('conflicting-observation'); continue }
      const score = accuracies[producer]
      score.n++
      if (([...values][0] === 'app_bug') === [...truths][0]) score.correct++
    }
  }
  for (const score of Object.values(accuracies)) if (score.n) score.accuracy = score.correct / score.n
  for (const rate of [falsePass, falseFail]) if (rate.denominator) rate.rate = rate.numerator / rate.denominator
  return {
    channels: { 'recorded-verdict': noisy('recorded-verdict'), 'self-heal-pair': noisy('self-heal-pair'),
      'user-mark': { n_gold: goldIds['user-mark'].size, precision: 'by-construction' },
      'overturned-verdict': { n_gold: goldIds['overturned-verdict'].size, precision: 'by-construction' } },
    minGold: { ...minGold }, corpusDigest: computeCorpusDigest(snapshot.entries),
    goldSetDigest,
    priors, unchangedOrigins: ['user', 'import'], verifierFalsePassRate: falsePass, verifierFalseFailRate: falseFail,
    rootCauseClassifierAccuracy: accuracies, rootCauseClassifierGrain: 'member/producer:app_bug-binary', skippedCounts,
  }
}
