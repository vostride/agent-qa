// Readable, not hashed; changing the recipe re-keys every accumulated fingerprint history.

import { canonicalJson } from '../determinism/canonical-json'
import type { Anchor } from '../identity/anchor'
import { normalizeAnchor } from '../identity/normalize-anchor'
import type { Verdict } from './verdict'

/** What a failure offers the fingerprint: its exercised anchors, and its error text. */
export interface FailureFingerprintInput {
  readonly anchors: readonly Anchor[]
  /** The error-signature fallback source for anchorless failures. Absent means ''. */
  readonly errorText?: string
}

// Total: an empty anchor list with no error text still keys as the empty-message error.
export function failureFingerprint(
  input: FailureFingerprintInput,
  verdictClass: Verdict['class'],
): string {
  const selected =
    input.anchors.find((anchor) => anchor.t === 'el')
    ?? input.anchors.find((anchor) => anchor.t === 'page')
    ?? { t: 'error' as const, message: input.errorText ?? '' }
  return `${canonicalJson(normalizeAnchor(selected))}::${verdictClass}`
}
