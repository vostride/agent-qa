// The post-processing READ route and its dedicated live channel (Phase 404 plan 05,
// D-16/D-17/D-18/D-22/D-23 · LIFE-03/LIFE-04).
//
// TWO DOORS ONTO ONE ANSWER, AND THE ANSWER IS ALWAYS A RE-READ. `GET /api/runs/:id/post-processing`
// is what a page polls; `…/post-processing/stream` opens with the SAME body as a `snapshot` frame
// and then relays chip envelopes as they are appended. The envelopes are TRIGGERS: a
// consumer that derived a chip from one would be a second projection of chip truth, free to
// disagree with `runs.postprocessing` over the durable rows — which is the one thing 388 D-14 and
// 404 D-16 rule out by name. Nothing in this file reads a job store, opens `agent-jobs.db` or
// composes a chip; every fact on the wire arrived through the injected host's one door.
//
// WHY THE READ JOINS TWO RECORDS. The chain's chips live in the durable job store and are read
// through `runs.postprocessing`. The run's POSTURE — `drained` / `handedOff` / `detached`, i.e. who
// was going to pump that chain — is a decision made at the verdict and written on the
// `runFinished` line of the run's own event log, and the last per-stage failure TEXT rides the chip
// envelopes on that same log (404-03 D-21: the durable notification row deliberately carries no
// failure prose). So the read invokes `runs.events` as well and folds the record. That fold is
// STRICTLY A FORWARD: a failed stage whose log holds no `*Failed` envelope — a daemon-drained run,
// or one drained after this process last saw it — gets NO `failures` entry, because the record
// declined to say and this route does not compose prose on the record's behalf.
//
// EVERY REFUSAL IS NAMED. The alternative that actually shipped in surfaces like this one is
// an all-pending body: a page that cannot tell "the chain has not started" from "the composition
// bound no such op" renders two grey chips forever and calls it a state. So an unbound function, a
// job store stamped by another build, an id the op refuses and a missing host each have their own
// word, and the words are read STRUCTURALLY off `error.name` — this package may not import the
// packages that mint those classes (validate:arch), and a message compare would be a compare
// against prose somebody will rewrite.

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  RunsPostProcessingInputSchema,
  type ChipEventPayload,
  type PostProcessingDisposition,
  type PostProcessingStatus,
  type RunEventEnvelope,
  type RunFinishedPayload,
} from '@vostride/agent-qa-schema'

import type { AgentHost } from '../chat/host.js'
import type { PostProcessingRelay } from '../execution/post-processing-relay.js'

/**
 * The comment-frame keepalive interval, matching every other SSE this package serves.
 *
 * EXPORTED so a cell can name the number rather than sleep past it, and so the client
 * can size its own liveness expectation off the server's constant instead of a second guess.
 */
export const POST_PROCESSING_STREAM_HEARTBEAT_MS = 15_000

/**
 * The SSE event name the joined read travels under.
 *
 * DELIBERATELY NOT A BUS EVENT TYPE. Every other frame on this stream is an envelope
 * whose `event:` is its own `type`, so the one frame that is NOT an envelope must be unmistakable:
 * a client switching on the frame name can never confuse the whole-state answer with a chip tick.
 */
const SNAPSHOT_EVENT = 'snapshot'

/** The last failure the record holds for one stage — the emitter's masked, bounded text, forwarded. */
export interface PostProcessingStageFailure {
  readonly error?: string
  readonly willRetry?: boolean
}

/** What both doors answer with: the op result, plus what the run's own record says about it. */
export interface PostProcessingReadBody {
  /** The `runs.postprocessing` result, VERBATIM. A reshaping here would be a second contract. */
  readonly status: PostProcessingStatus
  /** The `runFinished` posture, when the record has one. Absent while the run is still in flight. */
  readonly disposition?: PostProcessingDisposition
  /**
   * The last `analysisFailed` / `curationFailed` payload per stage.
   *
   * PRESENT AND POSSIBLY EMPTY when the record was read; ABSENT ENTIRELY when the events read
   * refused. The difference is a fact a client can act on — "this run wrote no failure line" is not
   * the same claim as "this door could not read the log".
   */
  readonly failures?: {
    readonly analysis?: PostProcessingStageFailure
    readonly curation?: PostProcessingStageFailure
  }
}

