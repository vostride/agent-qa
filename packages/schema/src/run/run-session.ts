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

/**
 * The awaitable run completion resolved on {@link RunSession.done} the moment the
 * `verdict` event is emitted. The CLI awaits this and maps `verdict` → exit code;
 * `handoff` is the durable {@link CompletedRunHandoff}.
 */
export interface RunCompletion {
  verdict: RunStatus
  handoff: CompletedRunHandoff
}

/**
 * The M1-lite run session. A run becomes an addressable in-process
 * handle: identity + status, an optional live `subscribe`/replay seam onto the event bus,
 * run-level `cancel`, an awaitable `done`, and the per-handle live-frame seam.
 *
 * FRAMES ARE DATA. `subscribeFrames` surfaces a handle's live
 * frames as `bytes` + geometry + an ack, and `streamCapabilityOf` declares what that handle
 * can produce; both are closures over this process's per-run stream hub. `liveUrl` is
 * deliberately NOT a session member — it is minted by the function-layer op `runs.liveurl`
 * over a signer the session knows nothing about, so the session never holds token power.
 * Arbiter/control members stay ABSENT (Mode A, post-v2.0).
 *
 * 2026-08-25 (Phase 403, RESEARCH Pitfall 6 — the limit `subscribeFrames` carries): a Chromium
 * handle's screencast binds to the page the adapter held when the stream STARTED. A step that
 * switches tab or opens a popup therefore keeps streaming the first page, and a viewer sees a
 * still picture of somewhere the run has left. The declaration stays honest — the handle really
 * can stream — but the frames stop tracking the run, which no state on this type expresses.
 * Filed as a WINDOWS entry by 403-06 with its owning follow-up (a page-change signal the hub can
 * stop-and-start on); recorded here because this is the seam a consumer reads.
 *
 * @remarks Expanded from the provisional three-field DTO. `status` widens `RunStatus` with
 * the non-terminal `'running'` locally (the aggregate-verdict {@link RunStatus} stays
 * terminal-only). The bus stamps `seq`/`ts`; the session only exposes the subscribe seam.
 */
export interface RunSession {
  id: RunId
  status: 'running' | RunStatus
  executionContext: ExecutionContext
  /**
   * Attach a subscriber from `fromSeq` (replay-then-live, seq-order delivery). Returns an
   * unsubscribe handle. Bridges 1:1 onto SSE `Last-Event-ID` in M5.
   */
  subscribe(fromSeq: number, handler: (event: RunEventEnvelope) => void): () => void
  /**
   * Attach to handle `handle`'s live frames. Returns `undefined` when that handle
   * declares no stream — an honest absence, never an error. The subscription's `ack` throttles
   * the producer; `unsubscribe` releases the hold (last release stops the stream after a grace).
   *
   * `onEnd` is called once when this handle's stream ends under the
   * subscriber — the member finished, or its capability was replaced. OPTIONAL, so every caller
   * that only wants frames is unchanged. It is what lets a surface NAME the end of one member's
   * stream instead of holding a frozen last frame and going on calling it live.
   * `onEnd` names its reason — `withdrawn` (this member finished or was
   * replaced, the subject goes on) or `closed` (the whole subject is over).
   */
  subscribeFrames(
    handle: number,
    onFrame: (frame: LiveFrame) => void,
    onEnd?: (reason: LiveFrameEndReason) => void,
  ): LiveFrameSubscription | undefined
  /** What handle `handle` can stream right now. `{ kind: 'none' }` for an absent/finished handle. */
  streamCapabilityOf(handle: number): LiveStreamDeclaration
  /** Run-level cancel: abort the active member test, skip the rest, verdict `cancelled`. */
  cancel(): void
  /** Resolves on the `verdict` event with the terminal verdict + durable handoff. */
  done: Promise<RunCompletion>
}
