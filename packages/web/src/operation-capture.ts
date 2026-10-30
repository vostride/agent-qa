// Downloads are hashed in memory and deleted, and no app origin is granted `clipboard-read`.

import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import type { BrowserContext, Download, Frame, Page, Request } from 'playwright-core'
import type { ClipboardEvidence, DownloadEvidence } from '@vostride/agent-qa-schema'
import type { ExecuteOptions } from '@vostride/agent-qa-runner'

export { CLIPBOARD_TEXT_LIMIT } from '@vostride/agent-qa-runner'

/** How long an activation action is given to start a download after it returns. */
export const DOWNLOAD_START_GRACE_MS = 500
/** How long the start window stays open after a navigation the action started is answered; the download event follows the response. */
export const NAVIGATION_SETTLE_MS = 250
/** The download wait's bound for an action dispatched with no step deadline. */
export const DOWNLOAD_COMPLETION_CAP_MS = 120_000
/** The longest the start window stays open for subframe and popup navigations; never more than half the action's time left. */
export const NAVIGATION_WINDOW_CAP_MS = 5_000
/** The largest downloaded file whose bytes are held in memory. */
export const DOWNLOAD_HOLD_FILE_CAP = 1024 * 1024
/** The most downloaded bytes held at once; the oldest files are evicted first. */
export const DOWNLOAD_HOLD_TOTAL_CAP = 8 * 1024 * 1024

/** The web actions that can start a download; see isDownloadActivation for tab and fill. */
export const DOWNLOAD_ACTIVATION_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'doubleClick',
  'rightClick',
  'keypress',
  'select',
  'navigate',
  'executeScript',
  'handleDialog',
  'fileUpload',
  'tab',
])

export interface DownloadActivationInput {
  type: string
  submit?: unknown
  action?: unknown
}

/** Whether the action is given the download start window: a `tab` only when it opens one, a `fill` only when it submits. */
export function isDownloadActivation(action: DownloadActivationInput): boolean {
  if (action.type === 'fill') return action.submit === true
  if (action.type === 'tab') return action.action === 'new'
  return DOWNLOAD_ACTIVATION_ACTIONS.has(action.type)
}

interface PendingNavigation {
  page: Page | undefined
  /** The acting page's own main-frame navigation. */
  main: boolean
}

interface TrackedDownload {
  download: Download
  late: boolean
}

const UNFINISHED = Symbol('unfinished')

/** The binding the page-world hook reports app clipboard writes through. */
export const CLIPBOARD_BINDING = '__agentQaAppClipboardWrite'
/** agent-qa's own clipboard actions; their writes are never the app's. */
const CLIPBOARD_EXCLUDED_ACTIONS: ReadonlySet<string> = new Set(['copy', 'paste'])
const CLIPBOARD_SOURCES: ReadonlySet<string> = new Set(['writeText', 'write', 'copy-event'])
export const READ_BACK_TIMEOUT_MS = 2_000
/** The most recent app clipboard claims kept per action; older ones are dropped. */
export const CLIPBOARD_CLAIMS_PER_ACTION = 8
/** The reserved origin of the read-back probe page; nothing else loads in the probe context. */
export const CLIPBOARD_READBACK_ORIGIN = 'https://agent-qa-readback.invalid'
// The probe page's compare() answers that confirm anything; -2 (no pre-image or unreadable) and
// -3 (unchanged) confirm nothing.
const PROBE_MATCHED = 1
const PROBE_DIFFERENT = 0

type ProbeStatus = 'none' | 'read' | 'unreadable'

interface ProbeReadback {
  readonly status: ProbeStatus
  snapshot(): Promise<ProbeStatus>
  compare(finalText: string): Promise<number>
}

type ProbeScope = typeof globalThis & { __agentQaReadback: ProbeReadback }

