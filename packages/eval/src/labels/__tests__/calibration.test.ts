import { describe, expect, it } from 'vitest'
import { MARK_RECEIPT_SCHEMA_VERSION, asRunId } from '@vostride/agent-qa-schema'
import * as core from '../../index'
import { makeArtifactRefV2Handoff } from '../../__tests__/fixtures/handoff-fixtures'

function fixture(n = 1, correct = n, channel: 'recorded-verdict' | 'self-heal-pair' = 'recorded-verdict') {
  const snapshot = { entries: [] as core.CorpusEntry[], labelsById: new Map<string, core.StandaloneLabelRecord>(), cassettesById: new Map<string, core.LeafCassette>(), blobPresentById: new Map<string, boolean>(), excludedLabelIds: undefined as ReadonlySet<string> | undefined }
  const marks: core.GoldMark[] = []
  for (let i = 0; i < n; i++) {
    const handoff = makeArtifactRefV2Handoff()
    handoff.runId = asRunId(`calibration-${i}`)
    handoff.tests[0]!.steps = [handoff.tests[0]!.steps[0]!]
    handoff.tests[0]!.steps[0]!.verifierVerdict = { pass: false, reasoning: 'recorded' }
    const cassette = core.extractRunCassettes({ handoff, artifacts: { getBlob: () => new Uint8Array([1]) } }).cassettes.find(c => c.cassette.granularity === 'leaf')!.cassette as core.LeafCassette
    const product = i % 2 ? 'one' : 'two'
    const record = core.projectSilverLabelRecord({ cassette, runId: handoff.runId })
    if (channel === 'self-heal-pair') record.label = { ...record.label, sourceChannel: channel, tier: 'near-gold', pairing: { relation: 'contrastive-negative', pairedCassetteId: 'partner' } }
    snapshot.entries.push(core.projectCorpusEntry({ cassette, product, runId: handoff.runId, assignment: { split: 'natural' } }))
    snapshot.labelsById.set(cassette.id, record)
    snapshot.cassettesById.set(cassette.id, cassette)
    const gold: core.MarkGoldClaim[] = []
    const mark: core.GoldMark = { schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: `mark_${i.toString(16).padStart(12, '0')}`, runId: asRunId(handoff.runId), runSlug: core.deriveRunSlug(handoff.runId), testIndex: 0, stepIndex: 0,
      kind: i < correct ? 'confirmed-bug' : 'false-fail', origin: 'user', ordinal: 1, markedAt: 0,
      disposition: { kind: 'confirmed-bug', confirmedRecords: 0 }, gold, evidence: { confirmed: 0, overturned: 0 } }
    const plan = core.buildGoldenTrajectoryPlan({ handoff, cassettes: [{ cassette, blobs: [] }], mark, product })
    for (const row of plan.cases) {
      snapshot.entries.push(row.corpusEntry); snapshot.labelsById.set(row.cassetteId, row.labelRecord)
      snapshot.cassettesById.set(row.cassetteId, { ...cassette, id: row.cassetteId })
      gold.push({ cassetteId: row.cassetteId, sourceCassetteId: cassette.id, channel: row.labelRecord.label.sourceChannel as 'user-mark' })
    }
    marks.push(mark)
  }
  return { snapshot, marks }
}

function calibrate(input: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  return Reflect.get(core, 'calibrateLabels')?.({ ...input, ...extra })
}

