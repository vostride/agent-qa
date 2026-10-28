// The run service's HTTP surface (Phase 402 plan 01, D-02 / D-06 / D-13 / D-15 · INVK-03).
//
// 2026-10-01 (432-21, D-12/D-13): TOKENLESS. The bearer verdict this door put first on every route,
// its `verifyBearer` port and the trust scope a matched token carried into the caller are deleted
// with `services.dashboard.runServiceTokens`. What stands first on every route now is the
// dashboard's own same-site guard (`refuseCrossSiteRequest`): a Host this loopback server never
// agreed to answer to, a foreign `Origin` or a cross-site `Sec-Fetch-Site` is refused before the
// route table. The paragraphs below that describe the bearer are kept as history and say so.
//
// A MOUNTABLE MODULE, NOT A SERVER (D-02). Everything this door needs from the world arrives as
// {@link RunServicePorts}: how to start a run, how to reach a started run's session, and how to
// answer readiness. It imports the shared schema vocabulary and
// node built-ins and NOTHING from `@vostride/agent-qa-agent`, `-agent-local` or `-safety` — those
// are the packages `packages/dashboard-server` may not name, and the arch package tests are the
// mechanical proof. 402 mounts this in the shipped dashboard process so there is no fourth process
// and no daemon TCP exposure; a future cloud host mounts the same unit with different ports.
//
// THE SAME-SITE GUARD IS FIRST ON EVERY ROUTE, AND ABOVE THE ROUTE TABLE (D-06, D-15; 432-21 D-13).
// Not per handler — per REQUEST, before dispatch is even attempted. A route added tomorrow inherits
// the refusal by construction rather than by somebody remembering, and a refused caller cannot
// learn WHICH paths exist, because a valid path and a nonsense one are refused identically. `/ok` is
// inside this rule and not an exception to it (D-15). Until 432-21 the rung here was the bearer
// verdict, whose two-arm type had no permissive arm; the guard that replaced it has none either —
// a request it does not admit is refused, never served a weaker answer.
//
// EVERY REFUSAL WRITES THE SAME BODY SHAPE — one key, a closed code (see
// `RunServiceErrorBodySchema`). Nothing echoes the caller's input or names a run id.
//
// THE STREAM SERVES THE FROZEN BUS ENVELOPE VERBATIM (D-13). SSE `id` is the envelope's `seq`,
// `event` is its `type`, and `data` is the envelope's own JSON. There is no projection layer and
// no re-mint: the bus IS the wire contract, so there is no second event vocabulary to drift, and
// payloads were masked at emit. `Last-Event-ID` resume falls out of seq-as-id nearly free, but the
// full replay/attach acceptance is 403's (INVK-05); 402 claims delivery, not the attach contract.
//
// NO CROSS-ORIGIN GRANT, AT ALL. This file writes no `Access-Control-Allow-Origin`, following the
// chat door's adjudication rather than the legacy run stream's wildcard. Until 432-21 that was the
// whole of this door's CSRF story: every route required an `Authorization` header, which made every
// request non-simple. With no header required, a page could send a SIMPLE cross-site POST, so the
// same-site guard above the table is what refuses it now, preflight or not.
//
// THE `?handle=` FILTER IS SERVER-SIDE, AND ITS PREDICATE LIVES IN THE SCHEMA (402-04, D-14).
// A parallel run is ONE run id with N attachable per-member handles. The optional `handle` query
// parameter selects one member's slice; run-scoped envelopes (verdict, `runFinished`, `heartbeat`,
// the diagnostics, and `runStarted` carrying the roster) ALWAYS pass it, so a handle subscriber
// still learns that the run ended. This file re-derives none of that: `passesHandleFilter` is
// imported from `@vostride/agent-qa-schema`, which is the only place an event type's scope is
// declared. A second spelling here would be a classification that drifts silently (T-402-15),
// because the two would agree on the day it was written and disagree the first time an event type
// is appended.
//
// THE HANDLE IS VALIDATED BEFORE ANY STREAM HEADER, on the same rule as the run id and for the
// same reason: a `200 text/event-stream` cannot be told it failed. Validation is in two parts, and
// the two answers are kept apart — a malformed parameter is `invalid_handle`, a well-formed one
// naming no member of this run is `unknown_handle`. Neither echoes the value.
//
// THE ROSTER IS READ OFF THE SESSION'S OWN REPLAYED `runStarted`, deliberately, rather than from
// bookkeeping the attach port could keep. The run's own header IS the roster announcement, so
// reading it here means the door validates against exactly what the stream is about to serve
// rather than against a second copy that could disagree. `runStarted` is seq 1 and `subscribe`
// replays synchronously from `REPLAY_FROM_START`, so the roster is in hand before `writeHead`.
// A run whose `runStarted` announces no roster cannot answer a per-handle question at all, and the
// honest answer to one is a refusal — not an unfiltered stream (which would serve every member's
// data to a caller who asked for one) and not an empty one (which would look like a member that
// did nothing).
//
// 2026-10-01 (432-21): no bearer is carried at all, in a header or a URL. This door's clients are
// still `curl`, `fetch` and CI; none of them sends an `Origin`, which is what the guard admits.
//
// BACKPRESSURE POSTURE, STATED RATHER THAN OVERLOOKED: writes are fire-and-forget with no `drain`
// handling, matching both shipped SSE streams in this package. A client that reads slower than a
// run emits grows this process's socket buffer. That is the shipped posture for run streaming and
// this door does not change it; a bounded-writer policy is one decision for all three streams, not
// a thing to invent here for one of them.
//
// REMOTE CANCEL IS DEFERRED (2026-08-24, Phase 402 · D-01 discretion note). Criterion 1 requires
// start + stream only. Cancel is a control affordance and belongs with 403's attach/detach world,
// where detach, reconnect and multi-surface addressing decide together what "stop it" means for a
// run several surfaces are watching. Nothing here forecloses it: it is a fourth row in the table
// below and a fifth port.

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  RUN_SERVICE_REFUSED_REQUEST_FIELDS,
  RunServiceStartRequestSchema,
  handleRosterOf,
  parseHandleParam,
  passesHandleFilter,
  type RunEventEnvelope,
  type RunServiceErrorCode,
  type RunServiceReadiness,
  type RunsLiveUrlResult,
  type RunSession,
  type RunStartAcknowledgement,
} from '@vostride/agent-qa-schema'

