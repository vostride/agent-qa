import { z } from 'zod'
import { canonicalJson } from '../determinism/canonical-json'
import { sha256hex } from '../determinism/sha256'
import { PROMOTION_PATHS, strongerPromotionPath, type PromotionPath } from './promotion-path'

export const GATE_RECEIPT_SCHEMA_VERSION = 2
export type GateNumber = 1 | 3
export type GateVerdict = 'pass' | 'fail' | 'abstain'
// prettier-ignore
export const GATE_NUMBERS = [1, 3] as const satisfies readonly GateNumber[]
// prettier-ignore
export const GATE_VERDICTS = ['pass', 'fail', 'abstain'] as const satisfies readonly GateVerdict[]
export type PerAxisScoreAxis = 'headline' | 'elementIdentity' | 'value' | 'opClass' | 'sideEffect' | 'loop'
// 416 D-02: mirror the neutral axis names; schema never depends on eval.
// prettier-ignore
export const PER_AXIS_SCORE_AXES = ['headline', 'elementIdentity', 'value', 'opClass', 'sideEffect', 'loop'] as const satisfies readonly PerAxisScoreAxis[]
export type CrossCheck = 'flipped' | 'held' | 'inconclusive' | 'not-run'
// prettier-ignore
export const CROSS_CHECKS = ['flipped', 'held', 'inconclusive', 'not-run'] as const satisfies readonly CrossCheck[]
export type Degradation = 'replay-diff' | 'tier-not-implemented'
// prettier-ignore
export const DEGRADATIONS = ['replay-diff', 'tier-not-implemented'] as const satisfies readonly Degradation[]
// 2026-09-07, 417 D-02/D-06/D-09/D-13/D-19/D-20: declaration order is precedence.
// The first applicable reason decides; same-family-refused is disclosure-only and never decides.
export type Gate1Reason = 'tier-not-implemented' | 'unprovenanced-candidate' | 'empty-gate-set' | 'target-unavailable' | 'baseline-uncached' | 'collateral-unscorable' | 'cap-exceeded' | 'no-positive-value' | 'collateral-harm' | 'target-not-reproduced' | 'inconclusive' | 'same-family-refused'
// prettier-ignore
export const GATE1_REASONS = ['tier-not-implemented', 'unprovenanced-candidate', 'empty-gate-set', 'target-unavailable', 'baseline-uncached', 'collateral-unscorable', 'cap-exceeded', 'no-positive-value', 'collateral-harm', 'target-not-reproduced', 'inconclusive', 'same-family-refused'] as const satisfies readonly Gate1Reason[]
export type Gate1TargetSource = 'committed' | 'extracted'
// prettier-ignore
export const GATE1_TARGET_SOURCES = ['committed', 'extracted'] as const satisfies readonly Gate1TargetSource[]
export type Gate1KSource = 'flag' | 'config' | 'default'
// prettier-ignore
export const GATE1_K_SOURCES = ['flag', 'config', 'default'] as const satisfies readonly Gate1KSource[]
// 417 D-01/D-03: post-exclusion collateral versus siblings at the target's step.
export type Gate1HarmOrigin = 'gate-set' | 'target-step'
// prettier-ignore
export const GATE1_HARM_ORIGINS = ['gate-set', 'target-step'] as const satisfies readonly Gate1HarmOrigin[]
export type Benefit = 'exercised-benefited' | 'rode-along' | 'exercised-harmed'
// prettier-ignore
export const BENEFITS = ['exercised-benefited', 'rode-along', 'exercised-harmed'] as const satisfies readonly Benefit[]
export type Mark = 'false-fail' | 'false-pass' | 'confirmed-bug'
// prettier-ignore
export const MARKS = ['false-fail', 'false-pass', 'confirmed-bug'] as const satisfies readonly Mark[]
export type StateValidity = 'valid' | 'stale' | 'unknown'
// prettier-ignore
export const STATE_VALIDITIES = ['valid', 'stale', 'unknown'] as const satisfies readonly StateValidity[]
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const count = z.number().int().nonnegative()
export const gate1CapSchema = z.object({ maxScreens: z.number().int().min(1) }).strict()
export const gate1SpendSchema = z.object({
  screens: count, modelCalls: count, promptTokens: count, completionTokens: count, wallClockMs: count,
}).strict()
export const gate1TargetSchema = z.object({
  cassetteId: z.string().min(1), stepIndex: count, decisionOrdinal: count,
  runId: z.string().min(1), source: z.enum(GATE1_TARGET_SOURCES),
  baselineCorrect: z.boolean(), candidateCorrect: z.boolean(),
  baselineBriefSource: z.string(), candidateBriefSource: z.string(),
}).strict()
// Mirror LabelTier, LabelSourceChannel and CorpusEntry split/heldOutVisibility without importing eval.
// Extracted target-step siblings have no CorpusEntry, so split and visibility are optional.
export const gate1HarmedSchema = z.object({
  cassetteId: z.string().min(1), stepIndex: count.optional(), decisionOrdinal: count,
  origin: z.enum(GATE1_HARM_ORIGINS), labelTier: z.string().optional(),
  sourceChannel: z.string().optional(), verdictPresent: z.boolean(), split: z.string().optional(),
  heldOutVisibility: z.string().optional(), axes: z.array(z.enum(PER_AXIS_SCORE_AXES)).min(1),
  softWeight: z.number().finite().min(0).max(1).optional(),
}).strict()
export const axisScoreSchema = z.object({
  baseline: z.number(), candidate: z.number(), delta: z.number(), floor: z.number(),
  n: z.number().int().nonnegative(),
}).strict()
export const perAxisScoreSchema = z.object({
  headline: axisScoreSchema, elementIdentity: axisScoreSchema, value: axisScoreSchema,
  opClass: axisScoreSchema, sideEffect: axisScoreSchema, loop: axisScoreSchema,
}).strict()
export const corpusVersionSchema = z.object({
  corpusDigest: sha256,
  partitionVersion: z.number().int().nonnegative(),
  gateSetSize: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
  minimumGateSet: z.number().int().min(1),
}).strict()
export const samplesSchema = z.object({
  k: z.number().int().min(1), seeds: z.array(z.number().int()), seedHonored: z.boolean(),
  modelCalls: z.number().int().nonnegative(),
  detail: z.array(z.object({
    withRecord: z.boolean(), seed: z.number().int(), matchesGold: z.boolean(), kind: z.string(),
  }).strict()).optional(),
}).strict()
export const noiseFloorRefSchema = z.object({
  profileKey: z.string().min(1), corpusDigest: sha256,
}).strict()
const receiptCoreShape = {
  schemaVersion: z.literal(GATE_RECEIPT_SCHEMA_VERSION),
  candidateId: z.string().min(1),
  verdict: z.enum(GATE_VERDICTS),
  producedAtOrdinal: z.number().int().nonnegative(),
  producedBy: z.object({ jobId: z.string().optional(), opId: z.string().optional() }).strict(),
  receiptDigest: sha256,
}
// 416 D-01/D-02: each strict arm only accepts evidence that its gate measures.
export const gate1ArmSchema = z.object({
  ...receiptCoreShape, gate: z.literal(1), perAxisScore: perAxisScoreSchema,
  corpusVersion: corpusVersionSchema, samples: samplesSchema, crossCheck: z.enum(CROSS_CHECKS),
  judgeId: z.string().optional(), degradation: z.enum(DEGRADATIONS).optional(),
  noiseFloorRef: noiseFloorRefSchema.optional(),
  reasons: z.array(z.enum(GATE1_REASONS)).optional(),
  cap: gate1CapSchema.optional(),
  spend: gate1SpendSchema.optional(),
  kSource: z.enum(GATE1_K_SOURCES).optional(),
  targets: z.array(gate1TargetSchema).optional(),
  harmed: z.array(gate1HarmedSchema).optional(),
  unverifiedFlips: z.array(gate1HarmedSchema).optional(),
  population: z.object({
    proof: count, empty: count, rendered: count, refused: count, renderedExcluded: count,
  }).strict().optional(),
  floorAbsentAxes: z.array(z.enum(PER_AXIS_SCORE_AXES)).optional(),
  productFloor: z.object({
    product: z.string(), axes: z.array(z.object({
      axis: z.enum(PER_AXIS_SCORE_AXES), floor: z.number().nullable(), n: count,
    }).strict()),
  }).strict().optional(),
  generalization: z.object({
    ratio: z.number().optional(), ci: z.tuple([z.number(), z.number()]).optional(),
    liftDecisions: count, minimumLiftDecisions: count,
  }).strict().optional(),
  baselineSource: z.object({
    runRoot: z.string(), seed: z.number().int(), seedSource: z.string(),
  }).strict().optional(),
  judge: z.object({
    eligibility: z.string(), overrideConfigured: z.boolean(),
    panelSize: z.number().int().min(2).optional(),
    members: z.array(z.object({ judgeModelId: z.string().min(1), judgeFamily: z.string() }).strict()).optional(),
  }).strict().refine(judge => judge.panelSize === undefined
    ? judge.members === undefined : judge.members?.length === judge.panelSize,
  'panel size and complete member metadata must appear together').optional(),
}).strict()
export const gate3ArmSchema = z.object({
  ...receiptCoreShape, gate: z.literal(3), runId: z.string().min(1).optional(),
  stepId: z.string().optional(), mark: z.enum(MARKS).optional(),
  // 419 D-17: accepting a policy is not a run mark. Preserve its actual proposal identity.
  policyApproval: z.object({ proposalId: z.string().min(1), recordId: z.string().min(1) }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.policyApproval === undefined) {
    if (value.runId === undefined || value.mark === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Gate 3 requires a complete run mark or policy approval' })
    }
  } else if (value.runId !== undefined || value.mark !== undefined || value.stepId !== undefined
    || value.policyApproval.recordId !== value.candidateId) {
    ctx.addIssue({ code: 'custom', message: 'policy approval must name this candidate and cannot carry a run mark' })
  }
})
export const GateReceiptSchema = z.discriminatedUnion('gate', [
  gate1ArmSchema, gate3ArmSchema,
])
export const PromotionReceiptSchema = z.object({
  schemaVersion: receiptCoreShape.schemaVersion,
  kind: z.literal('promotion'),
  candidateId: receiptCoreShape.candidateId,
  promotionPath: z.enum(PROMOTION_PATHS),
  citedReceiptDigests: z.array(sha256),
  producedAtOrdinal: receiptCoreShape.producedAtOrdinal,
  producedBy: receiptCoreShape.producedBy,
  receiptDigest: sha256,
}).strict()
export const GateLineSchema = z.union([GateReceiptSchema, PromotionReceiptSchema])
export type GateReceipt = z.infer<typeof GateReceiptSchema>
export type Gate1Receipt = Extract<GateReceipt, { gate: 1 }>
export type Gate3Receipt = Extract<GateReceipt, { gate: 3 }>
export type PromotionReceipt = z.infer<typeof PromotionReceiptSchema>
export type GateLine = z.infer<typeof GateLineSchema>
type WithoutDigest<T> = T extends unknown ? Omit<T, 'receiptDigest'> : never

