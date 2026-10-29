import type { GoldAnchorDescriptor } from '../cassette/sidecar-leg'
import type { IdentityLadderLevel } from './config'

type ResolvedAnchor = {
  role: string
  nameNormalized: string
  ordinal: number
}

// The optional recorded ref is evidence only and never part of cross-run identity.
export function anchorsEqual(a: ResolvedAnchor, b: GoldAnchorDescriptor): boolean {
  return (
    a.role === b.role &&
    a.nameNormalized === b.nameNormalized &&
    a.ordinal === b.ordinal
  )
}

// Ordinal is a same-screen tiebreaker, so an ordinal-only difference is a partial match.
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
