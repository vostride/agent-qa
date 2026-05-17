import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebPlatformAdapter } from '../adapter.js'

const mockClickFn = vi.fn().mockResolvedValue(undefined)
const mockFillFn = vi.fn().mockResolvedValue(undefined)
const mockSelectOptionFn = vi.fn().mockResolvedValue(undefined)
const mockHoverFn = vi.fn().mockResolvedValue(undefined)
const mockLocatorEvaluateFn = vi.fn().mockResolvedValue(undefined)
const mockNthFn = vi.fn().mockReturnThis()

const REALISTIC_ARIA_TREE = [
  '- navigation "Main Nav"',
  '  - link "Home"',
  '  - link "About"',
  '  - link "Contact"',
  '- heading "Welcome to Example" [level=1]',
  '- region "Content"',
  '  - textbox "Email"',
  '  - textbox "Password"',
  '  - button "Sign In"',
  '  - link "Forgot password?"',
  '- heading "Features" [level=2]',
  '  - listitem "Fast performance"',
  '  - listitem "Easy to use"',
].join('\n')

const mockLocatorBoundingBoxFn = vi.fn().mockResolvedValue(null)

function createMockLocator() {
  return {
    click: mockClickFn,
    fill: mockFillFn,
    selectOption: mockSelectOptionFn,
    hover: mockHoverFn,
    evaluate: mockLocatorEvaluateFn,
    nth: mockNthFn,
    boundingBox: mockLocatorBoundingBoxFn,
  }
}

const mockGotoFn = vi.fn().mockResolvedValue(undefined)
const mockKeyPressFn = vi.fn().mockResolvedValue(undefined)
const mockWaitForSelectorFn = vi.fn().mockResolvedValue(undefined)
const mockPageEvaluateFn = vi.fn().mockResolvedValue(undefined)
const mockScreenshotFn = vi.fn().mockResolvedValue(Buffer.from('fake-screenshot'))
const mockWaitForLoadStateFn = vi.fn().mockResolvedValue(undefined)
const mockPageCloseFn = vi.fn().mockResolvedValue(undefined)
const mockAriaSnapshotFn = vi.fn().mockResolvedValue(REALISTIC_ARIA_TREE)
const mockGetByRoleFn = vi.fn().mockReturnValue(createMockLocator())

const mockMouseMoveFn = vi.fn().mockResolvedValue(undefined)
const mockMouseWheelFn = vi.fn().mockResolvedValue(undefined)
const mockMouseClickFn = vi.fn().mockResolvedValue(undefined)

const mockPage = {
  goto: mockGotoFn,
  keyboard: { press: mockKeyPressFn },
  mouse: { move: mockMouseMoveFn, wheel: mockMouseWheelFn, click: mockMouseClickFn },
  waitForSelector: mockWaitForSelectorFn,
  evaluate: mockPageEvaluateFn,
  screenshot: mockScreenshotFn,
  addInitScript: vi.fn().mockResolvedValue(undefined),
  video: vi.fn().mockReturnValue(null),
  waitForLoadState: mockWaitForLoadStateFn,
  close: mockPageCloseFn,
  locator: vi.fn().mockReturnValue({
    ariaSnapshot: mockAriaSnapshotFn,
  }),
  on: vi.fn(),
  url: vi.fn().mockReturnValue('https://example.com'),
  viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
  getByRole: mockGetByRoleFn,
}

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
  addInitScript: vi.fn().mockResolvedValue(undefined),
  pages: vi.fn().mockReturnValue([mockPage]),
  grantPermissions: vi.fn().mockResolvedValue(undefined),
}

const mockBrowserCloseFn = vi.fn().mockResolvedValue(undefined)
const mockBrowser = {
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: mockBrowserCloseFn,
  on: vi.fn(),
}

const mockChromiumLaunch = vi.fn().mockResolvedValue(mockBrowser)
const mockFirefoxLaunch = vi.fn().mockResolvedValue(mockBrowser)
const mockWebkitLaunch = vi.fn().mockResolvedValue(mockBrowser)

vi.mock('playwright-core', () => ({
  chromium: { launch: mockChromiumLaunch },
  firefox: { launch: mockFirefoxLaunch },
  webkit: { launch: mockWebkitLaunch },
}))

