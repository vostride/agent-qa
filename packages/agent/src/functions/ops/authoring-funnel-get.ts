// Callers render this op's answer; `computeAuthoringFunnel` owns every number.

import {
  AuthoringFunnelGetInputSchema,
  AuthoringFunnelGetOutputSchema,
} from '@vostride/agent-qa-schema'
import type { AuthoringFunnelGetInput, AuthoringFunnelGetOutput } from '@vostride/agent-qa-schema'

import { projectAuthoringFunnel } from '../../authoring/funnel.js'
import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'

// Dot segments only: an underscore id breaks the chat tool-name mapping for every op.
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
  // An unbound host refuses rather than answer a zero funnel that flatters the loop.
  boundThrough: 'authoringFunnel',
  input: AuthoringFunnelGetInputSchema,
  output: AuthoringFunnelGetOutputSchema,
  risk: { name: `fn:${AUTHORING_FUNNEL_GET_FUNCTION_ID}`, recognized: true, readOnly: true },
  // The receipt carries the funnel's own screened line, never one composed from the counters.
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
