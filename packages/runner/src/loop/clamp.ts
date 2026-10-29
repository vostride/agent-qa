// Provider-neutral: overflow detection is runner-local, so no model package or `@ai-sdk/*` import.

import type { LanguageModelUsage, ModelMessage, SystemModelMessage } from 'ai'
import type { TokenAccounting, RunnerDegradeOutcome } from './ports.js'
import { estimateTokens } from './prompts.js'

// The margin scales with the model window: a 4k model floors at 256, a 1M model reserves 2%.

/** Fraction of the context window reserved as headroom above the output cap. */
export const SAFETY_PERCENT = 0.02
/** Absolute floor for the safety margin — dominates on small windows. */
export const SAFETY_FLOOR = 256
/** Floor for the output clamp — the cap never drops to zero/negative. */
export const OUTPUT_FLOOR = 256

export interface SafetyOverrides {
  percent?: number
  floor?: number
}

// `max(floor, ceil(percent * C))` for a context window `C`.
export function resolveSafety(contextWindow: number, overrides?: SafetyOverrides): number {
  const percent = overrides?.percent ?? SAFETY_PERCENT
  const floor = overrides?.floor ?? SAFETY_FLOOR
  return Math.max(floor, Math.ceil(percent * contextWindow))
}

/** Test-facing alias for the default safety policy: `max(256, ceil(0.02 * C))`. */
export function computeSafety(contextWindow: number): number {
  return resolveSafety(contextWindow)
}

export interface ComputeMaxOutputInput {
  contextWindow: number
  inputTokens: number
  defaultMaxOutput: number
  /** Reserve above the cap; defaults to the standard safety policy for `contextWindow`. */
  safety?: number
  /** Lower bound for the cap; defaults to OUTPUT_FLOOR. */
  floor?: number
}

// `max(floor, min(default, C − I − safety))`; a tiny or negative headroom clamps up to the floor.
export function computeMaxOutput(input: ComputeMaxOutputInput): number {
  const { contextWindow, inputTokens, defaultMaxOutput } = input
  const safety = input.safety ?? resolveSafety(contextWindow)
  const floor = input.floor ?? OUTPUT_FLOOR
  return Math.max(floor, Math.min(defaultMaxOutput, contextWindow - inputTokens - safety))
}

// The port's estimate() counts messages only, so tool-schema tokens are added explicitly.

/** Tool-schema token count for the always-send-all action slice. */
export function estimateToolSchemaTokens(actionTools: unknown): number {
  if (actionTools === undefined || actionTools === null) return 0
  return estimateTokens(JSON.stringify(actionTools))
}

/**
 * Full input estimate `I` = message tokens (port) + tool-schema tokens. `toolSchema`
 * is the already-serialized action-slice JSON (computed once at the call site).
 */
export function estimateInput(
  accounting: TokenAccounting,
  messages: ModelMessage[],
  toolSchema?: string,
): number {
  const schemaTokens = toolSchema ? estimateTokens(toolSchema) : 0
  return accounting.estimate(messages) + schemaTokens
}

// ---------------------------------------------------------------------------
// Combined clamp: resolve ceilings + safety, produce the output cap and the input
// budget (the max input tokens allowed once the output reserve is carved out).
// ---------------------------------------------------------------------------

export interface ClampResult {
  maxOut: number
  budget: number
  safety: number
}

/**
 * Compute the output cap and input budget from the port ceilings for a precomputed
 * input estimate `I` (messages + tool schema). `budget = C − maxOut − safety`.
 */
export function computeClamp(
  accounting: TokenAccounting,
  inputTokens: number,
  safetyOverride?: SafetyOverrides,
): ClampResult {
  const { contextWindow, maxOutput } = accounting.getCeilings()
  const safety = resolveSafety(contextWindow, safetyOverride)
  const maxOut = computeMaxOutput({
    contextWindow,
    inputTokens,
    defaultMaxOutput: maxOutput,
    safety,
  })
  return { maxOut, budget: contextWindow - maxOut - safety, safety }
}

// ---------------------------------------------------------------------------
// Runner-local context-overflow predicate. Mirrors loop/index.ts
// CONTEXT_ERROR_PATTERNS so overflow detection stays provider-neutral and inside
// the runner boundary (the port does not expose it; a model re-export is forbidden).
// ---------------------------------------------------------------------------

const CONTEXT_OVERFLOW_PATTERNS = [
  'context length',
  'maximum context',
  'token limit',
  'too many tokens',
  'exceeds.*max',
  'input.*too long',
]

