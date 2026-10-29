// The resume token is the element's own `seq`, as on the live attach.

import { ReplayIncompleteError } from '@vostride/agent-qa-runner'
import { RunEventEnvelopeSchema, RunsEventsInputSchema } from '@vostride/agent-qa-schema'
import type { RunEventEnvelope, RunsEventsInput } from '@vostride/agent-qa-schema'

import type { ClauseVerdict, FunctionStream, FunctionStreamSpec } from '../spec.js'

export const RUNS_EVENTS_FUNCTION_ID = 'runs.events'

// The caller learns the exact seq replay can restart at, never a silently served gap.
export class StreamReplayFloorError extends Error {
  constructor(
    readonly runId: string,
    readonly requestedSeq: number,
    readonly earliestAvailableSeq: number,
  ) {
    super(
      `Events before seq ${earliestAvailableSeq} are no longer available for run ${runId} ` +
        `(replay requested at seq ${requestedSeq})`,
    )
    this.name = 'StreamReplayFloorError'
  }
}

/**
 * Yield the acquired envelopes one at a time.
 *
 * Acquisition happens BEFORE the generator is handed out (see `invoke`), so a floor
 * refusal is an invocation failure rather than a stream that dies mid-delivery. Iteration
 * itself stays lazy, which is the shape a live producer fills in unchanged.
 */
async function* replay(
  events: readonly RunEventEnvelope[],
): FunctionStream<RunEventEnvelope> {
  for (const event of events) {
    yield event
  }
}

export const runsEventsSpec: FunctionStreamSpec<RunsEventsInput, RunEventEnvelope> = {
  id: RUNS_EVENTS_FUNCTION_ID,
  summary: "Stream one run's recorded events in seq order, resuming after lastEventId.",
  resultKind: 'stream',
  input: RunsEventsInputSchema,
  output: RunEventEnvelopeSchema,
  risk: { name: `fn:${RUNS_EVENTS_FUNCTION_ID}`, recognized: true, readOnly: true },
  // Must not read an element: consuming the stream would eat the caller's first event.
  classify(_stream): ClauseVerdict {
    return { status: 'executed', outcome: 'replay opened — the recorded events are streaming' }
  },
  async invoke(input, deps) {
    // The token names the last envelope the caller ALREADY observed, so replay opens at
    // the next one. Absent means the caller has observed nothing, i.e. seq 1 onward.
    const fromSeq = (input.lastEventId ?? 0) + 1

    let events: readonly RunEventEnvelope[]
    try {
      events = await deps.runs.readEvents(input.runId, fromSeq)
    } catch (error) {
      if (error instanceof ReplayIncompleteError) {
        throw new StreamReplayFloorError(input.runId, fromSeq, error.earliestAvailableSeq)
      }
      throw error
    }

    return replay(events)
  },
}
