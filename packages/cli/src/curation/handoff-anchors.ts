// The anchor-extraction walk moved to schema — this module re-exports it.
//
// `exercisedAnchors` and its helpers are pure over schema types and now have consumers on
// both sides of the package graph (the agent-side cluster function, 390's recurrence window,
// and this tail), so the ONE implementation lives in
// `@vostride/agent-qa-schema`'s identity module and every existing CLI call site keeps
// compiling unchanged through these re-exports. Only `elementNaturalKey` (this tail's own
// display key) and the dispatch-pair projection below stay local, consumed nowhere else.

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

// curation reads the pair a healed sub-action dispatched.
export function actedSubAction(subAction: SubActionEvidence): SubActionEvidence {
  const { action, stateBefore } = actedPair(subAction)
  return { ...subAction, plannedAction: action, stateBefore }
}

export function actedStep(step: StepEvidence): StepEvidence {
  return { ...step, subActions: step.subActions.map(actedSubAction) }
}
