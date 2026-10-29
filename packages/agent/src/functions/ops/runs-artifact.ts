// The sniffer has no markup arm, so a blob can never pick a type the browser executes.

import { RunsArtifactInputSchema, RunsArtifactResultSchema } from '@vostride/agent-qa-schema'
import type { RunsArtifactInput, RunsArtifactResult } from '@vostride/agent-qa-schema'

import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionSpec } from '../spec.js'
import { RunNotFoundError } from './runs-get.js'

/**
 * All lowercase and two segments, because the id taxonomy is pinned as `/^[a-z]+(?:\.[a-z]+)+$/` —
 * `runs.artifactBlob` is not a spelling this catalogue admits. The exported constant is what the
 * dashboard composition hands its server as DATA; `packages/dashboard-server` may not import this
 * package, so the literal appears here once.
 */
export const RUNS_ARTIFACT_FUNCTION_ID = 'runs.artifact'

// Separate from `RunNotFoundError`: the run exists, and the page shows the artifact unavailable.
export class EvidenceBlobAbsentError extends Error {
  constructor(
    readonly runId: string,
    readonly sha: string,
  ) {
    super(`No evidence blob is recorded for run ${runId} under that content address`)
    this.name = 'EvidenceBlobAbsentError'
  }
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** The PNG signature, whole. A prefix of it is not a PNG and must not be typed as one. */
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47]
/** The JFIF/EXIF start-of-image marker plus its first marker byte. */
const JPEG_SIGNATURE: readonly number[] = [0xff, 0xd8, 0xff]
const WEBM_SIGNATURE: readonly number[] = [0x1a, 0x45, 0xdf, 0xa3]
const MP4_FTYP_SIGNATURE: readonly number[] = [0x66, 0x74, 0x79, 0x70]

export const ARTIFACT_RANGE_MAX_BYTES = 1048576
export const EVIDENCE_SNIFF_HEAD_BYTES = 12

export class ArtifactRangeNotSatisfiableError extends Error {
  constructor(readonly totalLength: number) {
    super('Artifact range starts beyond the available bytes')
    this.name = 'ArtifactRangeNotSatisfiableError'
  }
}

/** The type a blob gets when nothing recognises it — opaque, and never rendered as a document. */
export const OPAQUE_EVIDENCE_CONTENT_TYPE = 'application/octet-stream'

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < signature.length + offset) return false
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i + offset] !== signature[i]) return false
  }
  return true
}

// SVG and HTML serve as `application/octet-stream`, which with `nosniff` is a download.
export function sniffEvidenceContentType(bytes: Uint8Array): string {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg'
  if (startsWith(bytes, WEBM_SIGNATURE)) return 'video/webm'
  if (startsWith(bytes, MP4_FTYP_SIGNATURE, 4)) return 'video/mp4'
  return OPAQUE_EVIDENCE_CONTENT_TYPE
}

/**
 * Standard base64 over raw bytes, hand-rolled.
 *
 * `packages/agent` is storageNeutral and names no host API, so `Buffer.from(bytes).toString(
 * 'base64')` is unavailable here by the same rule that makes `live-url.ts` hand-roll base64url.
 * Padded with `=` because the adapter decodes with the platform's own reader, which expects it.
 */
function encodeBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const hasB = i + 1 < bytes.length
    const hasC = i + 2 < bytes.length
    const b = hasB ? bytes[i + 1] ?? 0 : 0
    const c = hasC ? bytes[i + 2] ?? 0 : 0
    out += BASE64_ALPHABET[a >> 2]
    out += BASE64_ALPHABET[((a & 0x03) << 4) | (b >> 4)]
    out += hasB ? BASE64_ALPHABET[((b & 0x0f) << 2) | (c >> 6)] : '='
    out += hasC ? BASE64_ALPHABET[c & 0x3f] : '='
  }
  return out
}

