import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CandidateInjectionSchema, KnowledgeCandidateInjectionResultSchema } from '../knowledge/candidate-injection'
import {
  GATE_RECEIPT_SCHEMA_VERSION,
  GateReceiptSchema, PromotionReceiptSchema, receiptDigestOf, stampReceiptDigest,
  standingReceiptsByGate, strongestPromotionPath,
} from '../knowledge/gate-receipt'

function core() {
  return { schemaVersion: GATE_RECEIPT_SCHEMA_VERSION as typeof GATE_RECEIPT_SCHEMA_VERSION,
    candidateId: 'candidate', verdict: 'pass' as const,
    producedAtOrdinal: 5, producedBy: { jobId: 'replay' } }
}

it('policy Gate-3 approvals retain honest identity without fabricating a run mark', () => {
  const receipt = stampReceiptDigest({ ...core(), gate: 3 as const,
    policyApproval: { proposalId: 'kp_fixture', recordId: 'candidate' } })
  expect(GateReceiptSchema.parse(receipt)).toEqual(receipt)
  expect(receiptDigestOf(receipt)).toBe(receipt.receiptDigest)
  expect(receipt).not.toHaveProperty('runId')
  expect(receipt).not.toHaveProperty('mark')
  for (const altered of [
    { ...receipt, policyApproval: undefined },
    { ...receipt, runId: 'run' }, { ...receipt, mark: 'confirmed-bug' },
    { ...receipt, stepId: '0:1' },
    { ...receipt, policyApproval: { proposalId: 'kp_fixture' } },
    { ...receipt, policyApproval: { proposalId: 'kp_fixture', recordId: 'foreign' } },
    { ...core(), gate: 3, runId: 'run', receiptDigest: 'a'.repeat(64) },
    { ...core(), gate: 3, mark: 'false-fail', receiptDigest: 'a'.repeat(64) },
  ]) expect(GateReceiptSchema.safeParse(altered).success).toBe(false)
  const changed = { ...receipt, policyApproval: { ...receipt.policyApproval, proposalId: 'kp_changed' } }
  expect(receiptDigestOf(changed)).not.toBe(receipt.receiptDigest)
  expect(JSON.stringify(z.toJSONSchema(GateReceiptSchema))).toContain('policyApproval')
})
function gate1() {
  const score = { baseline: 0.5, candidate: 0.8, delta: 0.3, floor: 0.1, n: 10 }
  return stampReceiptDigest({ ...core(), gate: 1 as const,
    perAxisScore: { headline: score, elementIdentity: score, value: score, opClass: score,
      sideEffect: score, loop: score },
    corpusVersion: { corpusDigest: 'c'.repeat(64), partitionVersion: 2, gateSetSize: 10,
      excludedCount: 1, minimumGateSet: 3 },
    samples: { k: 1, seeds: [1], seedHonored: true, modelCalls: 0 },
    crossCheck: 'held' as const, judgeId: 'judge', degradation: 'replay-diff' as const,
    noiseFloorRef: { profileKey: 'planner-judge', corpusDigest: 'c'.repeat(64) },
  })
}
function completeGate1() {
  return { ...gate1(), reasons: [], crossCheck: 'flipped',
    cap: { maxScreens: 50 },
    spend: { screens: 8, modelCalls: 8, promptTokens: 100, completionTokens: 20, wallClockMs: 500 },
    kSource: 'default',
    targets: [{ cassetteId: 'cassette', stepIndex: 0, decisionOrdinal: 0, runId: 'run',
      source: 'committed', baselineCorrect: false, candidateCorrect: true,
      baselineBriefSource: 'proof', candidateBriefSource: 'proof' }],
    harmed: [], unverifiedFlips: [],
    population: { proof: 5, empty: 1, rendered: 2, refused: 0, renderedExcluded: 2 },
    floorAbsentAxes: ['loop'],
    productFloor: { product: 'checkout', axes: [{ axis: 'headline', floor: 0.1, n: 5 },
      { axis: 'loop', floor: null, n: 0 }] },
    generalization: { liftDecisions: 1, minimumLiftDecisions: 3 },
    baselineSource: { runRoot: 'local/replay', seed: 11, seedSource: 'floor' },
    judge: { eligibility: 'no-judge-configured', overrideConfigured: false },
    samples: { k: 3, seeds: [11, 12, 13], seedHonored: true, modelCalls: 6,
      detail: [{ withRecord: true, seed: 11, matchesGold: true, kind: 'action' },
        { withRecord: false, seed: 11, matchesGold: false, kind: 'action' }] },
  }
}

