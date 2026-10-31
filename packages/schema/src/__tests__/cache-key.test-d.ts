import { expectTypeOf, test } from 'vitest'
import { computeCacheKey } from '../determinism/cache-key'
import type { CacheableStepInput, CacheKey, NonCacheableStepInput } from '../determinism/cache-key'

test('a cache key comes only from a cacheable step and is a branded string', () => {
  const cacheableInput: CacheableStepInput = {
    platform: 'web',
    suiteConfigDigest: 'suite-digest',
    testConfigDigest: 'test-digest',
    stepText: 'Click the Save button',
    stepIndex: 1,
    testIndex: 0,
    relevantEnvDigest: 'env-digest',
    screenIdentityHash: 'screen-identity',
  }

  const envStep: NonCacheableStepInput = {
    cacheable: false,
    reason: 'reads-env',
  }

  expectTypeOf(computeCacheKey).parameter(0).toEqualTypeOf<CacheableStepInput>()
  expectTypeOf(computeCacheKey).returns.toEqualTypeOf<CacheKey>()
  expectTypeOf(computeCacheKey(cacheableInput)).toEqualTypeOf<CacheKey>()

  // @ts-expect-error env-touching steps are structurally non-cacheable
  computeCacheKey(envStep)

  // @ts-expect-error raw strings are not cache keys
  const rawKey: CacheKey = 'cache-key'

  const key = computeCacheKey(cacheableInput)
  const stringValue: string = key

  void rawKey
  void stringValue
})
