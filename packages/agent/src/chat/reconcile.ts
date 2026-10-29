// Stage 3 — deterministic reconciliation.
//
// THE FILE IS A TOTAL FUNCTION FROM TWO PROPOSALS TO ONE VERDICT, and every clause of the utterance
// leaves it accounted for: bound by the table, bound by the model, answered in prose, or naming the
// refusal that costs the whole turn. There is no fifth outcome and no path on which a clause simply
// stops being mentioned — a silently dropped clause is T-392-25, and the only structural defence
// against it is a merge that walks the CLAUSES rather than either proposal.
//
// D-12, PRECISELY. Wherever the table resolved a clause, the mapper's `{ functionId, args }` is the
// verdict — the model's call for that same clause is discarded whole, target and arguments alike
// ("run test 42" with the model planning TST-999 executes TST-42). That is two claims and they fail
// independently, so the suite asserts them apart: the ACTION SET (how many, and which) and the
// BOUND ARGUMENTS. A reconciler that honoured the first and not the second would run the right op
// against the wrong entity, which is the more dangerous half.
//
// D-09'S PRECISION CLAUSE IS WHAT LIMITS THE OVERRIDE. Only EXACT table resolutions participate:
// `mapped` carries what stage 1 proved at confidence 1.0, and nothing else may ever be added to it,
// because an overriding path that false-positived would beat a correct model plan with a wrong
// guess. Everything fuzzy stays on the model's side of the merge, where it is one proposal among
// others rather than a verdict.
//
// WHAT IS ALREADY FINAL HERE IS THE ATOMICITY. Reconciliation returns before any side effect
// exists, so an unhandled clause costs the turn everything and executes nothing. That is not an
// optimisation of the failure path; it is the property `compound/` scenarios assert as
// `executed == 0`, and a strategy that let earlier clauses run before discovering a later
// unroutable one would make that assertion unwritable.
//
// THE STRATEGY IS PURE: a verdict in, a verdict out, no clock, no filesystem, no model. That purity
// is what makes D-16's mutation proof meaningful — the differential composes the REAL host twice
// with two strategies and reads the difference off a named scenario, and it can only do that
// because swapping this function changes nothing else about the assembled system.

import type {
  ChatClause,
  ClauseAction,
  PlannerToolCall,
  ReconcileInput,
  ReconcileStrategy,
  ReconcileVerdict,
  ResolvedClause,
} from './ports.js'
import {
  ANSWER_ONLY_TOOL_NAME,
  MARK_UNHANDLED_TOOL_NAME,
  fromToolName,
  isChatMetaToolName,
} from './tool-names.js'

/**
 * The refusal sentence a fail-closed turn carries.
 *
 * It NAMES the clause. A message that said only "I could not do that" would leave a person
 * unable to tell which half of a compound request was refused, and would make a silent drop and a
 * loud refusal read identically in the log.
 */
export function unhandledReason(clause: string): string {
  return (
    `No capability in this build handles: "${clause}". The turn was refused before anything ran, `
    + 'so nothing in the request was carried out.'
  )
}

/**
 * The refusal sentence a turn carries when the MODEL said the clause cannot be done.
 *
 * D-08's clause-naming law holds, and this adds the ATTRIBUTION law beside it: model prose reaches
 * the person only as the planner's quoted claim, never as a fact this host asserts.
 *
 * The reason is not a defensive one. `reason` is untrusted model output — `modelMarkedUnhandled`
 * reads it off a tool call exactly as it reads the clause — and until this round it was spliced
 * bare after an em-dash, immediately behind a clause the host composed. The two halves then read as
 * one host statement with nothing marking where the host stopped speaking. 394-30 measured what
 * that costs on a real turn: a live planner refused an authoring request with "it requires a target
 * scope identifier and none was supplied", a phrase in no source file in this repo, describing a
 * requirement the op's own contract denies (`required: ["intent"]`). The person was told a false
 * fact about this build, in this build's voice, and had no way to tell the host had not said it.
 *
 * The host can only assert what it can check. It cannot check the planner's prose; what it CAN
 * check is that the planner said it — so saying so is the whole of the claim it makes about it.
 * The tail is still shown in full rather than dropped, because the planner's stated reason is
 * often the only thing that tells a person what to try next.
 *
 * THE DELIMITERS MUST BE ONES THE PAYLOAD CANNOT SPELL, and the first version of
 * this fix used ones it could. `reason` was spliced between bare `"` characters — the single most
 * likely character for a planner's prose to contain — and followed by a fixed sentence the model
 * can read in its own tool description. A planner emitting
 * `X". The turn was refused before anything ran, so nothing in the request was carried out. This
 * build requires …` closed the attribution after `X` and left its own claim standing after the
 * host's atomicity sentence, in the host's voice: 394-30's defect, restored through the fix meant
 * to close it. `JSON.stringify` escapes the quote AND the newline a multi-line payload would use
 * to leave the quoted span, so there is no byte sequence the model can emit that ends the
 * quotation early — while the tail is still shown whole.
 *
 * AND THE HOST FINISHES SPEAKING BEFORE THE QUOTATION OPENS. The attribution moved to the END for
 * the same reason the escaping was needed: with the host's own two claims — which clause, and that
 * nothing ran — both made before any model byte appears, there is no host sentence AFTER the
 * quotation for a crafted payload to impersonate by running on into it.
 */
