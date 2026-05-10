import type { PlatformAdapter, PlatformConfig, ScreenState, Action, ActionResult, ElementInfo, ObserveOptions, ConsoleLogEntry } from '@vostride/agent-qa-core'
import { MobileSetupError, parseMobileSource, MobileElementResolver, KEY_MAP, computeSwipe, computePinch, computeFingerPositions, warnIfOutOfBounds } from '@vostride/agent-qa-core'
import type { MobileRefMap } from '@vostride/agent-qa-core'
import { createAndroidSession } from './session.js'
import type { AndroidAdapterConfig } from './types.js'

const ANDROID_FILLABLE_ROLES = new Set(['textbox', 'searchbox', 'edittext', 'combobox'])
const ANDROID_NATIVE_SELECT_ROLES = new Set(['combobox', 'spinbutton', 'listbox', 'list'])
const ANDROID_NATIVE_SELECT_TYPES = new Set([
  'android.widget.Spinner',
  'android.widget.NumberPicker',
  'android.widget.DatePicker',
  'android.widget.TimePicker',
  'android.widget.ListView',
  'androidx.recyclerview.widget.RecyclerView',
])

async function safePerform(chain: { perform: () => Promise<void> }): Promise<void> {
  try {
    await chain.perform()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('actions') && msg.includes('DELETE')) return
    throw err
  }
}

const LOGCAT_REGEX = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.+?)\s*:\s+(.*)/

const ANDROID_LEVEL_MAP: Record<string, string> = {
  V: 'debug',
  D: 'debug',
  I: 'info',
  W: 'warn',
  E: 'error',
  F: 'error',
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed) return trimmed
  }
  return undefined
}

function isAndroidWebContextName(context: string): boolean {
  const normalized = context.toUpperCase()
  return normalized.includes('CHROMIUM') || normalized.includes('WEBVIEW')
}

function isTargetWebContext(context: string, appPackage: string | null, explicitBrowserMode: boolean): boolean {
  if (explicitBrowserMode) return isAndroidWebContextName(context)
  if (!appPackage) return false
  return context.toLowerCase().includes(appPackage.toLowerCase())
}

function isAndroidNativeSelectTarget(refData: MobileRefMap[string] | undefined): boolean {
  const role = refData?.role?.toLowerCase()
  return Boolean(
    (role && ANDROID_NATIVE_SELECT_ROLES.has(role))
    || (refData?.nativeType && ANDROID_NATIVE_SELECT_TYPES.has(refData.nativeType))
  )
}

function androidUiSelectorText(value: string): string {
  return `android=new UiSelector().text(${JSON.stringify(value)})`
}

function androidUiSelectorDescription(value: string): string {
  return `android=new UiSelector().description(${JSON.stringify(value)})`
}

async function findAndroidNativeOption(
  driver: WebdriverIO.Browser,
  value: string,
): Promise<{ element: any; matchedValue: string; matchStrategy: 'text' | 'description' } | null> {
  for (const [selector, matchStrategy] of [
    [androidUiSelectorText(value), 'text'],
    [androidUiSelectorDescription(value), 'description'],
  ] as const) {
    try {
      const element = await driver.$(selector)
      if (await element.isExisting()) {
        return { element, matchedValue: value, matchStrategy }
      }
    } catch {
      // Try the next exact selector.
    }
  }
  return null
}

function parseLogcatLine(message: string, timestamp: number, appPid: string | null): ConsoleLogEntry | null {
  const match = message.match(LOGCAT_REGEX)
  if (!match) return null
  const [, , , pid, , levelChar, tag, text] = match
  if (appPid && pid !== appPid) return null
  return {
    level: ANDROID_LEVEL_MAP[levelChar] ?? 'debug',
    text: `[${tag.trim()}] ${text.trim()}`,
    timestamp,
  }
}

