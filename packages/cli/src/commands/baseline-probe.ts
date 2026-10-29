// The runner bans `node:*`, so this probe runs at the CLI and only its result enters `RunConfig`.

import type { BaselineProbeResult } from '@vostride/agent-qa-runner'

export async function runBaselineProbe(url: string, timeoutMs = 4000): Promise<BaselineProbeResult> {
  const startedAt = Date.now()
  try {
    // `redirect: 'manual'` keeps the raw status; a 3xx is healthy and only 5xx means environment.
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
