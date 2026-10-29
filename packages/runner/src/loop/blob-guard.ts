// Pure runner-local pre-prompt blob-guard fallback. Bounds a single
// one-shot structured tool-output value before it lands in the sub-action history / next
// planning turn — replacing the v1 2000-char guillotine. When a composition root injects a
// canonical guardBlob (model's shared substrate), it is used in preference; otherwise this
// boundary-respecting fallback applies a generous documented ceiling + a visible marker.

const TRUNCATION_MARKER = '…[truncated to fit context budget]'

// A single structured value is one thing, not a burst — so it earns a far more generous
// bound than the v1 2000-char slice: 8000 chars (~2000 tokens, 4×) keeps real signal while
// still capping an adversarial huge/repeating blob.
const BLOB_CEILING = 8000

/**
 * Bound one-shot tool-output data for prompt inclusion. Delegates to an injected `guard`
 * when present (single shared implementation); else applies the runner-local fallback:
 * `undefined`⇒`undefined`, a short value safe-stringified verbatim, and a value over the
 * ceiling sliced with the visible marker. Never throws on cyclic input.
 */
export function guardActionData(
  value: unknown,
  guard?: (value: unknown) => string | undefined,
): string | undefined {
  if (guard) return guard(value)
  if (value === undefined) return undefined
  const str = safeStringify(value)
  if (str.length <= BLOB_CEILING) return str
  return str.slice(0, BLOB_CEILING) + TRUNCATION_MARKER
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return (
      JSON.stringify(value, (_key, node) => {
        if (typeof node === 'object' && node !== null) {
          if (seen.has(node)) return '[Circular]'
          seen.add(node)
        }
        return node
      }) ?? 'undefined'
    )
  } catch {
    return '[unserializable]'
  }
}