// Injected into the browser to build an accessibility tree from the live DOM.
// Defined as a string because this runs in browser context — the Node tsconfig
// has no DOM lib so a typed function would fail compilation.
const WEB_OBSERVER_SCRIPT = `
return (function() {
  var TAG_ROLES = {
    A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox',
    SELECT: 'combobox', H1: 'heading', H2: 'heading', H3: 'heading',
    H4: 'heading', H5: 'heading', H6: 'heading', IMG: 'image'
  };

  var vh = window.innerHeight;
  var vw = window.innerWidth;
  var refCounter = 0;
  var elements = [];
  var refs = {};
  var lines = [];
  var seen = {};

  var all = document.querySelectorAll(
    'a, button, input, textarea, select, h1, h2, h3, h4, h5, h6, img[alt], [role]'
  );

  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    var tag = el.tagName;
    var ariaRole = el.getAttribute('role');
    var role = ariaRole || TAG_ROLES[tag] || null;
    if (!role) continue;

    var name = '';
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      name = ariaLabel;
    } else if (tag === 'IMG') {
      name = el.alt || '';
    } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
      name = el.getAttribute('placeholder') || el.value || '';
    } else {
      name = (el.textContent || '').trim();
    }

    name = name.slice(0, 100).replace(/[\\n\\r]+/g, ' ').trim();
    if (!name && role !== 'textbox') continue;

    var key = role + ':' + name;
    if (seen[key]) continue;
    seen[key] = true;

    refCounter++;
    var ref = 'e' + refCounter;

    var bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };

    var offscreen = bounds.y + bounds.height < 0 || bounds.y > vh;

    elements.push({ ref: ref, role: role, name: name, attributes: {} });
    refs[ref] = { role: role, name: name, bounds: bounds };

    var line = '- ' + role + ' "' + name.replace(/"/g, "'") + '" [ref=' + ref + ']';
    if (offscreen) line += ' [offscreen]';
    lines.push(line);
  }

  var visCount = 0, aboveCount = 0, belowCount = 0;
  var refKeys = Object.keys(refs);
  for (var j = 0; j < refKeys.length; j++) {
    var b = refs[refKeys[j]].bounds;
    if (b.y + b.height <= 0) aboveCount++;
    else if (b.y >= vh) belowCount++;
    else visCount++;
  }

  var header = 'Current page: ' + location.href + '\\n';
  header += '[Viewport: ' + vw + 'x' + vh + ']';
  if (aboveCount > 0 || belowCount > 0) {
    header += ' [' + visCount + ' visible, ' + aboveCount + ' above, ' + belowCount + ' below]';
  }

  return {
    tree: header + '\\n' + lines.join('\\n'),
    elements: elements,
    refs: refs,
    url: location.href,
    viewportHeight: vh,
    viewportWidth: vw
  };
})();
`

export class AndroidPlatformAdapter implements PlatformAdapter {
  readonly platform = 'android' as const

  private driver: WebdriverIO.Browser | null = null
  private lastRefs: MobileRefMap = {}
  private config: AndroidAdapterConfig | null = null
  // Tracks the active web context name (e.g. 'CHROMIUM', 'WEBVIEW_...').
  // null means last observation was native-only.
  private activeWebContext: string | null = null
  // Cached so we skip redundant switchContext round-trips.
  private currentContext: string | null = null
  // Video recording state
  private recordingEnabled = false
  private videoDir: string | null = null
  private videoPath: string | null = null
  private consoleLogs: ConsoleLogEntry[] = []
  private consoleDrainIndex = 0
  private captureConsole = true
  private appPackage: string | null = null
  private appPid: string | null = null

