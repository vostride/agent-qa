// Formats nothing; a pruned handoff answers 200 `evidence-incomplete`, so `unknown_run` is rare.

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
  // The op's own input schema refuses a bad id before any dispatch; there is one run id codec.
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
