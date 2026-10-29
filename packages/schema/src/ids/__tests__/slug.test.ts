import { describe, expect, it } from 'vitest'

import { slugBranch } from '../slug'

describe('slugBranch traversal-safe path segment', () => {
  it.each([
    ['feature/login', 'feature-login'],
    ['feature/foo\\bar', 'feature-foo-bar'],
    ['../../etc/passwd', 'etc-passwd'],
  ])('collapses path separators in %j to %j', (input, expected) => {
    expect(slugBranch(input)).toBe(expected)
  })

  it.each([
    ['', 'default'],
    ['.', 'default'],
    ['..', 'default'],
    ['/', 'default'],
    ['///', 'default'],
    ['...', 'default'],
  ])('maps unsafe empty or dot-only input %j to %j', (input, expected) => {
    const slug = slugBranch(input)
    expect(slug).toBe(expected)
    expect(slug).not.toBe('.')
    expect(slug).not.toBe('..')
  })

  it('strips control characters before forming the segment', () => {
    expect(slugBranch(`feat${String.fromCharCode(7)}ure`)).toBe('feature')
  })

  it('replaces disallowed characters and strips unsafe edge punctuation', () => {
    expect(slugBranch('--.feat with@chars.-')).toBe('feat-with-chars')
  })

  it('preserves ordinary dots, underscores, and dashes', () => {
    expect(slugBranch('release_1-1.2.x')).toBe('release_1-1.2.x')
  })
})
