// Each expected error below fails `pnpm typecheck` if its type returns to the barrel.

import { test } from 'vitest'

test('the standing approval grant, trust credential and trust scope are gone from the barrel', () => {
  // @ts-expect-error the standing-approval grant is deleted
  type RetiredStandingApprovalGrant = import('@vostride/agent-qa-schema').StandingApprovalGrant
  // @ts-expect-error the trust credential is deleted
  type RetiredTrustCredential = import('@vostride/agent-qa-schema').TrustCredential
  // @ts-expect-error the trust scope is deleted
  type RetiredTrustScope = import('@vostride/agent-qa-schema').TrustScope
})
