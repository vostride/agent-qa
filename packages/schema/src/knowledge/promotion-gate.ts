import type { BundleKind, FactSubtype } from '../delta/envelope'
import type { Anchor } from '../identity/anchor'
import type { EvidenceToken } from '../ids/record-id'
import type { DistilledObservation } from './distilled-observation'
import type { OriginClass } from './outcome-event'
import type { BundleStatus } from './trust-fold'
import type { PromotionPath } from './promotion-path'
import { standingReceiptsByGate, type GateReceipt } from './gate-receipt'
export { PROMOTION_PATHS, PROMOTION_PATH_STRENGTH, strongerPromotionPath } from './promotion-path'
export type { PromotionPath } from './promotion-path'

export type PromotionOutcome =
  | { kind: 'promoted'; promotionPath: PromotionPath; citedReceiptDigests: readonly string[] }
  | { kind: 'already-active'; promotionPath?: PromotionPath }
export type GateReceiptRecordOutcome = { kind: 'appended' } | { kind: 'duplicate' }
export interface PromotionCandidateProvenance {
  runIds: readonly string[]
  receiptDigests: readonly string[]
  capturedAtOrdinals: readonly number[]
}

export type PromotionGateObservation = Pick<DistilledObservation, 'element' | 'error'>

/** Bundle-derivable evidence only; callers assemble this view from canonical bundle truth. */
export interface PromotionGateInput {
  kind: BundleKind
  subtype?: FactSubtype
  status: BundleStatus
  validityOpen: boolean
  anchors: readonly Anchor[]
  originClass: OriginClass
  withheld: boolean
  needsEnrichment: boolean
  evidenceIncomplete: boolean
  distilledObservations: readonly PromotionGateObservation[]
  /** Surviving code-derived confirmation identities from canonical outcome truth. */
  confirmedOutcomeEvidenceTokens: readonly EvidenceToken[]
  hasUserDeprecateInLineage: boolean
  memoryOffForAnchorGroup: boolean
  gateReceipts?: readonly GateReceipt[]
}

export type PromotionGateHoldReason =
  | 'kind-excluded'
  | 'not-candidate'
  | 'window-closed'
  | 'withheld'
  | 'needs-enrichment'
  | 'evidence-incomplete'
  | 'no-confirmed-evidence'
  | 'no-element-observation'
  | 'missing-root-cause'
  | 'memory-off-anchor'
  | 'user-deprecated'

/**
 * The runtime list of the hold-reason union. The `satisfies` clause rejects an entry that names
 * no member, and `__tests__/promotion-gate.test-d.ts` rejects a member no entry names.
 * `promotionHoldReason` is persisted in knowledge-local commit outcomes and printed by the CLI.
 */
export const PROMOTION_GATE_HOLD_REASONS = [
  'kind-excluded',
  'not-candidate',
  'window-closed',
  'withheld',
  'needs-enrichment',
  'evidence-incomplete',
  'no-confirmed-evidence',
  'no-element-observation',
  'missing-root-cause',
  'memory-off-anchor',
  'user-deprecated',
] as const satisfies readonly PromotionGateHoldReason[]

export type PromotionGateVerdict =
  | { verdict: 'promote'; promotionPath: PromotionPath; citedReceiptDigests: readonly string[] }
  | { verdict: 'hold'; reason: PromotionGateHoldReason }

function hold(reason: PromotionGateHoldReason): PromotionGateVerdict {
  return { verdict: 'hold', reason }
}

function floor(): PromotionGateVerdict {
  return { verdict: 'promote', promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [] }
}

function promotionElementAnchor(
  input: PromotionGateInput,
): Extract<Anchor, { t: 'el' }> | undefined {
  const primary = input.anchors[0]
  if (primary?.t === 'el') return primary
  if (primary?.t !== 'page' || input.subtype !== 'navigational') return undefined
  return input.anchors.find(
    (anchor): anchor is Extract<Anchor, { t: 'el' }> => anchor.t === 'el',
  )
}

function hasMatchingElementObservation(input: PromotionGateInput): boolean {
  const anchor = promotionElementAnchor(input)
  if (anchor?.ordinal === undefined) return false
  const naturalKey = `${anchor.role}:${anchor.name}:${anchor.ordinal}`
  const elements = input.distilledObservations.flatMap((observation) =>
    observation.element === undefined ? [] : [observation.element],
  )
  return elements.length === 1 && elements[0]?.naturalKey === naturalKey
}

/**
 * A standing Gate-3 pass (a person's mark or accepted policy) promotes on its own. Otherwise
 * promotion keys on durable evidence: a fact needs one matching element observation and a
 * caution a root-cause class. This pure predicate performs no loading.
 */
export function evaluatePromotionGate(input: PromotionGateInput): PromotionGateVerdict {
  if (input.kind !== 'fact' && input.kind !== 'caution') return hold('kind-excluded')
  if (input.status !== 'candidate') return hold('not-candidate')
  if (!input.validityOpen) return hold('window-closed')
  const g3 = standingReceiptsByGate(input.gateReceipts ?? []).find(receipt => receipt.gate === 3)
  if (g3?.verdict === 'pass') {
    return { verdict: 'promote', promotionPath: 'user-sovereign',
      citedReceiptDigests: [g3.receiptDigest] }
  }
  if (input.withheld) return hold('withheld')
  if (input.needsEnrichment) return hold('needs-enrichment')
  if (input.evidenceIncomplete) return hold('evidence-incomplete')
  if (!input.confirmedOutcomeEvidenceTokens.some((token) => token.length > 0)) {
    return hold('no-confirmed-evidence')
  }
  if (input.memoryOffForAnchorGroup) return hold('memory-off-anchor')
  if (input.hasUserDeprecateInLineage) return hold('user-deprecated')

  if (input.kind === 'fact') {
    return hasMatchingElementObservation(input) ? floor() : hold('no-element-observation')
  }

  return input.distilledObservations.some(
    (observation) => observation.error?.rootCauseClass !== undefined,
  )
    ? floor()
    : hold('missing-root-cause')
}
