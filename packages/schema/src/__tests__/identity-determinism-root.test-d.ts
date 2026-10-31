import { expectTypeOf, test } from 'vitest'
import {
  computeCacheKey,
  relevantEnvDigest,
  screenIdentityHash,
  screenStateHash,
  sha256hex,
  sha256hex16,
} from '../index'
import type {
  Anchor,
  CacheableStepInput,
  CacheKey,
  NonCacheableStepInput,
  RedactedEnvVar,
  ScopeKey,
  ScopeTier,
  ScreenState,
} from '../index'

test('the root barrel exports the scope and anchor vocabularies', () => {
  expectTypeOf<ScopeTier>().toEqualTypeOf<'global' | 'product' | 'suite' | 'test'>()
  expectTypeOf<ScopeKey>().toMatchTypeOf<{ tier: ScopeTier; key: string }>()
  expectTypeOf<Extract<Anchor, { t: 'platform' }>['platform']>().toEqualTypeOf<'web' | 'android' | 'ios'>()
})

test('the root barrel hash, digest and cache key functions have fixed signatures', () => {
  expectTypeOf(sha256hex).parameter(0).toEqualTypeOf<string>()
  expectTypeOf(sha256hex).returns.toEqualTypeOf<string>()
  expectTypeOf(sha256hex16).parameter(0).toEqualTypeOf<string>()
  expectTypeOf(sha256hex16).returns.toEqualTypeOf<string>()

  expectTypeOf(screenIdentityHash).parameter(0).toEqualTypeOf<ScreenState>()
  expectTypeOf(screenIdentityHash).returns.toEqualTypeOf<string>()
  expectTypeOf(screenStateHash).parameter(0).toEqualTypeOf<ScreenState>()
  expectTypeOf(screenStateHash).returns.toEqualTypeOf<string>()

  expectTypeOf(relevantEnvDigest).parameter(0).toEqualTypeOf<readonly RedactedEnvVar[]>()
  expectTypeOf(relevantEnvDigest).parameter(1).toEqualTypeOf<string>()
  expectTypeOf(relevantEnvDigest).returns.toEqualTypeOf<string>()

  expectTypeOf(computeCacheKey).parameter(0).toEqualTypeOf<CacheableStepInput>()
  expectTypeOf(computeCacheKey).returns.toEqualTypeOf<CacheKey>()
})

test('an env-touching step is not cacheable through the root barrel', () => {
  const envStep: NonCacheableStepInput = {
    cacheable: false,
    reason: 'reads-env',
  }

  // @ts-expect-error env-touching steps remain non-cacheable through the root barrel.
  computeCacheKey(envStep)
})
