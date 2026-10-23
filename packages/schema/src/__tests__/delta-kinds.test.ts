import { describe, expect, it } from 'vitest'
import { DELTA_KINDS } from '../delta/delta'

/**
 * The runtime wall on the SURVIVING §7.3 delta vocabulary (409 D-04, "two walls, both read").
 * It pins `DELTA_KINDS` — the authored projection of `Delta` — against a literal list. The
 * companion type-level bar `Extract<Delta, { kind: 'FileIssue' }>` is `never` lives in
 * `delta.test-d.ts` and `seam-root.test-d.ts`; a member widened into this projection through a
 * cast satisfies the compiler, walks past that bar and REDs only here, by name. Both halves are
 * measured by hand-mutation: 409-MUTATION-LEDGER.md Rows 4 and 5.
 *
 * WHAT THIS CELL IS NOT. It is not a wall around the delta vocabulary the Issue-slot cleanup
 * DELETED. `Delta` and `DELTA_KINDS` are byte-identical across Phase 409, and the deleted
 * vocabulary's arms belonged to that vocabulary's own union rather than to `Delta`, so neither
 * half of D-04 changes state when the deleted vocabulary returns. That is measured rather than
 * argued: under a complete readmission this suite exits 0 with "Type Errors no errors", recorded
 * in 409-MUTATION-LEDGER.md Rows 10-13. The instrument that carries VOCB-01/VOCB-02 is the
 * lexical deletion census, `packages/arch/src/__tests__/412-issue-slot-deleted.test.ts`, whose
 * four vocabulary/brand cells RED by name under that same mutation.
 *
 * 2026-09-01 (Phase 409): the second delta vocabulary left with the Issue-slot cleanup.
 *
 * 2026-09-03 (Phase 412): the three per-phase census cells merged into one.
 */

const SIX_SHIPPED_KINDS = ['Add', 'Confirm', 'Supersede', 'Deprecate', 'MintUnknown', 'Noop']

describe('the §7.3 delta vocabulary (D-04 runtime wall)', () => {
  it('declares exactly the six §7.3 delta kinds, in declaration order', () => {
    // Declaration order, not sorted: `DELTA_KINDS` is an authored array, so the order is part of
    // what it claims. Listed rather than counted so the RED says WHAT joined or left.
    expect([...DELTA_KINDS]).toEqual(SIX_SHIPPED_KINDS)
  })
})
