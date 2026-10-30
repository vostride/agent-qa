import type { Browser, BrowserContext, CDPSession, Dialog, Page } from 'playwright-core'
import type {
  ActionsFor,
  ActionResult,
  ConsoleLogEntry,
  ExecuteOptions,
  LiveStreamCapability,
  NetworkLogEntry,
  OperationCaptureSupport,
  PlatformAdapter,
  PlatformConfig,
  RecordingCapability,
} from '@vostride/agent-qa-runner'
import type { LiveFrame } from '@vostride/agent-qa-schema'
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from '@vostride/agent-qa-schema'
import {
  assertNever,
  buildScreenState,
  createSnapshotLiveStream,
  LIVE_KEEPALIVE_QUIET_MS,
} from '@vostride/agent-qa-runner'
import type { ScreenState } from '@vostride/agent-qa-schema'
import { convertKeysForPlatform, isMacPlatform } from '@vostride/agent-qa-runner'
import { parseAriaSnapshot, enrichWebNodes, captureWebScroll } from './observer.js'
import { ElementResolver, buildRefMap } from './element-resolver.js'
import {
  bindingRefusal,
  captureEpoch,
  checkBinding,
  checkDocument,
  disposeEpoch,
  laneRefs,
  snapshotRoot,
} from './binding.js'
import type { ObservationEpoch, SnapshotRootOptions } from './binding.js'
import { validateAction } from './action-validator.js'
import { waitForPageReady } from './smart-wait.js'
import { runWebFillCompound, runWebScrollCompound, webOpenAppError } from './compound-web.js'
import type { RefMap } from './types.js'
import { formatMissingBrowserError, isPlaywrightMissingBrowserError } from './browser-install-error.js'
import { createScreencastRecording, type ScreencastRecording } from './recording.js'
import { isHeadlessLaunch, OperationCapture } from './operation-capture.js'
import type { CapturedOperations } from './operation-capture.js'

interface PageLogBuffers {
  consoleLogs: ConsoleLogEntry[]
  networkLogs: NetworkLogEntry[]
  consoleDrainIndex: number
  networkDrainIndex: number
  pendingRequests: Map<string, { url: string; method: string; headers: Record<string, string>; startTime: number; postData?: string }>
}

// A hung iframe keeps the snapshot and `document.fonts.ready` pending, so both are bounded.
/** The longest observe's first ai-mode snapshot waits; a child frame that has not answered by then is left empty. */
export const OBSERVE_SNAPSHOT_TIMEOUT_MS = 5_000
/** The bound a main-frame snapshot gets after it outlasts the short one: Playwright's default. */
export const OBSERVE_SNAPSHOT_RETRY_TIMEOUT_MS = 30_000
const OBSERVE_SNAPSHOT: SnapshotRootOptions = {
  timeoutMs: OBSERVE_SNAPSHOT_TIMEOUT_MS,
  retryTimeoutMs: OBSERVE_SNAPSHOT_RETRY_TIMEOUT_MS,
}
/** The longest screenshot() waits before it gives up and returns undefined. */
export const SCREENSHOT_TIMEOUT_MS = 5_000

// The loop masks this metadata, moves it onto `operationEvidence` and drops both keys.
function withOperationMetadata(result: ActionResult, captured: CapturedOperations | undefined): ActionResult {
  const download = captured?.downloads?.length ? captured.downloads : undefined
  const clipboard = captured?.clipboard?.length ? captured.clipboard : undefined
  if (!download && !clipboard) return result
  return {
    ...result,
    metadata: { ...result.metadata, ...(download ? { download } : {}), ...(clipboard ? { clipboard } : {}) },
  }
}

function clickDelayOption(clickDelay?: number): { delay?: number } {
  return clickDelay !== undefined && clickDelay > 0 ? { delay: clickDelay } : {}
}

// The dispatch seam injects the stored storage-state blob; the adapter never reads it off disk.
function readSeamStorageState(action: unknown): Parameters<BrowserContext['setStorageState']>[0] {
  return (action as { state: Parameters<BrowserContext['setStorageState']>[0] }).state
}

// The ack, not a parameter, makes the stream change-driven: CDP stalls until a frame is acked.
export const SCREENCAST_PARAMS = {
  format: 'jpeg',
  quality: 60,
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1,
} as const

/**
 * How many un-acked CDP ack tokens the producer will remember.
 *
 * Chromium keeps only a couple of frames in flight, so this is generous by two orders of magnitude;
 * it exists so a viewer that stops acking cannot grow the map without bound. An evicted token is
 * ACKED on its way out rather than dropped, because a token nobody acks is a producer that stalls
 * forever — the failure this whole ack path exists to avoid.
 */
const SCREENCAST_ACK_WINDOW = 64

/**
 * How long after a keepalive frame one screencast frame is treated as that capture's echo.
 *
 * `Page.captureScreenshot` makes the compositor paint once, and the screencast delivers that paint
 * as a frame within a millisecond of the capture (measured: same-millisecond stamps on every
 * keepalive of a static page). It is the same picture the keepalive just emitted, so it is acked at
 * once and not emitted; a page that really starts moving is only one frame later.
 */
const KEEPALIVE_ECHO_WINDOW_MS = 250

// A withdrawal is not always permanent, so the snapshot fallback retries the screencast.
export const SCREENCAST_RECOVERY_MS = 10_000

/** Decode a CDP base64 frame payload to bytes without a `Buffer` round-trip in the hot path. */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export interface WebPlatformAdapterOptions {
  // Set only by a host with its own SIGINT, SIGTERM and SIGHUP handling, such as `agent-qa run`.
  readonly hostOwnsSignals?: true
}

