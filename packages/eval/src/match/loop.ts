import type { ProcedureCassette } from '../cassette/cassette'
import type { DecisionIdentity } from '../replay/identity'
import {
  computeDecisionIdentity,
  decisionIdentityKey,
} from '../replay/identity'

// Leaf decisions are n/a; procedure decisions are clear or attributed.
export type LoopVerdict =
  | { kind: 'not-applicable' }
  | { kind: 'none' }
  | { kind: 'flagged'; priorStepIndex: number }

/** One recorded procedure decision available to later steps as loop history. */
export interface ProcedurePriorIdentity {
  /** Canonical key of the recorded gold decision identity. */
  identityKey: string
  /** Recorded screen-state digest used for the same-screen constraint. */
  screenStateHash: string
  /** Procedure step that supplied the prior decision. */
  stepIndex: number
}

/** Leaf cassettes carry no procedure history; an empty procedure prefix remains applicable. */
export type LoopHistory = readonly ProcedurePriorIdentity[] | 'leaf-no-history'

/**
 * Collect the gold identity of every recorded procedure decision in procedure order. Cache-served
 * and synthesized steps have no replayable gold decision and therefore contribute no history.
 */
export function collectProcedurePriorIdentities(
  cassette: ProcedureCassette,
): ProcedurePriorIdentity[] {
  const identities: ProcedurePriorIdentity[] = []
  for (const step of cassette.steps) {
    if (step.kind !== 'decision') continue
    const identity = computeDecisionIdentity(
      step.record.sidecar.goldAction,
      step.record.input.stateBefore.elements,
    )
    identities.push({
      identityKey: decisionIdentityKey(identity),
      screenStateHash: step.record.receipt.screenStateHash,
      stepIndex: step.stepIndex,
    })
  }
  return identities
}

// Detects identity repetition over recorded procedure history only.
export function computeLoopVerdict(
  candidateIdentity: DecisionIdentity,
  currentScreenStateHash: string,
  priorIdentities: LoopHistory,
): LoopVerdict {
  if (priorIdentities === 'leaf-no-history') return { kind: 'not-applicable' }
  const candidateKey = decisionIdentityKey(candidateIdentity)
  const repeated = priorIdentities.find(
    prior =>
      prior.screenStateHash === currentScreenStateHash && prior.identityKey === candidateKey,
  )
  return repeated === undefined
    ? { kind: 'none' }
    : { kind: 'flagged', priorStepIndex: repeated.stepIndex }
}
