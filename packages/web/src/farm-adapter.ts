import type { Browser, BrowserContext, Page } from 'playwright-core'
import type { PlatformAdapter, PlatformConfig, ScreenState, Action, ActionResult, ObserveOptions, ConsoleLogEntry, NetworkLogEntry } from '@vostride/agent-qa-core'
import { getProvider, registerAllProviders } from '@vostride/agent-qa-core'
import { convertKeysForPlatform, isMacPlatform } from '@vostride/agent-qa-core'
import type { FarmWebConfig } from '@vostride/agent-qa-core'
import { observePage } from './observer.js'
import { ElementResolver } from './element-resolver.js'
import { validateAction } from './action-validator.js'
import { waitForPageReady } from './smart-wait.js'
import { scrollWithRef } from './scroll-helper.js'
import type { RefMap } from './types.js'

interface PageLogBuffers {
  consoleLogs: ConsoleLogEntry[]
  networkLogs: NetworkLogEntry[]
  consoleDrainIndex: number
  networkDrainIndex: number
  pendingRequests: Map<string, { url: string; method: string; headers: Record<string, string>; startTime: number; postData?: string }>
}

function clickDelayOption(clickDelay?: number): { delay?: number } {
  return clickDelay !== undefined && clickDelay > 0 ? { delay: clickDelay } : {}
}

export class FarmWebAdapter implements PlatformAdapter {
  readonly platform = 'web' as const

  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private lastRefs: RefMap = {}
  private sessionUrl: string | undefined
  private sessionId: string | undefined
  private testFailed = false
  private exitHandler: (() => void) | null = null
  private credentials: { username: string; accessKey: string } | null = null
  private pageLogBuffers = new Map<Page, PageLogBuffers>()
  private logCaptureConfig: { console: boolean; network: boolean } = { console: true, network: true }