/** A refusal, already carrying its status and its single-key body. */
interface PostProcessingRefusal {
  readonly kind: 'refused'
  readonly status: number
  readonly body: Record<string, string>
}

type PostProcessingReadOutcome =
  | { readonly kind: 'ok'; readonly body: PostProcessingReadBody }
  | PostProcessingRefusal

/**
 * Has this chain finished, whatever became of it?
 *
 * TWO CLAUSES BECAUSE THERE ARE TWO TERMINALS AND THE ROW OUTRANKS THE CHIPS. A chain that wrote
 * its one `RunNotification` is over by definition — that row IS the chain's terminal receipt — and
 * a projection that disagreed with it would be a chain that ended twice. Absent the row, both chips
 * having settled (`complete` or `failed`, the only two settled words in the four-word vocabulary) is
 * the same fact read one layer down.
 */
export function isPostProcessingTerminal(status: PostProcessingStatus): boolean {
  if (status.notification !== undefined) return true
  const settled = (chip: PostProcessingStatus['chips']['analysis']): boolean =>
    chip === 'complete' || chip === 'failed'
  return settled(status.chips.analysis) && settled(status.chips.curation)
}

/** The name a rejection carries, read structurally — never by class, never by message. */
function errorNameOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UnknownError'
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' && name.length > 0 ? name : 'UnknownError'
}

function errorMessageOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
}

/**
 * The op's refusals, classified into this door's vocabulary.
 *
 * THE TWO NAMED ARMS CARRY THEIR MESSAGE AND THE FALLBACK CARRIES ONLY THE NAME, and the asymmetry
 * is the point. `FunctionNotBoundError` and `JobStoreSchemaVersionError` are both minted with text
 * that tells an operator what to DO — which op was not bound, that the queue database must be
 * cleared — and withholding it would leave a 503 nobody can act on. Anything else is an unclassified
 * throw from somewhere inside the store, whose message is arbitrary prose that may name a path or
 * quote a row; that one travels as a NAME, which is a classification rather than a disclosure.
 */
function refusalFor(error: unknown): PostProcessingRefusal {
  const name = errorNameOf(error)
  if (name === 'FunctionNotBoundError') {
    return { kind: 'refused', status: 503, body: { error: 'function_not_bound', reason: errorMessageOf(error) } }
  }
  if (name === 'JobStoreSchemaVersionError') {
    return { kind: 'refused', status: 503, body: { error: 'job_store_schema_version', reason: errorMessageOf(error) } }
  }
  return { kind: 'refused', status: 500, body: { error: 'post_processing_unavailable', reason: name } }
}

/** What the record says, folded out of one drain of the events stream. */
interface RecordFold {
  readonly disposition?: PostProcessingDisposition
  readonly failures: {
    analysis?: PostProcessingStageFailure
    curation?: PostProcessingStageFailure
  }
}

function stageFailureOf(payload: ChipEventPayload): PostProcessingStageFailure {
  return {
    ...(payload.error === undefined ? {} : { error: payload.error }),
    ...(payload.willRetry === undefined ? {} : { willRetry: payload.willRetry }),
  }
}

/**
 * Drain the whole recorded log once and keep the two facts the chips cannot carry.
 *
 * THE LAST ENVELOPE PER STAGE WINS, deliberately: a stage that failed, was retried and failed again
 * has two lines, and the honest answer to "why is this chip red" is the reason it is red NOW. The
 * whole iterable is consumed rather than stopped early — abandoning a stream mid-delivery is a side
 * effect on a producer this route does not own, and the recorded log of one run is bounded.
 */
async function foldRecord(events: AsyncIterable<RunEventEnvelope>): Promise<RecordFold> {
  const failures: RecordFold['failures'] = {}
  let disposition: PostProcessingDisposition | undefined
  for await (const envelope of events) {
    if (envelope.type === 'runFinished') {
      disposition = (envelope.payload as RunFinishedPayload).disposition
      continue
    }
    if (envelope.type === 'analysisFailed') {
      failures.analysis = stageFailureOf(envelope.payload as ChipEventPayload)
      continue
    }
    if (envelope.type === 'curationFailed') {
      failures.curation = stageFailureOf(envelope.payload as ChipEventPayload)
    }
  }
  return { ...(disposition === undefined ? {} : { disposition }), failures }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<RunEventEnvelope> {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as AsyncIterable<RunEventEnvelope>)[Symbol.asyncIterator] === 'function'
  )
}