/** True when `err` is a provider context-length / token-limit overflow. */
export function isContextLengthOverflow(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : ''
  if (!message) return false
  const lower = message.toLowerCase()
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => new RegExp(pattern, 'i').test(lower))
}

// The planner and verifier both call through this, so the planning turn stays free of policy.

export interface ClampedCallOptions<T> {
  accounting: TokenAccounting
  /** System tier — pinned by construction (never trimmed); counted into `I`. */
  system: SystemModelMessage[]
  /** Turn messages — the degrade-eligible set. */
  messages: ModelMessage[]
  /** Serialized action-slice JSON (computed once at the call site); '' when none. */
  toolSchema?: string
  /** Pin predicate protecting the observation + current instruction. */
  pin: (message: ModelMessage, index: number) => boolean
  /** Provider call: receives the output cap and the fitted message set. */
  call: (maxOutputTokens: number, messages: ModelMessage[]) => Promise<T>
  /** Overflow predicate; defaults to the runner-local isContextLengthOverflow. */
  isOverflow?: (err: unknown) => boolean
  safetyOverride?: SafetyOverrides
  /** Extract the usage anchor from a successful result; defaults to `result.usage`. */
  recordFrom?: (result: T) => LanguageModelUsage
}

export interface ClampedCallResult<T> {
  result: T
  /**
   * The structured degrade outcome, present only when a (proactive or reactive)
   * degrade ran. Widened over RunnerDegradeOutcome so callers may read `.reason`
   * directly (the `ok:true` fit carries no reason) without discriminating on `.ok`.
   */
  degrade?: { ok: boolean; reason?: 'pinned-content-exceeds-budget'; messages: ModelMessage[] }
}

interface FittedTurn {
  maxOut: number
  messages: ModelMessage[]
  degrade?: RunnerDegradeOutcome
}

// Degrades when the estimate exceeds the budget or on `force`; a cannot-fit keeps the pinned floor.
function fitTurn(
  opts: ClampedCallOptions<unknown>,
  toolSchemaTokens: number,
  force: boolean,
): FittedTurn {
  const { accounting, system, messages, pin } = opts
  const inputEstimate = accounting.estimate([...system, ...messages]) + toolSchemaTokens
  const { maxOut, budget } = computeClamp(accounting, inputEstimate, opts.safetyOverride)

  if (!force && inputEstimate <= budget) {
    return { maxOut, messages }
  }

  // Degrade only the turn messages: carve the system + tool-schema tokens out of the
  // input budget so the port trims the message stream against the remaining headroom.
  const messageBudget = budget - accounting.estimate(system) - toolSchemaTokens
  const outcome = accounting.degrade(messages, { budget: messageBudget, pin })
  return { maxOut, messages: outcome.messages, degrade: outcome }
}

// Retries once on a runner-local overflow, after re-degrading; any other error rethrows unchanged.
export async function executeClampedCall<T>(
  opts: ClampedCallOptions<T>,
): Promise<ClampedCallResult<T>> {
  const isOverflow = opts.isOverflow ?? isContextLengthOverflow
  const recordFrom =
    opts.recordFrom ?? ((result: T) => (result as { usage: LanguageModelUsage }).usage)
  const toolSchema = opts.toolSchema ?? ''
  const toolSchemaTokens = toolSchema ? estimateTokens(toolSchema) : 0

  const record = (result: T, sent: ModelMessage[], degrade?: RunnerDegradeOutcome) => {
    accountingRecord(opts.accounting, recordFrom(result), opts.system, sent)
    return { result, degrade }
  }

  const proactive = fitTurn(opts as ClampedCallOptions<unknown>, toolSchemaTokens, false)

  try {
    const result = await opts.call(proactive.maxOut, proactive.messages)
    return record(result, proactive.messages, proactive.degrade)
  } catch (err) {
    if (!isOverflow(err)) throw err
    // Reactive backstop: recompute + re-degrade against the shrunk window, retry once.
    const reactive = fitTurn(opts as ClampedCallOptions<unknown>, toolSchemaTokens, true)
    const result = await opts.call(reactive.maxOut, reactive.messages)
    return record(result, reactive.messages, reactive.degrade ?? proactive.degrade)
  }
}

function accountingRecord(
  accounting: TokenAccounting,
  usage: LanguageModelUsage,
  system: SystemModelMessage[],
  sent: ModelMessage[],
): void {
  accounting.recordUsage(usage, [...system, ...sent])
}
