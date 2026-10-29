// `authoring.funnel.get` — the honesty funnel as a catalogued capability.
//
// ONE READ OP, AND ITS CALLERS RENDER ITS ANSWER (388 D-14's one-read-op law). What consumes it
// TODAY is a function caller — the chat/MCP tool surface, and the CLI's generic `fn` dispatch,
// which reaches the registered op rather than a render of its own. There is no CLI
// funnel command and no per-run-digest funnel section; when one is written it is a client of this
// projection, so "how many drafts did this session keep, and did the loop actually filter any of
// them" has ONE answer by construction rather than by renderers agreeing. The op derives nothing:
// `computeAuthoringFunnel` in `schema` owns every number, including the acceptance-failure flag,
// and this file is the envelope.
//
// THE OP RE-SORTS AND RE-DERIVES NOTHING. `quarantine.list`'s house rule, inherited verbatim:
// ordering is the port's law and a second sort here would be a second declaration of it, free to
// agree today and disagree after the first tie-break change. The same argument applies with more
// force to the numbers — a second keep-rate computation would be a second answer to the question
// this whole capability exists to keep honest.
//
// THE INPUT CARRIES A WINDOW, AND THAT IS A DELIBERATE DIVERGENCE FROM `quarantine.list`. That
// file's input carries no filter because "a filter here would make the verb's answer depend on
// how it was asked", and the caller who most needs the full picture is the one who would have to
// know to ask for it. D-12's `window` is not that: it is a SCOPE — which invocations the
// projection is over, i.e. the denominator — rather than a predicate over rows already in hand.
// Without it, "how is THIS session doing" is unanswerable from any surface, which is the exact
// question WTST-05 asks. The divergence is recorded here and in the input schema's own doc block
// so it reads as a decision on the record rather than as an erosion of the rule.
//
// IT EXPOSES PER-SESSION AUTHORING HISTORY TO ANY CALLER. How many drafts a user
// produced and how many were kept is a fact about that person's work, and any caller can ask for
// it. That is stated HERE, in the header, so a reviewer can object now rather than discover the
// exposure later. The disposition is ACCEPT, and the argument is: the funnel reads a gitignored
// local store of the caller's own project, the same callers already reach run history and the
// quarantine ledger, and hiding it would make "how is this session doing" unanswerable from the
// surfaces that ask it — which is precisely where 394 D-12 puts it. 2026-10-01 (432-23, 432
// D-12): it was once declared behind the `read` scope; no scope is declared or checked now, and
// every door can call every operation.

import {
  AuthoringFunnelGetInputSchema,
  AuthoringFunnelGetOutputSchema,
} from '@vostride/agent-qa-schema'
import type { AuthoringFunnelGetInput, AuthoringFunnelGetOutput } from '@vostride/agent-qa-schema'

import { projectAuthoringFunnel } from '../../authoring/funnel.js'
import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'

/**
 * Lowercase dot taxonomy, three segments: the shipped `authoring` domain, `funnel` as
 * the subject and `get` as the verb — the `authoring.draft.verify` / `authoring.draft.write`
 * precedent, which is itself the `knowledge.records.inspect` one.
 *
 * NO UNDERSCORE, and that is a constraint rather than a style: `parity-coverage.test.ts` requires
 * every id to match the dot taxonomy, and `chat/tool-names.ts` REFUSES an id already carrying `_`
 * because such a name has two pre-images under the `.` ↔ `_` inverse. Since 392 D-07 binds every
 * registry op into the planner's toolset, an underscore id would raise `ChatToolNameError` for
 * the whole projection rather than merely looking unconventional.
 *
 * `funnel` and not `drafts` because the subject is the MEASUREMENT, not the drafts: a second verb
 * about drafts would file under `authoring.draft.` beside its two siblings, and filing this one
 * there would have made "get the drafts" and "get the funnel over the drafts" indistinguishable at
 * exactly the point a reader is choosing between them.
 *
 * The literal appears here once; the parity-coverage suite picks the id up off the registry.
 */
export const AUTHORING_FUNNEL_GET_FUNCTION_ID = 'authoring.funnel.get'

export const authoringFunnelGetSpec: FunctionSpec<
  AuthoringFunnelGetInput,
  AuthoringFunnelGetOutput
> = {
  id: AUTHORING_FUNNEL_GET_FUNCTION_ID,
  summary:
    'Report the authoring funnel for a window — built, passed stably, added value, write-eligible — '
    + 'and flag a keep rate above the ceiling as the loop failing to filter.',
  resultKind: 'unary',
  // Bound exactly where a composition supplies the receipts store (the proposals inbox left in 432-17).
  // An unbound host answering an all-zero funnel would say "this session authored nothing" about
  // a store it has never been able to read — and worse, it would say the loop filtered
  // everything, which is the one reading of a zero funnel that flatters the loop. So it refuses
  // by name instead.
  boundThrough: 'authoringFunnel',
  input: AuthoringFunnelGetInputSchema,
  output: AuthoringFunnelGetOutputSchema,
  risk: { name: `fn:${AUTHORING_FUNNEL_GET_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * The funnel's OWN one line, not a second one composed here.
   *
   * `line` is the single rendered sentence every surface prints, and it is screened against the
   * forbidden phrasings before the contract will carry it. Composing a receipt line out of the
   * counters instead would be a second funnel rendering — unscreened, and free to call a high keep
   * rate an achievement, which is the exact misreading D-13 exists to prevent.
   */
  classify(output): ClauseVerdict {
    return { status: 'executed', outcome: output.line }
  },
  async invoke(input, deps: FunctionDeps) {
    const authoringFunnel = deps.authoringFunnel
    if (authoringFunnel === undefined) {
      throw new FunctionNotBoundError(AUTHORING_FUNNEL_GET_FUNCTION_ID)
    }

    // An EMPTY funnel is a result, not an absence — a project that has authored nothing is the
    // starting state, and the computation reports it as an ABSENT keep rate rather than 0%.
    return await projectAuthoringFunnel(input.window, authoringFunnel)
  },
}
