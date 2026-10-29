// The failure fingerprint: one exported vocabulary.
//
// 390's FLAK-01 windows recurrence over this key and the cluster function groups over it,
// so it is exported ONCE, from here, and the recipe below is part of the contract — changing
// it later re-keys every accumulated fingerprint history. Deliberately a readable
// deterministic string rather than a hash: the cluster DTO carries the fingerprint value
// and a reader owed an explanation should be able to see what the key says.
//
// THE RECIPE (contract, not implementation detail):
//   1. Select one anchor deterministically — the FIRST element-kind anchor in `anchors`,
//      else the FIRST page-kind anchor, else mint `{t: 'error', message: errorText ?? ''}`.
//   2. Normalize the selection through `normalizeAnchor` — the shape-locked contract whose
//      'error' arm already collapses digit runs to '#', which is what makes two timeouts
//      differing only in milliseconds one recurrence.
//   3. Key = `canonicalJson(normalized)` joined to the verdict class with `::` — the
//      emit-canary-outcomes normalizedKey idiom, extended by the class because the same
//      anchor failing as a flake and failing as an app bug are two facts, not one.

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

/**
 * Deterministic, byte-stable fingerprint for one failure.
 *
 * Total: every failure keys, including anchorless ones — an empty anchor list with no error
 * text still yields the normalized empty-message error key rather than a refusal. Two
 * identical `(anchors, class)` inputs produce byte-identical keys across processes, because
 * every step of the recipe is pure over its arguments.
 */
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