// Runs once in the probe page. The pre-image lives only in this closure; readText is looked up at
// call time.
function installProbeReadback(): void {
  const scope = globalThis as unknown as {
    navigator: { clipboard: { readText: () => Promise<unknown> } }
  }
  let preImage: string | undefined
  let status: ProbeStatus = 'none'
  const read = async (): Promise<string | undefined> => {
    try {
      const text = await scope.navigator.clipboard.readText()
      return typeof text === 'string' ? text : undefined
    } catch {
      return undefined
    }
  }
  Object.defineProperty(globalThis, '__agentQaReadback', {
    value: Object.freeze({
      get status() { return status },
      async snapshot() {
        preImage = undefined
        status = 'none'
        const text = await read()
        if (text === undefined) {
          status = 'unreadable'
        } else {
          preImage = text
          status = 'read'
        }
        return status
      },
      async compare(finalText: string) {
        if (status !== 'read') return -2
        const now = await read()
        if (now === undefined) return -2
        if (now === preImage) return -3
        return now === finalText ? 1 : 0
      },
    }),
  })
}

export type CapturedClipboardWrite = Pick<ClipboardEvidence, 'source' | 'text' | 'readBack'>

/** What one armed action produced; the clipboard text is raw until the loop masks it. */
export interface CapturedOperations {
  downloads?: DownloadEvidence[]
  clipboard?: CapturedClipboardWrite[]
}

interface PendingClipboardWrite {
  source: ClipboardEvidence['source']
  text: string
  frame: Frame
}

const CLIPBOARD_HOOK = `(() => {
  const binding = ${JSON.stringify(CLIPBOARD_BINDING)};
  const report = (via, text) => {
    const send = window[binding];
    if (typeof send !== 'function' || typeof text !== 'string' || text.length === 0) return;
    try { Promise.resolve(send({ via, text })).catch(() => {}); } catch {}
  };
  // A write is reported only once the browser accepted it; the app gets the original promise.
  const proto = typeof Clipboard === 'function' ? Clipboard.prototype : undefined;
  if (proto && typeof proto.writeText === 'function') {
    const writeText = proto.writeText;
    proto.writeText = function (data) {
      let text;
      try { text = String(data); } catch {}
      const result = writeText.apply(this, arguments);
      try { Promise.resolve(result).then(() => report('writeText', text), () => {}); } catch {}
      return result;
    };
  }
  if (proto && typeof proto.write === 'function') {
    const write = proto.write;
    proto.write = function (items) {
      const texts = [];
      try {
        for (const item of Array.from(items || [])) {
          if (!item || !Array.from(item.types || []).includes('text/plain')) continue;
          texts.push(item.getType('text/plain').then((blob) => blob.text()).catch(() => undefined));
        }
      } catch {}
      const result = write.apply(this, arguments);
      try {
        Promise.resolve(result).then(
          () => Promise.all(texts).then((all) => { for (const text of all) report('write', text); }),
          () => {},
        );
      } catch {}
      return result;
    };
  }
  // A copy event is tracked from window's capture phase, which runs before any app handler can
  // stop propagation, and settled once dispatch is over: a prevented copy writes what the app
  // set (seen through setData), an unprevented one writes the selection taken at dispatch.
  let pending = null;
  const selected = (event) => {
    for (const el of [event.target, document.activeElement]) {
      if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) continue;
      try {
        const start = el.selectionStart, end = el.selectionEnd;
        if (typeof start === 'number' && typeof end === 'number' && end > start) return el.value.slice(start, end);
      } catch {}
    }
    const selection = document.getSelection();
    return selection ? selection.toString() : '';
  };
  const settle = () => {
    const copy = pending;
    pending = null;
    if (!copy) return;
    if (!copy.event.defaultPrevented) return report('copy-event', copy.selection);
    if (copy.set !== undefined) return report('copy-event', copy.set);
    try { report('copy-event', copy.event.clipboardData ? copy.event.clipboardData.getData('text/plain') : ''); } catch {}
  };
  if (typeof DataTransfer === 'function' && typeof DataTransfer.prototype.setData === 'function') {
    const setData = DataTransfer.prototype.setData;
    DataTransfer.prototype.setData = function (format, data) {
      if (pending && this === pending.event.clipboardData && /^text(\\/plain)?$/i.test(String(format))) pending.set = String(data);
      return setData.apply(this, arguments);
    };
  }
  window.addEventListener('copy', (event) => {
    settle();
    pending = { event, selection: selected(event), set: undefined };
    setTimeout(settle, 0);
  }, true);
})();`

