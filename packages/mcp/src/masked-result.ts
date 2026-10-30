// Masked once, leaf by leaf, before serializing; a masked value may then fail its SEP-2106 schema.

import type { CallToolResult } from '@modelcontextprotocol/server'
import { RunsArtifactResultSchema } from '@vostride/agent-qa-schema'
import type { RunsArtifactResult } from '@vostride/agent-qa-schema'

/** The one prose a caller reads when a value could not be masked in place. Value-free by design. */
const WITHHELD_TEXT =
  'This result could not be returned: part of its output could not be masked in place — a value '
  + 'whose hidden form would not be the same kind of value, or two names that mask to one name — so '
  + 'the unmasked object was withheld rather than served.'

/**
 * Raised inside the walk when a leaf cannot be masked without changing what the document MEANS.
 *
 * Private, and it never escapes this module: every caller turns it into a withheld answer. It is an
 * exception rather than a sentinel return because it is thrown from inside a recursion whose every
 * frame would otherwise have to re-check for the sentinel — and a missed check there is served
 * output.
 */
class UnmaskableValueError extends Error {}

/**
 * Mask every STRING LEAF and every OBJECT KEY of a JSON value, in place, leaving the shape alone.
 *
 * THE MASKER ONLY EVER SEES RAW BYTES. That is the whole correction: a literal-substring masker
 * handed `{"token":"sk-live\"abc"}` cannot find `sk-live"abc`, and handed `sk-live"abc` it can.
 */
function maskJsonLeaves(value: unknown, maskText: (text: string) => string): unknown {
  if (typeof value === 'string') return maskText(value)
  if (value === null) return null

  if (Array.isArray(value)) {
    return value.map((entry) => maskJsonLeaves(entry, maskText))
  }

  if (typeof value === 'object') {
    const masked: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // A credential can sit in a key, and two keys masking to one name are refused, not merged.
      const maskedKey = maskText(key)
      if (Object.hasOwn(masked, maskedKey)) {
        throw new UnmaskableValueError('two keys of one object mask to the same name')
      }
      // Defined, not assigned: assigning `__proto__` sets the prototype and drops the key.
      Object.defineProperty(masked, maskedKey, {
        value: maskJsonLeaves(entry, maskText),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return masked
  }

  // A number or boolean spelling a registered value cannot be masked in place, so it is refused.
  const spelling = JSON.stringify(value) ?? 'null'
  if (maskText(spelling) !== spelling) {
    throw new UnmaskableValueError('a non-string leaf spells a registered value')
  }
  return value
}

/**
 * One masked value and its one serialization, or `undefined` when it cannot be represented.
 *
 * The pair is returned together so that no caller can compose a text channel and a data channel out
 * of two different maskings — `text` is `JSON.stringify(value)` and nothing else. Exported because
 * `resources.ts` composes resource contents the same way and must not grow a second answer to the
 * same question.
 */
export function maskJsonDocument(
  output: unknown,
  maskText: (text: string) => string,
): { readonly value: unknown; readonly text: string } | undefined {
  // Round-tripped through the serializer FIRST, so what is masked is exactly what a caller would
  // have received: `toJSON` hooks run, `undefined` members vanish, a `Date` becomes its string.
  // `JSON.stringify` answers `undefined` for `undefined` and for a bare function; `'null'` is the
  // honest serialization of "the op answered nothing", and it parses.
  const serialized = JSON.stringify(output) ?? 'null'

  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return undefined
  }

  let value: unknown
  try {
    value = maskJsonLeaves(parsed, maskText)
  } catch {
    return undefined
  }

  const text = JSON.stringify(value)
  if (text === undefined) return undefined
  return { value, text }
}

/**
 * Mask once, and answer both channels from the one masked value.
 *
 * `structuredContent` IS the masked value and `content` is its serialization, which is the whole
 * point: the object a machine reads and the text a person reads agree about what was hidden,
 * because there is only one masking and one document. One exception: the evidence image arm
 * replaces `bytesBase64` in the text with a marker, while `structuredContent` keeps the bytes.
 */
export function maskedToolResult(
  output: unknown,
  maskText: (text: string) => string,
): CallToolResult {
  const masked = maskJsonDocument(output, maskText)
  if (masked === undefined) {
    return {
      content: [{ type: 'text' as const, text: WITHHELD_TEXT }],
      isError: true,
    }
  }

  return {
    content: [{ type: 'text' as const, text: masked.text }],
    structuredContent: masked.value as CallToolResult['structuredContent'],
  }
}

// A refusal is a readable result, masked because an error string can carry a credential.
export function maskedToolError(err: unknown, maskText: (text: string) => string): CallToolResult {
  const message = err instanceof Error ? err.message : String(err)
  return {
    content: [
      {
        type: 'text' as const,
        text: maskText(message),
      },
    ],
    isError: true,
  }
}

// An image block is added after masking; masking hides strings, never pixels.

/** Why an artifact did not travel as an image. Each is a tool error, never a success. */
export type RunEvidenceImageRefusal =
  | 'artifact-range-fragment'
  | 'artifact-not-image'
  | 'artifact-image-invalid'
  | 'artifact-image-withheld'

const RUN_EVIDENCE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg'])

export const RUN_EVIDENCE_IMAGE_TEXT_MARKER = '[image attached as image content]'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const PNG_IEND_TRAILER = [
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
] as const
const JPEG_START = [0xff, 0xd8, 0xff] as const
const JPEG_END = [0xff, 0xd9] as const

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function refusalText(refusal: RunEvidenceImageRefusal, contentType: string | undefined): string {
  switch (refusal) {
    case 'artifact-range-fragment':
      return 'artifact-range-fragment: agent_qa_get_run_evidence returns a screenshot only as one '
        + 'complete PNG or JPEG image, and this range covers part of one. Call runs.artifact without '
        + 'a range.'
    case 'artifact-not-image':
      return `artifact-not-image: this artifact is ${contentType ?? 'not typed'}, not a PNG or JPEG `
        + 'screenshot, and agent_qa_get_run_evidence relays no other artifact bytes. Read a step '
        + 'document through action runs.evidence.'
    case 'artifact-image-invalid':
      return 'artifact-image-invalid: the artifact is typed as an image, but its bytes are not one '
        + 'complete PNG or JPEG, so they were not returned.'
    case 'artifact-image-withheld':
      return 'artifact-image-withheld: masking changed the encoded screenshot, so neither the image '
        + 'nor its bytes were returned.'
  }
}

function hasBytesAt(bytes: Uint8Array, expected: readonly number[], offset: number): boolean {
  if (offset < 0 || bytes.length < offset + expected.length) return false
  return expected.every((byte, index) => bytes[offset + index] === byte)
}

function isCompleteImage(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === 'image/png') {
    return hasBytesAt(bytes, PNG_SIGNATURE, 0)
      && hasBytesAt(bytes, PNG_IEND_TRAILER, bytes.length - PNG_IEND_TRAILER.length)
  }
  return hasBytesAt(bytes, JPEG_START, 0)
    && hasBytesAt(bytes, JPEG_END, bytes.length - JPEG_END.length)
}

