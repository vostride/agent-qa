// The turn engine's injected seams (Phase 392, D-16 / RESEARCH Pitfall 1).
//
// EVERY SEAT IS DECLARED NOW, including the ones nothing fills yet. The tracer ships one stage-1
// path, but a turn engine whose planner seat, reconciliation seat and compaction seat arrive later
// is a turn engine that gets re-architected three times — and each of those rewrites happens after
// sibling plans have composed against the previous shape. Declaring the seats up front costs a few
// optional members and buys every expansion plan a fill rather than a redesign.
//
// NONE OF THESE IS CONFIG-REACHABLE, and that is load-bearing rather than tidy. D-16's whole point
// is that the reconciliation override — the mechanism that stops a model's plan from beating the
// deterministic mapper's — must be switchable by a DIFFERENTIAL and by nothing else. A config field
// that could turn it off would be a production knob that disables a safety property, which is the
// one thing the mutation proof exists to prove impossible.

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

/**
 * WHICH STAGE PROVED A BINDING (RESEARCH Pitfall 1 / 391 D-06).
 *
 * The same word names the caller mint and the action's provenance on purpose: the origin a clause
 * executes under is decided by which stage bound it, and giving the two ideas separate vocabularies
 * would let them drift into disagreeing about the same clause.
 */
export type ChatBindingStage = 'resolver' | 'planner'

/**
 * One step of an execute verdict: a binding, and the stage that proved it.
 *
 * `source` is carried rather than re-derived, and that is a correctness decision rather than a
 * convenience. The engine has to mint a caller per action, and the only honest input to that choice
 * is which stage produced the binding — a fact reconciliation KNOWS and every later consumer would
 * have to guess at by matching the action back against the mapper set. A guess that matched on
 * `functionId` would mint `human` for a planner-planned call to an op the table also knows, which
 * is exactly the self-grant 391 D-06 withholds.
 */
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

/**
 * A stage-2 failure the engine folds into a failed turn.
 *
 * A transport error, an auth refusal or a provider outage is a fact about this turn, not a crash of
 * the session — so it is DATA rather than a thrown error, and the turn ends with a receipt instead
 * of a hang or a stack trace. The name is the provider's own refusal name where there is one, which
 * keeps it on the same footing as every other refusal a receipt carries.
 */
export interface PlannerStageFailure {
  readonly name: string
  readonly message: string
}

/**
 * What stage 2 produces: a PLAN, and never an effect.
 *
 * `toolCalls` carries EVERY call the model made, meta-tools included and in the order it proposed
 * them. Nothing is filtered out here, because stage 3 is the component that decides what a plan
 * means and a stage that pre-digested it would be making that decision one layer early, out of
 * sight of the reconciliation the whole design exists to route through.
 *
 * THERE IS NO `answer` FIELD, and its absence is load-bearing. This outcome used to carry
 * a convenience projection of the FIRST `answer_only` call's prose, which became a second prose
 * path the moment the tool contract moved to one call per answered clause: reconciliation counted
 * every claimed clause as answered and the person received the first answer only. The prose now
 * has exactly one carrier — the verdict's `answer`, built from the claims the merge actually
 * consumed — and a projection that could disagree with it no longer exists to be read.
 */
export interface PlannerStageOutcome {
  readonly toolCalls: readonly PlannerToolCall[]
  /** Present when the model could not be reached or refused; the turn fails, never hangs. */
  readonly failure?: PlannerStageFailure
}

/**
 * Stage 2 — the tool-bound planner.
 *
 * OPTIONAL AT THE COMPOSITION, and its absence is a real production posture rather than a stub:
 * a host with no model bound is HEADLESS, and the correct behaviour there is that any clause the
 * table cannot resolve fails the turn closed by name. A stubbed planner that answered "I could not
 * plan that" would say the same words about a completely different fact — that a model was asked
 * and declined — and the two need to stay distinguishable in the log.
 */
export interface PlannerStagePort {
  plan(request: PlannerStageRequest): Promise<PlannerStageOutcome>
}

/**
 * What stage 2 is asked, INCLUDING WHOSE TURN IS ASKING.
 *
 * `sessionId` is not decoration on a prompt. The context a composition builds for this call — the
 * conversation replayed into the request, the model in force — are facts about ONE session, and a
 * composition serving two conversations at once has no other way to know which of them it is
 * assembling a request for. Without it the planner reads whichever conversation was published
 * most recently, which on an interleaved pair is the OTHER person's.
 */
export interface PlannerStageRequest {
  readonly utterance: string
  readonly clauses: readonly ChatClause[]
  readonly sessionId: string
}

/**
 * What stage 3 is given: what the table proved, and what the model proposed.
 *
 * `planned` is the model's RAW outcome rather than a set of resolved clauses, and the difference is
 * where the safety property lives. Aligning tool calls to clauses IS reconciliation — deciding
 * which proposal answers which part of the request, and whose binding wins where the table already
 * has one. A stage 2 that handed over pre-aligned clauses would have made that decision
 * already, in the one component whose input is untrusted model output.
 */
