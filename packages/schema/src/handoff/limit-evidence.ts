import type { PlannerLimits } from '../config/planner-limits'

// Present only when a limit refused a dispatch; it is never a failure, a termination or a verdict.
export interface LimitStopEvidence {
  limit: 'actions' | 'planning-turns'
  configured: number
  used: number
  reason: string
  // The verifier judges the stop once; its verdicts sit in `StepEvidence.conditionVerdicts`.
  requestedOutcome: 'unverified'
  /** The last verifier rejection's reasoning, masked-before-record. */
  lastVerifierRejection?: string
  /** The planner's last stated reasoning, masked-before-record. */
  lastPlannerReasoning?: string
}

// A compound action's inner inputs count once against the action limit.
export interface CompoundInputCount {
  subActionIndex: number
  kind: 'scroll' | 'fill'
  count: number
}

export interface StepLimitUsage {
  limits: PlannerLimits
  actionsUsed: number
  planningCallsUsed: number
  verifierCalls: number
  judgeCalls: number
  compoundInputs?: CompoundInputCount[]
}

export const LIMIT_STOP_EVIDENCE_KEYS = [
  'limit',
  'configured',
  'used',
  'reason',
  'requestedOutcome',
  'lastVerifierRejection',
  'lastPlannerReasoning',
] as const satisfies readonly (keyof LimitStopEvidence)[]

export const STEP_LIMIT_USAGE_KEYS = [
  'limits',
  'actionsUsed',
  'planningCallsUsed',
  'verifierCalls',
  'judgeCalls',
  'compoundInputs',
] as const satisfies readonly (keyof StepLimitUsage)[]

/** The plain reason a limit stop reads with, e.g. "Stopped: action limit reached — 30 of 30 actions used". */
export function formatLimitStopReason(
  limit: LimitStopEvidence['limit'],
  configured: number,
  used: number,
): string {
  return limit === 'actions'
    ? `Stopped: action limit reached — ${used} of ${configured} actions used`
    : `Stopped: planning-turn limit reached — ${used} of ${configured} planner calls used`
}
