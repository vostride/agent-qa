// Per-clause turn receipts.
//
// A turn reports what happened to EACH clause, not a single verdict, because D-11's execution rule
// is sequential-and-stop-on-failure: a compound turn can legitimately end with one clause executed,
// one failed and two never attempted, and a scalar answer cannot say that. The three statuses are
// exactly those three facts.
//
// `not-run` is the member that earns the vocabulary. Without it a clause the engine deliberately
// never attempted is indistinguishable from one that failed, and a person reading the receipt would
// go looking for a failure that never happened.

/**
 * What became of one clause. Closed, spelled once (388 C13).
 *
 * A DENIED confirm folds to `failed` rather than acquiring a fourth member (RESEARCH Pitfall 6):
 * the refusal name travels in `outcome`, so the fact is not lost, and a status a surface has to
 * special-case is a status every surface has to special-case.
 *
 * `refused` IS THAT FOURTH MEMBER, AND THE RULING ABOVE STANDS.
 * The 388 C13 ruling is about a PERSON declining a confirm, and a person who says no has not been
 * refused by anything: the turn asked, the answer was no, and folding that to `failed` costs a
 * reader nothing they cannot recover from `outcome`. This member is about the OTHER subject — a
 * GUARDRAIL declining an op. There the control WORKED and nothing failed, and both of the existing
 * members are actively wrong about it: `executed` asserts the change happened (measured G-399-2: a
 * credential-blocked config mutation rendered `executed` in green while the file was byte-unchanged,
 * and the reader's plausible next action was to paste the secret in by hand), while `failed` sends
 * them hunting a defect that does not exist. The specific reason — `schema-fail`, `refs-only`,
 * `duplicate-of:…` — still travels in `outcome` and in the rendered payload; what this member adds
 * is the one bit a surface must not get wrong, which is whether the thing was carried out.
 *
 * THE COST IS PAID DELIBERATELY, not overlooked: a status every surface has to special-case is
 * exactly what this is, and 399.1 pays it at every consumer in-phase (the receipt colour map becomes
 * exhaustive with a never-check, so a FIFTH member is a compile error rather than a silent `pc.dim`).
 * Widening the set is read-compatible for existing session logs — a status only ever appears in
 * entries written after it existed.
 */
export const CLAUSE_RECEIPT_STATUSES = ['executed', 'failed', 'not-run', 'refused'] as const

export type ClauseReceiptStatus = (typeof CLAUSE_RECEIPT_STATUSES)[number]

/**
 * One clause's receipt.
 *
 * `outcome` is a ONE-LINE summary and never a payload body: for a failure it carries the
 * function layer's own refusal NAME (`UnknownFunctionError`, `FunctionInputError`, …), which is
 * the vocabulary `invokeFunction` already publishes, so a surface reporting a refused clause names
 * the same thing the audit row does.
 */
export interface ClauseReceipt {
  clause: string
  functionId: string
  origin: string
  status: ClauseReceiptStatus
  outcome: string
}

/**
 * Whether this status means the clause REACHED ITS CAPABILITY and came back.
 *
 * IT EXISTS BECAUSE THE FOURTH MEMBER PUT A HOLE IN EVERY ROLL-CALL SPELLED OVER `executed`. D-10's
 * atomicity claim — a fail-closed turn carried NOTHING out — was checked by both scenario runners as
 * "no receipt says `executed`", which was a complete statement of it for exactly as long as
 * `executed` was the only word for a clause that ran and returned. It is not any more: an op that
 * reached its capability and declined says `refused`, and some of them leave a durable trace on the
 * way (a blocked config proposal is FILED — that arm carries its `proposalId` precisely so a person
 * can find it). A roll-call that could not see that row would report "nothing ran" over a turn that
 * ran something and wrote a record.
 *
 * `failed` AND `not-run` ARE DELIBERATELY OUTSIDE IT, and they are outside for different reasons.
 * `not-run` is a clause the engine never attempted — the one member that is unambiguously nothing
 * happening. `failed` is the ambiguous one: it covers a clause the gate refused before dispatch AND
 * one that threw mid-flight, and the vocabulary cannot tell those apart, so a predicate that claimed
 * either answer for it would be inventing a fact. What this function answers is the question it can
 * answer: these two words mean the op RAN and RETURNED.
 *
 * SPELLED ONCE, BESIDE THE SET IT READS. Two runners in two packages ask this question, and a copy
 * in each is how one of them keeps a hole after somebody fixes the other.
 */
export function clauseReachedCapability(status: ClauseReceiptStatus): boolean {
  return status === 'executed' || status === 'refused'
}