export interface ReconcileInput {
  readonly clauses: readonly ChatClause[]
  readonly mapped: readonly ResolvedClause[]
  readonly planned: PlannerStageOutcome
}

/**
 * What stage 3 decides.
 *
 * `unhandled` and `execute` are mutually exclusive by contract rather than by shape, and the
 * asymmetry is D-10: reconciliation completes BEFORE the first side effect, so a verdict naming an
 * unhandled clause carries an empty execution plan and the turn ends with `executed == 0`.
 */
export type ReconcileVerdict =
  | {
      readonly kind: 'execute'
      readonly plan: readonly ClauseAction[]
      /**
       * The prose a turn answers with when the model answered rather than acted.
       *
       * It rides the EXECUTE verdict, with an empty plan in the pure case, because an answered turn
       * completed — it did what was asked. Giving it a third verdict variant would have made
       * "answered" a sibling of "refused", and every consumer would then have to remember that one
       * of the two non-execute outcomes is a success.
       */
      readonly answer?: string
    }
  | { readonly kind: 'unhandled'; readonly clause: ChatClause; readonly reason: string }

/**
 * Stage 3 — deterministic reconciliation.
 *
 * A pure function, supplied at engine CONSTRUCTION. The purity is what makes the mutation proof
 * possible at all: the differential composes the real host twice with two strategies and reads the
 * difference off a named scenario, without a single production code path knowing which it got.
 */
export type ReconcileStrategy = (input: ReconcileInput) => ReconcileVerdict

/**
 * The deterministic conjunction splitter.
 *
 * A seam rather than a hard-coded call because plan 02 replaces the tracer's whole-utterance
 * splitter with the quote-aware tokenizer, and the engine must not need editing for that.
 */
export type ClauseSplitter = (utterance: string) => readonly ChatClause[]

/**
 * Per-stage caller minting (RESEARCH Pitfall 1 / 391 D-06).
 *
 * `FunctionCaller.origin` is a per-CALL fact, not a per-surface one: a person typing a canonical
 * alias IS a human acting, and a model planning a call is not, and both happen inside one turn, so a
 * receipt attributes each clause to the stage that bound it. 2026-10-02: the
 * origin is attribution only; no op withholds anything by it.
 */
export interface CallerMint {
  /**
   * The caller for one binding stage.
   *
   * no `sessionId` parameter. It only ever stamped the retired
   * `FunctionCaller.sessionId` (392 plan 13), which nothing read after the session deny overlay left
   * (432-13/432-19); the production mint ignored it, and the caller member is deleted.
   */
  forStage(stage: ChatBindingStage): FunctionCaller
}

/**
 * Stage-4's dispatch binding.
 *
 * A closure over `invokeFunction` supplied by the composition root, NOT a registry handle. Two
 * reasons and the second is the structural one: `agent`'s chat subtree would otherwise import the
 * registry it is registered inside, and — more importantly — a seam typed as "call this op for me"
 * cannot become a seam that runs a spec directly.
 */
export type ChatInvokeBinding = (
  functionId: string,
  input: unknown,
  caller: FunctionCaller,
) => Promise<ChatInvokeAnswer>

/**
 * What an op answered, classified — the seam's return type since 399.1.
 *
 * WHY THE VERDICT ARRIVES AS DATA RATHER THAN BEING COMPUTED HERE. The engine cannot classify a
 * result: the fold that knows which arm of an op's union is a refusal lives on that op's SPEC, and
 * this seam is deliberately not a registry handle (the paragraph above, 384 FUNC-03). The one place
 * in the system holding both the registry and this call is the composition root that mints the
 * binding, so that is where the fold runs and this is how its answer travels. The engine reads three
 * fields; it reaches for nothing.
 *
 * THIS TYPE IS WHY THE SEAM CHANGED AT ALL. `Promise<unknown>` was a seam that could carry the
 * RESULT and nothing about it, so the engine's only available derivation for a receipt status was
 * throw-versus-return — and every arm of a typed refusal returns. G-399-2 is that gap measured: a
 * credential-blocked config mutation reported `executed` in green.
 */
export interface ChatInvokeAnswer {
  /**
   * The op's own result, masked as the function layer returned it.
   *
   * NEVER RESTORED ON THIS PATH. It reaches `results[]` on the turn contract, the session log and
   * every `agent.ask` client in this form; each surface's emit masks with the declared secrets.
   */
  readonly payload: unknown
  /**
   * The classifier's answer, or the legacy verdict when the op declares no classifier.
   *
   * FAIL-CLOSED: a fold that throws, or answers something that is not a verdict, yields
   * `failed` with a named outcome — never `executed`. An unreadable result might be a refusal, and
   * success is the one claim a receipt must not default to.
   */
  readonly verdict: ClauseVerdict
  /** The op's declared render fold, or `[]`. ADDITIVE — these lines never replace the payload. */
  readonly foldLines: readonly string[]
}