const PLAYWRIGHT_DEBUG_ENV = ['PWDEBUG', 'npm_config_pwdebug', 'npm_package_config_pwdebug'] as const
const DEBUG_OFF: ReadonlySet<string> = new Set(['', '0', 'false'])

/** True only for a plain headless launch: `headless: true`, no channel and no Playwright debug mode. */
export function isHeadlessLaunch(
  launch: { headless?: unknown; channel?: unknown },
  env: Record<string, string | undefined>,
): boolean {
  if (launch.headless !== true || launch.channel !== undefined) return false
  // Playwright's inspector debug mode forces a headed launch whatever `headless` says.
  return PLAYWRIGHT_DEBUG_ENV.every((name) => env[name] === undefined || DEBUG_OFF.has(env[name]))
}

export interface OperationCaptureOptions {
  /** The bound when the action carries no remaining step time. */
  completionCapMs?: number
  startGraceMs?: number
  /** True only when the adapter launched headless; anything else never reads the clipboard. */
  headless?: boolean
}

export class OperationCapture {
  private readonly completionCapMs: number
  private readonly startGraceMs: number
  private readonly attachedPages = new WeakSet<Page>()
  private downloads: TrackedDownload[] = []
  /** Downloads that started while no start window was open, kept for the next action. */
  private held: Download[] = []
  /** Completed downloads' bytes by sha256, oldest first; memory only. */
  private readonly heldBytes = new Map<string, Uint8Array>()
  private heldByteTotal = 0
  private readonly pendingNavigations = new Map<Request, PendingNavigation>()
  private clipboardWrites: PendingClipboardWrite[] = []
  private armed = false
  private startWindow = false
  private navigationWindow = false
  private navigationSettledAt = 0
  private navigationSettledMain = false
  private actingPage: Page | undefined
  private clipboardArmed = false
  private activation = false
  private boundAt = 0
  private abortSignal: AbortSignal | undefined
  private notify: (() => void) | null = null
  private appContext: BrowserContext | null = null
  private probe: Promise<Page | undefined> | null = null
  private probeContext: BrowserContext | null = null
  private probeGeneration = 0
  private readonly readsClipboard: boolean
  /** The probe generation holding this action's pre-image; -1 when none was read. */
  private preImageGeneration = -1
  /** A probe generation whose read did not settle; skipped until resetProbe() replaces it. */
  private unreadableGeneration = -1

  constructor(options: OperationCaptureOptions = {}) {
    this.completionCapMs = options.completionCapMs ?? DOWNLOAD_COMPLETION_CAP_MS
    this.startGraceMs = options.startGraceMs ?? DOWNLOAD_START_GRACE_MS
    this.readsClipboard = options.headless === true
  }

  async attach(context: BrowserContext): Promise<void> {
    this.appContext = context
    for (const page of context.pages()) this.attachPage(page)
    context.on('page', (page) => this.attachPage(page))
    context.on('request', (request) => this.onRequest(request))
    context.on('response', (response) => { this.settleNavigation(response.request()) })
    context.on('requestfailed', (request) => { this.settleNavigation(request) })
    await context.exposeBinding(CLIPBOARD_BINDING, (source, payload: unknown) => {
      this.onClipboardWrite(source.frame, payload)
    })
    await context.addInitScript(CLIPBOARD_HOOK)
  }

