// Sovereignty differential 4 — DENY FINALITY (Phase 391, PROP-05, plan 05) — RE-SPELLED 2026-10-01
// (432-19, D-14/D-15).
//
// spec/v2/qa-agent-and-surfaces.md §5 stated the sovereignty rule as "a grant satisfies an ask but
// never overrides a deny/restricted". This file drove the shipped gate (`evaluate`) with a covering
// standing approval and showed it satisfying an ask on a class while never overriding a `restricted`
// verdict on the identical class, by each of the three routes to `restricted`. 432-18 deleted the
// grant ledger; 432-19 deletes the gate, its ask, its `StandingApprovalReader` port and the
// `StandingApprovalGrant` contract. There is no grant to satisfy anything and no verdict to override,
// so what remains is the absence: no gate, no reader and no grant contract.

import * as schema from '@vostride/agent-qa-schema'
import * as safety from '@vostride/agent-qa-safety'
import { describe, expect, it } from 'vitest'

describe('no gate, standing-approval reader or grant contract remains', () => {
  it('there is no gate, no standing-approval reader and no grant contract to override anything', () => {
    for (const retired of ['evaluate', 'resolveAsk', 'NO_STANDING_APPROVALS', 'DENY_CONFIRM']) {
      expect(Object.keys(safety), retired).not.toContain(retired)
    }
    // The grant contract was type-only, and its runtime footprint (the scope constant) left with the
    // MCP credential in 432-21, so the census reads the barrel for anything grant-shaped instead.
    expect(Object.keys(schema).filter((key) => /StandingApproval(Grant|Reader)/.test(key))).toEqual([])
  })
})
