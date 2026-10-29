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
  // Possibly empty on live-turn decisions, absent on cache hits and replays; values are masked.
  exchanges?: ToolExchangeEvidence[]
  // Absent when no live model call happened; unknown values are never fabricated.
  callRecord?: ModelCallRecord
  // One attempt per rung run; an unattempted visual rung records `skipped`.
  grounding?: GroundingEvidence
  // Present only when the per-verb intended-effect oracle ran for this sub-action.
  localEffect?: LocalEffectEvidence
  // Absent when the action produced nothing outside the page; values arrive masked.
  operationEvidence?: OperationEvidence
  // `plannedAction` stays the planner's; a heal that re-dispatched records what it sent here.
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