  async arm(action: DownloadActivationInput, options: ExecuteOptions = {}, actingPage?: Page): Promise<void> {
    const carried = [...this.downloads.map((entry) => entry.download), ...this.held]
    this.held = []
    this.downloads = carried.map((download) => ({ download, late: true }))
    this.clipboardWrites = []
    this.armed = true
    this.startWindow = true
    this.clipboardArmed = false
    this.activation = isDownloadActivation(action)
    this.navigationWindow = this.activation
    this.navigationSettledAt = 0
    this.navigationSettledMain = false
    this.actingPage = actingPage
    this.pendingNavigations.clear()
    const remaining = options.remainingStepMs
    this.boundAt = Date.now()
      + (typeof remaining === 'number' && Number.isFinite(remaining) ? Math.max(0, remaining) : this.completionCapMs)
    this.abortSignal = options.abortSignal
    this.preImageGeneration = -1
    const clipboardAction = !CLIPBOARD_EXCLUDED_ACTIONS.has(action.type)
    if (this.readsClipboard && clipboardAction && this.timeLeft() > 0) await this.takePreImage()
    // Claims count only once the pre-image step settled, so a write made during it is not attributed.
    this.clipboardArmed = this.armed && clipboardAction
  }

  private timeLeft(): number {
    return this.abortSignal?.aborted ? 0 : this.boundAt - Date.now()
  }

  // Calls `fire` once when the action's abort signal fires; the returned function removes it.
  private onAbort(fire: () => void): () => void {
    const signal = this.abortSignal
    if (!signal) return () => undefined
    if (signal.aborted) {
      queueMicrotask(fire)
      return () => undefined
    }
    signal.addEventListener('abort', fire, { once: true })
    return () => { signal.removeEventListener('abort', fire) }
  }

  async collect(): Promise<CapturedOperations | undefined> {
    if (!this.armed) return undefined
    let next = 0
    try {
      await this.waitForStartWindow()
      this.closeStartWindow()
      const writes = this.clipboardWrites
      this.clipboardArmed = false
      this.clipboardWrites = []
      const clipboard = !this.readsClipboard
        ? writes.map(({ source, text }): CapturedClipboardWrite => ({ source, text, readBack: 'unavailable' }))
        : writes.length > 0 ? await this.readBack(writes) : []
      const evidence: DownloadEvidence[] = []
      while (next < this.downloads.length) {
        const { download, late } = this.downloads[next++]!
        const finished = await this.finish(download)
        evidence.push(late ? { ...finished, late: true } : finished)
      }
      if (evidence.length === 0 && clipboard.length === 0) return undefined
      return {
        ...(evidence.length > 0 ? { downloads: evidence } : {}),
        ...(clipboard.length > 0 ? { clipboard } : {}),
      }
    } finally {
      this.held.push(...this.downloads.slice(next).map((entry) => entry.download))
      this.closeStartWindow()
      this.armed = false
      this.clipboardArmed = false
      this.downloads = []
      this.clipboardWrites = []
      this.abortSignal = undefined
      this.actingPage = undefined
      this.preImageGeneration = -1
    }
  }

  // The grace after an activation action, then for as long as a navigation it started has neither
  // a response nor a failure, plus NAVIGATION_SETTLE_MS after the last answer; all bounded by the
  // action's time left. Fixed when the wait begins: the acting page's main-frame navigation ends at
  // mainEnd (half the time left), any other at capEnd (also NAVIGATION_WINDOW_CAP_MS).
  private async waitForStartWindow(): Promise<void> {
    if (!this.activation) return
    const start = Date.now()
    const graceEnd = start + Math.min(this.startGraceMs, Math.max(0, this.timeLeft()))
    const reserve = Math.max(0, this.timeLeft()) / 2
    const capEnd = start + Math.min(NAVIGATION_WINDOW_CAP_MS, reserve)
    const mainEnd = start + reserve
    for (;;) {
      const left = this.timeLeft()
      if (left <= 0) return
      const now = Date.now()
      const settleEnd = Math.min(
        this.navigationSettledAt + NAVIGATION_SETTLE_MS,
        this.navigationSettledMain ? mainEnd : capEnd,
      )
      const openFor = Math.max(graceEnd, settleEnd) - now
      const pendingEnd = this.pendingNavigationEnd(mainEnd, capEnd)
      if (openFor > 0) await this.waitForSignal(Math.min(openFor, left))
      else if (now < pendingEnd) await this.waitForSignal(Math.min(pendingEnd - now, left))
      else return
    }
  }