/**
 * THE JOINED READ — the one place chip truth and run posture are put beside each other.
 *
 * Exported so the stream door and the read door answer with byte-identical bodies by CALLING one
 * function rather than by two spellings that agree today. `routes.post-processing-stream.test.ts`
 * compares the snapshot frame against the read route's body for exactly that reason.
 */
export async function readPostProcessing(
  host: AgentHost,
  runId: string,
): Promise<PostProcessingReadOutcome> {
  // THE ID IS VALIDATED BY THE OP'S OWN INPUT SCHEMA, HERE, BEFORE THE DOOR IS TOUCHED.
  // Not a second regex: `runIdSchema` refuses exactly the ids the path layer would have to REWRITE
  // before using them as a directory name, and the whole point of that codec is that there is one
  // of it. Refusing early also means an untrusted path segment never reaches a dispatch at all.
  const parsed = RunsPostProcessingInputSchema.safeParse({ runId })
  if (!parsed.success) {
    return { kind: 'refused', status: 400, body: { error: 'invalid_run_id' } }
  }

  let status: PostProcessingStatus
  try {
    status = await host.invokeFunction(
      host.registry,
      host.runsPostProcessingFunctionId,
      parsed.data,
      host.caller,
    ) as PostProcessingStatus
  } catch (error) {
    return refusalFor(error)
  }

  // THE RECORD IS THE WEAKER OF THE TWO SOURCES AND DEGRADES ALONE. A run whose log fell out of the
  // replay window, or whose events op is unbound, still has durable chip truth — and a route that
  // 500ed on the log would hide the answer it already has in hand. Both joined fields go absent
  // together, which is what tells a client the record was not read rather than that it was empty.
  try {
    const events = await host.invokeFunction(
      host.registry,
      host.runsEventsFunctionId,
      { runId: parsed.data.runId },
      host.caller,
    )
    if (!isAsyncIterable(events)) return { kind: 'ok', body: { status } }
    const record = await foldRecord(events)
    return {
      kind: 'ok',
      body: {
        status,
        ...(record.disposition === undefined ? {} : { disposition: record.disposition }),
        failures: record.failures,
      },
    }
  } catch {
    return { kind: 'ok', body: { status } }
  }
}

function respondJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent || res.writableEnded) {
    res.destroy()
    return
  }
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export interface PostProcessingReadDeps {
  /** The DECODED run id. Decoding can throw, and that throw is the caller's refusal to answer. */
  readonly runId: string
  /** The injected host. Its absence is the ROUTER'S 503, not this function's. */
  readonly host: AgentHost
}

/** `GET /api/runs/:id/post-processing` — what the page polls. */
export function servePostProcessingRead(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: PostProcessingReadDeps,
): void {
  void readPostProcessing(deps.host, deps.runId).then(
    (outcome) => {
      if (outcome.kind === 'refused') {
        respondJson(res, outcome.status, outcome.body)
        return
      }
      respondJson(res, 200, outcome.body)
    },
    // The read swallows what it can degrade past; anything reaching here is this module failing,
    // which is a 500 by name and never a body that looks like an answer.
    (error: unknown) => { respondJson(res, 500, refusalFor(error).body) },
  )
}

export interface PostProcessingStreamDeps extends PostProcessingReadDeps {
  /** The in-process chip sink this browser's frames come from. */
  readonly relay: PostProcessingRelay
  /** Live teardowns, so a host can count open streams and a close removes exactly one. */
  readonly openStreams?: {
    add(teardown: () => void): void
    delete(teardown: () => void): void
  }
}

