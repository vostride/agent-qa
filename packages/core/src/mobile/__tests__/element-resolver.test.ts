import { describe, it, expect } from 'vitest'
import { MobileElementResolver } from '../element-resolver.js'
import type { MobileRefMap } from '../types.js'
import type { Action } from '../../types/platform.js'

const sampleRefs: MobileRefMap = {
  e1: { role: 'textbox', name: 'Email', bounds: { x: 100, y: 200, width: 50, height: 30 } },
  e2: { role: 'button', name: 'Sign In', bounds: { x: 200, y: 400, width: 100, height: 44 } },
  e3: { role: 'text', name: 'Title' },
  e4: { role: 'image', name: 'Logo', bounds: { x: 0, y: 0, width: 200, height: 200 } },
}

describe('MobileElementResolver', () => {
  describe('resolve', () => {
    it('returns center coordinates for known ref', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const result = resolver.resolve('e1')

      expect(result.role).toBe('textbox')
      expect(result.name).toBe('Email')
      expect(result.bounds).toEqual({ x: 100, y: 200, width: 50, height: 30 })
      expect(result.center).toEqual({ x: 125, y: 215 })
    })

    it('calculates center correctly for various bounds', () => {
      const resolver = new MobileElementResolver(sampleRefs)

      const result = resolver.resolve('e2')
      expect(result.center).toEqual({ x: 250, y: 422 })

      const result2 = resolver.resolve('e4')
      expect(result2.center).toEqual({ x: 100, y: 100 })
    })

    it('throws for unknown ref with helpful error listing available refs', () => {
      const resolver = new MobileElementResolver(sampleRefs)

      expect(() => resolver.resolve('e99')).toThrow('Unknown ref "e99"')
      expect(() => resolver.resolve('e99')).toThrow('Available refs: e1, e2, e3, e4')
    })

    it('throws for ref with no bounds', () => {
      const resolver = new MobileElementResolver(sampleRefs)

      expect(() => resolver.resolve('e3')).toThrow('has no bounds')
      expect(() => resolver.resolve('e3')).toThrow('text "Title"')
    })

    it('throws for unknown ref when no refs available', () => {
      const resolver = new MobileElementResolver({})

      expect(() => resolver.resolve('e1')).toThrow('Available refs: none')
    })
  })

  describe('resolveAction', () => {
    it('returns null for navigate action', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const action: Action = { type: 'navigate', url: 'https://example.com' }

      expect(resolver.resolveAction(action)).toBeNull()
    })

    it('returns null for waitFor action', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const action: Action = { type: 'waitFor', condition: 'visible' }

      expect(resolver.resolveAction(action)).toBeNull()
    })

    it('returns null for assert action', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const action: Action = { type: 'assert', condition: 'text equals "hello"' }

      expect(resolver.resolveAction(action)).toBeNull()
    })

    it('returns coordinates for tap action', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const action: Action = { type: 'tap', ref: 'e2' }

      const result = resolver.resolveAction(action)
      expect(result).not.toBeNull()
      expect(result!.center).toEqual({ x: 250, y: 422 })
      expect(result!.bounds).toEqual({ x: 200, y: 400, width: 100, height: 44 })
    })

    it('returns coordinates for fill action', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const action: Action = { type: 'fill', ref: 'e1', value: 'test@example.com' }

      const result = resolver.resolveAction(action)
      expect(result).not.toBeNull()
      expect(result!.center).toEqual({ x: 125, y: 215 })
    })

    it('returns coordinates for longpress action', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const action: Action = { type: 'longpress', ref: 'e2', duration: 1000 }

      const result = resolver.resolveAction(action)
      expect(result).not.toBeNull()
      expect(result!.center).toEqual({ x: 250, y: 422 })
    })

    it('returns null for scroll without ref', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const action: Action = { type: 'scroll', scrollType: 'vertical', value: -500 }

      expect(resolver.resolveAction(action)).toBeNull()
    })

    it('returns coordinates for scroll with ref', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const action: Action = { type: 'scroll', scrollType: 'vertical', value: -500, ref: 'e2' }

      const result = resolver.resolveAction(action)
      expect(result).not.toBeNull()
      expect(result!.center).toEqual({ x: 250, y: 422 })
    })

    it('returns null for pinch without ref', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const action: Action = { type: 'pinch', scale: 2.0 }

      expect(resolver.resolveAction(action)).toBeNull()
    })

    it('returns coordinates for pinch with ref', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const action: Action = { type: 'pinch', scale: 2.0, ref: 'e2' }

      const result = resolver.resolveAction(action)
      expect(result).not.toBeNull()
      expect(result!.center).toEqual({ x: 250, y: 422 })
    })

    it('returns null for multiTap without ref', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const action: Action = { type: 'multiTap', fingers: 2 }

      expect(resolver.resolveAction(action)).toBeNull()
    })

    it('returns coordinates for multiTap with ref', () => {
      const resolver = new MobileElementResolver(sampleRefs)
      const action: Action = { type: 'multiTap', fingers: 3, ref: 'e2' }

      const result = resolver.resolveAction(action)
      expect(result).not.toBeNull()
      expect(result!.center).toEqual({ x: 250, y: 422 })
    })
  })
})
