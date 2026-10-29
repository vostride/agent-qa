// Mirrors runner-local's `latestBuildOrdinal` read, which this package cannot import.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BUILD_ORDINALS_FILE = 'build-ordinals.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readLatestBuildOrdinal(
  runtimeRoot: string,
  product: string,
): number | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(runtimeRoot, BUILD_ORDINALS_FILE), 'utf8'),
    )
    if (!isRecord(parsed)) return undefined

    const ordinal = parsed[product]
    return typeof ordinal === 'number' && Number.isFinite(ordinal)
      ? ordinal
      : undefined
  } catch {
    return undefined
  }
}