/**
 * `GET /api/runs/:id/post-processing/stream` — the DEDICATED live channel.
 *
 * THE ORDER IS THE CONTRACT, on `serveRunEventStream`'s own law: every refusal happens before
 * `writeHead`, because a response that has already written `200 text/event-stream` cannot be told
 * it failed. So the joined read runs FIRST — it is the snapshot's content and the open-time
 * decision both — and only then does a head go out.
 *
 * THE 204 IS THE SSE SPEC'S NO-RECONNECT CLOSE, and it is the whole answer to Pitfall 6. An
 * `EventSource` reconnects after ANY close except a 204, so a door that answered `200` with an
 * immediate end to a run whose chain is over would be answering the same request every few seconds
 * for as long as the tab is open. Three states get it:
 *
 *   - the chain is already terminal — there is nothing left to relay, ever;
 *   - the run says `handedOff` — a lease-holder in ANOTHER process is draining it, and this
 *     process's emitter will therefore never publish a single envelope for it;
 *   - the run says `detached` — nothing is draining it in-process either.
 *
 * The last two are D-16's "closes immediately on hand-off / detach" and they are one decision with
 * two words, because the fact that matters is identical: this relay cannot ever fire for that run,
 * so the honest channel is the page's poll and holding a socket open would be a promise this
 * process cannot keep. A snapshot with NO disposition at all is the opposite case — the run has not
 * reached `runFinished` yet, which is exactly when a live channel is worth having — and it opens.
 */
