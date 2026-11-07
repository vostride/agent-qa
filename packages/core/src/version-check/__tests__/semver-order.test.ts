import { describe, expect, it } from 'vitest'
import { compareSemverVersions, semverRangeFloor } from '../index.js'

describe('semver order', () => {
  it('a prerelease orders below its release', () => {
    expect(compareSemverVersions('0.3.4-beta.0', '0.3.4')).toBe(-1)
  })

  it('a release orders above its prerelease', () => {
    expect(compareSemverVersions('0.3.4', '0.3.4-beta.0')).toBe(1)
  })

  it('equal versions compare as 0', () => {
    expect(compareSemverVersions('0.3.3', '0.3.3')).toBe(0)
  })

  it('an invalid version on either side has no order', () => {
    expect(compareSemverVersions('latest', '0.3.3')).toBeUndefined()
    expect(compareSemverVersions('0.3.3', 'file:../agent-qa')).toBeUndefined()
  })
})

describe('semver range floor', () => {
  it("a caret range's floor is its base version", () => {
    expect(semverRangeFloor('^0.3.0')).toBe('0.3.0')
  })

  it("a bounded range's floor is its lower bound", () => {
    expect(semverRangeFloor('>=0.4.0 <1')).toBe('0.4.0')
  })

  it('a tag has no floor', () => {
    expect(semverRangeFloor('latest')).toBeUndefined()
  })
})
