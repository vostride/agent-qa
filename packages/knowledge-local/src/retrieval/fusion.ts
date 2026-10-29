import {
  C_RRF,
  EXPANSION_DISCOUNT_WEIGHT,
  EXPANSION_FRACTION_F,
  TAU_LEX,
} from './constants.js'

export type CandidateSource = 'direct' | 'expanded'

export interface CandidateRawScores {
  readonly bm25Positive?: number
  readonly cosine?: number
  readonly anchorExact?: boolean
}

export interface FusionCandidate {
  readonly bundleId: string
  readonly source: CandidateSource
  readonly legRanks: Readonly<Record<string, number>>
  readonly rawScores: CandidateRawScores
}

export interface AdmissionFloors {
  readonly tauDense: number
}

export interface WeightedRrfLeg<T extends FusionCandidate = FusionCandidate> {
  readonly weight: number
  readonly ranked: readonly T[]
}

export type FusedCandidate<T extends FusionCandidate = FusionCandidate> = Omit<
  T,
  'source' | 'legRanks' | 'rawScores'
> & {
  readonly source: CandidateSource
  readonly legRanks: Readonly<Record<string, number>>
  readonly rawScores: CandidateRawScores
  readonly fusedScore: number
}

interface FusionAccumulator<T extends FusionCandidate> {
  base: T
  source: CandidateSource
  legRanks: Record<string, number>
  rawScores: {
    bm25Positive?: number
    cosine?: number
    anchorExact?: boolean
  }
  fusedScore: number
}

function compareBundleIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function mergeRawScores(
  target: FusionAccumulator<FusionCandidate>['rawScores'],
  incoming: CandidateRawScores,
): void {
  if (incoming.bm25Positive !== undefined) {
    target.bm25Positive = Math.max(target.bm25Positive ?? -Infinity, incoming.bm25Positive)
  }
  if (incoming.cosine !== undefined) {
    target.cosine = Math.max(target.cosine ?? -Infinity, incoming.cosine)
  }
  if (incoming.anchorExact !== undefined) {
    target.anchorExact = (target.anchorExact ?? false) || incoming.anchorExact
  }
}

export function admitCandidate(
  candidate: Pick<FusionCandidate, 'rawScores'>,
  floors: AdmissionFloors,
): boolean {
  const { anchorExact, bm25Positive, cosine } = candidate.rawScores
  return (
    anchorExact === true ||
    (cosine !== undefined && cosine >= floors.tauDense) ||
    (bm25Positive !== undefined && bm25Positive >= TAU_LEX)
  )
}

// Expanded contributions take the fixed discount; final ties break on bundle identity.
export function fuseWeightedRrf<T extends FusionCandidate>(
  legs: readonly WeightedRrfLeg<T>[],
): FusedCandidate<T>[] {
  const byBundle = new Map<string, FusionAccumulator<T>>()

  for (const leg of legs) {
    const seenInLeg = new Set<string>()
    for (const [index, candidate] of leg.ranked.entries()) {
      if (seenInLeg.has(candidate.bundleId)) continue
      seenInLeg.add(candidate.bundleId)

      const contributionWeight =
        candidate.source === 'expanded'
          ? leg.weight * EXPANSION_DISCOUNT_WEIGHT
          : leg.weight
      const contribution = contributionWeight / (C_RRF + index + 1)
      const current = byBundle.get(candidate.bundleId)

      if (current === undefined) {
        byBundle.set(candidate.bundleId, {
          base: candidate,
          source: candidate.source,
          legRanks: { ...candidate.legRanks },
          rawScores: { ...candidate.rawScores },
          fusedScore: contribution,
        })
        continue
      }

      current.fusedScore += contribution
      Object.assign(current.legRanks, candidate.legRanks)
      mergeRawScores(current.rawScores, candidate.rawScores)
      if (candidate.source === 'direct' && current.source === 'expanded') {
        current.base = candidate
        current.source = 'direct'
      }
    }
  }

  return [...byBundle.values()]
    .map(
      (entry) =>
        ({
          ...entry.base,
          source: entry.source,
          legRanks: entry.legRanks,
          rawScores: entry.rawScores,
          fusedScore: entry.fusedScore,
        }) as FusedCandidate<T>,
    )
    .sort(
      (left, right) =>
        right.fusedScore - left.fusedScore ||
        compareBundleIds(left.bundleId, right.bundleId),
    )
}

// Keeps every direct candidate and at most `ceil(f*N)` expanded ones; `retrieve()` owns the top N.
export function capExpansion<T extends Pick<FusionCandidate, 'source'>>(
  fused: readonly T[],
  n: number,
): T[] {
  const resultBudget = Math.max(0, Math.floor(n))
  const expansionBudget = Math.ceil(EXPANSION_FRACTION_F * resultBudget)
  const retained: T[] = []
  let expandedCount = 0

  for (const candidate of fused) {
    if (candidate.source === 'expanded') {
      if (expandedCount >= expansionBudget) continue
      expandedCount += 1
    }
    retained.push(candidate)
  }

  return retained
}