  async setup(config: PlatformConfig): Promise<void> {
    this.config = config as AndroidAdapterConfig
    this.captureConsole = config.logCapture?.console !== false
    this.appPackage = this.config.appPackage ?? (config.device?.match?.appPackage as string | undefined) ?? null

    this.driver = await createAndroidSession(this.config, config.farmSession)

    // Explicitly launch the app after session creation.
    // Appium with noReset:true doesn't always auto-launch pre-installed apps
    // even when appPackage+appActivity are set in capabilities.
    const appPackage = this.appPackage
    if (appPackage && !this.config.browserName && !this.config.device?.match?.browserName) {
      try {
        await this.driver.activateApp(appPackage)
      } catch (err) {
        throw new MobileSetupError({
          category: 'app-launch',
          message: `Failed to launch Android app "${appPackage}": ${err instanceof Error ? err.message : String(err)}`,
          platform: 'android',
          deviceName: config.device?.name,
          appId: appPackage,
          cause: err,
        })
      }
    }

    // Resolve app PID for logcat filtering only when explicitly enabled. Appium
    // 3 blocks mobile: shell unless the server is started with adb_shell enabled.
    if (process.env.AGENT_QA_ANDROID_USE_MOBILE_SHELL === '1' && this.appPackage && this.driver) {
      try {
        const result = String(await this.driver.execute('mobile: shell', { command: 'pidof', args: [this.appPackage] }))
        const pid = result?.trim()
        if (pid && /^\d+$/.test(pid)) this.appPid = pid
      } catch {
        // mobile shell may be disabled — logs will be unfiltered
      }
    }

    // Start screen recording if configured
    if (config.recording?.enabled && this.driver) {
      this.videoDir = config.recording.videoDir
      const videoSize = config.recording.videoSize
        ? `${config.recording.videoSize.width}x${config.recording.videoSize.height}`
        : undefined
      // Try WebdriverIO wrapper first (works across Appium 1.x + 2.x), then mobile: command
      try {
        await (this.driver as any).startRecordingScreen({ videoSize, timeLimit: 1800, forceRestart: true })
        this.recordingEnabled = true
      } catch {
        try {
          await this.driver.execute('mobile: startScreenRecording', {
            videoSize, timeLimit: 1800, forceRestart: true,
          })
          this.recordingEnabled = true
        } catch {
          // Recording not supported by this Appium/device setup
        }
      }
    }
  }

  async cleanup(): Promise<void> {
    // Stop recording before closing the session
    if (this.recordingEnabled && this.driver) {
      try {
        await this.stopAndSaveRecording()
      } catch {
        // best-effort
      }
    }

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
    this.appPackage = null
    this.appPid = null
    this.activeWebContext = null
    this.currentContext = null
    this.recordingEnabled = false
  }

  // Whether we've ever successfully observed via a web context.
  // Once true, we know a WebView/browser exists and should retry rather than
  // falling back to native (which returns an opaque WebView and can crash UiAutomator2).
  private hasSeenWebContext = false

  async observe(_options?: ObserveOptions): Promise<ScreenState> {
    if (!this.driver) {
      throw new Error('AndroidPlatformAdapter not initialized — call setup() first')
    }

    // Dynamically detect web contexts (handles browserName sessions, native browser
    // apps like Chrome opened via appPackage, and hybrid apps with WebViews).
    const webState = await this.tryObserveWeb()
    if (webState) {
      this.hasSeenWebContext = true
      return webState
    }

    // If we previously had web content, the page is likely transitioning (navigation,
    // new tab, etc.).  Wait for the web context to come back before giving up.
    if (this.hasSeenWebContext) {
      for (const delay of [2000, 3000]) {
        await this.driver.pause(delay)
        const retry = await this.tryObserveWeb()
        if (retry) return retry
      }
    }

    // No web context available — fall back to native XML observation.
    // Wrapped in try-catch because calling getPageSource() on Chrome's native
    // view hierarchy can crash UiAutomator2's instrumentation process.
    this.activeWebContext = null
    try {
      return await this.observeNative()
    } catch {
      return {
        tree: '(native observation unavailable — WebView content not accessible)',
        elements: [],
        timestamp: Date.now(),
        metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
      }
    }
  }

