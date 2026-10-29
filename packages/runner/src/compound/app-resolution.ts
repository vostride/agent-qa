// Pure openApp name→id resolution ladder + vendored scorer.
//
// CRITICAL: provider-neutral + storage-neutral. No driver imports, no node:* imports, no
// randomness, no Date — deterministic pure logic. Adapters supply the enumerated registry and
// perform the launch; this module only decides. No fuse.js: a small ladder — normalize →
// exact > prefix > substring > token-overlap > bounded edit distance — over the union of full
// ids, tokenized id segments, and labels. A fuzzy winner requires clearing the threshold AND
// leading the runner-up by a margin; near-ties resolve ambiguous with candidates, never
// a coin-flip launch. All four constants are internal, injectable for tests only via
// ScorerOptions — never user-facing config (353 K=2 pattern).

export interface AppRegistryEntry {
  id: string
  label?: string
}

export interface ScorerOptions {
  fuzzyThreshold?: number
  fuzzyMargin?: number
  editDistanceBound?: number
  candidateCount?: number
}

export type AppResolution =
  | { kind: 'exact' | 'fuzzy'; id: string }
  | { kind: 'ambiguous' | 'unknown'; candidates: { id: string; label?: string }[] }

/**
 * Minimum score a fuzzy top candidate must clear to be launchable. Internal runner constant;
 * injectable via ScorerOptions for tests only. Do NOT promote to user-facing config or thread
 * through LoopPorts / any config schema (353 K=2 precedent).
 */
export const DEFAULT_FUZZY_THRESHOLD = 0.5

/**
 * Minimum lead the top fuzzy candidate must hold over the runner-up to launch (else ambiguous).
 * Internal runner constant; injectable for tests only. Do NOT promote to user-facing config.
 */
export const DEFAULT_FUZZY_MARGIN = 0.15

/**
 * Levenshtein cap: matches beyond this edit distance do not count as edit-rung candidates.
 * Internal runner constant; injectable for tests only. Do NOT promote to user-facing config.
 */
export const DEFAULT_EDIT_DISTANCE_BOUND = 3

/**
 * How many candidates an ambiguous/unknown resolution surfaces. Internal runner constant;
 * injectable for tests only. Do NOT promote to user-facing config.
 */
export const DEFAULT_CANDIDATE_COUNT = 3

const PREFIX_SCORE = 3
const SUBSTRING_SCORE = 2

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Exact-match terms for an entry: full id, each id segment, the last segment, and any label. */
function exactTerms(entry: AppRegistryEntry): string[] {
  const segments = entry.id.split('.')
  const terms = [entry.id, ...segments]
  if (segments.length > 0) terms.push(segments[segments.length - 1])
  if (entry.label !== undefined) terms.push(entry.label)
  return terms.map(normalize).filter((t) => t.length > 0)
}

/** All corpus terms an entry offers the fuzzy ladder. */
function corpusTerms(entry: AppRegistryEntry): string[] {
  return Array.from(new Set(exactTerms(entry)))
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = new Array<number>(n + 1)
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/** Ladder score for one query↔term pair. exact is handled before scoring; here prefix > substring > edit. */
function termScore(query: string, term: string, editBound: number): number {
  if (term.startsWith(query) || query.startsWith(term)) return PREFIX_SCORE
  if (term.includes(query) || query.includes(term)) return SUBSTRING_SCORE
  const dist = levenshtein(query, term)
  if (dist <= editBound) {
    const longest = Math.max(query.length, term.length)
    return longest === 0 ? 0 : 1 - dist / longest
  }
  return 0
}

function entryScore(query: string, entry: AppRegistryEntry, editBound: number): number {
  let best = 0
  for (const term of corpusTerms(entry)) {
    const score = termScore(query, term, editBound)
    if (score > best) best = score
  }
  return best
}

export function resolveAppName(
  name: string,
  registry: AppRegistryEntry[],
  opts: ScorerOptions = {},
): AppResolution {
  const threshold = opts.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD
  const margin = opts.fuzzyMargin ?? DEFAULT_FUZZY_MARGIN
  const editBound = opts.editDistanceBound ?? DEFAULT_EDIT_DISTANCE_BOUND
  const candidateCount = opts.candidateCount ?? DEFAULT_CANDIDATE_COUNT
  const query = normalize(name)

  // Exact rung: any corpus term equal to the normalized query wins outright.
  for (const entry of registry) {
    if (exactTerms(entry).includes(query)) return { kind: 'exact', id: entry.id }
  }

  // Fuzzy ladder: score every entry, rank descending, apply the threshold + margin rules.
  const ranked = registry
    .map((entry) => ({ entry, score: entryScore(query, entry, editBound) }))
    .sort((a, b) => b.score - a.score)

  const surfaced = (): { id: string; label?: string }[] =>
    ranked.slice(0, candidateCount).map(({ entry }) =>
      entry.label !== undefined ? { id: entry.id, label: entry.label } : { id: entry.id },
    )

  const top = ranked[0]
  if (top === undefined || top.score < threshold) {
    return { kind: 'unknown', candidates: surfaced() }
  }

  const runnerUp = ranked[1]
  if (runnerUp === undefined || top.score - runnerUp.score >= margin) {
    return { kind: 'fuzzy', id: top.entry.id }
  }

  return { kind: 'ambiguous', candidates: surfaced() }
}
