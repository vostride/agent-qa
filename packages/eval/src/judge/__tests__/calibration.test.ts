import { describe, expect, it } from 'vitest'
import {
  MARK_RECEIPT_SCHEMA_VERSION,
  asRef,
  type Action,
} from '@vostride/agent-qa-schema'
import * as core from '../../index'
import { MATCHER_CONFIG } from '../../match/config'
import { makeArtifactRefV2Handoff } from '../../__tests__/fixtures/handoff-fixtures'
import { wilsonInterval } from '../../stats/wilson'

function fixture(kind: core.GoldMark['kind'] = 'confirmed-bug', correction?: Action) {
  const handoff = makeArtifactRefV2Handoff()
  handoff.tests[0]!.steps = [handoff.tests[0]!.steps[0]!]
  handoff.tests[0]!.steps[0]!.verifierVerdict = { pass: false, reasoning: 'recorded fail' }
  const source = core.extractRunCassettes({ handoff, artifacts: { getBlob: () => new Uint8Array([1]) } })
    .cassettes.find(row => row.cassette.granularity === 'leaf')!.cassette as core.LeafCassette
  const mark: core.GoldMark = { schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_abcdef012345', runId: handoff.runId,
    runSlug: core.deriveRunSlug(handoff.runId), testIndex: 0, stepIndex: 0, kind, origin: 'user',
    ordinal: 1, markedAt: 0, disposition: { kind: 'confirmed-bug', confirmedRecords: 0 }, gold: [],
    evidence: { confirmed: 0, overturned: 0 }, ...(correction ? { correctedAction: correction } : {}) }
  const frozen = core.buildGoldenTrajectoryPlan({ handoff, cassettes: [{ cassette: source, blobs: [] }], mark, product: 'shop' })
  const snapshot: core.CommittedCorpusSnapshot = {
    entries: [core.projectCorpusEntry({ cassette: source, product: 'shop', runId: source.runId, assignment: { split: 'natural' } }), ...frozen.cases.map(row => row.corpusEntry)],
    labelsById: new Map([[source.id, core.projectSilverLabelRecord({ cassette: source, runId: source.runId })], ...frozen.cases.map(row => [row.cassetteId, row.labelRecord] as const)]),
    cassettesById: new Map([[source.id, source], ...frozen.goldCassettes.map(row => [row.cassette.id, row.cassette as core.LeafCassette] as const)]),
    blobPresentById: new Map(),
  }
  mark.gold = frozen.cases.map(row => ({ cassetteId: row.cassetteId, sourceCassetteId: source.id, channel: row.labelRecord.label.sourceChannel as 'user-mark' | 'overturned-verdict' }))
  return { snapshot, marks: [mark], source }
}
const select = (input: ReturnType<typeof fixture>) => Reflect.get(core, 'selectJudgeCalibrationGold')?.(input)
const truth = (gold: core.JudgeCalibrationGold, action: Action) => Reflect.get(core, 'resolveJudgeCalibrationTruth')?.({
  gold, candidate: { sampleIndex: 0, durationMs: 1, outcome: { kind: 'decision', action,
    identity: core.computeDecisionIdentity(action, (gold as { cassette: core.LeafCassette }).cassette.input.stateBefore.elements) } },
})

