import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import { WebPlatformAdapter } from '../adapter.js'

// The fill compound re-reads via inputValue() after typing — the mock echoes the
// last filled value back so replace-mode fills verify green.
let lastFilledValue = ''
const mockClickFn = vi.fn().mockResolvedValue(undefined)
const mockFillFn = vi.fn().mockImplementation((v: string) => { lastFilledValue = v; return Promise.resolve() })
const mockInputValueFn = vi.fn().mockImplementation(() => Promise.resolve(lastFilledValue))
const mockGetAttributeFn = vi.fn().mockResolvedValue(null)
const mockPressFn = vi.fn().mockResolvedValue(undefined)
const mockPressSequentiallyFn = vi.fn().mockImplementation((v: string) => { lastFilledValue += v; return Promise.resolve() })
const mockSelectOptionFn = vi.fn().mockResolvedValue(undefined)
const mockHoverFn = vi.fn().mockResolvedValue(undefined)
const mockLocatorEvaluateFn = vi.fn().mockResolvedValue(undefined)
const mockNthFn = vi.fn().mockReturnThis()

// An ai-mode snapshot: every line carries Playwright's native [ref=eN].
const REALISTIC_ARIA_TREE = [
  '- navigation "Main Nav" [ref=e1]',
  '  - link "Home" [ref=e2]',
  '  - link "About" [ref=e3]',
  '  - link "Contact" [ref=e4]',
  '- heading "Welcome to Example" [level=1] [ref=e5]',
  '- region "Content" [ref=e6]',
  '  - textbox "Email" [ref=e7]',
  '  - textbox "Password" [ref=e8]',
  '  - button "Sign In" [ref=e9]',
  '  - link "Forgot password?" [ref=e10]',
  '- heading "Features" [level=2] [ref=e11]',
  '  - listitem "Fast performance" [ref=e12]',
  '  - listitem "Easy to use" [ref=e13]',
].join('\n')

const mockLocatorBoundingBoxFn = vi.fn().mockResolvedValue(null)

