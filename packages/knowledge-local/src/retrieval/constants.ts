import type { QueryClass } from './query-class.js'

/**
 * Weighted reciprocal-rank-fusion denominator (spec §5.5.3).
 *
 * LOCKED at 60, ratified 2026-07-03. Changing it changes retrieval semantics rather than tuning a
 * deployment preference, so it remains an internal config-free constant.
 */
export const C_RRF = 60

/**
 * Maximum one-hop graph fan-out per seed (GRPH-01/D-08).
 *
 * LOCKED at 32 by the phase requirement so graph expansion stays bounded and reproducible.
 */
export const FAN_OUT_CAP = 32

/**
 * Positive-scale lexical admission floor (D-05/D-06).
 *
 * Calibrated 2026-07-15 from the schema-v2 `quoted-token-or-v1` serving replay: positive-scale
 * p05 6.864719139232, using linear interpolation and floored to two decimals. SQLite FTS5 returns negated raw bm25()
 * scores, so query sites apply this floor to -bm25(...). M3 owns refinement; D-05 requires no
 * human lock gate.
 */
export const TAU_LEX = 6.86

/**
 * Identity-column BM25 weight (D-03).
 *
 * PROVISIONAL 10 pending the Plan 377-09 lexical calibration receipt. The runtime-verified
 * (10, 5, 1) triple keeps identity matches above context-only matches.
 */
export const FTS_WEIGHT_IDENTITY = 10

/**
 * Self-content BM25 weight (D-03).
 *
 * PROVISIONAL 5 pending the Plan 377-09 lexical calibration receipt. It preserves self-field
 * relevance between identity and situating context.
 */
export const FTS_WEIGHT_CONTENT = 5

/**
 * Situating-context BM25 weight (D-03).
 *
 * PROVISIONAL 1 pending the Plan 377-09 lexical calibration receipt. Context contributes recall
 * without outranking an otherwise-equivalent identity match.
 */
export const FTS_WEIGHT_CONTEXT = 1

/**
 * Maximum situating-line length in characters (D-02).
 *
 * PROVISIONAL 240 pending retrieval-quality measurements; the constant-driven shape remains
 * internal and config-free at roughly one to two sentences.
 */
export const SITUATING_LINE_MAX_CHARS = 240

/**
 * Maximum expanded share of a requested result budget (D-07).
 *
 * PROVISIONAL 0.25 pending recorded-query evaluation. capExpansion applies ceil(f * N), ensuring
 * graph-derived candidates cannot starve direct matches.
 */
export const EXPANSION_FRACTION_F = 0.25

/**
 * Fusion-weight discount for graph-expanded candidates (D-07).
 *
 * PROVISIONAL 0.5 pending recorded-query evaluation; expanded evidence remains secondary to the
 * same query class's direct lexical, dense, and anchor legs.
 */
export const EXPANSION_DISCOUNT_WEIGHT = 0.5

/**
 * Graph-node degree above which expansion skips the hub entirely (D-08).
 *
 * PROVISIONAL 64 pending graph-volume measurements. Ubiquity is treated as a poison signal, never
 * as implicit relevance.
 */
export const HUB_DEGREE_THRESHOLD = 64

/**
 * Maximum distinct-seed fan-in admitted for an expanded candidate (D-11).
 *
 * PROVISIONAL 4 pending graph-volume measurements. Direct matches remain eligible above this
 * threshold, while ubiquitous expansion candidates are excluded.
 */
export const FAN_IN_THRESHOLD_K = 4

/**
 * Maximum assembled results sharing one primary element or flow anchor (D-15/spec §5.5.6).
 *
 * PROVISIONAL 2 within the specified one-to-two range pending diversity measurements. Audit mode
 * bypasses this cap entirely.
 */
export const DIVERSITY_CAP_PER_ANCHOR = 2

type QueryClassWeightVector = {
  readonly wLex: number
  readonly wDense: number
  readonly wAnchor: number
}

/**
 * Fixed weighted-RRF vector for each deterministic query class (D-06).
 *
 * PROVISIONAL vectors pending M3's learned per-product replacements. Plain RRF with all three
 * weights equal to 1 is the declared cold-start floor; learning may replace vectors, never the
 * classifier itself.
 */
export const QUERY_CLASS_WEIGHTS = {
  literal: { wLex: 1.5, wDense: 0.5, wAnchor: 2 },
  mixed: { wLex: 1, wDense: 1, wAnchor: 1.5 },
  semantic: { wLex: 0.5, wDense: 1.5, wAnchor: 1 },
} as const satisfies Record<QueryClass, QueryClassWeightVector>
