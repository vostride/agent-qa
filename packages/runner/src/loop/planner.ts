// Takes an injected `LanguageModel` and never resolves a provider.
import type { LanguageModel, LanguageModelUsage, ModelMessage, SystemModelMessage } from 'ai'
import type {
  DeclaredModelProfile,
  ModelCallRecord,
  Platform,
  ScreenState,
  ToolExchangeEvidence,
} from '@vostride/agent-qa-schema'
import type { Planner, PlanResult, StepContext } from './types.js'
import type { LoopScopedLogger, TokenAccounting } from './ports.js'
import { buildSystemPrompt, buildContextTier, buildVolatileTier, composeTurnMessages } from './prompts.js'
import { buildTools, defaultRegistry } from '../tools/index.js'
import {
  executePlanningTurn,
  type GroundabilityCallback,
  type NonActionToolMap,
  type PlanningTurnFailureReason,
  type PlanningTurnResult,
} from './planning-turn.js'
import { executeClampedCall, type ClampedCallResult } from './clamp.js'
import { groundActionPlan } from '../grounding/gate.js'

// Appended to the current instruction when the screenshot send fails, so the retried turn
// falls back to the accessibility tree.
const SCREENSHOT_UNAVAILABLE_NOTE =
  '[Note: Visual screenshot is unavailable for this step. Rely on the accessibility tree for element identification.]'

// Max characters of a provider `responseBody` to carry into log meta / rethrown messages —
// bounds an accidentally-large error body so a swallowed catch never dumps an unbounded blob.
const MAX_RESPONSE_BODY_CHARS = 500

// Carries failed-turn evidence across the planner's throw-based contract.
export class PlanningTurnError extends Error {
  readonly reason: PlanningTurnFailureReason
  readonly exchanges: ToolExchangeEvidence[]
  readonly callRecord?: ModelCallRecord

  constructor(
    reason: PlanningTurnFailureReason,
    message: string,
    exchanges: ToolExchangeEvidence[],
    callRecord?: ModelCallRecord,
  ) {
    super(`Planning turn failed (${reason}): ${message}`)
    this.name = 'PlanningTurnError'
    this.reason = reason
    this.exchanges = exchanges
    this.callRecord = callRecord
  }
}

// The planning-turn limit refused a model call; the loop ends the step with its typed limit stop.
export class PlanningLimitReachedError extends Error {
  readonly exchanges: ToolExchangeEvidence[]
  readonly callRecord?: ModelCallRecord

  constructor(exchanges: ToolExchangeEvidence[], callRecord?: ModelCallRecord) {
    super('Planning-turn limit reached')
    this.name = 'PlanningLimitReachedError'
    this.exchanges = exchanges
    this.callRecord = callRecord
  }
}

// Reads APICallError fields by duck typing, so the runner imports no provider SDK.
function extractProviderError(
  err: unknown,
): { statusCode?: number; responseBody?: string; detail?: string } | undefined {
  if (err === null || typeof err !== 'object') return undefined
  const e = err as { statusCode?: unknown; responseBody?: unknown }
  const statusCode = typeof e.statusCode === 'number' ? e.statusCode : undefined
  const rawBody = typeof e.responseBody === 'string' ? e.responseBody : undefined
  if (statusCode === undefined && rawBody === undefined) return undefined

  const responseBody = rawBody !== undefined ? rawBody.slice(0, MAX_RESPONSE_BODY_CHARS) : undefined
  let detail: string | undefined
  if (rawBody !== undefined) {
    try {
      const body = JSON.parse(rawBody) as { detail?: unknown; error?: { message?: unknown } }
      if (typeof body?.detail === 'string') detail = body.detail
      else if (typeof body?.error?.message === 'string') detail = body.error.message
    } catch {
      // Provider did not return JSON — the bounded responseBody still carries its words.
    }
  }
  return { statusCode, responseBody, detail }
}

// Extract the trimmed textual content of a system tier. A tier's `content` is a string
// (the SystemModelMessage shape the planner builders emit); defensively, if a tier ever
// carries array content parts, join their text before trimming so an empty check stays
// honest across shapes.
function tierTextContent(tier: SystemModelMessage): string {
  const content = tier.content as unknown
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('')
      .trim()
  }
  return ''
}

// Drops empty system tiers, which the OpenAI Responses API rejects as empty developer messages.
export function assemblePlannerSystemTiers(
  context: StepContext,
  options: { platform: Platform; capabilityNotes?: string },
): SystemModelMessage[] {
  const stableContent = options.capabilityNotes
    ? `${buildSystemPrompt(options.platform)}\n\nRuntime capability notes:\n${options.capabilityNotes}`
    : buildSystemPrompt(options.platform)
  const tiers: SystemModelMessage[] = [
    { role: 'system', content: stableContent },
    buildContextTier(context),
    buildVolatileTier(context),
  ]
  return tiers.filter((tier) => tierTextContent(tier).length > 0)
}

