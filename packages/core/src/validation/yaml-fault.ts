// Reads only the two `linePos` numbers; the error's message quotes the person's file.
export function yamlParseFailureMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'not readable as YAML (position unavailable)'
  }
  const linePos = (error as { linePos?: readonly { line?: unknown; col?: unknown }[] }).linePos
  const first = Array.isArray(linePos) ? linePos[0] : undefined
  if (typeof first?.line === 'number' && typeof first.col === 'number') {
    return `not readable as YAML at line ${first.line}, column ${first.col}`
  }
  return 'not readable as YAML (position unavailable)'
}
