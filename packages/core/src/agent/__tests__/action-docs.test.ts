import { describe, it, expect } from 'vitest'
import { defaultRegistry, MOBILE_ONLY_ACTIONS, WEB_ONLY_ACTIONS } from '../../tools/index.js'

const ACTION_NAMES = [
  'click', 'fill', 'select', 'nativeSelect', 'navigate', 'scroll', 'waitFor', 'delay', 'assert',
  'keypress', 'hover', 'paste', 'keyDown', 'keyUp', 'refresh', 'navigateHistory',
  'readConsoleLogs', 'readNetworkLogs', 'readCookies', 'setCookies', 'readLocalStorage', 'setLocalStorage',
  'tap', 'swipe', 'longpress',
  'hideKeyboard', 'clearText', 'openLink', 'drag', 'doubleTap',
  'launchApp', 'stopApp', 'setOrientation', 'pinch', 'multiTap',
  'tapCoordinate', 'executeScript', 'setVariable',
  'newTab', 'switchTab',
  'doubleClick', 'rightClick',
  'waitForUrl', 'fileUpload', 'copy',
]

describe('defaultRegistry.generateDocs', () => {
  describe('no platform filter (all actions)', () => {
    it('returns a string containing all 45 action types', () => {
      const result = defaultRegistry.generateDocs()
      for (const type of ACTION_NAMES) {
        expect(result).toContain(type)
      }
    })

    it('contains exactly 45 action lines', () => {
      const result = defaultRegistry.generateDocs()
      const lines = result.split('\n').filter((l: string) => l.startsWith('- '))
      expect(lines).toHaveLength(45)
    })
  })

  describe('web platform (excludes mobile-only)', () => {
    it('excludes all 11 mobile-only actions', () => {
      const result = defaultRegistry.generateDocs('web')
      for (const action of MOBILE_ONLY_ACTIONS) {
        expect(result).not.toMatch(new RegExp(`^- ${action}:`, 'm'))
      }
    })

    it('includes hover (web-only action)', () => {
      const result = defaultRegistry.generateDocs('web')
      expect(result).toMatch(/^- hover:/m)
    })

    it('contains exactly 34 action lines (45 minus 11 mobile-only)', () => {
      const result = defaultRegistry.generateDocs('web')
      const lines = result.split('\n').filter((l: string) => l.startsWith('- '))
      expect(lines).toHaveLength(34)
    })
  })

  describe('android platform (excludes web-only)', () => {
    it('excludes hover (web-only action)', () => {
      const result = defaultRegistry.generateDocs('android')
      expect(result).not.toMatch(/^- hover:/m)
    })

    it('includes mobile-only actions', () => {
      const result = defaultRegistry.generateDocs('android')
      for (const action of MOBILE_ONLY_ACTIONS) {
        expect(result).toMatch(new RegExp(`^- ${action}:`, 'm'))
      }
    })

    it('contains exactly 27 action lines (45 minus 18 web-only)', () => {
      const result = defaultRegistry.generateDocs('android')
      const lines = result.split('\n').filter((l: string) => l.startsWith('- '))
      expect(lines).toHaveLength(27)
    })
  })

  describe('ios platform (excludes web-only)', () => {
    it('excludes hover (web-only action)', () => {
      const result = defaultRegistry.generateDocs('ios')
      expect(result).not.toMatch(/^- hover:/m)
    })

    it('contains exactly 27 action lines (45 minus 18 web-only)', () => {
      const result = defaultRegistry.generateDocs('ios')
      const lines = result.split('\n').filter((l: string) => l.startsWith('- '))
      expect(lines).toHaveLength(27)
    })
  })

  describe('action line format', () => {
    it('each line contains type name, description, and params', () => {
      const result = defaultRegistry.generateDocs()
      expect(result).toMatch(/^- fill: .+\. Params: .+/m)
    })

    it('click action includes ref parameter', () => {
      const result = defaultRegistry.generateDocs()
      expect(result).toMatch(/^- click: Click an element\. Params: ref/m)
    })

    it('fill action includes ref and value parameters', () => {
      const result = defaultRegistry.generateDocs()
      expect(result).toMatch(/^- fill: .+\. Params: .*ref.*value/m)
    })

    it('navigateHistory action shows direction param', () => {
      const result = defaultRegistry.generateDocs()
      const line = result.split('\n').find((l: string) => l.startsWith('- navigateHistory:'))
      expect(line).toBeDefined()
      expect(line).toContain('Params:')
      expect(line).toContain('direction')
    })

    it('scroll action shows scrollType and ref params', () => {
      const result = defaultRegistry.generateDocs()
      expect(result).toMatch(/^- scroll: .+\. Params: .*scrollType.*ref/m)
    })

    it('doubleClick docs discourage default top-left offsets and no-op delay', () => {
      const result = defaultRegistry.generateDocs('web')
      const line = result.split('\n').find((l: string) => l.startsWith('- doubleClick:'))

      expect(line).toBeDefined()
      expect(line).toContain('Do not use { x: 0, y: 0 }')
      expect(line).toContain('Omit when there is no requested delay')
    })
  })

  describe('exported constants', () => {
    it('MOBILE_ONLY_ACTIONS contains expected actions', () => {
      expect(MOBILE_ONLY_ACTIONS).toEqual(
        new Set(['tap', 'swipe', 'longpress', 'launchApp', 'stopApp', 'setOrientation', 'hideKeyboard', 'pinch', 'multiTap', 'executeScript', 'nativeSelect'])
      )
    })

    it('WEB_ONLY_ACTIONS contains all web-only actions', () => {
      expect(WEB_ONLY_ACTIONS).toEqual(
        new Set([
          'hover', 'paste', 'keyDown', 'keyUp', 'refresh', 'navigateHistory',
          'readNetworkLogs', 'readCookies', 'setCookies', 'readLocalStorage', 'setLocalStorage',
          'newTab', 'switchTab',
          'doubleClick', 'rightClick',
          'waitForUrl', 'fileUpload', 'copy',
        ])
      )
    })
  })
})
