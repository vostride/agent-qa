// Curator writes and retrieval collapse share this helper, so both use one anchor identity.
import { canonicalJson } from '../determinism/canonical-json'
import { sha256hex } from '../determinism/sha256'
import type { Anchor } from './anchor'
import { normalizeAnchor } from './normalize-anchor'

/** Hashes a normalized anchor set without mutating the caller's array. */
export function supersessionKey(anchors: readonly Anchor[]): string {
  const sortedNormalized = anchors.map(normalizeAnchor)
  sortedNormalized.sort((left, right) => {
    const leftJson = canonicalJson(left)
    const rightJson = canonicalJson(right)
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0
  })

  return sha256hex(canonicalJson(sortedNormalized))
}
