// The run-detail READ route (Phase 405 plan 01, D-03).
//
// `GET /api/runs/:id/detail` is what the rebuilt run-detail page reads, and this module is the
// whole of the HTTP half: validate the id with the OP'S OWN input schema, dispatch through the
// injected host, map the op's named refusals onto status codes. It formats nothing. It opens no
// database. There is no SQLite read in `routes.ts` for this arm and there must never be one —
// that was the shipped v1 arrangement, and a private store read is a capability the function
// layer cannot see, cannot audit and cannot offer to the CLI, MCP or chat (D-03, the fourth-door
// law of 404 D-16).
//
// EVERY REFUSAL IS NAMED, on `post-processing-routes.ts`'s measured precedent. A page unable to
// distinguish an unrecorded run and a composition that binds no run-detail port renders one grey
// error for two completely different operator actions. Names are read STRUCTURALLY off
// `error.name` because this package may not import the packages that mint those classes
// (validate:arch), and comparing messages would be comparing against prose somebody will rewrite.

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  RunsArtifactInputSchema,
  RunsDetailInputSchema,
  RunsEvidenceInputSchema,
  RunsEvidenceResultSchema,
  RunsMarkInputSchema,
  RunsMarkPreviewResultSchema,
  RunsMarksHistoryInputSchema,
  RunsMarksHistoryResultSchema,
  type RunDetailProjection,
  type RunsArtifactInput,
  type RunsArtifactResult,
} from '@vostride/agent-qa-schema'

import type { AgentHost } from '../chat/host.js'
import { readJsonBody } from '../server/body-parser.js'

/** A refusal, already carrying its status and its single-key body. */
export interface RunDetailRefusal {
  readonly kind: 'refused'
  readonly status: number
  readonly body: Record<string, string>
}

export type RunDetailReadOutcome =
  | { readonly kind: 'ok'; readonly body: RunDetailProjection }
  | RunDetailRefusal

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
 * `FunctionNotBoundError` CARRIES ITS MESSAGE because that text tells an operator what to do —
 * which op this host does not bind. `RunNotFoundError` does NOT: it would echo the requested id
 * back into a response body, and a refusal that quotes untrusted input is a reflection this door
 * has no reason to offer. Anything else is an unclassified throw from inside the store, whose
 * message may name a path or quote a row; that one travels as a NAME, which is a classification
 * rather than a disclosure.
 *
 * EXPORTED SINCE 406-01 (D-04). `run-analysis-routes.ts` dispatches `analysisGetFunctionId` through
 * the same host and meets the same three refusals; a second spelling of `unknown_run` /
 * `agent_host_unavailable` / `read_failed` there would be a second vocabulary for one door, free to
 * drift the first time either side gains a class.
 */
export function refusalFor(error: unknown): RunDetailRefusal {
  const name = errorNameOf(error)
  if (name === 'RunNotFoundError') {
    return { kind: 'refused', status: 404, body: { error: 'unknown_run' } }
  }
  if (name === 'FunctionNotBoundError') {
    return {
      kind: 'refused',
      status: 503,
      body: { error: 'agent_host_unavailable', reason: errorMessageOf(error) },
    }
  }
  return { kind: 'refused', status: 500, body: { error: 'read_failed', reason: name } }
}

/**
 * THE READ. Exported so a cell can measure the outcome without a socket, and so any second door
 * (405-05's authed remote row) answers with byte-identical bytes by CALLING this rather than by a
 * second spelling that agrees today.
 */
export async function readRunDetail(
  host: AgentHost,
  runId: string,
): Promise<RunDetailReadOutcome> {
  // THE ID IS VALIDATED BY THE OP'S OWN INPUT SCHEMA, HERE, BEFORE THE DOOR IS TOUCHED
  // (T-405-01). Not a second regex: `runIdSchema` refuses exactly the ids the path layer would
  // have to REWRITE before using them, and the whole point of that codec is that there is one of
  // it. Refusing early also means an untrusted path segment never reaches a dispatch at all.
  const parsed = RunsDetailInputSchema.safeParse({ runId })
  if (!parsed.success) {
    return { kind: 'refused', status: 400, body: { error: 'invalid_run_id' } }
  }

  try {
    const projection = await host.invokeFunction(
      host.registry,
      host.runsDetailFunctionId,
      parsed.data,
      host.caller,
    ) as RunDetailProjection
    return { kind: 'ok', body: projection }
  } catch (error) {
    return refusalFor(error)
  }
}

