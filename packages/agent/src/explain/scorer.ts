// Ordered by score, then code-unit row id, so no locale or iteration order changes the answer.

import { catalogRowKey } from '@vostride/agent-qa-schema'
import type { CatalogRow } from '@vostride/agent-qa-schema'

/** How many suggestions an abstention offers when the caller does not say. */
export const DEFAULT_CLOSEST_COUNT = 3

/**
 * The canonical row id — kind-prefixed, so an op and an alias sharing a word are two ids.
 *
 * Spelled here as well as in `renderer.ts` would be two spellings of one identity, so the renderer
 * owns it and this file imports it. `catalogRowKey` (schema) is the within-kind half.
 */
function rowIdOf(row: CatalogRow): string {
  return `${row.kind}:${catalogRowKey(row)}`
}

/**
 * Code-unit comparison of two canonical row ids.
 *
 * Exported because it IS the determinism claim's choke point: a cell asserts it directly against
 * the pair where a locale collation disagrees, which a test routed only through the ranking could
 * not reach without contriving a tie in every ordering scenario.
 */
export function compareRowIds(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** Lowercased, whitespace-collapsed — the one normalisation, applied to both sides. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

// Bigrams never cross a space, or every query would score above zero against unrelated rows.
function bigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const word of text.split(' ')) {
    for (let index = 0; index + 1 < word.length; index += 1) {
      const gram = word.slice(index, index + 2)
      counts.set(gram, (counts.get(gram) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Sørensen–Dice over character bigrams: `2·|A ∩ B| / (|A| + |B|)`, in [0, 1].
 *
 * Character bigrams rather than word tokens because the queries this serves are typed by a person
 * who does not know the vocabulary yet — "starting runs" should reach `runs.start`, and a
 * word-equality tokenizer answers zero to that.
 */
function diceCoefficient(left: string, right: string): number {
  const leftGrams = bigramCounts(left)
  const rightGrams = bigramCounts(right)
  let leftTotal = 0
  for (const count of leftGrams.values()) leftTotal += count
  let rightTotal = 0
  for (const count of rightGrams.values()) rightTotal += count
  if (leftTotal === 0 || rightTotal === 0) return 0

  let shared = 0
  for (const [gram, count] of leftGrams) {
    const other = rightGrams.get(gram)
    if (other !== undefined) shared += Math.min(count, other)
  }
  return (2 * shared) / (leftTotal + rightTotal)
}

/** The row's name-ish text: the word a person would type for it. */
function nameTextOf(row: CatalogRow): string {
  return catalogRowKey(row)
}

// The better of name alone and name plus description, because Dice normalises by length.
function scoreRow(normalizedQuery: string, row: CatalogRow): number {
  const name = normalize(nameTextOf(row))
  const withDescription = normalize(`${nameTextOf(row)} ${row.description}`)
  return Math.max(
    diceCoefficient(normalizedQuery, name),
    diceCoefficient(normalizedQuery, withDescription),
  )
}

// Zero-overlap rows are dropped, so an unrelated query gets no suggestion at all.
export function closestCapabilities(
  query: string,
  rows: readonly CatalogRow[],
  k: number = DEFAULT_CLOSEST_COUNT,
): readonly string[] {
  if (rows.length === 0 || k <= 0) return []
  const normalizedQuery = normalize(query)
  if (normalizedQuery === '') return []

  const ranked = rows
    .map((row) => ({ rowId: rowIdOf(row), score: scoreRow(normalizedQuery, row) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      left.score === right.score
        ? compareRowIds(left.rowId, right.rowId)
        : right.score - left.score,
    )

  return ranked.slice(0, k).map((candidate) => candidate.rowId)
}
