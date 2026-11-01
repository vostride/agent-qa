// The model arrives built, and no tool has an execute callback, so this stage only plans.

import { generateText } from 'ai'
import type { LanguageModel, ToolSet } from 'ai'

import { buildChatPrompt } from './chat-prompt.js'
import type { ChatPromptInput } from './chat-prompt.js'
import type {
  PlannerStageFailure,
  PlannerStageOutcome,
  PlannerStagePort,
  PlannerStageRequest,
  PlannerToolCall,
} from './ports.js'

/** A model OBJECT, never a model id: an id would be resolved by constructing a client. */
export type ChatLanguageModel = Exclude<LanguageModel, string>

/** What the prompt's context and volatile tiers state about the session, read per turn. */
export type ChatSessionPromptContext = Omit<ChatPromptInput, 'utterance' | 'clauses'>

export interface PlannerStageDeps {
  // Built by the host through `createModel`, so masking and profile resolution always apply.
  readonly model: ChatLanguageModel
  /** The registry projection from `planner-tools.ts`. Execute-less, by that module's contract. */
  readonly tools: ToolSet
  // Read per request with the session, because one cached stage serves every session.
  readonly context: (request: PlannerStageRequest) => ChatSessionPromptContext
}

/** The refusal NAME a provider published, or the closest honest thing to it. */
function toStageFailure(error: unknown): PlannerStageFailure {
  if (error instanceof Error) {
    return { name: error.name === '' ? 'PlannerStageError' : error.name, message: error.message }
  }
  return { name: 'PlannerStageError', message: String(error) }
}

// Every call survives in model order, meta-tools included, so only reconciliation decides.
export function readBackPlan(
  toolCalls: readonly { readonly toolName: string; readonly input: unknown }[],
): PlannerStageOutcome {
  const plan: PlannerToolCall[] = toolCalls.map((call) => ({
    toolName: call.toolName,
    input: call.input,
  }))

  return { toolCalls: plan }
}

/**
 * Build stage 2 over an already-constructed model and an already-projected toolset.
 *
 * Both arrive from the composition root, and neither is reachable from here: this module cannot
 * build a model and cannot widen a toolset. What it can do is ask, and read the answer back.
 */
export function createPlannerStage(deps: PlannerStageDeps): PlannerStagePort {
  return {
    async plan(request): Promise<PlannerStageOutcome> {
      const { system, prompt } = buildChatPrompt({
        utterance: request.utterance,
        clauses: request.clauses,
        ...deps.context(request),
      })

      try {
        const result = await generateText({
          model: deps.model,
          tools: deps.tools,
          instructions: system,
          prompt,
        })
        return readBackPlan(result.toolCalls)
      } catch (error) {
        return { toolCalls: [], failure: toStageFailure(error) }
      }
    },
  }
}
