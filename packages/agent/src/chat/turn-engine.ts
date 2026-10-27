// The four-stage turn engine (Phase 392, CHAT-01 / CHAT-05 / D-01 / D-08 / D-10 / D-24).
//
// ONE turn engine, two surfaces. The interactive REPL, the one-shot `ask` verb and the scenario
// harness all drive this same entry — and they reach it through the registered `agent.ask` op, not
// by holding this object (D-24). Chat therefore has no private powers: every capability a turn
// exercises crosses `invokeFunction`'s eight-step gate exactly as a typed CLI verb does.
//
// THE STAGE ORDER IS A PINNED CONTRACT, in the house style `invoke.ts:123-134` sets:
//
//   1. deterministic resolver — the closed table, over the clause split. Precision 1.0 by
//      construction: an exact predicate hit or nothing, never a guess (D-09).
//   2. planner LLM          — via `PlannerStagePort`, and SKIPPED ENTIRELY when stage 1 resolved
//      every clause. Skipping is the tracer's whole point and a permanent property of canonical
//      utterances: they are model-independent, which is what makes their scenarios stable.
//   3. deterministic reconciliation — the injected strategy. Runs on single-clause turns too, so
//      there is one code path rather than a fast one and a careful one.
//   4. verdict + sequential execution — in utterance order, stopping on the first runtime failure,
//      one receipt per clause (D-11).
//
// STAGE 3 COMPLETES BEFORE STAGE 4 BEGINS, and that ordering IS D-10's strict pre-flight atomicity.
// An unroutable clause anywhere in the utterance rejects the whole turn with zero executions and a
// message naming it. There is no arrangement of these four stages in which a side effect precedes
// the verdict, and that is the property `compound/` scenarios pin as `executed == 0`.
//
// EVERY EFFECT, NOT ONLY THE DISPATCHED ONES (392-11, CR-04). A session DIRECTIVE mutates the
// session rather than the project — `/model` overrides the model — and those effects used to happen
// above stage 2, so a refused turn could tell a person "nothing in the request was carried out"
// while a directive was already in force. The binding question ("can this build carry this out at
// all") is pure and stays early; the carrying-out sits below the verdict with everything else.
//
// NO TURN WRITES AN APPROVAL (432-13, D-14). The `/pin` directive and its `approval_decision` row are
// gone with the op gate; `approval_decision` stays a readable kind for sessions written before 432.
//
// THIS ENGINE NEVER BRANCHES ON `caller.surface`. The anti-pattern is named in `invoke.ts:28-29`
// and it is the thing the function layer exists to abolish; what varies per stage here is the
// ORIGIN the composition minted, which is a fact about who is acting, not about where from.

import type {
  AgentAskInput,
  AgentAskResult,
  ChatSessionEvent,
  ChatSessionHandle,
  ClauseReceipt,
  ClauseResult,
  ChatTurnStatus,
  FunctionCaller,
  SessionLogPort,
} from '@vostride/agent-qa-schema'

import { AUTHORING_DRAFT_WRITE_FUNCTION_ID } from '../functions/ops/authoring-draft-write.js'
import { CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID } from '../functions/ops/config-project-scaffold.js'
import {
  WRITE_TEST_UNCONFIGURED_DETAIL,
  writeTestScaffoldStopDetail,
  resolveWriteTestRoute,
} from '../config-mutation/write-test-route.js'

import type {
  CallerMint,
  ChatClause,
  ChatDirectiveHandlers,
  ChatInvokeBinding,
  ChatTurnStateSink,
  ClauseSplitter,
  CompactionHook,
  PlannerStageOutcome,
  PlannerStagePort,
  ReconcileStrategy,
  ResolvedClause,
} from './ports.js'
import { diffChatConfig, foldChatConfigState } from './config-drift.js'
import type { ChatConfigState } from './config-drift.js'
import { replayToModelMessages } from './compaction.js'
import { directiveNotBoundReason, resolveClause } from './resolver-table.js'
import { retiredChatVerbReason } from './retired-chat-verbs.js'
import { replaySession } from './session-repair.js'
import { SESSION_STAMPED_FUNCTION_IDS, WINDOW_STAMPED_FUNCTION_IDS } from './session-stamps.js'
import type { ChatDirectiveName, ChatResolverTable } from './resolver-table.js'

