// The bounded planning tool-loop (net-new, D-06/D-07/D-08/D-09).
//
// Per planning turn the model may make up to K non-action tool calls — each is
// executed, its result appended as a tool message, the conversation continues — and
// the turn terminates when the model emits exactly one action tool call. K is an
// internal runner constant (default 4), injectable via options for tests, and NEVER
// user-facing config: it is not threaded through LoopPorts or any config schema.
//
// Zero non-action tools ship in 353. The always-send-all law holds: the full
// v45 action slice is always sent, plus any caller-registered non-action tools; the
// surface never shrinks or gates. The machinery is proven with test-registered fakes.
//
// Degenerate-response policy:
//   (a) K exhausted + another non-action call ⇒ append a structured budget-exhausted
//       tool-result telling the model it must now choose exactly one action, continue
//       the turn; a further non-action-only response ⇒ a structured planning failure.
//   (b) text-only response (no tool call) ⇒ exactly one re-prompt with
//       toolChoice:'required', then a structured planning failure.
//   (c) multiple tool calls in one response ⇒ process non-action calls in order until
//       the first action call, discard anything after it, log the discard.
//
// This module contains NO `throw` statement: every degenerate model output returns a
// structured failure that feeds the failure-context/replan path. The only
// throws that surface are the abort propagation from generateText and the untouched
// zod schemaInvalid grounding error from toolCallToActionPlan.
import { generateText } from 'ai'
import { withStepModelCall } from '../run/step-model-observations.js'
import type { LanguageModel, ModelMessage, SystemModelMessage, Tool, ToolCallPart, ToolResultPart, ToolSet } from 'ai'
import type {
  GroundingAttempt,
  ModelCallRecord,
  SamplingParams,
  ToolExchangeEvidence,
} from '@vostride/agent-qa-schema'
import type { ActionPlan, PlanningCallGate } from './types.js'
import type { StatedTargets } from '../grounding/stated-target.js'
import type { TokenUsage } from '../result.js'
import type { LoopScopedLogger } from './ports.js'
import { toolCallToActionPlan } from '../tools/builder.js'
import type { ToolRegistry } from '../tools/registry.js'
import { bindApiToolNames } from './api-tool-names.js'

/**
 * K — the per-turn non-action tool-call budget. Channel 2's designed
 * search→read sequence needs two calls, and one retry pair must fit in the same turn.
 * This remains an internal provisional constant, injectable via
 * ExecutePlanningTurnOptions.budget for tests only. Do NOT promote it to user-facing
 * config or thread it through LoopPorts / any config schema.
 */
export const DEFAULT_NON_ACTION_TOOL_BUDGET = 4

const BUDGET_EXHAUSTED_MESSAGE =
  'Tool budget exhausted — you must now choose exactly one action tool.'

/**
 * A caller-registered non-action tool. `tool` is the `ai` definition merged into the
 * always-send-all slice; `execute` runs the call and returns a JSON-serializable
 * result appended to the conversation as a tool message. Zero of these ship in 353;
 * tests register fakes to exercise the machinery.
 */
export interface NonActionToolHandler {
  tool: Tool
  execute(args: Record<string, unknown>): Promise<unknown> | unknown
}

export type NonActionToolMap = Record<string, NonActionToolHandler>

/**
 * An ordered record of one executed non-action tool call within a planning turn
 * (§B1). Exchanges persist on SubActionEvidence for successful decisions (INST-01,
 * D-01) and PlanningFailureEvidence for failed turns.
 */
export type ToolExchange = ToolExchangeEvidence

export type PlanningTurnFailureReason =
  | 'no_action_tool_called'
  | 'non_action_tool_budget_exhausted'
  | 'ungroundable_action'
  | 'planning_limit_reached'

/**
 * The in-turn groundability verdict for a parsed action. Returned by the
 * injected `groundability` callback the caller (LLMPlanner) builds from the Plan-04
 * grounding gate + the in-scope screenState — the tool-loop stays gate-agnostic and
 * NEVER imports `grounding/` itself.
 *
 * `ok: true` may optionally carry the gate's fully-grounded execution-shape `action`
 * (ref, never a descriptor) and its §A8 `attempts` trail; when present the turn swaps
 * them onto the returned plan so the resolved action + evidence ride to executeStep.
 * When omitted (e.g. a test seam that only signals groundability) the parsed plan is
 * returned unchanged. `ok: false` carries the §7.1 error text injected back into the
 * SAME conversation as an error-text tool result for the model's one-shot correction.
 */
export type GroundabilityResult =
  | {
      ok: true
      action?: Record<string, unknown>
      attempts?: GroundingAttempt[]
      statedTargets?: StatedTargets
    }
  | { ok: false; message: string }