export class WebPlatformAdapter implements PlatformAdapter<'web'> {
  readonly platform = 'web' as const

  constructor(private readonly options: WebPlatformAdapterOptions = {}) {}

  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  // Adapter-private: observe returns only the `ScreenState`, never the native binding.
  private lastRefs: RefMap = {}
  private epoch: ObservationEpoch | undefined
  private pageLogBuffers = new Map<Page, PageLogBuffers>()
  private logCaptureConfig: { console: boolean; network: boolean } = { console: true, network: true }
  private navigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS
  private disconnected = false
  private intentionalClose = false
  // Routes persist until unroute and a dialog arm until its dialog; `cleanup()` drains both.
  private armedRoutes = new Set<string>()
  private pendingDialogArm: ((dialog: Dialog) => void) | null = null
  private browserName: 'chromium' | 'firefox' | 'webkit' = 'chromium'
  private screencast: CDPSession | null = null
  private screencastCapability: LiveStreamCapability | null = null
  private recordingCapability: ScreencastRecording | undefined
  private recordingPageRevision = 0
  private recordingConfig: PlatformConfig['recording']
  private screencastFrameSeq = 0
  private screencastAckTokens = new Map<number, number>()
  private screencastOnFrame: ((frame: LiveFrame) => void) | null = null
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null
  private lastScreencastSize: { width: number; height: number } | null = null
  private keepaliveEchoDeadline: number | null = null
  private screencastChain: Promise<void> = Promise.resolve()
  private withdrawnSnapshot: LiveStreamCapability | null = null
  private screencastRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private operationCapture: OperationCapture | null = null
  // Firefox and WebKit run no capture and name themselves as the reason.
  operationCaptureSupport: OperationCaptureSupport | undefined

  async setup(config: PlatformConfig): Promise<void> {
    this.recordingConfig = config.recording
    const { chromium, firefox, webkit } = await import('playwright-core')
    const launchers = { chromium, firefox, webkit } as const
    const browserName = config.browser?.name ?? 'chromium'
    this.browserName = browserName
    const launcher = launchers[browserName]
    const headless = config.browser?.headless ?? true

    try {
      this.browser = await launcher.launch({
        headless,
        ...(browserName === 'chromium' ? { args: ['--disable-blink-features=AutomationControlled'] } : {}),
        ...(this.options.hostOwnsSignals === true
          ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }
          : {}),
      })
    } catch (error) {
      if (isPlaywrightMissingBrowserError(error)) {
        throw new Error(formatMissingBrowserError(browserName))
      }
      throw error
    }

    this.disconnected = false
    this.intentionalClose = false
    this.browser.on('disconnected', () => {
      if (!this.intentionalClose) {
        this.disconnected = true
      }
    })

    const contextOptions: Record<string, unknown> = {
      viewport: config.browser?.viewport ?? { width: 1280, height: 720 },
    }
    if (config.authState?.storageStatePath) {
      contextOptions.storageState = config.authState.storageStatePath
    }
    this.context = await this.browser.newContext(contextOptions)
    this.navigationTimeoutMs = config.timeouts?.navigation ?? DEFAULT_NAVIGATION_TIMEOUT_MS
    this.context.setDefaultNavigationTimeout(this.navigationTimeoutMs)

    // Clipboard write permission — chromium only (firefox/webkit reject this permission)
    if (browserName === 'chromium') {
      await this.context.grantPermissions(['clipboard-write'])
    }

    this.logCaptureConfig = { console: config.logCapture?.console !== false, network: config.logCapture?.network !== false }

