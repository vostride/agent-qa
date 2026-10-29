import { z } from 'zod'

/**
 * The live-view transport families a run handle can declare. `cdp-screencast` is
 * the continuous stream; `snapshot` is the labelled 1s fallback frames arrive through when
 * continuous streaming is unavailable, delivered on the same hub, socket
 * and embed page. `snapshot` supersedes 403 D-08's rejection of stills (the dated note lands in
 * 428 Plan 27). `mjpeg` (mobile, M6) and `webrtc` (headful phase 2) are named here so a consumer
 * switches on a DECLARED kind rather than on a browser name or an adapter class (LIVE-04's
 * prohibition).
 */
export type LiveStreamKind = 'cdp-screencast' | 'snapshot' | 'mjpeg' | 'webrtc'
// prettier-ignore
export const LIVE_STREAM_KINDS = [
  'cdp-screencast',
  'snapshot',
  'mjpeg',
  'webrtc',
] as const satisfies readonly LiveStreamKind[]

/**
 * What a handle declares about its live stream. `{ kind: 'none' }` is the HONEST absent state —
 * a non-Chromium target, a finished member, or an adapter with no capability. It is never an
 * error and never a blank frame: the surface renders the no-stream state by name.
 */
export type LiveStreamDeclaration = { kind: LiveStreamKind } | { kind: 'none' }

/** The zod mirror of {@link LiveStreamDeclaration} — a discriminated union on `kind`. */
export const LiveStreamDeclarationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cdp-screencast') }).strict(),
  z.object({ kind: z.literal('snapshot') }).strict(),
  z.object({ kind: z.literal('mjpeg') }).strict(),
  z.object({ kind: z.literal('webrtc') }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
])

/**
 * Per-frame geometry as the producer reported it (CDP `screencastFrame.metadata`), plus the frame's
 * time. `timestamp` is the frame's CAPTURE time in integer epoch milliseconds, stamped by the
 * producer at capture. It is the one definition of a frame's time on every layer: the
 * hub fills it from its own clock only when a producer left it out, and never overwrites it.
 */
export interface LiveFrameMetadata {
  width: number
  height: number
  timestamp?: number
  scrollOffsetX?: number
  scrollOffsetY?: number
}

/**
 * ONE live frame as DATA: an id to ack with, the encoded bytes, and geometry. No
 * `Page`, no `CDPSession`, no handle of any kind crosses this type — which is what lets frames
 * travel a side channel while the run event bus stays silent about them.
 */
export interface LiveFrame {
  id: number
  bytes: Uint8Array
  metadata: LiveFrameMetadata
  /** The kind of the capability that produced this frame, stamped by the hub when the producer did not set it. */
  kind?: LiveStreamKind
}

/**
 * Why a handle's frame stream ended under its subscribers (428; the hub speaks them from Plan 04).
 * `withdrawn`: the member's capability was withdrawn or replaced while its run continues.
 * `closed`: the hub itself closed, because the run or the editor session is over.
 */
export type LiveFrameEndReason = 'withdrawn' | 'closed'
// prettier-ignore
export const LIVE_FRAME_END_REASONS = [
  'withdrawn',
  'closed',
] as const satisfies readonly LiveFrameEndReason[]

/**
 * A subscriber's hold on a handle's frame stream. `ack` reports that this subscriber consumed the
 * frame (the producer only asks for the next one once every subscriber has, or the ack bound
 * elapses); `unsubscribe` drops the hold and counts as acked for every outstanding frame.
 */
export interface LiveFrameSubscription {
  ack(frameId: number): void
  unsubscribe(): void
}