/**
 * CHAT-04's degrade pass, as a seam the tracer leaves empty.
 *
 * Declared now for the reason every other seat here is: plan 06 fills it over the shipped
 * `TokenAccounting` substrate, and an engine that grew a compaction call later would grow it in the
 * middle of the turn contract this file pins.
 *
 * IT IS HANDED THE REPLAY, AND THAT IS WHAT MAKES CHAT-05'S ORDERING STRUCTURAL. The requirement is
 * that the replay-safety repair runs BEFORE pruning, and a hook that received nothing would have to
 * fetch its own messages — at which point nothing in the type stops it fetching them from an
 * unrepaired source. Receiving an already-repaired replay leaves the degrade pass no other input to
 * prune, so "repair first" is a fact about the argument rather than a rule someone has to remember.
 */
export type CompactionHook = (context: {
  readonly turnId: string
  /**
   * The session this turn belongs to.
   *
   * Beside `append` for the same reason `append` is here: what a pass produces — the pruned
   * conversation — belongs to ONE conversation, and the sink a host publishes it into is one
   * container per session. A hook that knew the turn but not the session could write a pruned
   * history into whichever conversation asked most recently.
   */
  readonly sessionId: string
  /** The conversation as of this turn's start: repaired, aborted turns already excluded. */
  readonly replay: SessionReplay
  /**
   * Where this pass's one event goes: the SESSION HANDLE of the turn being compacted.
   *
   * The hook used to hold an `emit` bound at composition time, which — while the adapter owned a
   * single mutable descriptor — meant "the session whose open ran most recently" rather than "the
   * session this turn belongs to". Passing the append IN makes the destination a fact about the
   * call, so a compaction event cannot land in another conversation however many turns are in
   * flight. The hook still holds no log of its own; it holds one turn's writer for the length of
   * one call.
   */
  readonly append: (event: ChatCompactionEvent) => Promise<void>
}) => Promise<void> | void

/**
 * What a `/model` directive did.
 *
 * The handler applies the override and REPORTS the two model names, rather than emitting anything.
 * The engine is what turns the pair into a `model_change` event, through the same `diffChatConfig`
 * the per-turn config re-read uses — so there is ONE construction site for that event and the
 * `source` field is what distinguishes a person typing from a file changing underneath them.
 */
export interface ChatModelDirectiveOutcome {
  readonly from: string
  readonly to: string
  /** The line the surface prints back. The handler renders it, because it knows what it resolved. */
  readonly line: string
}

/**
 * The session directives, as handlers a composition binds.
 *
 * EVERY MEMBER IS OPTIONAL, and an absent one is not a gap: the engine's refusal arm names an
 * unbound directive by name, which is the honest answer for a build that recognises `/model` and
 * cannot carry it out. A host that binds none behaves exactly as every host did before this seam
 * existed.
 *
 * A HANDLER MAY THROW, AND THROWING IS AN ANSWER. That refusal travels the engine's ONE refusal
 * path, so it leaves the same `mark_unhandled` row every other refused clause does.
 *
 * `/pin` and its handler are gone with the op gate they tightened.
 */
export interface ChatDirectiveHandlers {
  readonly model?: (name: string) => ChatModelDirectiveOutcome | Promise<ChatModelDirectiveOutcome>
  readonly help?: () => string
  readonly quit?: () => string
  /**
   * THE BATCH PRE-FLIGHT: state the refusal before ANY directive of this turn is applied.
   *
   * The engine runs this over EVERY collected directive and only then applies the first one, so a
   * throw here refuses the whole turn with zero effects. That is D-10's own shape — reconciliation
   * completes before the first side effect — applied to a directive BATCH.
   *
   * IT MUTATES NOTHING, and that is the member's whole contract. Asking whether a directive CAN be
   * carried out is a different act from carrying it out, exactly as `directiveBindingRefusal` is.
   * Resolving and caching a value the apply will reuse is permitted, because a cache is not a
   * session's state.
   *
   * OPTIONAL, so a host that publishes none is exactly as safe as it was: `runDirective`'s catch
   * remains the belt, and the only thing such a host loses is the batch guarantee.
   */
  readonly validate?: (
    directive: ChatDirectiveName,
    argument?: string,
  ) => void | Promise<void>
}

/**
 * Where the engine publishes the live turn state a surface renders from (RESEARCH Open Q2).
 *
 * A SINK rather than the container, so the engine can write the two facts only it holds — the
 * minted turn id and the turn's outcome — without acquiring the ability to read or reshape the
 * rest of a surface's state. The id is the load-bearing one: it is minted inside `runTurn`, and a
 * Ctrl+C handler that wants to write the explicit `aborted` event D-19 asks for has no other way
 * to name the turn it is interrupting.
 */
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
