export const MOBILE_ONLY_ACTIONS = new Set([
  'tap', 'swipe', 'longpress', 'launchApp', 'stopApp', 'setOrientation', 'hideKeyboard', 'pinch', 'multiTap', 'executeScript',
  'nativeSelect',
])

export const WEB_ONLY_ACTIONS = new Set([
  'hover', 'paste', 'keyDown', 'keyUp', 'refresh', 'navigateHistory',
  'readNetworkLogs', 'readCookies', 'setCookies', 'readLocalStorage', 'setLocalStorage',
  'newTab', 'switchTab',
  'doubleClick', 'rightClick',
  'waitForUrl', 'fileUpload', 'copy',
])

export function getPlatformFilter(name: string): ('web' | 'android' | 'ios')[] | undefined {
  if (WEB_ONLY_ACTIONS.has(name)) return ['web']
  if (MOBILE_ONLY_ACTIONS.has(name)) return ['android', 'ios']
  return undefined
}
