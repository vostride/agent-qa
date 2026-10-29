// Re-sorts nothing and takes no filter: ordering is the port's, and every caller sees all rows.

import {
  QuarantineListInputSchema,
  QuarantineListOutputSchema,
} from '@vostride/agent-qa-schema'
import type { QuarantineListInput, QuarantineListOutput } from '@vostride/agent-qa-schema'

import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'

// A `quarantine` domain, because quarantine state is neither a run, a memory nor an analysis.
export const QUARANTINE_LIST_FUNCTION_ID = 'quarantine.list'

export const quarantineListSpec: FunctionSpec<QuarantineListInput, QuarantineListOutput> = {
  id: QUARANTINE_LIST_FUNCTION_ID,
  summary: 'List every quarantined test with its owner, expiry and lifecycle state.',
  resultKind: 'unary',
  // An unbound host refuses rather than answer `[]` about a ledger it cannot read.
  boundThrough: 'quarantine',
  input: QuarantineListInputSchema,
  output: QuarantineListOutputSchema,
  risk: { name: `fn:${QUARANTINE_LIST_FUNCTION_ID}`, recognized: true, readOnly: true },
  // The count only, no entry's identity legs.
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
