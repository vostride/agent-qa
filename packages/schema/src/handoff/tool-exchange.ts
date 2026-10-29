import type { ModelCallRecord } from './model-call-profile'

// Masked, never truncated, as `guardBlob` bounded the input; never execute `args` or `result`.
export interface ToolExchangeEvidence {
  tool: string
  args: Record<string, unknown>
  result: unknown
}

// `reason` is a plain string so this schema stays runner-agnostic; `message` arrives masked.
export interface PlanningFailureEvidence {
  reason: string
  message: string
  exchanges: ToolExchangeEvidence[]
  callRecord?: ModelCallRecord
}
