// The 2025 codec wraps a result in `{ result }` when the tool's output schema is not an object.
export function payloadOf(structuredContent: unknown): Record<string, unknown> {
  const record = (structuredContent ?? {}) as Record<string, unknown>
  const keys = Object.keys(record)
  return keys.length === 1 && keys[0] === 'result'
    ? record.result as Record<string, unknown>
    : record
}