  async execute(action: Action): Promise<ActionResult> {
    if (!this.driver) {
      throw new Error('AndroidPlatformAdapter not initialized — call setup() first')
    }

    try {
      // Ensure we're in the right context before acting
      if (this.activeWebContext) {
        await this.ensureContext(this.activeWebContext)
      }
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
    if (this.activeWebContext) {
      await this.ensureContext(this.activeWebContext)
    } else {
      try { await this.ensureContext('NATIVE_APP') } catch { /* best-effort */ }
    }
    const buf = await this.captureScreenshot()
    if (buf && this.driver) {
      // D-19 / D-20 (Phase 138.1.1): Android screenshot dims differ from getWindowSize() on WebView
      // (1080x2274 image vs 411x810 viewport — ~6% vertical AR drift from URL bar, per D-13/D-14).
      // On native, dims match (1080x2400 == 1080x2400 getWindowSize). Phase 142 removed all
      // scaling code — coords are viewport-space identity. Log kept for diagnostics.
      try {
        const { getImageDimensions } = await import('@vostride/agent-qa-core')
        const dims = await getImageDimensions(buf)
        const { width } = await this.driver.getWindowSize()
        if (dims && Math.abs(dims.width - width) > 1) {
          // eslint-disable-next-line no-console
          console.warn(`[android-adapter] screenshot width ${dims.width} != window width ${width} (coord-space divergence, handled by scaleFactor per D-19/D-20)`)
        }
      } catch { /* best-effort assertion */ }
    }
    return buf
  }

  // ---------------------------------------------------------------------------
  // Device log capture
  // ---------------------------------------------------------------------------

  async pollDeviceLogs(): Promise<void> {
    if (!this.captureConsole) return
    if (!this.driver) return
    try {
      const logs = await this.driver.getLogs('logcat') as { message: string; timestamp?: number }[]
      for (const entry of logs) {
        const parsed = parseLogcatLine(entry.message, entry.timestamp ?? Date.now(), this.appPid)
        if (!parsed) continue
        this.consoleLogs.push(parsed)
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
  // Video recording
  // ---------------------------------------------------------------------------

  async getVideoPath(): Promise<string | null> {
    if (this.recordingEnabled && !this.videoPath && this.driver) {
      await this.stopAndSaveRecording()
    }
    return this.videoPath
  }

  private async stopAndSaveRecording(): Promise<void> {
    if (!this.driver || !this.videoDir) return
    this.recordingEnabled = false

    let base64Video: string | undefined
    // Try WebdriverIO wrapper first, then mobile: command
    try {
      base64Video = await (this.driver as any).stopRecordingScreen()
    } catch {
      try {
        base64Video = await this.driver.execute('mobile: stopScreenRecording') as unknown as string
      } catch {
        // Recording stop failed
      }
    }
    if (!base64Video) return

    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')

    mkdirSync(this.videoDir, { recursive: true })
    const filename = `android-${Date.now()}.mp4`
    const filePath = join(this.videoDir, filename)
    writeFileSync(filePath, Buffer.from(base64Video, 'base64'))
    this.videoPath = filePath
  }

  // ---------------------------------------------------------------------------
  // Observation
  // ---------------------------------------------------------------------------

  private async tryObserveWeb(): Promise<ScreenState | null> {
    const driver = this.driver!
    try {
      const contexts = await driver.getContexts() as string[]
      const explicitBrowserMode = Boolean(this.config?.browserName || this.config?.device?.match?.browserName)
      const webCtx = contexts.find(c =>
        typeof c === 'string' && isTargetWebContext(c, this.appPackage, explicitBrowserMode)
      )
      if (!webCtx) return null

      await this.ensureContext(webCtx)

      const result = await driver.execute(WEB_OBSERVER_SCRIPT) as unknown as {
        tree: string
        elements: ElementInfo[]
        refs: MobileRefMap
        url: string
        viewportHeight: number
        viewportWidth: number
      } | null

      if (!result || !result.elements || result.elements.length === 0) return null

      this.lastRefs = result.refs
      this.activeWebContext = webCtx

      return {
        tree: result.tree,
        elements: result.elements,
        url: result.url,
        timestamp: Date.now(),
        metadata: {
          coordSpace: 'viewport' as const,
          viewportWidth: result.viewportWidth,
          viewportHeight: result.viewportHeight,
          refMap: result.refs,
        },
      }
    } catch {
      // Web observation failed — caller will fall back to native
      return null
    }
  }

  private async observeNative(): Promise<ScreenState> {
    const driver = this.driver!

    await this.ensureContext('NATIVE_APP')

    const [xml, viewport] = await Promise.all([
      driver.getPageSource(),
      driver.getWindowSize(),
    ])
    const parsed = parseMobileSource(xml, 'android', viewport)
    this.lastRefs = parsed.refs

    return {
      tree: parsed.tree,
      elements: parsed.elements,
      timestamp: Date.now(),
      metadata: { coordSpace: 'viewport' as const, viewportWidth: viewport.width, viewportHeight: viewport.height, refMap: parsed.refs },
    }
  }

  // ---------------------------------------------------------------------------
  // Context management
  // ---------------------------------------------------------------------------

  private async ensureContext(target: string): Promise<void> {
    if (this.currentContext === target) return
    try {
      await this.driver!.switchContext(target)
      this.currentContext = target
    } catch {
      // If switch fails, clear cache so next call retries
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
    const inWeb = !!this.activeWebContext

    switch (action.type) {
      case 'tap':
      case 'click': {
        const { center, bounds } = resolver.resolve(action.ref)
        if (inWeb) {
          await driver.execute(
            'var el = document.elementFromPoint(arguments[0], arguments[1]); if (el) el.click();',
            center.x, center.y,
          )
        } else {
          await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
            .move({ x: Math.round(center.x), y: Math.round(center.y) })
            .down({ button: 0 })
            .up({ button: 0 })
            )
        }
        return { success: true, coordinates: center, boundingBox: bounds }
      }

      case 'fill': {
        const { center, bounds } = resolver.resolve(action.ref)
        const refData = this.lastRefs[action.ref]
        const role = refData?.role?.toLowerCase()
        if (role && !ANDROID_FILLABLE_ROLES.has(role)) {
          return {
            success: false,
            error: `Element ${action.ref} is not fillable (role: ${role}). Use a textbox or input element instead.`,
          }
        }
        if (inWeb) {
          await driver.execute(
            'var el = document.elementFromPoint(arguments[0], arguments[1]);'
            + 'if (el) { el.focus(); el.click(); }',
            center.x, center.y,
          )
          await driver.execute(
            'var el = document.activeElement;'
            + 'if (el) { el.value = ""; el.value = arguments[0];'
            + 'el.dispatchEvent(new Event("input", {bubbles:true})); }',
            action.value,
          )
          return { success: true, coordinates: center, boundingBox: bounds }
        }
        // Native fill — tap to focus, then clear + type
        await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: Math.round(center.x), y: Math.round(center.y) })
          .down({ button: 0 })
          .up({ button: 0 })
          )
        try {
          const el = await driver.$('//*[@focused="true"]')
          if (await el.isExisting()) {
            await el.setValue(action.value)
            return { success: true, coordinates: center, boundingBox: bounds }
          }
        } catch {
          // fall through to last resort
        }
        // Last resort — type via keyboard (pass whole string, not split chars)
        await driver.keys([action.value])
        return { success: true, coordinates: center, boundingBox: bounds }
      }

      case 'select': {
        const { center, bounds } = resolver.resolve(action.ref)
        if (inWeb) {
          await driver.execute(
            'var el = document.elementFromPoint(arguments[0], arguments[1]);'
            + 'if (el) { el.value = arguments[2];'
            + 'el.dispatchEvent(new Event("change", {bubbles:true})); }',
            center.x, center.y, action.value,
          )
          return { success: true, coordinates: center, boundingBox: bounds }
        } else {
          return {
            success: false,
            error: 'select is for HTML dropdowns. Use nativeSelect for Android native picker/dropdown/list controls, or tap/swipe/tapCoordinate for custom controls.',
            coordinates: center,
            boundingBox: bounds,
          }
        }
      }

      case 'nativeSelect': {
        const { center, bounds } = resolver.resolve(action.ref)
        const refData = this.lastRefs[action.ref]
        if (!isAndroidNativeSelectTarget(refData)) {
          return {
            success: false,
            error: 'nativeSelect only supports native Android picker/dropdown/list controls. Use tap, swipe, or tapCoordinate for custom controls.',
            coordinates: center,
            boundingBox: bounds,
          }
        }

        await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: Math.round(center.x), y: Math.round(center.y) })
          .down({ button: 0 })
          .up({ button: 0 })
          )

        const option = await findAndroidNativeOption(driver, action.value)
        if (!option) {
          return {
            success: false,
            error: `Could not find native Android option "${action.value}". Open the control with tap, then use swipe/tap/tapCoordinate for custom controls.`,
            coordinates: center,
            boundingBox: bounds,
          }
        }

        if (typeof option.element.click === 'function') {
          await option.element.click()
        } else {
          return {
            success: false,
            error: `Could not click native Android option "${action.value}". Use tap, swipe, or tapCoordinate for custom controls.`,
            coordinates: center,
            boundingBox: bounds,
          }
        }

        return {
          success: true,
          coordinates: center,
          boundingBox: bounds,
          data: {
            requestedValue: action.value,
            matchedValue: option.matchedValue,
            matchStrategy: option.matchStrategy,
          },
        }
      }