function createMockLocator() {
  return {
    click: mockClickFn,
    fill: mockFillFn,
    inputValue: mockInputValueFn,
    getAttribute: mockGetAttributeFn,
    press: mockPressFn,
    pressSequentially: mockPressSequentiallyFn,
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
// page.locator('aria-ref=eN'): the observed element's locator.
const mockAriaRefLocatorFn = vi.fn().mockReturnValue(createMockLocator())

// ':root' answers the ai snapshot (observe and the pre-dispatch binding check); any other
// selector is an aria-ref locator.
function pageLocator(selector: string) {
  return selector === ':root' ? { ariaSnapshot: mockAriaSnapshotFn } : mockAriaRefLocatorFn(selector)
}

// The observation's document handle: still the page's document, disposable.
function documentHandle() {
  return { evaluate: vi.fn().mockResolvedValue(true), dispose: vi.fn().mockResolvedValue(undefined) }
}

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
  locator: vi.fn(pageLocator),
  evaluateHandle: vi.fn(async () => documentHandle()),
  on: vi.fn(),
  url: vi.fn().mockReturnValue('https://example.com'),
  viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
  getByText: vi.fn().mockReturnValue({
    first: () => ({ scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined) }),
  }),
}

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
  addInitScript: vi.fn().mockResolvedValue(undefined),
  pages: vi.fn().mockReturnValue([mockPage]),
  grantPermissions: vi.fn().mockResolvedValue(undefined),
  exposeBinding: vi.fn().mockResolvedValue(undefined),
  setDefaultNavigationTimeout: vi.fn(),
  on: vi.fn(),
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
    mockPage.locator.mockImplementation(pageLocator)
    mockPage.url.mockReturnValue('https://example.com')
    mockAriaRefLocatorFn.mockReturnValue(createMockLocator())
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
    lastFilledValue = ''
    mockFillFn.mockImplementation((v: string) => { lastFilledValue = v; return Promise.resolve() })
    mockInputValueFn.mockImplementation(() => Promise.resolve(lastFilledValue))
    mockGetAttributeFn.mockResolvedValue(null)
    mockPressFn.mockResolvedValue(undefined)
    mockPressSequentiallyFn.mockImplementation((v: string) => { lastFilledValue += v; return Promise.resolve() })
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

    // schema v2 refMap lives at state.refMap (geometry only); it is present but empty
    // here because the mocked aria-ref locators answer no element handle to enrich into bounds.
    expect(state.refMap).toBeDefined()

    // The native binding — one entry per observed element, keyed by the minted ref, holding
    // the snapshot's native ref and the observed role and exact name.
    const lastRefs = adapter['lastRefs']
    expect(Object.keys(lastRefs).length).toBe(state.elements.length)
    for (const el of state.elements) {
      expect(lastRefs[el.ref]).toBeDefined()
      expect(lastRefs[el.ref].role).toBe(el.role)
      expect(lastRefs[el.ref].name).toBe(el.name)
      expect(lastRefs[el.ref].nativeRef).toMatch(/^e\d+$/)
    }
  })

  it('execute fill action calls locator.fill()', async () => {
    await adapter.setup({ platform: 'web' })
    const state = await adapter.observe()

    // Find a textbox element
    const textbox = state.elements.find(e => e.role === 'textbox')
    expect(textbox).toBeDefined()

    const result = await adapter.execute({ type: 'fill', ref: textbox!.ref, text: 'test@example.com', clearMode: 'replace', submit: false })
    expect(result.success).toBe(true)
    expect(mockFillFn).toHaveBeenCalledWith('test@example.com')
  })

  it('execute navigate action calls page.goto()', async () => {
    await adapter.setup({ platform: 'web' })

    const result = await adapter.execute({ type: 'navigate', to: 'url', url: 'https://other.com' })
    expect(result.success).toBe(true)
    expect(mockGotoFn).toHaveBeenCalledWith('https://other.com', { waitUntil: 'domcontentloaded' })
  })

  it('direction scroll without ref wheel-scrolls a page-sized step and rides scrollUntilVisible metadata', async () => {
    await adapter.setup({ platform: 'web' })

    const result = await adapter.execute({ type: 'scroll', mode: 'direction', direction: 'down', amount: 'page', retryOpposite: false })
    expect(result.success).toBe(true)
    // page-sized vertical step = viewport height (720 in the mock); down = positive dy
    expect(mockMouseWheelFn).toHaveBeenCalledWith(0, 720)
    expect(result.metadata?.scrollUntilVisible).toBeDefined()
  })

  it('direction scroll with a container ref scrolls inside the resolver\'s role locator, not mouse.wheel', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    mockMouseMoveFn.mockClear()
    mockMouseWheelFn.mockClear()
    mockAriaRefLocatorFn.mockClear()
    mockLocatorEvaluateFn.mockClear()
    const located = { ...createMockLocator(), count: vi.fn().mockResolvedValue(1) }
    located.nth = vi.fn().mockReturnValue(located)
    mockAriaRefLocatorFn.mockReturnValue(located)
    mockLocatorEvaluateFn.mockResolvedValue({ bounds: null, scrolledContainer: 'element', scrolled: true, offsets: { before: 0, after: 720, max: 2000 } })
    adapter['lastRefs']['e1'] = { nativeRef: 'e12', role: 'listitem', name: 'Item 1' }

    const result = await adapter.execute({ type: 'scroll', mode: 'direction', direction: 'down', amount: 'page', retryOpposite: false, ref: asRef('e1') })

    expect(result.success).toBe(true)
    // container scroll resolves the ref through ElementResolver to the observed element's
    // aria-ref locator, never a position, and runs inside that element
    expect(mockAriaRefLocatorFn).toHaveBeenCalledWith('aria-ref=e12')
    expect(located.nth).not.toHaveBeenCalled()
    const scrollCall = mockLocatorEvaluateFn.mock.calls.find((call: unknown[]) => typeof call[0] === 'function')
    expect(scrollCall).toBeDefined()
    expect(scrollCall![1]).toEqual([0, 720, 'vertical'])
    expect(mockMouseMoveFn).not.toHaveBeenCalled()
    expect(mockMouseWheelFn).not.toHaveBeenCalled()
  })

  it('halfPage direction scroll wheel-scrolls a half-viewport step', async () => {
    await adapter.setup({ platform: 'web' })
    mockMouseWheelFn.mockClear()

    const result = await adapter.execute({ type: 'scroll', mode: 'direction', direction: 'up', amount: 'halfPage', retryOpposite: false })
    expect(result.success).toBe(true)
    // up = negative dy; half of viewport height 720 = 360
    expect(mockMouseWheelFn).toHaveBeenCalledWith(0, -360)
  })

  it('untilVisible scroll rides scrollUntilVisible metadata with its key set and leaves lastRefs untouched', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()
    const refsBefore = { ...adapter['lastRefs'] }

    const result = await adapter.execute({
      type: 'scroll', mode: 'untilVisible', text: 'Nonexistent Target', direction: 'down', maxSwipes: 2, retryOpposite: true,
    })

    expect(result.success).toBe(true)
    const meta = result.metadata?.scrollUntilVisible as { swipes: number; reversedOnce: boolean; outcome: string; endedBy: string } | undefined
    expect(meta).toBeDefined()
    expect(typeof meta!.swipes).toBe('number')
    expect(typeof meta!.reversedOnce).toBe('boolean')
    // The mock page reports no offsets, so nothing proves movement or a boundary: both directions
    // use their budget and the search stays unresolved.
    expect(meta).toEqual({ swipes: 4, reversedOnce: true, outcome: 'unresolved', endedBy: 'max-swipes' })
    // the light probe never re-mints refs
    expect(adapter['lastRefs']).toEqual(refsBefore)
  })

  it('direction scroll without ref does not surface a legacy data block', async () => {
    await adapter.setup({ platform: 'web' })

    const result = await adapter.execute({ type: 'scroll', mode: 'direction', direction: 'down', amount: 'page', retryOpposite: false })
    expect(result.data).toBeUndefined()
  })

  it('execute error handling wraps errors in ActionResult', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    // Make click throw
    mockClickFn.mockRejectedValueOnce(new Error('Element detached'))

    const signIn = adapter['lastRefs']
    const firstRef = Object.keys(signIn)[0]
    const result = await adapter.execute({ type: 'click', ref: asRef(firstRef) })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Element detached')
  })

  it('action validation: fill on button returns validation error', async () => {
    await adapter.setup({ platform: 'web' })
    await adapter.observe()

    // Find a button element
    const button = (await adapter.observe()).elements.find(e => e.role === 'button')
    expect(button).toBeDefined()

    const result = await adapter.execute({ type: 'fill', ref: button!.ref, text: 'text', clearMode: 'replace', submit: false })
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
    const fillResult = await adapter.execute({ type: 'fill', ref: textbox1!.ref, text: 'hello', clearMode: 'replace', submit: false })
    expect(fillResult.success).toBe(true)

    // Change ARIA tree for second observation (and the binding check that follows it)
    mockAriaSnapshotFn.mockResolvedValue([
      '- heading "Updated Page" [level=1] [ref=e14]',
      '- button "Submit" [ref=e15]',
      '- textbox "Search" [ref=e16]',
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
        version: 2,
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

  describe('keypress', () => {
    const originalPlatform = process.platform

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    it('presses a single key from keys array', async () => {
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Enter'], mode: 'press' })
      expect(result.success).toBe(true)
      expect(mockKeyPressFn).toHaveBeenCalledTimes(1)
      expect(mockKeyPressFn).toHaveBeenCalledWith('Enter')
    })

    it('iterates multiple keys in order', async () => {
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Tab', 'Enter'], mode: 'press' })
      expect(result.success).toBe(true)
      expect(mockKeyPressFn).toHaveBeenCalledTimes(2)
      expect(mockKeyPressFn).toHaveBeenNthCalledWith(1, 'Tab')
      expect(mockKeyPressFn).toHaveBeenNthCalledWith(2, 'Enter')
    })

    it('converts Meta → Control on non-Mac when convertPlatformKeys is default (undefined/true)', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Meta+k'], mode: 'press' })
      expect(result.success).toBe(true)
      expect(mockKeyPressFn).toHaveBeenCalledWith('Control+k')
    })

    it('leaves Meta alone on Mac', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Meta+k'], mode: 'press' })
      expect(result.success).toBe(true)
      expect(mockKeyPressFn).toHaveBeenCalledWith('Meta+k')
    })

    it('leaves Meta alone on non-Mac when convertPlatformKeys=false', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Meta+k'], mode: 'press', convertPlatformKeys: false })
      expect(result.success).toBe(true)
      expect(mockKeyPressFn).toHaveBeenCalledWith('Meta+k')
    })

    it('applies conversion to each entry in a multi-key array', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      await adapter.setup({ platform: 'web' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Meta+k', 'Enter', 'Shift+Meta+T'], mode: 'press' })
      expect(result.success).toBe(true)
      expect(mockKeyPressFn).toHaveBeenCalledTimes(3)
      expect(mockKeyPressFn).toHaveBeenNthCalledWith(1, 'Control+k')
      expect(mockKeyPressFn).toHaveBeenNthCalledWith(2, 'Enter')
      expect(mockKeyPressFn).toHaveBeenNthCalledWith(3, 'Shift+Control+T')
    })
  })
})
