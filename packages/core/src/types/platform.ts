// Platform-agnostic types for the PlatformAdapter contract.
// CRITICAL: No imports from playwright-core, webdriverio, or any platform package.

import type { ConsoleLogEntry, NetworkLogEntry } from './result.js'

export interface ObserveOptions {
  extractDom?: boolean
}

export interface PlatformAdapter {
  readonly platform: 'web' | 'android' | 'ios'

  setup(config: PlatformConfig): Promise<void>
  cleanup(): Promise<void>
  observe(options?: ObserveOptions): Promise<ScreenState>
  execute(action: Action): Promise<ActionResult>
  screenshot?(): Promise<Buffer | undefined>
  drainConsoleLogs?(level?: string): ConsoleLogEntry[]
  drainNetworkLogs?(urlPattern?: string): NetworkLogEntry[]
}

export interface ScreenStateMetadata {
  coordSpace: 'viewport'
  viewportWidth: number
  viewportHeight: number
  refMap?: Record<string, unknown>
  imageWidth?: number
  imageHeight?: number
  domContext?: string
}

export interface ScreenState {
  tree: string
  elements: ElementInfo[]
  url?: string
  timestamp: number
  metadata: ScreenStateMetadata
}

export interface ElementInfo {
  ref: string
  role: string
  name: string
  value?: string
  attributes: Record<string, string>
}

export type Action =
  // Web actions
  | { type: 'click'; ref: string; clickDelay?: number }
  | { type: 'fill'; ref: string; value: string }
  | { type: 'select'; ref: string; value: string }
  | { type: 'nativeSelect'; ref: string; value: string }
  | { type: 'navigate'; url: string }
  | { type: 'scroll'; scrollType: 'vertical' | 'horizontal'; value: number; ref?: string; duration?: number }
  | { type: 'waitFor'; condition: string; timeout?: number }
  | { type: 'delay'; ms: number }
  | { type: 'assert'; condition: string; expected?: string; visual?: boolean }
  | { type: 'keypress'; keys: string[]; convertPlatformKeys?: boolean }
  | { type: 'hover'; ref: string }
  | { type: 'paste'; ref: string; value: string }
  | { type: 'keyDown'; key: string }
  | { type: 'keyUp'; key: string }
  | { type: 'refresh' }
  | { type: 'navigateHistory'; direction: 'back' | 'forward' }
  | { type: 'readConsoleLogs'; level?: 'log' | 'info' | 'warn' | 'error'; tab?: { index?: number; title?: string; url?: string } }
  | { type: 'readNetworkLogs'; urlPattern?: string; tab?: { index?: number; title?: string; url?: string } }
  | { type: 'readCookies'; name?: string }
  | { type: 'setCookies'; cookies: Array<{ name: string; value: string; domain?: string; path?: string; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None'; expires?: number }> }
  | { type: 'readLocalStorage'; key?: string }
  | { type: 'setLocalStorage'; entries: Array<{ key: string; value: string }> }
  | { type: 'newTab'; url: string }
  | { type: 'switchTab'; index?: number; title?: string; url?: string }
  | { type: 'doubleClick'; ref: string; relativePosition?: { x: number; y: number }; clickDelay?: number }
  | { type: 'rightClick'; ref: string; relativePosition?: { x: number; y: number }; clickDelay?: number }
  | { type: 'waitForUrl'; pattern: string }
  | { type: 'fileUpload'; ref: string; files: string[] }
  | { type: 'copy'; ref: string }
  // Mobile actions
  | { type: 'tap'; ref: string }
  | { type: 'swipe'; direction: 'up' | 'down' | 'left' | 'right'; ref?: string; startX?: number; startY?: number; endX?: number; endY?: number; duration?: number }
  | { type: 'longpress'; ref: string; duration?: number }
  // Cross-platform actions
  | { type: 'hideKeyboard' }
  | { type: 'clearText'; ref: string }
  | { type: 'openLink'; url: string; appId?: string; bundleId?: string; appPackage?: string; waitForLaunch?: boolean }
  | { type: 'drag'; fromRef: string; toRef: string }
  | { type: 'doubleTap'; ref: string }
  | { type: 'launchApp'; bundleId: string }
  | { type: 'stopApp'; bundleId: string }
  | { type: 'setOrientation'; orientation: 'portrait' | 'landscape' }
  | { type: 'pinch'; scale: number; x?: number; y?: number; ref?: string }
  | { type: 'multiTap'; fingers: number; x?: number; y?: number; ref?: string }
  | { type: 'tapCoordinate'; x: number; y: number }
  | { type: 'executeScript'; command: string; args?: unknown }
  | { type: 'setVariable'; name: string; value: string }

export interface ActionResult {
  success: boolean
  error?: string
  screenshot?: Buffer
  metadata?: Record<string, unknown>
  coordinates?: { x: number; y: number }
  boundingBox?: { x: number; y: number; width: number; height: number }
  startCoordinates?: { x: number; y: number }
  endCoordinates?: { x: number; y: number }
  data?: unknown
}

export interface RuntimeAuthStateConfig {
  version: number
  kind: 'web'
  targetName: string
  stateName: string
  capturedAt: string
  storageStatePath: string
}

export interface PlatformConfig {
  platform: 'web' | 'android' | 'ios'
  browser?: BrowserConfig
  device?: DeviceConfig
  bundleId?: string
  appPackage?: string
  appActivity?: string
  deepLinkAppId?: string
  appState?: 'preserve' | 'reset'
  appPath?: string
  browserstackApp?: string
  appiumUrl?: string
  timeouts?: TimeoutConfig
  recording?: { enabled: boolean; videoDir: string; videoSize?: { width: number; height: number } }
  verbose?: boolean
  farmSession?: { hostname: string; port: number; path: string; capabilities: Record<string, unknown> }
  logCapture?: { console?: boolean; network?: boolean }
  authState?: RuntimeAuthStateConfig
}

export interface BrowserConfig {
  name: 'chromium' | 'firefox' | 'webkit'
  headless?: boolean
  viewport?: { width: number; height: number }
}

export interface DeviceConfig {
  name: string
  platform: 'android' | 'ios'
  transport: 'local' | 'browserstack'
  match: Record<string, unknown>
}

export interface TimeoutConfig {
  step?: number
  test?: number
  navigation?: number
}
