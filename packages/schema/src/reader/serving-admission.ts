import { canonicalJson } from '../determinism/canonical-json'
import type { Anchor } from '../identity/anchor'
import { normalizeAnchor } from '../identity/normalize-anchor'
import type { RecordId } from '../ids/record-id'

/**
 * Exact per-record material required to enforce serving-volume and poisoning limits after a
 * reader selection crosses a package boundary. `renderedCost` is the cost of the bytes exposed
 * on that channel, not the source record body.
 */
export interface ServingRecordMetadata {
  readonly id: RecordId
  readonly sourceId: string
  readonly clusterKey: string
  readonly renderedCost: number
}

// Every serving channel clusters by this one precise-first key.
export function servingClusterKey(anchors: readonly Anchor[]): string {
  const element = anchors.find((anchor) => anchor.t === 'el')
  if (element !== undefined) {
    const { ordinal: _ordinal, ...identity } = normalizeAnchor(element) as Extract<
      Anchor,
      { t: 'el' }
    >
    return canonicalJson(identity)
  }

  const flow = anchors.find((anchor) => anchor.t === 'flow')
  if (flow !== undefined) return canonicalJson(normalizeAnchor(flow))

  const page = anchors.find((anchor) => anchor.t === 'page')
  if (page !== undefined) {
    return (normalizeAnchor(page) as Extract<Anchor, { t: 'page' }>).route
  }

  // Records without a Pin-2 identity anchor deliberately share one conservative cluster.
  return canonicalJson([])
}

export function servingRecordMetadata(input: {
  id: RecordId
  anchors: readonly Anchor[]
  renderedCost: number
  sourceId?: string
}): ServingRecordMetadata {
  return {
    id: input.id,
    sourceId: input.sourceId ?? String(input.id),
    clusterKey: servingClusterKey(input.anchors),
    renderedCost: input.renderedCost,
  }
}

export type ServingAdmissionRejectionReason =
  | 'volume-cap'
  | 'budget-cap'
  | 'source-dominance'
  | 'cluster-dominance'

export type ServingAdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: ServingAdmissionRejectionReason }

export interface ServingAdmissionState {
  readonly selectedIds: Set<string>
  readonly sourceCosts: Map<string, number>
  readonly clusterCosts: Map<string, number>
  selectedCount: number
  usedBudget: number
}

export interface ServingAdmissionInput {
  readonly record: ServingRecordMetadata
  readonly budget: number
  readonly recordCap: number
  /** Charge a repeated cross-channel exposure while keeping its distinct-record slot free. */
  readonly chargeRepeated?: boolean
}

function normalizeLimit(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export function createServingAdmissionState(
  seeds: readonly ServingRecordMetadata[] = [],
): ServingAdmissionState {
  const state: ServingAdmissionState = {
    selectedIds: new Set<string>(),
    sourceCosts: new Map<string, number>(),
    clusterCosts: new Map<string, number>(),
    selectedCount: 0,
    usedBudget: 0,
  }

  // Seeds have already crossed a serving boundary (the frozen brief), so retain their exact
  // material even if an upstream bug handed us an over-limit set. Later admissions still fail
  // closed against the accumulated costs.
  for (const seed of seeds) commitServingRecord(seed, state, true)
  return state
}

/** Pure preview used when channel-local and combined-turn authorities must commit atomically. */
export function inspectServingRecord(
  input: ServingAdmissionInput,
  state: ServingAdmissionState,
): ServingAdmissionDecision {
  const budget = normalizeLimit(input.budget)
  const recordCap = normalizeLimit(input.recordCap)
  const cost = normalizeLimit(input.record.renderedCost)
  const id = String(input.record.id)
  const repeated = state.selectedIds.has(id)
  const chargeCost = !repeated || input.chargeRepeated === true

  if (!repeated && state.selectedCount >= recordCap) {
    return { admitted: false, reason: 'volume-cap' }
  }
  if (!chargeCost) return { admitted: true }
  if (cost === 0 || state.usedBudget + cost > budget) {
    return { admitted: false, reason: 'budget-cap' }
  }

  const nextSourceCost = (state.sourceCosts.get(input.record.sourceId) ?? 0) + cost
  const nextClusterCost = (state.clusterCosts.get(input.record.clusterKey) ?? 0) + cost
  // The ratified boundary is integer-only: equality is admitted; strictly above is refused.
  if (2 * nextSourceCost > budget) {
    return { admitted: false, reason: 'source-dominance' }
  }
  if (2 * nextClusterCost > budget) {
    return { admitted: false, reason: 'cluster-dominance' }
  }
  return { admitted: true }
}

function commitServingRecord(
  record: ServingRecordMetadata,
  state: ServingAdmissionState,
  chargeRepeated = false,
): void {
  const id = String(record.id)
  const repeated = state.selectedIds.has(id)
  if (!repeated) {
    state.selectedIds.add(id)
    state.selectedCount += 1
  }
  if (repeated && !chargeRepeated) return

  const cost = normalizeLimit(record.renderedCost)
  state.sourceCosts.set(record.sourceId, (state.sourceCosts.get(record.sourceId) ?? 0) + cost)
  state.clusterCosts.set(record.clusterKey, (state.clusterCosts.get(record.clusterKey) ?? 0) + cost)
  state.usedBudget += cost
}

/** Shared greedy admission authority for brief, caution, search, and combined-turn ledgers. */
export function tryAdmitServingRecord(
  input: ServingAdmissionInput,
  state: ServingAdmissionState,
): ServingAdmissionDecision {
  const decision = inspectServingRecord(input, state)
  if (decision.admitted) {
    commitServingRecord(input.record, state, input.chargeRepeated === true)
  }
  return decision
}