export const runsArtifactSpec: FunctionSpec<RunsArtifactInput, RunsArtifactResult> = {
  id: RUNS_ARTIFACT_FUNCTION_ID,
  summary: "Read one run's content-addressed evidence blob by its sha, with a sniffed content type.",
  resultKind: 'unary',
  // Bound exactly where a composition owns a runtime root (every local host does). A host that
  // holds no run directories lists this by name as `unbound` rather than answering `blob_absent`
  // about every artifact in the product, which would look like a storage failure.
  boundThrough: 'evidenceBlobs',
  input: RunsArtifactInputSchema,
  output: RunsArtifactResultSchema,
  risk: { name: `fn:${RUNS_ARTIFACT_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * The type and the size, which are what a receipt can honestly say about serving bytes.
   *
   * NOT THE BYTES AND NOT THE BASE64. An audit row that quoted the payload would be the blob
   * written a second time, into the one record that is kept forever — and receipts are read by
   * people, in terminals.
   */
  classify(output): ClauseVerdict {
    // `byteLength` is declared, so the fold never reads its own payload.
    return {
      status: 'executed',
      outcome: `${output.contentType}, ${String(output.byteLength)} bytes for ${output.runId}`,
    }
  },
  async invoke(input, deps) {
    // Reached with no port only by an in-layer caller; the refusal is the same named error.
    const port = deps.evidenceBlobs
    if (port === undefined) {
      throw new FunctionNotBoundError(RUNS_ARTIFACT_FUNCTION_ID)
    }

    const runId = String(input.runId)
    if (input.range !== undefined) {
      const assertFound = <T extends { status: string }>(lookup: T): void => {
        if (lookup.status === 'unknown_run') throw new RunNotFoundError(runId)
        if (lookup.status === 'blob_absent') throw new EvidenceBlobAbsentError(runId, input.sha)
      }
      let whole: Uint8Array | undefined
      let totalLength: number
      if (port.stat !== undefined && port.readRange !== undefined) {
        const lookup = await port.stat(input.runId, input.sha)
        assertFound(lookup)
        if (lookup.status !== 'found') throw new EvidenceBlobAbsentError(runId, input.sha)
        totalLength = lookup.byteLength
      } else {
        const lookup = await port.read(input.runId, input.sha)
        assertFound(lookup)
        if (lookup.status !== 'found') throw new EvidenceBlobAbsentError(runId, input.sha)
        whole = lookup.bytes
        totalLength = whole.length
      }
      const { start } = input.range
      if (start >= totalLength) throw new ArtifactRangeNotSatisfiableError(totalLength)
      const end = Math.min(input.range.end ?? totalLength - 1, totalLength - 1, start + ARTIFACT_RANGE_MAX_BYTES - 1)
      const readSlice = async (from: number, to: number): Promise<Uint8Array> => {
        if (whole !== undefined) return whole.slice(from, to + 1)
        const lookup = await port.readRange!(input.runId, input.sha, from, to)
        assertFound(lookup)
        if (lookup.status !== 'found') throw new EvidenceBlobAbsentError(runId, input.sha)
        return lookup.bytes
      }
      const head = await readSlice(0, Math.min(EVIDENCE_SNIFF_HEAD_BYTES, totalLength) - 1)
      const bytes = await readSlice(start, end)
      return {
        runId, sha: input.sha, contentType: sniffEvidenceContentType(head),
        byteLength: bytes.length, bytesBase64: encodeBase64(bytes), totalLength, range: { start, end },
      }
    }
    const lookup = await port.read(input.runId, input.sha)
    if (lookup.status === 'unknown_run') {
      // REUSED, NEVER RE-MINTED. `runs.get` already owns "no run is recorded under that id", and a
      // second not-found class would give one surface two words for one answer.
      throw new RunNotFoundError(runId)
    }
    if (lookup.status === 'blob_absent') {
      throw new EvidenceBlobAbsentError(runId, input.sha)
    }

    return {
      runId,
      sha: input.sha,
      contentType: sniffEvidenceContentType(lookup.bytes),
      byteLength: lookup.bytes.length,
      bytesBase64: encodeBase64(lookup.bytes),
    }
  },
}
