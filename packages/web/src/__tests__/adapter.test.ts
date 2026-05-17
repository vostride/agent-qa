import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebPlatformAdapter } from '../adapter.js'

// Track browser event listeners so tests can simulate disconnect
let browserListeners: Record<string, Function[]> = {}
let mockPageListeners: Record<string, Function[]> = {}
let mockPage2Listeners: Record<string, Function[]> = {}
let newPageCallCount = 0

const mockPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  keyboard: { press: vi.fn().mockResolvedValue(undefined) },
  mouse: {
    move: vi.fn().mockResolvedValue(undefined),
    wheel: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
  },
  waitForSelector: vi.fn().mockResolvedValue(undefined),
  waitForTimeout: vi.fn().mockResolvedValue(undefined),
  waitForURL: vi.fn().mockResolvedValue(undefined),
  bringToFront: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
  addInitScript: vi.fn().mockResolvedValue(undefined),
  video: vi.fn().mockReturnValue(null),
  locator: vi.fn().mockReturnValue({
    ariaSnapshot: vi.fn().mockResolvedValue('- button "Test" [ref=e1]'),
  }),
  on: vi.fn().mockImplementation((event: string, cb: Function) => {
    if (!mockPageListeners[event]) mockPageListeners[event] = []
    mockPageListeners[event].push(cb)
  }),
  url: vi.fn().mockReturnValue('https://example.com'),
  title: vi.fn().mockResolvedValue('Example Page'),
  viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
  getByRole: vi.fn().mockReturnValue({
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    dblclick: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    nth: vi.fn().mockReturnThis(),
    boundingBox: vi.fn().mockResolvedValue({ x: 50, y: 100, width: 200, height: 40 }),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    textContent: vi.fn().mockResolvedValue('hello world'),
    focus: vi.fn().mockResolvedValue(undefined),
  }),
}

const mockPage2 = {
  goto: vi.fn().mockResolvedValue(undefined),
  keyboard: { press: vi.fn().mockResolvedValue(undefined) },
  mouse: {
    move: vi.fn().mockResolvedValue(undefined),
    wheel: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
  },
  waitForSelector: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot-2')),
  addInitScript: vi.fn().mockResolvedValue(undefined),
  video: vi.fn().mockReturnValue(null),
  locator: vi.fn().mockReturnValue({
    ariaSnapshot: vi.fn().mockResolvedValue('- button "Test2" [ref=e2]'),
  }),
  on: vi.fn().mockImplementation((event: string, cb: Function) => {
    if (!mockPage2Listeners[event]) mockPage2Listeners[event] = []
    mockPage2Listeners[event].push(cb)
  }),
  url: vi.fn().mockReturnValue('https://other.com/page'),
  title: vi.fn().mockResolvedValue('Other Page'),
  viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
  getByRole: vi.fn().mockReturnValue({
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    dblclick: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    nth: vi.fn().mockReturnThis(),
    boundingBox: vi.fn().mockResolvedValue({ x: 50, y: 100, width: 200, height: 40 }),
  }),
}

const mockContext = {
  newPage: vi.fn().mockImplementation(() => {
    newPageCallCount++
    return Promise.resolve(newPageCallCount <= 1 ? mockPage : mockPage2)
  }),
  close: vi.fn().mockResolvedValue(undefined),
  pages: vi.fn().mockReturnValue([mockPage, mockPage2]),
  addInitScript: vi.fn().mockResolvedValue(undefined),
  grantPermissions: vi.fn().mockResolvedValue(undefined),
}

const mockBrowser = {
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn().mockImplementation((event: string, cb: Function) => {
    if (!browserListeners[event]) browserListeners[event] = []
    browserListeners[event].push(cb)
  }),
}

// Mock playwright-core to avoid real browser launches
vi.mock('playwright-core', () => {
  return {
    chromium: { launch: vi.fn().mockResolvedValue(mockBrowser) },
    firefox: { launch: vi.fn().mockResolvedValue(mockBrowser) },
    webkit: { launch: vi.fn().mockResolvedValue(mockBrowser) },
  }
})