/**
 * This door's JSON writer — and the ABSENCE of a cross-origin grant on it is load-bearing (405 CR-01).
 *
 * `serveRunDetailRead` answers a run's whole stored projection. `Content-Type` and `Content-Length`
 * are the whole header set on purpose: no `Access-Control-Allow-Origin`, because a page on another
 * origin that the operator happens to have open must not be able to read a run out of this
 * response. Until CR-01 that posture was
 * an accident of which writer this file inherited rather than a decision, and the sibling arms in
 * `server/routes.ts` — which answered through the wildcard-writing `json()` — proved how easily the
 * accident goes the other way. If a later refactor wants one JSON writer across both files, the one
 * it converges on must be the no-grant one.
 *
 * EXPORTED SINCE 406-01: `run-analysis-routes.ts` is that later refactor's first caller, and it
 * converged on this writer rather than minting a second one.
 */
export function respondJson(res: ServerResponse, status: number, data: unknown): void {
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

export interface RunDetailReadDeps {
  /** The DECODED run id. Decoding can throw, and that throw is the caller's refusal to answer. */
  readonly runId: string
  /** The injected host. Its absence is the ROUTER'S 503, not this function's. */
  readonly host: AgentHost
}

/** Parsed evidence only; raw artifacts never enter this path. */
export function serveRunEvidenceRead(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunDetailReadDeps,
): void {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  const entries: Array<[string, unknown]> = [['runId', deps.runId]]
  const seen = new Set(['runId'])
  for (const [key, value] of query) {
    if (seen.has(key)) {
      respondJson(res, 400, { error: 'invalid_evidence_input' })
      return
    }
    seen.add(key)
    if (key === 'testIndex' || key === 'stepIndex' || key === 'subActionIndex') {
      // Do not coerce blanks, fractions, exponents or signed values into a recorded index.
      entries.push([key, /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value])
    } else entries.push([key, value])
  }
  const parsed = RunsEvidenceInputSchema.safeParse(Object.fromEntries(entries))
  if (!parsed.success) {
    respondJson(res, 400, { error: 'invalid_evidence_input' })
    return
  }
  void deps.host.invokeFunction(deps.host.registry, deps.host.runsEvidenceFunctionId,
    parsed.data, deps.host.caller).then(result => {
    const body = RunsEvidenceResultSchema.parse(result)
    respondJson(res, 200, body)
  }).catch((error: unknown) => {
    const refusal = refusalFor(error)
    respondJson(res, refusal.status, refusal.body)
  })
}

/**
 * Answer one feedback read's typed result. Its outcomes, refusals included, are the op's result
 * and travel as 200; only thrown classes map to status codes. Every door answers the op's body as
 * stored.
 */
function respondFeedbackRead(
  res: ServerResponse,
  deps: RunDetailReadDeps,
  functionId: string,
  input: unknown,
  parse: (result: unknown) => unknown,
): void {
  void deps.host.invokeFunction(deps.host.registry, functionId, input, deps.host.caller).then(result => {
    const body = parse(result)
    respondJson(res, 200, body)
  }).catch((error: unknown) => {
    const refusal = refusalFor(error)
    respondJson(res, refusal.status, refusal.body)
  })
}

/** 2026-09-15, 423-21 D-18: `GET …/:runId/marks` — runs.marks.history on either door. */
export function serveRunMarksHistoryRead(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunDetailReadDeps,
): void {
  // The op's input is the run id alone; a query string is a second, unvalidated address.
  if (new URL(req.url ?? '/', 'http://localhost').search !== '') {
    respondJson(res, 400, { error: 'invalid_marks_input' })
    return
  }
  const parsed = RunsMarksHistoryInputSchema.safeParse({ runId: deps.runId })
  if (!parsed.success) {
    respondJson(res, 400, { error: 'invalid_run_id' })
    return
  }
  respondFeedbackRead(res, deps, deps.host.runsMarksHistoryFunctionId, parsed.data,
    result => RunsMarksHistoryResultSchema.parse(result))
}

/**
 * 2026-09-15, 423-21 D-18: `POST …/:runId/mark-preview` — runs.mark.preview on either door.
 *
 * POST carries the exact runs.mark input, but the op is read-tier: it plans and writes nothing, so
 * no confirm scope is accepted. The body's runId must name the URL's run, so a page cannot preview
 * one run under another run's address.
 */
export function serveRunMarkPreviewRead(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunDetailReadDeps,
): void {
  void readJsonBody<unknown>(req).then((body) => {
    const parsed = RunsMarkInputSchema.safeParse(body)
    if (!parsed.success) {
      respondJson(res, 400, { error: 'invalid_mark_preview_input' })
      return
    }
    if (parsed.data.runId !== deps.runId) {
      respondJson(res, 400, { error: 'run_id_mismatch' })
      return
    }
    respondFeedbackRead(res, deps, deps.host.runsMarkPreviewFunctionId, parsed.data,
      result => RunsMarkPreviewResultSchema.parse(result))
  }, () => { respondJson(res, 400, { error: 'invalid_mark_preview_input' }) })
}

/** `GET /api/runs/:id/detail` — what the rebuilt run-detail page reads (D-03). */
export function serveRunDetailRead(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunDetailReadDeps,
): void {
  void readRunDetail(deps.host, deps.runId).then(
    (outcome) => {
      if (outcome.kind === 'refused') {
        respondJson(res, outcome.status, outcome.body)
        return
      }
      respondJson(res, 200, outcome.body)
    },
    // The read classifies every refusal it can name; anything reaching here is this module
    // failing, which is a 500 by name and never a body that looks like an answer.
    (error: unknown) => { respondJson(res, 500, refusalFor(error).body) },
  )
}

// ---- 405-05 (D-12/D-13/D-15 · DETL-03): the ref-RESOLVING arm, on both doors ---------------------
//
// `GET /api/runs/:runId/artifacts/:sha` locally, `GET /run/:runId/artifacts/:sha` on the authed
// remote door, and BOTH call the one function below. The run-detail read hands a page a `sha`; this
// is where that sha becomes an image, and if the two doors resolved it through two implementations
// then "the same artifact" would mean two things depending on which credential asked.
//
// THE BYTES CROSS THE FUNCTION LAYER (D-13). This module constructs no store, joins no path and
// imports nothing that can read a file. Containment is `FsEvidenceArtifactStore`'s own rule —
// `slugBranch` over the runId, a 64-lowercase-hex check over the sha — reached through the op, so
// there is exactly one place in the product where a caller-supplied string becomes a path segment.
//
// THE SHA IS VALIDATED BY THE OP'S OWN INPUT SCHEMA, AND WHICH FIELD FAILED IS THE ANSWER. A
// malformed run id and a malformed sha are different mistakes a caller can fix, so the parse's
// failure paths are read apart rather than collapsed into one 400.
//
// NOTHING ECHOES THE REQUEST. Every refusal body is a fixed shape carrying a closed word; a body
// that quoted the sha would reflect attacker-chosen bytes back through a door that has no reason
// to offer one (T-405-18).

/** The immutable-caching header set a CONTENT ADDRESS earns (D-12). */
const ARTIFACT_CACHE_CONTROL = 'public, max-age=31536000, immutable'

export function parseSingleByteRange(header: string | undefined): RunsArtifactInput['range'] {
  const match = header === undefined ? null : /^bytes=(\d+)-(\d*)$/.exec(header)
  if (match === null) return undefined
  const start = Number(match[1])
  const end = match[2] === '' ? undefined : Number(match[2])
  if (!Number.isSafeInteger(start) ||
      (end !== undefined && (!Number.isSafeInteger(end) || end < start))) return undefined
  return { start, ...(end === undefined ? {} : { end }) }
}

export type RunArtifactReadOutcome =
  | {
    readonly kind: 'ok'
    readonly sha: string
    readonly contentType: string
    readonly bytes: Buffer
    readonly range?: RunsArtifactResult['range']
    readonly totalLength?: number
  }
  | { readonly kind: 'range-not-satisfiable'; readonly totalLength: number }
  | RunDetailRefusal

/**
 * The op's refusals, classified into this door's vocabulary.
 *
 * `EvidenceBlobAbsentError` AND `RunNotFoundError` ARE BOTH 404 AND THEY ARE NOT THE SAME 404
 * (D-15). One says the link names a run nothing recorded; the other says the run is right there and
 * holds no blob under that address — a screenshot the evidence diet collected, a ref that declared
 * itself incomplete, or an artifact never written. The page renders the second as a visible
 * "unavailable" state and the first as a broken link, and it can only do that because the words
 * differ. Neither body carries the sha.
 */
function artifactRefusalFor(error: unknown): RunDetailRefusal {
  const name = errorNameOf(error)
  if (name === 'RunNotFoundError') {
    return { kind: 'refused', status: 404, body: { error: 'unknown_run' } }
  }
  if (name === 'EvidenceBlobAbsentError') {
    return { kind: 'refused', status: 404, body: { error: 'blob_absent' } }
  }
  if (name === 'FunctionNotBoundError') {
    return {
      kind: 'refused',
      status: 503,
      body: { error: 'agent_host_unavailable', reason: errorMessageOf(error) },
    }
  }
  return { kind: 'refused', status: 500, body: { error: 'read_failed', reason: name } }
}

/**
 * THE READ. Exported so a cell can measure the outcome without a socket, and so the authed remote
 * door answers with byte-identical bytes by CALLING this rather than by a second spelling.
 */
export async function readRunArtifact(
  host: AgentHost,
  runId: string,
  sha: string,
  range?: RunsArtifactInput['range'],
): Promise<RunArtifactReadOutcome> {
  const parsed = RunsArtifactInputSchema.safeParse({ runId, sha })
  if (!parsed.success) {
    // WHICH FIELD, not merely THAT it failed. `runIdSchema` refuses exactly the ids the path layer
    // would have to rewrite, and the sha regex refuses everything that is not a content address;
    // telling a caller which of the two it got wrong costs one issue-path read and is the whole
    // difference between an actionable 400 and a shrug.
    const blamesSha = parsed.error.issues.some((issue) => issue.path[0] === 'sha')
    return {
      kind: 'refused',
      status: 400,
      body: { error: blamesSha ? 'malformed_sha' : 'invalid_run_id' },
    }
  }

  try {
    const result = await host.invokeFunction(
      host.registry,
      host.runsArtifactFunctionId,
      { ...parsed.data, ...(range === undefined ? {} : { range }) },
      host.caller,
    ) as RunsArtifactResult
    return {
      kind: 'ok',
      sha: result.sha,
      contentType: result.contentType,
      // The ONE decode in the product. The op encodes without a host API because its package may
      // not name one; this package may, and this is the layer whose job is bytes on a socket.
      bytes: Buffer.from(result.bytesBase64, 'base64'),
      ...(result.range === undefined ? {} : { range: result.range, totalLength: result.totalLength }),
    }
  } catch (error) {
    if (errorNameOf(error) === 'ArtifactRangeNotSatisfiableError') {
      const totalLength = (error as { totalLength?: unknown }).totalLength
      if (typeof totalLength === 'number' && Number.isSafeInteger(totalLength) && totalLength >= 0) {
        return { kind: 'range-not-satisfiable', totalLength }
      }
    }
    return artifactRefusalFor(error)
  }
}

export interface RunArtifactReadDeps {
  /** The DECODED run id. Decoding can throw, and that throw is the caller's refusal to answer. */
  readonly runId: string
  /** The RAW sha segment. Never decoded: a content address contains nothing percent-encoding
   * could represent, so a segment that needed decoding is already not one. */
  readonly sha: string
  /** The injected host. Its absence is the ROUTER'S 503, not this function's. */
  readonly host: AgentHost
}

/**
 * `GET /api/runs/:runId/artifacts/:sha` — a ref, resolved (D-12).
 *
 * THE HEADERS ARE THE FEATURE AS MUCH AS THE BYTES.
 * - `ETag: "<sha>"` — the content address IS the validator; there is nothing else it could be, and
 *   nothing that could make it stale, because bytes cannot change under a hash of themselves.
 * - `Cache-Control: public, max-age=31536000, immutable` — for the same reason. A revalidation of
 *   an immutable resource is a round trip that can only ever answer "yes, still".
 * - `X-Content-Type-Options: nosniff` — the second half of the T-405-15 mitigation. The op refuses
 *   to NAME a type a browser executes; this refuses to let the browser guess one anyway.
 * - `Content-Length` — from the op's own declared `byteLength` by way of the decoded buffer.
 *
 * `If-None-Match` IS HONOURED because it is three lines against a header set that promises a year
 * of caching, and a client that revalidates anyway should not be made to re-download a screenshot.
 */
export function serveRunArtifact(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunArtifactReadDeps,
): void {
  const revalidating = req.headers['if-none-match'] === `"${deps.sha}"`
  const range = revalidating ? undefined : parseSingleByteRange(req.headers.range)
  void readRunArtifact(deps.host, deps.runId, deps.sha, range).then(
    (outcome) => {
      if (outcome.kind === 'refused') {
        respondJson(res, outcome.status, outcome.body)
        return
      }
      if (res.headersSent || res.writableEnded) {
        res.destroy()
        return
      }
      const etag = `"${deps.sha}"`
      const headers = {
        ETag: etag,
        'Cache-Control': ARTIFACT_CACHE_CONTROL,
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
      }
      // THE VALIDATOR IS COMPARED WHOLE, against the quoted form this door writes. No weak-match
      // and no list parse: this door mints exactly one validator per resource and a request that
      // presents anything else has not seen this resource.
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers)
        res.end()
        return
      }
      if (outcome.kind === 'range-not-satisfiable') {
        res.writeHead(416, {
          ...headers,
          'Content-Range': `bytes */${outcome.totalLength}`,
          'Content-Length': 0,
        })
        res.end()
        return
      }
      res.writeHead(outcome.range === undefined ? 200 : 206, {
        ...headers,
        'Content-Type': outcome.contentType,
        'Content-Length': outcome.bytes.byteLength,
        ...(outcome.range === undefined ? {} : {
          'Content-Range': `bytes ${outcome.range.start}-${outcome.range.end}/${outcome.totalLength}`,
        }),
      })
      res.end(outcome.bytes)
    },
    // The read classifies every refusal it can name; anything reaching here is this module
    // failing, which is a 500 by name and never a body that looks like an answer.
    (error: unknown) => { respondJson(res, 500, artifactRefusalFor(error).body) },
  )
}
