import { describe, it, expect } from 'vitest'
import { isCanonicalSuiteId } from '@vostride/agent-qa-ids'
import { generateSuiteId } from '../generate-suite-id.js'

describe('generateSuiteId', () => {
  it('matches the canonical shared suite-id contract', () => {
    for (let i = 0; i < 50; i++) {
      expect(isCanonicalSuiteId(generateSuiteId())).toBe(true)
    }
  })

  it('is not deterministic (produces diverse values across 100 calls)', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) ids.add(generateSuiteId())
    // crypto.getRandomValues should give near-100 unique values
    expect(ids.size).toBeGreaterThanOrEqual(95)
  })
})
