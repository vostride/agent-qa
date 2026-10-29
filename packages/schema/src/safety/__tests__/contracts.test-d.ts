import { expectTypeOf } from 'vitest'
import type { ExecutionContext } from '../../index'

// 2026-10-01. The exact-shape pin on `ExecutionPolicyResult` (verdict, reason, tier,
// remedies, neutral reason) and its three invalid-member cells retire with the gate: the result, its
// `PolicyVerdict` and the remedy vocabulary are deleted, and each is now a type a consumer cannot
// name.

// @ts-expect-error the execution-policy result is deleted
export type RetiredExecutionPolicyResult = import('../../index').ExecutionPolicyResult
// @ts-expect-error the allow/ask/deny verdict is deleted
export type RetiredPolicyVerdict = import('../../index').PolicyVerdict

// the hook-result, scan and masking-context pins are deleted with
// their contracts.
expectTypeOf<ExecutionContext>().toEqualTypeOf<'local-interactive' | 'local-headless' | 'ci' | 'cloud'>()

// C432-NO-TRUST-CONTRACT. The trust-scope wire projection leaves with
// the run-service token DTO it parsed for; the caller types and their key set stay until 432-39.
// @ts-expect-error the trust-scope projection is deleted from the safety barrel
export type RetiredSafetyTrustScopeSchema = typeof import('../index').TrustScopeSchema
// @ts-expect-error and from the root barrel
export type RetiredRootTrustScopeSchema = typeof import('../../index').TrustScopeSchema
// @ts-expect-error no barrel exports the scope key type
export type RetiredRootTrustScopeKey = import('../../index').TrustScopeKey
// @ts-expect-error nor the safety barrel
export type RetiredSafetyTrustScopeKey = import('../index').TrustScopeKey