export function servePostProcessingStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PostProcessingStreamDeps,
): void {
  /**
   * The half-built stream's resource release, hoisted so the failure arm can unwind it.
   *
   * Assigned in the same breath the stream's state is declared and BEFORE the head goes out, so a
   * throw anywhere from `writeHead(200)` onwards is unwound rather than abandoned: without it a
   * failure between the head and `req.on('close', …)` leaves the 15s heartbeat ticking, the relay
   * subscription registered and this stream's teardown inside `openStreams`, behind a socket
   * nothing will ever close. It releases resources and TOUCHES THE RESPONSE NOT AT ALL — ending it
   * here would answer an empty 200 to a request the arm below still owes a refusal.
   */
  let unwindStream: (() => void) | undefined

  /**
   * THE ARM UF-01 NAMED, and the sibling read door at `servePostProcessingRead` already carries.
   *
   * `void promise.then(onOk)` with no failure arm turns any throw inside `onOk` into an unhandled
   * rejection — process-fatal by default on Node ≥ 15, so one closed tab takes the whole dashboard
   * server down with it. The throw is ordinary rather than exotic: two awaited op calls sit between
   * the request arriving and the head going out, and a client that aborts inside that window leaves
   * a response a later `writeHead`/`write` throws on.
   *
   * IT ANSWERS THE SAME FAILURE SHAPE THE SIBLING DOOR ANSWERS WITH, for the same reason — anything
   * reaching here is this module failing, and `refusalFor`'s unclassified arm travels as a NAME and
   * never a message, because an arbitrary throw's prose may quote a path or a row.
   *
   * AND IT LEAVES NOTHING HALF-OPEN. A response already carrying `200 text/event-stream` cannot be
   * told it failed, so once headers are out the only honest close is `destroy()`; before they are
   * out the request still gets its named refusal.
   */
  const failStream = (error: unknown): void => {
    try {
      unwindStream?.()
    } catch {
      // An unwind that throws may not become the second rejection this arm exists to prevent —
      // and the request below is still owed an answer.
    }
    try {
      if (res.headersSent || res.writableEnded) {
        res.destroy()
        return
      }
      respondJson(res, 500, refusalFor(error).body)
    } catch {
      try {
        res.destroy()
      } catch {
        // The socket is already past answering. There is nothing left to do and nothing left to
        // throw at: this function is the end of the chain.
      }
    }
  }

  void readPostProcessing(deps.host, deps.runId).then((outcome) => {
    if (outcome.kind === 'refused') {
      respondJson(res, outcome.status, outcome.body)
      return
    }
    const snapshot = outcome.body
    if (
      isPostProcessingTerminal(snapshot.status)
      || snapshot.disposition === 'handedOff'
      || snapshot.disposition === 'detached'
    ) {
      if (res.headersSent || res.writableEnded) {
        res.destroy()
        return
      }
      res.writeHead(204, { 'Cache-Control': 'no-cache' })
      res.end()
      return
    }

    // THE SAME GUARD THE 204 ARM ABOVE CARRIES, on the arm that OPENS a socket rather than closing
    // one. The asymmetry was the bug: both arms are reached after the same two awaited op
    // calls, so both face the same already-answered response — and `writeHead` on one throws
    // `ERR_HTTP_HEADERS_SENT`, which is the throw that became the process-fatal rejection. Guarded
    // before any state is built, so this leg registers nothing it would then have to unwind.
    if (res.headersSent || res.writableEnded) {
      res.destroy()
      return
    }

    let closed = false
    let unsubscribe: (() => void) | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    // What `teardown` releases, with no opinion about the response — the failure arm needs exactly
    // this half, because it decides `destroy()` vs a named refusal for itself.
    const releaseStream = (): void => {
      if (closed) return
      closed = true
      if (heartbeat !== undefined) clearInterval(heartbeat)
      unsubscribe?.()
      deps.openStreams?.delete(teardown)
    }
    const teardown = (): void => {
      if (closed) return
      releaseStream()
      if (!res.writableEnded) res.end()
    }
    unwindStream = releaseStream

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    // THE SNAPSHOT IS THE FIRST FRAME AND IT IS THE WHOLE ANSWER. A stream that opened with nothing
    // would leave the page holding whatever it last polled, for as long as no chip moved — which on
    // a chain between stages is minutes.
    res.write(`event: ${SNAPSHOT_EVENT}\ndata: ${JSON.stringify(snapshot)}\n\n`)

    unsubscribe = deps.relay.subscribe(deps.runId, (envelope: RunEventEnvelope) => {
      if (closed) return
      // D-13's three parts, exactly as the run stream frames them: the id IS the seq, the event
      // name IS the envelope type, and the data IS the envelope's own JSON. No projection and no
      // second vocabulary — a client that can read one of this product's streams can read both.
      res.write(
        `id: ${String(envelope.seq)}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`,
      )
      if (!STAGE_SETTLING_EVENTS.has(envelope.type)) return
      // THE TRIGGER, ANSWERED BY A RE-READ. The envelope says a stage settled; whether the
      // CHAIN is over is a fact about durable rows, and this door asks the op rather than deriving
      // it from the tick it just wrote.
      void readPostProcessing(deps.host, deps.runId).then(
        (again) => {
          if (closed || again.kind !== 'ok') return
          if (!isPostProcessingTerminal(again.body.status)) return
          res.write(`event: ${SNAPSHOT_EVENT}\ndata: ${JSON.stringify(again.body)}\n\n`)
          teardown()
        },
        // A failed re-read is not a reason to close a live channel: the next envelope will trigger
        // another, and the page's own poll is the floor underneath both.
        () => undefined,
      // …but a throw from the arm ABOVE is not a failed re-read, it is a dead socket, and `.then`'s
      // failure arm never sees its own fulfilment arm's throw (UF-01, on the nested chain).
      ).catch(failStream)
    })

    heartbeat = setInterval(() => { res.write(':\n\n') }, POST_PROCESSING_STREAM_HEARTBEAT_MS)
    deps.openStreams?.add(teardown)
    req.on('close', teardown)
    // THE SECOND ARGUMENT is the READ's own rejection — `readPostProcessing` swallows what it can
    // degrade past, so anything arriving there is this module failing. THE TRAILING `.catch` is the
    // FULFILMENT ARM'S OWN THROW, and it is a separate arm because `.then(onOk, onError)` answers
    // only for the promise it is attached to: a throw inside `onOk` rejects the DERIVED promise,
    // which `void` would strand as the process-fatal unhandled rejection UF-01 named.
  }, failStream).catch(failStream)
}

/**
 * The four envelope types that can move a chain to its terminal.
 *
 * `*Started` is excluded because a stage starting can never end a chain, and a re-read per tick
 * would double this door's op traffic to learn nothing. The set is spelled from the bus vocabulary
 * rather than derived by string surgery on the type name — a `curationCancelled` minted later would
 * be silently included by a `.endsWith('ed')` rule and silently excluded by this one, and being
 * excluded from a re-read is the safe direction (the page still polls).
 */
const STAGE_SETTLING_EVENTS = new Set<RunEventEnvelope['type']>([
  'analysisCompleted',
  'analysisFailed',
  'curationCompleted',
  'curationFailed',
])