import type { AgentHost } from '../chat/host.js'
import { carriesNonJsonBody, readJsonBody } from '../server/body-parser.js'
import { refuseCrossSiteRequest } from '../server/cross-site.js'
// 405-05 (D-12 / 402 D-16): THE SAME TWO ADAPTERS THE LOCAL DOOR CALLS. Imported rather than
// re-implemented, because "both doors answer the same bytes" is a claim about there being one
// implementation — two that agree today are two that can stop agreeing.
import {
  serveRunArtifact,
  serveRunDetailRead,
  serveRunEvidenceRead,
  serveRunMarkPreviewRead,
  serveRunMarksHistoryRead,
} from './run-detail-routes.js'
import { serveRunAnalysisRead } from './run-analysis-routes.js'

/**
 * The seq a subscriber attaches at to receive the whole run.
 *
 * NEVER 0. The bus numbers from 1 and REFUSES to serve a prefix it cannot produce, so 0 is not
 * "earlier", it is unserveable — `subscribe(0, …)` raises `ReplayIncompleteError` on every run,
 * empty window or not. Same constant and same value as `in-process-backend.ts`'s.
 */
const REPLAY_FROM_START = 1

/** The comment-frame keepalive interval, matching both shipped SSE streams in this package. */
const HEARTBEAT_MS = 15_000

/**
 * The largest request body this door reads.
 *
 * TIGHTER THAN THE SHARED 1 MB DEFAULT, deliberately: the only thing a caller may send is a list
 * of test patterns, and a door that accepts a megabyte of it is a door that will one day be asked
 * to buffer a megabyte of it.
 */
const MAX_REQUEST_BYTES = 64 * 1024

/**
 * What starting a run needs from the composition, as data rather than as a live handle.
 *
 * 2026-10-01 (432-21, D-12): the matched token's `trustScope` and `clientId` are deleted with the
 * token. A start carries the caller's pattern set and nothing about who the caller is.
 */
export interface RunServiceStartInput {
  /** The pattern set the caller asked for; absent means the configured default set. */
  readonly patterns?: readonly string[]
}

/**
 * Everything this door reaches the world through (D-02).
 *
 * ALL ARE INJECTED, and the injection is what makes the module mountable: the implementations name
 * `invokeFunction`, `runs.start` and a composed local host, all of it vocabulary this package may
 * not import. `InProcessRunStarter` is the shape precedent one directory over. 2026-10-01 (432-21,
 * D-12): `verifyBearer` is deleted; the same-site guard needs no port.
 */
export interface RunServicePorts {
  /**
   * Start a run and return the acknowledgment.
   *
   * REJECTION IS NOT "the run failed" — a failing run still acknowledges. A rejection is a denial,
   * a refused request field, an input error or a crash.
   */
  invokeRunStart(input: RunServiceStartInput): Promise<RunStartAcknowledgement>
  /** The started run's session, or nothing if this process never started that run. */
  attach(runId: string): RunSession | undefined
  /** The measured readiness facts `/ok` reports (D-15). */
  readiness(): RunServiceReadiness
  /**
   * Mint a live-view URL for one handle of a run (403 D-03).
   *
   * REQUIRED, NOT OPTIONAL, and that is a decision rather than an oversight. An optional member is
   * a member a composition can forget, and the failure mode of forgetting it here is a 404 that
   * reads exactly like "no such route" — which is what a door with no live view is indistinguishable
   * from. A composition that cannot mint supplies a function that REJECTS with a
   * `LiveViewUnavailableError`-named error, which the arm maps to 503 `live_view_unavailable`: an
   * honest host fact, said out loud, once, in the vocabulary the local door already uses.
   *
   * The minted token's own subject (run, handle) and expiry are checked by the live-view validator
   * independently of who asked (D-13). 2026-10-01 (432-21, D-12): the bearer's trust scope this mint
   * used to run under is deleted; the composition supplies the one caller it runs under.
   */
  mintLiveUrl(input: MintLiveUrlInput): Promise<RunsLiveUrlResult>
  /**
   * The injected agent host the two READ rows dispatch through (405-05, D-12/D-13).
   *
   * OPTIONAL, unlike `mintLiveUrl` above, and the asymmetry is deliberate rather than an
   * oversight. `mintLiveUrl` is required because a composition that forgot it would answer a 404
   * indistinguishable from an unserved path — but the argument runs the other way here: a host
   * genuinely composed without a function registry (a bare mount, this file's own fixtures) has no
   * capability to reach, and the honest answer is the SAME 503 `agent_host_unavailable` the local
   * door already gives for exactly this state. One word, one meaning, both doors.
   *
   * It is a HANDLE and nothing else — this package may not name the agent packages, so what
   * crosses is the seam `chat/host.ts` declares and the op ids the composition supplies as data.
   */
  readonly agentHost?: AgentHost
}

/** What minting one `liveUrl` needs from a request, as data: the subject, and nothing else. */
export interface MintLiveUrlInput {
  readonly runId: string
  readonly handle: number
}

/** Which handler a table row reaches. A closed union, so a row with no arm is a type error. */
export type RunServiceRouteHandlerName =
  | 'start'
  | 'events'
  | 'liveUrl'
  // 405-05 (D-12 / 402 D-16): the two READ rows. 402 D-16 said "405's ref-resolving sha-keyed
  // route mounts behind the same authed door", and mounting it here rather than beside it is what
  // makes that literal: the guard above the table applies to these rows by construction, and the
  // census that drives every row cross-site inherits them the day they land.
  | 'detail'
  | 'evidence'
  | 'artifact'
  // 406-01 (D-04): the failure view's read, on the two rows above's exact footing — the local
  // door's `GET /api/runs/:id/analysis` mounts the SAME adapter, so 408's embed and every thin
  // client parse one path shape whichever door they call.
  | 'analysis'
  // 2026-09-15, 423-21 D-18: the two feedback reads, masked on this door like the rows above.
  | 'marks'
  | 'markPreview'
  | 'ok'

