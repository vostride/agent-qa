// An injected `guardBlob` wins; this fallback bounds one tool-output value with a visible marker.

const TRUNCATION_MARKER = '…[truncated to fit context budget]'

// One structured value is not a burst, so it gets a generous bound that still caps a huge blob.
const BLOB_CEILING = 8000

// Delegates to an injected `guard` when present; never throws on cyclic input.
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
