// `quarantine.release` — the human half of the exit path.
//
// Quarantine already exits on its own two ways: M consecutive passing build ordinals
// (`released-auto`) and the wall-clock expiry that makes suppression stop. This is
// the third — a person deciding the test is fixed and saying so now — and it is what keeps the
// automatic exits conservative: a rule that has to be the ONLY way out has to be tuned for the
// impatient case, and this verb is why it does not.
//
// A DIRECT WRITE, NOT A PROPOSE+APPLY PAIR. The two-step KREV idiom exists for
// LEARNED-knowledge mutations, where the deltas a verb would commit are computed, reviewed and
// then applied by id. This is operational state: the caller already knows exactly which test it
// means, the change is one append to an event log, and the counterpart verb reverses it. 391
// may wrap these in the proposal engine when it lands; wrapping them now would have bought a
// review step for a gesture whose whole content is already in the request.
//
// NOT-QUARANTINED IS AN ARM, NOT A THROW. A release aimed at a test with no open window
// answers `no-entry`. That is an ordinary situation — a stale note, an auto-exit that beat the
// human to it, a second click — and a rejected promise would report it as a failure of the
// system rather than as a fact about the ledger.
//
// this verb no longer declares a write scope; `quarantine-add.ts` says
// why both verbs once carried `knowledge-write` and what bounds them now.

import {
  QuarantineReleaseInputSchema,
  QuarantineReleaseOutputSchema,
} from '@vostride/agent-qa-schema'
import type { QuarantineReleaseInput, QuarantineReleaseOutput } from '@vostride/agent-qa-schema'

import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'

/** The literal appears here once; every surface names the constant. */
export const QUARANTINE_RELEASE_FUNCTION_ID = 'quarantine.release'

export const quarantineReleaseSpec: FunctionSpec<
  QuarantineReleaseInput,
  QuarantineReleaseOutput
> = {
  id: QUARANTINE_RELEASE_FUNCTION_ID,
  summary: 'Release one test from quarantine — the manual half of the exit path.',
  resultKind: 'unary',
  boundThrough: 'quarantine',
  input: QuarantineReleaseInputSchema,
  output: QuarantineReleaseOutputSchema,
  risk: { name: `fn:${QUARANTINE_RELEASE_FUNCTION_ID}`, recognized: true, readOnly: false },
  /**
   * `no-entry` IS "an ordinary answer to an ordinary question" — the contract's words.
   */
  classify(output): ClauseVerdict {
    switch (output.kind) {
      case 'released':
        return { status: 'executed', outcome: 'released: the quarantine window was closed' }
      case 'no-entry':
        return {
          status: 'executed',
          outcome: 'no-entry: nothing was quarantined under that identity',
        }
      default:
        return output satisfies never
    }
  },
  async invoke(input, deps: FunctionDeps) {
    const quarantine = deps.quarantine
    if (quarantine === undefined) {
      // An unbound WRITE verb must refuse loudly. A silent no-op would tell an operator their
      // release landed while the ledger stayed exactly as it was, and the next red build would
      // be the first sign otherwise.
      throw new FunctionNotBoundError(QUARANTINE_RELEASE_FUNCTION_ID)
    }

    // Forwarded verbatim: the identity legs are DATA the implementation matches entries on —
    // never joined onto a path. The ledger's location is a fixed constant at the knowledge
    // root, so no caller string ever addresses a file.
    return await quarantine.release(input)
  },
}