const memberIds = ['claude-sonnet-4', 'gemini-2.5', 'llama-3']
function observation(id: string, verdicts: ('equivalent' | 'different' | 'error' | 'unsure')[] = ['equivalent', 'equivalent', 'different']): core.JudgeCalibrationProbeObservation {
  const members: core.JudgeMemberOutcome[] = verdicts.map((verdict, index) => ({
    judgeModelId: memberIds[index]!, judgeFamily: ['claude', 'gemini', 'llama'][index]!,
    outcome: verdict === 'error' ? { kind: 'error', reason: 'provider-error', detail: 'fixed provider error' }
      : verdict === 'unsure' ? { kind: 'abstained', cause: 'unsure-verdict' }
      : { kind: 'settled', resolution: verdict, confidence: 'high' },
    usage: { calls: 2, inputTokens: 20, outputTokens: 4 },
  }))
  return { decisionId: id, replayedModelId: 'gpt-5', truth: { kind: 'resolved', fullMatch: true, provenance: 'deterministic-full-match' },
    eligibility: core.assessPanelEligibility({ memberModelIds: memberIds.slice(0, verdicts.length), replayedModelId: 'gpt-5' }),
    kind: 'attempted', outcome: core.poolPanel(members), usage: { calls: verdicts.length * 2, inputTokens: verdicts.length * 20, outputTokens: verdicts.length * 4, members },
    probe: { axis: 'element-identity', evidence: { stepText: 'Click continue', question: { kind: 'element-equivalence', gold: { role: 'button', nameNormalized: 'continue', ordinal: 0 }, candidate: { role: 'button', nameNormalized: 'continue', ordinal: 0 } } },
      score: { kind: 'scored', matcherVersion: MATCHER_CONFIG.matcherVersion, tierReached: 2,
        axes: { elementIdentity: { kind: 'scored', level: 'full', numeric: 1, tier: 2 } as never,
          opClass: { kind: 'match' } as never, value: { kind: 'not-applicable' } },
        sideEffect: { kind: 'none' }, loop: { kind: 'not-flagged' } as never } } }
}
function refused(id: string): core.JudgeCalibrationProbeObservation {
  return { decisionId: id, replayedModelId: 'gpt-5', recordedModelId: 'claude-sonnet-4',
    truth: { kind: 'resolved', fullMatch: true, provenance: 'deterministic-full-match' },
    eligibility: core.assessPanelEligibility({ memberModelIds: memberIds, replayedModelId: 'gpt-5', recordedModelId: 'claude-sonnet-4' }),
    kind: 'not-invoked', reason: 'no-eligible-judge' }
}
const summarize = (observations: readonly core.JudgeCalibrationProbeObservation[], minN?: number) =>
  Reflect.get(core, 'summarizeJudgeCalibration')?.({ observations, memberModelIds: memberIds, minN: core.resolveJudgeCalibrationMinimum(minN) })

