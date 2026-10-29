// The ONE test-side spelling of "this run's post-verdict enqueue happened".
//
// WHY THIS EXISTS. D-05 moved the durable `analyze-run` enqueue out of `runPostRunTail`'s
// `enqueue()` leg and into the shell-awaited post-verdict step, so every suite that drove the tail
// against a REAL store now has to queue its rows some other way — and "some other way" written six
// times, six slightly different ways, would be six fixtures quietly disagreeing about what a run
// owes its chain. This is the shipped `enqueueAnalyzeRun`, called through one adapter, so a suite
// that drives the pump is still driving rows the PRODUCT put there.
//
// IT IS NOT A REIMPLEMENTATION. Nothing here mints a payload, chooses an idempotency key or decides
// what `deduped` means; the only thing this file owns is the shape change between the tail's
// `composeHost(input: PostRunTailHostInput)` and the step's `composeHost({ agentQaRoot, configPath })`.
// A fixture's host factory ignores that argument anyway — it closes over the fixture's own roots —
// which is exactly why the adapter can be one line.

import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'

import {
  defaultCurationTailOperations,
  type CurationTailOperations,
} from '../curation/curation-tail.js'
import {
  enqueueAnalyzeRun,
  type PostVerdictEnqueueOutcome,
} from '../curation/post-verdict-step.js'

/**
 * Queue this run's `analyze-run` row the way the shell does, over the fixture's own host.
 *
 * `loadCompletedRunHandoff` defaults to the REAL reader, because every caller writes a real
 * handoff to disk and reading it is half of what the enqueue is being trusted to do.
 */
export async function enqueueThroughTheStep(input: {
  readonly runId: string
  readonly agentQaRoot: string
  readonly configPath: string
  readonly composeHost: () => LocalAgentHost
  readonly loadCompletedRunHandoff?: CurationTailOperations['loadCompletedRunHandoff']
}): Promise<PostVerdictEnqueueOutcome> {
  return await enqueueAnalyzeRun({
    runId: input.runId,
    agentQaRoot: input.agentQaRoot,
    configPath: input.configPath,
    operations: {
      loadCompletedRunHandoff:
        input.loadCompletedRunHandoff ?? defaultCurationTailOperations().loadCompletedRunHandoff,
      composeHost: () => input.composeHost(),
    },
  })
}
