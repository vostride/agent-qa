// This module formats nothing and opens no database; refusals are read off `error.name`.

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

// `FunctionNotBoundError` keeps its message; `RunNotFoundError` would echo the id; others by name.
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

// Exported so a cell can measure the outcome without a socket, and both doors call this one read.
export async function readRunDetail(
  host: AgentHost,
  runId: string,
): Promise<RunDetailReadOutcome> {
  // The op's own input schema refuses a bad id before any dispatch; there is one run id codec.
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
 * This door's JSON writer, which `run-analysis-routes.ts` shares. It writes only Content-Type and
 * Content-Length; no dashboard answer carries a cross-origin grant, so a page on another origin
 * cannot read a run's stored projection out of `serveRunDetailRead`'s response.
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

/** `GET …/:runId/marks` — runs.marks.history on either door. */
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

// The op is read-tier; the body's `runId` must name the URL's run.
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

/** `GET /api/runs/:id/detail` — what the rebuilt run-detail page reads. */
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

// Containment is the evidence store's own rule, reached through the op; no refusal echoes the sha.

// The immutable-caching header set a content address earns.
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

// Both are 404 with different words: an unrecorded run, or a run with no blob at that address.
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

// The content address is the `ETag`, so caching is immutable and `If-None-Match` is honoured.
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
