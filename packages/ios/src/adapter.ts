import type { PlatformAdapter, PlatformConfig, ScreenState, Action, ActionResult, ObserveOptions, ConsoleLogEntry } from '@vostride/agent-qa-core'
import { MobileSetupError, parseMobileSource, MobileElementResolver, KEY_MAP, computeSwipe, computePinch, computeFingerPositions, alignToWindow, warnIfOutOfBounds } from '@vostride/agent-qa-core'
import type { MobileRefMap } from '@vostride/agent-qa-core'
import { createIOSSession } from './session.js'
import type { IOSAdapterConfig } from './types.js'

const IOS_FILLABLE_ROLES = new Set(['textbox', 'searchbox', 'textfield', 'securetextfield', 'searchfield', 'combobox'])
const IOS_NATIVE_SELECT_TYPES = new Set([
  'XCUIElementTypePickerWheel',
  'XCUIElementTypePicker',
  'XCUIElementTypeDatePicker',
  'XCUIElementTypePopUpButton',
  'XCUIElementTypeComboBox',
])
const IOS_NATIVE_SELECT_ROLES = new Set(['pickerwheel', 'spinbutton', 'combobox'])

// WebDriverIO's action().perform() calls DELETE /session/{id}/actions (releaseActions)
// after performing. BrowserStack iOS doesn't support this endpoint and throws
// "resource not found" errors. This wrapper swallows that specific error.
async function safePerform(chain: { perform: () => Promise<void> }): Promise<void> {
  try {
    await chain.perform()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('actions') && msg.includes('DELETE')) return
    throw err
  }
}

const IOS_SYSLOG_REGEX = /^.*?\s+(\S+)\[(\d+)\].*?:\s+(.*)/
const IOS_APPIUM_LOG_REGEX = /^\S+\s+\S+\s+\[(\w+)\]\s+\[(\S+)\]\s+(.*)/

const IOS_LEVEL_MAP: Record<string, string> = {
  Debug: 'debug',
  Info: 'info',
  Warning: 'warn',
  Warn: 'warn',
  Error: 'error',
  Fault: 'error',
  Notice: 'info',
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed) return trimmed
  }
  return undefined
}

function isIOSNativeSelectTarget(refData: MobileRefMap[string] | undefined): boolean {
  const role = refData?.role?.toLowerCase()
  return Boolean(
    (role && IOS_NATIVE_SELECT_ROLES.has(role))
    || (refData?.nativeType && IOS_NATIVE_SELECT_TYPES.has(refData.nativeType))
  )
}

function normalizePickerValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

async function getElementValue(el: any): Promise<string | undefined> {
  for (const getter of [
    () => el.getValue?.(),
    () => el.getText?.(),
    () => el.getAttribute?.('value'),
  ]) {
    try {
      const value = await getter()
      if (typeof value === 'string' && value.trim()) return value
    } catch {
      // Try the next value source.
    }
  }
  return undefined
}

async function findIOSPickerWheels(
  driver: WebdriverIO.Browser,
  refs: MobileRefMap,
  targetRef: string,
  refData: MobileRefMap[string] | undefined,
): Promise<any[]> {
  const wheelSelector = '-ios class chain:**/XCUIElementTypePickerWheel'
  if (refData?.nativeType === 'XCUIElementTypePickerWheel') {
    try {
      const observedWheelRefs = Object.entries(refs)
        .filter(([, data]) => data.nativeType === 'XCUIElementTypePickerWheel')
        .map(([ref]) => ref)
      const targetIndex = observedWheelRefs.indexOf(targetRef)
      const wheels = Array.from(await driver.$$(wheelSelector) as unknown as any[])
      if (targetIndex >= 0 && wheels[targetIndex]) return [wheels[targetIndex]]
      if (targetIndex <= 0 && wheels.length === 1) return [wheels[0]]
    } catch {
      // Fall back to a direct lookup below for drivers/tests without $$ support.
    }
    try {
      const wheel = await driver.$(wheelSelector)
      return await wheel.isExisting() ? [wheel] : []
    } catch {
      return []
    }
  }

  try {
    const wheels = await driver.$$(wheelSelector)
    return Array.from(wheels as unknown as any[])
  } catch {
    return []
  }
}