describe('additive Gate-1 contract', () => {
  it('preserves strict panel metadata and singleton bytes', () => {
    const single = completeGate1()
    expect(GateReceiptSchema.parse(single)).toEqual(single)
    expect(single.judge).not.toHaveProperty('panelSize')
    const judge = { eligibility: 'eligible', overrideConfigured: false, panelSize: 2,
      members: [{ judgeModelId: 'claude-fixture', judgeFamily: 'claude' },
        { judgeModelId: 'gemini-fixture', judgeFamily: 'gemini' }] }
    const panel = { ...single, judge }
    expect(GateReceiptSchema.safeParse(panel).success).toBe(true)
    expect(GateReceiptSchema.parse(panel)).toEqual(panel)
    for (const invalid of [
      { ...judge, panelSize: 1 }, { ...judge, panelSize: 3 },
      { ...judge, members: undefined }, { ...judge, panelSize: undefined },
      { ...judge, members: [{ ...judge.members[0], extra: true }, judge.members[1]] },
      { ...judge, members: [{ judgeFamily: 'claude' }, judge.members[1]] },
    ]) expect(GateReceiptSchema.safeParse({ ...single, judge: invalid }).success).toBe(false)
  })
  it('round-trips every new field and preserves the historical complete arm', () => {
    expect(GateReceiptSchema.parse(completeGate1())).toEqual(completeGate1())
    expect(GateReceiptSchema.parse(gate1())).toEqual(gate1())
  })
  it('records a zero-screen baseline-uncached abstention', () => {
    const receipt = { ...completeGate1(), verdict: 'abstain', reasons: ['baseline-uncached'],
      crossCheck: 'not-run', spend: { screens: 0, modelCalls: 0, promptTokens: 0,
        completionTokens: 0, wallClockMs: 0 } }
    expect(GateReceiptSchema.parse(receipt)).toEqual(receipt)
  })
  it('accepts extracted sibling harm without split or held-out visibility', () => {
    const harmed = [{ cassetteId: 'target', decisionOrdinal: 1, origin: 'target-step',
      verdictPresent: true, axes: ['headline'] }]
    expect(GateReceiptSchema.parse({ ...completeGate1(), harmed })).toMatchObject({ harmed })
  })
  it('refuses unknown reasons, empty harm axes, invalid caps and unknown nested fields', () => {
    const base = completeGate1()
    const harm = { cassetteId: 'c', decisionOrdinal: 0, origin: 'gate-set',
      verdictPresent: true, axes: [] }
    for (const value of [
      { ...base, reasons: ['bogus'] }, { ...base, cap: { maxScreens: 0 } },
      { ...base, harmed: [harm] }, { ...base, spend: { ...base.spend, extra: 1 } },
      { ...base, targets: [{ ...base.targets[0], extra: 1 }] },
      { ...base, population: { ...base.population, extra: 1 } },
      { ...base, productFloor: { ...base.productFloor, extra: 1 } },
      { ...base, generalization: { ...base.generalization, extra: 1 } },
      { ...base, baselineSource: { ...base.baselineSource, extra: 1 } },
      { ...base, judge: { ...base.judge, extra: 1 } },
      { ...base, samples: { ...base.samples, detail: [{ ...base.samples.detail[0], extra: 1 }] } },
      { ...base, scalarScore: 1 },
    ]) expect(GateReceiptSchema.safeParse(value).success).toBe(false)
  })
  it('round-trips candidate DATA and absence, refusing missing rendered bytes and unknown keys', () => {
    const injection = { candidateId: 'candidate', kind: 'fact', product: 'checkout',
      scope: { tier: 'product', key: 'checkout' }, anchors: [], status: 'candidate',
      line: { id: 'candidate', kind: 'fact', summary: 'Checkout', trust: 0.5,
        status: 'candidate', servedAsCanary: false, tier: 'L2' },
      renderedLine: '[observation] Checkout',
      provenance: { runIds: ['run'], receiptDigests: [], capturedAtOrdinals: [42] },
      target: { runId: 'run', stepIndex: 0, testId: 'test', sourceBuildOrdinal: 42 },
      latestOrdinal: 42 }
    expect(CandidateInjectionSchema.parse(injection)).toEqual(injection)
    const { renderedLine: _renderedLine, ...missing } = injection
    for (const value of [missing, { ...injection, renderedLine: '' }, { ...injection, extra: 1 },
      { ...injection, target: { ...injection.target, extra: 1 } },
      { ...injection, provenance: { ...injection.provenance, extra: 1 } },
      { ...injection, line: { ...injection.line, extra: 1 } },
    ]) expect(CandidateInjectionSchema.safeParse(value).success).toBe(false)
    for (const result of [{ kind: 'found', injection }, { kind: 'not-found', recordId: 'missing' }]) {
      expect(KnowledgeCandidateInjectionResultSchema.parse(result)).toEqual(result)
    }
  })
})
function gate3() {
  return stampReceiptDigest({ ...core(), gate: 3 as const, runId: 'run', stepId: 'step',
    mark: 'confirmed-bug' as const })
}
function promotion(promotionPath: 'deterministic-verdict-floor' | 'user-sovereign') {
  return stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion' as const,
    candidateId: 'candidate', producedAtOrdinal: 5, producedBy: {}, promotionPath,
    citedReceiptDigests: [] })
}

