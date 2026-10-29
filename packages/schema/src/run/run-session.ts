import type { CompletedRunHandoff } from '../handoff/completed-run-handoff'
import type {
  LiveFrame,
  LiveFrameEndReason,
  LiveFrameSubscription,
  LiveStreamDeclaration,
} from './live-stream'
import type { RunEventEnvelope } from './bus-events'
import type { RunId } from './run-id'
import type { RunStatus, ExecutionContext } from './run-status'

export interface RunCompletion {
  verdict: RunStatus
  handoff: CompletedRunHandoff
}

// A Chromium screencast stays bound to the page it started on, so a tab switch freezes the frames.
export interface RunSession {
  id: RunId
  status: 'running' | RunStatus
  executionContext: ExecutionContext
  // Replays from `fromSeq`, then delivers live events in seq order.
  subscribe(fromSeq: number, handler: (event: RunEventEnvelope) => void): () => void
  // Returns `undefined` when the handle declares no stream; `onEnd` says `withdrawn` or `closed`.
  subscribeFrames(
    handle: number,
    onFrame: (frame: LiveFrame) => void,
    onEnd?: (reason: LiveFrameEndReason) => void,
  ): LiveFrameSubscription | undefined
  /** What handle `handle` can stream now; `{ kind: 'none' }` for an absent or finished handle. */
  streamCapabilityOf(handle: number): LiveStreamDeclaration
  /** Run-level cancel: abort the active member test, skip the rest, verdict `cancelled`. */
  cancel(): void
  /** Resolves on the `verdict` event with the terminal verdict + durable handoff. */
  done: Promise<RunCompletion>
}