export interface TurnEngineDeps {
  readonly table: ChatResolverTable
  readonly split: ClauseSplitter
  readonly reconcile: ReconcileStrategy
  readonly sessionLog: SessionLogPort
  readonly mint: CallerMint
  readonly invoke: ChatInvokeBinding
  /** Absent ⇒ headless: an unresolved clause fails the turn closed BY NAME (D-08). */
  readonly planner?: PlannerStagePort
  readonly compaction?: CompactionHook
  /**
   * The configuration in force RIGHT NOW for THIS SESSION, re-read per turn (D-04, CR-02).
   *
   * A THUNK rather than a value, and that is the whole of "config changes are events": a value
   * captured at construction would be the configuration the host started with, and the drift this
   * seam exists to detect is precisely the case where the file changed underneath a running
   * session. Absent ⇒ this host does not re-read, and nothing is claimed about drift — which is
   * different from claiming there was none, and is why the seam is optional rather than defaulted.
   *
   * IT IS HANDED THE SESSION for the reason `state` below is: the answer includes the model in
   * force, a `/model` override is session-scoped by D-04, and a composition-wide re-read would
   * report one session's override as every session's drift.
   */
  readonly config?: (sessionId: string) => ChatConfigState | Promise<ChatConfigState>
  /**
   * The session directives, where a host binds any, RESOLVED PER SESSION (D-04 / CR-02).
   *
   * Absent, or absent for one directive, means the refusal arm below names it. That is not a
   * degraded mode: a build that recognises `/model` and cannot carry it out should say so, and the
   * `mark_unhandled` row it leaves is what makes the gap countable.
   *
   * A FACTORY, because a directive mutates a session: `/model` moves the model this conversation
   * plans under, `/quit` asks THIS loop to end. Handlers bound once per composition would carry
   * those effects to whoever asked next (W-03).
   */
  readonly directives?: (sessionId: string) => ChatDirectiveHandlers
  /**
   * Where the live turn state a surface renders from is published, PER SESSION (Open Q2, CR-02).
   *
   * The turn id goes out at the START of the turn rather than with the result, and that ordering is
   * the whole reason the seam exists — an interrupted turn never produces a result, so a Ctrl+C
   * handler that waited for one could never name the turn it was interrupting (D-19's graceful arm).
   *
   * A FACTORY OVER THE SESSION ID, resolved once per turn from the header `open()` returned. What
   * this sink carries — the turn in flight, the conversation, the model — are facts about ONE
   * conversation, and a sink held per composition made them facts about whichever turn wrote last.
   * The engine cannot resolve it any earlier than the open, because a turn that names no session is
   * given one BY the adapter and the id is the adapter's answer rather than the caller's input.
   */
  readonly state?: (sessionId: string) => ChatTurnStateSink
  /**
   * This project's configured target vocabulary, for the PRE-DISPATCH write_test route (395-08,
   * D-14/D-15 · CFGM-05).
   *
   * A THUNK for `config`'s reason: a scaffold applied earlier in this very turn changes the answer,
   * and a value captured at composition would send the authoring dispatch that follows it against
   * the vocabulary as it stood before the scaffold wrote anything (2026-10-02, 432-40: re-spelled
   * from "before the person approved anything" — the scaffold writes in the call, D-05/D-14).
   *
   * BOUND FROM THE SAME PORT THE AUTHORING LOOP READS (`AuthoringReadPortLike.configuredTargetNames`),
   * so "which targets does this project declare" has one answer on both sides of the dispatch. Two
   * readings of that question would let this seam route on a vocabulary the loop then disagrees with,
   * which is the sibling-input failure this project keeps rediscovering.
   *
   * ABSENT ⇒ NO ROUTING. A host that cannot name its targets dispatches authoring exactly as it did
   * before this seam existed, and the loop's own backstop is unchanged. That is deliberately the
   * permissive direction: this seam adds a scaffold offer and a refusal, and a host that cannot
   * answer the question has not lost a guard — the backstop it always had is still there.
   */
  readonly configuredTargets?: () => Promise<readonly string[]>
  /**
   * Where a mid-turn artifact a person should read is written (395-13 · CFGM-05).
   *
   * DISPLAY-ONLY. Nothing handed to this port enters a decision, and nothing waits on it.
   *
   * 2026-09-30, 432-11 D-05/D-14: the `write_test` scaffold route writes the configuration in the
   * scaffold call itself, so what this port shows is a receipt of a change already on disk: the
   * summary, the files written and the diff. It is no longer a precondition of an approval, because
   * there is no approval. An absent port, or one that fails, does not stop the turn; the clause
   * receipt still names the files the scaffold wrote.
   */
  readonly present?: (text: string) => void | Promise<void>
  readonly now: () => string
  readonly mintTurnId: () => string
}

/** What `agent.ask` is bound to. One method, because a turn is one thing that happens. */
export interface TurnEngine {
  runTurn(input: AgentAskInput): Promise<AgentAskResult>
}

/**
 * A one-line outcome summary, never a payload body (D-18).
 *
 * The log and the receipt are a MAP: they say which op ran and how it went, and the result itself
 * stays wherever the op put it. `JSON.stringify(result)` here would be the single easiest way to
 * put a knowledge record, a config value or a masked secret into a file several surfaces render.
 *
 * THIS IS THE FALLBACK NOW, NOT THE RULE (399.1-03). An op that declares a classifier says how it
 * went in its own words and this line is never reached for it; what remains here is the honest
 * answer for an op that has said nothing about its own result — which is the same line every op
 * printed before folds existed.
 *
 * THE 394-14 EXCEPTION LEFT THIS FILE AND ITS REASONING WENT WITH IT. `summariseOutcome` used to
 * append `authoring.draft.write`'s fan-out report by an explicit id comparison here; that
 * disclosure is now a `renderResult` fold declared on the op's own spec, where the whole argument
 * for it (WTST-08's preview-plus-honest-reporting, and why counts are a map rather than a
 * territory) is recorded. The exception is no longer a named branch in a shared function — it is a
 * member of one spec, which is the same claim enforced by construction rather than by a comparison
 * somebody could widen.
 */
function summarise(functionId: string): string {
  return `${functionId} completed`
}

// The stamped vocabulary now lives in `session-stamps.ts`, because the model-facing projection in
// `planner-tools.ts` must withhold exactly what the stamp below writes (394-22, G-1). Re-exported
// here so the sets stay readable from the module that acts on them.
export { SESSION_STAMPED_FUNCTION_IDS, WINDOW_STAMPED_FUNCTION_IDS }

/**
 * Stamp the chat session onto the args of the ops this surface owns the session facts for.
 *
 * TWO LAWS, AND THEY POINT OPPOSITE WAYS ON PURPOSE. The receipt ref is an OVERWRITE AND NEVER A
 * DEFAULT — a `sessionRef` the planner emitted is a value a model wrote, honouring it would let a
 * model attribute its draft to another author's keep rate, and an absent one must stay absent
 * because absence is exclusion on a receipt. The funnel WINDOW is D-12's ratified SURFACE default
 * on the read side: the op cannot construct it (`FunctionSpec.invoke` never sees a caller), so the
 * surface that knows its session supplies it, and only its session ARM's ref is overwritten —
 * all-time and last-n pass through untouched because a model may legitimately ask a wider
 * question.
 *
 * A non-object args value is handed back untouched — the ops' `.strict()` schemas refuse that call
 * anyway, and stamping a key onto a string would invent a shape nobody sent.
 */
function stampSessionFacts(functionId: string, args: unknown, sessionId: string): unknown {
  const stampsRef = SESSION_STAMPED_FUNCTION_IDS.has(functionId)
  const stampsWindow = WINDOW_STAMPED_FUNCTION_IDS.has(functionId)
  if (!stampsRef && !stampsWindow) return args
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args

  const stamped: Record<string, unknown> = { ...(args as Record<string, unknown>) }
  if (stampsRef) stamped.sessionRef = sessionId
  if (stampsWindow) {
    const window = stamped.window
    if (window === undefined) {
      stamped.window = { scope: 'session', sessionRef: sessionId }
    } else if (
      typeof window === 'object'
      && window !== null
      && !Array.isArray(window)
      && (window as { scope?: unknown }).scope === 'session'
    ) {
      stamped.window = { ...(window as Record<string, unknown>), sessionRef: sessionId }
    }
  }
  return stamped
}