describe('Integration: WebPlatformAdapter lifecycle', () => {
  let adapter: WebPlatformAdapter

  beforeEach(() => {
    adapter = new WebPlatformAdapter()
    vi.clearAllMocks()
    // Re-wire mocks after clearAllMocks
    mockAriaSnapshotFn.mockResolvedValue(REALISTIC_ARIA_TREE)
    mockPage.locator.mockReturnValue({ ariaSnapshot: mockAriaSnapshotFn })
    mockPage.url.mockReturnValue('https://example.com')
    mockGetByRoleFn.mockReturnValue(createMockLocator())
    mockNthFn.mockReturnThis()
    mockChromiumLaunch.mockResolvedValue(mockBrowser)
    mockFirefoxLaunch.mockResolvedValue(mockBrowser)
    mockWebkitLaunch.mockResolvedValue(mockBrowser)
    mockBrowser.newContext.mockResolvedValue(mockContext)
    mockContext.newPage.mockResolvedValue(mockPage)
    mockPageEvaluateFn.mockResolvedValue(undefined)
    mockGotoFn.mockResolvedValue(undefined)
    mockKeyPressFn.mockResolvedValue(undefined)
    mockClickFn.mockResolvedValue(undefined)
    mockFillFn.mockResolvedValue(undefined)
    mockSelectOptionFn.mockResolvedValue(undefined)
    mockHoverFn.mockResolvedValue(undefined)
    mockScreenshotFn.mockResolvedValue(Buffer.from('fake-screenshot'))
    mockWaitForLoadStateFn.mockResolvedValue(undefined)
    mockBrowserCloseFn.mockResolvedValue(undefined)
    mockLocatorBoundingBoxFn.mockResolvedValue(null)
  })

  afterEach(async () => {
    try { await adapter.cleanup() } catch { /* already cleaned */ }
  })

  it('full lifecycle: setup → observe → execute(click) → cleanup', async () => {
    await adapter.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })

    // Verify browser launched with chromium
    expect(mockChromiumLaunch).toHaveBeenCalledWith({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    })

    // Observe
    const state = await adapter.observe()
    expect(state.tree).toContain('navigation')
    expect(state.tree).toContain('button')
    expect(state.elements.length).toBeGreaterThan(0)
    expect(state.url).toBe('https://example.com')

    // Find the Sign In button ref
    const signInElement = state.elements.find(e => e.role === 'button' && e.name === 'Sign In')
    expect(signInElement).toBeDefined()

    // Execute click
    const result = await adapter.execute({ type: 'click', ref: signInElement!.ref })
    expect(result.success).toBe(true)
    expect(mockClickFn).toHaveBeenCalled()

    // Cleanup
    await adapter.cleanup()
    expect(mockBrowserCloseFn).toHaveBeenCalled()
  })

  it('setup with firefox config launches firefox', async () => {
    await adapter.setup({ platform: 'web', browser: { name: 'firefox', headless: true } })

    expect(mockFirefoxLaunch).toHaveBeenCalledWith({ headless: true })
    expect(mockChromiumLaunch).not.toHaveBeenCalled()
    expect(mockWebkitLaunch).not.toHaveBeenCalled()
  })

  it('setup with webkit config launches webkit', async () => {
    await adapter.setup({ platform: 'web', browser: { name: 'webkit', headless: true } })

    expect(mockWebkitLaunch).toHaveBeenCalledWith({ headless: true })
    expect(mockChromiumLaunch).not.toHaveBeenCalled()
    expect(mockFirefoxLaunch).not.toHaveBeenCalled()
  })

  it('observe returns valid ScreenState with elements and refs', async () => {
    await adapter.setup({ platform: 'web' })

    const state = await adapter.observe()

    // ARIA tree is enhanced with refs
    expect(state.tree).toContain('[ref=')

    // elements array has ElementInfo objects
    expect(state.elements.length).toBeGreaterThan(5)
    for (const el of state.elements) {
      expect(el.ref).toMatch(/^e\d+$/)
      expect(typeof el.role).toBe('string')
      expect(typeof el.name).toBe('string')
    }

    // url matches
    expect(state.url).toBe('https://example.com')

    // timestamp is a number
    expect(typeof state.timestamp).toBe('number')

    // metadata.refMap exists
    expect(state.metadata.refMap).toBeDefined()
    const refMap = state.metadata.refMap as Record<string, any>
    expect(Object.keys(refMap).length).toBeGreaterThan(0)
  })

  it('execute fill action calls locator.fill()', async () => {
    await adapter.setup({ platform: 'web' })
    const state = await adapter.observe()

    // Find a textbox element
    const textbox = state.elements.find(e => e.role === 'textbox')
    expect(textbox).toBeDefined()

    const result = await adapter.execute({ type: 'fill', ref: textbox!.ref, value: 'test@example.com' })
    expect(result.success).toBe(true)
    expect(mockFillFn).toHaveBeenCalledWith('test@example.com')
  })

  it('execute navigate action calls page.goto()', async () => {
    await adapter.setup({ platform: 'web' })

    const result = await adapter.execute({ type: 'navigate', url: 'https://other.com' })
    expect(result.success).toBe(true)
    expect(mockGotoFn).toHaveBeenCalledWith('https://other.com', { waitUntil: 'domcontentloaded' })
  })

  it('execute scroll action without ref calls page.mouse.wheel()', async () => {
    await adapter.setup({ platform: 'web' })

    const result = await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: 300 })
    expect(result.success).toBe(true)
    expect(mockMouseWheelFn).toHaveBeenCalledWith(0, 300)
    expect(result.coordinates).toBeUndefined()
    expect(result.boundingBox).toBeUndefined()
  })

  it('scroll with ref uses page.evaluate with ancestor walking', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    mockPageEvaluateFn.mockClear()
    mockMouseMoveFn.mockClear()
    mockMouseWheelFn.mockClear()
    mockPageEvaluateFn.mockResolvedValueOnce({ bounds: null, scrolledContainer: 'notFound', scrolled: true })
    mockPageEvaluateFn.mockResolvedValueOnce('raf')

    const firstRef = Object.keys(adapter['lastRefs'])[0]
    const result = await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: 500, ref: firstRef })

    expect(result.success).toBe(true)
    expect(mockPageEvaluateFn).toHaveBeenCalled()
    expect(mockMouseMoveFn).not.toHaveBeenCalled()
    expect(mockMouseWheelFn).not.toHaveBeenCalled()
  })

  it('scroll with ref always uses page.evaluate regardless of cached bounds', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    mockLocatorBoundingBoxFn.mockResolvedValue(null)
    adapter['lastRefs']['e1'] = { role: 'region', name: 'Content', bounds: { x: 10, y: 20, width: 100, height: 200 } }
    mockMouseMoveFn.mockClear()
    mockMouseWheelFn.mockClear()
    mockPageEvaluateFn.mockClear()
    mockPageEvaluateFn.mockResolvedValueOnce({ bounds: null, scrolledContainer: 'notFound', scrolled: true })
    mockPageEvaluateFn.mockResolvedValueOnce('raf')

    const result = await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: 300, ref: 'e1' })

    expect(result.success).toBe(true)
    expect(mockPageEvaluateFn).toHaveBeenCalled()
    expect(mockMouseMoveFn).not.toHaveBeenCalled()
    expect(mockMouseWheelFn).not.toHaveBeenCalled()
  })

  it('scroll with ref when refData has no bounds still uses page.evaluate', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    mockLocatorBoundingBoxFn.mockResolvedValue(null)
    adapter['lastRefs']['e1'] = { role: 'region', name: 'Content' }
    mockMouseMoveFn.mockClear()
    mockMouseWheelFn.mockClear()
    mockPageEvaluateFn.mockClear()
    mockPageEvaluateFn.mockResolvedValueOnce({ bounds: null, scrolledContainer: 'notFound', scrolled: true })
    mockPageEvaluateFn.mockResolvedValueOnce('raf')

    const result = await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: 400, ref: 'e1' })

    expect(result.success).toBe(true)
    expect(mockPageEvaluateFn).toHaveBeenCalled()
    expect(mockMouseWheelFn).not.toHaveBeenCalled()
    expect(result.coordinates).toBeUndefined()
  })

  it('scroll with ref passes correct arguments to page.evaluate for ancestor walking', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    mockPageEvaluateFn.mockClear()
    mockPageEvaluateFn.mockResolvedValueOnce({ bounds: null, scrolledContainer: 'notFound', scrolled: true })
    mockPageEvaluateFn.mockResolvedValueOnce('raf')
    adapter['lastRefs']['e1'] = { role: 'listitem', name: 'Item 1', nth: 0 }

    await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: 600, ref: 'e1' })

    const evaluateCall = mockPageEvaluateFn.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'function' && Array.isArray(call[1])
    )
    expect(evaluateCall).toBeDefined()
    const args = evaluateCall![1] as unknown[]
    expect(args[0]).toBe('listitem')
    expect(args[1]).toBe('Item 1')
    expect(args[2]).toBe(0)
    expect(args[3]).toBe(0)
    expect(args[4]).toBe(600)
    expect(args[5]).toBe('vertical')
  })

  it('scroll with ref returns bounds from page.evaluate result', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    const fakeBounds = { x: 50, y: 100, width: 200, height: 40 }
    mockPageEvaluateFn.mockResolvedValueOnce({ bounds: fakeBounds, scrolledContainer: 'ancestor', scrolled: true })
    mockPageEvaluateFn.mockResolvedValueOnce('raf')
    adapter['lastRefs']['e1'] = { role: 'listitem', name: 'Item 1' }

    const result = await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: 500, ref: 'e1' })

    expect(result.success).toBe(true)
    expect(result.coordinates).toEqual({ x: 150, y: 120 })
    expect(result.boundingBox).toEqual(fakeBounds)
  })

  it('scroll with ref returns diagnostic scrolledContainer field', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    mockPageEvaluateFn.mockResolvedValueOnce({ bounds: null, scrolledContainer: 'notFound', scrolled: true })
    mockPageEvaluateFn.mockResolvedValueOnce('raf')
    adapter['lastRefs']['e1'] = { role: 'listitem', name: 'Nonexistent' }

    const result = await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: 300, ref: 'e1' })

    expect(result.success).toBe(true)
    expect(result.coordinates).toBeUndefined()
    expect(result.boundingBox).toBeUndefined()
  })

  it('scroll with ref uses function-argument evaluate, not string template', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    mockPageEvaluateFn.mockClear()
    mockPageEvaluateFn.mockResolvedValueOnce({ bounds: null, scrolledContainer: 'notFound', scrolled: true })
    mockPageEvaluateFn.mockResolvedValueOnce('raf')
    adapter['lastRefs']['e1'] = { role: 'button', name: 'Submit' }

    await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: 200, ref: 'e1' })

    const scrollCall = mockPageEvaluateFn.mock.calls.find(
      (call: unknown[]) => Array.isArray(call[1])
    )
    expect(scrollCall).toBeDefined()
    expect(typeof scrollCall![0]).toBe('function')
  })

  it('scroll with ref surfaces scrolled and scrolledContainer in ActionResult.data', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    const fakeBounds = { x: 50, y: 100, width: 200, height: 40 }
    mockPageEvaluateFn.mockResolvedValueOnce({ bounds: fakeBounds, scrolledContainer: 'ancestor', scrolled: true })
    mockPageEvaluateFn.mockResolvedValueOnce('raf')
    adapter['lastRefs']['e1'] = { role: 'listitem', name: 'Item 1' }

    const result = await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: 500, ref: 'e1' })

    expect(result.data).toEqual({ scrolled: true, scrolledContainer: 'ancestor' })
  })

  it('scroll with ref at boundary returns scrolled false in ActionResult.data', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    mockPageEvaluateFn.mockResolvedValueOnce({ bounds: { x: 10, y: -50, width: 100, height: 30 }, scrolledContainer: 'ancestor', scrolled: false })
    mockPageEvaluateFn.mockResolvedValueOnce('raf')
    adapter['lastRefs']['e1'] = { role: 'listitem', name: 'Item 1' }

    const result = await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: 500, ref: 'e1' })

    expect(result.data).toEqual({ scrolled: false, scrolledContainer: 'ancestor' })
  })

  it('scroll without ref does not include scroll data in ActionResult', async () => {
    await adapter.setup({ platform: 'web' })

    const result = await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: 300 })
    expect(result.data).toBeUndefined()
  })

  it('execute error handling wraps errors in ActionResult', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    // Make click throw
    mockClickFn.mockRejectedValueOnce(new Error('Element detached'))

    const signIn = adapter['lastRefs']
    const firstRef = Object.keys(signIn)[0]
    const result = await adapter.execute({ type: 'click', ref: firstRef })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Element detached')
  })

  it('execute mobile actions returns rejection', async () => {
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

  it('action validation: fill on button returns validation error', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    // Find a button element
    const button = (await adapter.observe()).elements.find(e => e.role === 'button')
    expect(button).toBeDefined()

    const result = await adapter.execute({ type: 'fill', ref: button!.ref, value: 'text' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('not fillable')
  })

  it('multiple observe-execute cycles update refs between observations', async () => {
    await adapter.setup({ platform: 'web' })

    // First observation
    const state1 = await adapter.observe()
    const textbox1 = state1.elements.find(e => e.role === 'textbox')
    expect(textbox1).toBeDefined()

    // Execute fill on first observation's ref
    const fillResult = await adapter.execute({ type: 'fill', ref: textbox1!.ref, value: 'hello' })
    expect(fillResult.success).toBe(true)

    // Change ARIA tree for second observation
    mockAriaSnapshotFn.mockResolvedValueOnce([
      '- heading "Updated Page" [level=1]',
      '- button "Submit"',
      '- textbox "Search"',
    ].join('\n'))

    // Second observation — refs regenerated
    const state2 = await adapter.observe()
    expect(state2.elements.find(e => e.name === 'Updated Page')).toBeDefined()

    // Execute click on second observation's ref
    const btn = state2.elements.find(e => e.role === 'button')
    expect(btn).toBeDefined()
    const clickResult = await adapter.execute({ type: 'click', ref: btn!.ref })
    expect(clickResult.success).toBe(true)
  })

  it('setup with viewport config passes viewport to browser context', async () => {
    const viewport = { width: 1920, height: 1080 }
    await adapter.setup({ platform: 'web', browser: { name: 'chromium', viewport } })

    expect(mockBrowser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: { width: 1920, height: 1080 } })
    )
  })

  it('setup with auth state passes storageState to browser context before page creation', async () => {
    await adapter.setup({
      platform: 'web',
      browser: { name: 'chromium' },
      authState: {
        version: 1,
        kind: 'web',
        targetName: 'staging-web',
        stateName: 'admin',
        capturedAt: '2026-05-17T00:00:00.000Z',
        storageStatePath: '/tmp/internal/admin.json',
      },
    })

    expect(mockBrowser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ storageState: '/tmp/internal/admin.json' })
    )
    expect(mockBrowser.newContext.mock.invocationCallOrder[0]).toBeLessThan(
      mockContext.newPage.mock.invocationCallOrder[0]
    )
  })

  describe('keypress (phase 137)', () => {
    const originalPlatform = process.platform

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    it('presses a single key from keys array', async () => {
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Enter'] })
      expect(result.success).toBe(true)
      expect(mockKeyPressFn).toHaveBeenCalledTimes(1)
      expect(mockKeyPressFn).toHaveBeenCalledWith('Enter')
    })

    it('iterates multiple keys in order', async () => {
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Tab', 'Enter'] })
      expect(result.success).toBe(true)
      expect(mockKeyPressFn).toHaveBeenCalledTimes(2)
      expect(mockKeyPressFn).toHaveBeenNthCalledWith(1, 'Tab')
      expect(mockKeyPressFn).toHaveBeenNthCalledWith(2, 'Enter')
    })

    it('converts Meta → Control on non-Mac when convertPlatformKeys is default (undefined/true)', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Meta+k'] })
      expect(result.success).toBe(true)
      expect(mockKeyPressFn).toHaveBeenCalledWith('Control+k')
    })

    it('leaves Meta alone on Mac', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Meta+k'] })
      expect(result.success).toBe(true)
      expect(mockKeyPressFn).toHaveBeenCalledWith('Meta+k')
    })

    it('leaves Meta alone on non-Mac when convertPlatformKeys=false', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Meta+k'], convertPlatformKeys: false })
      expect(result.success).toBe(true)
      expect(mockKeyPressFn).toHaveBeenCalledWith('Meta+k')
    })

    it('applies conversion to each entry in a multi-key array', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Meta+k', 'Enter', 'Shift+Meta+T'] })
      expect(result.success).toBe(true)
      expect(mockKeyPressFn).toHaveBeenCalledTimes(3)
      expect(mockKeyPressFn).toHaveBeenNthCalledWith(1, 'Control+k')
      expect(mockKeyPressFn).toHaveBeenNthCalledWith(2, 'Enter')
      expect(mockKeyPressFn).toHaveBeenNthCalledWith(3, 'Shift+Control+T')
    })
  })
})
