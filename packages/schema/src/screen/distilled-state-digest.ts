// One distilled digest of a screen state, for the staged-feedback provenance check.
// Route + ordered role/name/ordinal is pinned by a literal fixture digest.
// Volatile capture fields never participate; dynamic non-badge names can still drift.
import { canonicalJson } from '../determinism/canonical-json'
import { sha256hex } from '../determinism/sha256'
import { elementOrdinal } from './element-ordinal'
import { normalizeAccessibleName } from './normalize-name'
import type { ScreenState } from './screen-state'

export type DistilledScreenStateInput = Pick<ScreenState, 'platform' | 'elements'> & { url?: string }

export function distilledScreenStateDigest(state: DistilledScreenStateInput): string {
  let route: string | null = null
  if (state.url !== undefined) {
    try {
      const url = new URL(state.url)
      route = (url.origin + url.pathname).replace(/\/$/, '')
    } catch {
      // Missing and non-parseable routes have the same explicit absent identity.
    }
  }
  const elements = state.elements.map((element) => [
    element.role,
    normalizeAccessibleName(element.name),
    elementOrdinal(element, state.elements),
  ])
  return sha256hex(canonicalJson({ platform: state.platform, route, elements }))
}
