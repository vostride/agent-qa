// `runs.liveurl` — the ONE producer of live-view capability tokens.
//
// WHY THIS IS A FUNCTION-LAYER OP AND NOT A DASHBOARD ROUTE. The `liveUrl` is a credential of the
// v48 family, and the milestone's constraint is that surfaces are thin clients over one typed
// layer with no private powers. A dashboard that minted its own tokens would be a second auth
// system with its own expiry rules, its own audit story and its own log discipline — which is
// exactly the thing this op exists so that nobody has to write.

import {
  LIVE_URL_SCOPE,
  RunsLiveUrlInputSchema,
  RunsLiveUrlResultSchema,
} from '@vostride/agent-qa-schema'
import type { RunsLiveUrlInput, RunsLiveUrlResult } from '@vostride/agent-qa-schema'

import { liveUrlOf, mintLiveUrlToken, LIVE_URL_TTL_MS } from '../live-url.js'
import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export const RUNS_LIVE_URL_FUNCTION_ID = 'runs.liveurl'

/**
 * This host has no served origin to build a `liveUrl` against, or no live-view composition at all.
 *
 * A GENUINE HOST FACT, refused by name rather than answered with a URL that resolves to nothing:
 * `agent-qa run` in a terminal has no HTTP origin, and inventing one would produce a link that
 * looks live and is not.
 */
export class LiveViewUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`Live view is unavailable on this host: ${detail}`)
    this.name = 'LiveViewUnavailableError'
  }
}

/**
 * No such run (or no such handle on it). The SAME `unknown_run` word the run-service doors answer
 * with, so a caller that has learned one refusal vocabulary has learned them all.
 */
export class UnknownRunError extends Error {
  constructor(readonly runId: string) {
    super(`unknown_run: no live session for run ${runId}`)
    this.name = 'UnknownRunError'
  }
}

export const runsLiveUrlSpec: FunctionSpec<RunsLiveUrlInput, RunsLiveUrlResult> = {
  id: RUNS_LIVE_URL_FUNCTION_ID,
  summary: 'Mint a short-lived, view-scoped live-view URL for one handle of a running run.',
  resultKind: 'unary',
  boundThrough: 'liveView',
  input: RunsLiveUrlInputSchema,
  output: RunsLiveUrlResultSchema,
  risk: { name: `fn:${RUNS_LIVE_URL_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * THE OUTCOME SENTENCE NEVER CONTAINS THE TOKEN OR THE URL.
   *
   * A clause verdict is a thing surfaces PRINT — into chat transcripts, receipts and the audit
   * sink — so interpolating the result here would put a live credential into every durable record
   * this op touches, from one line of "helpful" formatting. What a person needs to know is that a
   * link was minted and for which handle; the link itself is already in the result they asked for.
   *
   * Declared explicitly rather than inherited: `registry.ts` registers this through a
   * `FunctionSpec` cast, and the classifier census is what makes a missing fold red.
   */
  classify(result): ClauseVerdict {
    return { status: 'executed', outcome: `liveUrl minted for handle ${result.handle}` }
  },
  async invoke(input, deps): Promise<RunsLiveUrlResult> {
    const liveView = deps.liveView
    if (!liveView) throw new LiveViewUnavailableError('no live-view port is bound on this host')
    const origin = liveView.origin()
    if (origin === undefined || origin === '') {
      throw new LiveViewUnavailableError('this host is not serving on a known origin')
    }

    const handle = input.handle ?? 0
    const stream = liveView.capabilityOf(input.runId, handle)
    if (stream === undefined) throw new UnknownRunError(input.runId)

    const now = liveView.now()
    const exp = now + LIVE_URL_TTL_MS
    const token = mintLiveUrlToken(liveView.signer, {
      subject: { kind: 'run', runId: input.runId, handle },
      scope: LIVE_URL_SCOPE,
      iat: now,
      exp,
    })
    // The one observation point for minted tokens, complete because this op is the only minter.
    // no shipped host binds it; it never gates producing the link.
    liveView.onMinted?.(token)

    return { liveUrl: liveUrlOf(origin, input.runId, token), expiresAt: exp, handle, stream }
  },
}
