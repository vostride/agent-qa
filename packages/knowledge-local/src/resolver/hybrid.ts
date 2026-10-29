// No scoring here: the never-guess decision sits on a ranking the legs and the fusion compute.

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
  // The entity index projection this ranks over.
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

// Exported so the corpus report reads the same ranking the resolver uses.
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

// Parameterised only so the corpus can probe the boundary; production passes the pinned defaults.
export interface StrongHitThresholds {
  readonly minScore: number
  readonly margin: number
}

export const RESOLVER_STRONG_HIT_THRESHOLDS: StrongHitThresholds = {
  minScore: RESOLVER_STRONG_HIT_MIN_SCORE,
  margin: RESOLVER_STRONG_HIT_MARGIN,
}

// Both parts must hold, so equal-strength candidates always disambiguate: zero margin never clears.
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