function matchesIOSApp(processName: string, bundleId: string): boolean {
  const appName = bundleId.split('.').pop() ?? bundleId
  return processName === appName || processName.includes(appName)
}

function parseIOSSyslogLine(message: string, timestamp: number, bundleId: string | null): ConsoleLogEntry | null {
  const appiumMatch = message.match(IOS_APPIUM_LOG_REGEX)
  if (appiumMatch) {
    const [, levelStr, processName, text] = appiumMatch
    if (bundleId && !matchesIOSApp(processName, bundleId)) return null
    return {
      level: IOS_LEVEL_MAP[levelStr] ?? 'info',
      text: text.trim(),
      timestamp,
    }
  }

  const syslogMatch = message.match(IOS_SYSLOG_REGEX)
  if (syslogMatch) {
    const [, processName, , text] = syslogMatch
    if (bundleId && !matchesIOSApp(processName, bundleId)) return null
    return {
      level: 'info',
      text: text.trim(),
      timestamp,
    }
  }

  return null
}

export class IOSPlatformAdapter implements PlatformAdapter {
  readonly platform = 'ios' as const

  private driver: WebdriverIO.Browser | null = null
  private lastRefs: MobileRefMap = {}
  private config: IOSAdapterConfig | null = null
  // Web context detected from getContexts() (e.g. 'WEBVIEW_12345').
  // Used for URL extraction in observe() and JS scroll in execute().
  private activeWebContext: string | null = null
  private webContextChecked = false
  private currentContext: string | null = null
  private consoleLogs: ConsoleLogEntry[] = []
  private consoleDrainIndex = 0
  private captureConsole = true
  private bundleId: string | null = null

  async setup(config: PlatformConfig): Promise<void> {
    this.config = config as IOSAdapterConfig
    this.captureConsole = config.logCapture?.console !== false
    this.bundleId = this.config.bundleId ?? (config.device?.match?.bundleId as string | undefined) ?? null

    this.driver = await createIOSSession(this.config, config.farmSession)

    const bundleId = this.bundleId
    if (bundleId) {
      try {
        await this.driver.activateApp(bundleId)
      } catch (err) {
        throw new MobileSetupError({
          category: 'app-launch',
          message: `Failed to launch iOS app "${bundleId}": ${err instanceof Error ? err.message : String(err)}`,
          platform: 'ios',
          deviceName: config.device?.name,
          appId: bundleId,
          cause: err,
        })
      }
    }
  }

  async cleanup(): Promise<void> {
    try {
      if (this.driver) {
        await this.driver.deleteSession()
      }
    } catch {
      // session may already be closed
    }
    this.driver = null
    this.lastRefs = {}
    this.config = null
    this.consoleLogs = []
    this.bundleId = null
    this.activeWebContext = null
    this.webContextChecked = false
    this.currentContext = null
  }

  async observe(_options?: ObserveOptions): Promise<ScreenState> {
    if (!this.driver) {
      throw new Error('IOSPlatformAdapter not initialized — call setup() first')
    }

    // Ensure native context for XCUITest observation (which CAN see into WebViews on iOS)
    await this.ensureContext('NATIVE_APP')

    const [xml, viewport] = await Promise.all([
      this.driver.getPageSource(),
      this.driver.getWindowSize(),
    ])
    const parsed = parseMobileSource(xml, 'ios', viewport)
    this.lastRefs = parsed.refs

    // Try to get the current URL from web context (if available).
    // This gives the LLM verifier critical evidence about which page we're on.
    let url: string | undefined
    const webCtx = await this.getWebContext()
    if (webCtx) {
      try {
        await this.ensureContext(webCtx)
        url = await this.driver.getUrl()
        await this.ensureContext('NATIVE_APP')
      } catch {
        try { await this.ensureContext('NATIVE_APP') } catch { /* best-effort */ }
      }
    }

    return {
      tree: parsed.tree,
      elements: parsed.elements,
      url,
      timestamp: Date.now(),
      metadata: { coordSpace: 'viewport' as const, viewportWidth: viewport.width, viewportHeight: viewport.height, refMap: parsed.refs },
    }
  }

