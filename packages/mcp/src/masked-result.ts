// ONE MASKED SERIALIZATION, TWO CHANNELS (Phase 396 plan 06 · T-396-01 / RESEARCH Pitfall 9).
//
// WHY THIS MODULE EXISTS, measured rather than reasoned. Every tool result this package returns has
// TWO output channels: `content`, the prose a person might read, and `structuredContent`, the object
// a model reads and a host logs. Until 396-06 drove the wire, only the first was masked:
//
//     content:           [{ type: 'text', text: maskText(JSON.stringify(output)) }]
//     structuredContent: output          <-- the raw op output, unmasked
//
// A credential this host had DECLARED — its own bearer token — reached the wire verbatim through
// that second field while the text beside it read `<SECRET_0>`. Observed 2026-08-16 in
// `packages/cli/src/__tests__/mcp-credential-surface.test.ts` (B1b):
//
//     AssertionError: structuredContent carried the plant — the machine channel a person never
//     reads: expected 'prop_qxr' to be undefined
//
// That is RESEARCH Pitfall 9's own sentence, which named `structuredContent` as the channel and was
// filed before anyone had driven it: *"the new projection returns op outputs as `structuredContent`
// — an unmasked serialization can carry planted values to a machine surface a person never sees."*
//
// THE FIX IS ONE MASKING, NOT TWO. Masking the object and the text separately would be a second
// implementation of the same rule, free to disagree with the first — and the disagreement would be
// invisible, because nobody diffs the two channels of a result. So the output is masked ONCE, as a
// value, and both channels are answered from that one masked value: `structuredContent` IS it, and
// `content` is its serialization. A value hidden from one cannot survive in the other.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE FIRST VERSION OF THIS MODULE GOT WRONG (CR-01, measured 2026-08-16, fixed the same
// day). "One masked serialization" was originally implemented as: serialize, mask the SERIALIZED
// DOCUMENT, parse the masked document back. That is escape-blind, and it leaked:
//
//     const serialized = JSON.stringify(output) ?? 'null'   // escapes " as \" , \ as \\ , \n , \t
//     const text = maskText(serialized)                     // literal substring replacement
//
// `maskText` is the host's declared-secret mask (`SecretRedactor` in the runner package), a
// LITERAL replacement of the declared raw values. `JSON.stringify` escapes `"`, `\` and every C0
// control character, so for a registered credential containing one of those bytes the raw value
// DOES NOT OCCUR in the document the masker scans. The masker matched nothing and the credential
// reached the caller verbatim — and, because this module answers both channels from the same
// bytes, it reached BOTH of them. Measured:
//
//     raw:        sk-live"abc\def
//     serialized: {"token":"sk-live\"abc\\def"}
//     raw value present in the scanned document? false
//
// The phase verifier drove the then-shipped environment masker over six inputs and recorded
// four of five shapes leaking verbatim on both channels, including a `*_CREDENTIALS`-style JSON
// blob — an entirely ordinary environment value (a password with a quote in it, a service-account
// blob). The corpus in place at the time could not see it: every credential plant was alphanumeric,
// so no cell could tell masking of raw values apart from masking of the serialized form. (Phrased
// without quoted-string-after-`from`: the arch dep lint reads that shape as an import specifier.)
//
// SO THE MASKER IS NEVER HANDED A SERIALIZATION. `maskJsonDocument` below walks the JSON value and
// masks every STRING LEAF and every OBJECT KEY — the raw bytes an operator declared — and only
// then serializes. The standing corpus for the class is
// `__tests__/masked-serialization.test.ts`, which drives the shipped masker over a value containing
// a quote, one containing a backslash, one containing a control character, and a JSON blob.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// IT STILL FAILS CLOSED, and the conditions are now named rather than incidental. A masked value
// that cannot be REPRESENTED — a number or a boolean whose JSON spelling is itself a registered
// credential, so hiding it in place would change the value's type; two keys of one object that mask
// to the same name, so the masked object would silently drop a member; anything unserializable —
// yields a tool error naming the condition instead of a result. The alternative is returning the
// unmasked object, which is the defect this module exists to close. (The previous version withheld
// on "the masked document no longer parses", which is the same posture reached by accident: a
// placeholder substituted for a bare number produced invalid JSON. That case is now refused by
// name, and the numeric cell in the corpus pins it across the change.)
//
// THE COST, STATED — and the reason it is a REAL cost rather than a theoretical one: SEP-2106
// loosened `inputSchema`/`outputSchema` to full JSON Schema 2020-12, so an advertised output
// contract can now say things precise enough for a masked value to violate them (a `format`, a
// `pattern`, a `minLength`). A masked value can therefore violate the tool's advertised
// `outputSchema`, and the SDK
// then refuses the result. That is the correct direction. An op output that contains a declared
// credential is a leak; turning a leak into a refusal a caller can see is a better answer than
// serving it, and it happens only when a legitimate value is byte-equal to a credential this host
// was told about.

import type { CallToolResult } from '@modelcontextprotocol/server'
import { RunsArtifactResultSchema } from '@vostride/agent-qa-schema'
import type { RunsArtifactResult } from '@vostride/agent-qa-schema'

// the MCP remedy renderer is deleted with the remedy vocabulary. The
// mark credential refusal that carried its last sentence is deleted too.

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
      // KEYS TOO. A map keyed by a credential — a header table, an env echo — carries the value in
      // the name rather than in the leaf, and the old whole-document mask happened to cover that
      // case. Two keys masking to one name would silently DROP a member, which is a different
      // answer wearing the same shape, so it is refused rather than resolved.
      const maskedKey = maskText(key)
      if (Object.hasOwn(masked, maskedKey)) {
        throw new UnmaskableValueError('two keys of one object mask to the same name')
      }
      // Defined, not assigned: `masked['__proto__'] = …` would set the prototype and drop the key,
      // and a captured variable may legitimately be named `__proto__`.
      Object.defineProperty(masked, maskedKey, {
        value: maskJsonLeaves(entry, maskText),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return masked
  }

  // JSON's remaining leaves: number and boolean. They hold no string for the masker to replace, so
  // a registered credential whose SPELLING is one of them (`{"pin":867530912345}`) cannot be hidden
  // here without turning a number into a string. Refused, which is what the previous implementation
  // did by accident when a placeholder substituted into a bare number broke the document's JSON.
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

/**
 * The masked error result every handler in this package answers a refusal with.
 *
 * A refusal is a RESULT the caller can read, not a transport failure — and the message is masked
 * because an error string is the channel 395's credential disclosure actually travelled down
 * Kept beside `maskedToolResult` so the two halves of one handler's output posture
 * are one thing to read and one thing to change.
 */
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE IMAGE ARM. A complete PNG or JPEG screenshot also travels as an
// MCP image block, added after masking from bytes the masked value still carries unchanged.
// `structuredContent` is never changed. The text keeps every field except the bytes, which it
// names as attached image content (owner decision 2026-09-29, review WR-06).
// Masking hides strings, never pixels: a screenshot shows what the page showed.
// ─────────────────────────────────────────────────────────────────────────────────────────────

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

// the mark door's credential refusal is deleted with the MCP bearer
// credential. `agent_qa_mark_run` dispatches through the generic projection handler like every other
// change tool, advertises the op's own outcome, and answers its receipt on the one call.