    // Hide automation signals so bot-protected sites don't redirect
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })

    this.page = await this.context.newPage()
    this.attachLogListeners(this.page)

    if (browserName === 'chromium') {
      // A headed or undetermined launch never reads the clipboard.
      this.operationCapture = new OperationCapture({ headless: isHeadlessLaunch({ headless }, process.env) })
      await this.operationCapture.attach(this.context)
      this.operationCaptureSupport = { download: true, clipboard: true }
    } else {
      this.operationCaptureSupport = { download: false, clipboard: false, reason: browserName }
    }
  }

  // Absence means no stream, not no preview: the runner's `liveStreamFor` wraps `screenshot()`.
  get liveStream(): LiveStreamCapability | undefined {
    if (this.browserName !== 'chromium') return undefined
    if (!this.page || !this.context) return undefined
    if (this.screencastCapability) return this.screencastCapability
    const capability: LiveStreamCapability = {
      kind: 'cdp-screencast',
      start: (onFrame: (frame: LiveFrame) => void): Promise<void> =>
        this.onScreencastChain(async () => {
          if (this.screencastOnFrame !== null) return
          const page = this.page
          const context = this.context
          if (!page || !context) return
          const cdp = await context.newCDPSession(page)
          this.screencast = cdp
          this.screencastOnFrame = onFrame
          this.screencastAckTokens.clear()
          this.attachScreencast(cdp, onFrame)
          try {
            await cdp.send('Page.startScreencast', { ...SCREENCAST_PARAMS })
          } catch (error) {
            // A start that fails leaves nothing started, so the hub's fallback owns the handle.
            this.screencast = null
            this.screencastOnFrame = null
            try { await cdp.detach() } catch { /* best-effort */ }
            throw error
          }
          if (this.screencast === cdp) this.armKeepalive(cdp)
        }),
      ack: async (frameId: number): Promise<void> => {
        const cdp = this.screencast
        if (!cdp) return
        const sessionId = this.screencastAckTokens.get(frameId)
        this.screencastAckTokens.delete(frameId)
        // An ack for a frame this producer never minted (a stale viewer, a re-started stream, a
        // keepalive, a frame from before a re-bind) is dropped rather than forwarded: acking an
        // arbitrary token is worse than acking nothing.
        if (sessionId === undefined) return
        try {
          await cdp.send('Page.screencastFrameAck', { sessionId })
        } catch {
          // Acking after stop (or after the page navigated away) is expected, never an error.
        }
      },
      stop: (): Promise<void> =>
        this.onScreencastChain(async () => {
          this.screencastOnFrame = null
          await this.stopWithdrawnSnapshot()
          await this.detachScreencast()
        }),
    }
    this.screencastCapability = capability
    return capability
  }

  /** Run `step` after every earlier start, stop and re-bind has settled. */
  private onScreencastChain(step: () => Promise<void>): Promise<void> {
    const run = this.screencastChain.then(step)
    this.screencastChain = run.catch(() => undefined)
    return run
  }

  /** Stop and detach the current CDP session, best-effort, and forget its tokens and keepalive. */
  private async detachScreencast(): Promise<void> {
    const cdp = this.screencast
    this.screencast = null
    this.clearKeepalive()
    this.keepaliveEchoDeadline = null
    this.screencastAckTokens.clear()
    if (!cdp) return
    try { await cdp.send('Page.stopScreencast') } catch { /* best-effort */ }
    try { await cdp.detach() } catch { /* best-effort */ }
  }

  /** Wire `cdp`'s screencast frames to `onFrame`; shared by `start` and `rebindScreencast`. */
  private attachScreencast(cdp: CDPSession, onFrame: (frame: LiveFrame) => void): void {
    cdp.on('Page.screencastFrame', (event) => {
      // A session being replaced by a re-bind may still deliver a frame of the old page.
      if (this.screencast !== cdp) return
      const metadata = event.metadata
      this.lastScreencastSize = { width: metadata.deviceWidth, height: metadata.deviceHeight }
      this.armKeepalive(cdp)
      const echoDeadline = this.keepaliveEchoDeadline
      this.keepaliveEchoDeadline = null
      if (echoDeadline !== null && Date.now() <= echoDeadline) {
        void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined)
        return
      }
      // `sessionId` is CDP's ack token, constant per stream; `LiveFrame.id` is unique per frame.
      const id = ++this.screencastFrameSeq
      this.screencastAckTokens.set(id, event.sessionId)
      // Bound the map. An evicted token is acked on its way out: an un-acked token is a
      // producer stalled forever, which is worse than a frame nobody watched.
      while (this.screencastAckTokens.size > SCREENCAST_ACK_WINDOW) {
        const oldest = this.screencastAckTokens.keys().next()
        if (oldest.done === true) break
        const token = this.screencastAckTokens.get(oldest.value)
        this.screencastAckTokens.delete(oldest.value)
        if (token !== undefined) {
          void cdp.send('Page.screencastFrameAck', { sessionId: token }).catch(() => undefined)
        }
      }
      onFrame({
        id,
        bytes: decodeBase64(event.data),
        metadata: {
          width: metadata.deviceWidth,
          height: metadata.deviceHeight,
          // CDP's `TimeSinceEpoch` is in seconds; every other layer uses epoch ms.
          ...(metadata.timestamp === undefined
            ? {}
            : { timestamp: Math.round(metadata.timestamp * 1000) }),
          scrollOffsetX: metadata.scrollOffsetX,
          scrollOffsetY: metadata.scrollOffsetY,
        },
      })
    })
  }

  // Every page switch goes through here so a running screencast re-binds on its chain.
  private setActivePage(page: Page): void {
    this.page = page
    this.recordingPageRevision++
    if (this.screencastOnFrame !== null) {
      void this.onScreencastChain(() => this.rebindScreencast())
    }
  }

  /**
   * Move the running screencast onto `this.page` without its subscribers noticing: the old session
   * is stopped and detached, a new one is started with the stored `onFrame`, and the id sequence
   * continues. Ids still pending in the hub settle through its ack bound and are dropped here as
   * unknown. Best-effort throughout; it never throws into a step.
   */
  private async rebindScreencast(options: { focus?: boolean } = {}): Promise<void> {
    const onFrame = this.screencastOnFrame
    const page = this.page
    const context = this.context
    if (onFrame === null || !page || !context) return
    await this.detachScreencast()
    this.lastScreencastSize = null
    // A headed browser may not paint a background tab; a recovery never steals desktop focus.
    if (options.focus !== false) {
      try { await page.bringToFront() } catch { /* best-effort */ }
    }
    let cdp: CDPSession
    try {
      cdp = await context.newCDPSession(page)
    } catch {
      this.handleScreencastWithdrawn(null)
      return
    }
    this.screencast = cdp
    this.attachScreencast(cdp, onFrame)
    try {
      await cdp.send('Page.startScreencast', { ...SCREENCAST_PARAMS })
    } catch {
      this.handleScreencastWithdrawn(cdp)
      return
    }
    if (this.screencast !== cdp) return
    this.armKeepalive(cdp)
    await this.stopWithdrawnSnapshot()
  }

  // Frames carry `kind: 'snapshot'` until a re-bind; the declared kind stays `cdp-screencast`.
  private handleScreencastWithdrawn(cdp: CDPSession | null): void {
    void this.onScreencastChain(async () => {
      if (this.screencast !== cdp) return
      const onFrame = this.screencastOnFrame
      if (onFrame === null || this.withdrawnSnapshot !== null || !this.browserIsLive()) return
      await this.detachScreencast()
      const snapshot = createSnapshotLiveStream({ capture: () => this.screenshot() })
      this.withdrawnSnapshot = snapshot
      // Re-minted into the capability's own id sequence, so ids stay monotonic for every viewer.
      await snapshot.start((frame) => {
        if (this.withdrawnSnapshot !== snapshot) return
        onFrame({ ...frame, id: ++this.screencastFrameSeq })
      })
      this.armScreencastRecovery()
    })
  }

  private armScreencastRecovery(): void {
    this.clearScreencastRecovery()
    const timer = setTimeout(() => {
      this.screencastRecoveryTimer = null
      void this.onScreencastChain(async () => {
        if (this.withdrawnSnapshot === null || this.screencastOnFrame === null || !this.browserIsLive()) return
        await this.rebindScreencast({ focus: false })
        if (this.withdrawnSnapshot !== null) this.armScreencastRecovery()
      })
    }, SCREENCAST_RECOVERY_MS)
    timer.unref?.()
    this.screencastRecoveryTimer = timer
  }

  private clearScreencastRecovery(): void {
    if (this.screencastRecoveryTimer !== null) clearTimeout(this.screencastRecoveryTimer)
    this.screencastRecoveryTimer = null
  }

  private browserIsLive(): boolean {
    return !this.intentionalClose && !this.disconnected && this.browser?.isConnected() === true
  }

  private async stopWithdrawnSnapshot(): Promise<void> {
    this.clearScreencastRecovery()
    const snapshot = this.withdrawnSnapshot
    this.withdrawnSnapshot = null
    try { await snapshot?.stop() } catch { /* best-effort */ }
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer !== null) clearTimeout(this.keepaliveTimer)
    this.keepaliveTimer = null
  }

  /** (Re-)arm the quiet-page keepalive for `cdp`; every screencast frame pushes it back. */
  private armKeepalive(cdp: CDPSession): void {
    this.clearKeepalive()
    const timer = setTimeout(() => { void this.fireKeepalive(cdp) }, LIVE_KEEPALIVE_QUIET_MS)
    timer.unref?.()
    this.keepaliveTimer = timer
  }

  // A rejected capture means a withdrawn screencast only if a trivial probe fails too.
  private async fireKeepalive(cdp: CDPSession): Promise<void> {
    this.keepaliveTimer = null
    if (this.screencast !== cdp) return
    const framesBefore = this.screencastFrameSeq
    let data: string
    try {
      const result = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 })
      data = result.data
    } catch {
      if (this.screencast !== cdp) return
      const withdrawn = this.screencastOnFrame !== null && this.browserIsLive() && !(await this.sessionAnswers(cdp))
      if (this.screencast !== cdp) return
      if (withdrawn) this.handleScreencastWithdrawn(cdp)
      else this.armKeepalive(cdp)
      return
    }
    if (this.screencast !== cdp) return
    const onFrame = this.screencastOnFrame
    if (onFrame === null) return
    // A screencast frame that landed while the capture was in flight is already a fresh frame.
    if (this.screencastFrameSeq !== framesBefore) return
    const size = this.lastScreencastSize ?? this.page?.viewportSize() ?? { width: 0, height: 0 }
    onFrame({
      id: ++this.screencastFrameSeq,
      bytes: decodeBase64(data),
      metadata: { width: size.width, height: size.height, timestamp: Date.now() },
    })
    this.keepaliveEchoDeadline = Date.now() + KEEPALIVE_ECHO_WINDOW_MS
    this.armKeepalive(cdp)
  }

  /** Whether `cdp` still answers a command that cannot fail on a usable session. */
  private async sessionAnswers(cdp: CDPSession): Promise<boolean> {
    try {
      await cdp.send('Runtime.evaluate', { expression: '1' })
      return true
    } catch {
      return false
    }
  }

  get recording(): RecordingCapability | undefined {
    if (!this.page || !this.context || !this.recordingConfig) return undefined
    return this.recordingCapability ??= createScreencastRecording(
      () => this.page,
      this.recordingConfig,
      () => this.recordingPageRevision,
    )
  }

  async cleanup(): Promise<void> {
    this.intentionalClose = true
    try { await this.recordingCapability?.stop() } catch { /* best-effort */ }
    this.recordingCapability = undefined
    this.recordingConfig = undefined
    // Clear the consumer first so a queued re-bind no-ops; stop the screencast while CDP is up.
    this.screencastOnFrame = null
    await this.stopWithdrawnSnapshot()
    try { await this.screencastCapability?.stop() } catch { /* best-effort */ }
    this.screencastCapability = null
    // Close the clipboard read-back probe context before the browser goes.
    try { await this.operationCapture?.dispose() } catch { /* best-effort */ }
    // Undo routes, offline mode and the dialog arm before closing, so the next test inherits none.
    if (this.context) {
      try { await this.context.unrouteAll({ behavior: 'ignoreErrors' }) } catch { /* best-effort */ }
      try { await this.context.setOffline(false) } catch { /* best-effort */ }
    }
    if (this.page && this.pendingDialogArm) {
      try { this.page.off('dialog', this.pendingDialogArm) } catch { /* best-effort */ }
    }
    this.armedRoutes.clear()
    this.pendingDialogArm = null
    await disposeEpoch(this.epoch)
    this.epoch = undefined
    if (this.browser) {
      await this.browser.close()
    }
    this.browser = null
    this.context = null
    this.page = null
    this.operationCapture = null
    this.operationCaptureSupport = undefined
    this.lastRefs = {}
    this.pageLogBuffers.clear()
    this.disconnected = false
    this.intentionalClose = false
    this.screencast = null
    this.screencastOnFrame = null
    this.clearKeepalive()
    this.lastScreencastSize = null
    this.screencastAckTokens.clear()
    this.screencastChain = Promise.resolve()
  }

  get isBrowserDisconnected(): boolean {
    return this.disconnected
  }

  async observe(): Promise<ScreenState> {
    if (!this.page) {
      throw new Error('WebPlatformAdapter not initialized — call setup() first')
    }
    const page = this.page

    await waitForPageReady(page)

    // The epoch is taken before the snapshot, so any later document replacement reads as stale.
    const epoch = await captureEpoch(page)
    try {
      const state = await this.observeDocument(page)
      await disposeEpoch(this.epoch)
      this.epoch = epoch
      return state
    } catch (error) {
      await disposeEpoch(epoch)
      throw error
    }
  }

  private async observeDocument(page: Page): Promise<ScreenState> {
    // The snapshot's native `[ref=eN]` handles are adapter-private; aria-ref locators use them.
    const ariaTree = await snapshotRoot(page, OBSERVE_SNAPSHOT)

    const { nodes, nativeRefs } = parseAriaSnapshot(ariaTree)
    if (nodes.length > 0) {
      await enrichWebNodes(page, nodes, nativeRefs)
    }
    const { viewport, scroll } = await captureWebScroll(page)

    // The shared runner builder mints refs, normalizes names, and assembles the schema
    // v2 ScreenState. The binding stays adapter-private; only the state crosses the port.
    const { state, binding } = buildScreenState({
      platform: 'web',
      nodes,
      viewport,
      scroll,
      coordSpace: 'viewport',
      timestamp: Date.now(),
      url: page.url(),
    })

    this.lastRefs = buildRefMap(binding, nodes, nativeRefs, state.elements)
    return state
  }

  async execute(action: ActionsFor<'web'>, options?: ExecuteOptions): Promise<ActionResult> {
    if (!this.page) {
      throw new Error('WebPlatformAdapter not initialized — call setup() first')
    }

    const capture = this.operationCapture
    await capture?.arm(action, options, this.page)
    const result = await this.executeWithErrorResult(action)
    // The download-start grace and clipboard read-back follow the action, outside its interval.
    this.recordingCapability?.endAction()
    let captured: CapturedOperations | undefined
    try {
      captured = await capture?.collect()
    } catch {
      captured = undefined
    }
    return withOperationMetadata(result, captured)
  }

  // A navigation that timed out stays pending and blocks every later call on its page until stopped.
  private async stopLoading(page: Page): Promise<void> {
    try {
      const cdp = await this.context!.newCDPSession(page)
      await cdp.send('Page.stopLoading')
      await cdp.detach()
    } catch {
      // Firefox and WebKit have no CDP session.
    }
  }

  private async executeWithErrorResult(action: ActionsFor<'web'>): Promise<ActionResult> {
    if (!this.page) {
      throw new Error('WebPlatformAdapter not initialized — call setup() first')
    }
    try {
      return await this.executeAction(action)
    } catch (err) {
      let screenshot: Buffer | undefined
      let boundingBox: { x: number; y: number; width: number; height: number } | undefined
      try {
        screenshot = await this.page.screenshot({ scale: 'css' })
      } catch {
        // ignore screenshot failure
      }
      try {
        if ('ref' in action && typeof (action as any).ref === 'string') {
          const resolver = new ElementResolver(this.page, this.lastRefs)
          const box = await resolver.getBoundingBox((action as any).ref)
          if (box) boundingBox = box
        }
      } catch {
        // ignore bounding box failure
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        screenshot,
        boundingBox,
      }
    }
  }

  async screenshot(): Promise<Buffer | undefined> {
    try {
      if (this.page) {
        return await this.page.screenshot({ scale: 'css', timeout: SCREENSHOT_TIMEOUT_MS })
      }
      return undefined
    } catch {
      return undefined
    }
  }

  getPage(): Page | null {
    return this.page
  }

  drainConsoleLogs(level?: string): ConsoleLogEntry[] {
    const all: ConsoleLogEntry[] = []
    for (const buffers of this.pageLogBuffers.values()) {
      const newLogs = buffers.consoleLogs.slice(buffers.consoleDrainIndex)
      buffers.consoleDrainIndex = buffers.consoleLogs.length
      all.push(...newLogs)
    }
    if (!level) return all
    return all.filter(e => e.level === level)
  }

  drainNetworkLogs(urlPattern?: string): NetworkLogEntry[] {
    const all: NetworkLogEntry[] = []
    for (const buffers of this.pageLogBuffers.values()) {
      const newLogs = buffers.networkLogs.slice(buffers.networkDrainIndex)
      buffers.networkDrainIndex = buffers.networkLogs.length
      all.push(...newLogs)
    }
    if (!urlPattern) return all
    return all.filter(e => e.url.includes(urlPattern))
  }

  readDownloadBytes(sha256: string): Uint8Array | undefined {
    return this.operationCapture?.readDownloadBytes(sha256)
  }

  peekNetworkLogs(urlPattern?: string): NetworkLogEntry[] {
    const all: NetworkLogEntry[] = []
    for (const buffers of this.pageLogBuffers.values()) {
      all.push(...buffers.networkLogs.slice(buffers.networkDrainIndex))
    }
    if (!urlPattern) return all
    return all.filter(e => e.url.includes(urlPattern))
  }

  private attachLogListeners(page: Page): void {
    const buffers: PageLogBuffers = {
      consoleLogs: [],
      networkLogs: [],
      consoleDrainIndex: 0,
      networkDrainIndex: 0,
      pendingRequests: new Map(),
    }
    this.pageLogBuffers.set(page, buffers)

    if (this.logCaptureConfig.console) {
      page.on('console', (msg) => {
        const type = msg.type()
        buffers.consoleLogs.push({
          level: type === 'warning' ? 'warn' : type,
          text: msg.text(),
          location: msg.location(),
          timestamp: Date.now(),
        })
        if (buffers.consoleLogs.length > 1000) {
          buffers.consoleLogs = buffers.consoleLogs.slice(-500)
        }
      })
    }

    if (this.logCaptureConfig.network) {
      page.on('request', (request) => {
        buffers.pendingRequests.set(request.url() + request.method(), {
          url: request.url(),
          method: request.method(),
          headers: request.headers(),
          startTime: Date.now(),
          postData: request.postData() ?? undefined,
        })
      })

      page.on('response', async (response) => {
        const key = response.url() + response.request().method()
        const pending = buffers.pendingRequests.get(key)
        buffers.pendingRequests.delete(key)

        let body: string | undefined
        try {
          const buf = await response.body()
          const ct = response.headers()['content-type'] ?? ''
          if (ct.includes('image/') && !ct.includes('svg')) {
            body = buf.length > 32768 ? undefined : `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`
          } else {
            const text = buf.toString('utf-8')
            body = text.length > 32768 ? text.slice(0, 32768) + '...[truncated]' : text
          }
        } catch {
          body = undefined
        }

        buffers.networkLogs.push({
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
          requestHeaders: pending?.headers ?? response.request().headers(),
          responseHeaders: response.headers(),
          body,
          requestBody: pending?.postData,
          startTime: pending?.startTime ?? Date.now(),
          endTime: Date.now(),
          timing: response.request().timing(),
        })
        if (buffers.networkLogs.length > 500) {
          buffers.networkLogs = buffers.networkLogs.slice(-250)
        }
      })
    }
  }

  private async resolveTabTargetAsync(tab: { index?: number; title?: string; url?: string }): Promise<Page | undefined> {
    const pages = this.context!.pages()
    if (tab.index !== undefined) {
      return (tab.index >= 0 && tab.index < pages.length) ? pages[tab.index] : undefined
    }
    if (tab.title) {
      for (const p of pages) {
        const t = await p.title()
        if (t.includes(tab.title)) return p
      }
      return undefined
    }
    if (tab.url) {
      return pages.find(p => p.url().includes(tab.url!))
    }
    return undefined
  }

  private async executeAction(action: ActionsFor<'web'>): Promise<ActionResult> {
    const page = this.page!
    const resolver = new ElementResolver(page, this.lastRefs)

    // An element that differs from the observed one is a typed refusal with no page interaction.
    for (const ref of laneRefs(action)) {
      const entry = this.lastRefs[ref]
      if (entry === undefined) continue
      // A scroll's ref names its container, so only its document is checked.
      const check = action.type === 'scroll'
        ? await checkDocument(page, this.epoch)
        : await checkBinding(page, this.epoch, entry, OBSERVE_SNAPSHOT)
      if (check.outcome !== 'ok') return bindingRefusal(check.outcome, ref)
    }

    // Validate action-element compatibility for ref-targeting actions
    if ('ref' in action && typeof (action as any).ref === 'string') {
      const refData = this.lastRefs[(action as any).ref]
      const role = refData?.role
      const validation = validateAction(action, role)
      if (!validation.valid) {
        return { success: false, error: validation.error }
      }
    }

    switch (action.type) {
      case 'click': {
        const locator = resolver.resolve(action.ref)
        const box = await resolver.getBoundingBox(action.ref)
        const coordinates = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined
        await locator.click({
          ...clickDelayOption(action.clickDelay),
          ...(this.operationCapture ? { noWaitAfter: true } : {}),
        })
        return { success: true, coordinates, boundingBox: box ?? undefined }
      }

      case 'fill': {
        const locator = resolver.resolve(action.ref)
        const box = await resolver.getBoundingBox(action.ref)
        return runWebFillCompound(locator, box ?? undefined, action)
      }

      case 'openApp': {
        return webOpenAppError()
      }

      case 'select': {
        const locator = resolver.resolve(action.ref)
        const box = await resolver.getBoundingBox(action.ref)
        await locator.selectOption(action.value)
        return { success: true, boundingBox: box ?? undefined }
      }

      case 'navigate': {
        try {
          switch (action.to) {
            case 'url':
              await page.goto(action.url, { waitUntil: 'domcontentloaded' })
              break
            case 'back':
              await page.goBack({ waitUntil: 'domcontentloaded' })
              break
            case 'forward':
              await page.goForward({ waitUntil: 'domcontentloaded' })
              break
            case 'reload':
              await page.reload({ waitUntil: 'domcontentloaded' })
              break
          }
        } catch (err) {
          await this.stopLoading(page)
          throw err
        }
        await waitForPageReady(page)
        return { success: true }
      }

      case 'scroll': {
        return runWebScrollCompound(page, this.lastRefs, action)
      }

      case 'waitFor': {
        const timeout = action.timeoutMs
        try {
          switch (action.on) {
            case 'text':
              await page.getByText(action.text).first().waitFor({ state: 'visible', timeout })
              break
            case 'gone':
              await page.getByText(action.text).first().waitFor({ state: 'hidden', timeout })
              break
            case 'selector':
              await page.waitForSelector(action.selector, { timeout })
              break
          }
        } catch {
          const what = action.on === 'selector' ? `selector "${action.selector}"` : `text "${action.text}"`
          const how = action.on === 'gone' ? 'was still present after' : 'did not appear within'
          return { success: false, error: `waitFor: ${what} ${how} ${timeout}ms.` }
        }
        return { success: true }
      }

      case 'delay': {
        await page.waitForTimeout(action.ms)
        return { success: true }
      }

      case 'waitForUrl': {
        try {
          await page.waitForURL(action.pattern, { timeout: this.navigationTimeoutMs })
          return { success: true }
        } catch (err) {
          return {
            success: false,
            error: `URL pattern "${action.pattern}" did not match within ${this.navigationTimeoutMs}ms. Hint: use "**" wildcards for substring matching (e.g., "**/dashboard**"). ${err instanceof Error ? err.message : String(err)}`,
          }
        }
      }

      case 'keypress': {
        // Fold re-key of keyDown/keyUp: the schema `mode` selects press / down / up on the
        // platform-normalized keys.
        const effectiveKeys = convertKeysForPlatform(action.keys, {
          enabled: action.convertPlatformKeys !== false,
          isMac: isMacPlatform(),
        })
        for (const key of effectiveKeys) {
          if (action.mode === 'down') {
            await page.keyboard.down(key)
          } else if (action.mode === 'up') {
            await page.keyboard.up(key)
          } else {
            await page.keyboard.press(key)
          }
        }
        return { success: true }
      }

      case 'hover': {
        const locator = resolver.resolve(action.ref)
        const box = await resolver.getBoundingBox(action.ref)
        await locator.hover()
        return { success: true, boundingBox: box ?? undefined }
      }

      case 'paste': {
        const locator = resolver.resolve(action.ref)
        const box = await resolver.getBoundingBox(action.ref)
        await locator.focus()
        await page.evaluate(`(() => {
          const el = document.activeElement;
          if (!el) return;
          const dt = new DataTransfer();
          dt.setData('text/plain', ${JSON.stringify(action.value)});
          el.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          }));
        })()`)
        return { success: true, boundingBox: box ?? undefined }
      }

      case 'fileUpload': {
        // Paths arrive absolute: the runner's `loop.ts` resolves them before dispatch.
        const { existsSync } = await import('node:fs')
        for (const filePath of action.files) {
          if (!existsSync(filePath)) {
            return { success: false, error: `File not found: ${filePath}` }
          }
        }
        const locator = resolver.resolve(action.ref)
        const box = await resolver.getBoundingBox(action.ref)
        await locator.setInputFiles(action.files)
        return { success: true, boundingBox: box ?? undefined }
      }

      case 'copy': {
        const locator = resolver.resolve(action.ref)
        const box = await resolver.getBoundingBox(action.ref)
        const text = (await locator.textContent()) ?? ''
        await page.evaluate(`navigator.clipboard.writeText(${JSON.stringify(text)})`)
        return { success: true, boundingBox: box ?? undefined, data: { copied: text } }
      }

      case 'tab': {
        // Fold re-key of newTab/switchTab: `action` discriminant selects open-new vs switch.
        if (action.action === 'new') {
          const newPage = await this.context!.newPage()
          this.attachLogListeners(newPage)
          try {
            await newPage.goto(action.url, { waitUntil: 'domcontentloaded' })
          } catch (err) {
            await this.stopLoading(newPage)
            throw err
          }
          await waitForPageReady(newPage)
          this.setActivePage(newPage)
          return { success: true }
        }
        const pages = this.context!.pages()
        let target: Page | undefined
        if (action.index !== undefined) {
          if (action.index < 0 || action.index >= pages.length) {
            return { success: false, error: `Tab index ${action.index} out of range (${pages.length} tabs open)` }
          }
          target = pages[action.index]
        } else if (action.title !== undefined) {
          for (const p of pages) {
            const t = await p.title()
            if (t.includes(action.title)) { target = p; break }
          }
        } else if (action.url !== undefined) {
          target = pages.find(p => p.url().includes(action.url!))
        }
        if (!target) {
          return { success: false, error: `No tab found matching ${JSON.stringify({ index: action.index, title: action.title, url: action.url })}` }
        }
        this.setActivePage(target)
        return { success: true }
      }

      case 'inspect': {
        // Fold re-key of the four read* verbs; output rides ActionResult.data through the
        // existing guardActionData/guardBlob compaction path (no new compaction).
        switch (action.what) {
          case 'console': {
            let entries: ConsoleLogEntry[]
            if (action.tab) {
              const targetPage = await this.resolveTabTargetAsync(action.tab)
              if (!targetPage) {
                return { success: false, error: `No tab found matching ${JSON.stringify(action.tab)}` }
              }
              const buffers = this.pageLogBuffers.get(targetPage)
              entries = buffers ? [...buffers.consoleLogs] : []
            } else {
              entries = []
              for (const buffers of this.pageLogBuffers.values()) {
                entries.push(...buffers.consoleLogs)
              }
            }
            if (action.level) {
              entries = entries.filter(e => e.level === action.level)
            }
            return { success: true, data: entries }
          }
          case 'network': {
            let entries: NetworkLogEntry[]
            if (action.tab) {
              const targetPage = await this.resolveTabTargetAsync(action.tab)
              if (!targetPage) {
                return { success: false, error: `No tab found matching ${JSON.stringify(action.tab)}` }
              }
              const buffers = this.pageLogBuffers.get(targetPage)
              entries = buffers ? [...buffers.networkLogs] : []
            } else {
              entries = []
              for (const buffers of this.pageLogBuffers.values()) {
                entries.push(...buffers.networkLogs)
              }
            }
            if (action.urlPattern) {
              entries = entries.filter(e => e.url.includes(action.urlPattern!))
            }
            return { success: true, data: entries }
          }
          case 'cookies': {
            const cookies = await this.context!.cookies()
            if (action.name) {
              const cookie = cookies.find(c => c.name === action.name) ?? null
              return { success: true, data: cookie }
            }
            return { success: true, data: cookies }
          }
          case 'localStorage': {
            const pageUrl = page.url()
            if (pageUrl === 'about:blank') {
              return { success: true, data: action.key ? null : {} }
            }
            if (action.key) {
              const value = await page.evaluate(
                (k: string) => localStorage.getItem(k), action.key
              )
              return { success: true, data: value }
            }
            const all = await page.evaluate(
              () => Object.fromEntries(
                Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])
              )
            )
            return { success: true, data: all }
          }
        }
        return { success: true }
      }

      case 'setCookies': {
        const cookiesWithDefaults = action.cookies.map(c => ({
          ...c,
          url: !c.domain ? page.url() : undefined,
        }))
        await this.context!.addCookies(cookiesWithDefaults)
        return { success: true }
      }

      case 'setLocalStorage': {
        await page.evaluate((entries: Array<{ key: string; value: string }>) => {
          for (const { key, value } of entries) {
            localStorage.setItem(key, value)
          }
        }, action.entries)
        return { success: true }
      }

      case 'focus': {
        const locator = resolver.resolve(action.ref)
        const box = await resolver.getBoundingBox(action.ref)
        await locator.focus()
        return { success: true, boundingBox: box ?? undefined }
      }

      case 'assertValue': {
        // The adapter resolves the raw value; the runner-side comparator applies the op and judges.
        let value: unknown
        if ('expr' in action) {
          value = await page.evaluate(action.expr)
        } else {
          switch (action.source) {
            case 'url':
              value = page.url()
              break
            case 'storage':
              value = page.url() === 'about:blank'
                ? {}
                : await page.evaluate(
                    () => Object.fromEntries(
                      Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])
                    )
                  )
              break
            case 'network':
              value = this.peekNetworkLogs()
              break
          }
        }
        return { success: true, data: value }
      }

      case 'clearText': {
        const loc = resolver.resolve(action.ref)
        const clearBox = await resolver.getBoundingBox(action.ref)
        await loc.clear()
        return { success: true, boundingBox: clearBox ?? undefined }
      }

      case 'doubleClick': {
        const locator = resolver.resolve(action.ref)
        const box = await resolver.getBoundingBox(action.ref)
        const coordinates = box
          ? action.relativePosition
            ? { x: box.x + action.relativePosition.x, y: box.y + action.relativePosition.y }
            : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          : undefined
        await locator.dblclick({
          ...(action.relativePosition && { position: action.relativePosition }),
          ...clickDelayOption(action.clickDelay),
        })
        return { success: true, coordinates, boundingBox: box ?? undefined }
      }

      case 'rightClick': {
        const locator = resolver.resolve(action.ref)
        const box = await resolver.getBoundingBox(action.ref)
        const coordinates = box
          ? action.relativePosition
            ? { x: box.x + action.relativePosition.x, y: box.y + action.relativePosition.y }
            : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          : undefined
        await locator.click({
          button: 'right',
          ...(action.relativePosition && { position: action.relativePosition }),
          ...clickDelayOption(action.clickDelay),
        })
        return { success: true, coordinates, boundingBox: box ?? undefined }
      }

      case 'route': {
        // A mocked response body crosses into page context, so this action is declared destructive.
        await this.context!.route(action.urlPattern, async (route) => {
          await route.fulfill({
            status: 200,
            ...(action.contentType !== undefined ? { contentType: action.contentType } : {}),
            ...(action.headers !== undefined ? { headers: action.headers } : {}),
            ...(action.body !== undefined ? { body: action.body } : {}),
          })
        })
        this.armedRoutes.add(action.urlPattern)
        return { success: true }
      }

      case 'unroute': {
        if (action.urlPattern !== undefined) {
          await this.context!.unroute(action.urlPattern)
          this.armedRoutes.delete(action.urlPattern)
        } else {
          await this.context!.unrouteAll({ behavior: 'ignoreErrors' })
          this.armedRoutes.clear()
        }
        return { success: true }
      }

      case 'networkState': {
        if (action.mode === 'offline') {
          await this.context!.setOffline(true)
          return { success: true }
        }
        // `throttle` is Chromium-only via CDP; other browsers reject `newCDPSession`.
        try {
          const cdp = await this.context!.newCDPSession(page)
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: action.latencyMs,
            downloadThroughput: (action.downloadKbps * 1000) / 8,
            uploadThroughput: (action.uploadKbps * 1000) / 8,
          })
          return { success: true }
        } catch (err) {
          return {
            success: false,
            error: `Network throttling is only available on Chromium (via CDP); this context does not support it. ${err instanceof Error ? err.message : String(err)}`,
          }
        }
      }

      case 'storageState': {
        // The dispatch seam strips and persists the saved blob; the adapter never touches the disk.
        if (action.op === 'save') {
          const state = await this.context!.storageState()
          return { success: true, data: { name: action.name, state } }
        }
        await this.context!.setStorageState(readSeamStorageState(action))
        return { success: true }
      }

      case 'handleDialog': {
        // Drop the pending arm first, or stacked `page.once` handlers both answer the next dialog.
        if (this.pendingDialogArm) {
          page.off('dialog', this.pendingDialogArm)
          this.pendingDialogArm = null
        }
        const accept = action.accept
        const promptText = action.promptText
        const handler = (dialog: Dialog): void => {
          this.pendingDialogArm = null
          if (accept) {
            void dialog.accept(promptText)
          } else {
            void dialog.dismiss()
          }
        }
        this.pendingDialogArm = handler
        page.once('dialog', handler)
        return { success: true }
      }

      case 'executeScript': {
        return { success: false, error: 'executeScript is a mobile-only action' }
      }

      // The dispatch seam intercepts these verbs; reaching the adapter is a routing error.
      case 'reportValue':
      case 'uniqueValue':
      case 'assertAI':
      case 'extractAI':
      case 'setVariable':
        return {
          success: false,
          error: `Action "${action.type}" is handled by the runner dispatch seam and must not reach the web adapter (runner-minted/author-channel verb). This indicates a dispatch routing error.`,
        }

      default:
        return assertNever(action)
    }
  }
}
