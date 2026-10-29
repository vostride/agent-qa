import { describe, expect, it } from 'vitest'

import { shouldWrite, type CachePolicy } from '../write-policy.js'

function policy(overrides: Partial<CachePolicy> = {}): CachePolicy {
  return {
    currentBranch: 'main',
    defaultBranch: 'main',
    protectedBranches: ['main'],
    isCI: false,
    saveCache: false,
    disableCache: false,
    ...overrides,
  }
}

describe('shouldWrite truth table', () => {
  it('is false when disableCache is set, regardless of other flags', () => {
    expect(
      shouldWrite(policy({ disableCache: true, saveCache: true, isCI: true, currentBranch: 'x' })),
    ).toBe(false)
  })

  it('is false on a protected branch when neither saveCache nor CI', () => {
    expect(shouldWrite(policy({ currentBranch: 'main', protectedBranches: ['main'] }))).toBe(false)
  })

  it('is true on a protected branch when saveCache is set', () => {
    expect(
      shouldWrite(policy({ currentBranch: 'main', protectedBranches: ['main'], saveCache: true })),
    ).toBe(true)
  })

  it('is true on a protected branch when running in CI', () => {
    expect(
      shouldWrite(policy({ currentBranch: 'main', protectedBranches: ['main'], isCI: true })),
    ).toBe(true)
  })

  it('is true on a non-protected (feature) branch', () => {
    expect(
      shouldWrite(policy({ currentBranch: 'feature-x', protectedBranches: ['main', 'master'] })),
    ).toBe(true)
  })

  it('treats every configured protected branch as protected', () => {
    expect(
      shouldWrite(policy({ currentBranch: 'release/1.0', protectedBranches: ['main', 'release/1.0'] })),
    ).toBe(false)
  })
})
