import type { Action } from '../action/index'
import type { ArtifactRef } from '../ids/artifact-ref'
import type { RecordedActionResult } from '../result/index'
import type { ScreenState } from '../screen/screen-state'
import type { GroundingEvidence } from '../screen/target-descriptor'
import type { ModelCallRecord } from './model-call-profile'
import type { OperationEvidence } from './operation-evidence'
import type { LocalEffectEvidence } from './progress-evidence'
import type { ToolExchangeEvidence } from './tool-exchange'

export interface SubActionEvidence {
  plan: string
  plannedAction: Action
  stateBefore: ScreenState
  stateAfter?: ScreenState
  result: RecordedActionResult
  decisionScreenshotRef?: ArtifactRef
  artifactRefs?: ArtifactRef[]
  /**
   * The ordered non-action tool exchanges from the live planning turn that produced this
   * decision. Present, possibly empty, for live-turn decisions and structurally
   * absent for cache-hit or replayed sub-actions; values arrive masked under D-02.
   */
  exchanges?: ToolExchangeEvidence[]
  /**
   * Observed enrichment for the live call that produced this decision.
   * Absent when no live model call happened; unknown values are never fabricated.
   */
  callRecord?: ModelCallRecord
  /**
   * The §A8 grounding evidence. Present only when the grounder ran for
   * this sub-action: it carries the descriptor the planner emitted plus one attempt
   * entry per ladder rung run — an unattempted visual rung records outcome 'skipped',
   * and `resolvedRef` is present only on a 'resolved' rung.
   */
  grounding?: GroundingEvidence
  /**
   * The §A8 differential-observation oracle outcome. Present only when
   * the per-verb intended-effect oracle ran for this sub-action: which oracle row keyed
   * on the verb class and whether the action's local intended effect was achieved.
   */
  localEffect?: LocalEffectEvidence
  /**
   * What this action produced outside the page: the downloads it started, and the
   * clipboard writes the app made. Absent when the action produced none; values arrive masked.
   */
  operationEvidence?: OperationEvidence
  // plannedAction/stateBefore stay the planner's own; a heal that
  // re-dispatched records what it sent here (optional-additive).
  healedDispatch?: { action: Action; stateBefore: ScreenState }
}

export function actedPair(
  subAction: SubActionEvidence,
): { action: Action; stateBefore: ScreenState } {
  return subAction.healedDispatch ?? {
    action: subAction.plannedAction,
    stateBefore: subAction.stateBefore,
  }
}

export function isRedispatchedHeal(subAction: SubActionEvidence): boolean {
  return subAction.healedDispatch !== undefined
}