/** The bytes of CANONICAL base64 only; anything a strict encoder would not emit is refused. */
function decodeCanonicalBase64(text: string): Uint8Array | undefined {
  if (!CANONICAL_BASE64.test(text)) return undefined
  let binary: string
  try {
    binary = atob(text)
  } catch {
    return undefined
  }
  if (btoa(binary) !== text) return undefined
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

// The op types a ranged read by the WHOLE blob's head, so a fragment can say image/png while
// carrying a middle slice. Only a read that provably covers every byte is a whole image.
function coversWholeBlob(artifact: RunsArtifactResult): boolean {
  if (artifact.range === undefined) {
    return artifact.totalLength === undefined || artifact.totalLength === artifact.byteLength
  }
  return artifact.totalLength !== undefined
    && artifact.range.start === 0
    && artifact.range.end === artifact.totalLength - 1
    && artifact.byteLength === artifact.totalLength
}

/**
 * Add one image block to the evidence tool's `runs.artifact` answer, after masking.
 *
 * `result` is what `maskedToolResult` answered for `output`. A refusal or withheld result is
 * returned untouched. Anything that is not one complete PNG or JPEG, or whose base64 the masking
 * changed, becomes a named tool error carrying no bytes at all.
 */
export function decorateRunEvidenceImage(input: {
  readonly result: CallToolResult
  readonly output: unknown
  readonly maskText: (text: string) => string
}): CallToolResult {
  const { result } = input
  if (result.isError === true) return result

  const refuse = (refusal: RunEvidenceImageRefusal, contentType?: string): CallToolResult => ({
    content: [{ type: 'text' as const, text: input.maskText(refusalText(refusal, contentType)) }],
    isError: true,
    ...(result._meta === undefined ? {} : { _meta: result._meta }),
  })

  const parsed = RunsArtifactResultSchema.safeParse(input.output)
  if (!parsed.success) return refuse('artifact-image-invalid')
  const artifact = parsed.data
  if (!RUN_EVIDENCE_IMAGE_TYPES.has(artifact.contentType)) {
    return refuse('artifact-not-image', artifact.contentType)
  }
  if (!coversWholeBlob(artifact)) return refuse('artifact-range-fragment')

  const masked = result.structuredContent as
    | { readonly bytesBase64?: unknown; readonly contentType?: unknown }
    | undefined
  if (masked?.bytesBase64 !== artifact.bytesBase64 || masked.contentType !== artifact.contentType) {
    return refuse('artifact-image-withheld')
  }

  const bytes = decodeCanonicalBase64(artifact.bytesBase64)
  if (
    bytes === undefined
    || bytes.length !== artifact.byteLength
    || !isCompleteImage(artifact.contentType, bytes)
  ) {
    return refuse('artifact-image-invalid')
  }

  const text = JSON.stringify({ ...masked, bytesBase64: RUN_EVIDENCE_IMAGE_TEXT_MARKER })
  return {
    ...result,
    content: [
      ...result.content.map((block) => (block.type === 'text' ? { type: 'text' as const, text } : block)),
      { type: 'image' as const, data: artifact.bytesBase64, mimeType: artifact.contentType },
    ],
  }
}

