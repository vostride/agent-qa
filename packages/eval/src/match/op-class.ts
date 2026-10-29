import type { Action } from '@vostride/agent-qa-schema'

// The mapped type breaks this table until a new catalog verb gets an explicit class.
export const OP_CLASS_MAP = Object.freeze({
  // Web catalog.
  navigate: 'navigate',
  waitForUrl: 'waitForUrl',
  click: 'activate',
  doubleClick: 'doubleClick',
  rightClick: 'rightClick',
  fill: 'value-entry',
  select: 'select',
  hover: 'hover',
  paste: 'paste',
  copy: 'copy',
  fileUpload: 'fileUpload',
  tab: 'tab',
  inspect: 'inspect',
  route: 'route',
  unroute: 'unroute',
  networkState: 'networkState',
  storageState: 'storageState',
  handleDialog: 'handleDialog',
  uniqueValue: 'uniqueValue',
  focus: 'focus',
  setCookies: 'setCookies',
  setLocalStorage: 'setLocalStorage',

  // Mobile catalog (fill is shared with web and appears once above).
  tap: 'activate',
  doubleTap: 'doubleTap',
  multiTap: 'multiTap',
  tapCoordinate: 'activate',
  swipe: 'swipe',
  longpress: 'longpress',
  pinch: 'pinch',
  drag: 'drag',
  nativeSelect: 'nativeSelect',
  hideKeyboard: 'hideKeyboard',
  setOrientation: 'setOrientation',
  stopApp: 'stopApp',

  // Android catalog.
  pressBack: 'pressBack',
  pressHome: 'pressHome',
  pressRecent: 'pressRecent',
  openNotifications: 'openNotifications',
  openQuickSettings: 'openQuickSettings',
  intent: 'intent',
  keyevent: 'keyevent',

  // iOS catalog.
  pressButton: 'pressButton',
  pickerSelect: 'pickerSelect',
  swipeFromEdge: 'swipeFromEdge',
  openUniversalLink: 'openUniversalLink',

  // Cross-platform catalog.
  assertAI: 'assertAI',
  assertValue: 'assertValue',
  extractAI: 'extractAI',
  waitFor: 'waitFor',
  delay: 'delay',
  scroll: 'scroll',
  clearText: 'clearText',
  reportValue: 'reportValue',
  openApp: 'openApp',
  executeScript: 'executeScript',
  setVariable: 'setVariable',
  keypress: 'keypress',
} satisfies { [T in Action['type']]: string })

function isCatalogVerb(verb: string): verb is Action['type'] {
  return Object.hasOwn(OP_CLASS_MAP, verb)
}

// Every unknown string remains its own class.
export function classifyOpClass(verb: string): string {
  if (!isCatalogVerb(verb)) return verb
  return OP_CLASS_MAP[verb]
}

/** Compare two verb strings only through their versioned match-time operation classes. */
export function opClassEquivalent(goldVerb: string, candidateVerb: string): boolean {
  if (!isCatalogVerb(goldVerb) || !isCatalogVerb(candidateVerb)) {
    return goldVerb === candidateVerb
  }
  return OP_CLASS_MAP[goldVerb] === OP_CLASS_MAP[candidateVerb]
}
