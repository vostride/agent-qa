// Both doors call this one adapter, which formats nothing; `analysis.get` is the only producer.

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