export function receiptDigestOf(line: GateLine): string {
  const { receiptDigest: _receiptDigest, ...rest } = line
  return sha256hex(canonicalJson(rest))
}
export function stampReceiptDigest<T extends WithoutDigest<GateLine>>(line: T): T & { receiptDigest: string } {
  return { ...line, receiptDigest: sha256hex(canonicalJson(line)) }
}
export function isPromotionReceipt(line: GateLine): line is PromotionReceipt {
  return 'kind' in line && line.kind === 'promotion'
}
export function standingReceiptsByGate(receipts: readonly GateReceipt[]): GateReceipt[] {
  const standing = new Map<GateNumber, GateReceipt>()
  for (const receipt of receipts) {
    const previous = standing.get(receipt.gate)
    if (previous === undefined || receipt.producedAtOrdinal >= previous.producedAtOrdinal) {
      standing.set(receipt.gate, receipt)
    }
  }
  return GATE_NUMBERS.flatMap(gate => {
    const receipt = standing.get(gate)
    return receipt === undefined ? [] : [receipt]
  })
}
export function strongestPromotionPath(lines: readonly GateLine[]): PromotionPath | undefined {
  let strongest: PromotionPath | undefined
  for (const line of lines) {
    if (isPromotionReceipt(line)) {
      strongest = strongest === undefined ? line.promotionPath
        : strongerPromotionPath(strongest, line.promotionPath)
    }
  }
  return strongest
}