      case 'scroll': {
        if (inWeb) {
          const dx = action.scrollType === 'horizontal' ? action.value : 0
          const dy = action.scrollType === 'vertical' ? action.value : 0
          await driver.execute(
            'window.scrollBy(arguments[0], arguments[1]);',
            dx, dy,
          )
          return { success: true }
        }
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
        if (inWeb) {
          await this.ensureContext('NATIVE_APP')
        }
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
        if (inWeb) {
          await this.ensureContext(this.activeWebContext!)
        }
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
          try { await driver.execute('mobile: pressKey', { keycode: 4 }) } catch { /* best-effort */ }
        }
        return { success: true }
      }

      case 'clearText': {
        const { center, bounds } = resolver.resolve(action.ref)
        const clearRefData = this.lastRefs[action.ref]
        const clearRole = clearRefData?.role?.toLowerCase()
        if (clearRole && !ANDROID_FILLABLE_ROLES.has(clearRole)) {
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
        try {
          const el = await driver.$('//*[@focused="true"]')
          if (await el.isExisting()) {
            await el.clearValue()
          }
        } catch {
          // best-effort
        }
        return { success: true, coordinates: center, boundingBox: bounds }
      }

      case 'openLink': {
        const appPackage = firstNonEmpty(action.appId, action.appPackage, this.appPackage)
        const isWebUrl = /^https?:\/\//i.test(action.url)
        if (!appPackage && !isWebUrl) {
          return { success: false, error: `Missing Android app package for native deep link: ${action.url}` }
        }
        try {
          if (appPackage) {
            await driver.execute('mobile: deepLink', { url: action.url, package: appPackage })
          } else {
            await driver.url(action.url)
          }
          return { success: true }
        } catch (err) {
          if (!isWebUrl) {
            return { success: false, error: `Failed to open link ${action.url} in Android app ${appPackage}: ${err instanceof Error ? err.message : String(err)}` }
          }
          try {
            await driver.url(action.url)
            return { success: true }
          } catch (fallbackErr) {
            return { success: false, error: `Failed to open link: ${action.url}: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}` }
          }
        }
      }

      case 'drag': {
        const from = resolver.resolve(action.fromRef)
        const to = resolver.resolve(action.toRef)
        if (inWeb) await this.ensureContext('NATIVE_APP')
        await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: Math.round(from.center.x), y: Math.round(from.center.y) })
          .down({ button: 0 })
          .pause(300)
          .move({ x: Math.round(to.center.x), y: Math.round(to.center.y), duration: 500 })
          .up({ button: 0 })
          )
        if (inWeb) await this.ensureContext(this.activeWebContext!)
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
        if (inWeb) {
          await driver.execute(
            'var el = document.elementFromPoint(arguments[0], arguments[1]); if (el) el.click();',
            x, y,
          )
        } else {
          await safePerform(driver.action('pointer', { parameters: { pointerType: 'touch' } })
            .move({ x, y })
            .down({ button: 0 })
            .up({ button: 0 })
            )
        }
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
