import { describe, expect, it } from 'vitest'
import { normalizeAccessibleName } from '../index'

describe('normalizeAccessibleName', () => {
  it('dynamic count drift collapses to one identity', () => {
    expect(normalizeAccessibleName('Cart (3)')).toBe(normalizeAccessibleName('Cart (0)'))
    expect(normalizeAccessibleName('Cart (3)')).toBe('cart')
  })

  it.each([
    ['  Sign   In  ', 'sign in'],     // trim + internal collapse
    ['Cart (3)', 'cart'],             // parenthesized count
    ['Cart ( 12 )', 'cart'],          // spaced parenthesized count
    ['Notifications [9]', 'notifications'], // bracketed count
    ['Messages •', 'messages'],       // bullet badge
    ['Inbox 5', 'inbox'],             // bare trailing integer (documented choice)
    ['SIGN IN', 'sign in'],           // case-fold
    ['', ''],                          // total: empty in → empty out
    ['   ', ''],                       // whitespace-only
  ])('normalizes %j → %j', (input, expected) => {
    expect(normalizeAccessibleName(input)).toBe(expected)
  })

  it('is idempotent', () => {
    const once = normalizeAccessibleName('Cart (3)')
    expect(normalizeAccessibleName(once)).toBe(once)
  })
})
