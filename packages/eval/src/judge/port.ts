// Declares the async seam only; the binding lives in eval-local through `createModel`.

import type {
  JudgeConfidence,
  JudgeErrorReason,
  JudgeTokenUsage,
} from '../match/score'

// Physical A/B position tag; each order is its own independent judge call.
export type JudgeOrder = 'ab' | 'ba'

// Forced explicit-unsure verdict vocabulary.
export type JudgeVerdictCategory = 'equivalent' | 'different' | 'unsure'

/**
 * One order-tagged call. The port receives eval-core-built prompt content — all judgment
 * rules (rubric, swap agreement, threshold) stay pure-side; the binding only transports.
 */
export interface JudgeCallRequest {
  system: string
  prompt: string
  order: JudgeOrder
}

// The port never throws: infra failure is a typed result.
export type JudgeCallResult =
  | {
      kind: 'verdict'
      verdict: JudgeVerdictCategory
      confidence: JudgeConfidence
      rationale: string
      usage?: JudgeTokenUsage
    }
  | { kind: 'call-error'; reason: JudgeErrorReason; detail: string }

/** The async tier-4 judge seam declared pure-side; eval-local owns the LLM behind it. */
export interface JudgePort {
  judgeModelId: string
  call(request: JudgeCallRequest): Promise<JudgeCallResult>
}
