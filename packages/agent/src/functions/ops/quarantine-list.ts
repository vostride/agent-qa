// `quarantine.list` — the machine-readable enumeration of quarantine state.
//
// FLAK-03's "quarantine is enumerable" in one op: every entry carries the three legs of stable
// test identity, the fingerprint that keyed the window, the resolved class, the owner, the
// entry instant, the accumulated re-entry history, the deadline and the computed state. One
// producer, so a dashboard column, a CLI table and a chat answer are the same rows by
// construction rather than by review.
//
// That enumeration is D-13's, and it is stated in the SCHEMA'S OWN WORDING because it is one
// contract with two readers, not two paraphrases of one. `QuarantineEntrySchema`'s docstring is
// the other copy; the re-entry history was added to that copy in 390-18 and to this one in
// 390-20, and an enumeration contract that under-reports its own contents is precisely the
// failure the contract exists to prevent.
//
// THE OP RE-SORTS NOTHING. D-12 requires unassigned-owner entries FIRST — they are the triage
// queue — with the rest ordered deterministically after them. That ordering is the PORT
// implementation's law and is pinned where it is implemented; a second sort here would be a
// second declaration of it, free to agree today and disagree after the first tie-break change.
// The op's whole job is the envelope.
//
// THE INPUT CARRIES NO FILTER. Owner and state filtering are reader concerns over rows already
// in hand. A filter here would make the verb's answer depend on how it was asked, and the one
// caller that most needs the full picture — a human deciding what to un-quarantine — is exactly
// the one who would have to know to ask for it.

import {
  QuarantineListInputSchema,
  QuarantineListOutputSchema,
} from '@vostride/agent-qa-schema'
import type { QuarantineListInput, QuarantineListOutput } from '@vostride/agent-qa-schema'

import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'

/**
 * Lowercase dot taxonomy: a new `quarantine` domain, one noun. Quarantine state is
 * neither a run, a memory nor an analysis — filing these verbs under an existing domain would
 * have made the taxonomy decorative, which is the same call 387 made for `entities`.
 *
 * The literal appears here once; the parity-coverage suite picks the id up off the registry.
 */
export const QUARANTINE_LIST_FUNCTION_ID = 'quarantine.list'

export const quarantineListSpec: FunctionSpec<QuarantineListInput, QuarantineListOutput> = {
  id: QUARANTINE_LIST_FUNCTION_ID,
  summary: 'List every quarantined test with its owner, expiry and lifecycle state.',
  resultKind: 'unary',
  // Bound exactly where a composition supplies the quarantine port. Listing quarantine state
  // is not something a host can approximate: an unbound host answering `[]` would say "nothing
  // is quarantined" about a ledger it has never been able to read, which is a wrong answer
  // wearing a correct one's clothes. So it refuses by name instead.
  boundThrough: 'quarantine',
  input: QuarantineListInputSchema,
  output: QuarantineListOutputSchema,
  risk: { name: `fn:${QUARANTINE_LIST_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * A ledger listing that answered — the count, and no entry's identity legs.
   */
  classify(output): ClauseVerdict {
    const count = output.entries.length
    return {
      status: 'executed',
      outcome: `${count} quarantine entr${count === 1 ? 'y' : 'ies'}`,
    }
  },
  async invoke(_input, deps: FunctionDeps) {
    const quarantine = deps.quarantine
    if (quarantine === undefined) {
      throw new FunctionNotBoundError(QUARANTINE_LIST_FUNCTION_ID)
    }

    // An EMPTY listing is a result, not an absence: a project with no quarantined tests is the
    // healthy state, and it reads identically to one whose ledger file was never created.
    return { entries: [...await quarantine.list()] }
  },
}
