import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { generatePKCE, generateState } from '../auth/pkce.js'

describe('PKCE', () => {
  it('generates verifier between 43 and 128 chars', () => {
    const { verifier } = generatePKCE()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
  })

  it('generates base64url verifier (no +, /, =)', () => {
    const { verifier } = generatePKCE()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('generates challenge as SHA-256 of verifier in base64url', () => {
    const { verifier, challenge } = generatePKCE()
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
  })

  it('generates different values on each call', () => {
    const a = generatePKCE()
    const b = generatePKCE()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).not.toBe(b.challenge)
  })
})

describe('generateState', () => {
  it('produces a 32-char hex string', () => {
    const state = generateState()
    expect(state).toHaveLength(32)
    expect(state).toMatch(/^[0-9a-f]{32}$/)
  })

  it('produces different values on each call', () => {
    const a = generateState()
    const b = generateState()
    expect(a).not.toBe(b)
  })
})