export function modelUnhandledReason(clause: string, reason: string): string {
  return (
    `No capability in this build handles: "${clause}". The turn was refused before anything ran, `
    + 'so nothing in the request was carried out.\n'
    + `The planner's stated reason, unverified by this build: ${JSON.stringify(reason)}`
  )
}

/**
 * The refusal sentence a turn carries when the model's plan cannot be attributed to its clauses.
 *
 * AN ACTION CALL CARRIES NO CLAUSE. The model emits `runs_start {…}`, not "runs_start, for the
 * second half of what you asked" — so when it makes more action calls than there are clauses
 * needing one, NOTHING in the output says which clause each call was about. Binding them by
 * position is a guess, and the guess is wrong exactly when the model made a call about a clause the
 * TABLE already resolved (392-VERIFICATION round 3, CR-01): the surplus call shifted every later
 * binding, so a clause that asked for a digest ran a test with the model's own arguments and its
 * real intent left no row at all, on a turn the person was told completed.
 *
 * So the sentence states the DISAGREEMENT rather than inventing a cause. It names a clause
 * and it says what could not be done with the plan, because "no capability handles this" would be
 * false here — a capability does handle it, and the reason nothing ran is that nobody can tell
 * which call was for it.
 */
export function unattributablePlanReason(
  clause: string,
  proposed: number,
  needed: number,
): string {
  return (
    `The plan proposed ${String(proposed)} actions for ${String(needed)} clauses that needed one, `
    + `so no call could be attributed to "${clause}". The turn was refused before anything ran, `
    + 'so nothing in the request was carried out.'
  )
}

/** The refusal sentence a turn carries when stage 2 could not reach the model at all. */
export function plannerFailedReason(clause: string, failure: { name: string }): string {
  return (
    `The planner could not be reached (${failure.name}), so "${clause}" was never routed. `
    + 'The turn was refused before anything ran.'
  )
}

/**
 * Read the model's own fail-closed signal off its plan.
 *
 * `mark_unhandled` is a tool call like any other, so this is a read of untrusted output: the clause
 * text it names is used to CHOOSE which clause the refusal is about, by matching what the splitter
 * produced, and never as the refusal's subject directly. A model that names a clause nobody typed
 * still refuses the turn — the first unmapped clause is the honest subject then — because a plan
 * containing this call is a plan whose author said it could not be completed.
 */
function modelMarkedUnhandled(
  input: ReconcileInput,
): { clause: string; reason: string } | undefined {
  for (const call of input.planned.toolCalls) {
    if (call.toolName !== MARK_UNHANDLED_TOOL_NAME) continue
    const body = (typeof call.input === 'object' && call.input !== null ? call.input : {}) as {
      clause?: unknown
      reason?: unknown
    }
    return {
      clause: typeof body.clause === 'string' ? body.clause : '',
      reason: typeof body.reason === 'string' ? body.reason : 'no capability for it has shipped.',
    }
  }
  return undefined
}

/** One `answer_only` call that survived the coverage predicate: the clause it names, and its prose. */
interface AnsweredClaim {
  readonly clause: string
  readonly text: string
}

