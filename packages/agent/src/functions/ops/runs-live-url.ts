// The one minter, so live links have one expiry rule and no surface runs its own auth.

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
  // The outcome never holds the token or URL, because surfaces print it into durable records.
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
    // The one observation point for minted tokens; it never gates producing the link.
    liveView.onMinted?.(token)

    return { liveUrl: liveUrlOf(origin, input.runId, token), expiresAt: exp, handle, stream }
  },
}
