// The run-KNOWLEDGE read route.
//
// `GET /api/runs/:id/knowledge` is what the Knowledge tab reads, and this module is the whole of
// the HTTP half: validate the id with the OP'S OWN input schema, dispatch through the injected
// host, map the op's named refusals onto status codes. IT FORMATS NOTHING. It composes no summary
// line, folds no channel and opens no database — `runs.knowledge` is THE single producer of what
// a run used and learned, and a second producer on this door is the 405 D-01
// anti-pattern restated one surface later.
//
// ONE ADAPTER, ON THE ANALYSIS ARM'S FOOTING. The local door is the only door that
// serves this today, and the function is still written as an adapter both doors could call
// because that is what stopped `runs.detail` and `analysis.get` from forking: two doors resolving
// one read through two implementations means "the same run's knowledge" depends on which
// credential asked.
//
// BOTH DOORS SERVE THE STORED BODY. The projection carries producer text throughout, masked at
// write, and neither door restores anything.
//
// THE REFUSAL VOCABULARY IS IMPORTED, NEVER RESPELLED. `refusalFor` is the detail adapter's;
// `unknown_run` / `agent_host_unavailable` / `read_failed` mean here exactly what they mean two
// modules away. Note that `unknown_run` is nearly unreachable through THIS op by design: a run
// whose handoff is gone answers `kind: 'evidence-incomplete'` with a 200, because D-06 makes a
// pruned handoff a RESULT the page renders rather than a refusal it has to catch.

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  RunsKnowledgeInputSchema,
  type RunKnowledgeProjection,
} from '@vostride/agent-qa-schema'

import type { AgentHost } from '../chat/host.js'
import { refusalFor, respondJson, type RunDetailRefusal } from './run-detail-routes.js'

export type RunKnowledgeReadOutcome =
  | { readonly kind: 'ok'; readonly body: RunKnowledgeProjection }
  | RunDetailRefusal

/**
 * THE READ. Exported so a cell can measure the outcome without a socket, and so any second door
 * answers with byte-identical bytes by CALLING this rather than by a second spelling that agrees
 * on the day it is written.
 */
export async function readRunKnowledge(
  host: AgentHost,
  runId: string,
): Promise<RunKnowledgeReadOutcome> {
  // THE ID IS VALIDATED BY THE OP'S OWN INPUT SCHEMA, HERE, BEFORE THE DOOR IS TOUCHED
  // Not a second regex: `runIdSchema` refuses exactly the ids the path layer would
  // have to REWRITE before using them, and the whole point of that codec is that there is one of
  // it. Refusing early also means an untrusted path segment never reaches a dispatch at all.
  const parsed = RunsKnowledgeInputSchema.safeParse({ runId })
  if (!parsed.success) {
    return { kind: 'refused', status: 400, body: { error: 'invalid_run_id' } }
  }

  try {
    const projection = await host.invokeFunction(
      host.registry,
      host.runsKnowledgeFunctionId,
      parsed.data,
      host.caller,
    ) as RunKnowledgeProjection
    return { kind: 'ok', body: projection }
  } catch (error) {
    return refusalFor(error)
  }
}

export interface RunKnowledgeReadDeps {
  /** The DECODED run id. Decoding can throw, and that throw is the caller's refusal to answer. */
  readonly runId: string
  /** The injected host. Its absence is the ROUTER'S 503, not this function's. */
  readonly host: AgentHost
}

/** `GET /api/runs/:id/knowledge` — the Knowledge tab's one read. */
export function serveRunKnowledgeRead(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunKnowledgeReadDeps,
): void {
  void readRunKnowledge(deps.host, deps.runId).then(
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
