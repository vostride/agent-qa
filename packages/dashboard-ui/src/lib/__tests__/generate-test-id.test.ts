import { describe, it, expect } from 'vitest'
import { isCanonicalTestId } from '@vostride/agent-qa-ids'
import { generateTestId } from '../generate-test-id.js'

describe('generateTestId', () => {
  it('matches the canonical shared test-id contract', () => {
    const id = generateTestId()
    expect(isCanonicalTestId(id)).toBe(true)
  })

  it('generated ID has 10 hyphen-separated words after the prefix', () => {
    const id = generateTestId()
    const body = id.slice(2)
    const words = body.split('-')
    expect(words).toHaveLength(10)
  })

  it('two consecutive calls produce different IDs', () => {
    const id1 = generateTestId()
    const id2 = generateTestId()
    expect(id1).not.toBe(id2)
  })
})
