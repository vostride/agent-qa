// The D-07 strong-hit rule's pinned constants.
//
// The style is the `LEASE_HEARTBEAT_TTL_MS` idiom: named exports carrying the rationale a
// retune needs, never configuration. A threshold that a project could set is a threshold that
// differs per project, and "never guesses" would then mean something different in every repo.
//
// THE SCALE THESE NUMBERS LIVE ON, AND HOW IT WAS MEASURED
//
// Tier (b) ranks with `fuseWeightedRrf`, which is reciprocal-rank fusion: a candidate's
// contribution from one leg is `weight / (C_RRF + rank)` and nothing else. Raw BM25 and cosine
// magnitudes are discarded by design at that point — RRF ranks by AGREEMENT, not by score. So
// with `C_RRF` at 60, one leg's rank-1 contribution is `weight / 61`, its rank-2 contribution
// is `weight / 62`, and the gap between adjacent ranks (0.00026 at weight 1) is two orders of
// magnitude smaller than the gap between being in one leg and being in two.
//
// Measured on 2026-08-02 against a six-entity index seeded through `refreshEntity` and queried
// through `lexicalLeg` + `denseLeg` + `fuseWeightedRrf` at weights (1, 1): a lexical-only hit
// scored 0.016393, a lexical rank-1 plus dense rank-2 hit scored 0.032522, and the whole
// observed spread across four queries was 0.015625 .. 0.032787. That is the entire dynamic
// range of the raw fused score, and it is why the reported score is NORMALISED (below) rather
// than published as-is: "0.0328" is not a number any surface can render as confidence.
//
// THE CORPUS REPORT THESE VALUES WERE FINALISED AGAINST
//
// `test-output/entity-resolution-report.json`, written by every run of the resolver corpus
// suite: 106 entities across the five mintable kinds, 110 authored query cases, 220 rows —
// every case scored under the full hybrid posture AND under the lexical-only floor. That file
// is what a retune must argue from; retuning from a handful of observed queries is how a
// never-guess contract quietly becomes a usually-right one.
//
// What the corpus measured on 2026-08-02, at the values below and with nothing changed:
//
//   - 46 of 110 cases resolve under the full posture, 31 under the floor. Eleven of the floor's
//     are free text, so the lexical-only rung genuinely answers rather than merely surviving.
//   - No case resolves an entity other than the one it declares, in either posture.
//   - No case resolves a DIFFERENT entity at the floor than at the full posture.
//   - Every equal-strength pair disambiguates in both postures, with the two fused scores
//     differing by exactly zero.
//
// NEITHER VALUE MOVED, and the corpus is why rather than an excuse for it: both are derived
// from `C_RRF` and the leg weights (below), so a value fitted to a corpus would have replaced
// an arithmetic property with a curve fit. What the corpus adds is the boundary measurement the
// margin's comment could not make on its own — see `RESOLVER_STRONG_HIT_MARGIN`.

import { C_RRF } from '../retrieval/constants.js'

/**
 * The two leg weights, and they are EQUAL for a reason that is not aesthetic.
 *
 * The degradation invariant says a floor host may only produce MORE disambiguation,
 * never a different answer. Floor mode is full mode minus the dense leg, so each candidate's
 * floor score is its full score minus its own dense contribution. With equal weights the most
 * any candidate can gain from the dense leg is one rank-1 contribution, which is what bounds
 * how far the dense leg can reorder the lexical ranking — and that bound is what
 * `RESOLVER_STRONG_HIT_MARGIN` is set against. Weighting the dense leg above the lexical one
 * (as the `semantic` query-class vector does for records) would let the dense leg invert an
 * ordering by more than the margin, and floor mode could then resolve to a different entity.
 *
 * The resolver therefore owns its own weights rather than importing a query-class vector: this
 * pair is load-bearing for a safety property, and a vector tuned for record retrieval has no
 * obligation to stay equal.
 */
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

/**
 * The absolute half of the D-07 rule: a strong hit is at the head of at least one leg.
 *
 * 0.5 is exactly one leg's rank-1 contribution on the normalised scale, and picking it says
 * something narrow and true: a candidate that no leg ranked first is never a strong hit, no
 * matter how far ahead of the runner-up it ended up. That case is reachable in practice — the
 * index is refreshed on sighting, so it can hold a row for an entity whose owning store has
 * since forgotten it; when that row heads a leg it is dropped after fusion, and the survivor
 * behind it must NOT be promoted into a confident answer just because the leader vanished.
 *
 * Honest about its limits: on an RRF scale an absolute threshold cannot do much more than
 * this. The fused top is always at least one leg's rank-1 contribution whenever any leg head
 * survives, so a threshold below 0.5 would never fire, and a threshold above 0.5 would forbid
 * a floor host from ever resolving anything — including a reference that matched exactly one
 * entity. The discrimination work is therefore done by the margin below, which is where the
 * two-part rule's second half earns its place rather than restating the first.
 *
 * The corpus report confirms both halves of that claim rather than only the comfortable one:
 * 31 of its 110 cases resolve at the floor, so the threshold is not quietly forbidding the
 * floor rung; and the case where a leg head is dropped after fusion still refuses, so it is not
 * quietly permitting a survivor to inherit a leader's confidence.
 */
