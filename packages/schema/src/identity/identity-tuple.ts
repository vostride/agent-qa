// JSON array encoding is injective over string tuples; no unicode normalization, as in SQLite.
export function identityTupleKey(parts: readonly string[]): string {
  return JSON.stringify(parts)
}