  async setup(config: PlatformConfig): Promise<void> {
    if (!config.farmSession) {
      throw new Error('FarmWebAdapter requires config.farmSession to be set')
    }

    registerAllProviders()
    const provider = getProvider('browserstack')
    if (!provider) {
      throw new Error('Unknown farm provider: browserstack')
    }

    this.credentials = provider.resolveCredentials(config.farmSession.capabilities as any)
    if (!config.browser?.name) {
      throw new Error('FarmWebAdapter requires config.browser.name to be set')
    }
    const credentials = this.credentials

    const farmWebConfig: FarmWebConfig = {
      browser: config.browser,
      credentials,
      testName: (config.farmSession.capabilities as any)?.testName,
    }

    const { wsEndpoint } = await provider.resolveWebEndpoint(farmWebConfig)

    const { chromium } = await import('playwright-core')
    this.browser = await chromium.connect({ wsEndpoint })

    const contextOptions: Record<string, unknown> = {
      viewport: config.browser?.viewport ?? { width: 1280, height: 720 },
    }
    if (config.recording?.enabled) {
      contextOptions.recordVideo = {
        dir: config.recording.videoDir,
        size: config.recording.videoSize ?? config.browser?.viewport ?? { width: 1280, height: 720 },
      }
    }
    if (config.authState?.storageStatePath) {
      contextOptions.storageState = config.authState.storageStatePath
    }
    this.context = await this.browser.newContext(contextOptions)

    // Clipboard write permission — farm-adapter always uses chromium (see chromium.connect above)
    await this.context.grantPermissions(['clipboard-write'])

    this.page = await this.context.newPage()

    try {
      const cdpSession = await this.page.context().newCDPSession(this.page)
      const result = await cdpSession.send('Browser.getVersion') as Record<string, string>
      await cdpSession.detach()
      // BrowserStack includes session info in the debugger URL or we extract from the WSS endpoint
      // Use REST API to get session details
      const auth = Buffer.from(`${credentials.username}:${credentials.accessKey}`).toString('base64')
      const resp = await fetch('https://api.browserstack.com/automate/builds.json?limit=1&status=running', {
        headers: { Authorization: `Basic ${auth}` },
      })
      if (resp.ok) {
        const builds = await resp.json() as Array<{ automation_build: { hashed_id: string; name: string } }>
        if (builds.length > 0) {
          const buildId = builds[0].automation_build.hashed_id
          const sessResp = await fetch(`https://api.browserstack.com/automate/builds/${buildId}/sessions.json?limit=1`, {
            headers: { Authorization: `Basic ${auth}` },
          })
          if (sessResp.ok) {
            const sessions = await sessResp.json() as Array<{ automation_session: { hashed_id: string; browser_url: string } }>
            if (sessions.length > 0) {
              this.sessionId = sessions[0].automation_session.hashed_id
              this.sessionUrl = sessions[0].automation_session.browser_url
            }
          }
        }
      }
    } catch {
      // Session details extraction is best-effort
    }

    this.exitHandler = () => {
      try {
        this.browser?.close()
      } catch {
        // Best-effort cleanup on exit
      }
    }
    process.on('exit', this.exitHandler)

    this.logCaptureConfig = { console: config.logCapture?.console !== false, network: config.logCapture?.network !== false }
    this.attachLogListeners(this.page)
  }

  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
    }

    // Set session status via REST API after browser is closed
    if (this.sessionId && this.credentials) {
      try {
        const status = this.testFailed ? 'failed' : 'passed'
        const reason = this.testFailed ? 'Test failed' : 'Test passed'
        const auth = Buffer.from(`${this.credentials.username}:${this.credentials.accessKey}`).toString('base64')
        await fetch(`https://api.browserstack.com/automate/sessions/${this.sessionId}.json`, {
          method: 'PUT',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, reason }),
        })
      } catch {
        // Status reporting is best-effort
      }
    }

    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler)
      this.exitHandler = null
    }

    this.browser = null
    this.context = null
    this.page = null
    this.lastRefs = {}
    this.pageLogBuffers.clear()
  }

  async observe(options?: ObserveOptions): Promise<ScreenState> {
    if (!this.page) {
      throw new Error('FarmWebAdapter not initialized — call setup() first')
    }

    await waitForPageReady(this.page)
    const state = await observePage(this.page, {
      extractDom: options?.extractDom,
    })
    this.lastRefs = (state.metadata.refMap as RefMap) ?? {}
    return state
  }

  async execute(action: Action): Promise<ActionResult> {
    if (!this.page) {
      throw new Error('FarmWebAdapter not initialized — call setup() first')
    }

    try {
      return await this.executeAction(action)
    } catch (err) {
      let screenshot: Buffer | undefined
      let boundingBox: { x: number; y: number; width: number; height: number } | undefined
      try {
        screenshot = await this.page.screenshot()
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
        return await this.page.screenshot()
      }
      return undefined
    } catch {
      return undefined
    }
  }

  getPage(): Page | null {
    return this.page
  }

  async getVideoPath(): Promise<string | null> {
    try {
      const video = this.page?.video()
      if (!video) return null
      return await video.path()
    } catch {
      return null
    }
  }

  markFailed(): void {
    this.testFailed = true
  }

  getSessionUrl(): string | undefined {
    return this.sessionUrl
  }

  getSessionId(): string | undefined {
    return this.sessionId
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
        buffers.consoleLogs.push({
          level: msg.type(),
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

  private async executeAction(action: Action): Promise<ActionResult> {
    const page = this.page!
    const resolver = new ElementResolver(page, this.lastRefs)

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
        })
        return { success: true, coordinates, boundingBox: box ?? undefined }
      }

      case 'fill': {
        const locator = resolver.resolve(action.ref)
        const box = await resolver.getBoundingBox(action.ref)
        await locator.fill(action.value)
        return { success: true, boundingBox: box ?? undefined }
      }

      case 'select': {
        const locator = resolver.resolve(action.ref)
        const box = await resolver.getBoundingBox(action.ref)
        await locator.selectOption(action.value)
        return { success: true, boundingBox: box ?? undefined }
      }

      case 'navigate': {
        await page.goto(action.url, { waitUntil: 'domcontentloaded' })
        await waitForPageReady(page)
        return { success: true }
      }

      case 'scroll': {
        const deltaX = action.scrollType === 'horizontal' ? action.value : 0
        const deltaY = action.scrollType === 'vertical' ? action.value : 0
        let coordinates: { x: number; y: number } | undefined
        let boundingBox: { x: number; y: number; width: number; height: number } | undefined
        let scrollData: { scrolled: boolean; scrolledContainer: string } | undefined

        if (action.ref) {
          const refData = this.lastRefs[action.ref]
          if (refData) {
            const scrollAxis = action.scrollType === 'horizontal' ? 'horizontal' : 'vertical'
            const result = await scrollWithRef(page, refData, deltaX, deltaY, scrollAxis)
            if (result.bounds) {
              coordinates = { x: result.bounds.x + result.bounds.width / 2, y: result.bounds.y + result.bounds.height / 2 }
              boundingBox = result.bounds
            }
            scrollData = { scrolled: result.scrolled, scrolledContainer: result.scrolledContainer }
          } else {
            await page.mouse.wheel(deltaX, deltaY)
          }
        } else {
          await page.mouse.wheel(deltaX, deltaY)
        }

        await page.evaluate(`new Promise(resolve => {
          const t = setTimeout(() => resolve('timeout'), 500);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            clearTimeout(t);
            resolve('raf');
          }));
        })`)

        return { success: true, coordinates, boundingBox, data: scrollData }
      }

      case 'waitFor': {
        const timeout = action.timeout ?? 5000
        try {
          await page.waitForFunction(
            `document.body && document.body.innerText.includes(${JSON.stringify(action.condition)})`,
            { timeout },
          )
        } catch {
          try {
            await page.waitForSelector(action.condition, { timeout })
          } catch {
            // Best-effort
          }
        }
        return { success: true }
      }

      case 'delay': {
        await page.waitForTimeout(action.ms)
        return { success: true }
      }

      case 'waitForUrl': {
        try {
          // Explicit 30s timeout overrides Playwright's infinite default (Pitfall 2)
          await page.waitForURL(action.pattern, { timeout: 30_000 })
          return { success: true }
        } catch (err) {
          return {
            success: false,
            error: `URL pattern "${action.pattern}" did not match within 30s. Hint: use "**" wildcards for substring matching (e.g., "**/dashboard**"). ${err instanceof Error ? err.message : String(err)}`,
          }
        }
      }

      case 'keypress': {
        const effectiveKeys = convertKeysForPlatform(action.keys, {
          enabled: action.convertPlatformKeys !== false,
          isMac: isMacPlatform(),
        })
        for (const key of effectiveKeys) {
          await page.keyboard.press(key)
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
        // Paths are pre-resolved to absolute by runner loop.ts (see Plan 01 Task 2)
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

      case 'keyDown': {
        await page.keyboard.down(action.key)
        return { success: true }
      }

      case 'keyUp': {
        await page.keyboard.up(action.key)
        return { success: true }
      }

      case 'refresh': {
        await page.reload({ waitUntil: 'domcontentloaded' })
        await waitForPageReady(page)
        return { success: true }
      }

      case 'navigateHistory': {
        if (action.direction === 'back') {
          await page.goBack({ waitUntil: 'domcontentloaded' })
        } else {
          await page.goForward({ waitUntil: 'domcontentloaded' })
        }
        await waitForPageReady(page)
        return { success: true }
      }

      case 'readConsoleLogs': {
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

      case 'readNetworkLogs': {
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

      case 'readCookies': {
        const cookies = await this.context!.cookies()
        if (action.name) {
          const cookie = cookies.find(c => c.name === action.name) ?? null
          return { success: true, data: cookie }
        }
        return { success: true, data: cookies }
      }

      case 'setCookies': {
        const cookiesWithDefaults = action.cookies.map(c => ({
          ...c,
          url: !c.domain ? page.url() : undefined,
        }))
        await this.context!.addCookies(cookiesWithDefaults)
        return { success: true }
      }

      case 'readLocalStorage': {
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

      case 'setLocalStorage': {
        await page.evaluate((entries: Array<{ key: string; value: string }>) => {
          for (const { key, value } of entries) {
            localStorage.setItem(key, value)
          }
        }, action.entries)
        return { success: true }
      }

      case 'assert': {
        return { success: true }
      }

      case 'clearText': {
        const loc = resolver.resolve(action.ref)
        const clearBox = await resolver.getBoundingBox(action.ref)
        await loc.clear()
        return { success: true, boundingBox: clearBox ?? undefined }
      }

      case 'drag': {
        const fromLoc = resolver.resolve(action.fromRef)
        const toLoc = resolver.resolve(action.toRef)
        await fromLoc.dragTo(toLoc)
        return { success: true }
      }

      case 'doubleTap': {
        const dblLoc = resolver.resolve(action.ref)
        const dblBox = await resolver.getBoundingBox(action.ref)
        await dblLoc.dblclick()
        return { success: true, boundingBox: dblBox ?? undefined }
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

      case 'openLink': {
        await page.goto(action.url, { waitUntil: 'domcontentloaded' })
        await waitForPageReady(page)
        return { success: true }
      }

      case 'newTab': {
        const newPage = await this.context!.newPage()
        this.attachLogListeners(newPage)
        await newPage.goto(action.url, { waitUntil: 'domcontentloaded' })
        await waitForPageReady(newPage)
        this.page = newPage
        return { success: true }
      }

      case 'switchTab': {
        const pages = this.context!.pages()

        let target: Page | undefined

        if (action.index !== undefined) {
          if (action.index < 0 || action.index >= pages.length) {
            return { success: false, error: `Tab index ${action.index} out of range (${pages.length} tabs open)` }
          }
          target = pages[action.index]
        } else if (action.title) {
          for (const p of pages) {
            const t = await p.title()
            if (t.includes(action.title)) { target = p; break }
          }
        } else if (action.url) {
          target = pages.find(p => p.url().includes(action.url!))
        } else {
          return { success: false, error: 'switchTab requires at least one of: index, title, or url' }
        }

        if (!target) {
          return { success: false, error: `No tab found matching ${JSON.stringify({ index: action.index, title: action.title, url: action.url })}` }
        }

        this.page = target
        return { success: true }
      }

      case 'tap':
      case 'swipe':
      case 'longpress':
      case 'pinch':
      case 'multiTap': {
        return { success: false, error: `${action.type} is a mobile-only gesture` }
      }

      case 'tapCoordinate': {
        await page.mouse.click(action.x, action.y)
        return { success: true, coordinates: { x: action.x, y: action.y } }
      }

      case 'hideKeyboard':
      case 'launchApp':
      case 'stopApp':
      case 'setOrientation': {
        return { success: true }
      }

      default: {
        return { success: false, error: `Unknown action type: ${(action as any).type}` }
      }
    }
  }
}
