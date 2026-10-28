import { describe, it, expect } from 'vitest'
import type { Platform } from '@vostride/agent-qa-schema'
import { defaultRegistry, EXPOSURE } from '@vostride/agent-qa-runner'

function actionLines(docs: string): string[] {
  return docs.split('\n').filter((line: string) => line.startsWith('- '))
}

function expectedLineCount(platform: Platform): number {
  const surfaces = EXPOSURE[platform]
  return defaultRegistry.getAll().filter(def => surfaces.has(def.surface)).length
}

const CAT_02_WEB_IDS = [
  'web_route',
  'web_unroute',
  'web_networkState',
  'web_storageState',
  'web_handleDialog',
  'web_uniqueValue',
  'web_focus',
] as const

const CAT_03_ANDROID_IDS = [
  'android_pressBack',
  'android_pressHome',
  'android_pressRecent',
  'android_openNotifications',
  'android_openQuickSettings',
  'android_intent',
  'android_keyevent',
] as const

const CAT_04_IOS_IDS = [
  'ios_pressButton',
  'ios_pickerSelect',
  'ios_swipeFromEdge',
  'ios_openUniversalLink',
] as const

describe('defaultRegistry.generateDocs', () => {
  describe('no platform filter (all actions)', () => {
    it('returns a string containing all registered action ids', () => {
      const result = defaultRegistry.generateDocs()

      for (const { id } of defaultRegistry.getAll()) {
        expect(result).toMatch(new RegExp(`^- ${id}:`, 'm'))
      }
    })

    it('contains exactly 56 action lines', () => {
      const result = defaultRegistry.generateDocs()
      expect(actionLines(result)).toHaveLength(56)
    })
  })

  describe('web platform', () => {
    it('includes click and excludes tap', () => {
      const result = defaultRegistry.generateDocs('web')

      expect(result).toMatch(/^- web_click:/m)
      expect(result).not.toMatch(/^- mobile_tap:/m)
    })

    it('includes folded web ids and excludes folded-away ids', () => {
      const result = defaultRegistry.generateDocs('web')

      expect(result).toMatch(/^- web_inspect:/m)
      expect(result).toMatch(/^- web_navigate:/m)
      expect(result).toMatch(/^- web_tab:/m)
      expect(result).toMatch(/^- web_route:/m)
      expect(result).toMatch(/^- web_focus:/m)
      expect(result).toMatch(/^- web_handleDialog:/m)

      for (const id of [
        'web_keyDown',
        'web_keyUp',
        'web_navigateHistory',
        'web_newTab',
        'web_readConsoleLogs',
        'web_readCookies',
        'web_readLocalStorage',
        'web_readNetworkLogs',
        'web_refresh',
        'web_switchTab',
      ]) {
        expect(result).not.toMatch(new RegExp(`^- ${id}:`, 'm'))
      }
    })

    it('renders CAT-02 web additions only in the web docs', () => {
      const webDocs = defaultRegistry.generateDocs('web')
      const androidDocs = defaultRegistry.generateDocs('android')
      const iosDocs = defaultRegistry.generateDocs('ios')

      for (const id of CAT_02_WEB_IDS) {
        expect(webDocs).toMatch(new RegExp(`^- ${id}:`, 'm'))
        expect(androidDocs).not.toMatch(new RegExp(`^- ${id}:`, 'm'))
        expect(iosDocs).not.toMatch(new RegExp(`^- ${id}:`, 'm'))
      }
    })

    it('excludes mobile interaction ids from the web docs', () => {
      const result = defaultRegistry.generateDocs('web')

      for (const id of [
        'mobile_tap',
        'mobile_doubleTap',
        'mobile_multiTap',
        'mobile_tapCoordinate',
        'mobile_swipe',
        'mobile_longpress',
        'mobile_pinch',
        'mobile_drag',
        'mobile_nativeSelect',
        'mobile_fill',
        'mobile_hideKeyboard',
        'mobile_setOrientation',
      ]) {
        expect(result).not.toMatch(new RegExp(`^- ${id}:`, 'm'))
      }
    })

    it('contains the expected exposed web slice line count', () => {
      const result = defaultRegistry.generateDocs('web')

      expect(expectedLineCount('web')).toBe(33)
      expect(actionLines(result)).toHaveLength(expectedLineCount('web'))
    })
  })

  describe('android platform', () => {
    it('includes tap and excludes click', () => {
      const result = defaultRegistry.generateDocs('android')

      expect(result).toMatch(/^- mobile_tap:/m)
      expect(result).not.toMatch(/^- web_click:/m)
    })

    it('includes mobile and common ids without browser-only ids', () => {
      const result = defaultRegistry.generateDocs('android')

      expect(result).toMatch(/^- mobile_nativeSelect:/m)
      expect(result).toMatch(/^- mobile_fill:/m)
      expect(result).toMatch(/^- common_keypress:/m)
      expect(result).not.toMatch(/^- web_doubleClick:/m)
      expect(result).not.toMatch(/^- web_inspect:/m)
      expect(result).not.toMatch(/^- common_executeScript:/m)
    })

    it('renders CAT-03 android additions only in the android docs', () => {
      const webDocs = defaultRegistry.generateDocs('web')
      const androidDocs = defaultRegistry.generateDocs('android')
      const iosDocs = defaultRegistry.generateDocs('ios')

      for (const id of CAT_03_ANDROID_IDS) {
        expect(androidDocs).toMatch(new RegExp(`^- ${id}:`, 'm'))
        expect(webDocs).not.toMatch(new RegExp(`^- ${id}:`, 'm'))
        expect(iosDocs).not.toMatch(new RegExp(`^- ${id}:`, 'm'))
      }
    })

    it('contains the expected exposed android slice line count', () => {
      const result = defaultRegistry.generateDocs('android')

      expect(expectedLineCount('android')).toBe(30)
      expect(actionLines(result)).toHaveLength(expectedLineCount('android'))
    })
  })

  describe('ios platform', () => {
    it('includes tap and excludes click', () => {
      const result = defaultRegistry.generateDocs('ios')

      expect(result).toMatch(/^- mobile_tap:/m)
      expect(result).not.toMatch(/^- web_click:/m)
    })

    it('includes mobile and common ids without browser-only ids', () => {
      const result = defaultRegistry.generateDocs('ios')

      expect(result).toMatch(/^- mobile_nativeSelect:/m)
      expect(result).toMatch(/^- mobile_fill:/m)
      expect(result).toMatch(/^- common_keypress:/m)
      expect(result).not.toMatch(/^- web_doubleClick:/m)
      expect(result).not.toMatch(/^- web_inspect:/m)
      expect(result).not.toMatch(/^- common_executeScript:/m)
    })

    it('renders CAT-04 ios additions only in the ios docs', () => {
      const webDocs = defaultRegistry.generateDocs('web')
      const androidDocs = defaultRegistry.generateDocs('android')
      const iosDocs = defaultRegistry.generateDocs('ios')

      for (const id of CAT_04_IOS_IDS) {
        expect(iosDocs).toMatch(new RegExp(`^- ${id}:`, 'm'))
        expect(webDocs).not.toMatch(new RegExp(`^- ${id}:`, 'm'))
        expect(androidDocs).not.toMatch(new RegExp(`^- ${id}:`, 'm'))
      }
    })

    it('contains the expected exposed ios slice line count', () => {
      const result = defaultRegistry.generateDocs('ios')

      expect(expectedLineCount('ios')).toBe(27)
      expect(actionLines(result)).toHaveLength(expectedLineCount('ios'))
    })
  })

  describe('action line format', () => {
    it('each line contains id, description, and params', () => {
      const result = defaultRegistry.generateDocs()
      expect(result).toMatch(/^- web_fill: .+\. Params: .+/m)
      expect(result).toMatch(/^- mobile_fill: .+\. Params: .+/m)
    })

    it('click action includes ref parameter', () => {
      const result = defaultRegistry.generateDocs()
      expect(result).toMatch(/^- web_click: Click an element\. Params: ref/m)
    })

    it('fill actions include ref and text parameters', () => {
      const result = defaultRegistry.generateDocs()
      expect(result).toMatch(/^- web_fill: .+\. Params: .*ref.*text/m)
      expect(result).toMatch(/^- mobile_fill: .+\. Params: .*ref.*text/m)
    })

    it('nativeSelect action uses its mobile-prefixed line', () => {
      const result = defaultRegistry.generateDocs('android')
      expect(result).toMatch(/^- mobile_nativeSelect: .+\. Params: .*ref.*value/m)
    })

    it('navigate action shows the to param', () => {
      const result = defaultRegistry.generateDocs()
      const line = result.split('\n').find((l: string) => l.startsWith('- web_navigate:'))
      expect(line).toBeDefined()
      expect(line).toContain('Params:')
      expect(line).toContain('to')
    })

    it('scroll action shows mode and ref params', () => {
      const result = defaultRegistry.generateDocs()
      expect(result).toMatch(/^- common_scroll: .+\. Params: .*mode.*ref/m)
    })

    it('doubleClick docs discourage default top-left offsets and no-op delay', () => {
      const result = defaultRegistry.generateDocs('web')
      const line = result.split('\n').find((l: string) => l.startsWith('- web_doubleClick:'))

      expect(line).toBeDefined()
      expect(line).toContain('Do not use { x: 0, y: 0 }')
      expect(line).toContain('Omit when there is no requested delay')
    })
  })
})