export interface RunServiceRouteRow {
  readonly method: 'GET' | 'POST'
  /** The literal path, or — for a templated route — its `:param` shape. */
  readonly path: string
  readonly handler: RunServiceRouteHandlerName
  /** Present only on a templated route; the matcher uses it instead of `path`. */
  readonly pattern?: RegExp
}

export const RUN_SERVICE_START_ROUTE = '/run'
export const RUN_SERVICE_EVENTS_TEMPLATE = '/run/:runId/events'
const RUN_SERVICE_EVENTS_PATTERN = /^\/run\/([^/]+)\/events$/
/**
 * The MINT (403 D-03, Q3) — the remote half of the pair whose local half is
 * `GET /api/runs/:runId/live-url`.
 *
 * SAME SHAPE AS THE EVENTS ROUTE ONE LINE UP, deliberately: a caller addresses a run it started by
 * id and asks this door for one thing about it per route. Since 432-21 the two doors differ in
 * nothing but the path — the same op, the same caller shape, the same result and fragment carriage.
 */
export const RUN_SERVICE_LIVE_URL_TEMPLATE = '/run/:runId/live-url'
const RUN_SERVICE_LIVE_URL_PATTERN = /^\/run\/([^/]+)\/live-url$/
/**
 * Readiness (D-15) — behind the same-site guard, like every other route on this door.
 *
 * An `/ok` that answered before the guard would tell a page on another origin that this process is
 * an agent-qa run service and that it is up. (Until 432-21 the guard here was the bearer verdict,
 * and the preflight was liveness and early token validation in one round-trip.)
 */
/**
 * The durable run-detail READ — the remote twin of the local door's `GET /api/runs/:id/detail`.
 *
 * IT DISPATCHES THROUGH THE SAME ADAPTER THE LOCAL DOOR CALLS. `serveRunDetailRead` is one
 * function, so the two doors cannot come to disagree about what a run's projection is; a second
 * spelling here would agree on the day it was written and be a wire-contract fork thereafter.
 *
 * This row serves the same stored body the local door serves, masked at write.
 */
export const RUN_SERVICE_DETAIL_TEMPLATE = '/run/:runId/detail'
const RUN_SERVICE_DETAIL_PATTERN = /^\/run\/([^/]+)\/detail$/
export const RUN_SERVICE_EVIDENCE_TEMPLATE = '/run/:runId/evidence'
const RUN_SERVICE_EVIDENCE_PATTERN = /^\/run\/([^/]+)\/evidence$/
/**
 * The ref-resolving artifact READ (405-05, D-12 / 402 D-16) — the remote twin of the local door's
 * `GET /api/runs/:runId/artifacts/:sha`, and the row 402 D-16 named by anticipation.
 *
 * TWO CAPTURES, `[^/]+` ON BOTH. The runId is decoded and the sha is not: a content address is 64
 * characters from `[0-9a-f]`, none of which percent-encoding can represent differently, so a sha
 * segment that needed decoding is already not one.
 *
 * MASKED, LIKE ITS SIBLING AND MORE SO: these are BYTES. The unmask seam never touches an artifact
 * body on any door (D-09) — a screenshot is not text and there is nothing in it to restore.
 */
export const RUN_SERVICE_ARTIFACT_TEMPLATE = '/run/:runId/artifacts/:sha'
const RUN_SERVICE_ARTIFACT_PATTERN = /^\/run\/([^/]+)\/artifacts\/([^/]+)$/
/**
 * The run-ANALYSIS read — the remote twin of the local door's `GET /api/runs/:id/analysis`.
 *
 * IT DISPATCHES THROUGH THE SAME ADAPTER THE LOCAL DOOR CALLS, for the reason its detail sibling
 * does: `serveRunAnalysisRead` is one function, so the two doors cannot come to disagree about
 * what a run's analysis is.
 *
 * This row serves the same stored body the local door serves, masked at write.
 */
export const RUN_SERVICE_ANALYSIS_TEMPLATE = '/run/:runId/analysis'
const RUN_SERVICE_ANALYSIS_PATTERN = /^\/run\/([^/]+)\/analysis$/
/** 2026-09-15, 423-21 D-18: runs.marks.history and runs.mark.preview behind the same guard. */
export const RUN_SERVICE_MARKS_TEMPLATE = '/run/:runId/marks'
const RUN_SERVICE_MARKS_PATTERN = /^\/run\/([^/]+)\/marks$/
export const RUN_SERVICE_MARK_PREVIEW_TEMPLATE = '/run/:runId/mark-preview'
const RUN_SERVICE_MARK_PREVIEW_PATTERN = /^\/run\/([^/]+)\/mark-preview$/
export const RUN_SERVICE_OK_ROUTE = '/ok'

/**
 * EVERY PATH THIS DOOR ANSWERS, as data the dispatch reads (the chat door's own idiom).
 *
 * WHY A TABLE AND NOT THREE ARMS. The same-site guard below is applied to the REQUEST, above this
 * table, so a route added tomorrow inherits it by construction. The table is what makes that
 * inheritance AUDITABLE from outside: because dispatch reads it, a route not in it is unreachable,
 * so a census cell can enumerate this array and drive every row cross-site — and a newly added
 * route cannot escape that corpus by nobody noticing it.
 */
