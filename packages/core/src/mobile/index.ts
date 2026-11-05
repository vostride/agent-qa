export { parseMobileSource, buildRefEntries, deriveMobileScroll } from './xml-parser.js'
export { normalizeRole, ANDROID_ROLE_MAP, IOS_ROLE_MAP, IOS_EDITABLE_TYPES } from './role-map.js'
export { MobileElementResolver } from './element-resolver.js'
export { KEY_MAP, computeSwipe, computePinch, computeFingerPositions } from './gestures.js'
export * from './launch-resolver.js'
export * from './appium-executable.js'
export * from './select-device.js'
export * from './device-plan.js'
export * from './find-device-here.js'
export type { MobileNode, MobileRefMap, ParsedMobileSource, RefEntry } from './types.js'
export {
  WEBVIEW_SCROLLERS_SCRIPT,
  parseWebViewScrollers,
  webViewSwipeSignal,
} from './webview-scrollers.js'
export type { IdentifiedScrollOffsets } from './webview-scrollers.js'
