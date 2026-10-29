// A release with no open window answers `no-entry`, an ordinary arm, not a throw.

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
  // `no-entry` is an ordinary answer, not a refusal.
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

    // Identity legs are matched as data, never joined onto a path.
    return await quarantine.release(input)
  },
}
