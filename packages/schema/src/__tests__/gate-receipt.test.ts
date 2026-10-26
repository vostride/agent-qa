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
function gate3() {
  return stampReceiptDigest({ ...core(), gate: 3 as const, runId: 'run', stepId: 'step',
    mark: 'confirmed-bug' as const })
}
function promotion(promotionPath: 'deterministic-verdict-floor' | 'user-sovereign') {
  return stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion' as const,
    candidateId: 'candidate', producedAtOrdinal: 5, producedBy: {}, promotionPath,
    citedReceiptDigests: [] })
}

describe('strict mark and approval receipt vocabulary', () => {
  it('parses marks with or without stepId and refuses unknown fields', () => {
    expect(GateReceiptSchema.safeParse(gate3()).success).toBe(true)
    const { stepId: _stepId, ...withoutStep } = gate3()
    expect(GateReceiptSchema.safeParse(withoutStep).success).toBe(true)
    const parsed = GateReceiptSchema.safeParse({ ...gate3(), judgeId: 'judge' })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['judgeId'] }),
    ]))
    expect(GateReceiptSchema.safeParse({ ...gate3(), mark: 'confirmed-defect' }).success).toBe(false)
  })
  it('refuses gate 1, gate 4, unknown verdict and an unknown promotion path', () => {
    expect(GateReceiptSchema.safeParse({ ...gate3(), gate: 1 }).success).toBe(false)
    expect(GateReceiptSchema.safeParse({ ...gate3(), gate: 4 }).success).toBe(false)
    expect(GateReceiptSchema.safeParse({ ...gate3(), verdict: 'maybe' }).success).toBe(false)
    expect(PromotionReceiptSchema.safeParse({ ...promotion('deterministic-verdict-floor'), promotionPath: 'gate4' }).success).toBe(false)
  })
  it('selects the greatest ordinal and breaks ties with the later line', () => {
    const first = GateReceiptSchema.parse(gate3())
    const failed = GateReceiptSchema.parse({ ...gate3(), verdict: 'fail', producedAtOrdinal: 9 })
    const later = GateReceiptSchema.parse({ ...gate3(), mark: 'false-fail', producedAtOrdinal: 9 })
    const earlier = GateReceiptSchema.parse({ ...gate3(), producedAtOrdinal: 4 })
    expect(standingReceiptsByGate([first, failed, later, earlier])).toEqual([later])
  })
  it('selects the strongest promotion path and leaves absent history undefined', () => {
    expect(strongestPromotionPath([])).toBeUndefined()
    expect(strongestPromotionPath([promotion('deterministic-verdict-floor')])).toBe('deterministic-verdict-floor')
    expect(strongestPromotionPath([promotion('user-sovereign'), promotion('deterministic-verdict-floor')])).toBe('user-sovereign')
  })
})
