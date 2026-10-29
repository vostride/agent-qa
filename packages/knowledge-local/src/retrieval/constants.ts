import type { QueryClass } from './query-class.js'

// Weighted reciprocal-rank-fusion denominator; changing it changes retrieval semantics.
export const C_RRF = 60

export const FAN_OUT_CAP = 32

// FTS5 returns negated bm25 scores, so query sites apply this floor to `-bm25(...)`.
export const TAU_LEX = 6.86

// Identity above content above context, so identity matches outrank context-only ones.
export const FTS_WEIGHT_IDENTITY = 10

export const FTS_WEIGHT_CONTENT = 5

export const FTS_WEIGHT_CONTEXT = 1

export const SITUATING_LINE_MAX_CHARS = 240

// `capExpansion` keeps `ceil(f * N)`, so graph-derived candidates cannot starve direct matches.
export const EXPANSION_FRACTION_F = 0.25

export const EXPANSION_DISCOUNT_WEIGHT = 0.5

// Ubiquity is a poison signal, not relevance, so a hub above this degree is skipped entirely.
export const HUB_DEGREE_THRESHOLD = 64

// Caps distinct-seed fan-in for expanded candidates only; direct matches stay eligible.
export const FAN_IN_THRESHOLD_K = 4

// Audit mode bypasses this cap entirely.
export const DIVERSITY_CAP_PER_ANCHOR = 2

type QueryClassWeightVector = {
  readonly wLex: number
  readonly wDense: number
  readonly wAnchor: number
}

// Equal weights are the cold-start floor; learning may replace vectors, never the classifier.
export const QUERY_CLASS_WEIGHTS = {
  literal: { wLex: 1.5, wDense: 0.5, wAnchor: 2 },
  mixed: { wLex: 1, wDense: 1, wAnchor: 1.5 },
  semantic: { wLex: 0.5, wDense: 1.5, wAnchor: 1 },
} as const satisfies Record<QueryClass, QueryClassWeightVector>
