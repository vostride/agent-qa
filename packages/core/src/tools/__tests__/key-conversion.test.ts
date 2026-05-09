import { describe, it, expect } from 'vitest'
import { convertKeysForPlatform, isMacPlatform } from '../actions/key-conversion.js'

describe('convertKeysForPlatform', () => {
  describe('non-Mac + enabled=true', () => {
    it('converts bare Meta → Control', () => {
      expect(convertKeysForPlatform(['Meta'], { enabled: true, isMac: false }))
        .toEqual(['Control'])
    })

    it('converts Meta+k → Control+k', () => {
      expect(convertKeysForPlatform(['Meta+k'], { enabled: true, isMac: false }))
        .toEqual(['Control+k'])
    })

    it('converts Shift+Meta+T → Shift+Control+T', () => {
      expect(convertKeysForPlatform(['Shift+Meta+T'], { enabled: true, isMac: false }))
        .toEqual(['Shift+Control+T'])
    })

    it('converts adjacent Meta+Meta → Control+Control', () => {
      expect(convertKeysForPlatform(['Meta+Meta'], { enabled: true, isMac: false }))
        .toEqual(['Control+Control'])
    })

    it('converts multiple entries in array', () => {
      expect(convertKeysForPlatform(['Enter', 'Meta+k', 'Control+Shift+T'], { enabled: true, isMac: false }))
        .toEqual(['Enter', 'Control+k', 'Control+Shift+T'])
    })

    it('leaves non-Meta keys unchanged', () => {
      expect(convertKeysForPlatform(['Enter', 'Tab', 'Escape'], { enabled: true, isMac: false }))
        .toEqual(['Enter', 'Tab', 'Escape'])
    })
  })

  describe('whole-word matching only', () => {
    it('does NOT convert "Metaphor"', () => {
      expect(convertKeysForPlatform(['Metaphor'], { enabled: true, isMac: false }))
        .toEqual(['Metaphor'])
    })

    it('does NOT convert "MetaX"', () => {
      expect(convertKeysForPlatform(['MetaX'], { enabled: true, isMac: false }))
        .toEqual(['MetaX'])
    })

    it('does NOT convert "XMeta"', () => {
      expect(convertKeysForPlatform(['XMeta'], { enabled: true, isMac: false }))
        .toEqual(['XMeta'])
    })
  })

  describe('Mac (isMac=true)', () => {
    it('returns Meta keys unchanged', () => {
      expect(convertKeysForPlatform(['Meta+k'], { enabled: true, isMac: true }))
        .toEqual(['Meta+k'])
    })

    it('returns multi-modifier Meta unchanged', () => {
      expect(convertKeysForPlatform(['Shift+Meta+T'], { enabled: true, isMac: true }))
        .toEqual(['Shift+Meta+T'])
    })
  })

  describe('enabled=false', () => {
    it('returns keys unchanged even on non-Mac', () => {
      expect(convertKeysForPlatform(['Meta+k'], { enabled: false, isMac: false }))
        .toEqual(['Meta+k'])
    })

    it('returns keys unchanged on Mac', () => {
      expect(convertKeysForPlatform(['Meta+k'], { enabled: false, isMac: true }))
        .toEqual(['Meta+k'])
    })
  })

  describe('immutability', () => {
    it('does not mutate the input array', () => {
      const input = ['Meta+k']
      convertKeysForPlatform(input, { enabled: true, isMac: false })
      expect(input).toEqual(['Meta+k'])
    })
  })

  describe('empty array', () => {
    it('returns empty array', () => {
      expect(convertKeysForPlatform([], { enabled: true, isMac: false }))
        .toEqual([])
    })
  })
})

describe('isMacPlatform', () => {
  it('returns a boolean', () => {
    expect(typeof isMacPlatform()).toBe('boolean')
  })

  it('matches process.platform === darwin', () => {
    expect(isMacPlatform()).toBe(process.platform === 'darwin')
  })
})