export const RESOLVER_STRONG_HIT_MIN_SCORE = 0.5

/**
 * The margin half of the D-07 rule, and the number that makes a safety property structural.
 *
 * A candidate can gain at most 0.5 on the normalised scale by being ranked first in the dense
 * leg. For floor mode (which has no dense leg) to resolve entity E while full mode resolves a
 * DIFFERENT entity Z, the dense leg would have to move Z past E by more than twice the margin.
 * Any margin above 0.25 therefore makes that impossible rather than unlikely: floor mode can
 * only ever produce the same resolved entity or refuse to resolve at all. 0.26 is the pinned
 * value with room above the bound so an adjacent-rank rounding difference cannot reach it.
 *
 * Its everyday meaning is simpler: a strong hit is one the legs AGREE on more than they agree
 * on anything else. Two near-twins ranked 1 and 2 differ by 0.016 and always disambiguate —
 * including the equal-strength typo case, which differs by exactly zero and therefore cannot
 * be resolved by any positive margin at all.
 *
 * WHERE THE BOUNDARY ACTUALLY IS, measured by the 387-05 corpus rather than argued.
 *
 * The 0.25 above comes from a CONTINUOUS inequality, and this scale is not continuous. A floor
 * host's score comes from the lexical leg alone, so its top is one leg's rank-1 contribution
 * (0.5) and its runner-up, when it has one, is rank 2 (0.4919). The largest margin a floor host
 * can therefore ever clear against a rival is the gap between two adjacent ranks — 1/124, about
 * 0.00806 — and above that the floor can only resolve a reference that matched exactly ONE
 * entity, which no dense leg can reorder. So the real bound is thirty times smaller than the
 * one the paragraph above derives, and 0.26 clears both with room to spare.
 *
 * That is not a licence to lower it. The corpus runs its whole population through this same
 * rule at several margins and reports what it finds: no divergence at 0.26, none at 1.5×1/124,
 * and a real one BELOW 1/124, where a case whose two lexical candidates sit 0.008 apart resolves
 * the first at the floor while the dense leg promotes the second in full. That measurement is
 * what makes the invariant's test a gate rather than an arithmetic tautology — and it is only
 * reachable because the decision is applied through one exported function (`applyStrongHitRule`)
 * that the corpus can hand a different margin. Nothing in production passes it one.
 *
 * Retune only alongside `RESOLVER_STRONG_HIT_MIN_SCORE`, and only against the corpus report
 * named at the top of this file: dropping below 1/124 trades the degradation guarantee for
 * recall, and dropping to 0.25 or below gives up the argument that it cannot be traded at all.
 */
export const RESOLVER_STRONG_HIT_MARGIN = 0.26

/**
 * How many candidates each leg is asked for.
 *
 * Larger than the top-3 a disambiguation card shows, because fusion needs to SEE the runner-up
 * to refuse: a leg truncated at 3 would hide the competitor that should have turned a resolve
 * into a disambiguation. Bounded because the entity corpus is bounded by what a human can name.
 */
export const RESOLVER_CANDIDATE_K = 32

/**
 * The lexical admission floor for the ENTITY corpus, which is not the records corpus floor.
 *
 * `TAU_LEX` is 6.86, calibrated from a recorded serving replay over knowledge records. Measured
 * against entity renderings on 2026-08-02, the entire observed positive BM25 range was 0.0 to
 * 3.24 — an entity rendering is six words where a record rendering is a paragraph, so the two
 * corpora are not on the same scale and `TAU_LEX` rejects EVERY entity lexical candidate. The
 * dense leg keeps its own floor, `tau_dense`, which is profile-owned and therefore correct
 * wherever it is applied; only the lexical floor is corpus-specific, and applying a record
 * corpus's number here would have silently deleted the lexical leg.
 *
 * Zero means "the FTS query matched at all", and that is deliberately permissive. Under the
 * never-guess rule a weak extra candidate can only ADD a runner-up, and a runner-up can only
 * turn a resolve into a disambiguation — never into a different answer, because `lexicalLeg`
 * orders by BM25, so a genuine match always outranks a noise match. Raising this floor would
 * make small corpora answer `none` where several entities plainly do mention the word, which
 * is a worse lie than an honest disambiguation card.
 */
export const RESOLVER_LEXICAL_MIN_BM25 = 0