export const RUN_SERVICE_ROUTE_TABLE: readonly RunServiceRouteRow[] = Object.freeze([
  { method: 'POST', path: RUN_SERVICE_START_ROUTE, handler: 'start' },
  {
    method: 'GET',
    path: RUN_SERVICE_EVENTS_TEMPLATE,
    handler: 'events',
    pattern: RUN_SERVICE_EVENTS_PATTERN,
  },
  {
    method: 'GET',
    path: RUN_SERVICE_LIVE_URL_TEMPLATE,
    handler: 'liveUrl',
    pattern: RUN_SERVICE_LIVE_URL_PATTERN,
  },
  {
    method: 'GET',
    path: RUN_SERVICE_DETAIL_TEMPLATE,
    handler: 'detail',
    pattern: RUN_SERVICE_DETAIL_PATTERN,
  },
  { method: 'GET', path: RUN_SERVICE_EVIDENCE_TEMPLATE, handler: 'evidence',
    pattern: RUN_SERVICE_EVIDENCE_PATTERN },
  {
    method: 'GET',
    path: RUN_SERVICE_ARTIFACT_TEMPLATE,
    handler: 'artifact',
    pattern: RUN_SERVICE_ARTIFACT_PATTERN,
  },
  {
    method: 'GET',
    path: RUN_SERVICE_ANALYSIS_TEMPLATE,
    handler: 'analysis',
    pattern: RUN_SERVICE_ANALYSIS_PATTERN,
  },
  { method: 'GET', path: RUN_SERVICE_MARKS_TEMPLATE, handler: 'marks', pattern: RUN_SERVICE_MARKS_PATTERN },
  { method: 'POST', path: RUN_SERVICE_MARK_PREVIEW_TEMPLATE, handler: 'markPreview',
    pattern: RUN_SERVICE_MARK_PREVIEW_PATTERN },
  { method: 'GET', path: RUN_SERVICE_OK_ROUTE, handler: 'ok' },
] as const)

/** What a matched row carries: the row itself and whatever its pattern captured. */
export interface RunServiceRouteMatch {
  readonly row: RunServiceRouteRow
  /** The raw, still-ENCODED capture groups. Decoding is the handler's business, and it can throw. */
  readonly params: readonly string[]
}

/** Resolve a request to a table row, or to nothing. The dispatch's only route lookup. */
export function matchRunServiceRoute(
  method: string | undefined,
  path: string,
): RunServiceRouteMatch | undefined {
  for (const row of RUN_SERVICE_ROUTE_TABLE) {
    if (row.method !== method) continue
    if (row.pattern === undefined) {
      if (path === row.path) return { row, params: [] }
      continue
    }
    const matched = row.pattern.exec(path)
    if (matched !== null) return { row, params: matched.slice(1).map((part) => part ?? '') }
  }
  return undefined
}

/**
 * Whether a path belongs to this door — the MOUNT's whole question, and method-blind on purpose.
 *
 * A host consults this before its own routing so that every request to a service path, including
 * an `OPTIONS` preflight and a method this table has no row for, is answered by this door rather
 * than by the host's generic handling. That is what keeps the host's wildcard CORS preflight and
 * its SPA fallback away from this surface.
 *
 * DERIVED FROM THE TABLE, never a second list: the prefixes are read off the rows, so a route
 * added above is mounted the same commit.
 */
export function ownsRunServicePath(path: string): boolean {
  for (const row of RUN_SERVICE_ROUTE_TABLE) {
    if (row.pattern === undefined) {
      if (path === row.path) return true
      continue
    }
    if (row.pattern.test(path)) return true
  }
  // A path UNDER a declared literal route is this door's too, so `/run/anything` is refused here
  // rather than falling into the host's SPA fallback and answering 200 with an HTML page.
  return RUN_SERVICE_ROUTE_TABLE.some((row) => row.pattern === undefined
    && path.startsWith(`${row.path}/`))
}

export interface RunServiceRouter {
  (req: IncomingMessage, res: ServerResponse): void
  /** Live SSE connections — so a host can assert this door leaks none on teardown. */
  openStreamCount(): number
}

/** The one non-2xx body this door writes: a single key carrying a closed code. */
function refuse(res: ServerResponse, status: number, error: RunServiceErrorCode): void {
  if (res.headersSent || res.writableEnded) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ error })
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * The ONE non-2xx body on this door wider than a single key.
 *
 * The shape is `RunServiceReplayFloorBodySchema`'s — see that schema for why the second key is
 * sound exactly here: `earliestAvailableSeq` is a fact about the CALLER'S OWN request, and without
 * it the refusal tells a caller nothing it can act on.
 */
