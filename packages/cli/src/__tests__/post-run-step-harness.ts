// The shipped `enqueueAnalyzeRun` through one adapter, so suites drive rows the product queued.

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
