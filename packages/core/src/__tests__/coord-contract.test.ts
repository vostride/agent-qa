import { describe, it, expect, vi } from 'vitest'
import type { PlatformAdapter, ScreenStateMetadata } from '../types/platform.js'
import type { CompressResult } from '../screenshot/compress.js'
import { warnIfOutOfBounds } from '../validation/coord-bounds.js'

describe('viewport-space coordinate contract', () => {
  describe('PlatformAdapter interface', () => {
    it('does not include setScaleFactor method', () => {
      type HasSetScaleFactor = 'setScaleFactor' extends keyof PlatformAdapter ? true : false
      const check: HasSetScaleFactor = false
      expect(check).toBe(false)
    })

    it('does not include scaleCoord method', () => {
      type HasScaleCoord = 'scaleCoord' extends keyof PlatformAdapter ? true : false
      const check: HasScaleCoord = false
      expect(check).toBe(false)
    })
  })

  describe('CompressResult interface', () => {
    it('does not include scaleFactor field', () => {
      type HasScaleFactor = 'scaleFactor' extends keyof CompressResult ? true : false
      const check: HasScaleFactor = false
      expect(check).toBe(false)
    })

    it('includes buffer, imageWidth, imageHeight', () => {
      type HasBuffer = 'buffer' extends keyof CompressResult ? true : false
      type HasImageWidth = 'imageWidth' extends keyof CompressResult ? true : false
      type HasImageHeight = 'imageHeight' extends keyof CompressResult ? true : false
      const checks: [HasBuffer, HasImageWidth, HasImageHeight] = [true, true, true]
      expect(checks).toEqual([true, true, true])
    })
  })

  describe('ScreenStateMetadata', () => {
    it('requires coordSpace to be the literal viewport', () => {
      const metadata: ScreenStateMetadata = {
        coordSpace: 'viewport',
        viewportWidth: 1280,
        viewportHeight: 720,
      }
      expect(metadata.coordSpace).toBe('viewport')
    })

    it('rejects non-viewport coordSpace at type level', () => {
      type CoordSpaceType = ScreenStateMetadata['coordSpace']
      const space: CoordSpaceType = 'viewport'
      expect(space).toBe('viewport')
    })

    it('requires viewportWidth and viewportHeight', () => {
      const metadata: ScreenStateMetadata = {
        coordSpace: 'viewport',
        viewportWidth: 393,
        viewportHeight: 852,
      }
      expect(metadata.viewportWidth).toBe(393)
      expect(metadata.viewportHeight).toBe(852)
    })
  })

  describe('warnIfOutOfBounds', () => {
    it('warns when x exceeds viewport width', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      warnIfOutOfBounds({ x: 500, y: 100 }, { width: 400, height: 800 }, 'tapCoordinate')
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('x=500'))
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('outside viewport'))
      spy.mockRestore()
    })

    it('warns when y exceeds viewport height', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      warnIfOutOfBounds({ x: 100, y: 900 }, { width: 400, height: 800 }, 'swipe')
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('y=900'))
      spy.mockRestore()
    })

    it('warns when coords are negative', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      warnIfOutOfBounds({ x: -10, y: 100 }, { width: 400, height: 800 }, 'tapCoordinate')
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('x=-10'))
      spy.mockRestore()
    })

    it('does not warn when coords are within bounds', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      warnIfOutOfBounds({ x: 200, y: 400 }, { width: 400, height: 800 }, 'tapCoordinate')
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('does not warn when coords exactly equal viewport bounds', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      warnIfOutOfBounds({ x: 400, y: 800 }, { width: 400, height: 800 }, 'tapCoordinate')
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('skips undefined coords', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      warnIfOutOfBounds({ x: undefined, y: undefined }, { width: 400, height: 800 }, 'pinch')
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })
  })
})
