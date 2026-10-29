// Walks the clauses, not either proposal, so every clause leaves bound, answered or refused.

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

// It names the clause, so a person can tell which half of a compound request was refused.
export function unhandledReason(clause: string): string {
  return (
    `No capability in this build handles: "${clause}". The turn was refused before anything ran, `
    + 'so nothing in the request was carried out.'
  )
}

// Model prose appears only quoted through `JSON.stringify`, after the host's own claims are made.
export function modelUnhandledReason(clause: string, reason: string): string {
  return (
    `No capability in this build handles: "${clause}". The turn was refused before anything ran, `
    + 'so nothing in the request was carried out.\n'
    + `The planner's stated reason, unverified by this build: ${JSON.stringify(reason)}`
  )
}

// An action call carries no clause, so a count mismatch is stated as a disagreement, not a cause.
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

// The named clause text only chooses which clause is refused; it is never the refusal's subject.
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

// A claim covers one occurrence of the clause it names, only with non-blank prose; no fallback.
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

// Counts are compared before anything binds, so a mismatch refuses by name instead of shifting.
export const deterministicOverrideStrategy: ReconcileStrategy = (
  input: ReconcileInput,
): ReconcileVerdict => {
  const mappedByIndex = new Map(input.mapped.map((resolved) => [resolved.clause.index, resolved]))

  // The model's refusal is checked before the plan is assembled, so the turn is refused whole.
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

  // Pass 1: each clause is mapped, answered or needs a proposal, asked in that order.
  const dispositions: ClauseDisposition[] = []
  const needy: ChatClause[] = []
  for (const clause of input.clauses) {
    const resolved = mappedByIndex.get(clause.index)
    if (resolved !== undefined) {
      dispositions.push({ kind: 'mapped', clause, resolved })
      continue
    }
    // Answered means a non-empty claim naming this clause, not an answer about the turn.
    const answered = takeClaimFor(clause.text)
    if (answered !== undefined) {
      dispositions.push({ kind: 'answered', clause, text: answered })
      continue
    }
    dispositions.push({ kind: 'needs', clause })
    needy.push(clause)
  }

  // The one site deciding count disagreements; a deficit names where the supply runs out.
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
  // Prose comes only from consumed claims, in utterance order, so answers match covered clauses.
  return answers.length === 0
    ? { kind: 'execute', plan }
    : { kind: 'execute', plan, answer: answers.join('\n') }
}