/**
 * What stage 2 produced when it was skipped or when no planner is bound.
 *
 * The EMPTY plan rather than an absent one, so stage 3 reads one shape whatever happened upstream:
 * a reconciliation strategy that had to ask "was there a planner" before asking "what did it say"
 * would have two paths through the decision that refuses a turn, and only one of them would be
 * exercised by a host that binds a model.
 */
const NO_PLAN: PlannerStageOutcome = { toolCalls: [] }

/** The refusal NAME the function layer publishes, which is what a failed receipt carries. */
function refusalName(error: unknown): string {
  if (error instanceof Error) return error.name === '' ? error.message : error.name
  return String(error)
}

/** The refusal SENTENCE a person reads. See `routeWriteTest`'s catch for why not the name. */
function refusalMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : refusalName(error)
}

/**
 * The boundary verdict, ABOVE the change it is a verdict about (399.1, RC-2, criterion 4).
 *
 * WHAT WAS WRONG (history, 399.1). The pre-confirm render answered "what does this change do" —
 * summary line, file list, the true diff — and never answered "does this change cross a trust
 * boundary". The proposed arm filed that verdict as two required fields, and the one surface where
 * a person was asked to authorise the write showed them neither (`demo/acceptance/399/
 * ACCEPTANCE.md` §9 item 2). 2026-10-02 (432-40, D-05/D-14/D-15): there is no confirm, no proposal
 * and no grant machinery any more; the change is written in the call, and these lines disclose the
 * crossing on the applied answer the person reads.
 *
 * VERBATIM, NEVER A PARAPHRASE. Each reason is one of `CROSS_BOUNDARY_REASONS`' closed words
 * and it is printed as filed. A hand-written sentence per reason would be a SECOND answer to "why
 * is this crossing", free to disagree with the record the change answers with — which is the
 * drop-site lesson (D-04) applied to the field a person reads to see what crossed.
 *
 * THE FIELD NAMES ARE IN THE BYTES, deliberately. A person who reads `crossBoundary: true` here can
 * find the same field on the applied answer `agent-qa fn` and the MCP change tool return, and knows
 * they are looking at one fact rather than several surfaces' opinions of it. (432-12: changes apply
 * in the call, so there is no proposal to look it up in and nothing waits for review.)
 *
 * SILENT ON THE COMMON PATH. A change that crosses nothing contributes NO line, because a warning
 * printed over every change is one nobody reads — and an absent or non-boolean verdict is treated
 * as "no claim of crossing", never as a crossing, since the notice is a disclosure and inventing one
 * would be this function paraphrasing a producer that said nothing.
 */
function crossBoundaryLines(answer: {
  readonly crossBoundary?: boolean
  readonly crossBoundaryReasons?: readonly string[]
}): readonly string[] {
  if (answer.crossBoundary !== true) return []
  const reasons = answer.crossBoundaryReasons ?? []
  return [
    'CROSSES A TRUST BOUNDARY — crossBoundary: true; crossBoundaryReasons: '
    + (reasons.length === 0 ? '(none named)' : reasons.join(', ')),
  ]
}

/** What one directive did: a line to print back, or the reason the turn is refused. */
type DirectiveResult =
  | { readonly kind: 'handled'; readonly text: string }
  | { readonly kind: 'refused'; readonly reason: string }

/** One collected directive: the clause the table matched, and what it matched it as. */
interface DirectiveEntry {
  readonly clause: ChatClause
  readonly directive: ChatDirectiveName
  readonly argument?: string
}

/**
 * Is this directive CARRYABLE by this build — asked without carrying anything out (CR-04).
 *
 * A PURE READ OF `deps.directives`, and that purity is the whole reason this check may sit where
 * the execution loop used to. A build that recognises `/model` and binds no handler should say so
 * early, by name, before a model is ever consulted; but "say so early" is a statement about the
 * REFUSAL, not a licence to mutate a session before the verdict that authorises it. Splitting the
 * question from the act is what lets both properties hold at once.
 *
 * The refusal wording is `directiveNotBoundReason`'s, unchanged — `runDirective`'s own not-bound
 * arm reaches for the same function, so the two cannot drift into two answers to one question.
 */
function directiveBindingRefusal(
  handlers: ChatDirectiveHandlers | undefined,
  entry: DirectiveEntry,
): string | undefined {
  const bound = ((): boolean => {
    switch (entry.directive) {
      case 'model':
        return handlers?.model !== undefined && entry.argument !== undefined
      case 'help':
        return handlers?.help !== undefined
      case 'quit':
        return handlers?.quit !== undefined
    }
  })()
  return bound ? undefined : directiveNotBoundReason(entry.directive, entry.clause.text)
}

/**
 * Carry out one session directive.
 *
 * ONE EVENT IS BORN HERE and it goes through the vocabulary that already owns it. `/model`
 * produces its `model_change` through `diffChatConfig` — the SAME function the per-turn config
 * re-read calls, with `source: 'verb'` instead of `'config_reread'` — because a person switching
 * models and a file changing underneath a session are different FACTS and not different events
 * (392-07). No directive writes an `approval_decision` (432-13).
 */
async function runDirective(
  deps: TurnEngineDeps,
  handlers: ChatDirectiveHandlers | undefined,
  entry: DirectiveEntry,
  context: {
    readonly turnId: string
    readonly sessionId: string
    readonly append: (event: ChatSessionEvent) => Promise<void>
    readonly now: () => string
  },
): Promise<DirectiveResult> {
  const notBound = (): DirectiveResult => ({
    kind: 'refused',
    reason: directiveNotBoundReason(entry.directive, entry.clause.text),
  })

  try {
    switch (entry.directive) {
      case 'model': {
        if (handlers?.model === undefined || entry.argument === undefined) return notBound()
        const outcome = await handlers.model(entry.argument)
        if (outcome.from !== outcome.to && deps.config !== undefined) {
          // Built from the configuration AS IT NOW STANDS, with only the model wound back — so the
          // diff produces exactly one `model_change` and cannot invent a toolset drift the verb did
          // not cause. The handler has already applied the override, which is what makes the
          // current read the `to` side and what stops the next turn's re-read from emitting a
          // `model_change` straight back to the composed model (392-07's trap).
          const current = await deps.config(context.sessionId)
          for (const event of diffChatConfig(
            { ...current, model: outcome.from },
            current,
            { turnId: context.turnId, at: context.now(), source: 'verb' },
          )) {
            await context.append(event)
          }
        }
        return { kind: 'handled', text: outcome.line }
      }
      case 'help': {
        if (handlers?.help === undefined) return notBound()
        return { kind: 'handled', text: handlers.help() }
      }
      case 'quit': {
        if (handlers?.quit === undefined) return notBound()
        return { kind: 'handled', text: handlers.quit() }
      }
    }
  } catch (error) {
    // A handler that REFUSED — a `/model` naming a model this host cannot resolve is the shipped
    // case — is a clause this build could not carry out, so it takes the engine's one refusal path
    // and leaves the same countable row. The message is the refusal's own.
    return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }
  }
}

