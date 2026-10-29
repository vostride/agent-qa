// The anchor walk lives in schema; this module re-exports it and keeps only its own display key.

import {
  actedPair,
  type ResolvedElementEvidence,
  type StepEvidence,
  type SubActionEvidence,
} from '@vostride/agent-qa-schema'

export {
  actionRefs,
  classifySubActionRoute,
  elementAnchor,
  exercisedAnchors,
  resolvedElementEvidence,
  uniqueAnchors,
} from '@vostride/agent-qa-schema'
export type { ClassifiedRoute, ResolvedElementEvidence } from '@vostride/agent-qa-schema'

export function elementNaturalKey(evidence: ResolvedElementEvidence): string {
  return `${evidence.element.role}:${evidence.element.nameNormalized}:${evidence.ordinal}`
}

// Curation reads the pair a healed sub-action dispatched.
export function actedSubAction(subAction: SubActionEvidence): SubActionEvidence {
  const { action, stateBefore } = actedPair(subAction)
  return { ...subAction, plannedAction: action, stateBefore }
}

export function actedStep(step: StepEvidence): StepEvidence {
  return { ...step, subActions: step.subActions.map(actedSubAction) }
}