describe('strict complete receipt vocabulary', () => {
  it('parses a complete Gate-1 receipt and round-trips its content digest', () => {
    const receipt = gate1()
    expect(GateReceiptSchema.safeParse(receipt).success).toBe(true)
    const parsed = GateReceiptSchema.parse(receipt)
    expect(parsed).toEqual(receipt)
    expect(receiptDigestOf(parsed)).toBe(receipt.receiptDigest)
  })
  it('refuses missing samples, missing loop and an unknown cross check', () => {
    const { samples: _samples, ...missingSamples } = gate1()
    const { loop: _loop, ...missingLoop } = gate1().perAxisScore
    for (const receipt of [missingSamples, { ...gate1(), perAxisScore: missingLoop },
      { ...gate1(), crossCheck: 'maybe' }]) {
      expect(GateReceiptSchema.safeParse(receipt).success).toBe(false)
    }
  })
  it('parses Gate-3 marks with or without stepId and refuses cross-arm fields', () => {
    expect(GateReceiptSchema.safeParse(gate3()).success).toBe(true)
    const { stepId: _stepId, ...withoutStep } = gate3()
    expect(GateReceiptSchema.safeParse(withoutStep).success).toBe(true)
    const parsed = GateReceiptSchema.safeParse({ ...gate3(), corpusVersion: gate1().corpusVersion })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['corpusVersion'] }),
    ]))
    expect(GateReceiptSchema.safeParse({ ...gate3(), mark: 'confirmed-defect' }).success).toBe(false)
  })
  it('refuses gate 4, unknown verdict and an unknown promotion path', () => {
    expect(GateReceiptSchema.safeParse({ ...gate1(), gate: 4 }).success).toBe(false)
    expect(GateReceiptSchema.safeParse({ ...gate1(), verdict: 'maybe' }).success).toBe(false)
    expect(PromotionReceiptSchema.safeParse({ ...promotion('deterministic-verdict-floor'), promotionPath: 'gate4' }).success).toBe(false)
  })
  it('keeps every evidence object strict and enforces counts and digest bounds', () => {
    const receipt = gate1()
    for (const invalid of [
      { ...receipt, perAxisScore: { ...receipt.perAxisScore, extra: receipt.perAxisScore.loop } },
      { ...receipt, perAxisScore: { ...receipt.perAxisScore, loop: { ...receipt.perAxisScore.loop, extra: 1 } } },
      { ...receipt, perAxisScore: { ...receipt.perAxisScore, loop: { ...receipt.perAxisScore.loop, n: -1 } } },
      { ...receipt, corpusVersion: { ...receipt.corpusVersion, minimumGateSet: 0 } },
      { ...receipt, corpusVersion: { ...receipt.corpusVersion, corpusDigest: 'bad' } },
      { ...receipt, corpusVersion: { ...receipt.corpusVersion, extra: 1 } },
      { ...receipt, samples: { ...receipt.samples, k: 0 } },
      { ...receipt, samples: { ...receipt.samples, seeds: [1.5] } },
      { ...receipt, samples: { ...receipt.samples, extra: 1 } },
      { ...receipt, noiseFloorRef: { ...receipt.noiseFloorRef, extra: 1 } },
      { ...receipt, degradation: 'unknown' },
    ]) expect(GateReceiptSchema.safeParse(invalid).success).toBe(false)
  })
  it('selects the greatest ordinal and breaks ties with the later line', () => {
    const first = GateReceiptSchema.parse(gate1())
    const failed = GateReceiptSchema.parse({ ...gate1(), verdict: 'fail', producedAtOrdinal: 9 })
    const second = GateReceiptSchema.parse({ ...gate3(), producedAtOrdinal: 9 })
    const later = GateReceiptSchema.parse({ ...gate1(), producedAtOrdinal: 9 })
    expect(standingReceiptsByGate([first, failed, second, later])).toEqual([later, second])
  })
  it('selects the strongest promotion path and leaves absent history undefined', () => {
    expect(strongestPromotionPath([])).toBeUndefined()
    expect(strongestPromotionPath([promotion('deterministic-verdict-floor')])).toBe('deterministic-verdict-floor')
    expect(strongestPromotionPath([promotion('user-sovereign'), promotion('deterministic-verdict-floor')])).toBe('user-sovereign')
  })
})
