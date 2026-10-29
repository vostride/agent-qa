// The ONE bundle-status → MEM card-status mapping.
//
// WHY THIS IS A MODULE AND NOT TWO PRIVATE TABLES
//
// It was two private tables, and they disagreed. The resolver's copy named three strings, two
// of which (`withdrawn`, `retired`) are not members of `BundleStatus` at all, and it omitted
// `deprecated` — the status every forget and every reject actually produces. Its reachable
// domain was therefore a single member, so after a forget the resolver-path card said `active`
// while the receipt handed to the same caller in the same operation said `tombstoned`. That is
// CR-04, and it falsifies D-04's "permanent address, honest status" on the one transition this
// phase's own destructive verb creates.
//
// The root-cause shape is worth naming because it decides this module's design: a table scoped
// to hand-picked members of a set whose hazard belongs to the WHOLE set. So the fix is not
// "add `deprecated`" — it is a mapping the compiler forces to be TOTAL over the complete union,
// and a regression case that walks the complete union rather than the member that failed.
//
// TOTAL, AND TOTAL TWICE OVER
//
// `satisfies Record<BundleStatus, …>` is the 387-07 key-facts table pattern applied to
// statuses: a fifth `BundleStatus` member becomes a type error HERE rather than a card that
// silently renders a generic status, and an entry naming something outside the union is a type
// error too — which is exactly what would have rejected `withdrawn` and `retired` on the day
// they were written. There is deliberately NO fallback arm. A silent default is what made two
// dead members and one missing member invisible for the life of the defect; an unknown status
// must be loud.
//
// This module is package-internal on purpose and is NOT re-exported through the package
// barrel. Its two consumers — the resolver's MEM sighting source, and the review apply path in
// `review/apply-review.ts` (swapped by plan 387-12) — both live inside `knowledge-local`, and
// a barrel export would invite a third vocabulary consumer outside the package, which is the
// one-producer discipline D-12 exists to keep.

import { ENTITY_STATUSES } from '@vostride/agent-qa-schema'
import type { BundleStatus } from '@vostride/agent-qa-schema'

/** The `MEM` card vocabulary, drawn off the schema's own table rather than respelled. */
export type MemoryCardStatus = (typeof ENTITY_STATUSES)['MEM'][number]

/**
 * Every `BundleStatus`, and what a `MEM` card says about it.
 *
 * `candidate` maps to `active` rather than to a third thing because the `MEM` vocabulary has no
 * word for "proposed but not yet promoted": a candidate record exists, is addressable and is
 * not tombstoned, and `active` is the honest card answer for it. `superseded` and `deprecated`
 * both mean the thing this address names stopped standing, which is precisely what
 * `tombstoned` reports.
 *
 * `forgotten` is a legal `MEM` status that nothing here produces, and that is correct rather
 * than an omission: it is the D-19 forget receipt's word, applied at the card producer when a
 * receipt is in hand, and a bundle status never derives it.
 *
 * This table is also the RUNTIME enumeration of `BundleStatus` — the schema declares that union
 * as a type only, with no runtime array beside it — so a walk of these keys is a walk of the
 * union.
 */
export const MEMORY_STATUS_BY_BUNDLE_STATUS = {
  active: 'active',
  candidate: 'active',
  superseded: 'tombstoned',
  deprecated: 'tombstoned',
} as const satisfies Record<BundleStatus, MemoryCardStatus>

/** A status no `BundleStatus` names reached the mapping. Loud by design — never `active`. */
export class UnknownBundleStatusError extends TypeError {
  constructor(readonly status: string) {
    super(
      `no MEM card status is declared for bundle status ${JSON.stringify(status)}; `
      + `the declared bundle statuses are ${Object.keys(MEMORY_STATUS_BY_BUNDLE_STATUS)
        .sort()
        .join(', ')}`,
    )
    this.name = 'UnknownBundleStatusError'
  }
}

/**
 * The MEM card status for a bundle status. TOTAL — no fallback arm.
 *
 * The parameter stays `BundleStatus` rather than widening to `string`, and the choice is the
 * whole protection this module exists to give. Both production call sites already hold a
 * `BundleStatus` (`listBundles` sets `status` from `deriveBundleTrust`, and `locateRecord` in
 * the review apply path does the same), so a narrow parameter makes a fifth union member a
 * COMPILE error at every call site. Widening to `string` would buy a reachable throw arm at the
 * cost of that compile-time totality, which is trading the guarantee for the backstop.
 *
 * The runtime `Object.hasOwn` check therefore guards a boundary the type system cannot see
 * through — a status that arrives from a deserialized projection row or a DTO round-trip
 * through a cast. It throws rather than defaulting because the silent default is the defect.
 */
export function memoryStatusForBundle(status: BundleStatus): MemoryCardStatus {
  if (!Object.hasOwn(MEMORY_STATUS_BY_BUNDLE_STATUS, status)) {
    throw new UnknownBundleStatusError(status)
  }
  return MEMORY_STATUS_BY_BUNDLE_STATUS[status]
}
