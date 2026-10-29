// Each expected error below fails `pnpm typecheck` if its type returns to the barrel.

// @ts-expect-error the standing-approval grant is deleted
export type RetiredStandingApprovalGrant = import('@vostride/agent-qa-schema').StandingApprovalGrant
// @ts-expect-error the trust credential is deleted
export type RetiredTrustCredential = import('@vostride/agent-qa-schema').TrustCredential
// @ts-expect-error the trust scope is deleted
export type RetiredTrustScope = import('@vostride/agent-qa-schema').TrustScope
