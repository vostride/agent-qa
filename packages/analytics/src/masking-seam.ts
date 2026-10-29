// Masks string leaves before serialization, so JSON escaping cannot hide a secret from the mask.

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