/** The injected groundability callback: parsed action → groundability verdict. */
export type GroundabilityCallback = (plan: ActionPlan) => GroundabilityResult

export interface PlanningTurnSuccess {
  ok: true
  plan: ActionPlan
  exchanges: ToolExchange[]
  tokenUsage?: TokenUsage
  callRecord?: ModelCallRecord
}

export interface PlanningTurnFailure {
  ok: false
  reason: PlanningTurnFailureReason
  message: string
  exchanges: ToolExchange[]
  tokenUsage?: TokenUsage
  callRecord?: ModelCallRecord
}

export type PlanningTurnResult = PlanningTurnSuccess | PlanningTurnFailure

export interface ExecutePlanningTurnOptions {
  model: LanguageModel
  /** Registry backing toolCallToActionPlan (the turn's termination projection). */
  registry: ToolRegistry
  /** The full v45 action slice (buildTools output) — always sent (always-send-all). */
  actionTools: ToolSet
  /**
   * System prompt — a single string, or the Phase 355 [stable, context, volatile]
   * tier array the caller assembles. Passed through to generateText untouched;
   * the tool-loop applies no clamp/degrade policy of its own.
   */
  system: string | Array<SystemModelMessage>
  /** The initial user message(s): text and optional image, built by the caller. */
  messages: ModelMessage[]
  /** Caller-registered non-action tools. Empty in production. */
  nonActionTools?: NonActionToolMap
  /** K override for tests. Defaults to DEFAULT_NON_ACTION_TOOL_BUDGET. */
  budget?: number
  /**
   * D-09 in-turn grounding feedback. When present, a parsed action call is grounded by
   * this injected callback after `toolCallToActionPlan` succeeds. A failure appends the
   * §7.1 error text as an error-text tool result in the SAME conversation with EXACTLY
   * ONE retry (a turn-local one-shot flag, never a counter — LOOP-02); a second
   * consecutive grounding failure returns a structured `'ungroundable_action'` failure.
   * The retry neither consumes nor bypasses the ≤K non-action budget (Pitfall 8). When
   * absent the turn behaves exactly as the 353 bounded loop (back-compat within phase).
   */
  groundability?: GroundabilityCallback
  /**
   * Dynamic output cap computed by the caller's clamp helper and passed
   * through to generateText. `undefined` is a valid no-op passthrough — the tool-loop
   * computes no clamp of its own (D-15/Pitfall 5).
   */
  maxOutputTokens?: number
  /**
   * Optional sampling parameters applied at the model call site. Every
   * field is optional and absence preserves the provider default. `maxOutputTokens`
   * is deliberately excluded because the output ceiling remains clamp-owned.
   */
  sampling?: SamplingParams
  /**
   * when bound, every model call of the turn is debited before it is made; a refused
   * debit ends the turn with `planning_limit_reached` and no model call.
   */
  planningCallGate?: PlanningCallGate
  abortSignal?: AbortSignal
  logger?: LoopScopedLogger
}

function appliedSampling(sampling: SamplingParams | undefined): SamplingParams | undefined {
  if (
    sampling?.temperature === undefined &&
    sampling?.topP === undefined &&
    sampling?.stop === undefined &&
    sampling?.seed === undefined
  ) {
    return undefined
  }

  return {
    ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
    ...(sampling.topP !== undefined ? { topP: sampling.topP } : {}),
    ...(sampling.stop !== undefined ? { stop: sampling.stop } : {}),
    ...(sampling.seed !== undefined ? { seed: sampling.seed } : {}),
  }
}

/** Defensive tool-call arg extraction across SDK key variants (v1 planner.ts:104-110). */
function extractArgs(tc: unknown): Record<string, unknown> {
  const t = tc as Record<string, unknown>
  const raw = t.args ?? t.input ?? t.arguments ?? t.toolInput
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

function assistantToolCallMessage(
  toolCalls: { toolCallId: string; toolName: string }[],
): ModelMessage {
  const content: ToolCallPart[] = toolCalls.map(tc => ({
    type: 'tool-call',
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    input: extractArgs(tc),
  }))
  return { role: 'assistant', content }
}

function jsonResultPart(
  tc: { toolCallId: string; toolName: string },
  result: unknown,
): ToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    output: { type: 'json', value: result as never },
  }
}

function errorResultPart(
  tc: { toolCallId: string; toolName: string },
  message: string,
): ToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    output: { type: 'error-text', value: message },
  }
}