export class LLMPlanner implements Planner {
  private model: LanguageModel
  private platform: Platform
  private logger?: LoopScopedLogger
  private capabilityNotes?: string
  private accounting: TokenAccounting
  private profile?: DeclaredModelProfile
  private nonActionTools?: NonActionToolMap

  // `nonActionTools` lets replay serve recorded exchanges through the production planner.
  constructor(
    model: LanguageModel,
    platform: Platform | undefined,
    logger: LoopScopedLogger | undefined,
    capabilityNotes: string | undefined,
    accounting: TokenAccounting,
    profile?: DeclaredModelProfile,
    nonActionTools?: NonActionToolMap,
  ) {
    this.model = model
    this.platform = platform ?? 'web'
    this.logger = logger
    this.capabilityNotes = capabilityNotes
    this.accounting = accounting
    this.profile = profile
    this.nonActionTools = nonActionTools
  }

  // The cache breakpoint rides the context tier; other providers ignore the `anthropic` namespace.
  private buildSystemTiers(context: StepContext): SystemModelMessage[] {
    return assemblePlannerSystemTiers(context, { platform: this.platform, capabilityNotes: this.capabilityNotes })
  }

  async plan(
    step: string,
    screenState: ScreenState,
    context: StepContext,
    abortSignal?: AbortSignal,
  ): Promise<PlanResult> {
    const planStart = performance.now()
    const turnContext: StepContext = { ...context, stepInstruction: step }
    const system = this.buildSystemTiers(turnContext)
    const actionTools = buildTools(defaultRegistry, { platform: this.platform })
    // The port's estimate() sees only messages, so tool-schema tokens are counted here once.
    const toolSchema = JSON.stringify(actionTools)

    // A gate failure returns the error text for one in-turn correction, never a throw.
    const groundability: GroundabilityCallback = (parsed) => {
      const toolName = typeof parsed.action.type === 'string' ? parsed.action.type : 'action'
      const gate = groundActionPlan({ toolName, action: parsed.action, screenState })
      if (gate.ok) {
        return {
          ok: true,
          action: gate.action,
          attempts: gate.attempts,
          statedTargets: gate.statedTargets,
        }
      }

      // The gate rejected the planned action. Surface a diagnostic so an ungroundable action
      // is never opaque again (this is how the "both ref+target" live regression was found):
      // the tool, the failure code, and which grounding handles the planner actually supplied.
      // Element identifiers only (ref/target/elementDescription) — never the text/value fields
      // a fill/type could carry. The §7.1 error text + hint is fed back to the model unchanged
      // (the one-shot retry contract is untouched).
      this.logger?.warn('planner emitted an ungroundable action', {
        tool: toolName,
        code: gate.error.code,
        hasRef: parsed.action.ref !== undefined && parsed.action.ref !== null,
        hasTarget: parsed.action.target !== undefined && parsed.action.target !== null,
        ref: parsed.action.ref,
        elementDescription: parsed.action.elementDescription,
        target: parsed.action.target,
      })
      return { ok: false, message: `${gate.error.message} ${gate.error.hint}` }
    }

    // Pins the latest observation and the instruction, so a degrade never evicts them.
    const runTurn = (messages: ModelMessage[]): Promise<ClampedCallResult<PlanningTurnResult>> => {
      const observation = messages[messages.length - 2]
      const instruction = messages[messages.length - 1]
      const pinned = new Set<ModelMessage>([observation, instruction])
      return executeClampedCall<PlanningTurnResult>({
        accounting: this.accounting,
        system,
        messages,
        toolSchema,
        pin: (message) => pinned.has(message),
        call: (maxOutputTokens, fitted) =>
          executePlanningTurn({
            model: this.model,
            registry: defaultRegistry,
            actionTools,
            system,
            messages: fitted,
            maxOutputTokens,
            sampling: this.profile?.sampling,
            abortSignal,
            logger: this.logger,
            groundability,
            // `runTurn` is behind every plan path, so this one thread-through covers them all.
            nonActionTools: this.nonActionTools,
            planningCallGate: context.planningCallGate,
          }),
        // recordUsage anchors on the observed input tokens (prompt only, per the clamp
        // contract); the turn result's accumulated TokenUsage supplies the triad. The `ai`
        // LanguageModelUsage also carries nested token-detail objects the port never reads —
        // asserting the minimal anchor is honest here (fabricating detail zeros would not be).
        recordFrom: (tr) =>
          ({
            inputTokens: tr.tokenUsage?.promptTokens ?? 0,
            outputTokens: tr.tokenUsage?.completionTokens ?? 0,
            totalTokens: tr.tokenUsage?.totalTokens ?? 0,
          }) as LanguageModelUsage,
      })
    }

    // The screenshot fallback retries the whole turn without the image, through the same clamp.
    let clamped: ClampedCallResult<PlanningTurnResult>
    try {
      if (context.screenshot) {
        try {
          clamped = await runTurn(composeTurnMessages(turnContext, screenState))
        } catch (err) {
          if (abortSignal?.aborted) throw err
          const provider = extractProviderError(err)
          this.logger?.warn('Screenshot send failed, retrying without image', {
            error: err instanceof Error ? err.message : String(err),
            ...(provider !== undefined
              ? { statusCode: provider.statusCode, responseBody: provider.responseBody }
              : {}),
          })
          const fallbackNote = turnContext.promptNote
            ? `${turnContext.promptNote}\n${SCREENSHOT_UNAVAILABLE_NOTE}`
            : SCREENSHOT_UNAVAILABLE_NOTE
          const fallbackContext: StepContext = { ...turnContext, screenshot: undefined, promptNote: fallbackNote }
          clamped = await runTurn(composeTurnMessages(fallbackContext, screenState))
        }
      } else {
        clamped = await runTurn(composeTurnMessages(turnContext, screenState))
      }
    } catch (err) {
      if (abortSignal?.aborted) throw err
      const errorMsg = err instanceof Error ? err.message : String(err)
      // Handle tool-related errors with clear messages
      if (errorMsg.includes('no such tool') || errorMsg.includes('tool_not_found') || errorMsg.includes('unknown tool')) {
        const availableTools = Object.keys(actionTools).join(', ')
        this.logger?.warn('LLM called unknown tool', { error: errorMsg, availableTools })
        throw new Error(`LLM called unknown tool. Available tools: ${availableTools}. Error: ${errorMsg}`)
      }
      if (errorMsg.includes('invalid_tool_input') || errorMsg.includes('tool input') || errorMsg.includes('schema validation')) {
        this.logger?.warn('LLM provided invalid tool input', { error: errorMsg })
        throw new Error(`LLM provided invalid tool input: ${errorMsg}`)
      }
      // Surface statusCode and responseBody so the provider's words survive the runner boundary.
      const provider = extractProviderError(err)
      if (provider !== undefined) {
        this.logger?.warn('LLM planning failed (provider error)', {
          statusCode: provider.statusCode,
          responseBody: provider.responseBody,
          error: errorMsg,
        })
        const status = provider.statusCode !== undefined ? `HTTP ${provider.statusCode}` : 'provider error'
        const detail = provider.detail ?? provider.responseBody ?? errorMsg
        throw new Error(`LLM planning failed (${status}): ${detail}`)
      }
      throw err
    }

    const turnResult = clamped.result

    // A cannot-fit degrade never throws; the turn ran on the pinned floor, so log and continue.
    if (clamped.degrade && clamped.degrade.ok === false) {
      this.logger?.warn('Planning turn degraded to the pinned floor (input exceeds budget)', {
        reason: clamped.degrade.reason,
      })
    }

    if (!turnResult.ok && turnResult.reason === 'planning_limit_reached') {
      throw new PlanningLimitReachedError(turnResult.exchanges, turnResult.callRecord)
    }

    if (!turnResult.ok) {
      // A typed error keeps the failed turn's exchanges while preserving the throw-based contract.
      throw new PlanningTurnError(
        turnResult.reason,
        turnResult.message,
        turnResult.exchanges,
        turnResult.callRecord,
      )
    }

    const plan = turnResult.plan

    this.logger?.info('LLM plan generated', {
      model: typeof this.model === 'object' && this.model && 'modelId' in this.model ? (this.model as { modelId: string }).modelId : 'unknown',
      promptTokens: turnResult.tokenUsage?.promptTokens ?? 0,
      completionTokens: turnResult.tokenUsage?.completionTokens ?? 0,
      latencyMs: performance.now() - planStart,
      confidence: plan.confidence,
      actionType: plan.action?.type,
    })

    return {
      plan,
      tokenUsage: turnResult.tokenUsage,
      exchanges: turnResult.exchanges,
      ...(turnResult.callRecord !== undefined ? { callRecord: turnResult.callRecord } : {}),
    }
  }
}
