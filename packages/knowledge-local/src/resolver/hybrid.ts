// Tiers (b) and (c) of the entity resolver.
//
//   (b) a STRONG HIT over the hybrid entity index — resolved, with a score.
//   (c) anything weaker — the top three, as a disambiguation set, or an honest miss.
//
// WHAT THIS FILE DOES NOT CONTAIN
//
// No scoring. Not a line of it. `lexicalLeg` runs the weighted BM25 recall, `denseLeg` runs the
// embedding recall and owns the degradation ladder that decides whether there is an embedder at
// all, and `fuseWeightedRrf` combines their rankings and breaks final ties on identity. D-05
// picked the memidex pipeline over fuse.js precisely so semantic phrasings resolve, and a
// second scoring engine living here would have re-opened every calibration those modules
// already carry — the admission floors, the RRF constant, the FTS escaping, the vec/brute
// rungs. What this file adds is the never-guess decision ON TOP of a ranking it did not compute.
//
// WHY THE FLOOR POSTURE NEEDS NO FLAG
//
// There is no branch here that asks whether this host has an embedder. `denseLeg` answers with
// an empty leg when it cannot embed, `hasDenseCandidates` skips it when nothing is embedded at
// all, and an empty leg contributes nothing to the fusion. A floor host therefore runs the same
// code and gets the lexical-only rung by omission — which is what makes the degradation
// direction a property of the arithmetic rather than of a posture check somebody has to keep
// in step.
//
// WHY THE INDEX IS NOT ASKED WHAT AN ENTITY IS
//
// The index ranks short-IDs; the caller turns a short-ID back into a descriptor. The projection
// is disposable and may hold a stale row for an entity its owning store has since forgotten
// so letting it describe the answer would let a stale row put a stale title in front of
// a user. The ledger and the stores stay the truth; this file only decides which address wins.

import { ENTITY_RESOLUTION_MAX_CANDIDATES } from '@vostride/agent-qa-schema'
import type { EntityDescriptor, EntityResolution } from '@vostride/agent-qa-schema'

import type { EmbedderPort } from '../embedder-port.js'
import {
  ENTITY_INDEX_SCOPE,
  entityIndexTauDense,
  type EntityIndexHandle,
} from '../entity-index/entity-index.js'
import { hasDenseCandidates } from '../retrieve.js'
import { admitCandidate, fuseWeightedRrf } from '../retrieval/fusion.js'
import { denseLeg, lexicalLeg, type LegCandidate } from '../retrieval/legs.js'
import {
  RESOLVER_CANDIDATE_K,
  RESOLVER_FUSED_SCORE_NORMALIZER,
  RESOLVER_LEG_WEIGHT_DENSE,
  RESOLVER_LEG_WEIGHT_LEXICAL,
  RESOLVER_LEXICAL_MIN_BM25,
  RESOLVER_STRONG_HIT_MARGIN,
  RESOLVER_STRONG_HIT_MIN_SCORE,
} from './constants.js'

export interface ResolveHybridDeps {
  /** The D-06 projection this ranks over. */
  readonly index: EntityIndexHandle
  /**
   * A short-ID back to the entity it names, or `undefined` when no store can describe it any
   * more. Supplied by the caller so the LEDGER stays the authority — see the file header.
   */
  readonly describe: (shortId: string) => EntityDescriptor | undefined
  /** Test/integration seam; production omission runs denseLeg's automatic acquisition ladder. */
  readonly embedder?: EmbedderPort
}

export interface RankedEntity {
  readonly descriptor: EntityDescriptor
  readonly score: number
}

/**
 * The lexical leg's admission for the ENTITY corpus.
 *
 * Deliberately not `admitCandidate`, and the reason is measured rather than stylistic: that
 * gate's lexical arm is `TAU_LEX`, calibrated from a serving replay over knowledge records,
 * and it rejects every entity candidate outright (see `RESOLVER_LEXICAL_MIN_BM25`). The dense
 * arm's floor is profile-owned and correct anywhere, so the dense leg keeps `admitCandidate`.
 */
function admitLexical(candidate: LegCandidate): boolean {
  return (candidate.rawScores.bm25Positive ?? 0) >= RESOLVER_LEXICAL_MIN_BM25
}

/**
 * Rank the entity corpus against free text, returning describable candidates best-first.
 *
 * Exported because this is the ranking a corpus report reads: a per-case score log is
 * only comparable across postures if it comes from the same call the resolver made.
 */
