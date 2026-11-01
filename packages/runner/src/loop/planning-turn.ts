// The turn ends at one action call; degenerate output returns a structured failure, never a throw.
import { generateText, ToolChoiceViolationError } from 'ai'
import { withStepModelCall } from '../run/step-model-observations.js'
import type { LanguageModel, LanguageModelUsage, ModelMessage, SystemModelMessage, Tool, ToolCallPart, ToolResultPart, ToolSet } from 'ai'
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

// Channel 2's search and read take a call each, and one retry pair must fit in the same turn.
export const DEFAULT_NON_ACTION_TOOL_BUDGET = 4

const BUDGET_EXHAUSTED_MESSAGE =
  'Tool budget exhausted — you must now choose exactly one action tool.'

// `tool` joins the always-send-all slice; `execute`'s result is appended as a tool message.
export interface NonActionToolHandler {
  tool: Tool
  execute(args: Record<string, unknown>): Promise<unknown> | unknown
}

export type NonActionToolMap = Record<string, NonActionToolHandler>

// Persists on SubActionEvidence, or on PlanningFailureEvidence for a failed turn.
export type ToolExchange = ToolExchangeEvidence

export type PlanningTurnFailureReason =
  | 'no_action_tool_called'
  | 'non_action_tool_budget_exhausted'
  | 'ungroundable_action'
  | 'planning_limit_reached'

// The tool-loop stays gate-agnostic; `ok: false` text is injected back for one correction.
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
  /** The full action slice from buildTools, always sent. */
  actionTools: ToolSet
  // Passed through to generateText untouched; the tool-loop applies no clamp policy of its own.
  system: string | Array<SystemModelMessage>
  /** The initial user message(s): text and optional image, built by the caller. */
  messages: ModelMessage[]
  /** Caller-registered non-action tools. Empty in production. */
  nonActionTools?: NonActionToolMap
  /** K override for tests. Defaults to DEFAULT_NON_ACTION_TOOL_BUDGET. */
  budget?: number
  // One in-turn retry after a grounding failure, outside the non-action budget; then a failure.
  groundability?: GroundabilityCallback
  // Computed by the caller's clamp helper; `undefined` passes through as a no-op.
  maxOutputTokens?: number
  // Absent fields keep the provider default; `maxOutputTokens` stays clamp-owned.
  sampling?: SamplingParams
  // When bound, every model call is debited first; a refused debit ends the turn with no call.
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

/** Defensive tool-call arg extraction across SDK key variants. */
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

  // Provider tools get API-safe aliases; logical ids stay in contracts and evidence.
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
  // A boolean, never a counter: a second consecutive grounding failure ends the turn.
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

  // Room for K non-action calls, both re-prompts, the action response and one grounding retry.
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
    const callEnd: { usage?: LanguageModelUsage; modelId?: string } = {}
    // A tool-choice violation is a text-only answer; any other error, abort included, propagates.
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
      onLanguageModelCallEnd: (event) => {
        callEnd.usage = event.usage
        callEnd.modelId = event.modelId
      },
    }).catch((error: unknown) => {
      if (!ToolChoiceViolationError.isInstance(error)) throw error
      return undefined
    }))
    const result = observed.result

    // A scoped turn takes only the provider-observed id; unscoped callers keep the SDK response id.
    lastResponseModelId = observed.scoped
      ? observed.respondingModelId
      : (observed.respondingModelId
        ?? (result === undefined ? callEnd.modelId : result.response?.modelId))
    for (const w of result?.warnings ?? []) {
      if (w.type === 'unsupported') unsupported.add(w.feature)
    }

    const usage = result === undefined ? callEnd.usage : result.usage
    if (usage) {
      usageSeen = true
      promptTokens += usage.inputTokens ?? 0
      completionTokens += usage.outputTokens ?? 0
    }

    const toolCalls = result?.toolCalls ?? []

    // Text-only response: one re-prompt, then planning failure.
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

      // The alias binding classifies; an unknown name is an action for `toolCallToActionPlan`.
      if (binding?.kind !== 'non-action') {
        actionCall = { name, args, tc, index: i }
        discardedAfterAction = toolCalls.length - i - 1
        break
      }

      // Non-action tool.
      if (budget <= 0) {
        // Over budget: inject the structured error, do not execute.
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
      // Malformed args throw the zod schemaInvalid error; they never get in-turn feedback.
      const plan = toolCallToActionPlan(actionCall.name, actionCall.args, options.registry) as ActionPlan

      // On failure, append the error as a tool result and retry once; the budget is never touched.
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
      // The first over-budget response injects the error; a further one without action fails.
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
