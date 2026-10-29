// The one canonical JSON serializer schema and eval share; array order stays semantic.
export function canonicalValue(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonicalValue)
  if (input === null || typeof input !== 'object') return input

  const source = input as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    sorted[key] = canonicalValue(source[key])
  }
  return sorted
}

/** Compact canonical JSON for hashes and deterministic comparisons. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

/** Pretty canonical JSON for committed files, ending in exactly one newline. */
export function committedFileText(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`
}