/**
 * The model's `answer_only` calls that actually ANSWER something (CR-03, and 392-14's tightening).
 *
 * A CLAIM COVERS THE CLAUSE IT NAMES AND NO OTHER, matched against what the splitter produced —
 * which is the same read `modelMarkedUnhandled` performs on `mark_unhandled`, with one deliberate
 * difference: THERE IS NO FALLBACK HERE. `mark_unhandled`'s fallback to "the first unmapped clause"
 * is fail-SAFE, because a model whose claim matches nothing still refuses more than it otherwise
 * would. An answer-coverage fallback would be fail-DANGEROUS in exactly the mirror direction: it
 * completes more, and what it completes is a clause nobody bound and nobody answered. That
 * asymmetry is why a claim naming text no one typed covers nothing at all, and why a call with no
 * `clause` field — the shape this tool had before the field was required — covers nothing either.
 *
 * AND IT MUST ALSO SAY SOMETHING. Naming a clause was made necessary and left sufficient, so
 * `{clause: "delete the knowledge root", text: ""}` — schema-valid until this round, naming a
 * clause the person really typed — consumed that clause and returned a `completed` turn with no
 * receipt, no refusal and no mention of it anywhere in the result (392-VERIFICATION round 2, E1).
 * A claim is coverage only when it names a clause AND carries prose, and the predicate here is one
 * notch stricter than the schema's `min(1)`: whitespace-only prose fails, because a space is not
 * an answer and the fail-safe direction is to refuse.
 *
 * AN ORDERED MULTISET, NOT A SET. `mapped` is keyed by clause INDEX; a set of clause TEXT let one
 * claim speak for every occurrence of a repeated clause ("run test 42 and run test 42", answered
 * once, both covered). The list below is consumed one entry per clause during the merge walk, so a
 * claim covers exactly one occurrence and the two halves of the merge agree about what identifies
 * a clause.
 */
function answeredClauseClaims(input: ReconcileInput): AnsweredClaim[] {
  const claims: AnsweredClaim[] = []
  for (const call of input.planned.toolCalls) {
    if (call.toolName !== ANSWER_ONLY_TOOL_NAME) continue
    const body = (typeof call.input === 'object' && call.input !== null ? call.input : {}) as {
      clause?: unknown
      text?: unknown
    }
    if (typeof body.clause !== 'string' || body.clause === '') continue
    if (typeof body.text !== 'string' || body.text.trim() === '') continue
    claims.push({ clause: body.clause, text: body.text })
  }
  return claims
}

/**
 * The model's ACTION proposals, in the order it made them.
 *
 * The two orchestration calls are removed here and nowhere else. They are not proposals about what
 * to run — one answers the turn and the other refuses it — and {@link fromToolName} THROWS on both
 * by design, so a merge that reversed every call without checking would crash on precisely the two
 * calls that matter most. Filtering by the published predicate rather than by a local name test is
 * what keeps that check from being re-derived a third time.
 */
function actionCalls(input: ReconcileInput): readonly PlannerToolCall[] {
  return input.planned.toolCalls.filter((call) => !isChatMetaToolName(call.toolName))
}

/** What one clause turned out to be, decided once and read by everything below. */
type ClauseDisposition =
  | { readonly kind: 'mapped'; readonly clause: ChatClause; readonly resolved: ResolvedClause }
  | { readonly kind: 'answered'; readonly clause: ChatClause; readonly text: string }
  | { readonly kind: 'needs'; readonly clause: ChatClause }

/**
 * The deterministic override: what the table proved beats what anything else proposed.
 *
 * The mapped set is indexed by CLAUSE INDEX rather than by matching text, and that is the D-12
 * mechanism in miniature: the clause's position is its identity, so a planner entry for a clause
 * the table already resolved cannot displace the mapper's binding no matter how the model spelled
 * it.
 *
 * THE COUNTS MUST AGREE BEFORE ANYTHING BINDS. Every clause gets exactly one disposition —
 * mapped, answered, or needing a proposal — and the number of action calls the model made is
 * compared against the number of clauses in that third group. That comparison is the ONE place a
 * count disagreement is decided, and it happens between the passes, before a single binding exists:
 * a disagreement refuses the turn BY NAME rather than shifting the alignment by one, so the
 * materialize walk below has no refusal arm at all. The count and the set it is compared against
 * come from the same pass, because a second predicate computing "which clauses need a proposal"
 * would be free to drift from the one the binder walks.
 *
 * WHEN NO CLAUSE NEEDS A PROPOSAL nothing can be mis-bound — no call is popped by anybody — and
 * the calls are discarded whole. This is a CHOICE, not an absence of alternatives: through the
 * engine there is always a clause a refusal could name here, because stage 2 is skipped entirely
 * when every clause is mapped (`turn-engine.ts`), so a non-empty proposal list beside an empty
 * needy list means at least one clause was ANSWERED. Naming it is available and is not taken. The
 * asymmetry this file has always had is what decides it: the model may lose a proposal, and the
 * person may never lose a request. A clause that was answered did not lose its request — its prose
 * reaches the person — so the discarded call costs the model, not the person. Ratified 2026-08-10
 * against the alternative of refusing by name, which would move this case and cost every such turn
 * a refusal instead of an answer.
 */