describe('420 held-out calibration', () => {
  it.each([0, 3, 20])('preserves the complete pre-extraction calibration output for n=%i', n => {
    expect(core.canonicalJson(calibrate(fixture(n, Math.floor(n / 2))))).toMatchSnapshot()
  })
  it.each([19, 20, 21])('gates globally at %i source observations', n => {
    const report = calibrate(fixture(n))
    expect(report?.channels['recorded-verdict']).toMatchObject({ n, n_gold: n, status: n < 20 ? 'uncalibrated' : 'calibrated' })
    expect(report.minGold).toEqual({ value: 20, source: 'default' })
    if (n < 20) {
      expect(report.channels['recorded-verdict']).not.toHaveProperty('precision')
      expect(report.priors).toEqual({})
    } else {
      if (report.channels['recorded-verdict'].status !== 'calibrated') throw new Error('Expected calibrated channel')
      expect(report.channels['recorded-verdict'].precision).toBe(1)
      expect(report.channels['recorded-verdict'].wilson95).toEqual(core.wilsonInterval(n, n))
    }
  })
  it.each([0, 1, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects minimum %s', value => {
    expect(() => calibrate(fixture(), { minGold: { value, source: 'flag' } })).toThrow('minGold')
  })
  it('returns honest empty gold and no numeric precision or priors', () => {
    const report = calibrate(fixture(0))
    expect(report?.channels['user-mark']).toEqual({ n_gold: 0, precision: 'by-construction' })
    expect(report.channels['overturned-verdict']).toEqual({ n_gold: 0, precision: 'by-construction' })
    expect(report.channels['recorded-verdict']).toEqual({ status: 'uncalibrated', n: 0, n_gold: 0 })
    expect(report.priors).toEqual({})
    expect(report.verifierFalsePassRate).toEqual({ numerator: 0, denominator: 0 })
  })
  it.each(['recorded-verdict', 'self-heal-pair'] as const)('deduplicates false-pass clones for %s', channel => {
    const input = fixture(1, 1, channel), mark = input.marks[0]!
    mark.kind = 'false-pass'
    const sourceId = mark.gold[0]!.sourceCassetteId
    const source = input.snapshot.labelsById.get(sourceId)!
    source.label.verdict = { pass: true, reasoning: 'recorded pass' }
    if (source.label.pairing) source.label.pairing.relation = 'contrastive-positive'
    const gold = input.snapshot.labelsById.get(mark.gold[0]!.cassetteId)!
    gold.correction = { verdict: 'fail', overturnedVerdict: source.label.verdict, markId: mark.markId }
    const cloneId = core.deriveGoldCassetteId({ leafCassetteId: `${sourceId}-overturned`, markOrdinal: 1 })
    const entry = input.snapshot.entries.find(e => e.cassetteId === gold.cassetteId)!
    input.snapshot.entries.push({ ...entry, cassetteId: cloneId })
    input.snapshot.labelsById.set(cloneId, { ...gold, cassetteId: cloneId, label: { ...gold.label, sourceChannel: 'overturned-verdict' } })
    input.snapshot.cassettesById.set(cloneId, { ...input.snapshot.cassettesById.get(gold.cassetteId)!, id: cloneId })
    mark.gold = [...mark.gold, { ...mark.gold[0]!, cassetteId: cloneId, channel: 'overturned-verdict' }]
    const report = calibrate(input)
    expect(report?.channels[channel]).toMatchObject({ n: 1, n_gold: 1, status: 'uncalibrated' })
    expect(report.channels['overturned-verdict'].n_gold).toBe(1)
    expect(report.verifierFalsePassRate).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(report.rootCauseClassifierAccuracy['analyze-run'].n).toBe(0)
  })
  it.each(['missing', 'excluded', 'uncommitted'] as const)('discloses %s noisy source without scoring gold', mode => {
    const input = fixture(), id = input.marks[0]!.gold[0]!.sourceCassetteId
    if (mode === 'missing') input.snapshot.labelsById.delete(id)
    if (mode === 'excluded') input.snapshot.excludedLabelIds = new Set([id])
    if (mode === 'uncommitted') input.snapshot.entries = input.snapshot.entries.filter(e => e.cassetteId !== id)
    const report = calibrate(input)
    expect(report?.channels['recorded-verdict'].n).toBe(0)
    expect(report.skippedCounts['missing-source']).toBe(1)
  })
  it('latest empty receipt retires older gold and changes evidence identity', () => {
    const input = fixture(2), before = calibrate(input)
    input.marks.push({ ...input.marks[0]!, ordinal: 2, gold: [] })
    const report = calibrate(input)
    expect(report?.channels['user-mark'].n_gold).toBe(1)
    expect(report.channels['recorded-verdict'].n).toBe(1)
    expect(report.goldSetDigest).not.toBe(before.goldSetDigest)
    expect(core.calibrationGoldSetDigest(input)).toBe(report.goldSetDigest)
  })
  it('skips conflicting overlapping address truths instead of inventing precedence', () => {
    const input = fixture(), mark = input.marks[0]!
    input.marks.push({ ...mark, stepIndex: undefined, ordinal: 2, kind: 'false-fail' })
    const report = calibrate(input)
    expect(report?.channels['recorded-verdict'].n).toBe(0)
    expect(report.skippedCounts['conflicting-truth']).toBe(1)
  })
  it('uses pair polarity rather than the shared verifier verdict', () => {
    const input = fixture(2, 2, 'self-heal-pair')
    for (const mark of input.marks) input.snapshot.labelsById.get(mark.gold[0]!.sourceCassetteId)!.label.verdict!.pass = true
    const report = calibrate(input, { minGold: { value: 2, source: 'flag' } })
    expect(report?.channels['self-heal-pair']).toMatchObject({ precision: 1 })
    expect(report.priors['agent-observed']).toEqual({ alpha: 2, beta: 0 })
  })
  it.each([0, 18, 20])('preserves prior mass with %i correct of 20', correct => {
    const report = calibrate(fixture(20, correct))
    const prior = report?.priors['agent-verified']!
    expect(prior.alpha).toBeCloseTo(correct / 20 * 3)
    expect(prior.beta).toBeCloseTo((1 - correct / 20) * 3)
    expect(prior.alpha + prior.beta).toBe(3)
    expect(report.unchangedOrigins).toEqual(['user', 'import'])
    expect(report.priors).not.toHaveProperty('user')
    if (correct !== 18) expect(Object.values(prior)).toContain(0)
  })
  it('keeps coarse classifier producer observations independent and deduplicated', () => {
    const input = fixture(2, 1)
    const observations = input.marks.flatMap(mark => [
      { runId: mark.runId, testIndex: 0, producer: 'analyze-run', class: 'app_bug' },
      { runId: mark.runId, testIndex: 0, producer: 'deterministic-classifier', class: mark.kind === 'confirmed-bug' ? 'app_bug' : 'test_bug' },
    ])
    const report = calibrate(input, { observations: [...observations, ...observations] })
    expect(report?.rootCauseClassifierAccuracy['analyze-run']).toEqual({ n: 2, correct: 1, accuracy: 0.5 })
    expect(report.rootCauseClassifierAccuracy['deterministic-classifier']).toEqual({ n: 2, correct: 2, accuracy: 1 })
    expect(report.rootCauseClassifierGrain).toBe('member/producer:app_bug-binary')
  })
  it('canonicalizes order and excludes timestamp, counts and generated weights from gold identity', () => {
    const input = fixture(3), before = calibrate(input)
    input.snapshot.entries.reverse(); input.marks.reverse()
    input.marks.forEach(mark => { mark.markedAt = 999 })
    const report = calibrate(input)
    expect(report).toBeDefined()
    expect(report).toEqual(before)
    expect(core.calibrationGoldSetDigest(input)).toBe(before.goldSetDigest)
    expect(calibrate(input, { minGold: { value: 2, source: 'flag' } }).goldSetDigest).toBe(before.goldSetDigest)
  })
  it('skips contradictory producer observations without picking an input order', () => {
    const input = fixture(), runId = input.marks[0]!.runId
    const observations = [
      { runId, testIndex: 0, producer: 'analyze-run', class: 'app_bug' },
      { runId, testIndex: 0, producer: 'analyze-run', class: 'test_bug' },
    ]
    const report = calibrate(input, { observations })
    expect(report?.rootCauseClassifierAccuracy['analyze-run']).toEqual({ n: 0, correct: 0 })
    expect(report.skippedCounts['conflicting-observation']).toBe(1)
    expect(calibrate(input, { observations: observations.reverse() })).toEqual(report)
  })
})

it('420 exact channel mapping', () => {
  expect(Reflect.get(core, 'CHANNEL_TO_ORIGIN_CLASS')).toEqual({ 'recorded-verdict': 'agent-verified', 'self-heal-pair': 'agent-observed', 'user-mark': 'user', 'overturned-verdict': 'user' })
})
it('420 exact channel mapping keys', () => {
  expect(Object.keys(core.CHANNEL_TO_ORIGIN_CLASS).sort()).toEqual([
    'overturned-verdict', 'recorded-verdict', 'self-heal-pair', 'user-mark',
  ])
})
it.each([
  ['recorded-verdict', 'agent-verified'], ['self-heal-pair', 'agent-observed'],
  ['user-mark', 'user'], ['overturned-verdict', 'user'],
] as const)('420 exact channel mapping value %s', (channel, origin) => {
  expect(Reflect.get(core.CHANNEL_TO_ORIGIN_CLASS, channel)).toBe(origin)
})
it('420 exact calibration status', () => {
  expect(Reflect.get(core, 'LABEL_CALIBRATION_STATUSES')).toEqual(['uncalibrated', 'calibrated'])
})