  async execute(action: Action): Promise<ActionResult> {
    if (!this.driver) {
      throw new Error('IOSPlatformAdapter not initialized — call setup() first')
    }

    try {
      return await this.executeAction(action)
    } catch (err) {
      let screenshot: Buffer | undefined
      try {
        screenshot = await this.captureScreenshot()
      } catch {
        // ignore screenshot failure
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        screenshot,
      }
    }
  }

  async screenshot(): Promise<Buffer | undefined> {
    try { await this.ensureContext('NATIVE_APP') } catch { /* best-effort */ }
    const raw = await this.captureScreenshot()
    if (!raw || !this.driver) return raw

    // Stage 2 (D-02, D-05): resize physical pixels → logical points.
    // iOS takeScreenshot returns physical pixels (e.g., 1179×2556 on iPhone 15 Pro)
    // while getWindowSize, XML bounds, and W3C pointer actions use logical points (393×852).
    // Re-read getWindowSize every call per Pitfall 8 (handles rotation — no caching).
    try {
      const { width, height } = await this.driver.getWindowSize()
      return await alignToWindow(raw, { width, height })
    } catch {
      // Alignment failure is best-effort — return raw buffer rather than crashing capture.
      return raw
    }
  }

  // ---------------------------------------------------------------------------
  // Device log capture
  // ---------------------------------------------------------------------------

  async pollDeviceLogs(): Promise<void> {
    if (!this.captureConsole) return
    if (!this.driver) return
    try {
      const logs = await this.driver.getLogs('syslog') as { message: string; timestamp?: number; level?: string }[]
      for (const entry of logs) {
        const parsed = parseIOSSyslogLine(entry.message, entry.timestamp ?? Date.now(), this.bundleId)
        if (parsed) {
          this.consoleLogs.push(parsed)
          continue
        }
        // Fallback: if regex didn't match, use the raw message with Appium-provided level
        if (entry.message?.trim()) {
          this.consoleLogs.push({
            level: IOS_LEVEL_MAP[entry.level ?? ''] ?? 'info',
            text: entry.message.trim(),
            timestamp: entry.timestamp ?? Date.now(),
          })
        }
      }
      if (this.consoleLogs.length > 1000) {
        this.consoleLogs = this.consoleLogs.slice(-500)
      }
    } catch {
      // getLogs may fail in some Appium configurations
    }
  }

  drainConsoleLogs(level?: string): ConsoleLogEntry[] {
    const newLogs = this.consoleLogs.slice(this.consoleDrainIndex)
    this.consoleDrainIndex = this.consoleLogs.length
    if (!level) return newLogs
    return newLogs.filter(e => e.level === level)
  }

  // ---------------------------------------------------------------------------
  // Web context helpers
  // ---------------------------------------------------------------------------

  /** Lazily detect the WEBVIEW context.  Cached after first lookup. */
  private async getWebContext(): Promise<string | null> {
    if (!this.webContextChecked) {
      this.webContextChecked = true
      try {
        const contexts = await this.driver!.getContexts() as string[]
        this.activeWebContext = contexts.find(c =>
          typeof c === 'string' && c.includes('WEBVIEW')
        ) ?? null
      } catch {
        this.activeWebContext = null
      }
    }
    return this.activeWebContext
  }

  /** Invalidate the cached web context so next getWebContext() re-queries. */
  private invalidateWebContext(): void {
    this.webContextChecked = false
    this.activeWebContext = null
  }

  private async ensureContext(target: string): Promise<void> {
    if (this.currentContext === target) return
    try {
      await this.driver!.switchContext(target)
      this.currentContext = target
    } catch {
      this.currentContext = null
    }
  }

  // ---------------------------------------------------------------------------
  // Screenshots
  // ---------------------------------------------------------------------------