function refuseWithFloor(res: ServerResponse, earliestAvailableSeq: number): void {
  if (res.headersSent || res.writableEnded) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ error: 'replay_floor', earliestAvailableSeq })
  res.writeHead(410, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function respondJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * The `handle` query parameter, exactly as it arrived, or `null` when absent.
 *
 * Read off the query substring with `URLSearchParams` rather than `new URL(...)`: this is
 * untrusted input on a path that has already matched, and a constructor that can throw does not
 * belong between a matched route and its handler.
 *
 * A REPEATED parameter is not resolved to one of its values — the values are joined, which cannot
 * parse, so `?handle=1&handle=2` is refused rather than silently answered as handle 1: a request
 * that says two different things is not a request that said the first one.
 *
 * EXPORTED FOR THE SECOND DOOR (402-08), on {@link serveRunEventStream}'s own reasoning. The local
 * loopback route reads the parameter through THIS function rather than through the host router's
 * `url.searchParams.get('handle')`, which would return `1` for `?handle=1&handle=2` — that is, the
 * one wrong answer this reader exists to refuse. The core takes the RAW parameter, so which reader
 * produced it is exactly the seam a second spelling would slip into.
 */
export function handleParamOf(req: IncomingMessage): string | null {
  const query = (req.url ?? '').split('?').slice(1).join('?')
  if (query === '') return null
  const values = new URLSearchParams(query).getAll('handle')
  if (values.length === 0) return null
  if (values.length === 1) return values[0] ?? null
  return values.join(',')
}

/**
 * The `lastEventId` query parameter, exactly as it arrived, or `null` when absent (403-03, D-13).
 *
 * SPELLED `lastEventId` AND NEVER `fromSeq`. The SSE header, the `runs.events` op input and this
 * door's query all mean the same thing — "the last envelope the caller already observed" — so they
 * carry the same word, and the `+ 1` that turns it into a subscribe point lives in exactly one
 * place per reader. A second spelling would be a second arithmetic somebody has to keep in step.
 *
 * READ OFF THE RAW QUERY, on {@link handleParamOf}'s reasoning and by the same mechanics: a
 * REPEATED parameter is joined rather than resolved to one of its values, so `?lastEventId=1&
 * lastEventId=7` cannot parse and is refused rather than silently answered as 1. A request that
 * says two different things about where to resume is not a request that said the first one — and
 * on a resume the consequence of guessing is a gap or a duplicate, which is exactly what INVK-05
 * exists to prevent.
 */
export function lastEventIdParamOf(req: IncomingMessage): string | null {
  const query = (req.url ?? '').split('?').slice(1).join('?')
  if (query === '') return null
  const values = new URLSearchParams(query).getAll('lastEventId')
  if (values.length === 0) return null
  if (values.length === 1) return values[0] ?? null
  return values.join(',')
}

/**
 * Where a stream request asked to resume from. Three arms, and the count is the contract.
 *
 * `start` is "the caller has observed nothing", `after` carries the last seq it DID observe, and
 * `invalid` is a fact about the caller's own input. There is deliberately no fourth arm meaning
 * "unparseable, serve them from the beginning": silently restarting a resume at seq 1 would
 * re-deliver every envelope the caller already has, and silently serving from the floor would hide
 * a gap — the two answers D-13 refuses by name.
 */
export type ResumePoint =
  | { readonly kind: 'start' }
  | { readonly kind: 'after'; readonly seq: number }
  | { readonly kind: 'invalid' }

/** Canonical non-negative decimal integers only — `parseHandleParam`'s own form, one package over. */
const CANONICAL_LAST_EVENT_ID = /^(?:0|[1-9][0-9]*)$/

/**
 * Resolve the `Last-Event-ID` header and the `?lastEventId=` parameter to one resume point.
 *
 * THE HEADER DECIDES WHEN BOTH ARE PRESENT, and that is not arbitrary. The query parameter exists
 * for clients that cannot set a header; the header is what a BROWSER's own automatic EventSource
 * reconnect carries, and it carries the freshest id the browser actually received. A URL, by
 * contrast, is whatever the page was opened with — possibly minutes and hundreds of envelopes ago.
 * Preferring the stale value would re-deliver the difference on every reconnect.
 *
 * DELIBERATELY NOT `Number(raw)`, on `parseHandleParam`'s reasoning: that accepts `' 7 '`, `'0x7'`,
 * `'1e1'`, `'-0'` and `''` (→ 0), so a caller could name one resume point several ways and an
 * empty header would silently become "from the beginning". An EMPTY header is `invalid` rather
 * than absent precisely because it is present — the caller said something, and it did not parse.
 */
export function resumePointOf(
  header: string | readonly string[] | null | undefined,
  param: string | null,
): ResumePoint {
  const headerValue = Array.isArray(header)
    // A repeated `Last-Event-ID` is joined, never resolved to one of its values — the repeated-
    // parameter law above, applied to the header Node folds into an array.
    ? (header as readonly string[]).join(',')
    : (header as string | null | undefined)
  const raw = headerValue ?? param
  if (raw === null || raw === undefined) return { kind: 'start' }
  if (!CANONICAL_LAST_EVENT_ID.test(raw)) return { kind: 'invalid' }
  const seq = Number(raw)
  if (!Number.isSafeInteger(seq)) return { kind: 'invalid' }
  return { kind: 'after', seq }
}

/**
 * The REPLAY FLOOR this rejection reports, if it is one — read structurally, never by class.
 *
 * `@vostride/agent-qa-runner` IS a declared dependency of this package, so an
 * `instanceof ReplayIncompleteError` would compile — and it would still be the wrong instrument.
 * The error arrives through {@link RunSession.subscribe}, a schema-declared port whose implementer
 * this module does not choose: a cloud host, a test fixture or a future replay source can all
 * satisfy that port without sharing this process's copy of the runner's class object, and
 * `instanceof` answers false across every one of those seams while the caller's situation is
 * identical. What is stable is the SHAPE the bus documents: the name and the floor.
 *
 * BOTH FIELDS ARE CHECKED. A rejection carrying the right name and no usable number cannot be
 * answered with a recovery point, and a 410 whose advertised recovery point is missing or nonsense
 * is worse than no 410 at all — the caller is told to re-attach somewhere unreachable. That case
 * falls through to the 500 arm, which is the honest answer for "the replay could not be served and
 * this door cannot say where it could have been".
 */
export function replayFloorOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if ((error as { name?: unknown }).name !== 'ReplayIncompleteError') return undefined
  const floor = (error as { earliestAvailableSeq?: unknown }).earliestAvailableSeq
  if (typeof floor !== 'number' || !Number.isSafeInteger(floor) || floor < 0) return undefined
  return floor
}

/**
 * Which REFUSED request fields a body carries (D-07 / D-12).
 *
 * Checked as a KEY test rather than by parsing, so `{"runId": null}` is refused too: the offense is
 * naming the field at all, not the value put in it. `RunServiceStartRequestSchema` is `.strict()`
 * and would refuse these keys as unrecognised a line later — this check exists so the answer says
 * WHICH kind of refusal it was, and so the door's own law is legible where the door enforces it.
 */
function refusedFieldsIn(body: Record<string, unknown>): readonly string[] {
  return RUN_SERVICE_REFUSED_REQUEST_FIELDS.filter((field) => Object.hasOwn(body, field))
}

/**
 * The run service's router: total over its own paths, and never anything else.
 *
 * TOTAL BY DESIGN. It answers every path {@link ownsRunServicePath} claims, including ones no row
 * matches, because the fall-through it would otherwise land in is the host's SPA fallback — which
 * answers 200 with an HTML page for any unknown path.
 */
/** What the exported stream core reaches the world through. */
export interface RunEventStreamDeps {
  /** The DECODED run id. Decoding can throw, and that throw is the caller's 404 to answer. */
  readonly runId: string
  /** The raw `handle` query parameter, exactly as it arrived; `null` means the firehose. */
  readonly handleParam: string | null
  /**
   * WHERE TO RESUME, ALREADY RESOLVED FROM THE HEADER AND THE QUERY (403-03, D-13).
   *
   * Resolved by the CALLER rather than read here, on `handleParam`'s own reasoning inverted: the
   * handle arrives raw because there is exactly one parse of it and it lives in this core, while
   * the resume point arrives resolved because it is read from TWO places — a header and a query —
   * and only the host holds the request object both live on. {@link resumePointOf} and
   * {@link lastEventIdParamOf} are exported so each door resolves it with the same pair.
   *
   * Absent is `{ kind: 'start' }`, which is what a door that has not learned about resume yet
   * would have meant anyway.
   */
  readonly resume?: ResumePoint
  /** The started run's session, or nothing if this process never started that run. */
  attach(runId: string): RunSession | undefined
  /** Live teardowns, so a host can count open streams and a close removes exactly one. */
  readonly openStreams?: {
    add(teardown: () => void): void
    delete(teardown: () => void): void
  }
}

