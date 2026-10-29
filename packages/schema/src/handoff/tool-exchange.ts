import type { ModelCallRecord } from './model-call-profile'

/**
 * The ordered record of one executed non-action tool call within the planning turn
 * that produced a decision. Values arrive masked before recording
 * under the T-360-01 discipline and retain full fidelity: no truncation, size
 * cap, or artifact spillover is applied because upstream `guardBlob` already bounded
 * what entered the model conversation. Consumers must treat `args` and `result` as
 * opaque data and must never execute them.
 */
export interface ToolExchangeEvidence {
  tool: string
  args: Record<string, unknown>
  result: unknown
}

/**
 * The dedicated step-level evidence block for a structurally failed planning turn
 * It preserves every exchange from the failed turn without overloading
 * `TerminationEvidence`; `reason` carries the runner failure literal as a plain string
 * so this schema stays runner-agnostic, and `message` arrives masked.
 */
export interface PlanningFailureEvidence {
  reason: string
  message: string
  exchanges: ToolExchangeEvidence[]
  callRecord?: ModelCallRecord
}
