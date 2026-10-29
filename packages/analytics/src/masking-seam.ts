// THE SEND SEAM.
//
// THERE IS ONE CHOKE POINT AND IT IS THE TRANSPORT'S `capture`. Not per-event-site masking, not a
// helper each emitter is expected to remember: every outgoing payload passes through
// `maskEventForSend` in `transports.ts`, and a cell counts the call sites in shipped source and
// refuses any number but one. Masking that has to be REMEMBERED is masking that will be forgotten
// exactly once, in the payload that mattered.
//
// STRUCTURE-AWARE, AND BEFORE SERIALIZATION. This is the 396 escape-blind lesson applied. A masker
// that runs on the serialized JSON string searches for the raw secret value — but serialization has
// already rewritten it: a secret containing a double quote and a newline is on the wire as
// `\"` and `\n`, so the raw-value search finds nothing and reports success. Walking the payload
// structure and replacing STRING LEAVES happens before any of that rewriting exists, so there is no
// encoding for the value to hide inside. The cells prove the difference rather than assert it: the
// control cell sends the same payload unmasked and pins that the ESCAPED form is what arrives.
//
// WHAT IS DELIBERATELY NOT MASKED, and why each is a decision rather than an oversight:
//
//   - THE EVENT NAME. It is drawn from a closed literal set (`ANALYTICS_EVENT_NAMES`), so it cannot
//     carry a user's data — every possible value of it is already written in this repo's source.
//     Rewriting it could therefore only corrupt attribution, never protect anything.
//   - PROPERTY KEYS. Every member is a `.strictObject`, so an unknown key REFUSES at parse rather
//     than riding along; the key space is closed for the same reason the name is. Masking keys
//     would put `run_id` one collision away from being renamed to a placeholder.
//
// the host supplies the declared-secret mask; nothing here decides
// what is a secret.

import type { AnalyticsCapturePayload } from './port.js'

/** The only thing the seam needs from a mask: the host binds the declared-secret mask here. */
export interface AnalyticsMaskingContext {
  mask(text: string): string
}

/**
 * Mask every string leaf of an outgoing payload, before anything has been serialized.
 *
 * Returns a NEW payload rather than mutating: the caller's object is the host's, and a host that
 * kept a reference to an event it emitted should not find its own data rewritten underneath it.
 */
export function maskEventForSend(
  payload: AnalyticsCapturePayload,
  context: AnalyticsMaskingContext | undefined,
): AnalyticsCapturePayload {
  if (context === undefined) return payload

  return {
    ...payload,
    // The distinct id IS a masked surface: it is the one caller-supplied string on the envelope, and
    // if a registered secret is what a host handed in as an identity, that is precisely a leak.
    distinctId: context.mask(payload.distinctId),
    event: {
      name: payload.event.name,
      properties: maskLeaves(payload.event.properties, context) as AnalyticsCapturePayload['event']['properties'],
    },
  }
}

/**
 * The walk. Objects and arrays recurse; strings are masked; everything else is returned as-is.
 *
 * `null`, numbers and booleans carry no text to mask, and a value that is none of the above (a
 * `Date`, a class instance) is returned untouched because rewriting it would corrupt it — such a
 * value cannot reach a payload through the closed union anyway, whose leaves are strings, numbers
 * and booleans.
 */
function maskLeaves(value: unknown, context: AnalyticsMaskingContext): unknown {
  if (typeof value === 'string') return context.mask(value)
  if (Array.isArray(value)) return value.map((entry) => maskLeaves(entry, context))
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = maskLeaves(entry, context)
    }
    return out
  }
  return value
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}