export async function executePlanningTurn(
  options: ExecutePlanningTurnOptions,
): Promise<PlanningTurnResult> {
  const budgetLimit = options.budget ?? DEFAULT_NON_ACTION_TOOL_BUDGET
  const nonActionTools = options.nonActionTools ?? {}
  const effectiveSampling = appliedSampling(options.sampling)

  // Always-send-all: the full v45 action slice plus any caller-registered non-action tools. The
  // logical ids remain untouched in contracts/evidence, while the provider ToolSet receives only
  // conservative API-safe aliases. Returned calls reverse through this binding; follow-up
  // assistant/tool messages intentionally retain the provider alias for wire coherence.
  const toolBindings = bindApiToolNames([
    ...Object.entries(options.actionTools).map(([logicalName, boundTool]) => ({
      kind: 'action' as const,
      logicalName,
      value: { tool: boundTool },
    })),
    ...Object.entries(nonActionTools).map(([logicalName, handler]) => ({
      kind: 'non-action' as const,
      logicalName,
      value: { tool: handler.tool, handler },
    })),
  ])
  const combinedTools: ToolSet = {}
  const bindingByApiName = new Map(toolBindings.map((binding) => [binding.apiName, binding]))
  for (const binding of toolBindings) {
    combinedTools[binding.apiName] = binding.value.tool
  }

  const messages: ModelMessage[] = [...options.messages]
  const exchanges: ToolExchange[] = []
  let budget = budgetLimit
  let promptTokens = 0
  let completionTokens = 0
  let usageSeen = false
  let lastResponseModelId: string | undefined
  const unsupported = new Set<string>()
  let rePromptedForNoTool = false
  let budgetErrorInjected = false
  // D-09 turn-local one-shot: a boolean, never a counter. Once a grounding
  // failure has injected its §7.1 error text and continued, a second consecutive
  // grounding failure becomes a structured 'ungroundable_action' failure.
  let groundingErrorInjected = false

  const tokenUsage = (): TokenUsage | undefined =>
    usageSeen
      ? { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
      : undefined

  const callRecord = (): ModelCallRecord => ({
    ...(lastResponseModelId !== undefined ? { resolvedModelId: lastResponseModelId } : {}),
    ...(options.maxOutputTokens !== undefined
      ? { effectiveMaxOutputTokens: options.maxOutputTokens }
      : {}),
    ...(effectiveSampling !== undefined ? { effectiveSampling } : {}),
    ...(unsupported.size > 0 ? { unsupportedFeatures: [...unsupported].sort() } : {}),
  })

  // Iteration backstop: at most K executed non-action calls, plus the exhaustion
  // re-prompt, the no-tool re-prompt, the terminating action response, and the one
  // extra grounding round-trip the D-09 one-shot retry may add (Pitfall 8). The budget
  // arithmetic itself is untouched — this backstop is raised by exactly one.
  const maxIterations = budgetLimit + 5

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (options.planningCallGate && !options.planningCallGate.tryDebitPlanningCall()) {
      return {
        ok: false,
        reason: 'planning_limit_reached',
        message: 'planning-turn limit reached',
        exchanges,
        tokenUsage: tokenUsage(),
        callRecord: callRecord(),
      }
    }
    // generateText errors (including abort) propagate to the caller untouched.
    const observed = await withStepModelCall(options.model, model => generateText({
      model,
      maxRetries: 0,
      maxOutputTokens: options.maxOutputTokens,
      ...(options.sampling?.temperature !== undefined
        ? { temperature: options.sampling.temperature }
        : {}),
      ...(options.sampling?.topP !== undefined ? { topP: options.sampling.topP } : {}),
      ...(options.sampling?.stop !== undefined
        ? { stopSequences: options.sampling.stop }
        : {}),
      ...(options.sampling?.seed !== undefined ? { seed: options.sampling.seed } : {}),
      tools: combinedTools,
      toolChoice: 'required',
      system: options.system,
      abortSignal: options.abortSignal,
      messages,
    }))
    const result = observed.result

    // a scoped turn takes only the provider-observed id; unscoped callers keep the
    // pre-423 SDK response identity.
    lastResponseModelId = observed.scoped
      ? observed.respondingModelId
      : (observed.respondingModelId ?? observed.result.response?.modelId)
    for (const w of result.warnings ?? []) {
      if (w.type === 'unsupported') unsupported.add(w.feature)
    }

    if (result.usage) {
      usageSeen = true
      promptTokens += result.usage.inputTokens ?? 0
      completionTokens += result.usage.outputTokens ?? 0
    }

    const toolCalls = result.toolCalls ?? []

    // D-08(b): text-only response — one re-prompt, then planning failure.
    if (toolCalls.length === 0) {
      if (!rePromptedForNoTool) {
        rePromptedForNoTool = true
        messages.push({
          role: 'user',
          content: 'You did not call a tool. You must call exactly one action tool to proceed.',
        })
        continue
      }
      return {
        ok: false,
        reason: 'no_action_tool_called',
        message: 'Model produced no action tool call after a re-prompt.',
        exchanges,
        tokenUsage: tokenUsage(),
        callRecord: callRecord(),
      }
    }

    // Scan tool calls in order until the first action call.
    const toolResultParts: ToolResultPart[] = []
    let actionCall:
      | {
          name: string
          args: Record<string, unknown>
          tc: (typeof toolCalls)[number]
          index: number
        }
      | undefined
    let discardedAfterAction = 0
    let sawOverBudgetNonAction = false

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      const binding = bindingByApiName.get(tc.toolName)
      const name = binding?.logicalName ?? tc.toolName
      const args = extractArgs(tc)

      // Action tool → terminate. The provider alias binding is the classifier; an unknown name
      // preserves the old fail-loud action path and reaches toolCallToActionPlan unchanged.
      if (binding?.kind !== 'non-action') {
        actionCall = { name, args, tc, index: i }
        discardedAfterAction = toolCalls.length - i - 1
        break
      }

      // Non-action tool.
      if (budget <= 0) {
        // D-08(a): over budget — inject the structured error, do not execute.
        sawOverBudgetNonAction = true
        toolResultParts.push(errorResultPart(tc, BUDGET_EXHAUSTED_MESSAGE))
        continue
      }
      const execResult = await nonActionTools[name]!.execute(args)
      exchanges.push({ tool: name, args, result: execResult })
      toolResultParts.push(jsonResultPart(tc, execResult))
      budget -= 1
    }

    if (actionCall) {
      if (discardedAfterAction > 0) {
        options.logger?.warn('Discarded tool calls after the first action call', {
          discarded: discardedAfterAction,
          action: actionCall.name,
        })
      }
      // toolCallToActionPlan validates via zod; the schemaInvalid grounding error is
      // preserved untouched (D-09 / T-353-05 / Q2) and propagates if the args are
      // malformed — malformed-args stay a throw this phase, never in-turn feedback.
      const plan = toolCallToActionPlan(actionCall.name, actionCall.args, options.registry) as ActionPlan

      // D-09 in-turn grounding feedback: ground the parsed action via the injected
      // callback. On failure, mirror the budget-exhausted flow exactly — append the
      // assistant tool call(s) plus a tool message carrying the §7.1 error text — and
      // continue the SAME conversation for exactly one retry (one-shot flag, never a
      // counter). A second consecutive failure is a structured 'ungroundable_action'
      // failure. The non-action budget is never read or written on this path.
      if (options.groundability) {
        const grounded = options.groundability(plan)
        if (!grounded.ok) {
          if (groundingErrorInjected) {
            return {
              ok: false,
              reason: 'ungroundable_action',
              message: grounded.message,
              exchanges,
              tokenUsage: tokenUsage(),
              callRecord: callRecord(),
            }
          }
          groundingErrorInjected = true
          // Respond only to the calls we processed (non-actions before the action, plus
          // the action itself); anything after the action is discarded and left out so no
          // tool-call is dangling without a result.
          const processed = toolCalls.slice(0, actionCall.index + 1)
          messages.push(assistantToolCallMessage(processed))
          messages.push({
            role: 'tool',
            content: [...toolResultParts, errorResultPart(actionCall.tc, grounded.message)],
          })
          continue
        }
        // ok: adopt the gate's fully-grounded execution-shape action + §A8 attempts trail
        // when the callback supplies them (LLMPlanner does; test seams may not).
        if (grounded.action) plan.action = grounded.action as ActionPlan['action']
        if (grounded.attempts) plan.groundingAttempts = grounded.attempts
        if (grounded.statedTargets) plan.statedTargets = grounded.statedTargets
      }

      return { ok: true, plan, exchanges, tokenUsage: tokenUsage(), callRecord: callRecord() }
    }

    // No action this response — append the model's tool calls and their results so the
    // conversation stays coherent, then continue the turn.
    messages.push(assistantToolCallMessage(toolCalls))
    if (toolResultParts.length > 0) {
      messages.push({ role: 'tool', content: toolResultParts })
    }

    if (sawOverBudgetNonAction) {
      // D-08(a): first over-budget response injects the error and continues; a further
      // non-action-only response is a planning failure.
      if (budgetErrorInjected) {
        return {
          ok: false,
          reason: 'non_action_tool_budget_exhausted',
          message: BUDGET_EXHAUSTED_MESSAGE,
          exchanges,
          tokenUsage: tokenUsage(),
          callRecord: callRecord(),
        }
      }
      budgetErrorInjected = true
    }
  }

  // Iteration backstop reached — treated as a budget-exhaustion failure, never a throw.
  return {
    ok: false,
    reason: 'non_action_tool_budget_exhausted',
    message: 'Planning turn exceeded its iteration backstop.',
    exchanges,
    tokenUsage: tokenUsage(),
    callRecord: callRecord(),
  }
}
