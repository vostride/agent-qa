// No seat is config-reachable, so nothing in config can switch off the reconciliation override.

import type { ModelMessage } from 'ai'

import type {
  ChatCompactionEvent,
  ChatTurnStatus,
  ClauseReceipt,
  FunctionCaller,
} from '@vostride/agent-qa-schema'

import type { ClauseVerdict } from '../functions/spec.js'
import type { ChatDirectiveName } from './resolver-table.js'
import type { SessionReplay } from './session-repair.js'

/** One piece of an utterance, as the splitter produced it. */
export interface ChatClause {
  /** The clause text exactly as the person typed it — what a refusal has to be able to name. */
  readonly text: string
  readonly index: number
}

/** A clause the deterministic table resolved: which op, and with what arguments. */
export interface ResolvedClause {
  readonly clause: ChatClause
  readonly functionId: string
  readonly args: unknown
}

// One word for the caller mint and the action's provenance, so the two cannot disagree.
export type ChatBindingStage = 'resolver' | 'planner'

// `source` is carried: matching on `functionId` would mint `human` for a planner-made call.
export interface ClauseAction extends ResolvedClause {
  readonly source: ChatBindingStage
}

/**
 * One tool call the model proposed. UNEXECUTED, and unexecutable — the tools it was offered carry
 * no execute callback, so the SDK returned a description of an intention and nothing more.
 *
 * `input` is `unknown` on purpose. It has crossed no contract yet: what validates it is the op's
 * own live schema inside `invokeFunction`, and a shape asserted here would be a second validator
 * standing in front of the real one, free to disagree with it.
 */
export interface PlannerToolCall {
  /** The provider-facing tool name. `tool-names.ts` maps it back to a function id. */
  readonly toolName: string
  readonly input: unknown
}

// A transport, auth or provider failure is data, so the turn ends with a receipt, not a crash.
export interface PlannerStageFailure {
  readonly name: string
  readonly message: string
}

// No `answer` field: the verdict's `answer`, built from consumed claims, is the one prose carrier.
export interface PlannerStageOutcome {
  readonly toolCalls: readonly PlannerToolCall[]
  /** Present when the model could not be reached or refused; the turn fails, never hangs. */
  readonly failure?: PlannerStageFailure
}

// Optional: a host with no model is headless, and unresolved clauses fail the turn by name.
export interface PlannerStagePort {
  plan(request: PlannerStageRequest): Promise<PlannerStageOutcome>
}

// `sessionId` tells a composition serving two conversations which one to assemble.
export interface PlannerStageRequest {
  readonly utterance: string
  readonly clauses: readonly ChatClause[]
  readonly sessionId: string
}

// `planned` is the raw outcome, because aligning tool calls to clauses is reconciliation itself.
export interface ReconcileInput {
  readonly clauses: readonly ChatClause[]
  readonly mapped: readonly ResolvedClause[]
  readonly planned: PlannerStageOutcome
}

// `unhandled` and `execute` exclude each other: an unhandled verdict carries an empty plan.
export type ReconcileVerdict =
  | {
      readonly kind: 'execute'
      readonly plan: readonly ClauseAction[]
      // Rides the execute verdict, because an answered turn completed what was asked.
      readonly answer?: string
    }
  | { readonly kind: 'unhandled'; readonly clause: ChatClause; readonly reason: string }

// A pure function, so a differential can compose the host with two strategies and compare.
export type ReconcileStrategy = (input: ReconcileInput) => ReconcileVerdict

export type ClauseSplitter = (utterance: string) => readonly ChatClause[]

// `origin` is per call, attributing each clause to the stage that bound it; no op withholds by it.
export interface CallerMint {
  forStage(stage: ChatBindingStage): FunctionCaller
}

// A closure over `invokeFunction`, not a registry handle, so the seam cannot run a spec directly.
export type ChatInvokeBinding = (
  functionId: string,
  input: unknown,
  caller: FunctionCaller,
) => Promise<ChatInvokeAnswer>

// The fold lives on each op's spec, so the composition root classifies and sends the verdict here.
export interface ChatInvokeAnswer {
  /**
   * The op's own result, masked as the function layer returned it.
   *
   * NEVER RESTORED ON THIS PATH. It reaches `results[]` on the turn contract, the session log and
   * every `agent.ask` client in this form; each surface's emit masks with the declared secrets.
   */
  readonly payload: unknown
  // Fail-closed: a fold that throws or answers a non-verdict yields `failed`, never `executed`.
  readonly verdict: ClauseVerdict
  /** The op's declared render fold, or `[]`. ADDITIVE — these lines never replace the payload. */
  readonly foldLines: readonly string[]
}

// Handed the repaired replay, so the degrade pass has no unrepaired input to prune.
export type CompactionHook = (context: {
  readonly turnId: string
  // A pruned conversation belongs to one session, so the hook must know which.
  readonly sessionId: string
  /** The conversation as of this turn's start: repaired, aborted turns already excluded. */
  readonly replay: SessionReplay
  // The append of the turn being compacted, so its event cannot land in another conversation.
  readonly append: (event: ChatCompactionEvent) => Promise<void>
}) => Promise<void> | void

// The engine builds the `model_change` event through `diffChatConfig`, its one construction site.
export interface ChatModelDirectiveOutcome {
  readonly from: string
  readonly to: string
  /** The line the surface prints back. The handler renders it, because it knows what it resolved. */
  readonly line: string
}

// Every member is optional: the engine refuses an unbound directive by name.
export interface ChatDirectiveHandlers {
  readonly model?: (name: string) => ChatModelDirectiveOutcome | Promise<ChatModelDirectiveOutcome>
  readonly help?: () => string
  readonly quit?: () => string
  // Runs over every directive before the first applies, and mutates nothing.
  readonly validate?: (
    directive: ChatDirectiveName,
    argument?: string,
  ) => void | Promise<void>
}

// A sink, not the container: the engine writes the turn id and outcome and reads nothing back.
export interface ChatTurnStateSink {
  beginTurn(turnId: string): void
  /**
   * The repaired conversation, published every turn BEFORE the degrade pass runs.
   *
   * Published by the engine rather than only by the compaction hook, because a host that binds no
   * accounting still has a conversation — and a prompt that saw one only on hosts with a token
   * budget would be two different prompts wearing one name. Where a hook IS bound it publishes
   * again with the pruned result, and last write wins, which is the order the engine already
   * enforces for the same reason.
   */
  setConversation(messages: readonly ModelMessage[]): void
  endTurn(turn: {
    readonly turnId: string
    readonly status: ChatTurnStatus
    readonly receipts: readonly ClauseReceipt[]
    readonly answer?: string
  }): void
}
