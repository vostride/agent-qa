import type {
  ActionsFor,
  ActionResult,
  AppRegistryEntry,
  FillRefusalMeta,
  FillSubmitMeta,
  FillVerdictMeta,
  ConsoleLogEntry,
  Direction,
  InterimNode,
  LiveStreamCapability,
  ObserveOptions,
  PlatformAdapter,
  PlatformConfig,
  ScrollPrimitives,
  SwipeSignal,
} from '@vostride/agent-qa-runner'
import {
  assertNever,
  buildScreenState,
  compareFillReread,
  createSnapshotLiveStream,
  resolveAppName,
  runDirectionScroll,
  runToEndScroll,
  runUntilVisibleLoop,
} from '@vostride/agent-qa-runner'
import type { Ref, ScreenState } from '@vostride/agent-qa-schema'
import {
  KEY_MAP,
  MobileElementResolver,
  MobileSetupError,
  buildRefEntries,
  computeFingerPositions,
  computePinch,
  computeSwipe,
  deriveMobileScroll,
  IOS_EDITABLE_TYPES,
  parseMobileSource,
  warnIfOutOfBounds,
} from '@vostride/agent-qa-core'
import type { MobileRefMap } from '@vostride/agent-qa-core'
// 363 D-08/Q10: sharp image utilities moved to runner-local (sharp left core, its host-adapter home).
import { alignToWindow } from '@vostride/agent-qa-runner-local'
import {
  IOS_SNAPSHOT_FALLBACK_DEPTH,
  IOS_SNAPSHOT_MAX_DEPTH,
  createIOSSession,
  resolveIOSSnapshotDepth,
} from './session.js'
import type { IOSAdapterConfig } from './types.js'

const IOS_NATIVE_SELECT_TYPES = new Set([
  'XCUIElementTypePickerWheel',
  'XCUIElementTypePicker',
  'XCUIElementTypeDatePicker',
  'XCUIElementTypePopUpButton',
  'XCUIElementTypeComboBox',
])
const IOS_NATIVE_SELECT_ROLES = new Set(['pickerwheel', 'spinbutton', 'combobox'])

const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735a1b0f2d'

const IOS_SNAPSHOT_PROBE_INTERVAL = 20

function errorNameAndMessage(err: unknown): string {
  return err instanceof Error ? `${err.name} ${err.message}` : String(err)
}

function isIOSSnapshotDepthError(err: unknown): boolean {
  return /kAXErrorIllegalArgument/i.test(errorNameAndMessage(err))
}

// getPageSource takes no element, so a stale-element error there is about the Application snapshot.
function isIOSSnapshotReadError(err: unknown): boolean {
  return /getting snapshot|stale element/i.test(errorNameAndMessage(err))
}
const FOCUS_POLLS = 3
const FOCUS_POLL_PAUSE_MS = 300
const RECT_TOLERANCE = 1

type Rect = { x: number; y: number; width: number; height: number }
type IOSTextElement = {
  elementId: string
  getAttribute: (name: string) => Promise<string | null>
  setValue: (value: string) => Promise<void>
  addValue: (value: string) => Promise<void>
  clearValue: () => Promise<void>
}
type IOSTextTarget = { el: IOSTextElement; rect: Rect }
type FocusOutcome = 'focused' | 'elsewhere' | 'none'
type TextBox = { coordinates: { x: number; y: number }; boundingBox: Rect }

const MULTI_LINE_SUBMIT_NOTICE =
  'submit not sent: Return would add a new line in this multi-line field; tap its send or submit control'

// pressButton: schema button → XCUITest hardware name. Volume buttons are real-devices-only.
const IOS_BUTTON_NAME: Record<'home' | 'volumeUp' | 'action', string> = {
  home: 'home',
  volumeUp: 'volumeup',
  action: 'action',
}
const VOLUME_BUTTONS = new Set<string>(['volumeUp'])

// pickerSelect index lane: bounded relative-stepping cap (OQ2). An index beyond this is a §7.1
// range error; reaching a valid index resets to the top with this many `previous` steps first.
const MAX_PICKER_INDEX = 20
const IOS_SAFARI_BUNDLE_ID = 'com.apple.mobilesafari'
const IOS_SPRINGBOARD_BUNDLE_ID = 'com.apple.springboard'
const IOS_LINK_HANDOFF_POLLS = 12
const IOS_LINK_HANDOFF_PAUSE_MS = 500

function firstErrorLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]
}

// A zero-duration touch does not reliably flip an iOS 27 switch knob; a held one does.
const IOS_TAP_HOLD_MS = 100

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

function rectMatches(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) <= RECT_TOLERANCE
    && Math.abs(a.y - b.y) <= RECT_TOLERANCE
    && Math.abs(a.width - b.width) <= RECT_TOLERANCE
    && Math.abs(a.height - b.height) <= RECT_TOLERANCE
}

function rectWithin(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x - RECT_TOLERANCE
    && inner.y >= outer.y - RECT_TOLERANCE
    && inner.x + inner.width <= outer.x + outer.width + RECT_TOLERANCE
    && inner.y + inner.height <= outer.y + outer.height + RECT_TOLERANCE
}

