import { canonicalJson } from '../determinism/canonical-json'
import { sha256hex } from '../determinism/sha256'
import { asEvidenceToken, type EvidenceToken } from '../ids/record-id'
import type { Anchor } from '../identity/anchor'
import { normalizeAnchor } from '../identity/normalize-anchor'

// A confirm without a fresh token is a no-op; tokens are derived by code, never by the model.
export function deriveEvidenceToken(input: {
  attributingObservationId: string
  anchor: Anchor
  buildOrdinal: number
}): EvidenceToken {
  return asEvidenceToken(
    sha256hex(
      canonicalJson([
        input.attributingObservationId,
        normalizeAnchor(input.anchor),
        input.buildOrdinal,
      ]),
    ),
  )
}