export function createTurnEngine(deps: TurnEngineDeps): TurnEngine {
  return {
    async runTurn(input: AgentAskInput): Promise<AgentAskResult> {
      // THE HANDLE THIS TURN OWNS (392-12, CR-01). Every write below goes through the object this
      // one `open()` returned, so a second turn running concurrently on the same adapter cannot be
      // written to by this one and cannot write to this one — session identity is a parameter of
      // the write path rather than adapter state. The `try/finally` around the whole body is what
      // makes "closed on every exit path exactly once" a property of the shape: a refusal, a
      // completion and a throw between here and `finish` all pass through the same release.
      const handle = await deps.sessionLog.open(input.sessionId)
      try {
        return await runTurnThrough(deps, handle, input)
      } finally {
        await handle.close()
      }
    },
  }
}

/**
 * The turn itself, written entirely through ONE session's handle.
 *
 * Lifted out of the closure so the open/close pair above can be a plain `try/finally` — the release
 * is then structural rather than a line each return path has to remember, which is the same reason
 * stage 4 is unreachable from a refusal by control flow rather than by a check.
 */
async function runTurnThrough(
  deps: TurnEngineDeps,
  opened: ChatSessionHandle,
  input: AgentAskInput,
): Promise<AgentAskResult> {
  const sessionId = opened.header.sessionId
  // THE PER-SESSION SEAMS, RESOLVED HERE AND NOWHERE EARLIER (392 plan 13, CR-02). The header the
  // adapter just returned is the FIRST moment this session's id is known: `AgentAskInput.sessionId`
  // is optional, and a turn that names none is given one by the adapter rather than by its caller.
  // Resolving above the open would therefore have to guess, and every guess is the aliasing this
  // keying removes. Resolved ONCE per turn rather than per use, so `beginTurn`, `setConversation`
  // and `endTurn` cannot end up addressing two different containers within one turn.
  const state = deps.state?.(sessionId)
  const directiveHandlers = deps.directives?.(sessionId)
  const turnId = deps.mintTurnId()
  // Published BEFORE anything can fail, because the state this names is "a turn is in flight"
  // and that becomes true here. A surface interrupted between this line and the boundary below
  // has the id it needs to write the explicit `aborted` event.
  state?.beginTurn(turnId)

  // THROUGH THE HANDLE, NEVER THROUGH THE ADAPTER (392-12). There is no adapter-level write verb
  // left to reach for, which is what makes "this turn's events go to this turn's session" a
  // property of the type rather than of everybody remembering.
  const append = async (event: ChatSessionEvent): Promise<void> => {
    await opened.append(event)
  }
  // Carried onto EVERY result of this turn, refusal arms included: a person whose session is
  // damaged needs to hear about it on the turn that reopened it, and the refusal arms are the
  // ones a damaged log makes more likely rather than less (392-03's note to this plan).
  const refusedLineCount =
    opened.refusedLines.length === 0
      ? {}
      : { refusedLineCount: opened.refusedLines.length }

  const finish = async (
    status: ChatTurnStatus,
    // 399.1 D-05: `results` is REQUIRED on the contract and DEFAULTED here to the empty list,
    // because every arm that reaches this without one is an arm where nothing ran — a refusal, a
    // fail-closed turn, a turn answered in prose. Making each of them spell `results: []` would be
    // making them state the fact twice; making the field optional would have made 'nothing ran' and
    // 'this build does not report results' the same bytes, which is the ambiguity `receipts` was
    // required for in the first place.
    result: Omit<AgentAskResult, 'sessionId' | 'turnId' | 'status' | 'results'>
      & { results?: readonly ClauseResult[] },
  ): Promise<AgentAskResult> => {
    await append({ kind: 'turn_complete', turnId, at: deps.now(), status })
    // The fsync point (D-19). Per TURN, so the loss bound is exactly the in-flight turn —
    // the case the next-turn repair already knows how to handle.
    await opened.turnBoundary()
    state?.endTurn({ turnId, status, receipts: result.receipts, ...(result.answer === undefined ? {} : { answer: result.answer }) })
    return {
      sessionId,
      turnId,
      status,
      ...refusedLineCount,
      ...result,
      results: [...result.results ?? []],
    }
  }
  /**
   * The ONE way this engine refuses a turn (D-08 / D-10 / D-15).
   *
   * Every fail-closed arm goes through here, and that is what makes the `mark_unhandled` event
   * a property of refusing rather than a line somebody remembered to add at three call sites.
   * The event is what CHAT-03's FIELD rate is a projection over — the gated ceiling is computed
   * across the frozen corpus, but the ungated number a live deployment produces is only
   * observable if every refusal in every session left a row. A refusal that returned the right
   * message and logged nothing would be invisible to exactly the measurement D-15 asks for.
   *
   * A DIRECTIVE WITH NO HANDLER GOES THROUGH HERE TOO, and that is a deliberate reading rather
   * than a shortcut: `/model` in a build that binds nothing for it IS a clause this build
   * cannot carry out, so it belongs in the same count as any other. The two facts stay
   * distinguishable in the log through the REASON, which says `recognised but no handler`
   * rather than `no capability handles`, and plan 08 removes the arm entirely by binding them.
   */
  const refuse = async (clause: string, reason: string): Promise<AgentAskResult> => {
    await append({ kind: 'mark_unhandled', turnId, at: deps.now(), clause, reason })
    return finish('fail_closed', { receipts: [], unhandled: { clause, reason } })
  }

  // REPAIR, THEN REPLAY, THEN PRUNE (CHAT-05). `open()` has already run the replay-safety
  // repair — that is the adapter's contract, not this engine's option — so the events in hand
  // are the repaired ones and the replay below cannot see an unrepaired conversation. The
  // degrade pass then receives that replay and has nothing else to work on, which is what
  // makes the ordering a property of the code rather than a convention.
  const replay = replaySession(opened.events)
  // The ONE projection, applied once (392-06's mismatch, resolved in `chat-state.ts`): the
  // repaired replay becomes the conversation a surface and a prompt read. A bound degrade pass
  // publishes again over the top with the pruned form.
  state?.setConversation(replayToModelMessages(replay))

  // CONFIG DRIFT, BEFORE THE MESSAGE (D-04, CHAT-05). The re-read happens on EVERY turn, which
  // makes the session-start case the first turn's case rather than a second code path — one
  // fold, one diff, one place a `model_change` can be born. The events carry the id of the turn
  // they precede (the base type's own rule for session-scoped facts) and are appended ahead of
  // the user message, so a reader folding the log has the configuration in hand before it sees
  // what was asked under it.
  if (deps.config !== undefined) {
    const current: ChatConfigState = await deps.config(sessionId)
    const previous = foldChatConfigState(opened.header, opened.events)
    for (const event of diffChatConfig(previous, current, {
      turnId,
      at: deps.now(),
      source: 'config_reread',
    })) {
      await append(event)
    }
  }

  await append({ kind: 'user_message', turnId, at: deps.now(), text: input.message })
  await deps.compaction?.({ turnId, sessionId, replay, append })

  // ---- Stage 1: the deterministic resolver over the clause split.
  const clauses = deps.split(input.message)
  const mapped: ResolvedClause[] = []
  const directives: DirectiveEntry[] = []
  for (const clause of clauses) {
    const resolution = resolveClause(deps.table, clause.text)
    if (resolution.kind === 'unresolved') continue
    if (resolution.entry.kind === 'directive') {
      // Resolved, and NOT executable through the function layer: a directive names no
      // capability (D-04/D-21). It is collected rather than dropped, because a clause the
      // table understood and the engine silently ignored is the exact silent-drop shape D-08
      // and D-10 exist to make impossible.
      directives.push({
        clause,
        directive: resolution.entry.directive,
        ...(resolution.entry.argument === undefined
          ? {}
          : { argument: resolution.entry.argument }),
      })
      continue
    }
    mapped.push({
      clause,
      functionId: resolution.entry.functionId,
      args: resolution.entry.input,
    })
  }
  await append({
    kind: 'stage_outcome',
    turnId,
    at: deps.now(),
    stage: 'resolver',
    // Directives count as RESOLVED here, because they were: the table matched them. Whether
    // anything can carry them out is the next question, and answering it in this field would
    // make "stage 1 did not recognise this" and "this build cannot do it" the same bytes.
    outcome:
      mapped.length + directives.length === clauses.length ? 'resolved' : 'unresolved',
  })

  // ---- Retired verbs, answered by name before any model sees them (261003-cpv, 432 IN-05).
  //
  // A clause stage 1 left unresolved goes to the planner, and in a live session a model may plan
  // the op named in a retired `/pin fn:runs.start`. The retired spellings are refused here, through
  // the same `refuse()` every refusal takes, so the planner is never consulted and nothing runs.
  for (const clause of clauses) {
    if (mapped.some((resolved) => resolved.clause.index === clause.index)) continue
    if (directives.some((entry) => entry.clause.index === clause.index)) continue
    const retired = retiredChatVerbReason(clause.text)
    if (retired !== undefined) return refuse(clause.text, retired)
  }

  // ---- Directives, ASKED ABOUT here and carried out below the verdict (D-10, CR-04).
  //
  // A directive names no capability — it changes what this SESSION is, and that is why it does
  // not travel `invokeFunction` and why a model may never reach one (391 D-07: the mechanism
  // deciding what a model may do is the one mechanism it must not touch, even in the
  // tightening direction). A directive with no handler still refuses the whole turn by name,
  // through the same `refuse()` every other refusal takes, so a build that recognises `/model`
  // and cannot carry it out leaves a countable row rather than a silent no-op (D-08 / D-15).
  //
  // WHAT MOVED, AND WHY. This loop USED TO CARRY THE DIRECTIVES OUT here, above stage 2 —
  // which put a directive's effect and its row on the log of a turn that then
  // got refused, under a message reading "nothing in the request was carried out"
  // (392-VERIFICATION CR-04). D-10's pre-flight atomicity was applied only to `invokeFunction`
  // dispatches; it is now applied to every effect a turn can have. What stays here is the
  // BINDING question, which mutates nothing.
  for (const entry of directives) {
    const notBound = directiveBindingRefusal(directiveHandlers, entry)
    if (notBound !== undefined) return refuse(entry.clause.text, notBound)
  }

  // ---- The directive BATCH, VALIDATED BEFORE THE FIRST ONE IS APPLIED (392-14, E3/E3b).
  //
  // The binding loop above asks "can this build carry this out at all"; this one asks "will THIS
  // argument be accepted", and both are asked of every entry before any entry is carried out.
  // Without it the execution loop below applied directives one at a time and returned on the first
  // refusal — so a turn whose SECOND directive was refused kept the first one's effect and its row
  // on the log of a turn that then told the person nothing in the request was carried out
  // (392-VERIFICATION round 2; the shipped case was two `/pin`s, retired in 432-13). Moving the loop
  // below the verdict closed the single-directive case and left the BATCH open; a batch is atomic
  // or it is not, and D-10 has no reading under which the second half of a request may undo only
  // the second half.
  //
  // ASKING IS NOT APPLYING, which is what lets this sit above stage 2 beside the binding check:
  // `validate` mutates no session state by its port contract, so a turn refused here has had
  // nothing done to it. `runDirective`'s catch stays as the belt for a host that publishes no
  // validate — such a host is exactly as safe as it was, and no safer.
  //
  // ONE CONSEQUENCE, ACCEPTED: a turn refused here never reaches stage 2, so its log carries the
  // resolver `stage_outcome` row alone rather than three. Every event carries `turnId` and `at`,
  // and the refusal still leaves the same `mark_unhandled` row every other refusal does.
  if (directiveHandlers?.validate !== undefined) {
    for (const entry of directives) {
      try {
        await directiveHandlers.validate(entry.directive, entry.argument)
      } catch (error) {
        // The refusal's own message, for the reason `runDirective`'s catch takes it: the handler
        // knows what it can accept, and re-deriving that here would be a second answer to it.
        return refuse(entry.clause.text, error instanceof Error ? error.message : String(error))
      }
    }
  }

  // Everything the directives did not claim. Computed rather than reusing `clauses`, so a turn
  // that is ENTIRELY directives reaches stage 3 with nothing to reconcile and completes through
  // the same four stages as any other — one path, rather than a fast one and a careful one.
  const routable = clauses.filter(
    (clause) => !directives.some((entry) => entry.clause.index === clause.index),
  )

  // ---- Stage 2: the planner, consulted ONLY for what stage 1 could not answer.
  const unmapped = routable.filter(
    (clause) => !mapped.some((resolved) => resolved.clause.index === clause.index),
  )
  let planned: PlannerStageOutcome = NO_PLAN
  if (unmapped.length === 0) {
    // The tracer's path, and a permanent one: a fully canonical utterance is model-independent.
    await append({
      kind: 'stage_outcome',
      turnId,
      at: deps.now(),
      stage: 'planner',
      outcome: 'skipped',
    })
  } else if (deps.planner === undefined) {
    // Headless. Not a stub and not an error — a real host posture whose correct behaviour is
    // to refuse by name rather than to guess (D-08).
    await append({
      kind: 'stage_outcome',
      turnId,
      at: deps.now(),
      stage: 'planner',
      outcome: 'unresolved',
    })
  } else {
    planned = await deps.planner.plan({ utterance: input.message, clauses: unmapped, sessionId })
    await append({
      kind: 'stage_outcome',
      turnId,
      at: deps.now(),
      stage: 'planner',
      // The stage RESOLVED when the model produced something to reconcile — a plan, or an
      // answer. It did not when the model was unreachable or said nothing. Whether what it
      // produced survives reconciliation is the next stage's question, and answering it in
      // this field would make "the model proposed nothing" and "the reconciler refused the
      // proposal" the same bytes for every reader of the log.
      //
      // ONE TERM, NOT TWO: an `answer_only` call IS a tool call, so the disjunction this used to
      // spell (`|| planned.answer !== undefined`) named the same set twice through a projection
      // that no longer exists (392-14).
      outcome:
        planned.failure === undefined && planned.toolCalls.length > 0 ? 'resolved' : 'unresolved',
    })
  }

  // ---- Stage 3: deterministic reconciliation, BEFORE any side effect (D-10).
  const verdict = deps.reconcile({ clauses: routable, mapped, planned })
  await append({
    kind: 'stage_outcome',
    turnId,
    at: deps.now(),
    stage: 'reconcile',
    outcome: verdict.kind === 'execute' ? 'resolved' : 'unresolved',
  })
  if (verdict.kind === 'unhandled') {
    return refuse(verdict.clause.text, verdict.reason)
  }

  // ---- The directives' side effects, on the execute arm and NOWHERE ELSE (D-10, CR-04).
  //
  // Reachable only from here, by the same control-flow discrimination stage 4 uses: the verdict
  // is a discriminated union, the `unhandled` arm returned above, and this loop lives on the
  // other side of that return. There is no arrangement of these statements in which a model is
  // overridden on a turn that got refused. A handler that THROWS here — a `/model` this host cannot
  // resolve — still routes through `refuse()`, so a refusal at this depth stays as countable as any
  // other.
  //
  // AND THAT SENTENCE IS TRUE OF A BATCH ONLY BECAUSE OF THE PRE-FLIGHT ABOVE (392-14). Read
  // alone, this loop applies entries one at a time and returns on the first refusal — which is
  // precisely the arrangement it claims does not exist, one clause over. What removes it is that
  // every entry's `validate` has already been asked and none of them said no; the catch below is
  // the belt for a host that publishes no validate, and on such a host the batch claim holds only
  // for a single directive.
  //
  // TWO CONSEQUENCES, ACCEPTED. A same-turn `/model` now applies AFTER the verdict, so this
  // turn's planner call ran under the previous model; that is the fail-safe direction, and the
  // alternative is an effect preceding the verdict. And the verb-sourced `model_change` rows now
  // follow this turn's `stage_outcome` rows — every event carries
  // `turnId` and `at`, so no reader's ordering claim rests on which came first within a turn.
  const directiveLines: string[] = []
  for (const entry of directives) {
    const line = await runDirective(deps, directiveHandlers, entry, {
      turnId,
      sessionId,
      append,
      now: deps.now,
    })
    if (line.kind === 'refused') return refuse(entry.clause.text, line.reason)
    directiveLines.push(line.text)
  }

  /**
   * The PRE-DISPATCH write_test route (395-08, D-14/D-15 · CFGM-05).
   *
   * IT RUNS BEFORE THE AUTHORING DISPATCH AND NOT INSIDE IT, which is RESEARCH Pitfall 6's whole
   * point: the authoring loop's `AuthoringDraftUnconfiguredTargetError` is a BACKSTOP over what a
   * model emitted, and it fires after an LLM call and a compilation. This asks a different question,
   * about the REQUEST, and it asks it before anything is spent.
   *
   * 2026-09-30, 432-11 D-05/D-14: NO CONFIRM. The scaffold writes the configuration in its own
   * call, the receipt is shown where a surface exists, and control returns to the loop below, which
   * dispatches authoring in the same turn against the target that now exists.
   */
  async function routeWriteTest(
    engine: TurnEngineDeps,
    step: { readonly functionId: string; readonly args: unknown },
    caller: FunctionCaller,
    appendEvent: (event: ChatSessionEvent) => Promise<void>,
    turn: string,
  ): Promise<'proceed' | 'stop'> {
    const intent = (step.args as { intent?: unknown } | undefined)?.intent
    if (typeof intent !== 'string') return 'proceed'

    const route = resolveWriteTestRoute({
      intent,
      configuredTargetNames: await (engine.configuredTargets as () => Promise<readonly string[]>)(),
    })
    if (route.kind === 'configured' || route.kind === 'passthrough') return 'proceed'
    if (route.kind === 'refuse') {
      writeTestRefusal = WRITE_TEST_UNCONFIGURED_DETAIL
      return 'stop'
    }

    // OP CALLS OP (392 D-24), through the same binding every other dispatch crosses — so the
    // scaffold is audited and receipted exactly as a directly-asked-for one would be.
    //
    // 2026-09-30, 432-11 D-05/D-14: THE SCAFFOLD WRITES IN THIS CALL. There is no proposal to show
    // and no apply to ask about afterwards: the answer is what was written, and the route goes on
    // to author against it.
    let scaffolded: unknown
    try {
      scaffolded = (await engine.invoke(
        CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID, { domain: route.domain }, caller,
      )).payload
    } catch (error) {
      writeTestRefusal = refusalMessage(error)
      return 'stop'
    }
    const answer = scaffolded as {
      outcome?: string
      detail?: string
      summaryLine?: string
      files?: readonly string[]
      shownDiff?: string
      crossBoundary?: boolean
      crossBoundaryReasons?: readonly string[]
      blockedReason?: string
      validationIssues?: readonly string[]
      path?: string
    }
    if (answer.outcome !== 'applied' || answer.files === undefined || answer.files.length === 0) {
      // A refusal, a blocked change, a no-change or an interrupted write: none is a configuration to
      // author a test against. 2026-10-03 (quick 261003-cpv, WR-03): each answers its own reason;
      // the no-configuration sentence was the fallback for the blocked and no-change arms, which
      // carry no `detail`.
      writeTestRefusal = writeTestScaffoldStopDetail(answer)
      return 'stop'
    }

    await appendEvent({
      kind: 'clause_receipt',
      turnId: turn,
      at: engine.now(),
      clause: step.functionId,
      functionId: CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID,
      origin: caller.origin,
      status: 'executed',
      outcome: `applied: ${answer.files.join(', ')}`,
    })

    // THE RECEIPT, SHOWN WHERE A SURFACE EXISTS. The op's own summary, files and diff, never a
    // re-derivation. Best effort: the change is already on disk and nothing waits on this render,
    // so a surface that is absent or fails leaves the turn to continue.
    const present = engine.present
    if (present !== undefined) {
      try {
        await present(
          [
            ...crossBoundaryLines(answer),
            ...(answer.summaryLine === undefined ? [] : [answer.summaryLine]),
            ...answer.files,
            ...(answer.shownDiff === undefined ? [] : [answer.shownDiff]),
          ].filter((part) => part !== '').join('\n'),
        )
      } catch {
        // The display is a receipt, not a gate; its failure contributes nothing to the turn.
      }
    }
    return 'proceed'
  }

  // ---- Stage 4: sequential execution in utterance order, stopping on failure (D-11).
  //
  // THE LOOP IS UNREACHABLE FROM A REFUSAL BY CONSTRUCTION, which is D-10 expressed as control
  // flow rather than as a check: the verdict is a discriminated union, the `unhandled` arm
  // returns above, and the plan this loop walks exists only on the other arm. There is no
  // ordering of these statements in which a side effect happens before the verdict, because
  // there is no plan to walk until the verdict has produced one.
  const receipts: ClauseReceipt[] = []
  // 399.1 (D-05): what the ops RETURNED, the sibling channel `receipts` was never allowed to be.
  // Appended inside the loop, so its order is the execution order — which is the utterance order
  // this engine preserves everywhere else — and its length is the number of clauses that ran.
  const results: ClauseResult[] = []
  /**
   * Whether some clause of this turn FAILED — the one fact the D-11 stop gate and the aggregate
   * below both read.
   *
   * ITS PRODUCER IS THE RECEIPT VOCABULARY, NOT THE ENDING (399.1-09, D-12). It was set in the
   * dispatch catch, so the only failure it could see was a thrown one — and every arm of a typed
   * refusal RETURNS. That is the same derivation RC-1b got wrong one layer down, and it stayed
   * wrong here after the receipt itself was fixed: a `failed` receipt sat under a `completed`
   * aggregate, the gate never tripped, and `ask` exited 0. It is derived at the push site below
   * now, from `receipt.status`, so a thrown failure and a returned one are one word to this loop.
   */
  let failed = false
  // 398-13 (D-21): what the ops PRODUCED, on its way to the turn's `answer` field. The receipt
  // charter is untouched — see the charter note at the push site below.
  const answerLines: string[] = []
  // The sentence the route wants a refused turn to carry, set by `routeWriteTest` before it answers
  // `stop`. A field rather than a return value so the refusal below reads as the one `refuse()` call
  // it is, and so a route that stopped without a reason still gets D-15's default sentence.
  let writeTestRefusal: string | undefined

  for (const step of verdict.plan) {
    // The mint follows the stage that PROVED the binding, which the verdict states (Pitfall 1).
    // Re-deriving it by matching the action back against the mapper set would answer `human`
    // for any planner-produced call to an op the table also knows, and the receipt would then
    // record a model-originated call as a person's (391 D-06, T-392-23). 2026-10-01 (432-20/21,
    // D-12): no op withholds anything by origin any more; the origin is attribution.
    const caller = deps.mint.forStage(step.source)
    let receipt: ClauseReceipt
    if (failed) {
      // `not-run` is a fact, not an absence: a person reading the receipt must be able to tell
      // a clause nobody attempted from one that was attempted and failed (D-11). It is LOGGED
      // like every other receipt, because "the log is the triage report" (D-18) is false the
      // moment the log carries only the clauses that got as far as a call.
      receipt = {
        clause: step.clause.text,
        functionId: step.functionId,
        origin: caller.origin,
        status: 'not-run',
        outcome: 'an earlier clause failed, so this one was never attempted',
      }
    } else if (
      step.functionId === AUTHORING_DRAFT_WRITE_FUNCTION_ID
      && deps.configuredTargets !== undefined
      && (await routeWriteTest(deps, step, caller, append, turnId)) === 'stop'
    ) {
      // THE ROUTE REFUSED: the project has no configuration and the scaffold did not write one.
      // Nothing is authored, and the turn says why through the same `refuse()` every other refusal
      // takes, so no draft is written against a project that still has none. (2026-10-03: nothing
      // is offered or declined since 432-13.)
      return refuse(step.clause.text, writeTestRefusal ?? WRITE_TEST_UNCONFIGURED_DETAIL)
    } else {
      try {
        // The result arrives CLASSIFIED (399.1, D-01/D-03/D-05). It used to arrive as `unknown`,
        // read by one id-matching summariser, and the status below was the literal `'executed'` — so
        // the only fact this receipt could report about a returning op was that it had returned.
        // Every arm of a typed refusal returns, which is how a credential-blocked config mutation
        // came to render `executed` in green over a file that was never written (G-399-2).
        const answered = await deps.invoke(
          step.functionId,
          stampSessionFacts(step.functionId, step.args, sessionId),
          caller,
        )
        receipt = {
          clause: step.clause.text,
          functionId: step.functionId,
          origin: caller.origin,
          // THE OP'S OWN VERDICT, not a derivation from how the call ended. Fail-closed upstream:
          // a fold that could not read its result answered `failed`, never `executed`.
          status: answered.verdict.status,
          // An empty outcome means the op's fold had nothing to add, and the line this engine has
          // always printed is the honest answer for it — the same line an op with no fold gets.
          outcome: answered.verdict.outcome === ''
            ? summarise(step.functionId)
            : answered.verdict.outcome,
        }
        // WHAT THE OP PRODUCED, ON THE CHANNEL D-05 GAVE IT. One entry per clause that ran, in
        // execution order, carrying the payload EXACTLY as the function layer returned it —
        // masked. Nothing restores a value here: this value reaches the session log and every
        // `agent.ask` client, and each surface's emit masks with the declared secrets.
        //
        results.push({ functionId: step.functionId, payload: answered.payload })
        // AND INTO THE RECORD, MASKED (399.1-05, D-05's persistence discretion resolved).
        //
        // WHY IT PERSISTS AT ALL. `results[]` is the turn's answer to "what did the ops actually
        // return", and 399's UAT rejected a chat surface that could not answer it. A session log
        // that carried only the receipt map would reproduce the same hole one layer down, in the
        // file D-18 calls the triage report — so the territory rides here beside its map.
        //
        // WHY VERBATIM AND NOT A DIGEST. A hash satisfies the disclosure guard trivially and gives
        // a reader nothing; the result is the turn's own territory and it is kept as filed.
        //
        // AND WHY NOTHING UNMASKS ON THE WAY. This is a DURABLE path. `answered.payload` is the
        // function layer's masked value and it is written exactly as it rode `results[]` — each
        // surface's emit masks with the declared secrets, and nothing restores a value into a
        // file. An unmasked entry here would mint a SECOND cleartext sink in
        // `.agent-qa/sessions/chat-*.jsonl`, which is the class
        // `.planning/phases/399.1-chat-render-contract/399.1-ADJUDICATION-transcript-cleartext.md`
        // adjudicates — inherited from 392 for two other fields, and a 399.1 DEFECT if this render
        // phase added a third.
        //
        // `?? null` IS THE JSON BOUNDARY, not a normalisation of the value: the adapter writes
        // JSONL, an `undefined` member serialises to an ABSENT KEY, and an absent key fails
        // `guardChatSessionEvent`'s exact-key check on reopen — so an op that returns nothing would
        // otherwise write a line this build cannot read back.
        await append({
          kind: 'clause_result',
          turnId,
          at: deps.now(),
          functionId: step.functionId,
          payload: answered.payload ?? null,
        })
        // THE RECEIPT CHARTER, WHICH SURVIVED THE MIGRATION THAT DELETED ITS OLD HOME (398-13 D-21,
        // moved here by 399.1-03). `explainAnswerLines` argued this seat at length and the argument
        // is unchanged by the fold arriving: THE RECEIPT STAYS THE MAP — the plain `<op> completed`
        // line, or the op's own one-line verdict — and the TERRITORY travels on this field, which
        // `renderTurn` already prints and `ask` already shares. A second carrier on the receipt
        // would put the answer inside the map, which is the prohibition `summarise` argues for.
        //
        // WHAT CHANGED IS ONLY WHO COMPOSES THE LINES. They used to be composed here, by comparing
        // `step.functionId` against one op's id and parsing that op's output — a render rule living
        // in the engine, which could only ever render what somebody had thought to name here. They
        // are composed now by the op's OWN declared `renderResult`, run at the composition root by
        // `foldFunctionResult`, and this site cannot tell which op produced them. That is the whole
        // of D-04's promote decision: this engine holds ZERO per-op render branches.
        //
        // PARSED, NEVER CAST, AND FAIL-OPEN, unchanged: a fold that throws or answers a non-list
        // renders NOTHING extra rather than anything invented, and the complete masked payload
        // reaches the person through `results[]` either way.
        answerLines.push(...answered.foldLines)
      } catch (error) {
        receipt = {
          clause: step.clause.text,
          functionId: step.functionId,
          origin: caller.origin,
          status: 'failed',
          outcome: refusalName(error),
        }
      }
    }
    // THE ONE DERIVATION (399.1-09, D-12). Every receipt this loop mints passes here — the
    // catch's, the fold's, and the `not-run` the gate itself writes — so the flag reads the
    // vocabulary rather than the control flow, and the gate above and the aggregate below become
    // honest without either of them changing a line.
    //
    // ONLY `failed` MOVES IT. D-11's rule is stop-on-FAILURE and D-02 ruled a refusal is not one:
    // `clauseReachedCapability` already counts `refused` as an op that reached its capability and
    // came back, so stopping there would abandon the rest of a person's sentence over a control
    // that worked. `executed` and `not-run` are the other two words that must leave it alone.
    if (receipt.status === 'failed') failed = true
    receipts.push(receipt)
    await append({
      kind: 'clause_receipt',
      turnId,
      at: deps.now(),
      clause: receipt.clause,
      functionId: receipt.functionId,
      origin: receipt.origin,
      status: receipt.status,
      outcome: receipt.outcome,
    })
  }

  // The answer rides the completed turn (CHAT-01). A turn the model answered in prose reaches
  // here with an empty plan, so the loop above ran zero times and `receipts` is empty — which
  // is the assertion "answering executes nothing" is made of, rather than a claim about it.
  // The directive lines lead, because they are what the person asked for FIRST in the
  // utterance order this whole engine preserves, and because a `/model` confirmation printed
  // after the receipts of the clauses that ran under the old model would misreport which model
  // ran them.
  // 398-13 (D-21): directives lead (the existing law), then what the OPS produced, then the
  // planner's prose. An explain answer that reached nobody was XPLN-02's last unwired inch.
  const answer = [...directiveLines, ...answerLines, verdict.answer].filter(
    (line): line is string => line !== undefined && line !== '',
  )
  return finish(failed ? 'failed' : 'completed', {
    receipts,
    results,
    ...(answer.length === 0 ? {} : { answer: answer.join('\n') }),
  })
}

/** The clause shape re-exported for composition roots that build a splitter. */
export type { ChatClause }
