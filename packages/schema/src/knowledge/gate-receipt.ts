import { z } from 'zod'
import { canonicalJson } from '../determinism/canonical-json'
import { sha256hex } from '../determinism/sha256'
import { PROMOTION_PATHS, strongerPromotionPath, type PromotionPath } from './promotion-path'

export const GATE_RECEIPT_SCHEMA_VERSION = 2
export type GateNumber = 3
export type GateVerdict = 'pass' | 'fail' | 'abstain'
// prettier-ignore
export const GATE_NUMBERS = [3] as const satisfies readonly GateNumber[]
// prettier-ignore
export const GATE_VERDICTS = ['pass', 'fail', 'abstain'] as const satisfies readonly GateVerdict[]
export type Benefit = 'exercised-benefited' | 'rode-along' | 'exercised-harmed'
// prettier-ignore
export const BENEFITS = ['exercised-benefited', 'rode-along', 'exercised-harmed'] as const satisfies readonly Benefit[]
export type Mark = 'false-fail' | 'false-pass' | 'confirmed-bug'
// prettier-ignore
export const MARKS = ['false-fail', 'false-pass', 'confirmed-bug'] as const satisfies readonly Mark[]
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const receiptCoreShape = {
  schemaVersion: z.literal(GATE_RECEIPT_SCHEMA_VERSION),
  candidateId: z.string().min(1),
  verdict: z.enum(GATE_VERDICTS),
  producedAtOrdinal: z.number().int().nonnegative(),
  producedBy: z.object({ jobId: z.string().optional(), opId: z.string().optional() }).strict(),
  receiptDigest: sha256,
}
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
export const GateReceiptSchema = gate3ArmSchema
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
export type Gate3Receipt = GateReceipt
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
