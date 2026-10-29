// The shared matcher and the rung-composed ladder, used by the gate and cache replay.

export { matchDescriptor } from './matcher.js'
export type {
  DescriptorInput,
  DescriptorMatchInput,
  MatchResult,
  PriorContext,
} from './matcher.js'

export { assembleLadder, refValidateRung, runLadder, treeSearchRung } from './rungs.js'
export type {
  GroundingRung,
  LadderOptions,
  RunLadderResult,
  RungOutcome,
  RungRequest,
} from './rungs.js'

export { groundActionPlan } from './gate.js'
export type { GateOptions, GateResult, GateVisualRung, GroundActionPlanInput } from './gate.js'

export { judgeStatedTarget, renderTargetMismatch, ROLE_KIND } from './stated-target.js'
export type {
  RoleKind,
  StatedTarget,
  StatedTargetJudgement,
  StatedTargetLane,
  StatedTargets,
  TargetIdentity,
  TargetMismatchInput,
  TargetMismatchReason,
} from './stated-target.js'

export { ROW_CONTAINER_ROLES, rowContains, rowTextOf, wordTokens } from './row-text.js'

export { strictMatch, tidyName } from './strict-match.js'
export type { StrictMatchResult, StrictTarget } from './strict-match.js'
