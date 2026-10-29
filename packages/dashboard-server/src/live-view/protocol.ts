// The LIVE-VIEW WIRE PROTOCOL (403 D-06, ratified 2026-08-25).
//
// THIS IS A PUBLISHED CONTRACT, not an internal shape. Phase 408's MCP App embed and M6's mobile
// transport consume the served page and this socket UNCHANGED, so what a `liveUrl` resolves to is
// one-way after they ship. The vocabulary is therefore written down once, here, and both ends of
// the socket are typed against it.
//
// THE PATH CONSTANTS ARE SPELLED AGAIN IN THIS PACKAGE, deliberately: `dashboard-server` does not
// import `agent` (the run-service routes' no-agent-import rule), so the embed prefix cannot be
// imported from the function layer. `live-view-tracer.test.ts` pins the two spellings EQUAL from
// the CLI, which may import both — the drift is measured rather than assumed away.

import { LIVE_URL_REFUSAL_REASONS } from '@vostride/agent-qa-schema'
import type {
  LiveStreamDeclaration,
  LiveStreamKind,
  LiveUrlRefusalReason,
} from '@vostride/agent-qa-schema'

/** The frame socket. A query carries the run id ONLY — never the token. */
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

/**
 * Every reason this socket can refuse a viewer, BY NAME.
 *
 * The four token verdicts plus the three this layer alone can answer: a run this process never
 * started, a handle that run does not have, and an editor session this process does not hold
 * Extending the token's list rather than restating it is what stops the two
 * vocabularies from drifting.
 */
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

/**
 * Every reason an `ended` message can carry, each naming a different fact.
 * `runFinished`: the run is over. `handleFinished`: this member's stream is over while its run
 * continues. `sessionEnded`: an editor session is over.
 */
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
  // `ts` is the frame's capture time in epoch ms and `kind` the producing capability's
  // kind. Both are ADDITIVE and optional: a frame that carries neither sends the pre-428 header.
  | { type: 'frame'; id: number; width: number; height: number; ts?: number; kind?: LiveStreamKind }
  | { type: 'renewed'; expiresAt: number }
  // EVERY END BY ITS OWN NAME. `handleFinished` says THIS member's stream is over
  // while the run continues; `runFinished` says the run is over; `sessionEnded` says an editor
  // session is over. Each is additive to the published contract: a consumer that
  // knows only the older names still reads every message it used to.
  | { type: 'ended'; reason: LiveViewEndReason }
