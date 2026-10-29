// The session facts this surface owns, as a value two modules read (Phase 394, gap round 3, G-1).
//
// A LEAF MODULE rather than a direct planner-tools → turn-engine import. The stamp writes these
// fields at the invoke; the model-facing projection must withhold the same ones before the model
// decides. Both sides reading ONE value is the two-sided contract pin; keeping that value here
// keeps the chat subtree's import graph acyclic by construction rather than by luck.

import { AUTHORING_DRAFT_WRITE_FUNCTION_ID } from '../functions/ops/authoring-draft-write.js'
import { AUTHORING_DRAFT_VERIFY_FUNCTION_ID } from '../functions/ops/authoring-verify-draft.js'
import { AUTHORING_FUNNEL_GET_FUNCTION_ID } from '../functions/ops/authoring-funnel-get.js'

/**
 * The ops whose `sessionRef` this surface OWNS.
 *
 * A SET RATHER THAN AN ID, and that is CR-02's adjudicated fix rather than a generalisation for
 * its own sake. `authoring.draft.verify` carries the same field, spreads it onto the receipt it
 * persists, and is planner-reachable like every registered op — so a guard naming only the write
 * op left the identical forgery open one function id over. Membership makes the guarded vocabulary
 * a value `session-stamp-vocabulary.test.ts` can compare SET-EQUAL against the registry ops that
 * actually carry the field, so a future sibling gaining it reds a cell by the omitted name instead
 * of shipping unguarded. Dropping the field from the verify schema is NOT the alternative fix:
 * `shelf.verifyDraft` needs it to thread the loop's own ref.
 */
export const SESSION_STAMPED_FUNCTION_IDS: ReadonlySet<string> = new Set([
  AUTHORING_DRAFT_WRITE_FUNCTION_ID,
  AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
])

/** The ops whose `window` this surface may scope to the session it knows. */
export const WINDOW_STAMPED_FUNCTION_IDS: ReadonlySet<string> = new Set([
  AUTHORING_FUNNEL_GET_FUNCTION_ID,
])

/**
 * The ops whose `scope` the COMPOSITION derives when the caller supplies none.
 *
 * NOT A STAMP, and the difference is why it is a third set rather than a member of either above.
 * Nothing is written at the invoke here: `authoring.draft.write` declares `scope` OPTIONAL at the
 * registry — the `runs.start` law — and the host resolves it inside the op when it is absent, so a
 * supplied scope reaches the loop untouched and the deriver is never consulted. What membership
 * buys is the model-facing half: an id here gets the one sentence saying who fills the field, and
 * `planner-tools.test.ts` pins the description-bearing ids SET-EQUAL to this set unioned with the
 * window-stamped one. A field the model may omit but is never told it may omit is a field it
 * invents a value for, or refuses the call over — which is the defect this set exists to close.
 *
 * It lives HERE beside the two stamp sets because it answers the same question they do — which
 * fields is the model NOT the source of — and the projection reads all three from one leaf module
 * rather than acquiring a second import graph for the third law.
 */
export const HOST_DERIVED_SCOPE_FUNCTION_IDS: ReadonlySet<string> = new Set([
  AUTHORING_DRAFT_WRITE_FUNCTION_ID,
])
