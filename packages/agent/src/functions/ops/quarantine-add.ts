// Re-adding renews and says `renewed`, so callers need not read the ledger to pick a verb.

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
  // Already quarantined is information, so both arms are `executed`.
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
