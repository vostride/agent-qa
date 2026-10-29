import { expect, test } from 'vitest'
import * as api from '../index'

test('C424-FAMILIES-EXACT', () => {
  expect(api.ACTION_FAMILIES).toEqual([
    'pointer', 'input', 'gesture', 'navigate', 'verify', 'extract', 'wait', 'device',
    'environment', 'script',
  ])
  for (const family of api.ACTION_FAMILIES) {
    expect(api.ActionFamilySchema.parse(family)).toBe(family)
  }
  expect(api.ActionFamilySchema.safeParse('unknown').success).toBe(false)
})

test('C424-FAMILIES-EXHAUSTIVE', () => {
  expect(api.ACTION_FAMILY_BY_TYPE).toBeDefined()
  expect(Object.keys(api.ACTION_FAMILY_BY_TYPE).sort()).toEqual([
    'click', 'doubleClick', 'rightClick', 'hover', 'focus', 'tap', 'doubleTap', 'multiTap',
    'longpress', 'tapCoordinate', 'fill', 'paste', 'copy', 'clearText', 'keypress', 'keyevent',
    'select', 'nativeSelect', 'pickerSelect', 'fileUpload', 'scroll', 'swipe', 'drag', 'pinch',
    'swipeFromEdge', 'navigate', 'tab', 'openUniversalLink', 'assertAI', 'assertValue',
    'extractAI', 'inspect', 'reportValue', 'setVariable', 'uniqueValue', 'waitFor', 'waitForUrl',
    'delay', 'pressBack', 'pressHome', 'pressRecent', 'pressButton', 'hideKeyboard',
    'setOrientation', 'openApp', 'stopApp', 'openNotifications', 'openQuickSettings', 'intent',
    'setCookies', 'setLocalStorage', 'storageState', 'route', 'unroute', 'networkState',
    'handleDialog', 'executeScript',
  ].sort())
  for (const family of Object.values(api.ACTION_FAMILY_BY_TYPE)) {
    expect(api.ACTION_FAMILIES).toContain(family)
  }
})

test('actionFamilyOf returns the declared family', () => {
  expect(api.actionFamilyOf).toBeTypeOf('function')
  expect(api.actionFamilyOf('click')).toBe('pointer')
  expect(api.actionFamilyOf('navigate')).toBe('navigate')
  expect(api.actionFamilyOf('assertAI')).toBe('verify')
  expect(api.actionFamilyOf('executeScript')).toBe('script')
})
