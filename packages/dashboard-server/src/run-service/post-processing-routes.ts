// Every fact on the wire is a re-read through the injected host; envelopes are only triggers.

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

// Exported so a cell can name the interval rather than sleep past it, and clients can size to it.
export const POST_PROCESSING_STREAM_HEARTBEAT_MS = 15_000

// Not a bus event type, so a client switching on the name never confuses the snapshot with a chip.
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
  // The op's own input schema refuses a bad id before any dispatch; there is one run id codec.
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

// Every refusal precedes `writeHead`; a terminal, handed-off or detached chain gets a 204.
export function servePostProcessingStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PostProcessingStreamDeps,
): void {
  // Assigned before the head goes out, so a later throw unwinds the heartbeat and relay.
  let unwindStream: (() => void) | undefined

  // An unhandled rejection here is process-fatal; after headers the only close is `destroy()`.
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

    // Both arms follow the same two awaited op calls, so both guard an already-answered response.
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
      // The id is the seq, the event is the envelope type, the data its JSON, as on the run stream.
      res.write(
        `id: ${String(envelope.seq)}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`,
      )
      if (!STAGE_SETTLING_EVENTS.has(envelope.type)) return
      // Whether the chain is over is a fact about durable rows, so the door re-reads it.
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
      // A throw from the arm above is a dead socket, and `.then`'s failure arm never sees it.
      ).catch(failStream)
    })

    heartbeat = setInterval(() => { res.write(':\n\n') }, POST_PROCESSING_STREAM_HEARTBEAT_MS)
    deps.openStreams?.add(teardown)
    req.on('close', teardown)
    // `.then`'s second argument takes the read's rejection; the `.catch` takes `onOk`'s throw.
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
