// Stage 2 — the tool-bound planner.
//
// THE MODEL ARRIVES BUILT. This module takes a `LanguageModel` as a constructor argument and does
// not construct one: it names no provider package, and it does not name `createModel` either. That
// is CHAT-06 stated structurally rather than as a convention — every chat model call rides the one
// entry the host composes, which is where the masking middleware and the profile resolution live,
// so there is no arrangement of this file in which a chat turn reaches a provider that skipped
// them. The `packages/arch` chat-model rollcall reds the build if that ever stops being true.
//
// THE STAGE PRODUCES A PLAN AND NOTHING ELSE. `generateText` executes a tool exactly when the tool
// carries a function to run, and `projectPlannerTools` gives none of them one — so what comes back
// is the model's proposal, in `result.toolCalls`, with zero side effects behind it. Reconciliation
// then decides what that proposal means. This is the strongest available form of "nothing
// runs before the verdict": not an ordering somebody maintains, but an absent callback.
//
// A TRANSPORT FAILURE IS DATA, NOT A CRASH. An auth refusal, a rate limit or an outage is a fact
// about this turn. It comes back as `failure` on the outcome, the engine folds it into a failed
// turn with a named receipt, and the session survives. A thrown error here would surface as a stack
// trace over a REPL and leave the session log with a turn that neither completed nor failed.
//
// A NOTE ON THE STRING FORM OF `LanguageModel`. The SDK's own type also admits a bare model id,
// which it resolves through a global provider registry — i.e. it constructs a client. That variant
// is excluded from {@link ChatLanguageModel} on purpose: it is a second door to the thing CHAT-06
// closes, and it is closed here at the type rather than by asking hosts not to walk through it.

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
  /** Built by the host through `createModel` and handed over — CHAT-06. */
  readonly model: ChatLanguageModel
  /** The registry projection from `planner-tools.ts`. Execute-less, by that module's contract. */
  readonly tools: ToolSet
  /**
   * Read once per REQUEST rather than captured at construction, because the model in force, the
   * pending-count facts and the conversation all change WITHIN a session — a `/model` directive
   * mid-session is the obvious case, and a stage holding a snapshot would prompt against a
   * session that no longer exists.
   *
   * IT IS TOLD WHICH SESSION IS ASKING. A composition caches one stage per
   * model NAME, so the same stage serves every session planning under that model; a thunk taking
   * no argument therefore had exactly one conversation available to answer with, and on two
   * interleaved turns that was whichever session published last. The request is the only thing
   * here that knows whose turn this is.
   */
  readonly context: (request: PlannerStageRequest) => ChatSessionPromptContext
}

/** The refusal NAME a provider published, or the closest honest thing to it. */
function toStageFailure(error: unknown): PlannerStageFailure {
  if (error instanceof Error) {
    return { name: error.name === '' ? 'PlannerStageError' : error.name, message: error.message }
  }
  return { name: 'PlannerStageError', message: String(error) }
}

/**
 * Shape the SDK's tool calls into the plan stage 3 reads.
 *
 * NOTHING IS DROPPED AND NOTHING IS PROJECTED. Every call survives into `toolCalls` in the order
 * the model made them, meta-tools included: `mark_unhandled` is a proposal about the turn that only
 * reconciliation can act on, and filtering it here would put the fail-closed decision in the
 * component whose input is the untrusted one.
 *
 * THE `answer` PROJECTION IS GONE. This function used to lift the FIRST `answer_only`
 * call's text onto the outcome as a convenience — and once the tool contract asked for one call per
 * answered clause, that convenience became a SECOND prose channel carrying strictly less than the
 * calls it was derived from: reconciliation counted every claimed clause as answered while the
 * person read the first answer only (392-VERIFICATION round 2, path (4)). The calls are the whole
 * of what the model said; whoever needs the prose reads the claims it belongs to.
 */
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
          system,
          prompt,
        })
        return readBackPlan(result.toolCalls)
      } catch (error) {
        return { toolCalls: [], failure: toStageFailure(error) }
      }
    },
  }
}