  // mainEnd while a main-frame navigation of the acting page is pending, else capEnd while any
  // other is, else 0.
  private pendingNavigationEnd(mainEnd: number, capEnd: number): number {
    let end = 0
    for (const { main } of this.pendingNavigations.values()) {
      if (main) return mainEnd
      end = capEnd
    }
    return end
  }

  private closeStartWindow(): void {
    this.startWindow = false
    this.navigationWindow = false
    this.pendingNavigations.clear()
  }

  private onRequest(request: Request): void {
    if (!this.navigationWindow || !request.isNavigationRequest()) return
    let page: Page | undefined
    let main = false
    try {
      const frame = request.frame()
      page = frame.page()
      main = this.actingPage !== undefined && frame === this.actingPage.mainFrame()
    } catch { /* not a frame request */ }
    this.pendingNavigations.set(request, { page, main })
  }

  private settleNavigation(request: Request): void {
    const pending = this.pendingNavigations.get(request)
    if (!pending) return
    this.pendingNavigations.delete(request)
    this.navigationSettledAt = Date.now()
    this.navigationSettledMain = pending.main
    this.notify?.()
  }

  private onClipboardWrite(frame: Frame, payload: unknown): void {
    if (!this.armed || !this.clipboardArmed) return
    if (!payload || typeof payload !== 'object') return
    const { via, text } = payload as Record<string, unknown>
    if (typeof via !== 'string' || !CLIPBOARD_SOURCES.has(via) || typeof text !== 'string') return
    this.clipboardWrites.push({ source: via as ClipboardEvidence['source'], text, frame })
    if (this.clipboardWrites.length > CLIPBOARD_CLAIMS_PER_ACTION) this.clipboardWrites.shift()
  }

