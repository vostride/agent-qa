// `quarantine.add` — manual entry, renewal and the owner claim, in one verb.
//
// The counterpart that makes D-05's narrow auto-gate livable. Automatic quarantine is reserved
// for the A3-routed classes (flake, environment, timeout) precisely so a real regression is
// never auto-silenced; a persistent `app_bug` keeps failing the build. This verb is how a human
// deliberately quarantines a test anyway — a known-broken one, a flake the ladder has not
// caught up with — which is a different act from the machine deciding to, and it is a different
// act because a person put their name on it.
//
// RE-ADDING RENEWS; IT DOES NOT THROW, AND IT IS NOT A SECOND VERB. In an append-only event log
// entry and renewal are one gesture with different prior state: an identity with an open window
// gets a `renewed` event extending the deadline and claiming the owner when one was supplied,
// and the result says `renewed` so the caller LEARNS which happened. Splitting claim and renew
// into their own verbs would have forced every caller to read the ledger's current state before
// it could choose a verb — a read whose answer can change between the two calls.
//
// A DIRECT WRITE, NOT A PROPOSE+APPLY PAIR: see `quarantine-release.ts`. 391 may wrap both
// verbs in the proposal engine; this plan mints the direct form the engine would wrap.
//
// ---- NO SCOPE ------------------------------------------------------
//
// Both quarantine writes once declared `knowledge-write` rather than a new scope member, on the
// reasoning that quarantine writes differ from knowledge writes neither in kind nor in
// recoverability. Every door can call every operation now, so neither verb declares a scope. What
// keeps the power bounded is unchanged and was never the scope: both verbs append to committed,
// human-reviewable text under the knowledge root, each REVERSES the other, suppression expires
// is loud in reporter output, and the risk descriptor still says the verb writes.

import {
  QuarantineAddInputSchema,
  QuarantineAddOutputSchema,
} from '@vostride/agent-qa-schema'
import type { QuarantineAddInput, QuarantineAddOutput } from '@vostride/agent-qa-schema'

import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'

/** The literal appears here once; every surface names the constant. */
export const QUARANTINE_ADD_FUNCTION_ID = 'quarantine.add'

export const quarantineAddSpec: FunctionSpec<QuarantineAddInput, QuarantineAddOutput> = {
  id: QUARANTINE_ADD_FUNCTION_ID,
  summary: 'Quarantine one test by hand, renewing and claiming an existing entry.',
  resultKind: 'unary',
  boundThrough: 'quarantine',
  input: QuarantineAddInputSchema,
  output: QuarantineAddOutputSchema,
  risk: { name: `fn:${QUARANTINE_ADD_FUNCTION_ID}`, recognized: true, readOnly: false },
  /**
   * `renewed` IS IDEMPOTENCY, AND THE CONTRACT CALLS IT INFORMATION.
   *
   * "Already quarantined is information an operator acts on, not an error" — so both arms are
   * `executed` and the outcome says which gesture the ledger recorded.
   */
  classify(output): ClauseVerdict {
    switch (output.kind) {
      case 'entered':
        return { status: 'executed', outcome: 'entered: a new quarantine window was opened' }
      case 'renewed':
        return { status: 'executed', outcome: 'renewed: an open window was extended' }
      default:
        return output satisfies never
    }
  },
  async invoke(input, deps: FunctionDeps) {
    const quarantine = deps.quarantine
    if (quarantine === undefined) {
      // The loudest of the three refusals to get right: an unbound add that no-opped would
      // report a test as quarantined while it kept failing every build, and the operator would
      // read the next red as the quarantine not working rather than as never having existed.
      throw new FunctionNotBoundError(QUARANTINE_ADD_FUNCTION_ID)
    }

    // An absent `expiresAt` is left absent on purpose — the implementation stamps the pinned
    // default lifetime at write time. Defaulting it here would put a deadline into the request
    // the caller never asked for, and would be a second place the lifetime constant is spelled.
    return await quarantine.add(input)
  },
}