describe('judge calibration independent denominators', () => {
  it('counts one independent observation for a three-member majority and six physical calls', () => {
    const result = summarize([observation('one')])
    expect(result?.n).toBe(1)
    expect(result).toMatchObject({ status: 'uncalibrated', pooledAgreement: 1, counts: { attempted: 1, truthComparable: 1 },
      cost: { usage: { calls: 6, inputTokens: 60, outputTokens: 12 } }, disagreement: { numerator: 2, denominator: 3, rate: 2 / 3 } })
    expect(result.wilson95).toEqual(wilsonInterval(1, 1))
    expect(result.wilson95!.lower).toBeCloseTo(0.2065493, 6)
    expect(result.wilson95!.upper).toBeCloseTo(1, 12)
    expect(result.perMember.map(row => row.agreement)).toEqual([1, 1, 0])
  })
  it.each([0, 19, 20, 21])('pins default independent n=%i boundary', n => {
    const result = summarize(Array.from({ length: n }, (_, index) => observation(String(index))))
    expect(result?.n).toBe(n)
    expect(result.status).toBe(n >= 20 ? 'calibrated' : 'uncalibrated')
    expect(result.minN).toBe(20); expect(result.minNSource).toBe('default')
    if (!n) { expect(result).not.toHaveProperty('pooledAgreement'); expect(result).not.toHaveProperty('wilson95') }
  })
  it('keeps unresolved truth in invocation and abstention counts but outside agreement', () => {
    const row = observation('unresolved', ['equivalent', 'error', 'unsure'])
    row.truth = { kind: 'unresolved', reason: 'truth-unresolved' }
    const result = summarize([row, observation('known')])
    expect(result?.n).toBe(1)
    expect(result).toMatchObject({ counts: { attempted: 2, unresolvedTruth: 1, truthComparable: 1 },
      abstention: { numerator: 1, denominator: 2, rate: 0.5 },
      disagreement: { numerator: 2, denominator: 3 }, cost: { usage: { calls: 12, inputTokens: 120 } } })
    expect(result.perMember[1]).toMatchObject({ settled: 1, errors: 1, abstained: 0, n: 1 })
    expect(result.perMember[2]).toMatchObject({ settled: 1, errors: 0, abstained: 1, n: 1 })
  })
  it('excludes zero-call refusals from every measured denominator and cost', () => {
    const measured = summarize([observation('known')]), mixed = summarize([refused('refused'), observation('known')])
    expect(mixed?.counts).toMatchObject({ selected: 2, eligible: 1, attempted: 1, eligibilityRefused: 1 })
    for (const key of ['n', 'pooledAgreement', 'wilson95', 'perMember', 'abstention', 'disagreement', 'cost'] as const) expect(mixed[key]).toEqual(measured[key])
    const empty = summarize([refused('a'), refused('b')])
    expect(empty).toMatchObject({ status: 'uncalibrated', n: 0, counts: { attempted: 0, eligibilityRefused: 2 }, cost: { usage: { calls: 0 } } })
    for (const key of ['pooledAgreement', 'wilson95']) expect(empty).not.toHaveProperty(key)
    expect(empty.abstention).not.toHaveProperty('rate'); expect(empty.disagreement).not.toHaveProperty('rate')
    expect(empty.perMember.every((row: { abstained: number; errors: number }) => row.abstained === 0 && row.errors === 0)).toBe(true)
  })
  it('uses whole-action full match when equivalent elements have an operation mismatch', () => {
    const row = observation('wrong-op')
    if (row.kind !== 'attempted' || row.probe.score.kind !== 'scored') throw new Error('fixture')
    row.probe.score.axes.opClass = { kind: 'mismatch' } as never
    row.truth = { kind: 'resolved', fullMatch: false, provenance: 'deterministic-full-match' }
    expect(summarize([row])?.pooledAgreement).toBe(1)
    expect(summarize([row]).perMember.every(member => member.agreement === 1)).toBe(true)
  })
  it('records override provenance and deterministic reruns without inflating independent n', () => {
    const rows = [observation('a'), observation('b')], before = JSON.stringify(rows)
    expect(summarize(rows, 2)?.status).toBe('calibrated')
    expect(summarize(rows, 3)).toMatchObject({ status: 'uncalibrated', minN: 3, minNSource: 'flag' })
    expect(summarize(rows, 2)).toEqual(summarize(rows, 2)); expect(JSON.stringify(rows)).toBe(before)
    expect(() => summarize([rows[0]!, rows[0]!])).toThrow('independent')
  })
  it('selects the anchored question first and explicitly skips a targetless valueless decision', () => {
    const gold = select(fixture()).gold[0] as core.JudgeCalibrationGold
    const action = gold.cassette.sidecar.goldAction
    const candidate: core.ReplaySample = { sampleIndex: 0, durationMs: 1, outcome: { kind: 'decision', action,
      identity: core.computeDecisionIdentity(action, gold.cassette.input.stateBefore.elements) } }
    const row: core.JudgeCalibrationEvidence = { ...gold, candidate, replayedModelId: 'gpt-5', profileKey: 'fixture', replayDigest: 'a'.repeat(64), truth: core.resolveJudgeCalibrationTruth({ gold, candidate }) }
    expect(core.prepareJudgeCalibrationProbe(row)?.evidence.question.kind).toBe('element-equivalence')
    delete row.cassette.sidecar.goldAnchor
    delete row.cassette.sidecar.goldValue
    expect(core.prepareJudgeCalibrationProbe(row)).toBeUndefined()
  })
})

