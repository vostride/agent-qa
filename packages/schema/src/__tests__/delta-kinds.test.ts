import { describe, expect, it } from 'vitest'
import { DELTA_KINDS } from '../delta/delta'

// A member cast into this list passes the type bar in `delta.test-d.ts` and fails only here.

const SIX_SHIPPED_KINDS = ['Add', 'Confirm', 'Supersede', 'Deprecate', 'MintUnknown', 'Noop']

describe('the §7.3 delta vocabulary', () => {
  it('declares exactly the six §7.3 delta kinds, in declaration order', () => {
    // Declaration order, not sorted: `DELTA_KINDS` is an authored array, so the order is part of
    // what it claims. Listed rather than counted so the RED says WHAT joined or left.
    expect([...DELTA_KINDS]).toEqual(SIX_SHIPPED_KINDS)
  })
})
