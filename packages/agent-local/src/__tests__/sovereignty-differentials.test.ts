// The schema barrel holds no gate, no standing-approval reader and no grant contract.

import * as schema from '@vostride/agent-qa-schema'
import * as safety from '@vostride/agent-qa-safety'
import { describe, expect, it } from 'vitest'

describe('no gate, standing-approval reader or grant contract remains', () => {
  it('there is no gate, no standing-approval reader and no grant contract to override anything', () => {
    for (const retired of ['evaluate', 'resolveAsk', 'NO_STANDING_APPROVALS', 'DENY_CONFIRM']) {
      expect(Object.keys(safety), retired).not.toContain(retired)
    }
    // Reads the barrel for anything grant-shaped: a type-only contract leaves no runtime key.
    expect(Object.keys(schema).filter((key) => /StandingApproval(Grant|Reader)/.test(key))).toEqual([])
  })
})
