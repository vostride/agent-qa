import { expectTypeOf } from 'vitest'
import type { ExecutionContext } from '../../index'

// @ts-expect-error the execution-policy result is deleted
export type RetiredExecutionPolicyResult = import('../../index').ExecutionPolicyResult
// @ts-expect-error the allow/ask/deny verdict is deleted
export type RetiredPolicyVerdict = import('../../index').PolicyVerdict

expectTypeOf<ExecutionContext>().toEqualTypeOf<'local-interactive' | 'local-headless' | 'ci' | 'cloud'>()

// @ts-expect-error the trust-scope projection is deleted from the safety barrel
export type RetiredSafetyTrustScopeSchema = typeof import('../index').TrustScopeSchema
// @ts-expect-error and from the root barrel
export type RetiredRootTrustScopeSchema = typeof import('../../index').TrustScopeSchema
// @ts-expect-error no barrel exports the scope key type
export type RetiredRootTrustScopeKey = import('../../index').TrustScopeKey
// @ts-expect-error nor the safety barrel
export type RetiredSafetyTrustScopeKey = import('../index').TrustScopeKey