  private async captureScreenshot(): Promise<Buffer | undefined> {
    try {
      if (this.driver) {
        const base64 = await this.driver.takeScreenshot()
        return Buffer.from(base64, 'base64')
      }
      return undefined
    } catch {
      return undefined
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private async executeAction(action: Action): Promise<ActionResult> {
    const driver = this.driver!
    const resolver = new MobileElementResolver(this.lastRefs)

    // Ensure we're in native context for touch gestures
    await this.ensureContext('NATIVE_APP')

    switch (action.type) {
      case 'tap':
      case 'click': {
        const { center, bounds } = resolver.resolve(action.ref)
        await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: Math.round(center.x), y: Math.round(center.y) })
          .down({ button: 0 })
          .up({ button: 0 })
          )
        return { success: true, coordinates: center, boundingBox: bounds }
      }

      case 'fill': {
        const { center, bounds } = resolver.resolve(action.ref)
        const refData = this.lastRefs[action.ref]
        const role = refData?.role?.toLowerCase()
        if (role && !IOS_FILLABLE_ROLES.has(role)) {
          return {
            success: false,
            error: `Element ${action.ref} is not fillable (role: ${role}). Use a textbox or input element instead.`,
          }
        }
        // Tap to focus
        await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: Math.round(center.x), y: Math.round(center.y) })
          .down({ button: 0 })
          .up({ button: 0 })
          )
        // Find the input element — try focused first, then any matching type
        const selectors = [
          // Focused element (most precise)
          '-ios class chain:**/XCUIElementTypeTextField[`hasFocus == 1`]',
          '-ios class chain:**/XCUIElementTypeSecureTextField[`hasFocus == 1`]',
          '-ios class chain:**/XCUIElementTypeSearchField[`hasFocus == 1`]',
          // Any visible element of the type (fallback — some apps don't report hasFocus)
          '-ios class chain:**/XCUIElementTypeSearchField',
          '-ios class chain:**/XCUIElementTypeTextField',
          '-ios class chain:**/XCUIElementTypeSecureTextField',
        ]
        for (const sel of selectors) {
          try {
            const el = await driver.$(sel)
            if (await el.isExisting()) {
              await el.setValue(action.value)
              return { success: true, coordinates: center, boundingBox: bounds }
            }
          } catch { /* try next */ }
        }
        // Last resort — type via keyboard (pass whole string, not split chars)
        await driver.keys([action.value])
        return { success: true, coordinates: center, boundingBox: bounds }
      }

      case 'select': {
        const { center, bounds } = resolver.resolve(action.ref)
        return {
          success: false,
          error: 'select is for HTML dropdowns. Use nativeSelect for iOS native picker wheels, or tap/swipe/tapCoordinate for custom controls.',
          coordinates: center,
          boundingBox: bounds,
        }
      }

      case 'nativeSelect': {
        const { center, bounds } = resolver.resolve(action.ref)
        const refData = this.lastRefs[action.ref]
        if (!isIOSNativeSelectTarget(refData)) {
          return {
            success: false,
            error: 'nativeSelect only supports native iOS picker wheels and picker controls. Use tap, swipe, or tapCoordinate for custom controls.',
            coordinates: center,
            boundingBox: bounds,
          }
        }

        const wheels = await findIOSPickerWheels(driver, this.lastRefs, action.ref, refData)
        if (wheels.length === 0) {
          return {
            success: false,
            error: 'Could not find an iOS picker wheel for nativeSelect. Use tap, swipe, or tapCoordinate for custom controls.',
            coordinates: center,
            boundingBox: bounds,
          }
        }
        if (wheels.length > 1) {
          return {
            success: false,
            error: 'Found multiple iOS picker wheels for nativeSelect. Do not guess which wheel to change; target a specific picker wheel or use tap/swipe/tapCoordinate.',
            coordinates: center,
            boundingBox: bounds,
          }
        }

        const wheel = wheels[0]
        await wheel.setValue(action.value)
        const selectedValue = await getElementValue(wheel)
        let matchStrategy: 'exact' | 'normalized' | 'setValue-accepted' = 'setValue-accepted'
        if (selectedValue === action.value) {
          matchStrategy = 'exact'
        } else if (selectedValue && normalizePickerValue(selectedValue) === normalizePickerValue(action.value)) {
          matchStrategy = 'normalized'
        } else if (selectedValue) {
          return {
            success: false,
            error: `iOS picker wheel value is "${selectedValue}" after nativeSelect, expected "${action.value}".`,
            coordinates: center,
            boundingBox: bounds,
            data: { requestedValue: action.value, matchedValue: selectedValue },
          }
        }

        return {
          success: true,
          coordinates: center,
          boundingBox: bounds,
          data: {
            requestedValue: action.value,
            matchedValue: selectedValue ?? action.value,
            matchStrategy,
          },
        }
      }

      case 'scroll': {
        // Try JS scroll in web context first (more reliable, no direction inversion)
        const webCtx = await this.getWebContext()
        if (webCtx) {
          try {
            await this.ensureContext(webCtx)
            const dx = action.scrollType === 'horizontal' ? action.value : 0
            const dy = action.scrollType === 'vertical' ? action.value : 0
            await driver.execute(
              'window.scrollBy(arguments[0], arguments[1]);',
              dx, dy,
            )
            await this.ensureContext('NATIVE_APP')
            return { success: true }
          } catch {
            try { await this.ensureContext('NATIVE_APP') } catch { /* best-effort */ }
          }
        }

        // Fall back to native touch gesture scroll
        const { width, height } = await driver.getWindowSize()
        const centerX = Math.round(width / 2)
        const centerY = Math.round(height / 2)
        // Invert value for native touch: positive value = scroll down = finger swipes UP
        const scrollStartX = centerX
        const scrollStartY = centerY
        const scrollEndX = action.scrollType === 'horizontal' ? centerX - action.value : centerX
        const scrollEndY = action.scrollType === 'vertical' ? centerY - action.value : centerY
        const scrollDuration = action.duration ?? 300

        await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: scrollStartX, y: scrollStartY })
          .down({ button: 0 })
          .move({ x: scrollEndX, y: scrollEndY, duration: scrollDuration })
          .up({ button: 0 })
          )
        return { success: true }
      }

      case 'swipe': {
        const { width, height } = await driver.getWindowSize()
        let sx = Math.round(width / 2)
        let sy = Math.round(height / 2)

        if (action.ref) {
          const { center } = resolver.resolve(action.ref)
          sx = Math.round(center.x)
          sy = Math.round(center.y)
        }

        const distance = Math.round(height * 0.6)
        const pts = (action.startX !== undefined && action.startY !== undefined &&
                     action.endX !== undefined && action.endY !== undefined)
          ? { startX: action.startX, startY: action.startY,
              endX: action.endX, endY: action.endY }
          : computeSwipe(sx, sy, action.direction, distance)
        warnIfOutOfBounds({ x: pts.startX, y: pts.startY }, { width, height }, 'swipe')
        warnIfOutOfBounds({ x: pts.endX, y: pts.endY }, { width, height }, 'swipe')
        const swipeDuration = action.duration ?? 300

        await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: pts.startX, y: pts.startY })
          .down({ button: 0 })
          .move({ x: pts.endX, y: pts.endY, duration: swipeDuration })
          .up({ button: 0 })
          )
        return {
          success: true,
          startCoordinates: { x: pts.startX, y: pts.startY },
          endCoordinates: { x: pts.endX, y: pts.endY },
        }
      }

      case 'pinch': {
        const { width: pinchW, height: pinchH } = await driver.getWindowSize()
        let pcx = Math.round(pinchW / 2)
        let pcy = Math.round(pinchH / 2)

        if (action.ref) {
          const { center } = resolver.resolve(action.ref)
          pcx = Math.round(center.x)
          pcy = Math.round(center.y)
        }
        if (action.x !== undefined) pcx = action.x
        if (action.y !== undefined) pcy = action.y
        warnIfOutOfBounds({ x: pcx, y: pcy }, { width: pinchW, height: pinchH }, 'pinch')

        const { finger1Start, finger1End, finger2Start, finger2End } = computePinch(pcx, pcy, action.scale)
        const pinchDuration = 500

        await driver.actions([
          driver.action('pointer', { parameters: { pointerType: 'touch' } })
            .move({ x: Math.round(finger1Start.x), y: Math.round(finger1Start.y) })
            .down({ button: 0 })
            .move({ x: Math.round(finger1End.x), y: Math.round(finger1End.y), duration: pinchDuration })
            .up({ button: 0 }),
          driver.action('pointer', { parameters: { pointerType: 'touch' } })
            .move({ x: Math.round(finger2Start.x), y: Math.round(finger2Start.y) })
            .down({ button: 0 })
            .move({ x: Math.round(finger2End.x), y: Math.round(finger2End.y), duration: pinchDuration })
            .up({ button: 0 }),
        ])
        return { success: true, coordinates: { x: pcx, y: pcy } }
      }

      case 'multiTap': {
        const { width: mtW, height: mtH } = await driver.getWindowSize()
        let mtcx = Math.round(mtW / 2)
        let mtcy = Math.round(mtH / 2)

        if (action.ref) {
          const { center } = resolver.resolve(action.ref)
          mtcx = Math.round(center.x)
          mtcy = Math.round(center.y)
        }
        if (action.x !== undefined) mtcx = action.x
        if (action.y !== undefined) mtcy = action.y
        warnIfOutOfBounds({ x: mtcx, y: mtcy }, { width: mtW, height: mtH }, 'multiTap')

        const positions = computeFingerPositions(mtcx, mtcy, action.fingers)
        await driver.actions(
          positions.map(pos =>
            driver.action('pointer', { parameters: { pointerType: 'touch' } })
              .move({ x: Math.round(pos.x), y: Math.round(pos.y) })
              .down({ button: 0 })
              .pause(100)
              .up({ button: 0 })
          )
        )
        return { success: true }
      }

      case 'longpress': {
        const { center } = resolver.resolve(action.ref)
        await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: Math.round(center.x), y: Math.round(center.y) })
          .down({ button: 0 })
          .pause(action.duration ?? 1000)
          .up({ button: 0 })
          )
        return { success: true }
      }

      case 'waitFor': {
        // Use timeout as a deadline, not a blind sleep — the agent loop will
        // re-observe after this returns and check the condition at a higher level.
        await driver.pause(action.timeout ?? 2000)
        return { success: true }
      }

      case 'delay': {
        await driver.pause(action.ms)
        return { success: true }
      }

      case 'keypress': {
        // convertPlatformKeys is a no-op on mobile (no Meta/Control distinction in Appium key codes per D-13)
        for (const rawKey of action.keys) {
          const mapped = KEY_MAP[rawKey] ?? rawKey
          await driver.keys([mapped])
        }
        return { success: true }
      }

      case 'navigate': {
        try {
          await driver.url(action.url)
          this.invalidateWebContext()
          return { success: true }
        } catch {
          return { success: false, error: 'navigate is not supported for this app. Use tap/fill on UI elements to navigate.' }
        }
      }

      case 'hover': {
        return { success: false, error: 'hover is a web-only action. Use tap or longpress instead.' }
      }

      case 'assert': {
        return { success: true }
      }

      // --- New actions ---

      case 'hideKeyboard': {
        try {
          await driver.hideKeyboard()
        } catch {
          // Keyboard may already be hidden
        }
        return { success: true }
      }

      case 'clearText': {
        const { center, bounds } = resolver.resolve(action.ref)
        const clearRefData = this.lastRefs[action.ref]
        const clearRole = clearRefData?.role?.toLowerCase()
        if (clearRole && !IOS_FILLABLE_ROLES.has(clearRole)) {
          return {
            success: false,
            error: `Element ${action.ref} is not fillable (role: ${clearRole}). clearText only works on text inputs. Use a textbox or input element instead.`,
          }
        }
        await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: Math.round(center.x), y: Math.round(center.y) })
          .down({ button: 0 })
          .up({ button: 0 })
          )
        const clearSelectors = [
          '-ios class chain:**/XCUIElementTypeTextField[`hasFocus == 1`]',
          '-ios class chain:**/XCUIElementTypeSecureTextField[`hasFocus == 1`]',
          '-ios class chain:**/XCUIElementTypeSearchField[`hasFocus == 1`]',
          '-ios class chain:**/XCUIElementTypeSearchField',
          '-ios class chain:**/XCUIElementTypeTextField',
          '-ios class chain:**/XCUIElementTypeSecureTextField',
        ]
        for (const sel of clearSelectors) {
          try {
            const el = await driver.$(sel)
            if (await el.isExisting()) {
              await el.clearValue()
              break
            }
          } catch { /* try next */ }
        }
        return { success: true, coordinates: center, boundingBox: bounds }
      }

      case 'openLink': {
        const bundleId = firstNonEmpty(action.appId, action.bundleId, this.bundleId)
        const isWebUrl = /^https?:\/\//i.test(action.url)
        if (!bundleId && !isWebUrl) {
          return { success: false, error: `Missing iOS bundle id for native deep link: ${action.url}` }
        }
        try {
          if (bundleId) {
            const deepLink = (driver as any).deepLink as undefined | ((url: string, appId: string, waitForLaunch?: boolean) => Promise<void>)
            if (typeof deepLink === 'function') {
              await deepLink.call(driver, action.url, bundleId, action.waitForLaunch ?? true)
            } else {
              await driver.execute('mobile: deepLink', { url: action.url, bundleId })
            }
          } else {
            await driver.url(action.url)
          }
          this.invalidateWebContext()
          return { success: true }
        } catch (err) {
          return { success: false, error: `Failed to open link ${action.url}${bundleId ? ` in iOS app ${bundleId}` : ''}: ${err instanceof Error ? err.message : String(err)}` }
        }
      }

      case 'drag': {
        const from = resolver.resolve(action.fromRef)
        const to = resolver.resolve(action.toRef)
        await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: Math.round(from.center.x), y: Math.round(from.center.y) })
          .down({ button: 0 })
          .pause(300)
          .move({ x: Math.round(to.center.x), y: Math.round(to.center.y), duration: 500 })
          .up({ button: 0 })
          )
        return { success: true }
      }

      case 'doubleTap': {
        const { center, bounds } = resolver.resolve(action.ref)
        const x = Math.round(center.x)
        const y = Math.round(center.y)
        await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x, y })
          .down({ button: 0 })
          .up({ button: 0 })
          .pause(50)
          .down({ button: 0 })
          .up({ button: 0 })
          )
        return { success: true, coordinates: center, boundingBox: bounds }
      }

      case 'launchApp': {
        await driver.activateApp(action.bundleId)
        return { success: true }
      }

      case 'stopApp': {
        await driver.terminateApp(action.bundleId)
        return { success: true }
      }

      case 'setOrientation': {
        await driver.setOrientation(action.orientation === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT')
        return { success: true }
      }

      case 'executeScript': {
        const result = await driver.execute(action.command, action.args ?? {})
        return { success: true, data: result }
      }

      case 'tapCoordinate': {
        const x = action.x
        const y = action.y
        const tcVp = await driver.getWindowSize()
        warnIfOutOfBounds({ x, y }, { width: tcVp.width, height: tcVp.height }, 'tapCoordinate')
        await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x, y })
          .down({ button: 0 })
          .up({ button: 0 })
          )
        return { success: true, coordinates: { x, y } }
      }

      case 'readConsoleLogs': {
        await this.pollDeviceLogs()
        const all = [...this.consoleLogs]
        const entries = action.level ? all.filter(e => e.level === action.level) : all
        return { success: true, data: entries }
      }

      default: {
        return { success: false, error: `Unknown action type: ${(action as any).type}` }
      }
    }
  }
}
