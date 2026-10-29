import { describe, expect, it } from 'vitest'

import { computeCacheKey } from '@vostride/agent-qa-schema'
import type { RedactedEnvVar } from '@vostride/agent-qa-schema'

import { buildCacheableStepInput } from '../key.js'

function envVars(name = 'API_KEY'): RedactedEnvVar[] {
  return [{ name, present: true, kind: 'string', lengthBucket: 4 }]
}

interface Overrides {
  platform?: 'web' | 'android' | 'ios'
  suiteConfigDigest?: string
  testConfigDigest?: string
  stepText?: string
  stepIndex?: number
  testIndex?: number
  envVars?: RedactedEnvVar[]
  envSalt?: string
  screenIdentityHash?: string
  branch?: string
}

function keyOf(overrides: Overrides = {}): string {
  return computeCacheKey(
    buildCacheableStepInput({
      platform: overrides.platform ?? 'web',
      suiteConfigDigest: overrides.suiteConfigDigest ?? 'suite',
      testConfigDigest: overrides.testConfigDigest ?? 'test',
      stepText: overrides.stepText ?? 'click the log in button',
      stepIndex: overrides.stepIndex ?? 0,
      testIndex: overrides.testIndex ?? 0,
      envVars: overrides.envVars ?? envVars(),
      envSalt: overrides.envSalt ?? 'salt',
      screenIdentityHash: overrides.screenIdentityHash ?? 'screen-hash',
      // Intentionally supplied but never a key component.
      branch: overrides.branch ?? 'main',
    }),
  )
}

describe('buildCacheableStepInput → computeCacheKey determinism', () => {
  it('the same 8-tuple yields a stable key', () => {
    expect(keyOf()).toBe(keyOf())
  })

  it('perturbing any one of the 8 components changes the key', () => {
    const base = keyOf()
    expect(keyOf({ platform: 'android' })).not.toBe(base)
    expect(keyOf({ suiteConfigDigest: 'suite-2' })).not.toBe(base)
    expect(keyOf({ testConfigDigest: 'test-2' })).not.toBe(base)
    expect(keyOf({ stepText: 'click a different button' })).not.toBe(base)
    expect(keyOf({ stepIndex: 1 })).not.toBe(base)
    expect(keyOf({ testIndex: 1 })).not.toBe(base)
    expect(keyOf({ envVars: envVars('OTHER_KEY') })).not.toBe(base)
    expect(keyOf({ screenIdentityHash: 'screen-hash-2' })).not.toBe(base)
  })

  it('branch is never a key component — the same tuple under two branches yields the same key', () => {
    expect(keyOf({ branch: 'main' })).toBe(keyOf({ branch: 'feature/x' }))
  })
})