function lastCallArg(mockFn: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const calls = mockFn.mock.calls
  const last = calls[calls.length - 1]?.[0]
  return last && typeof last === 'object' ? last as Record<string, unknown> : {}
}

describe('WebPlatformAdapter', () => {
  let adapter: WebPlatformAdapter

  beforeEach(() => {
    adapter = new WebPlatformAdapter()
    browserListeners = {}
    mockPageListeners = {}
    mockPage2Listeners = {}
    newPageCallCount = 0
    vi.clearAllMocks()
  })

  it('has platform set to web', () => {
    expect(adapter.platform).toBe('web')
  })

  it('throws on execute() before setup()', async () => {
    await expect(adapter.execute({ type: 'click', ref: 'e1' })).rejects.toThrow(
      'WebPlatformAdapter not initialized'
    )
  })

  it('throws on observe() before setup()', async () => {
    await expect(adapter.observe()).rejects.toThrow(
      'WebPlatformAdapter not initialized'
    )
  })

  it('sets up browser and page via setup()', async () => {
    await adapter.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })

    const page = adapter.getPage()
    expect(page).not.toBeNull()
  })

  it('loads selected auth storage state before creating the first page', async () => {
    await adapter.setup({
      platform: 'web',
      browser: { name: 'chromium', headless: true },
      authState: {
        version: 1,
        kind: 'web',
        targetName: 'staging-web',
        stateName: 'admin',
        capturedAt: '2026-05-17T00:00:00.000Z',
        storageStatePath: '/tmp/internal/admin.json',
      },
    })

    expect(mockBrowser.newContext).toHaveBeenCalledWith(expect.objectContaining({
      storageState: '/tmp/internal/admin.json',
    }))
    expect(mockBrowser.newContext.mock.invocationCallOrder[0]).toBeLessThan(
      mockContext.newPage.mock.invocationCallOrder[0],
    )
  })

  it('replaces Playwright missing-browser launch errors with agent-qa install guidance', async () => {
    const { webkit } = await import('playwright-core')
    const launch = webkit.launch as unknown as ReturnType<typeof vi.fn>
    launch.mockRejectedValueOnce(new Error([
      "browserType.launch: Executable doesn't exist at /Users/me/Library/Caches/ms-playwright/webkit-2272/pw_run.sh",
      'Looks like Playwright was just installed or updated.',
      'Please run the following command to download new browsers:',
      'npx playwright install',
    ].join('\n')))

    await expect(adapter.setup({ platform: 'web', browser: { name: 'webkit', headless: true } }))
      .rejects.toThrow('agent-qa install-browsers --webkit')
  })

  describe('clipboard-write permission grant', () => {
    it('grants clipboard-write permission on chromium setup', async () => {
      await adapter.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
      expect(mockContext.grantPermissions).toHaveBeenCalledWith(['clipboard-write'])
    })

    it('does NOT grant clipboard-write permission on firefox setup', async () => {
      await adapter.setup({ platform: 'web', browser: { name: 'firefox', headless: true } })
      expect(mockContext.grantPermissions).not.toHaveBeenCalled()
    })

    it('does NOT grant clipboard-write permission on webkit setup', async () => {
      await adapter.setup({ platform: 'web', browser: { name: 'webkit', headless: true } })
      expect(mockContext.grantPermissions).not.toHaveBeenCalled()
    })

    it('grants clipboard-write permission when browser.name is unset (defaults to chromium)', async () => {
      await adapter.setup({ platform: 'web' })
      expect(mockContext.grantPermissions).toHaveBeenCalledWith(['clipboard-write'])
    })
  })

  it('execute() handles navigate action', async () => {
    await adapter.setup({ platform: 'web' })

    const result = await adapter.execute({ type: 'navigate', url: 'https://example.com' })
    expect(result.success).toBe(true)

    const page = adapter.getPage()!
    expect(page.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'domcontentloaded' })
  })

  it('execute() handles click action with ref', async () => {
    await adapter.setup({ platform: 'web' })

    // First observe to populate refs
    await adapter.observe()

    const result = await adapter.execute({ type: 'click', ref: 'e1' })
    // The adapter delegates to ElementResolver which calls page.getByRole
    // Since refs are populated from observe, this should succeed
    expect(result.success).toBe(true)
  })

  it('execute() handles select actions through Playwright selectOption', async () => {
    await adapter.setup({ platform: 'web' })
    mockPage.locator.mockReturnValueOnce({
      ariaSnapshot: vi.fn().mockResolvedValue('- combobox "State"'),
    })
    const state = await adapter.observe()
    expect(state.elements[0].role).toBe('combobox')

    const locator = mockPage.getByRole()
    mockPage.getByRole.mockClear()
    locator.selectOption.mockClear()

    const result = await adapter.execute({ type: 'select', ref: 'e1', value: 'CA' })

    expect(result.success).toBe(true)
    expect(mockPage.getByRole).toHaveBeenCalledWith('combobox', { name: 'State', exact: true })
    expect(locator.selectOption).toHaveBeenCalledWith('CA')
  })

  it('execute() wraps errors in ActionResult', async () => {
    await adapter.setup({ platform: 'web' })

    // Try to click a ref that doesn't exist (no observe() called, lastRefs is empty)
    const result = await adapter.execute({ type: 'click', ref: 'nonexistent' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown ref')
  })

  it('execute() returns failure for mobile-only gestures', async () => {
    await adapter.setup({ platform: 'web' })

    const tapResult = await adapter.execute({ type: 'tap', ref: 'e1' })
    expect(tapResult.success).toBe(false)
    expect(tapResult.error).toContain('mobile-only gesture')

    const swipeResult = await adapter.execute({ type: 'swipe', direction: 'up' })
    expect(swipeResult.success).toBe(false)
    expect(swipeResult.error).toContain('mobile-only gesture')

    const longpressResult = await adapter.execute({ type: 'longpress', ref: 'e1' })
    expect(longpressResult.success).toBe(false)
    expect(longpressResult.error).toContain('mobile-only gesture')

    const pinchResult = await adapter.execute({ type: 'pinch', scale: 0.5 })
    expect(pinchResult.success).toBe(false)
    expect(pinchResult.error).toContain('mobile-only gesture')

    const multiTapResult = await adapter.execute({ type: 'multiTap', fingers: 2 })
    expect(multiTapResult.success).toBe(false)
    expect(multiTapResult.error).toContain('mobile-only gesture')
  })

  it('cleanup() sets internal state to null', async () => {
    await adapter.setup({ platform: 'web' })
    expect(adapter.getPage()).not.toBeNull()

    await adapter.cleanup()
    expect(adapter.getPage()).toBeNull()
  })

  describe('browser disconnect detection', () => {
    it('isBrowserDisconnected is false before any disconnect', async () => {
      await adapter.setup({ platform: 'web' })
      expect(adapter.isBrowserDisconnected).toBe(false)
    })

    it('isBrowserDisconnected is true after browser disconnects unexpectedly', async () => {
      await adapter.setup({ platform: 'web' })
      // Simulate browser disconnect (user closes window)
      const cbs = browserListeners['disconnected'] ?? []
      for (const cb of cbs) cb()
      expect(adapter.isBrowserDisconnected).toBe(true)
    })

    it('intentional cleanup does NOT set isBrowserDisconnected', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.cleanup()
      expect(adapter.isBrowserDisconnected).toBe(false)
    })

    it('cleanup resets disconnect state', async () => {
      await adapter.setup({ platform: 'web' })
      const cbs = browserListeners['disconnected'] ?? []
      for (const cb of cbs) cb()
      expect(adapter.isBrowserDisconnected).toBe(true)
      await adapter.cleanup()
      expect(adapter.isBrowserDisconnected).toBe(false)
    })
  })

  describe('newTab action', () => {
    it('creates a new page and navigates to URL', async () => {
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'newTab', url: 'https://new-page.com' })
      expect(result.success).toBe(true)
      expect(mockPage2.goto).toHaveBeenCalledWith('https://new-page.com', { waitUntil: 'domcontentloaded' })
    })

    it('switches active page to the new tab', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.execute({ type: 'newTab', url: 'https://new-page.com' })
      expect(adapter.getPage()).toBe(mockPage2)
    })
  })

  describe('switchTab action', () => {
    it('switches to tab by index', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.execute({ type: 'newTab', url: 'https://other.com' })
      const result = await adapter.execute({ type: 'switchTab', index: 0 })
      expect(result.success).toBe(true)
      expect(adapter.getPage()).toBe(mockPage)
    })

    it('returns error for out-of-range index', async () => {
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'switchTab', index: 99 })
      expect(result.success).toBe(false)
      expect(result.error).toContain('out of range')
    })

    it('switches to tab by title substring', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.execute({ type: 'newTab', url: 'https://other.com' })
      // Switch back to first tab
      await adapter.execute({ type: 'switchTab', index: 0 })
      // Now switch by title
      const result = await adapter.execute({ type: 'switchTab', title: 'Other' })
      expect(result.success).toBe(true)
      expect(adapter.getPage()).toBe(mockPage2)
    })

    it('switches to tab by URL substring', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.execute({ type: 'newTab', url: 'https://other.com' })
      await adapter.execute({ type: 'switchTab', index: 0 })
      const result = await adapter.execute({ type: 'switchTab', url: 'other.com' })
      expect(result.success).toBe(true)
      expect(adapter.getPage()).toBe(mockPage2)
    })

    it('returns error when no tab matches', async () => {
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'switchTab', title: 'Nonexistent' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('No tab found')
    })

    it('returns error when no params provided', async () => {
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'switchTab' } as any)
      expect(result.success).toBe(false)
      expect(result.error).toContain('requires at least one')
    })
  })

  describe('cross-tab log drain and read', () => {
    function simulateConsole(listeners: Record<string, Function[]>, text: string, type: string = 'log') {
      const cbs = listeners['console'] ?? []
      for (const cb of cbs) cb({ text: () => text, type: () => type, location: () => ({ url: '', lineNumber: 0, columnNumber: 0 }) })
    }

    async function setupTwoTabs() {
      await adapter.setup({ platform: 'web' })
      await adapter.execute({ type: 'newTab', url: 'https://other.com' })
    }

    it('drainConsoleLogs collects from all tabs', async () => {
      await setupTwoTabs()
      simulateConsole(mockPageListeners, 'tab1 log')
      simulateConsole(mockPage2Listeners, 'tab2 log')

      const logs = (adapter as any).drainConsoleLogs()
      expect(logs.length).toBe(2)
      const texts = logs.map((l: any) => l.text)
      expect(texts).toContain('tab1 log')
      expect(texts).toContain('tab2 log')
    })

    it('drainConsoleLogs with level filter collects from all tabs', async () => {
      await setupTwoTabs()
      simulateConsole(mockPageListeners, 'tab1 warn', 'warning')
      simulateConsole(mockPage2Listeners, 'tab2 error', 'error')
      simulateConsole(mockPageListeners, 'tab1 log', 'log')

      const errors = (adapter as any).drainConsoleLogs('error')
      expect(errors.length).toBe(1)
      expect(errors[0].text).toBe('tab2 error')
    })

    it('drainNetworkLogs collects from all tabs', async () => {
      await setupTwoTabs()
      // Simulate network via request+response events
      const page1ReqCbs = mockPageListeners['request'] ?? []
      for (const cb of page1ReqCbs) cb({ url: () => 'https://example.com/api', method: () => 'GET', headers: () => ({}), postData: () => null })
      const page1ResCbs = mockPageListeners['response'] ?? []
      for (const cb of page1ResCbs) cb({
        url: () => 'https://example.com/api', status: () => 200, headers: () => ({}),
        request: () => ({ method: () => 'GET', headers: () => ({}), timing: () => ({}) }),
        body: () => Promise.resolve(Buffer.from('ok')),
      })

      const page2ReqCbs = mockPage2Listeners['request'] ?? []
      for (const cb of page2ReqCbs) cb({ url: () => 'https://other.com/data', method: () => 'POST', headers: () => ({}), postData: () => null })
      const page2ResCbs = mockPage2Listeners['response'] ?? []
      for (const cb of page2ResCbs) cb({
        url: () => 'https://other.com/data', status: () => 201, headers: () => ({}),
        request: () => ({ method: () => 'POST', headers: () => ({}), timing: () => ({}) }),
        body: () => Promise.resolve(Buffer.from('created')),
      })

      // Wait for async response handlers to complete
      await new Promise(r => setTimeout(r, 50))

      const logs = (adapter as any).drainNetworkLogs()
      expect(logs.length).toBe(2)
      const urls = logs.map((l: any) => l.url)
      expect(urls).toContain('https://example.com/api')
      expect(urls).toContain('https://other.com/data')
    })

    it('readConsoleLogs with tab targets specific tab', async () => {
      await setupTwoTabs()
      simulateConsole(mockPageListeners, 'tab1 msg')
      simulateConsole(mockPage2Listeners, 'tab2 msg')

      const result = await adapter.execute({ type: 'readConsoleLogs', tab: { index: 1 } } as any)
      expect(result.success).toBe(true)
      const entries = result.data as any[]
      expect(entries.length).toBe(1)
      expect(entries[0].text).toBe('tab2 msg')
    })

    it('readConsoleLogs without tab returns all tabs', async () => {
      await setupTwoTabs()
      simulateConsole(mockPageListeners, 'tab1 msg')
      simulateConsole(mockPage2Listeners, 'tab2 msg')

      const result = await adapter.execute({ type: 'readConsoleLogs' })
      expect(result.success).toBe(true)
      const entries = result.data as any[]
      expect(entries.length).toBe(2)
    })

    it('readConsoleLogs with non-matching tab returns error', async () => {
      await setupTwoTabs()
      const result = await adapter.execute({ type: 'readConsoleLogs', tab: { title: 'Nonexistent' } } as any)
      expect(result.success).toBe(false)
      expect(result.error).toContain('No tab found')
    })

    it('readNetworkLogs with tab targets specific tab', async () => {
      await setupTwoTabs()
      // Simulate network on both tabs
      const page1ReqCbs = mockPageListeners['request'] ?? []
      for (const cb of page1ReqCbs) cb({ url: () => 'https://example.com/api', method: () => 'GET', headers: () => ({}), postData: () => null })
      const page1ResCbs = mockPageListeners['response'] ?? []
      for (const cb of page1ResCbs) cb({
        url: () => 'https://example.com/api', status: () => 200, headers: () => ({}),
        request: () => ({ method: () => 'GET', headers: () => ({}), timing: () => ({}) }),
        body: () => Promise.resolve(Buffer.from('ok')),
      })
      const page2ReqCbs = mockPage2Listeners['request'] ?? []
      for (const cb of page2ReqCbs) cb({ url: () => 'https://other.com/data', method: () => 'POST', headers: () => ({}), postData: () => null })
      const page2ResCbs = mockPage2Listeners['response'] ?? []
      for (const cb of page2ResCbs) cb({
        url: () => 'https://other.com/data', status: () => 201, headers: () => ({}),
        request: () => ({ method: () => 'POST', headers: () => ({}), timing: () => ({}) }),
        body: () => Promise.resolve(Buffer.from('created')),
      })

      await new Promise(r => setTimeout(r, 50))

      const result = await adapter.execute({ type: 'readNetworkLogs', tab: { url: 'other.com' } } as any)
      expect(result.success).toBe(true)
      const entries = result.data as any[]
      expect(entries.length).toBe(1)
      expect(entries[0].url).toBe('https://other.com/data')
    })

    it('readNetworkLogs without tab returns all tabs', async () => {
      await setupTwoTabs()
      const page1ReqCbs = mockPageListeners['request'] ?? []
      for (const cb of page1ReqCbs) cb({ url: () => 'https://example.com/api', method: () => 'GET', headers: () => ({}), postData: () => null })
      const page1ResCbs = mockPageListeners['response'] ?? []
      for (const cb of page1ResCbs) cb({
        url: () => 'https://example.com/api', status: () => 200, headers: () => ({}),
        request: () => ({ method: () => 'GET', headers: () => ({}), timing: () => ({}) }),
        body: () => Promise.resolve(Buffer.from('ok')),
      })
      const page2ReqCbs = mockPage2Listeners['request'] ?? []
      for (const cb of page2ReqCbs) cb({ url: () => 'https://other.com/data', method: () => 'POST', headers: () => ({}), postData: () => null })
      const page2ResCbs = mockPage2Listeners['response'] ?? []
      for (const cb of page2ResCbs) cb({
        url: () => 'https://other.com/data', status: () => 201, headers: () => ({}),
        request: () => ({ method: () => 'POST', headers: () => ({}), timing: () => ({}) }),
        body: () => Promise.resolve(Buffer.from('created')),
      })

      await new Promise(r => setTimeout(r, 50))

      const result = await adapter.execute({ type: 'readNetworkLogs' })
      expect(result.success).toBe(true)
      const entries = result.data as any[]
      expect(entries.length).toBe(2)
    })
  })

  describe('doubleClick and rightClick actions', () => {
    it('doubleTap executes dblclick on the resolved locator', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'doubleTap', ref: 'e1' })
      expect(result.success).toBe(true)
      expect(mockPage.getByRole().dblclick).toHaveBeenCalled()
    })

    it('doubleClick executes dblclick on the resolved locator', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'doubleClick', ref: 'e1' })
      expect(result.success).toBe(true)
      expect(mockPage.getByRole().dblclick).toHaveBeenCalled()
      expect(lastCallArg(mockPage.getByRole().dblclick)).not.toHaveProperty('position')
      expect(lastCallArg(mockPage.getByRole().dblclick)).not.toHaveProperty('delay')
    })

    it('doubleClick passes relativePosition as Playwright position option', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'doubleClick', ref: 'e1', relativePosition: { x: 10, y: 20 } })
      expect(result.success).toBe(true)
      expect(mockPage.getByRole().dblclick).toHaveBeenCalledWith(expect.objectContaining({ position: { x: 10, y: 20 } }))
    })

    it('doubleClick passes clickDelay as Playwright delay option', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'doubleClick', ref: 'e1', clickDelay: 500 })
      expect(result.success).toBe(true)
      expect(mockPage.getByRole().dblclick).toHaveBeenCalledWith(expect.objectContaining({ delay: 500 }))
    })

    it('doubleClick does not pass zero clickDelay as Playwright delay option', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'doubleClick', ref: 'e1', clickDelay: 0 })
      expect(result.success).toBe(true)
      expect(lastCallArg(mockPage.getByRole().dblclick)).not.toHaveProperty('delay')
    })

    it('rightClick executes click with button right on the resolved locator', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'rightClick', ref: 'e1' })
      expect(result.success).toBe(true)
      expect(mockPage.getByRole().click).toHaveBeenCalledWith(expect.objectContaining({ button: 'right' }))
      expect(lastCallArg(mockPage.getByRole().click)).not.toHaveProperty('position')
      expect(lastCallArg(mockPage.getByRole().click)).not.toHaveProperty('delay')
    })

    it('rightClick passes relativePosition as Playwright position option', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'rightClick', ref: 'e1', relativePosition: { x: 5, y: 15 } })
      expect(result.success).toBe(true)
      expect(mockPage.getByRole().click).toHaveBeenCalledWith(expect.objectContaining({ button: 'right', position: { x: 5, y: 15 } }))
    })

    it('click passes clickDelay as Playwright delay option', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'click', ref: 'e1', clickDelay: 200 })
      expect(result.success).toBe(true)
      expect(mockPage.getByRole().click).toHaveBeenCalledWith(expect.objectContaining({ delay: 200 }))
    })

    it('rightClick passes non-zero clickDelay as Playwright delay option', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'rightClick', ref: 'e1', clickDelay: 300 })
      expect(result.success).toBe(true)
      expect(mockPage.getByRole().click).toHaveBeenCalledWith(expect.objectContaining({ button: 'right', delay: 300 }))
    })

    it('rightClick does not pass zero clickDelay as Playwright delay option', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'rightClick', ref: 'e1', clickDelay: 0 })
      expect(result.success).toBe(true)
      expect(lastCallArg(mockPage.getByRole().click)).not.toHaveProperty('delay')
    })

    it('click does not pass omitted or zero clickDelay as Playwright delay option', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const locator = mockPage.getByRole()

      await adapter.execute({ type: 'click', ref: 'e1' })
      expect(lastCallArg(locator.click)).not.toHaveProperty('delay')

      locator.click.mockClear()
      const result = await adapter.execute({ type: 'click', ref: 'e1', clickDelay: 0 })
      expect(result.success).toBe(true)
      expect(lastCallArg(locator.click)).not.toHaveProperty('delay')
    })

    it('doubleClick returns coordinates at relativePosition offset', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'doubleClick', ref: 'e1', relativePosition: { x: 10, y: 20 } })
      expect(result.success).toBe(true)
      expect(result.coordinates).toEqual({ x: 60, y: 120 })
    })

    it('doubleClick returns center coordinates when no relativePosition', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'doubleClick', ref: 'e1' })
      expect(result.success).toBe(true)
      expect(result.coordinates).toEqual({ x: 150, y: 120 })
    })

    it('rightClick returns coordinates at relativePosition offset', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'rightClick', ref: 'e1', relativePosition: { x: 5, y: 15 } })
      expect(result.success).toBe(true)
      expect(result.coordinates).toEqual({ x: 55, y: 115 })
    })

    it('rightClick returns center coordinates when no relativePosition', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'rightClick', ref: 'e1' })
      expect(result.success).toBe(true)
      expect(result.coordinates).toEqual({ x: 150, y: 120 })
    })
  })

  describe('execute — delay', () => {
    it('calls page.waitForTimeout with action.ms', async () => {
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'delay', ms: 1500 })
      expect(result.success).toBe(true)
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(1500)
    })
  })

  describe('execute — waitForUrl', () => {
    it('calls page.waitForURL with explicit 30s timeout', async () => {
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'waitForUrl', pattern: '**/dashboard**' })
      expect(result.success).toBe(true)
      expect(mockPage.waitForURL).toHaveBeenCalledWith('**/dashboard**', { timeout: 30_000 })
    })

    it('returns success:false with helpful error message on timeout', async () => {
      mockPage.waitForURL.mockRejectedValueOnce(new Error('Timeout 30000ms exceeded'))
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'waitForUrl', pattern: '/dashboard' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('URL pattern "/dashboard"')
      expect(result.error).toContain('**')
    })
  })

  describe('execute — fileUpload', () => {
    it('calls locator.setInputFiles after verifying files exist', async () => {
      vi.doMock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(true) }))
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'fileUpload', ref: 'e1', files: ['/tmp/test.pdf'] })
      expect(result.success).toBe(true)
      const locator = mockPage.getByRole()
      expect(locator.setInputFiles).toHaveBeenCalledWith(['/tmp/test.pdf'])
    })

    it('returns error if file does not exist', async () => {
      vi.doMock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }))
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'fileUpload', ref: 'e1', files: ['/missing/file.pdf'] })
      expect(result.success).toBe(false)
      expect(result.error).toContain('File not found')
      expect(result.error).toContain('/missing/file.pdf')
    })
  })

  describe('execute — copy', () => {
    it('reads textContent, calls page.evaluate with clipboard.writeText, returns copied data', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'copy', ref: 'e1' })
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ copied: 'hello world' })
      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.stringContaining('navigator.clipboard.writeText'))
    })

    it('coalesces null textContent to empty string (Pitfall 5)', async () => {
      const locator = mockPage.getByRole()
      locator.textContent.mockResolvedValueOnce(null)
      await adapter.setup({ platform: 'web' })
      await adapter.observe()
      const result = await adapter.execute({ type: 'copy', ref: 'e1' })
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ copied: '' })
    })
  })

})
