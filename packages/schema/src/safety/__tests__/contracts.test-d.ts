import { expectTypeOf, test } from 'vitest'
import type { ExecutionContext } from '../../index'

test('the execution policy result and the allow, ask, deny verdict are gone', () => {
  // @ts-expect-error the execution-policy result is deleted
  type RetiredExecutionPolicyResult = import('../../index').ExecutionPolicyResult
  // @ts-expect-error the allow/ask/deny verdict is deleted
  type RetiredPolicyVerdict = import('../../index').PolicyVerdict
})

test('the execution context is one of four values', () => {
  expectTypeOf<ExecutionContext>().toEqualTypeOf<'local-interactive' | 'local-headless' | 'ci' | 'cloud'>()
})

test('the trust scope schema and key are gone from both barrels', () => {
  // @ts-expect-error the trust-scope projection is deleted from the safety barrel
  type RetiredSafetyTrustScopeSchema = typeof import('../index').TrustScopeSchema
  // @ts-expect-error and from the root barrel
  type RetiredRootTrustScopeSchema = typeof import('../../index').TrustScopeSchema
  // @ts-expect-error no barrel exports the scope key type
  type RetiredRootTrustScopeKey = import('../../index').TrustScopeKey
  // @ts-expect-error nor the safety barrel
  type RetiredSafetyTrustScopeKey = import('../index').TrustScopeKey
})
