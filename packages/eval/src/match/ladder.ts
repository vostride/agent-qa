import type { GoldAnchorDescriptor } from '../cassette/sidecar-leg'
import type { IdentityLadderLevel } from './config'

type ResolvedAnchor = {
  role: string
  nameNormalized: string
  ordinal: number
}

/**
 * Compare one resolved candidate target with recorded gold identity evidence. The optional
 * recorded ref is evidence only and never participates in cross-run identity.
 */
export function anchorsEqual(a: ResolvedAnchor, b: GoldAnchorDescriptor): boolean {
  return (
    a.role === b.role &&
    a.nameNormalized === b.nameNormalized &&
    a.ordinal === b.ordinal
  )
}

/**
 * Classify D-02 element identity through the named discrete ladder without continuous name
 * blending. Equivalence members grant only full membership; every partial rung compares with
 * the gold anchor itself. Ordinal is a same-screen tiebreaker, never cross-run identity, so an
 * ordinal-only difference remains a partial match rather than a miss.
 */
export function classifyAnchorLadder(
  candidateTarget: ResolvedAnchor,
  goldAnchor: GoldAnchorDescriptor,
  equivalenceSet: readonly GoldAnchorDescriptor[],
): IdentityLadderLevel {
  if (
    anchorsEqual(candidateTarget, goldAnchor) ||
    equivalenceSet.some(member => anchorsEqual(candidateTarget, member))
  ) {
    return 'full'
  }

  const roleMatches = candidateTarget.role === goldAnchor.role
  const nameMatches = candidateTarget.nameNormalized === goldAnchor.nameNormalized

  if (roleMatches && nameMatches) return 'ordinal-only-differs'
  if (roleMatches) return 'role-matches-name-differs'
  if (nameMatches) return 'name-matches-role-differs'
  return 'miss'
}
