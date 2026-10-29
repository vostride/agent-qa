// Run-start baseline health probe. ONE global-fetch GET against the web target's
// base URL, executed here at the CLI composition root — the runner's ports ban node:*, so only
// the RESULT crosses into RunConfig.baselineProbe. Every failure (abort, connect, DNS) is caught
// and returned as a value; the function never rejects and never retries — a probe failure is
// itself the environment signal the deterministic root-cause classifier consumes, never a run
// abort. No HTTP-client dependency (Node 24 global fetch).

import type { BaselineProbeResult } from '@vostride/agent-qa-runner'

export async function runBaselineProbe(url: string, timeoutMs = 4000): Promise<BaselineProbeResult> {
  const startedAt = Date.now()
  try {
    // redirect: 'manual' — a 3xx is a healthy baseline (only >=500 classifies environment), and
    // not following the chain keeps the raw status deterministic. AbortSignal.timeout bounds the
    // probe to a fixed budget; single attempt, no retry.
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    // The status is the whole signal — drop the body without reading it.
    response.body?.cancel().catch(() => {})
    return { status: response.status, elapsedMs: Date.now() - startedAt }
  } catch (error) {
    return {
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
