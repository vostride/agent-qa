import { describe, it, expect } from 'vitest'
import { formatTokens } from '../lib/format.js'

describe('formatTokens', () => {
  it('formats zero', () => {
    expect(formatTokens(0)).toBe('0')
  })
  it('formats small numbers without commas', () => {
    expect(formatTokens(42)).toBe('42')
    expect(formatTokens(999)).toBe('999')
  })
  it('formats thousands with compact notation', () => {
    expect(formatTokens(1000)).toBe('1K')
    expect(formatTokens(1234)).toBe('1.2K')
  })
  it('formats millions with compact notation', () => {
    expect(formatTokens(1234567)).toBe('1.2M')
  })
})