function elementIdOf(ref: unknown): string | undefined {
  if (!ref || typeof ref !== 'object') return undefined
  const record = ref as Record<string, unknown>
  const id = record[W3C_ELEMENT_KEY] ?? record.ELEMENT
  return typeof id === 'string' && id ? id : undefined
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

/**
 * Escape untrusted target text for interpolation into an XCUITest NSPredicate `CONTAINS` literal
 * (T-359-01 · Pitfall 9). Backslash-escape backslashes FIRST, then double quotes, so the raw text
 * can never break out of the quoted literal. Control characters cannot be represented safely in
 * the predicate language, so a target carrying any is rejected with a structured error rather than
 * being interpolated verbatim (T-352-11 posture).
 */
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/
function escapeIOSPredicateText(value: string): string {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(
      `scroll target contains a control character and cannot be used as an XCUITest predicate — provide a plain-text target for untilVisible.`,
    )
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** NSPredicate matching the target across the accessible label/name/value fields (A5, Pattern 3 iOS). */
function buildIOSPredicate(target: string): string {
  const escaped = escapeIOSPredicateText(target)
  return `label CONTAINS "${escaped}" OR name CONTAINS "${escaped}" OR value CONTAINS "${escaped}"`
}

/** Scroll intent (reveal content toward `direction`) maps to the OPPOSITE finger swipe. */
function fingerDirectionFor(scroll: Direction): 'up' | 'down' | 'left' | 'right' {
  switch (scroll) {
    case 'up':
      return 'down'
    case 'down':
      return 'up'
    case 'left':
      return 'right'
    case 'right':
      return 'left'
  }
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

export class IOSPlatformAdapter implements PlatformAdapter<'ios'> {
  readonly platform = 'ios' as const

  private driver: WebdriverIO.Browser | null = null
  private lastRefs: MobileRefMap = {}
  private config: IOSAdapterConfig | null = null
  // Web context detected from getContexts() (e.g. 'WEBVIEW_12345').
  // Used for URL extraction in observe() and JS scroll in execute().
  private activeWebContext: string | null = null
  private webContextChecked = false
  private currentContext: string | null = null
  private liveStreamCapability: LiveStreamCapability | undefined
  private consoleLogs: ConsoleLogEntry[] = []
  private consoleDrainIndex = 0
  private captureConsole = true
  private bundleId: string | null = null
  // EXEC-03 session-cached app registry (D-10/D-12): enumerated once per session. null = not yet
  // enumerated OR enumeration unavailable (iOS simulator — mobile: listApps throws). Reset in cleanup().
  private appRegistry: AppRegistryEntry[] | null = null
  private sessionSnapshotDepth = IOS_SNAPSHOT_MAX_DEPTH
  private snapshotDepth = IOS_SNAPSHOT_MAX_DEPTH
  private readsAtLoweredDepth = 0
  private snapshotDepthWarned = false

  async setup(config: PlatformConfig): Promise<void> {
    this.config = config as IOSAdapterConfig
    this.captureConsole = config.logCapture?.console !== false
    this.bundleId = this.config.bundleId ?? (config.device?.match?.bundleId as string | undefined) ?? null
    this.sessionSnapshotDepth = resolveIOSSnapshotDepth()
    this.snapshotDepth = this.sessionSnapshotDepth
    this.readsAtLoweredDepth = 0
    this.snapshotDepthWarned = false

    this.driver = await createIOSSession(this.config)

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
    try { await this.liveStreamCapability?.stop() } catch { /* best-effort */ }
    this.liveStreamCapability = undefined

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
    this.appRegistry = null
    this.activeWebContext = null
    this.webContextChecked = false
    this.currentContext = null
    this.sessionSnapshotDepth = IOS_SNAPSHOT_MAX_DEPTH
    this.snapshotDepth = IOS_SNAPSHOT_MAX_DEPTH
    this.readsAtLoweredDepth = 0
    this.snapshotDepthWarned = false
  }

  /**
   * 428 D-11: the labelled 1s snapshot preview, over `captureScreenshot()` — `takeScreenshot()`
   * and nothing else. Never `screenshot()`: that one switches the Appium context, and a tick
   * landing between a step's context switch and its command would run the command in the wrong
   * context. Declared before the driver exists (a capture then answers `undefined`), so the
   * composition's selection never falls through to `screenshot()`.
   */
  get liveStream(): LiveStreamCapability {
    this.liveStreamCapability ??= createSnapshotLiveStream({ capture: () => this.captureScreenshot() })
    return this.liveStreamCapability
  }

  async observe(_options?: ObserveOptions): Promise<ScreenState> {
    if (!this.driver) {
      throw new Error('IOSPlatformAdapter not initialized — call setup() first')
    }

    // Ensure native context for XCUITest observation (which CAN see into WebViews on iOS)
    await this.ensureContext('NATIVE_APP')

    const [xml, viewport] = await Promise.all([
      this.readIOSPageSource(),
      this.driver.getWindowSize(),
    ])

    // Shared builder pipeline (D-01/D-08/D-10): the parser lifts XCUITest attributes
    // into platform-neutral interim nodes (value/selected/enabled, XML nesting →
    // hierarchy, missing signals typed-absent — no fabrication in this adapter), the
    // one runner-owned builder mints refs and assembles the schema v2 ScreenState, and
    // buildRefEntries reconstructs the execute-time lastRefs locator record.
    const { nodes } = parseMobileSource(xml, 'ios', viewport)
    const scroll = deriveMobileScroll(nodes, viewport)

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

    const { state, binding } = buildScreenState({
      platform: 'ios',
      nodes,
      viewport,
      scroll,
      coordSpace: 'viewport',
      timestamp: Date.now(),
      ...(url !== undefined ? { url } : {}),
    })
    this.lastRefs = buildRefEntries(nodes, binding)
    return state
  }

  async execute(action: ActionsFor<'ios'>): Promise<ActionResult> {
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

  private async readForegroundBundleId(): Promise<string | undefined> {
    try {
      const info = await this.driver!.execute('mobile: activeAppInfo')
      if (!info || typeof info !== 'object') return undefined
      const bundleId = (info as { bundleId?: unknown }).bundleId
      return firstNonEmpty(typeof bundleId === 'string' ? bundleId : undefined)
    } catch {
      return undefined
    }
  }

  private isBrowserSession(): boolean {
    const browserName = this.config?.device?.match?.browserName
    return typeof browserName === 'string' && browserName.trim().length > 0
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
  // Compound behaviors (EXEC-01/02/03)
  // ---------------------------------------------------------------------------

  private async readIOSPageSource(): Promise<string> {
    const driver = this.driver!
    if (
      this.snapshotDepth < this.sessionSnapshotDepth
      && this.readsAtLoweredDepth >= IOS_SNAPSHOT_PROBE_INTERVAL
    ) {
      this.readsAtLoweredDepth = 0
      try {
        await driver.updateSettings({ snapshotMaxDepth: this.sessionSnapshotDepth })
        this.snapshotDepth = this.sessionSnapshotDepth
      } catch {
        // the read proceeds at the lowered depth
      }
    }
    try {
      return this.countLoweredRead(await driver.getPageSource())
    } catch (readErr) {
      const depthError = isIOSSnapshotDepthError(readErr)
      if (!depthError && !isIOSSnapshotReadError(readErr)) throw readErr
      if (depthError && this.snapshotDepth > IOS_SNAPSHOT_FALLBACK_DEPTH) {
        try {
          await driver.updateSettings({ snapshotMaxDepth: IOS_SNAPSHOT_FALLBACK_DEPTH })
        } catch {
          throw readErr
        }
        const failedDepth = this.snapshotDepth
        this.snapshotDepth = IOS_SNAPSHOT_FALLBACK_DEPTH
        this.readsAtLoweredDepth = 0
        if (!this.snapshotDepthWarned) {
          this.snapshotDepthWarned = true
          const detail = (readErr instanceof Error ? readErr.message : String(readErr))
            .split('\n')[0]
            .slice(0, 160)
          console.warn(
            `[ios-adapter] page source failed at snapshotMaxDepth ${failedDepth}; later reads stay at ${IOS_SNAPSHOT_FALLBACK_DEPTH} and retry ${this.sessionSnapshotDepth} every ${IOS_SNAPSHOT_PROBE_INTERVAL} reads (${detail})`,
          )
        }
      }
      return this.countLoweredRead(await driver.getPageSource())
    }
  }

  private countLoweredRead(xml: string): string {
    if (this.snapshotDepth < this.sessionSnapshotDepth) this.readsAtLoweredDepth++
    return xml
  }

  private async tapAt(point: { x: number; y: number }): Promise<void> {
    await this.driver!.action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ x: Math.round(point.x), y: Math.round(point.y) })
      .down({ button: 0 })
      .pause(IOS_TAP_HOLD_MS)
      .up({ button: 0 })
      .perform()
  }

  private async readRect(elementId: string): Promise<Rect | undefined> {
    try {
      const rect = await this.driver!.getElementRect(elementId)
      return rect && typeof rect.x === 'number' ? rect : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The ref's own text-entry element: candidates of its XCUI type (selector built from the fixed
   * type list only, never from app-supplied text) whose rect matches the observed bounds. Only a
   * unique match is used; two or more matches, or none, ⇒ undefined. Position never selects.
   */
  private async locateIOSTextTarget(ref: string): Promise<IOSTextTarget | undefined> {
    const refData = this.lastRefs[ref]
    const nativeType = refData?.nativeType
    const bounds = refData?.bounds
    if (!nativeType || !IOS_EDITABLE_TYPES.has(nativeType) || !bounds) return undefined
    let candidates: IOSTextElement[]
    try {
      candidates = Array.from(await this.driver!.$$(`-ios class chain:**/${nativeType}`) as unknown as IOSTextElement[])
    } catch {
      return undefined
    }
    const matches: IOSTextTarget[] = []
    for (const el of candidates) {
      if (!el?.elementId) continue
      const rect = await this.readRect(el.elementId)
      if (!rect || !rectMatches(rect, bounds)) continue
      matches.push({ el, rect })
    }
    return matches.length === 1 ? matches[0] : undefined
  }

  private async readIOSFocusedIds(): Promise<string[]> {
    const driver = this.driver!
    try {
      const id = elementIdOf(await driver.getActiveElement())
      if (id) return [id]
    } catch {
      // No element reports keyboard focus; fall through to the focus-engine flag.
    }
    const ids: string[] = []
    for (const type of IOS_EDITABLE_TYPES) {
      try {
        const focused = Array.from(await driver.$$(`-ios class chain:**/${type}[\`hasFocus == 1\`]`) as unknown as IOSTextElement[])
        for (const el of focused) if (el?.elementId) ids.push(el.elementId)
      } catch {
        // Try the next type.
      }
    }
    return ids
  }

  /**
   * WDA's typing taps an element that lacks keyboard focus and then sends keystrokes without
   * re-checking focus, so they land wherever focus is. Text is typed only once the target (or
   * a descendant) holds keyboard focus.
   */
  private async confirmIOSKeyboardFocus(target: IOSTextTarget): Promise<FocusOutcome> {
    let outcome: FocusOutcome = 'none'
    for (let poll = 0; poll < FOCUS_POLLS; poll++) {
      if (poll > 0) await this.driver!.pause(FOCUS_POLL_PAUSE_MS)
      const ids = await this.readIOSFocusedIds()
      if (ids.length === 0) {
        outcome = 'none'
        continue
      }
      for (const id of ids) {
        if (id === target.el.elementId) return 'focused'
        const rect = await this.readRect(id)
        if (rect && rectWithin(rect, target.rect)) return 'focused'
      }
      outcome = 'elsewhere'
    }
    return outcome
  }

  private textInputRefusal(
    verb: FillRefusalMeta['verb'],
    ref: string,
    evidence: Exclude<FillRefusalMeta['evidence'], 'text-has-line-breaks'>,
    box?: TextBox,
  ): ActionResult {
    const nothing = verb === 'fill' ? 'Nothing was typed.' : 'Nothing was cleared.'
    let error: string
    switch (evidence) {
      case 'no-editable-signal': {
        const picker = isIOSNativeSelectTarget(this.lastRefs[ref]) ? ' Use nativeSelect for native pickers.' : ''
        error = `Element ${ref} is not editable: the observation carries no editable signal for it.${picker} ${nothing}`
        break
      }
      case 'no-keyboard-focus':
        error = `Element ${ref} is not editable: it did not take keyboard focus when tapped. ${nothing}`
        break
      case 'focus-elsewhere':
        error = `Element ${ref} is not editable here: after tapping it, keyboard focus is on another element. Input is never sent to an element other than the target. ${nothing}`
        break
      case 'stale-target':
        error = `Element ${ref} was not found at its observed position; the screen changed. Re-observe before typing. ${nothing}`
        break
      default:
        return assertNever(evidence)
    }
    const cause: FillRefusalMeta['cause'] = evidence === 'stale-target' ? 'target-not-found' : 'not-editable'
    const fillRefusal: FillRefusalMeta = { verb, cause, evidence }
    return { success: false, error, ...(box ?? {}), metadata: { fillRefusal } }
  }

  /** Gate → own-element lookup → tap → keyboard-focus check shared by fill and clearText. */
  private async focusIOSTextTarget(
    verb: FillRefusalMeta['verb'],
    ref: string,
    box: TextBox,
  ): Promise<{ target: IOSTextTarget } | { refusal: ActionResult }> {
    if (this.lastRefs[ref]?.editable !== true) {
      return { refusal: this.textInputRefusal(verb, ref, 'no-editable-signal') }
    }
    const target = await this.locateIOSTextTarget(ref)
    if (!target) return { refusal: this.textInputRefusal(verb, ref, 'stale-target') }
    await this.tapAt(box.coordinates)
    const focus = await this.confirmIOSKeyboardFocus(target)
    if (focus === 'focused') return { target }
    return {
      refusal: this.textInputRefusal(verb, ref, focus === 'elsewhere' ? 'focus-elsewhere' : 'no-keyboard-focus', box),
    }
  }

  /** A non-empty empty-field hint (XCUITest placeholderValue); undefined when absent. */
  private async readIOSPlaceholder(el: { getAttribute: (name: string) => Promise<string | null> }): Promise<string | undefined> {
    try {
      const hint = await el.getAttribute('placeholderValue')
      return typeof hint === 'string' && hint !== '' ? hint : undefined
    } catch {
      return undefined
    }
  }

  /** Read a focused element's `value` attribute; undefined when nothing is readable. */
  private async readIOSValue(el: { getAttribute: (name: string) => Promise<string | null> }): Promise<string | undefined> {
    try {
      const value = await el.getAttribute('value')
      return typeof value === 'string' ? value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * EXEC-01 iOS fill compound (D-05..D-08). From the SAME focused-element handle: (append) capture
   * the prior value FIRST via getAttribute('value') then addValue, or (replace) setValue; RE-READ
   * via getAttribute('value') on that same handle; verdict via compareFillReread. Secure fields
   * (nativeType XCUIElementTypeSecureTextField) take the non-empty-only lane — the comparator yields
   * length sentinels so no raw value enters the result (T-359-02); bullet masking is tolerated
   * (A3/Pitfall 7 — never a length compare). On a passing re-read AND submit, a return/newline is
   * delivered AFTER the re-read (D-07). Single typing attempt; a mismatch is success:false + §7.1.
   *
   * Append (437 FA-1, owner 2026-10-08): the XCUITest `value` attribute often lags after addValue,
   * so a re-read equal to the prior cannot show the appended text. That fill is recorded unverified:
   * never exact, and never a mismatch. Every fill records the shared verdict as `fillVerdict`.
   * An empty field reads as its placeholder, so an append prior equal to it counts as empty.
   *
   * Return in a multi-line field adds a new line instead of submitting, so a multi-line submit is
   * never sent and is recorded as such.
   *
   * An unreadable re-read is unverified and does not stop a requested Return, as on Android (D-09,
   * D-10; owner 2026-10-09), but focus is confirmed once first and a Return is held as focus-lost
   * when the field no longer has it (444.1 D-10).
   */
  private async fillIOSCompound(
    el: {
      getAttribute: (name: string) => Promise<string | null>
      setValue: (value: string) => Promise<void>
      addValue: (value: string) => Promise<void>
    },
    action: { text: string; clearMode: 'replace' | 'append'; submit: boolean },
    box: TextBox,
    secure: boolean,
    multiline: boolean,
    target: IOSTextTarget,
  ): Promise<ActionResult> {
    const driver = this.driver!
    const isAppend = action.clearMode === 'append'
    // Prior value FIRST for append (expected = prior + typed, D-07) — before any typing.
    let prior = isAppend ? (await this.readIOSValue(el)) ?? '' : ''
    if (prior !== '' && prior === await this.readIOSPlaceholder(el)) prior = ''

    if (isAppend) {
      await el.addValue(action.text)
    } else {
      await el.setValue(action.text)
    }

    const expected = isAppend ? prior + action.text : action.text
    const raw = await this.readIOSValue(el)
    // A lagged append re-read equal to the prior shows nothing of the appended text: unverified.
    const actual = isAppend && raw === prior ? undefined : raw
    const verdict = compareFillReread({ expected, actual, secure })
    const fillVerdict: FillVerdictMeta = {
      verb: 'fill',
      verdict: verdict.verdict,
      ...(verdict.secure ? { secure: true as const } : {}),
    }
    const unsent: FillSubmitMeta = multiline ? { sent: false, reason: 'multi-line-field' } : { sent: false }
    const notice = action.submit && multiline ? { data: MULTI_LINE_SUBMIT_NOTICE } : {}

    // Return/newline AFTER the re-read, only when the fill is not a failure, in a single-line field (D-07).
    let fillSubmit: FillSubmitMeta = unsent
    if (verdict.ok && action.submit && !multiline) {
      if (raw === undefined && (await this.confirmIOSKeyboardFocus(target)) !== 'focused') {
        fillSubmit = { sent: false, reason: 'focus-lost' }
      } else {
        await driver.keys(['\n'])
        fillSubmit = { sent: true }
      }
    }
    const metadata = {
      ...(verdict.meta ? { fillReread: verdict.meta } : {}),
      fillVerdict,
      ...(action.submit ? { fillSubmit } : {}),
    }
    return verdict.ok
      ? { success: true, ...box, ...notice, metadata }
      : { success: false, error: verdict.selfCorrectingError, ...box, ...notice, metadata }
  }

  /**
   * EXEC-02 platform primitives injected into the shared runner scroll loops (D-02/D-03). The swipe
   * is a page-sized directional gesture (inverted to the finger direction) that reports unknown
   * movement; nativeSearchScroll drives
   * the XCUITest `mobile: scroll` predicateString rung over an injection-escaped target; readInterimTree
   * is a light page-source parse — NO refMap mint, NO screenshot, lastRefs untouched.
   */
  private async buildIOSScrollPrimitives(
    scrollDirection: Direction,
    maxSwipes: number,
    factor = 1,
  ): Promise<ScrollPrimitives> {
    const driver = this.driver!
    const viewport = await driver.getWindowSize()
    const axisLength = scrollDirection === 'left' || scrollDirection === 'right' ? viewport.width : viewport.height
    const distance = Math.max(1, Math.round(axisLength * 0.6 * factor))

    return {
      swipeOnce: async (direction: Direction, ref?: Ref): Promise<SwipeSignal> => {
        let sx = Math.round(viewport.width / 2)
        let sy = Math.round(viewport.height / 2)
        if (ref) {
          const { center } = new MobileElementResolver(this.lastRefs).resolve(ref)
          sx = Math.round(center.x)
          sy = Math.round(center.y)
        }
        const pts = computeSwipe(sx, sy, fingerDirectionFor(direction), distance)
        await driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: pts.startX, y: pts.startY })
          .down({ button: 0 })
          .move({ x: pts.endX, y: pts.endY, duration: 300 })
          .up({ button: 0 })
          .perform()
        // XCUITest/WDA report no movement or boundary for a swipe or a direction scroll.
        return 'unknown'
      },
      nativeSearchScroll: async (target: string): Promise<boolean> => {
        // buildIOSPredicate re-validates + escapes; a control char throws (the case already rejected
        // control chars up front, so this is escaping only). Native-rung failure is a soft fallback.
        const predicateString = buildIOSPredicate(target)
        try {
          // direction outranks predicateString in XCUITest's strategy order, so it is never sent here.
          await driver.execute('mobile: scroll', { predicateString })
          return true
        } catch {
          return false
        }
      },
      readInterimTree: async (): Promise<InterimNode[]> => {
        const xml = await this.readIOSPageSource()
        const { nodes } = parseMobileSource(xml, 'ios', viewport)
        return nodes
      },
    }
  }

  /**
   * EXEC-03 openApp (D-10/D-12, Pitfall 5). Resolve a human name to a bundle id (or validate an
   * explicit bundleId) over the session-cached registry, then launch via activateApp. On real devices
   * `mobile: listApps` enumerates the registry; on simulators it throws, leaving the registry
   * unavailable — the appName lane then mints a structured §7.1 error directing to an explicit
   * bundleId, and the bundleId lane validates without the registry (isAppInstalled / activateApp
   * error conversion, A2). Never a best-guess launch (T-359-04); an invalid bundle never succeeds.
   */
  private async openApp(action: { appName: string } | { bundleId: string }): Promise<ActionResult> {
    const driver = this.driver!
    const registry = await this.ensureAppRegistry()

    if ('bundleId' in action) {
      return await this.openByBundleId(action.bundleId, registry)
    }

    // appName variant. Registry unavailable (iOS simulator) ⇒ the §7.1 degradation lane (Pitfall 5).
    if (registry === null) {
      return {
        success: false,
        error:
          `openApp could not enumerate installed apps by name: "mobile: listApps" is unavailable on `
          + `iOS simulators. Retry with an explicit openApp {bundleId} using the app's exact bundle identifier.`,
      }
    }

    let reg = registry
    let resolution = resolveAppName(action.appName, reg)
    if (resolution.kind === 'unknown' || resolution.kind === 'ambiguous') {
      // Re-enumerate exactly once on a MISS before erroring (D-12).
      const fresh = await this.enumerateApps()
      if (fresh !== null) {
        this.appRegistry = fresh
        reg = fresh
        resolution = resolveAppName(action.appName, reg)
      }
    }

    switch (resolution.kind) {
      case 'exact':
      case 'fuzzy':
        await driver.activateApp(resolution.id)
        return { success: true, metadata: { openApp: { resolvedId: resolution.id, matchKind: resolution.kind } } }
      case 'ambiguous':
      case 'unknown': {
        const ids = resolution.candidates.map((c) => c.id).join(', ')
        const lead =
          resolution.kind === 'ambiguous' ? 'is ambiguous between installed apps' : 'did not match an installed app'
        return {
          success: false,
          error: `openApp: "${action.appName}" ${lead}. Closest candidates: ${ids || '(none)'}. Retry openApp {bundleId} with the exact bundle identifier.`,
        }
      }
    }
  }

  /**
   * Explicit `{bundleId}` launch (D-12, A2). With a registry, validate membership; without one
   * (simulator) validate via `driver.isAppInstalled` when the driver exposes it, otherwise attempt
   * `activateApp` and convert a driver rejection into the structured §7.1 error. An invalid bundle
   * NEVER returns success:true.
   */
  private async openByBundleId(bundleId: string, registry: AppRegistryEntry[] | null): Promise<ActionResult> {
    const driver = this.driver!
    if (registry !== null) {
      if (!registry.some((entry) => entry.id === bundleId)) {
        return {
          success: false,
          error: `openApp: bundleId "${bundleId}" is not installed (not in the app registry). Verify the bundle identifier or use openApp {appName}.`,
        }
      }
      await driver.activateApp(bundleId)
      return { success: true, metadata: { openApp: { resolvedId: bundleId, matchKind: 'explicit' } } }
    }

    // Registry unavailable (simulator): validate via isAppInstalled when the driver exposes it.
    const isAppInstalled = (driver as { isAppInstalled?: (id: string) => Promise<boolean> }).isAppInstalled
    if (typeof isAppInstalled === 'function') {
      let installed = false
      try {
        installed = await isAppInstalled.call(driver, bundleId)
      } catch {
        installed = false
      }
      if (!installed) {
        return {
          success: false,
          error: `openApp: bundleId "${bundleId}" is not installed on this device. Verify the bundle identifier.`,
        }
      }
      await driver.activateApp(bundleId)
      return { success: true, metadata: { openApp: { resolvedId: bundleId, matchKind: 'explicit' } } }
    }

    // Last resort — attempt activateApp and convert a rejection into the §7.1 form (never a false success).
    try {
      await driver.activateApp(bundleId)
      return { success: true, metadata: { openApp: { resolvedId: bundleId, matchKind: 'explicit' } } }
    } catch (err) {
      return {
        success: false,
        error: `openApp: could not launch bundleId "${bundleId}": ${err instanceof Error ? err.message : String(err)}. Verify the bundle identifier.`,
      }
    }
  }

  /** Return the cached registry, enumerating once on first use. Failed enumeration returns null (uncached). */
  private async ensureAppRegistry(): Promise<AppRegistryEntry[] | null> {
    if (this.appRegistry !== null) return this.appRegistry
    const enumerated = await this.enumerateApps()
    if (enumerated !== null) this.appRegistry = enumerated
    return enumerated
  }

  /**
   * Enumerate installed apps through the driver only (ownership contract — webdriverio only, no
   * child_process/simctl). `mobile: listApps` maps bundle ids → AppRegistryEntry with CFBundleName
   * labels when present (D-10 — no per-app round-trips). It throws on simulators (Pitfall 5) ⇒ null,
   * leaving enumeration unavailable WITHOUT crashing.
   */
  private async enumerateApps(): Promise<AppRegistryEntry[] | null> {
    const driver = this.driver!
    try {
      const raw = await driver.execute('mobile: listApps')
      return this.mapListApps(raw)
    } catch {
      return null
    }
  }

  /** Coerce a `mobile: listApps` result (bundle-id-keyed map, or an array of entries) into the registry. */
  private mapListApps(raw: unknown): AppRegistryEntry[] {
    const labelOf = (value: unknown): string | undefined => {
      if (!value || typeof value !== 'object') return undefined
      const v = value as Record<string, unknown>
      for (const key of ['CFBundleName', 'CFBundleDisplayName', 'label', 'name']) {
        const candidate = v[key]
        if (typeof candidate === 'string' && candidate.length > 0) return candidate
      }
      return undefined
    }
    const entries: AppRegistryEntry[] = []
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const v = item as Record<string, unknown>
        const id = v.bundleId ?? v.CFBundleIdentifier ?? v.id
        if (typeof id !== 'string' || id.length === 0) continue
        const label = labelOf(item)
        entries.push(label !== undefined ? { id, label } : { id })
      }
    } else if (raw && typeof raw === 'object') {
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!id) continue
        const label = labelOf(value)
        entries.push(label !== undefined ? { id, label } : { id })
      }
    }
    return entries
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private async executeAction(action: ActionsFor<'ios'>): Promise<ActionResult> {
    const driver = this.driver!
    const resolver = new MobileElementResolver(this.lastRefs)

    // Ensure we're in native context for touch gestures
    await this.ensureContext('NATIVE_APP')

    switch (action.type) {
      case 'tap': {
        const { center, bounds } = resolver.resolve(action.ref)
        await this.tapAt(center)
        return { success: true, coordinates: center, boundingBox: bounds }
      }

      case 'fill': {
        // EXEC-01 fill compound (D-05..D-08) over the ref's own element: gate on the observed
        // editable signal, locate by XCUI type + bounds, tap, confirm keyboard focus, then
        // clear/append → type → RE-READ the same handle. A mismatch is an honest single-shot
        // failure (the 358 ladder mediates). Secure is detected from the refMap's nativeType.
        const { center, bounds } = resolver.resolve(action.ref)
        const box = { coordinates: center, boundingBox: bounds }
        const focused = await this.focusIOSTextTarget('fill', action.ref, box)
        if ('refusal' in focused) return focused.refusal
        const nativeType = this.lastRefs[action.ref]?.nativeType
        return await this.fillIOSCompound(
          focused.target.el,
          action,
          box,
          nativeType === 'XCUIElementTypeSecureTextField',
          nativeType === 'XCUIElementTypeTextView',
          focused.target,
        )
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
        // EXEC-02 scroll (D-02/D-03; 436-02 D-24/D-25): ONE ActionResult carrying scrollUntilVisible
        // metadata. untilVisible prefers the native `mobile: scroll` predicateString rung
        // (injection-escaped), then bounded swipes with light page-source probes for target
        // visibility; direction mode is one gesture. iOS swipes report unknown movement, so only
        // the target becoming visible ends a search early; lastRefs is untouched (D-03).
        if (action.mode === 'untilVisible') {
          // Reject a hostile/control-char target up front — never interpolate it (Pitfall 9).
          try {
            escapeIOSPredicateText(action.text)
          } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) }
          }
          const primitives = await this.buildIOSScrollPrimitives(action.direction, action.maxSwipes)
          const { meta } = await runUntilVisibleLoop(primitives, {
            target: action.text,
            direction: action.direction,
            maxSwipes: action.maxSwipes,
            retryOpposite: action.retryOpposite,
            ...(action.ref ? { ref: action.ref } : {}),
          })
          return { success: true, metadata: { scrollUntilVisible: meta } }
        }

        // direction mode: page / halfPage / toEnd.
        const factor = action.amount === 'halfPage' ? 0.5 : 1
        const primitives = await this.buildIOSScrollPrimitives(action.direction, 0, factor)
        if (action.amount === 'toEnd') {
          const { meta } = await runToEndScroll(primitives, action.direction, action.ref)
          return { success: true, metadata: { scrollUntilVisible: meta } }
        }
        const { meta } = await runDirectionScroll(primitives, {
          direction: action.direction,
          ...(action.ref ? { ref: action.ref } : {}),
        })
        return { success: true, metadata: { scrollUntilVisible: meta } }
      }

      case 'swipe': {
        const { width, height } = await driver.getWindowSize()

        // Schema shapes: SwipeByPath drives explicit from/to points; SwipeByDirection computes a
        // page-sized gesture from the (optional ref) center (legacy startX..endY reads retired).
        let pts: { startX: number; startY: number; endX: number; endY: number }
        if (action.mode === 'path') {
          pts = {
            startX: Math.round(action.from.x),
            startY: Math.round(action.from.y),
            endX: Math.round(action.to.x),
            endY: Math.round(action.to.y),
          }
        } else {
          let sx = Math.round(width / 2)
          let sy = Math.round(height / 2)
          if (action.ref) {
            const { center } = resolver.resolve(action.ref)
            sx = Math.round(center.x)
            sy = Math.round(center.y)
          }
          const distance = Math.round(height * 0.6)
          pts = computeSwipe(sx, sy, action.direction, distance)
        }
        warnIfOutOfBounds({ x: pts.startX, y: pts.startY }, { width, height }, 'swipe')
        warnIfOutOfBounds({ x: pts.endX, y: pts.endY }, { width, height }, 'swipe')
        const swipeDuration = action.durationMs

        await driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: pts.startX, y: pts.startY })
          .down({ button: 0 })
          .move({ x: pts.endX, y: pts.endY, duration: swipeDuration })
          .up({ button: 0 })
          .perform()
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

        if ('ref' in action) {
          const { center } = resolver.resolve(action.ref)
          pcx = Math.round(center.x)
          pcy = Math.round(center.y)
        } else {
          pcx = action.x
          pcy = action.y
        }
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

        if ('ref' in action) {
          const { center } = resolver.resolve(action.ref)
          mtcx = Math.round(center.x)
          mtcy = Math.round(center.y)
        } else {
          mtcx = action.x
          mtcy = action.y
        }
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
        await driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: Math.round(center.x), y: Math.round(center.y) })
          .down({ button: 0 })
          .pause(action.duration ?? 1000)
          .up({ button: 0 })
          .perform()
        return { success: true }
      }

      case 'waitFor': {
        // Schema on-modes replace the legacy {condition,timeout} blind pause. text/gone poll the
        // native accessibility tree; selector-mode is a web-only capability (§7.1, catalog pin).
        if (action.on === 'selector') {
          return {
            success: false,
            error: 'waitFor {on:"selector"} (CSS/XPath) is a web-only mode. On native iOS, wait on visible text with waitFor {on:"text"} or {on:"gone"}.',
          }
        }
        const wantPresent = action.on === 'text'
        const needle = action.text
        const deadline = Date.now() + action.timeoutMs
        for (;;) {
          let source = ''
          try {
            source = await this.readIOSPageSource()
          } catch {
            source = ''
          }
          if (source.includes(needle) === wantPresent) return { success: true }
          if (Date.now() >= deadline) break
          await driver.pause(Math.min(250, Math.max(1, deadline - Date.now())))
        }
        return {
          success: false,
          error: wantPresent
            ? `waitFor: text "${needle}" did not appear within ${action.timeoutMs}ms.`
            : `waitFor: text "${needle}" was still present after ${action.timeoutMs}ms.`,
        }
      }

      case 'delay': {
        await driver.pause(action.ms)
        return { success: true }
      }

      case 'keypress': {
        // Schema adds mode:'press'|'down'|'up'. Only 'press' is meaningful on mobile — key
        // hold/release is a web-only lane (§7.1, catalog pin). convertPlatformKeys is a no-op on
        // mobile (no Meta/Control distinction in Appium key codes per D-13).
        if (action.mode !== 'press') {
          return {
            success: false,
            error: `keypress {mode:"${action.mode}"} (key hold/release) is web-only. On mobile, emit keypress {mode:"press"} to send the key.`,
          }
        }
        for (const rawKey of action.keys) {
          const mapped = KEY_MAP[rawKey] ?? rawKey
          await driver.keys([mapped])
        }
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
        const box = { coordinates: center, boundingBox: bounds }
        const focused = await this.focusIOSTextTarget('clearText', action.ref, box)
        if ('refusal' in focused) return focused.refusal
        const { el } = focused.target
        await el.clearValue()
        const remaining = (await this.readIOSValue(el)) ?? ''
        if (remaining === '' || remaining === await this.readIOSPlaceholder(el)) {
          return { success: true, ...box }
        }
        const secure = this.lastRefs[action.ref]?.nativeType === 'XCUIElementTypeSecureTextField'
        const residue = secure ? ` (${remaining.length} characters remain)` : ''
        return {
          success: false,
          error: `Element ${action.ref}: the field still has text after clearing${residue} — re-observe and retry.`,
          ...box,
        }
      }

      case 'openUniversalLink': {
        // Re-key of the proven openLink body (D-19). The openLink verb is retired.
        const explicit = firstNonEmpty(action.bundleId)
        const configured = firstNonEmpty(this.bundleId)
        const openInApp = async (appId: string): Promise<void> => {
          await driver.execute('mobile: deepLink', { url: action.url, bundleId: appId })
        }
        const openScoped = async (appId: string): Promise<ActionResult> => {
          try {
            await openInApp(appId)
            this.invalidateWebContext()
            return { success: true }
          } catch (err) {
            return { success: false, error: `Failed to open universal link ${action.url} in iOS app ${appId}: ${err instanceof Error ? err.message : String(err)}` }
          }
        }
        if (!/^https?:\/\//i.test(action.url)) {
          const bundleId = explicit ?? configured
          if (!bundleId) {
            return { success: false, error: `Missing iOS bundle id for native deep link: ${action.url}` }
          }
          return openScoped(bundleId)
        }
        if (explicit) return openScoped(explicit)
        if (this.isBrowserSession()) {
          try {
            await driver.url(action.url)
            this.invalidateWebContext()
            return { success: true }
          } catch (err) {
            return { success: false, error: `Failed to open universal link ${action.url}: ${err instanceof Error ? err.message : String(err)}` }
          }
        }
        let configuredFailure: string | undefined
        if (configured) {
          try {
            await openInApp(configured)
            this.invalidateWebContext()
            return { success: true }
          } catch (err) {
            configuredFailure = `opening it in the configured iOS app ${configured} failed first: ${firstErrorLine(err)}`
          }
        }
        // The system handler hands an http(s) link no installed app claims to Safari; the
        // before/after foreground check turns that hand-off into a failure. The window (~6 s)
        // covers a cold Safari or app launch, which can take 3-4 s to reach the front.
        const before = await this.readForegroundBundleId()
        try {
          await driver.url(action.url)
        } catch (err) {
          return {
            success: false,
            error: `Failed to open universal link ${action.url} through the iOS system handler: ${firstErrorLine(err)}${configuredFailure ? ` (${configuredFailure})` : ''}`,
          }
        }
        this.invalidateWebContext()
        if (!before || before === IOS_SAFARI_BUNDLE_ID) return { success: true }
        let after: string | undefined
        for (let poll = 0; poll < IOS_LINK_HANDOFF_POLLS; poll++) {
          await driver.pause(IOS_LINK_HANDOFF_PAUSE_MS)
          after = await this.readForegroundBundleId()
          if (after && after !== before && after !== IOS_SPRINGBOARD_BUNDLE_ID) break
        }
        if (after !== IOS_SAFARI_BUNDLE_ID) return { success: true }
        let error = `iOS opened ${action.url} in Safari: no installed app claimed the link (the foreground app was ${before}). Pass bundleId to open it in a specific app, or com.apple.mobilesafari to open it in Safari.`
        if (before !== IOS_SPRINGBOARD_BUNDLE_ID) {
          try {
            await driver.activateApp(before)
            error += ` Returned to ${before}.`
          } catch (err) {
            error += ` Could not return to ${before}: ${firstErrorLine(err)}.`
          }
        }
        return { success: false, error }
      }

      case 'assertValue': {
        // D-10: the adapter RESOLVES the requested source to a raw value on ActionResult.data; the
        // runner-side comparator applies the op and judges. The adapter never compares. url/storage/
        // expr require a live WebView context; sources with no native lane return a §7.1 error
        // naming the platform limitation.
        const webCtx = await this.getWebContext()
        const inWeb = webCtx !== null
        if ('expr' in action) {
          if (!inWeb) {
            return {
              success: false,
              error: 'assertValue {expr} evaluates JavaScript and is only available in an iOS WebView/browser context. Assert on a native signal, or run against a web target.',
            }
          }
          await this.ensureContext(webCtx!)
          const value = await driver.execute(`return (${action.expr});`)
          return { success: true, data: value }
        }
        switch (action.source) {
          case 'url': {
            if (!inWeb) {
              return {
                success: false,
                error: 'assertValue {source:"url"} reads the browser URL and is only available in an iOS WebView/browser context; native screens have no URL.',
              }
            }
            await this.ensureContext(webCtx!)
            const value = await driver.execute('return window.location.href;')
            return { success: true, data: value }
          }
          case 'storage': {
            if (!inWeb) {
              return {
                success: false,
                error: 'assertValue {source:"storage"} reads Web Storage and is only available in an iOS WebView/browser context.',
              }
            }
            await this.ensureContext(webCtx!)
            const value = await driver.execute(
              'return Object.fromEntries(Object.keys(localStorage).map(function(k){return [k, localStorage.getItem(k)];}));',
            )
            return { success: true, data: value }
          }
          case 'network':
            return {
              success: false,
              error: 'assertValue {source:"network"} (HTTP log inspection) is not available on the iOS adapter. Use a web target for network assertions, or assert on visible UI text.',
            }
          case 'expr-result':
            return { success: true, data: undefined }
        }
      }

      case 'drag': {
        const from = resolver.resolve(action.fromRef)
        const to = resolver.resolve(action.toRef)
        await driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: Math.round(from.center.x), y: Math.round(from.center.y) })
          .down({ button: 0 })
          .pause(300)
          .move({ x: Math.round(to.center.x), y: Math.round(to.center.y), duration: 500 })
          .up({ button: 0 })
          .perform()
        return { success: true }
      }

      case 'doubleTap': {
        const { center, bounds } = resolver.resolve(action.ref)
        const x = Math.round(center.x)
        const y = Math.round(center.y)
        await driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x, y })
          .down({ button: 0 })
          .up({ button: 0 })
          .pause(50)
          .down({ button: 0 })
          .up({ button: 0 })
          .perform()
        return { success: true, coordinates: center, boundingBox: bounds }
      }

      case 'openApp':
        // EXEC-03 (D-10/D-12): resolve a human app name (or validate an explicit bundleId) over a
        // session-cached registry, with the simulator degradation lane (Pitfall 5). Never a
        // best-guess launch; an invalid bundle never returns success.
        return await this.openApp(action)

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
        await this.tapAt({ x, y })
        return { success: true, coordinates: { x, y } }
      }

      // --- iOS hardware / native verbs ---

      case 'pressButton': {
        // mobile: pressButton maps the schema button to the XCUITest hardware name. Volume buttons
        // are real-devices-only; on a simulator session `mobile: listApps` is unavailable (the 359
        // listApps precedent) — probe it and mint a §7.1 degradation error rather than crash.
        const name = IOS_BUTTON_NAME[action.button]
        if (VOLUME_BUTTONS.has(action.button)) {
          const registry = await this.enumerateApps()
          if (registry === null) {
            return {
              success: false,
              error:
                `pressButton "${action.button}" (a volume hardware button) is only supported on real devices; `
                + `this appears to be an iOS simulator session, where volume buttons are unavailable. Run against a real device to use volume controls.`,
            }
          }
        }
        await driver.execute('mobile: pressButton', { name })
        return { success: true }
      }

      case 'pickerSelect': {
        // Locate the picker wheel element (elementId feeds the native driver loop).
        const wheel = await driver.$('-ios class chain:**/XCUIElementTypePickerWheel')
        if (!(await wheel.isExisting())) {
          return { success: false, error: 'pickerSelect: no picker wheel is present on screen.' }
        }
        const elementId = (wheel as unknown as { elementId?: string }).elementId
        if ('value' in action) {
          // Value lane — mobile: selectPickerWheelValue scrolls natively until the target value is
          // reached (never a hand-rolled next/next loop, Don't-Hand-Roll row 3).
          await driver.execute('mobile: selectPickerWheelValue', {
            elementId,
            order: 'next',
            value: action.value,
            maxAttempts: 25,
          })
          return { success: true }
        }
        // Index lane — the schema's 0-based wheel index has no absolute-index driver API (OQ2), so
        // reset to the top with bounded `previous` steps then step down `order` `next` positions.
        // An index beyond the bounded cap is a §7.1 range error rather than a silent wrong selection.
        if (!Number.isInteger(action.order) || action.order < 0 || action.order > MAX_PICKER_INDEX) {
          return {
            success: false,
            error:
              `pickerSelect: order ${action.order} is out of range (expected a 0-based wheel index in [0, ${MAX_PICKER_INDEX}]). `
              + `Prefer pickerSelect {value} to select by the visible option text.`,
          }
        }
        for (let i = 0; i < MAX_PICKER_INDEX; i++) {
          await driver.execute('mobile: selectPickerWheelValue', { elementId, order: 'previous', offset: 0.15 })
        }
        for (let i = 0; i < action.order; i++) {
          await driver.execute('mobile: selectPickerWheelValue', { elementId, order: 'next', offset: 0.15 })
        }
        return { success: true }
      }

      case 'swipeFromEdge': {
        // W3C pointer sequence from the named screen-edge boundary moving inward. Coordinates are
        // derived from the live window rect (never hardcoded screen sizes).
        const { width, height } = await driver.getWindowSize()
        const midX = Math.round(width / 2)
        const midY = Math.round(height / 2)
        let start: { x: number; y: number }
        let end: { x: number; y: number }
        switch (action.edge) {
          case 'left':
            start = { x: 0, y: midY }; end = { x: Math.round(width * 0.6), y: midY }; break
          case 'right':
            start = { x: width - 1, y: midY }; end = { x: Math.round(width * 0.4), y: midY }; break
          case 'top':
            start = { x: midX, y: 0 }; end = { x: midX, y: Math.round(height * 0.6) }; break
          case 'bottom':
            start = { x: midX, y: height - 1 }; end = { x: midX, y: Math.round(height * 0.4) }; break
        }
        await driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: start.x, y: start.y })
          .down({ button: 0 })
          .move({ x: end.x, y: end.y, duration: 300 })
          .up({ button: 0 })
          .perform()
        return { success: true, startCoordinates: start, endCoordinates: end }
      }

      // Runner-minted / author-channel verbs (D-01/D-15): reportValue, assertAI, extractAI, and
      // setVariable are intercepted at the runner dispatch seam and never reach the adapter. A
      // grouped §7.1 defensive case surfaces a dispatch-routing error if one arrives here;
      // assertNever remains the backstop for a genuinely unknown schema verb. (uniqueValue is
      // web-only and is not part of ActionsFor<'ios'>.)
      case 'reportValue':
      case 'assertAI':
      case 'extractAI':
      case 'setVariable':
        return {
          success: false,
          error: `Action "${action.type}" is handled by the runner dispatch seam and must not reach the iOS adapter (runner-minted/author-channel verb). This indicates a dispatch routing error.`,
        }

      default:
        return assertNever(action)
    }
  }
}
