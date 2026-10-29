// Total over `BundleStatus` with no fallback arm, so a new status is a type error, not a guess.

import { ENTITY_STATUSES } from '@vostride/agent-qa-schema'
import type { BundleStatus } from '@vostride/agent-qa-schema'

/** The `MEM` card vocabulary, drawn off the schema's own table rather than respelled. */
export type MemoryCardStatus = (typeof ENTITY_STATUSES)['MEM'][number]

// Also the runtime enumeration of `BundleStatus`, which the schema declares as a type only.
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