describe('judge calibration independent source truth', () => {
  it('selects one executable private source despite recorded FAIL', () => {
    const input = fixture(), selected = select(input)
    expect(selected?.gold).toHaveLength(1)
    expect(truth(selected.gold[0], input.source.sidecar.goldAction)).toMatchObject({ kind: 'resolved', fullMatch: true, provenance: 'deterministic-full-match' })
  })
  it('newest empty mark retires old gold and changes digest', () => {
    const input = fixture(), before = select(input)
    input.marks.push({ ...input.marks[0]!, ordinal: 2, gold: [] })
    expect(select(input)?.gold).toEqual([])
    expect(select(input)?.goldSetDigest).not.toBe(before?.goldSetDigest)
  })
  it('deduplicates executable user-mark and overturned siblings', () => {
    const input = fixture('false-pass', { type: 'click', ref: asRef('e-continue-1') })
    expect(select(input)?.gold).toHaveLength(1)
    expect(select(input)).toEqual(select({ ...input, marks: [...input.marks, ...input.marks] }))
  })
  it('never uses verifier mark Boolean for wrong-op full-match truth', () => {
    const input = fixture(), selected = select(input)
    expect(selected?.gold).toHaveLength(1)
    expect(truth(selected.gold[0], { type: 'hover', ref: asRef('e-continue-1') })).toMatchObject({ kind: 'resolved', fullMatch: false })
  })
  it('admits correction while leaving a distinct ambiguous target unresolved', () => {
    const input = fixture('false-pass', { type: 'click', ref: asRef('e-continue-1') }), selected = select(input)
    expect(selected?.gold).toHaveLength(1)
    expect(truth(selected.gold[0], { type: 'click', ref: asRef('e-continue-2') })).toMatchObject({ kind: 'unresolved', reason: 'truth-unresolved' })
    expect(truth(selected.gold[0], { type: 'click', ref: asRef('e-continue-1') })).toMatchObject({ kind: 'resolved', fullMatch: true, provenance: 'grounded-correction' })
  })
  it.each(['private', 'excluded', 'quarantine', 'foreign-step', 'missing-source'])('skips invalid %s gold', mode => {
    const input = fixture(), id = input.marks[0]!.gold[0]!.cassetteId
    if (mode === 'private') (input.snapshot.entries.find(row => row.cassetteId === id)! as { heldOutVisibility: string }).heldOutVisibility = 'public'
    if (mode === 'excluded') input.snapshot.excludedLabelIds = new Set([id])
    if (mode === 'quarantine') input.snapshot.labelsById.get(id)!.quarantine = { reason: 'fixture' } as never
    if (mode === 'foreign-step') input.snapshot.cassettesById.get(id)!.stepIndex = 99
    if (mode === 'missing-source') input.snapshot.cassettesById = new Map([...input.snapshot.cassettesById].filter(([id]) => id !== input.source.id))
    expect(select(input)?.gold).toEqual([])
    expect(Object.values(select(input)?.skippedCounts ?? {}).some(n => Number(n) > 0)).toBe(true)
  })
  it('names nonexecutable correction instead of borrowing recorded action', () => {
    const selected = select(fixture('false-pass'))
    expect(selected?.gold).toEqual([])
    expect(selected?.skippedCounts['missing-executable-correction']).toBeGreaterThan(0)
  })
  it('keeps raw recorded model provenance and genuine absence', () => {
    const input = fixture()
    input.source.receipt.model = { declared: { provider: 'custom', modelId: 'unlisted-raw' }, resolvedModelId: 'fallback' }
    expect(select(input)?.gold[0]).toMatchObject({ recordedModelId: 'unlisted-raw', recordedReceipt: { cassetteId: input.source.id } })
    input.source.receipt.model = {}
    expect(select(input)?.gold[0]).not.toHaveProperty('recordedModelId')
  })
  it('panel axis overlay preserves operation, value, side-effect and loop gates', () => {
    const score: core.DecisionScore = { kind: 'scored', matcherVersion: MATCHER_CONFIG.matcherVersion, tierReached: 2,
      axes: { elementIdentity: { kind: 'scored', level: 'partial' } as never, opClass: { kind: 'match' } as never, value: { kind: 'not-applicable' } },
      sideEffect: { kind: 'none' }, loop: { kind: 'not-flagged' } as never }
    const overlay = (value: core.DecisionScore) => Reflect.get(core, 'judgeCalibrationFullMatch')?.(value, { axis: 'element-identity', resolution: 'equivalent' })
    expect(overlay(score)).toBe(true)
    const full = { ...score, axes: { ...score.axes, elementIdentity: { kind: 'scored', level: 'full', numeric: 1, tier: 2 } } } as core.DecisionScore
    expect(Reflect.get(core, 'judgeCalibrationFullMatch')?.(full, { axis: 'element-identity', resolution: 'different' })).toBe(false)
    expect(overlay({ ...score, axes: { ...score.axes, opClass: { kind: 'mismatch' } as never } })).toBe(false)
    expect(overlay({ ...score, axes: { ...score.axes, value: { kind: 'scored', f1: 0, band: 'low' } } })).toBe(false)
    expect(overlay({ ...score, sideEffect: { kind: 'unexpected' } as never })).toBe(false)
    expect(overlay({ ...score, loop: { kind: 'flagged' } as never })).toBe(false)
  })
})