export const deterministicOverrideStrategy: ReconcileStrategy = (
  input: ReconcileInput,
): ReconcileVerdict => {
  const mappedByIndex = new Map(input.mapped.map((resolved) => [resolved.clause.index, resolved]))

  // The model's own refusal is checked BEFORE the plan is assembled, because a turn one of whose
  // clauses cannot be done is refused whole — including the clauses the table did resolve.
  // Assembling first and discarding after would put a plan and a refusal in the same code path,
  // which is how a partially-executed compound turn eventually gets written.
  const marked = modelMarkedUnhandled(input)
  if (marked !== undefined) {
    const named =
      input.clauses.find((clause) => clause.text === marked.clause)
      ?? input.clauses.find((clause) => !mappedByIndex.has(clause.index))
      ?? input.clauses[0]
    if (named !== undefined) {
      return {
        kind: 'unhandled',
        clause: named,
        reason: modelUnhandledReason(named.text, marked.reason),
      }
    }
  }

  const proposed = actionCalls(input)
  // Consumed by `takeClaimFor` as the disposition pass goes: what is left at the end are the claims
  // that named nothing the person typed, and they cover nothing.
  const claims = answeredClauseClaims(input)

  /** Pop the FIRST unconsumed claim naming this clause text, or nothing. One claim, one clause. */
  const takeClaimFor = (text: string): string | undefined => {
    const index = claims.findIndex((claim) => claim.clause === text)
    if (index === -1) return undefined
    return claims.splice(index, 1)[0]?.text
  }

  // ---- PASS 1: DISPOSITION. Every clause becomes exactly one of three things, and no proposal is
  // spent and no refusal is issued here.
  //
  // THE ORDER OF THE THREE QUESTIONS IS THE MECHANISM: mapped → answered → needs a proposal.
  //
  // The coverage question used to sit BELOW the proposal consumption, and that one statement's
  // position produced two opposite user-visible defects from the same input shape (392-VERIFICATION
  // round 2). "What is a flake and summarise the last failure" with the plan the prompt itself asks
  // for — one `answer_only` for clause 1, one action call for clause 2 — bound the action to the
  // ANSWERED clause, so with two action calls a tool ran against a clause the model had marked
  // answer-only and every receipt named the wrong clause; and with one action call the second
  // clause found no proposal left and the WHOLE TURN was refused by name, naming the clause the
  // model had actually bound. Asking coverage first costs nothing and removes both.
  //
  // MAPPED STILL TAKES PRECEDENCE OVER A CLAIM, so a claim naming a clause the table bound is not
  // consumed and does not reduce the count below. A claim that could shrink the needy set for a
  // clause it was never going to answer would let the model turn an equality into a whole-discard
  // and silently unbook the clause it did plan for.
  const dispositions: ClauseDisposition[] = []
  const needy: ChatClause[] = []
  for (const clause of input.clauses) {
    const resolved = mappedByIndex.get(clause.index)
    if (resolved !== undefined) {
      dispositions.push({ kind: 'mapped', clause, resolved })
      continue
    }
    // An unresolved clause is answered by prose or it is not answered at all — and "answered" is a
    // claim about THIS clause, quoted and non-empty, rather than about the turn.
    // The line this replaced read `if (input.planned.answer !== undefined) continue`, which let one
    // model-emitted answer consume every clause the merge had no binding for: "run test 42 and
    // delete the knowledge root", answered once, completed with the second clause erased.
    const answered = takeClaimFor(clause.text)
    if (answered !== undefined) {
      dispositions.push({ kind: 'answered', clause, text: answered })
      continue
    }
    dispositions.push({ kind: 'needs', clause })
    needy.push(clause)
  }

  // ---- THE ACCOUNTING: the ONE site where a count disagreement is decided, between the passes and
  // before any binding exists. Both numbers come from the same pass above.
  //
  // DEFICIT — fewer calls than clauses needing one. Byte-for-byte what it always did: it names the
  // clause the supply exhausts at, with the sentence the posture chooses (an unreachable planner
  // says so; anything else says no capability handles it). A person may never lose a request.
  const exhaustedAt = proposed.length < needy.length ? needy[proposed.length] : undefined
  if (exhaustedAt !== undefined) {
    return input.planned.failure !== undefined
      ? {
          kind: 'unhandled',
          clause: exhaustedAt,
          reason: plannerFailedReason(exhaustedAt.text, input.planned.failure),
        }
      : { kind: 'unhandled', clause: exhaustedAt, reason: unhandledReason(exhaustedAt.text) }
  }
  // SURPLUS — more calls than clauses needing one, with at least one clause needing one. `needy[0]`
  // is undefined exactly when nothing needs a proposal, which is the whole-discard case: no call
  // can be popped by anybody, so nothing is mis-bound. A subject to refuse about does exist there
  // (an ANSWERED clause — see the header); discarding rather than refusing is the ratified choice,
  // not a consequence of having nobody to name.
  const unattributable = proposed.length > needy.length ? needy[0] : undefined
  if (unattributable !== undefined) {
    return {
      kind: 'unhandled',
      clause: unattributable,
      reason: unattributablePlanReason(unattributable.text, proposed.length, needy.length),
    }
  }

  // ---- PASS 2: MATERIALIZE. The counts agree by construction now — either they were equal or
  // nothing needs a proposal — so this contains NO refusal arm and cannot.
  //
  // The pairing is by position and it is spelled once: the i-th proposal belongs to the i-th clause
  // that needs one. A proposal past the end of `needy` has no clause to belong to and is discarded
  // here, which is the only place in this file a call is ever dropped.
  const plannerBound = new Map<number, ClauseAction>()
  proposed.forEach((proposal, position) => {
    const clause = needy[position]
    if (clause === undefined) return
    plannerBound.set(clause.index, {
      clause,
      // The id the function layer answers to. An id nothing registered is NOT checked here —
      // `invokeFunction` raises `UnknownFunctionError` naming it, from the one place that knows
      // what is registered, and a check here would be a second catalogue free to disagree.
      functionId: fromToolName(proposal.toolName),
      // Carried across UNVALIDATED and unshaped. What validates a tool call's arguments is the
      // op's own live schema inside `invokeFunction`; a shape enforced here would be a second
      // validator standing in front of the real one.
      args: proposal.input,
      source: 'planner',
    })
  })

  const plan: ClauseAction[] = dispositions.flatMap((disposition) =>
    disposition.kind === 'mapped'
      // The override, in one line: the table's binding, tagged with the stage that proved it so the
      // engine mints a human caller for it. Nothing the model proposed is consulted for this clause.
      ? [{ ...disposition.resolved, source: 'resolver' as const }]
      : disposition.kind === 'needs'
        ? (plannerBound.get(disposition.clause.index) ?? [])
        // An answered clause contributes prose rather than an action; it is accounted for below.
        : [],
  )
  const answers: string[] = dispositions.flatMap((disposition) =>
    disposition.kind === 'answered' ? [disposition.text] : [],
  )
  // Utterance order, preserved: order is meaning, and later clauses routinely depend on
  // earlier ones. Both walks above go over `dispositions`, which pass 1 built by walking `clauses`
  // rather than either resolution set, precisely so a planner that answered out of order cannot
  // reorder what runs.
  //
  // THE PROSE IS THE CONSUMED CLAIMS', AND ONLY THEIRS. It used to be `input.planned.answer` — the
  // FIRST `answer_only` call's text, projected by `readBackPlan` — while the prompt and the tool
  // description had already been moved to "ONE CALL PER CLAUSE you are answering". So a turn
  // answering two questions accounted for both clauses and handed the person one answer, with the
  // other silently dropped (392-VERIFICATION round 2, path (4)). Building it here from what the
  // merge actually consumed is what makes the accounting checkable: the answers a person reads are
  // exactly the claims that covered a clause, in the order they typed them. That producer-side
  // projection is now gone entirely, so there is one prose path rather than two that can disagree.
  return answers.length === 0
    ? { kind: 'execute', plan }
    : { kind: 'execute', plan, answer: answers.join('\n') }
}

// The tracer's whole-utterance splitter USED TO LIVE HERE and is gone as of plan 02, because the
// seam it was holding open is now filled: `chat/clause-split.ts` is the real conjunction grammar
// and the composition root binds it. Keeping the one-clause version around as a published symbol
// would leave two answers to "how is an utterance split" in the barrel, with only one of them
// bound — which is precisely the second-vocabulary failure this subtree is written to avoid. A
// differential that wants a null splitter can spell one inline; that is a test's need, not a
// production surface.
