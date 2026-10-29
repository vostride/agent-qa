// A published contract; paths are spelled again because this package cannot import agent.

import { LIVE_URL_REFUSAL_REASONS } from '@vostride/agent-qa-schema'
import type {
  LiveStreamDeclaration,
  LiveStreamKind,
  LiveUrlRefusalReason,
} from '@vostride/agent-qa-schema'

// The frame socket's query carries the run id only, never the token.
export const LIVE_VIEW_WS_PATH = '/api/live-view/ws'

/** The served embed page's prefix. Bare, so a host's `/api/` allowlist is not involved. */
export const LIVE_EMBED_PATH_PREFIX = '/live/'

/** The largest first message this socket will read. A hello is a few hundred bytes. */
export const LIVE_VIEW_HELLO_MAX_BYTES = 4096

/** Above this much buffered, a frame is DROPPED and acked — a slow viewer must not stall CDP. */
export const LIVE_VIEW_SLOW_VIEWER_BYTES = 2 * 1024 * 1024

/** Keepalive cadence. */
export const LIVE_VIEW_PING_MS = 15_000

/** The close code every refusal uses. In the 4000-4999 application range. */
export const LIVE_VIEW_REFUSAL_CLOSE_CODE = 4400

// The four token verdicts plus three this layer answers; extending the list keeps one vocabulary.
export type LiveViewRefusalReason =
  | LiveUrlRefusalReason
  | 'unknown_run'
  | 'unknown_handle'
  | 'unknown_session'
// prettier-ignore
export const LIVE_VIEW_REFUSAL_REASONS = [
  ...LIVE_URL_REFUSAL_REASONS,
  'unknown_run',
  'unknown_handle',
  'unknown_session',
] as const satisfies readonly LiveViewRefusalReason[]

// `runFinished`: the run is over; `handleFinished`: one member's stream; `sessionEnded`: an editor.
export type LiveViewEndReason = 'runFinished' | 'handleFinished' | 'sessionEnded'
// prettier-ignore
export const LIVE_VIEW_END_REASONS = [
  'runFinished',
  'handleFinished',
  'sessionEnded',
] as const satisfies readonly LiveViewEndReason[]

/** What the PAGE sends. `hello` must be first; `ack` and `renew` are valid only after `ready`. */
export type LiveViewClientMessage =
  | { type: 'hello'; token: string }
  | { type: 'ack'; id: number }
  | { type: 'renew'; token: string }

/**
 * What the SERVER sends.
 *
 * A `frame` is a TEXT header immediately followed by ONE BINARY message carrying the JPEG bytes.
 * Two messages rather than a length-prefixed binary frame so a consumer needs no custom header
 * parser — `JSON.parse` and a `Blob` are all an embed page has to know.
 */
export type LiveViewServerMessage =
  | { type: 'ready'; runId: string; handle: number; stream: LiveStreamDeclaration; expiresAt: number }
  | { type: 'refused'; reason: LiveViewRefusalReason }
  // `ts` is the capture time in epoch ms and `kind` the producer's kind; both are optional.
  | { type: 'frame'; id: number; width: number; height: number; ts?: number; kind?: LiveStreamKind }
  | { type: 'renewed'; expiresAt: number }
  // Each end by its own name; the names are additive, so older consumers still read every message.
  | { type: 'ended'; reason: LiveViewEndReason }
