// The browser mark door dispatches the same op as the CLI, in one request.
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  RunsMarkInputSchema,
  type RunsMarkOutcome,
} from '@vostride/agent-qa-schema'

import type { AgentHost } from '../chat/host.js'
import { readJsonBody } from '../server/body-parser.js'
import { refusalFor, respondJson, type RunDetailRefusal } from './run-detail-routes.js'

export type RunMarkOutcome =
  | { readonly kind: 'ok'; readonly body: RunsMarkOutcome }
  | RunDetailRefusal

/**
 * Address comes from the route; the body may never replace it or claim a caller identity. The body
 * is the op's own strict input minus `runId`, so a field the op does not declare is refused here
 * before anything is dispatched.
 */
export async function markRun(
  host: AgentHost,
  runId: string,
  body: unknown,
): Promise<RunMarkOutcome> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'refused', status: 400, body: { error: 'invalid_mark_input' } }
  }
  const input = body as Record<string, unknown>
  const parsed = RunsMarkInputSchema.safeParse({ ...input, runId })
  if (!parsed.success || 'runId' in input) {
    return { kind: 'refused', status: 400, body: { error: 'invalid_mark_input' } }
  }
  try {
    const result = await host.invokeFunction(
      host.registry, host.runsMarkFunctionId, parsed.data, host.caller,
    )
    return { kind: 'ok', body: result as RunsMarkOutcome }
  } catch (error) {
    return refusalFor(error)
  }
}

/** POST /api/runs/:id/mark. Both doors answer the op's outcome as it is. */
export function registerRunMarkRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    readonly host: AgentHost
    readonly runId: string
  },
): void {
  void readJsonBody<unknown>(req).then(async (body) => {
    const outcome = await markRun(deps.host, deps.runId, body)
    if (outcome.kind === 'refused') {
      respondJson(res, outcome.status, outcome.body)
      return
    }
    respondJson(res, 200, outcome.body)
  }, () => { respondJson(res, 400, { error: 'invalid_mark_input' }) })
    .catch(() => { respondJson(res, 500, { error: 'read_failed' }) })
}
