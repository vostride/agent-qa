// The same-site guard stands above the route table, and frames are the bus envelope verbatim.

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
// Imported, so both doors answer the same bytes from one implementation.
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

// What starting a run needs, as data: the caller's pattern set and nothing about who the caller is.
export interface RunServiceStartInput {
  /** The pattern set the caller asked for; absent means the configured default set. */
  readonly patterns?: readonly string[]
}

// Injected, because the implementations name vocabulary this package may not import.
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
  /** The measured readiness facts `/ok` reports. */
  readiness(): RunServiceReadiness
  // Required, so a forgotten mint is a 503 `live_view_unavailable`, not a 404 like a missing route.
  mintLiveUrl(input: MintLiveUrlInput): Promise<RunsLiveUrlResult>
  // Optional: a host with no registry answers 503 `agent_host_unavailable`, as the local door does.
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
  // The read rows sit inside the table, so the guard above it applies to them by construction.
  | 'detail'
  | 'evidence'
  | 'artifact'
  // The failure view's read; the local door mounts the same adapter, so clients parse one path.
  | 'analysis'
  // The two feedback reads, masked on this door like the rows above.
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
// The remote half of `GET /api/runs/:runId/live-url`; the two doors differ only in path.
export const RUN_SERVICE_LIVE_URL_TEMPLATE = '/run/:runId/live-url'
const RUN_SERVICE_LIVE_URL_PATTERN = /^\/run\/([^/]+)\/live-url$/
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
// The sha is not decoded: a content address has no percent-encoded spelling.
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
/** runs.marks.history and runs.mark.preview behind the same guard. */
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
 * A host consults this before its own routing, so every request to a service path, `OPTIONS` and
 * methods this table has no row for included, gets this router's same-site and media-type checks
 * rather than the host's page arms.
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

// Repeated values are joined, so `?handle=1&handle=2` cannot parse; `searchParams` would answer 1.
export function handleParamOf(req: IncomingMessage): string | null {
  const query = (req.url ?? '').split('?').slice(1).join('?')
  if (query === '') return null
  const values = new URLSearchParams(query).getAll('handle')
  if (values.length === 0) return null
  if (values.length === 1) return values[0] ?? null
  return values.join(',')
}

// Read off the raw query like `handle`, so a repeated `lastEventId` is refused, not read as one.
export function lastEventIdParamOf(req: IncomingMessage): string | null {
  const query = (req.url ?? '').split('?').slice(1).join('?')
  if (query === '') return null
  const values = new URLSearchParams(query).getAll('lastEventId')
  if (values.length === 0) return null
  if (values.length === 1) return values[0] ?? null
  return values.join(',')
}

// No arm restarts an unparseable resume at seq 1 or the floor: that duplicates or hides envelopes.
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

// A key test, so `{"runId": null}` is refused too; the answer says which kind of refusal it is.
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
  // Resolved by the caller, because it is read from a header and a query; absent means `start`.
  readonly resume?: ResumePoint
  /** The started run's session, or nothing if this process never started that run. */
  attach(runId: string): RunSession | undefined
  /** Live teardowns, so a host can count open streams and a close removes exactly one. */
  readonly openStreams?: {
    add(teardown: () => void): void
    delete(teardown: () => void): void
  }
}

// Both doors call this one function, and every refusal precedes `writeHead`.
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

  // A deep resume peeks seq 1 `runStarted` for the roster; at the floor, only the filter runs.
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
    // The filter drops envelopes and never edits one, so filtered frames match the firehose bytes.
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
      // The stream ends at `runFinished`, which is run-scoped, so it reaches every handle.
      if (event.type === 'runFinished') teardown()
    })
  } catch (error) {
    // The floor is a named refusal saying where replay could start, so the caller re-attaches.
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

  // A resume past the final seq is served nothing, so `done`, not `status`, closes it.
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

  // The body is the port's result verbatim, refusals map by error name, and it is never logged.
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