export async function rankEntityCandidates(
  ref: string,
  deps: ResolveHybridDeps,
): Promise<RankedEntity[]> {
  const { connection } = deps.index
  const lexical = lexicalLeg(connection.db, ref, ENTITY_INDEX_SCOPE, RESOLVER_CANDIDATE_K)
    .filter(admitLexical)

  const tauDense = entityIndexTauDense(deps.index)
  const dense = hasDenseCandidates(connection.db, ENTITY_INDEX_SCOPE)
    ? (await denseLeg(
        connection,
        [ref],
        ENTITY_INDEX_SCOPE,
        RESOLVER_CANDIDATE_K,
        deps.embedder === undefined ? {} : { embedder: deps.embedder },
      )).filter((candidate) => admitCandidate(candidate, { tauDense }))
    : []

  return fuseWeightedRrf([
    { weight: RESOLVER_LEG_WEIGHT_LEXICAL, ranked: lexical },
    { weight: RESOLVER_LEG_WEIGHT_DENSE, ranked: dense },
  ]).flatMap((candidate) => {
    const descriptor = deps.describe(candidate.bundleId)
    return descriptor === undefined
      ? []
      : [{
          descriptor,
          // A rescale by a constant: `fuseWeightedRrf` decided the order, this only puts the
          // number on the [0, 1] scale tier (a) already answers on. Clamped because a score
          // outside its declared range is refused at the schema boundary, and a resolver that
          // threw there would turn a presentation detail into a failed resolution.
          score: Math.min(1, candidate.fusedScore / RESOLVER_FUSED_SCORE_NORMALIZER),
        }]
  })
}

/**
 * The two numbers the D-07 rule is decided against.
 *
 * Parameterised for ONE reason, and it is not configuration: the corpus has to be able
 * to ask where the boundary IS, not merely whether today's value sits on the right side of it.
 * A degradation gate that no input can redden is not a gate, and the only way to show this one
 * can redden is to run the same corpus, through this same function, at a margin below the bound
 * — which is a measurement, not a setting. No production call site passes this argument, the
 * defaults are the pinned constants, and nothing reads a config file to get here.
 */
export interface StrongHitThresholds {
  readonly minScore: number
  readonly margin: number
}

export const RESOLVER_STRONG_HIT_THRESHOLDS: StrongHitThresholds = {
  minScore: RESOLVER_STRONG_HIT_MIN_SCORE,
  margin: RESOLVER_STRONG_HIT_MARGIN,
}

/**
 * The D-07 decision itself, over a ranking somebody else produced.
 *
 * The rule is two-part and BOTH parts must hold — an absolute threshold the winner clears on
 * its own, and a margin over the runner-up. Equal-strength candidates therefore always
 * disambiguate without a special case: a margin of zero is not greater than a positive margin,
 * so the arithmetic refuses before any tie-break could pick a favourite.
 */
export function applyStrongHitRule(
  ranked: readonly RankedEntity[],
  thresholds: StrongHitThresholds = RESOLVER_STRONG_HIT_THRESHOLDS,
): EntityResolution {
  const top = ranked[0]
  if (top === undefined) return { kind: 'none', reason: 'no-match' }

  const runnerUp = ranked[1]?.score ?? 0
  if (top.score >= thresholds.minScore && top.score - runnerUp > thresholds.margin) {
    return { kind: 'resolved', descriptor: top.descriptor, score: top.score }
  }

  // Tier (c). Two candidates minimum, because a "disambiguation" between one option is not a
  // choice — it is a suggestion, and the miss arm is where a suggestion belongs.
  if (ranked.length >= 2) {
    return {
      kind: 'ambiguous',
      candidates: ranked.slice(0, ENTITY_RESOLUTION_MAX_CANDIDATES).map(({ descriptor, score }) => ({
        descriptor,
        score,
      })),
    }
  }

  return { kind: 'none', reason: 'no-match', closestSuggestion: top.descriptor.shortId }
}

/** Tier (b) then tier (c): rank the corpus, then apply the pinned rule to what came back. */
export async function resolveHybrid(
  ref: string,
  deps: ResolveHybridDeps,
): Promise<EntityResolution> {
  return applyStrongHitRule(await rankEntityCandidates(ref, deps))
}
