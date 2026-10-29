// The receipt line both chat surfaces render (Phase 394 plan 36, SC-5's reporting half).
//
// ONE RENDER, TWO SURFACES. `chat.ts` and `ask.ts` each carried a private copy of this function,
// byte-identical by intention (D-01: the one-shot and the REPL are the same turn, so a person's
// scripted run and their conversation must not disagree about what happened) and free to drift by
// construction. They import this module now, and `chat-command.test.ts`'s source pin fails if
// either surface re-grows a local `receiptLine` — the sharing is structural rather than promised.
//
// WHY THE OUTCOME IS RENDERED, AND WHY UNCONDITIONALLY (WINDOWS 124, owner-ratified 2026-08-13:
// the RENDERED LINE governs, not the persisted artifact). `Runs consumed: N (previewed up to M)` is
// composed into `ClauseReceipt.outcome` at `turn-engine.ts:176` and reaches the persisted clause
// receipt verbatim — and no surface ever printed it. A person who approved "up to 7 runs" was shown
// the worst case and never told it cost 1, which is the half of WTST-08's disclosure that makes the
// other half checkable. The field is rendered for EVERY receipt with no "only when it differs from
// the plain summary" branch, because a conditional render is a drop path with a condition on it,
// and a drop path is the defect this module closes.
//
// STILL NEVER A PAYLOAD. `outcome` is a one-line summary by its schema's own contract — for
// a failure the function layer's refusal NAME, for a fan-out the report's own sentence — so what
// this adds to the line is the same class of fact the line already carried, not a result body.
//
// NO PRINT SITE LIVES HERE. This returns a string; each surface's emit masks it with the declared
// secrets (`ask`'s `emitHuman`, chat's own masked write). A render that printed for itself would
// print outside that mask.

import type { ClauseReceipt, ClauseReceiptStatus } from '@vostride/agent-qa-schema'
import pc from 'picocolors'

/**
 * One receipt line: what ran, how it went, the op's own name — and what it cost.
 *
 * The outcome rides a second indented line rather than the tail of the first, because the sentence
 * it carries is a full clause on the ops that have something to report and would push the clause a
 * person typed off the edge of a terminal on the ones that do not.
 */
export function receiptLine(receipt: ClauseReceipt): string {
  return `  ${STATUS_STYLE[receipt.status](receipt.status)}  ${pc.bold(receipt.functionId)}`
    + `  ${pc.dim(receipt.clause)}\n    ${pc.dim(receipt.outcome)}`
}

/**
 * How each status reads on a terminal — TOTAL over the vocabulary, and that totality is the guard.
 *
 * IT WAS A TERNARY CHAIN UNTIL 399.1 (D-02, RESEARCH Pitfall 3), whose final `else` styled anything
 * it did not recognise as `pc.dim` — the `not-run` styling. `refused` would have landed there
 * silently: a security control's refusal wearing the "never attempted" affordance, on a build that
 * had just been changed specifically so a person could tell the difference. A record with no default
 * arm makes a FIFTH member a compile error at this line instead, which is the only version of this
 * guard that does not depend on somebody remembering to come here.
 *
 * THE FOUR STYLES ARE FOUR DIFFERENT FACTS, not a palette. `executed` is green because the thing was
 * carried out. `failed` is red because something went wrong and a person should look. `refused` is
 * yellow — a deliberate third colour, because a guardrail declining an op is neither of those: the
 * control worked, nothing is broken, and nothing happened. `not-run` is dim because the clause was
 * never attempted and is the one line here that is not about an act at all.
 */
const STATUS_STYLE = {
  executed: pc.green,
  failed: pc.red,
  refused: pc.yellow,
  'not-run': pc.dim,
} as const satisfies Record<ClauseReceiptStatus, (text: string) => string>

// the denial-detail renderer and its remedy text table are deleted. They
// rendered the execution gate's typed remedies under a denial; the gate and its remedy vocabulary
// are gone, and the one remaining run refusal (production without the config opt-in) is a plain
// sentence the door prints as it is.
