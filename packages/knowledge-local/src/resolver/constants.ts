// Pinned, never configured: a per-project threshold would make never-guess mean different things.

import { C_RRF } from '../retrieval/constants.js'

// Equal weights bound how far the dense leg can reorder lexical ranks; the margin relies on that.
export const RESOLVER_LEG_WEIGHT_LEXICAL = 1
export const RESOLVER_LEG_WEIGHT_DENSE = 1

/**
 * The fused score of a candidate ranked first in EVERY leg — the scale's maximum.
 *
 * Derived rather than typed out, so a `C_RRF` change or a weight change moves the scale and
 * the thresholds below keep meaning what they say. Dividing by it turns the fused score into
 * agreement on [0, 1]: 1 means every leg put this candidate first, and exactly 0.5 means one
 * leg put it first and the other did not rank it at all.
 *
 * This is a rescale by a constant and nothing else — it preserves the ordering `fuseWeightedRrf`
 * produced, and no ranking decision is taken here. It exists so a card can print a number next
 * to tier (a)'s 1.0 without inventing a second vocabulary for confidence.
 */
export const RESOLVER_FUSED_SCORE_NORMALIZER =
  (RESOLVER_LEG_WEIGHT_LEXICAL + RESOLVER_LEG_WEIGHT_DENSE) / (C_RRF + 1)

// One leg's rank-1 contribution: a candidate no leg ranked first is never a strong hit.
export const RESOLVER_STRONG_HIT_MIN_SCORE = 0.5

// Above 0.25, floor and full can never resolve different entities; change only with the min score.
export const RESOLVER_STRONG_HIT_MARGIN = 0.26

/**
 * How many candidates each leg is asked for.
 *
 * Larger than the top-3 a disambiguation card shows, because fusion needs to SEE the runner-up
 * to refuse: a leg truncated at 3 would hide the competitor that should have turned a resolve
 * into a disambiguation. Bounded because the entity corpus is bounded by what a human can name.
 */
export const RESOLVER_CANDIDATE_K = 32

// Entity BM25 scores sit far below `TAU_LEX`, so any match is admitted; extras only add runners-up.
export const RESOLVER_LEXICAL_MIN_BM25 = 0
