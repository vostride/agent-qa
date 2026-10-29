// Runner-side clamp/degrade policy helper. Pure, generic policy
// over the shipped Phase 354 TokenAccounting port: the dynamic output clamp
// (max_output = max(floor, min(default, C − I − safety))), the percentage-plus-floor
// safety margin, the proactive/reactive degrade wiring, the observation+instruction
// pins, retry-exactly-once on a live context overflow, the recordUsage feed, and the
// structured cannot-fit outcome (never a crash, D-17).
//
// CRITICAL: provider-neutral. Imports message/usage TYPES from 'ai' only and the runner
// TokenAccounting port from './ports.js'; reuses estimateTokens from './prompts.js'.
// NEVER imports the model package (@vostride/agent-qa-model) or any provider SDK
// (@ai-sdk/*) — overflow detection is runner-local (validate:arch, mirrors ports.ts).

import type { LanguageModelUsage, ModelMessage, SystemModelMessage } from 'ai'
import type { TokenAccounting, RunnerDegradeOutcome } from './ports.js'
import { estimateTokens } from './prompts.js'

// ---------------------------------------------------------------------------
// Safety policy — documented, injectable consts. The margin scales
// with the model window across the full BYOM range (a 4k local model floors at
// 256; a 1M model reserves 2%), and every knob is overridable per call.
// ---------------------------------------------------------------------------

/** Fraction of the context window reserved as headroom above the output cap. */
export const SAFETY_PERCENT = 0.02
/** Absolute floor for the safety margin — dominates on small windows. */
export const SAFETY_FLOOR = 256
/** Floor for the output clamp — the cap never drops to zero/negative. */
export const OUTPUT_FLOOR = 256

/** Per-call overrides for the safety policy. */
export interface SafetyOverrides {
  percent?: number
  floor?: number
}

/**
 * Resolve the safety margin for a context window `C`:
 * `max(floor, ceil(percent * C))`. Injectable percentage + floor so callers can
 * tune the reserve without forking the arithmetic.
 */
export function resolveSafety(contextWindow: number, overrides?: SafetyOverrides): number {
  const percent = overrides?.percent ?? SAFETY_PERCENT
  const floor = overrides?.floor ?? SAFETY_FLOOR
  return Math.max(floor, Math.ceil(percent * contextWindow))
}

/** Test-facing alias for the default safety policy: `max(256, ceil(0.02 * C))`. */
export function computeSafety(contextWindow: number): number {
  return resolveSafety(contextWindow)
}

// ---------------------------------------------------------------------------
// Clamp arithmetic.
// ---------------------------------------------------------------------------

export interface ComputeMaxOutputInput {
  contextWindow: number
  inputTokens: number
  defaultMaxOutput: number
  /** Reserve above the cap; defaults to the standard safety policy for `contextWindow`. */
  safety?: number
  /** Lower bound for the cap; defaults to OUTPUT_FLOOR. */
  floor?: number
}

/**
 * The dynamic output clamp:
 * `max(floor, min(default, C − I − safety))`. A tiny/negative headroom clamps up to
 * the floor rather than emitting a zero/negative cap.
 */
export function computeMaxOutput(input: ComputeMaxOutputInput): number {
  const { contextWindow, inputTokens, defaultMaxOutput } = input
  const safety = input.safety ?? resolveSafety(contextWindow)
  const floor = input.floor ?? OUTPUT_FLOOR
  return Math.max(floor, Math.min(defaultMaxOutput, contextWindow - inputTokens - safety))
}

// ---------------------------------------------------------------------------
// Input estimate (§5.1) — the port's estimate() counts messages only; tool schemas
// are not in the message stream, so their tokens must be added explicitly (Pitfall 4).
// ---------------------------------------------------------------------------

/** Tool-schema token count for the always-send-all action slice (Pitfall 4). */
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

// ---------------------------------------------------------------------------
// The generic clamp → pre-degrade → call → overflow-retry-once → recordUsage
// wrapper. Provider-neutral and result-generic so both the planner
// (result = PlanningTurnResult) and verifier (result = generateText result)
// consume it identically. The tool-loop (planning-turn.ts) stays pure —
// this module owns all clamp/degrade/retry policy.
// ---------------------------------------------------------------------------

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
  /** Per-call safety policy override. */
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

/**
 * Compute the clamp for the current ceilings and fit the turn messages to the input
 * budget. Degrades (proactively) when the input estimate exceeds the budget, or when
 * `force` is set (the reactive backstop after a live overflow). On a cannot-fit
 * (`ok:false`) outcome it keeps the best-effort pinned floor and surfaces the reason —
 * never throws.
 */
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

/**
 * Run one clamped, degrade-fitted provider call with a single reactive overflow retry.
 *
 * 1. Compute the clamp and proactively degrade the turn messages when the input
 *    estimate exceeds the budget (pinning observation + instruction).
 * 2. Invoke `call(maxOut, fittedMessages)`.
 * 3. On a runner-local context overflow, recompute the clamp against the now-shrunk
 *    window (the 354 lazy capabilities thunk has learned it), re-degrade, and retry
 *    the call EXACTLY once. A non-overflow error rethrows unchanged.
 * 4. After a successful response, feed `recordUsage` once with the full sent set.
 *
 * Never throws for the cannot-fit case — it proceeds with the pinned floor and returns
 * the structured degrade outcome.
 */
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