/**
 * THE RUN STREAM, AS ONE UNIT: attach, validate the handle, filter, frame, heartbeat, close.
 *
 * Exported because there is going to be a SECOND door onto the same stream — 402-08 mounts the
 * local door, which differed from this one only in what it did about credentials (and since 432-21
 * differs in nothing but the path). Two doors
 * calling one function is the only shape in which the filter has exactly one implementation; two
 * copies of the serving body would be two places `?handle=` could drift, and the drift would be
 * invisible until somebody diffed them.
 *
 * The ORDER below is the contract, not an implementation detail. Every refusal — unknown run,
 * malformed handle, unknown handle, unavailable replay — happens before `writeHead`, because a
 * response that has already written `200 text/event-stream` cannot be told it failed.
 */
export function serveRunEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunEventStreamDeps,
): void {
  const parsedHandle = parseHandleParam(deps.handleParam)
  if (parsedHandle.kind === 'invalid') {
    // Refused before the run is even looked up: a malformed parameter is a fact about the
    // caller's own input, so answering it early leaks nothing about which runs exist.
    refuse(res, 400, 'invalid_handle')
    return
  }

  const resume = deps.resume ?? { kind: 'start' }
  if (resume.kind === 'invalid') {
    // Same posture and same position as the handle refusal above, and for the same reason.
    refuse(res, 400, 'invalid_last_event_id')
    return
  }

  const session = deps.attach(deps.runId)
  if (session === undefined) {
    refuse(res, 404, 'unknown_run')
    return
  }

  // THE ONE PLACE THE `+ 1` LIVES on this door (`runs.events` holds the other, for the durable
  // reader). `Last-Event-ID` names the last envelope the caller ALREADY observed, so the replay
  // opens at the next one — which is what makes "no id at or below the resume point is ever
  // re-sent" a property of the arithmetic rather than of a filter somewhere downstream.
  const fromSeq = resume.kind === 'after' ? resume.seq + 1 : REPLAY_FROM_START
  const isDeepResume = fromSeq > REPLAY_FROM_START

  // ---- The roster on a DEEP resume (403-03, D-14) ------------------------------------------
  //
  // THE ROSTER RIDES `runStarted`, AND `runStarted` IS SEQ 1. Below, on a `subscribe(1, …)`, it is
  // the first envelope delivered and the roster is in hand before the handle is checked. On
  // `subscribe(N + 1, …)` with N >= 1 it is NOT delivered at all — so a door that only derived the
  // roster from what it was served would answer `unknown_handle` for EVERY deep resume on a member
  // stream, which is a correct handle refused because the door forgot who was in the run.
  //
  // The peek is a second `subscribe(1, …)` whose handler records the first envelope's roster and
  // which unsubscribes immediately. It costs one extra replay walk on the deep-resume path only,
  // and it is the price of not touching the bus: stopping the walk early would mean THROWING out
  // of the handler, which the bus reads as a detached subscriber and answers with a published
  // `runWarning` — a side effect on the run's own event log, caused by reading it.
  //
  // WHEN THE PEEK ITSELF HITS THE FLOOR THE ROSTER IS UNKNOWABLE, and the handle validation is
  // SKIPPED with the filter still applied. Refusing instead would turn every deep resume on a
  // member stream of a long run into `unknown_handle` the moment seq 1 fell out of the window —
  // punishing the caller for the bus's retention. The filter is what carries the security claim
  // (T-403-14): `passesHandleFilter` still runs on every envelope, so an unknown handle sees the
  // run-scoped events and nothing else, which is a strictly smaller set than the firehose it could
  // have asked for with no handle at all.
  let rosterKnown = true
  let peekedRoster: readonly number[] | undefined
  if (parsedHandle.kind === 'handle' && isDeepResume) {
    try {
      let first = true
      const stopPeek = session.subscribe(REPLAY_FROM_START, (event) => {
        if (!first) return
        first = false
        peekedRoster = handleRosterOf(event)
      })
      stopPeek()
    } catch (peekError) {
      if (replayFloorOf(peekError) === undefined) {
        refuse(res, 500, 'replay_unavailable')
        return
      }
      rosterKnown = false
    }
    if (rosterKnown && !(peekedRoster ?? []).includes(parsedHandle.index)) {
      refuse(res, 400, 'unknown_handle')
      return
    }
  }

  // The frame writer BUFFERS until the head is out, because `subscribe` delivers the replay
  // synchronously and can also THROW (`ReplayIncompleteError`). Subscribing first and writing the
  // head after is what keeps a failed attach answerable as a typed JSON error instead of a
  // half-open stream nobody can be told about. It is ALSO what puts the roster in hand before the
  // head: `runStarted` is seq 1, so the replay has already delivered it by the time the handle is
  // checked against the roster below.
  const pending: string[] = []
  let open = false
  const write = (frame: string): void => {
    if (open) res.write(frame)
    else pending.push(frame)
  }
  const frameOf = (event: RunEventEnvelope): string =>
    // D-13, all three parts: the id IS the seq, the event name IS the envelope type, and the
    // data IS the envelope's own JSON. No projection, no rename, no second vocabulary. The filter
    // DROPS envelopes; it never edits one, so a filtered stream's frames are byte-identical to the
    // firehose's — with gaps in the ids, which is what seq-as-id means once a filter exists.
    `id: ${String(event.seq)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

  let roster: readonly number[] | undefined

  let closed = false
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const teardown = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    unsubscribe?.()
    deps.openStreams?.delete(teardown)
    // ONLY ONCE THE HEAD IS OUT. `subscribe` delivers the replay SYNCHRONOUSLY, so a run that
    // was already over reaches `runFinished` — and therefore this teardown — before `writeHead`
    // has run. Ending here would let Node send its own default 200 with no `Content-Type` and no
    // body, so a client asking for a finished run's whole log would get an empty, untyped 200.
    // The flush below the head handles that case, and this guard is what leaves it to it.
    if (open && !res.writableEnded) res.end()
  }

  try {
    unsubscribe = session.subscribe(fromSeq, (event) => {
      if (closed) return
      roster = roster ?? handleRosterOf(event)
      // THE FILTER, and the ONE call to it. `passesHandleFilter` is the schema's predicate over
      // the schema's total scope classification — this module states no opinion about which event
      // types belong to a member.
      if (parsedHandle.kind === 'handle' && !passesHandleFilter(event, parsedHandle.index)) return
      write(frameOf(event))
      // THE STREAM ENDS AT `runFinished`. The run's event log is complete at that point and the
      // bus closes behind it, so holding the socket open would deliver nothing but heartbeats.
      // What a reconnect after this means is 403's attach contract to decide. `runFinished` is
      // run-scoped, so it reaches every handle and this arm is filter-independent.
      if (event.type === 'runFinished') teardown()
    })
  } catch (error) {
    // THE FLOOR IS A NAMED REFUSAL, NOT A CRASH (403-03, D-13 · INVK-05). The bus refuses to serve
    // a prefix it cannot produce; this door refuses to hide that, and answers WHERE the replay
    // could have started so the caller can re-attach rather than retry the same request forever.
    // A gap the viewer is not told about is the one thing D-13 forbids by name.
    const floor = replayFloorOf(error)
    if (floor !== undefined) {
      refuseWithFloor(res, floor)
      return
    }
    refuse(res, 500, 'replay_unavailable')
    return
  }

  // On a deep resume the roster came from the peek above (or is unknowable), and the check has
  // already been made — re-running it here would refuse on the empty roster this walk derived.
  if (!isDeepResume && parsedHandle.kind === 'handle' && !(roster ?? []).includes(parsedHandle.index)) {
    // A well-formed handle no member of this run answers to — including every handle on a run
    // whose `runStarted` announced no roster at all. Nothing has been written yet, so this is
    // still a typed JSON refusal rather than a stream that quietly carries only run-scoped events
    // and looks like a member that did nothing.
    closed = true
    unsubscribe?.()
    refuse(res, 400, 'unknown_handle')
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })
  res.write(':ok\n\n')
  open = true
  for (const frame of pending) res.write(frame)
  pending.length = 0
  if (closed) {
    // The whole run was already in the replay: the head and every frame are out, so all that is
    // left is to close the socket the teardown above could not reach.
    if (!res.writableEnded) res.end()
    return
  }

  // D-15: A RESUME THAT LANDS PAST THE END CLOSES RATHER THAN HANGING.
  //
  // The arm above closes a stream that was SERVED `runFinished`. A resume whose point is at or past
  // the final seq is served nothing at all, so that arm never fires — and without this one the
  // socket would stay open on a finished run, heartbeating forever at a viewer whose run is over.
  //
  // `done` IS THE HONEST SIGNAL AND `status` IS NOT. The shell sets `status` to the aggregate
  // verdict at the `verdict` event, which is published BEFORE `runFinished` and before an awaited
  // handoff write — so a door that closed on a terminal `status` would truncate a stream in the
  // window between them, which is the silent gap this whole plan exists to refuse. `done` resolves
  // after `runFinished` is published and after `bus.close()`: it means nothing more will ever
  // arrive, which is exactly the fact this arm needs. A REJECTED `done` says the same thing about
  // a run that ended badly, so both settlements tear down.
  //
  // Harmless on a live stream: a run still running has an unsettled `done`, and a subscriber that
  // was served `runFinished` has already torn down (the teardown is idempotent).
  void Promise.resolve(session.done).then(teardown, teardown)

  heartbeat = setInterval(() => { res.write(':\n\n') }, HEARTBEAT_MS)
  deps.openStreams?.add(teardown)
  req.on('close', teardown)
}

export function createRunServiceRoutes(ports: RunServicePorts): RunServiceRouter {
  /** Every live stream's teardown, so a host can count them and a close removes exactly one. */
  const openStreams = new Set<() => void>()

  function handleStart(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      let raw: unknown
      try {
        raw = await readJsonBody<unknown>(req, MAX_REQUEST_BYTES)
      } catch {
        refuse(res, 400, 'invalid_request_body')
        return
      }
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        refuse(res, 400, 'invalid_request_body')
        return
      }
      const refused = refusedFieldsIn(raw as Record<string, unknown>)
      if (refused.length > 0) {
        // A caller may not choose the identity its run is addressed by.
        refuse(res, 400, 'refused_request_field')
        return
      }
      const parsed = RunServiceStartRequestSchema.safeParse(raw)
      if (!parsed.success) {
        refuse(res, 400, 'invalid_request_body')
        return
      }

      let ack: RunStartAcknowledgement
      try {
        ack = await ports.invokeRunStart(
          parsed.data.patterns === undefined ? {} : { patterns: parsed.data.patterns },
        )
      } catch {
        // Every rejection keeps its words to itself: a crash message is composed from this
        // process's own state and is not this caller's to read. The run's own diagnostics reach
        // whoever reads the run.
        refuse(res, 500, 'run_start_failed')
        return
      }
      // 202 rather than 200: an acknowledgment is a START, not an outcome. Every field of it came
      // off the durable record — the op raises `RunNotRecordedError` rather than fabricating one.
      respondJson(res, 202, ack)
    })()
  }

  function handleEvents(
    runIdParam: string,
    handleParam: string | null,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    let runId: string
    try {
      runId = decodeURIComponent(runIdParam)
    } catch {
      refuse(res, 404, 'unknown_run')
      return
    }
    serveRunEventStream(req, res, {
      runId,
      handleParam,
      // BOTH SOURCES, RESOLVED BY THE ONE PAIR. The local door in `routes.ts` calls the identical
      // two functions on the identical two inputs — that is what makes the parity corpus a claim
      // about one implementation rather than about two readers that agree today.
      resume: resumePointOf(req.headers['last-event-id'], lastEventIdParamOf(req)),
      attach: ports.attach,
      openStreams,
    })
  }

  /**
   * The MINT arm (403 D-03, Q3) — the remote twin of `routes.ts`'s `/api/runs/:runId/live-url`.
   *
   * IT DISPATCHES THROUGH THE PORT AND FORMATS NOTHING. The body is the port's result verbatim: a
   * second shaping here would be a second contract for what a `liveUrl` is, free to disagree with
   * the one the function layer published — and the two doors' parity corpus would then be
   * comparing two shapings rather than one result.
   *
   * THE REFUSALS ARE MAPPED BY ERROR NAME, never by matching a message. A message is prose and
   * prose gets rewritten; the same reading `routes.ts` does, so both doors answer the same word for
   * the same situation.
   *
   * THE RESULT IS NEVER LOGGED, HERE OR ANYWHERE ON THIS PATH (LIVE-02, T-403-02). The token rides
   * the URL fragment and this arm's only job is to put it on the wire the caller asked for.
   */
  function handleLiveUrl(
    runIdParam: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    let runId: string
    try {
      runId = decodeURIComponent(runIdParam)
    } catch {
      refuse(res, 404, 'unknown_run')
      return
    }
    // THE RAW `handle` PARAMETER THROUGH THE SAME READER THE STREAM USES. `url.searchParams` would
    // resolve `?handle=1&handle=2` to `1`, which is the one answer that reader exists to refuse —
    // and minting a viewing credential for a handle the caller did not unambiguously name is worse
    // than refusing to mint at all.
    const parsedHandle = parseHandleParam(handleParamOf(req))
    if (parsedHandle.kind === 'invalid') {
      refuse(res, 400, 'invalid_handle')
      return
    }
    const handle = parsedHandle.kind === 'absent' ? 0 : parsedHandle.index
    void ports.mintLiveUrl({ runId, handle }).then(
      (result) => { respondJson(res, 200, result) },
      (error: unknown) => {
        const name = typeof error === 'object' && error !== null
          ? (error as { name?: unknown }).name
          : undefined
        if (name === 'UnknownRunError') { refuse(res, 404, 'unknown_run'); return }
        if (name === 'LiveViewUnavailableError') {
          refuse(res, 503, 'live_view_unavailable')
          return
        }
        refuse(res, 500, 'live_url_mint_failed')
      },
    )
  }

  /**
   * The READ arms — the remote twins of `routes.ts`'s own.
   *
   * THEY CALL THE LOCAL DOOR'S ADAPTERS AND FORMAT NOTHING, on `handleLiveUrl`'s rule and for its
   * reason: a second shaping here would be a second contract for what a run's projection or an
   * artifact's headers ARE, and the parity corpus would then compare two shapings rather than one.
   *
   * AN UNCOMPOSED HOST IS 503 IN THE ADAPTERS' OWN VOCABULARY, not this door's closed error set.
   * These two rows serve a shape the closed `RunServiceErrorCode` set was never written for — a
   * whole projection, a PNG — so their refusals are the adapters' and are byte-identical to the
   * local door's. What the closed set still owns is everything a caller refused at the door can see,
   * and that is settled above the table, before either of these arms is reachable at all.
   */
  function handleAgentRead(
    req: IncomingMessage,
    res: ServerResponse,
    runIdParam: string,
    serve: (runId: string, host: AgentHost) => void,
  ): void {
    const host = ports.agentHost
    if (host === undefined) {
      respondJson(res, 503, { error: 'agent_host_unavailable' })
      return
    }
    let runId: string
    try {
      runId = decodeURIComponent(runIdParam)
    } catch {
      // An undecodable segment names no run, and the honest answer is the one the ops' own input
      // schemas give for an id they refuse — the local door's word, not a second one.
      respondJson(res, 400, { error: 'invalid_run_id' })
      return
    }
    serve(runId, host)
  }

  const router = ((req: IncomingMessage, res: ServerResponse): void => {
    try {
      const path = (req.url ?? '/').split('?')[0] ?? '/'

      // Every path this door owns passes the same-site and Host check, then the JSON media-type
      // check, before the route table.
      if (refuseCrossSiteRequest(req) !== undefined) {
        refuse(res, 403, 'cross_site_refused')
        return
      }
      if (carriesNonJsonBody(req)) {
        refuse(res, 415, 'unsupported_media_type')
        return
      }

      const matched = matchRunServiceRoute(req.method, path)
      if (matched === undefined) {
        refuse(res, 404, 'unknown_route')
        return
      }

      switch (matched.row.handler) {
        case 'start':
          handleStart(req, res)
          return
        case 'events':
          handleEvents(matched.params[0] ?? '', handleParamOf(req), req, res)
          return
        case 'liveUrl':
          handleLiveUrl(matched.params[0] ?? '', req, res)
          return
        case 'detail':
          handleAgentRead(req, res, matched.params[0] ?? '', (runId, host) => {
            serveRunDetailRead(req, res, { runId, host })
          })
          return
        case 'artifact':
          handleAgentRead(req, res, matched.params[0] ?? '', (runId, host) => {
            serveRunArtifact(req, res, { runId, sha: matched.params[1] ?? '', host })
          })
          return
        case 'evidence':
          handleAgentRead(req, res, matched.params[0] ?? '', (runId, host) => {
            serveRunEvidenceRead(req, res, { runId, host })
          })
          return
        case 'analysis':
          handleAgentRead(req, res, matched.params[0] ?? '', (runId, host) => {
            serveRunAnalysisRead(req, res, { runId, host })
          })
          return
        case 'marks':
          handleAgentRead(req, res, matched.params[0] ?? '', (runId, host) => {
            serveRunMarksHistoryRead(req, res, { runId, host })
          })
          return
        case 'markPreview':
          handleAgentRead(req, res, matched.params[0] ?? '', (runId, host) => {
            serveRunMarkPreviewRead(req, res, { runId, host })
          })
          return
        case 'ok':
          respondJson(res, 200, ports.readiness())
          return
      }
    } catch {
      // The door's LAST answer. Fixed bytes carrying no host value; once a stream's head is out the
      // only honest answer is to hang up, which `refuse` does.
      refuse(res, 500, 'run_start_failed')
    }
  }) as RunServiceRouter

  router.openStreamCount = () => openStreams.size
  return router
}