  // Takes the probe page's pre-image of the clipboard; a closed or crashed probe is replaced once.
  private async takePreImage(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const probe = await this.openProbe()
      if (!probe) return
      if (probe.isClosed()) {
        await this.resetProbe()
        continue
      }
      const generation = this.probeGeneration
      const bound = Math.min(READ_BACK_TIMEOUT_MS, this.timeLeft())
      if (generation === this.unreadableGeneration || bound <= 0) return
      try {
        const status = await this.bounded(
          probe.evaluate(() => (globalThis as ProbeScope).__agentQaReadback.snapshot()),
          bound,
        )
        if (status === undefined) this.markUnreadable(generation, bound)
        else if (status === 'read' && generation === this.probeGeneration) this.preImageGeneration = generation
        return
      } catch {
        await this.resetProbe()
      }
    }
  }

  // Only the final claim is compared, against a clipboard that changed during the action; an
  // earlier claim is matched only when its text equals a matched final claim.
  private async readBack(writes: PendingClipboardWrite[]): Promise<CapturedClipboardWrite[]> {
    const last = writes.length - 1
    const final = writes[last]!
    const answer = await this.readClipboard(final.frame, final.text)
    return writes.map(({ source, text }, position) => ({
      source,
      text,
      readBack: answer === PROBE_MATCHED && text === final.text
        ? 'matched'
        : answer === PROBE_DIFFERENT && position === last ? 'mismatched' : 'unavailable',
    }))
  }

  // PROBE_MATCHED or PROBE_DIFFERENT when the clipboard changed during the action, else undefined.
  // Only the final claim's text enters the probe page and only a number comes back.
  private async readClipboard(frame: Frame, finalText: string): Promise<number | undefined> {
    const generation = this.preImageGeneration
    if (generation < 0 || generation !== this.probeGeneration || generation === this.unreadableGeneration) {
      return undefined
    }
    if (frame.isDetached()) return undefined
    try {
      if (new URL(frame.url()).origin === 'null') return undefined
    } catch {
      return undefined
    }
    const frameBound = Math.min(READ_BACK_TIMEOUT_MS, this.timeLeft())
    if (frameBound <= 0) return undefined
    const secure = await this.bounded(
      frame.evaluate('window.isSecureContext && !!(navigator.clipboard && navigator.clipboard.readText)'),
      frameBound,
    ).catch(() => false)
    if (secure !== true) return undefined
    const probe = await this.openProbe()
    const bound = Math.min(READ_BACK_TIMEOUT_MS, this.timeLeft())
    if (!probe || generation !== this.probeGeneration || bound <= 0) return undefined
    let answer: number | undefined
    try {
      if (probe.isClosed()) throw new Error('probe closed')
      answer = await this.bounded(
        probe.evaluate((text: string) => (globalThis as ProbeScope).__agentQaReadback.compare(text), finalText),
        bound,
      )
    } catch {
      // The probe page closed or crashed, or its context went away; its pre-image went with it.
      await this.resetProbe()
      return undefined
    }
    if (answer === undefined) this.markUnreadable(generation, bound)
    return answer === PROBE_MATCHED || answer === PROBE_DIFFERENT ? answer : undefined
  }

  // A read cut short by the step's time or its abort says nothing about the probe.
  private markUnreadable(generation: number, bound: number): void {
    if (bound >= READ_BACK_TIMEOUT_MS && !this.abortSignal?.aborted) this.unreadableGeneration = generation
  }

  // Resolves undefined after `ms` or on the action's abort; rejects when `promise` rejects.
  private async bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    let off = (): void => undefined
    try {
      return await Promise.race([
        withTimeout(promise, ms),
        new Promise<undefined>((resolve) => { off = this.onAbort(() => { resolve(undefined) }) }),
      ])
    } finally {
      off()
    }
  }

  private openProbe(): Promise<Page | undefined> {
    if (!this.readsClipboard) return Promise.resolve(undefined)
    this.probe ??= this.createProbe(this.probeGeneration)
    return this.probe
  }

  // A separate context of the app's browser: only the reserved origin loads (a blank document, no
  // init script), every other request is aborted, and only that origin may read the clipboard.
  private async createProbe(generation: number): Promise<Page | undefined> {
    let context: BrowserContext | undefined
    try {
      const browser = this.appContext?.browser()
      if (!browser) return undefined
      context = await browser.newContext()
      if (generation !== this.probeGeneration) {
        await context.close().catch(() => undefined)
        return undefined
      }
      this.probeContext = context
      await context.route('**/*', (route) => {
        let origin = ''
        try {
          origin = new URL(route.request().url()).origin
        } catch { /* aborted below */ }
        return origin === CLIPBOARD_READBACK_ORIGIN
          ? route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })
          : route.abort()
      })
      await context.grantPermissions(['clipboard-read'], { origin: CLIPBOARD_READBACK_ORIGIN })
      const page = await context.newPage()
      page.once('crash', () => {
        if (generation === this.probeGeneration) void this.resetProbe()
      })
      await page.goto(`${CLIPBOARD_READBACK_ORIGIN}/`)
      await page.evaluate(installProbeReadback)
      return page
    } catch {
      if (generation === this.probeGeneration) {
        this.probe = null
        this.probeContext = null
      }
      await context?.close().catch(() => undefined)
      return undefined
    }
  }

  /** The bytes of a completed download with this sha256 while the hold keeps them. */
  readDownloadBytes(sha256: string): Uint8Array | undefined {
    return this.heldBytes.get(sha256)
  }

  private holdBytes(sha256: string, bytes: Uint8Array): void {
    if (bytes.length > DOWNLOAD_HOLD_FILE_CAP) return
    const previous = this.heldBytes.get(sha256)
    if (previous !== undefined) {
      this.heldBytes.delete(sha256)
      this.heldByteTotal -= previous.length
    }
    this.heldBytes.set(sha256, bytes)
    this.heldByteTotal += bytes.length
    for (const [key, value] of this.heldBytes) {
      if (this.heldByteTotal <= DOWNLOAD_HOLD_TOTAL_CAP) break
      this.heldBytes.delete(key)
      this.heldByteTotal -= value.length
    }
  }

  /** Cancels and deletes every held download, clears the held bytes, then closes the read-back probe context. */
  async dispose(): Promise<void> {
    this.heldBytes.clear()
    this.heldByteTotal = 0
    const held = this.held
    this.held = []
    for (const download of held) {
      await download.cancel().catch(() => undefined)
      await download.delete().catch(() => undefined)
    }
    await this.resetProbe()
  }

  // Closes only the probe context; held downloads are never touched here.
  private async resetProbe(): Promise<void> {
    const context = this.probeContext
    this.probeGeneration += 1
    this.unreadableGeneration = -1
    this.probe = null
    this.probeContext = null
    await context?.close().catch(() => undefined)
  }

  private attachPage(page: Page): void {
    if (this.attachedPages.has(page)) return
    this.attachedPages.add(page)
    page.on('download', (download) => {
      if (!this.startWindow) {
        this.held.push(download)
        return
      }
      this.downloads.push({ download, late: false })
      this.notify?.()
    })
    page.on('close', () => {
      for (const [request, pending] of this.pendingNavigations) if (pending.page === page) this.settleNavigation(request)
    })
  }

  // Resolves on a download start, a settled navigation, the abort, or after `ms`.
  private async waitForSignal(ms: number): Promise<void> {
    let off = (): void => undefined
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        resolve()
      }
      this.notify = done
      off = this.onAbort(done)
    })
    off()
    this.notify = null
  }

  private async finish(download: Download): Promise<DownloadEvidence> {
    const suggestedFilename = download.suggestedFilename()
    const base: Pick<DownloadEvidence, 'suggestedFilename' | 'extension'> = {
      suggestedFilename,
      extension: extname(suggestedFilename),
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let off = (): void => undefined
    const outcome = await Promise.race([
      download.failure().catch((error: unknown) => (error instanceof Error ? error.message : String(error))),
      new Promise<typeof UNFINISHED>((resolve) => {
        const end = (): void => { resolve(UNFINISHED) }
        timer = setTimeout(end, Math.max(0, this.timeLeft()))
        off = this.onAbort(end)
      }),
    ])
    clearTimeout(timer)
    off()
    if (outcome === UNFINISHED) {
      await download.cancel().catch(() => undefined)
      await download.delete().catch(() => undefined)
      return { ...base, state: 'unfinished' }
    }
    if (outcome !== null) {
      await download.delete().catch(() => undefined)
      return { ...base, state: outcome === 'canceled' ? 'canceled' : 'failed', failure: outcome }
    }
    try {
      const { size, sha256, bytes } = await digest(download)
      if (bytes !== undefined) this.holdBytes(sha256, bytes)
      return { ...base, size, sha256, state: 'completed' }
    } catch (error) {
      return { ...base, state: 'failed', failure: error instanceof Error ? error.message : String(error) }
    } finally {
      await download.delete().catch(() => undefined)
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Hashes the stream and tees it into memory while the running size stays within the file cap.
async function digest(download: Download): Promise<{ size: number; sha256: string; bytes?: Uint8Array }> {
  const stream = await download.createReadStream()
  const hash = createHash('sha256')
  let size = 0
  let chunks: Buffer[] | undefined = []
  for await (const chunk of stream) {
    const bytes = chunk as Buffer
    size += bytes.length
    hash.update(bytes)
    if (size > DOWNLOAD_HOLD_FILE_CAP) chunks = undefined
    else chunks?.push(bytes)
  }
  const sha256 = hash.digest('hex')
  return chunks === undefined ? { size, sha256 } : { size, sha256, bytes: new Uint8Array(Buffer.concat(chunks)) }
}
