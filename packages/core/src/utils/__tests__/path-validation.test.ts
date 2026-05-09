import { describe, it, expect } from 'vitest'
import { isPathInsideDir } from '../path-validation.js'

describe('isPathInsideDir', () => {
  it('returns true for valid relative path', () => {
    expect(isPathInsideDir('tests/foo.yaml', '/root')).toBe(true)
  })

  it('returns false for ../ escape', () => {
    expect(isPathInsideDir('../etc/passwd', '/root')).toBe(false)
  })

  it('returns false for embedded traversal', () => {
    expect(isPathInsideDir('foo/../../etc/passwd', '/root')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isPathInsideDir('', '/root')).toBe(false)
  })

  it('returns false for absolute path input', () => {
    expect(isPathInsideDir('/etc/passwd', '/root')).toBe(false)
  })
})
