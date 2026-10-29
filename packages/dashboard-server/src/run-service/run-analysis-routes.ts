// The run-ANALYSIS read route.
//
// `GET /api/runs/:id/analysis` locally, `GET /run/:runId/analysis` on the authed remote door, and
// BOTH call the one function below. This module is the whole of the HTTP half: validate the id
// with the OP'S OWN input schema, dispatch through the injected host, map the op's named refusals
// onto status codes. IT FORMATS NOTHING. It composes no sentence, folds no cluster and opens no
// database — `analysis.get` is THE single producer of a run's verdicts, sentences and clusters
// and a second producer on this door is the 405 D-01 anti-pattern restated.
//
// BOTH DOORS, ONE ADAPTER. 405 D-12/D-13 established the shape and 405-05 proved why: two
// doors resolving one read through two implementations means "the same analysis" depends on which
// credential asked. The sibling detail adapter's own note says a second spelling agrees on the day
// it is written and is a wire-contract fork thereafter.
//
// BOTH DOORS SERVE THE STORED BODY. The verdict sentence quotes the failing step's recorded error,
// which was masked at write, and neither door restores anything.
//
// THE REFUSAL VOCABULARY IS IMPORTED, NEVER RESPELLED. `refusalFor` is the detail adapter's, made
// exported for this file; `unknown_run` / `agent_host_unavailable` / `read_failed` mean here
// exactly what they mean one module away.

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  AnalysisGetInputSchema,
  type AnalysisGetOutput,
} from '@vostride/agent-qa-schema'

import type { AgentHost } from '../chat/host.js'
import { refusalFor, respondJson, type RunDetailRefusal } from './run-detail-routes.js'

export type RunAnalysisReadOutcome =
  | { readonly kind: 'ok'; readonly body: AnalysisGetOutput }
  | RunDetailRefusal

/**
 * THE READ. Exported so a cell can measure the outcome without a socket, and so both doors answer
 * with byte-identical bytes by CALLING this rather than by a second spelling that agrees today.
 */
export async function readRunAnalysis(
  host: AgentHost,
  runId: string,
): Promise<RunAnalysisReadOutcome> {
  // THE ID IS VALIDATED BY THE OP'S OWN INPUT SCHEMA, HERE, BEFORE THE DOOR IS TOUCHED. Not a
  // second regex: `runIdSchema` refuses exactly the ids the path layer would have to REWRITE
  // before using them, and the whole point of that codec is that there is one of it.
  const parsed = AnalysisGetInputSchema.safeParse({ runId })
  if (!parsed.success) {
    return { kind: 'refused', status: 400, body: { error: 'invalid_run_id' } }
  }

  try {
    const analysis = await host.invokeFunction(
      host.registry,
      host.analysisGetFunctionId,
      parsed.data,
      host.caller,
    ) as AnalysisGetOutput
    return { kind: 'ok', body: analysis }
  } catch (error) {
    return refusalFor(error)
  }
}

export interface RunAnalysisReadDeps {
  /** The DECODED run id. Decoding can throw, and that throw is the caller's refusal to answer. */
  readonly runId: string
  /** The injected host. Its absence is the ROUTER'S 503, not this function's. */
  readonly host: AgentHost
}

/** `GET /api/runs/:id/analysis` — the failure view's one read. */
export function serveRunAnalysisRead(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunAnalysisReadDeps,
): void {
  void readRunAnalysis(deps.host, deps.runId).then(
    (outcome) => {
      if (outcome.kind === 'refused') {
        respondJson(res, outcome.status, outcome.body)
        return
      }
      respondJson(res, 200, outcome.body)
    },
    // The read classifies every refusal it can name; anything reaching here is this module
    // failing, which is a 500 by name and never a body that looks like an answer.
    (error: unknown) => { respondJson(res, 500, refusalFor(error).body) },
  )
}
