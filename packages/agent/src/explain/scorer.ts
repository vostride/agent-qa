// The deterministic closest-capability scorer.
//
// THE MODEL DOES NOT PICK THE SUGGESTION EITHER. D-10 takes the command out of the model's hands;
// this file takes the consolation prize out of them too, because "I could not answer that, but you
// probably want X" is a claim about the catalog exactly as much as an answer is, and a model that
// may not name a command may not name a capability by a softer route.
//
// HAND-ROLLED ON PURPOSE, AND THAT IS THE EXCEPTION NOT THE RULE. `fuse.js` and
// `fastest-levenshtein` were both available and both rejected: `packages/agent`'s ownership
// contract pins its external dependencies at exactly `ai` and `zod`, reconciled against
// package.json by `validate:arch`, so a similarity library is a boundary change requiring an
// argument. At thirty lines of pure arithmetic the house dependency discipline wins. If the
// scorer ever proves inadequate, widening that list is the visible, reviewed step — not a silent
// import.
//
// DETERMINISM IS TWO-SIDED, and the second side is the one that bites. It is not enough that the
// right row wins; the SAME input must not be able to produce a DIFFERENT answer on another run or
// another machine. Three things are therefore deliberate and each has a cell:
//   - the total order is score desc then row id asc, so no two rows can be left unordered;
//   - the id comparison is CODE-UNIT, never `localeCompare` — a collation is a machine fact, and a
//     tie broken by the host's locale is the machine-dependent answer this refuses to give;
//   - nothing is read out of a Map or Set in iteration order; the bigram counters exist only to
//     produce numbers, and the ranking is built by an explicit sort over an array.

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

/**
 * Character bigrams as a multiset, taken WITHIN words and never across a space.
 *
 * The word boundary matters more than it looks. A bigram spanning a space is a gram whose second
 * half is the first letter of an arbitrary next word, so `"zzzz qqqq wwww"` shares `" w"` with
 * `"…answer with its run id"` and scores non-zero against a row it has nothing to do with — which
 * makes "nothing in the catalog is close" a state the scorer can never report, and D-11's honest
 * empty answer unreachable. Measured: that one gram scored 0.0247 before this split. Words shorter
 * than two characters contribute no grams, which is correct — `a` and `I` are not evidence.
 */
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

/**
 * A row's score against a query: the better of its NAME alone and its name-plus-description.
 *
 * Two terms and one `max`, not two recipes: Dice normalises by total length, so a row whose name
 * IS the query would otherwise be beaten by a row whose long description happens to mention the
 * word. D-11 names both fields as the similarity's source; this is how both count without either
 * drowning the other.
 */
function scoreRow(normalizedQuery: string, row: CatalogRow): number {
  const name = normalize(nameTextOf(row))
  const withDescription = normalize(`${nameTextOf(row)} ${row.description}`)
  return Math.max(
    diceCoefficient(normalizedQuery, name),
    diceCoefficient(normalizedQuery, withDescription),
  )
}

/**
 * Up to `k` canonical row ids, closest first — the abstention arm's suggestion.
 *
 * ZERO-OVERLAP ROWS ARE FILTERED OUT, and that is the honest arm rather than a missing feature: a
 * query sharing no bigram with any row has no closest capability, and returning the
 * alphabetically-first three anyway would be a suggestion drawn from nothing — the same invention
 * by a quieter route. An empty answer is what the abstention text is written to say.
 */
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
