// D-05 judge port. CRITICAL: eval core stays pure — this module only declares the async seam
// the tier-4 judge rides; the concrete binding lives in eval-local through createModel (Phase
// 370 D-05 hexagonal split). The port answers exactly one order-tagged call per request — the
// order-swap agreement rule lives in adjudicate, never in the port. No runtime logic
// exists in this file.

import type {
  JudgeConfidence,
  JudgeErrorReason,
  JudgeTokenUsage,
} from '../match/score'

/** D-08 physical A/B position tag; each order is its own independent judge call. */
export type JudgeOrder = 'ab' | 'ba'

/** D-09 forced explicit-unsure verdict vocabulary. */
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

/** The port NEVER throws — infra failure is a typed result, never an exception. */
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
