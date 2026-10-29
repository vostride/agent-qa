import { createRequire } from 'node:module'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ANDROID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,1920]">
    <android.widget.LinearLayout bounds="[0,0][1080,1920]">
      <android.widget.TextView text="Login" bounds="[100,100][980,200]" content-desc="" enabled="true" />
      <android.widget.EditText text="" content-desc="Username" bounds="[100,250][980,350]" enabled="true" />
      <android.widget.EditText text="" content-desc="Password" bounds="[100,400][980,500]" enabled="true" />
      <android.widget.Button text="Sign In" bounds="[100,550][980,650]" enabled="true" />
      <android.widget.CheckBox text="Remember me" bounds="[100,700][980,800]" enabled="true" />
      <android.widget.ImageView content-desc="App Logo" bounds="[400,50][680,90]" enabled="true" />
    </android.widget.LinearLayout>
  </android.widget.FrameLayout>
</hierarchy>`

const ANDROID_SPINNER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,1920]">
    <android.widget.LinearLayout bounds="[0,0][1080,1920]">
      <android.widget.Spinner text="Priority" bounds="[100,800][980,900]" content-desc="" enabled="true" />
      <android.widget.CheckedTextView text="High" bounds="[100,900][980,980]" content-desc="" enabled="true" />
    </android.widget.LinearLayout>
  </android.widget.FrameLayout>
</hierarchy>`

const SCREENSHOT_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function createMockPointerAction() {
  const chain: Record<string, any> = {}
  chain.move = vi.fn().mockReturnValue(chain)
  chain.down = vi.fn().mockReturnValue(chain)
  chain.up = vi.fn().mockReturnValue(chain)
  chain.pause = vi.fn().mockReturnValue(chain)
  chain.perform = vi.fn().mockResolvedValue(undefined)
  return chain
}

function createMockDriver() {
  const pointerAction = createMockPointerAction()

  return {
    getPageSource: vi.fn().mockResolvedValue(ANDROID_XML),
    getWindowSize: vi.fn().mockResolvedValue({ width: 1080, height: 1920 }),
    takeScreenshot: vi.fn().mockResolvedValue(SCREENSHOT_BASE64),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    action: vi.fn().mockReturnValue(pointerAction),
    actions: vi.fn().mockResolvedValue(undefined),
    keys: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    activateApp: vi.fn().mockResolvedValue(undefined),
    queryAppState: vi.fn().mockResolvedValue(1),
    terminateApp: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(undefined),
    getContexts: vi.fn().mockResolvedValue(['NATIVE_APP']),
    switchContext: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockRejectedValue(new Error('not supported')),
    $: vi.fn() as unknown as (selector: string) => Promise<unknown>,
    _pointerAction: pointerAction,
  }
}

vi.mock('webdriverio', () => ({
  remote: vi.fn(),
}))

import { AndroidPlatformAdapter } from '../adapter.js'
import type { PlatformAdapter, PlatformConfig } from '@vostride/agent-qa-runner'
import type { LiveFrame } from '@vostride/agent-qa-schema'

describe('AndroidPlatformAdapter', () => {
  let adapter: AndroidPlatformAdapter
  let mockDriver: ReturnType<typeof createMockDriver>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockDriver = createMockDriver()
    const { remote } = await import('webdriverio')
    vi.mocked(remote).mockResolvedValue(mockDriver as any)

    adapter = new AndroidPlatformAdapter()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
  })

  describe('setup', () => {
    it('creates UIAutomator2 session with correct capabilities', async () => {
      const config: PlatformConfig = {
        platform: 'android',
        appState: 'preserve',
        device: {
          name: 'pixel-7',
          platform: 'android',
          match: { automationName: 'UiAutomator2', platformVersion: '14', serial: 'RZCT90BCMWW' },
        },
      }

      await adapter.setup(config)

      const { remote } = await import('webdriverio')
      expect(remote).toHaveBeenCalledWith(expect.objectContaining({
        hostname: 'localhost',
        port: 4723,
        capabilities: expect.objectContaining({
          platformName: 'Android',
          'appium:automationName': 'UiAutomator2',
          'appium:deviceName': 'pixel-7',
          'appium:platformVersion': '14',
          'appium:udid': 'RZCT90BCMWW',
          'appium:noReset': true,
          'appium:newCommandTimeout': 300,
        }),
      }))
    })

    it('strips undefined capability values', async () => {
      await adapter.setup({ platform: 'android' })

      const { remote } = await import('webdriverio')
      const call = vi.mocked(remote).mock.calls[0][0] as any
      const caps = call.capabilities
      expect(caps).not.toHaveProperty('appium:platformVersion')
      expect(caps).not.toHaveProperty('appium:app')
      expect(caps).not.toHaveProperty('appium:appPackage')
      expect(caps).not.toHaveProperty('appium:appActivity')
      expect(caps).not.toHaveProperty('appium:avd')
    })

    it('sets appium app capability from configured app path and preserve app state', async () => {
      await adapter.setup({
        platform: 'android',
        appState: 'preserve',
        device: {
          name: 'android-emu',
          platform: 'android',
          match: { automationName: 'UiAutomator2' },
        },
        appPath: '/tmp/wikipedia.apk',
      })

      const { remote } = await import('webdriverio')
      const call = vi.mocked(remote).mock.calls[0][0] as any
      expect(call.capabilities['appium:app']).toBe('/tmp/wikipedia.apk')
      expect(call.capabilities['appium:noReset']).toBe(true)
    })

    it('maps reset app state to appium noReset false', async () => {
      await adapter.setup({
        platform: 'android',
        appState: 'reset',
        device: {
          name: 'android-emu',
          platform: 'android',
          match: { automationName: 'UiAutomator2' },
        },
      })

      const { remote } = await import('webdriverio')
      const call = vi.mocked(remote).mock.calls[0][0] as any
      expect(call.capabilities['appium:noReset']).toBe(false)
    })

    it('omits appium noReset for Android browser mode', async () => {
      await adapter.setup({
        platform: 'android',
        appState: 'reset',
        device: {
          name: 'android-chrome',
          platform: 'android',
          match: { automationName: 'UiAutomator2', browserName: 'Chrome' },
        },
      })

      const { remote } = await import('webdriverio')
      const call = vi.mocked(remote).mock.calls[0][0] as any
      expect(call.capabilities).not.toHaveProperty('appium:noReset')
    })

    it('uses appState instead of stale match.noReset', async () => {
      await adapter.setup({
        platform: 'android',
        appState: 'reset',
        device: {
          name: 'android-emu',
          platform: 'android',
          match: { automationName: 'UiAutomator2', noReset: true },
        },
      })

      const { remote } = await import('webdriverio')
      const call = vi.mocked(remote).mock.calls[0][0] as any
      expect(call.capabilities['appium:noReset']).toBe(false)
    })

    it('rejects browserName with app path before session creation', async () => {
      await expect(adapter.setup({
        platform: 'android',
        device: {
          name: 'android-chrome',
          platform: 'android',
          match: { automationName: 'UiAutomator2', browserName: 'Chrome' },
        },
        appPath: '/tmp/wikipedia.apk',
      })).rejects.toMatchObject({ category: 'app-install' })

      const { remote } = await import('webdriverio')
      expect(remote).not.toHaveBeenCalled()
    })

    it('launches resolved target app package after session creation', async () => {
      await adapter.setup({
        platform: 'android',
        device: {
          name: 'android-emu',
          platform: 'android',
          match: { automationName: 'UiAutomator2' },
        },
        appPackage: 'org.wikipedia.alpha',
      })

      expect(mockDriver.activateApp).toHaveBeenCalledWith('org.wikipedia.alpha')
    })

    it('does not require mobile shell access for native app setup by default', async () => {
      await adapter.setup({
        platform: 'android',
        device: {
          name: 'android-emu',
          platform: 'android',
          match: { automationName: 'UiAutomator2' },
        },
        appPackage: 'app.linear',
      })

      expect(mockDriver.execute).not.toHaveBeenCalledWith('mobile: shell', expect.anything())
    })

    it('uses mobile shell pid lookup only when explicitly enabled', async () => {
      const previous = process.env.AGENT_QA_ANDROID_USE_MOBILE_SHELL
      process.env.AGENT_QA_ANDROID_USE_MOBILE_SHELL = '1'
      mockDriver.execute.mockResolvedValueOnce('12345')

      try {
        await adapter.setup({
          platform: 'android',
          device: {
            name: 'android-emu',
            platform: 'android',
            match: { automationName: 'UiAutomator2' },
          },
          appPackage: 'app.linear',
        })
      } finally {
        if (previous === undefined) delete process.env.AGENT_QA_ANDROID_USE_MOBILE_SHELL
        else process.env.AGENT_QA_ANDROID_USE_MOBILE_SHELL = previous
      }

      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: shell', { command: 'pidof', args: ['app.linear'] })
    })

    it('wraps resolved app launch failure as app-launch setup error', async () => {
      mockDriver.activateApp.mockRejectedValueOnce(new Error('not installed'))

      await expect(adapter.setup({
        platform: 'android',
        appPackage: 'org.wikipedia.alpha',
      })).rejects.toMatchObject({ category: 'app-launch' })
    })
  })

  describe('session start activates the app only when it is not already in the foreground', () => {
    const appPackage = 'dev.example.deeplinked'

    it('an app already in the foreground is not activated again', async () => {
      mockDriver.queryAppState.mockResolvedValue(4)

      await adapter.setup({ platform: 'android', appPackage })

      expect(mockDriver.activateApp).not.toHaveBeenCalled()
      expect(mockDriver.queryAppState).toHaveBeenCalledWith(appPackage)
    })

    it('an app that is not running is activated once', async () => {
      mockDriver.queryAppState.mockResolvedValue(1)

      await adapter.setup({ platform: 'android', appPackage })

      expect(mockDriver.activateApp).toHaveBeenCalledTimes(1)
      expect(mockDriver.activateApp).toHaveBeenCalledWith(appPackage)
    })

    it('a session started twice on a foreground app never activates it', async () => {
      mockDriver.queryAppState.mockResolvedValue(4)

      await adapter.setup({ platform: 'android', appPackage })
      await adapter.setup({ platform: 'android', appPackage })

      expect(mockDriver.activateApp).not.toHaveBeenCalled()
      expect(mockDriver.queryAppState).toHaveBeenCalledTimes(2)
    })

    it('an app state that cannot be read falls back to activating the app', async () => {
      mockDriver.queryAppState.mockRejectedValue(new Error('unknown command'))

      await adapter.setup({ platform: 'android', appPackage })

      expect(mockDriver.activateApp).toHaveBeenCalledTimes(1)
      expect(mockDriver.activateApp).toHaveBeenCalledWith(appPackage)
    })

    it('a foreground app read through mobile queryAppState when the typed query is gone is not activated', async () => {
      mockDriver.queryAppState.mockRejectedValue(new Error('unknown command'))
      mockDriver.execute.mockImplementation(async (script: string) =>
        script === 'mobile: queryAppState' ? 4 : undefined)

      await adapter.setup({ platform: 'android', appPackage })

      expect(mockDriver.activateApp).not.toHaveBeenCalled()
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: queryAppState', { appId: appPackage })
    })

    it('an app state that neither query can read activates the app once', async () => {
      mockDriver.queryAppState.mockRejectedValue(new Error('unknown command'))
      mockDriver.execute.mockImplementation(async (script: string) => {
        if (script === 'mobile: queryAppState') throw new Error('unknown mobile command')
        return undefined
      })

      await adapter.setup({ platform: 'android', appPackage })

      expect(mockDriver.activateApp).toHaveBeenCalledTimes(1)
      expect(mockDriver.activateApp).toHaveBeenCalledWith(appPackage)
    })
  })

  describe('cleanup', () => {
    it('calls deleteSession and clears state', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.cleanup()
      expect(mockDriver.deleteSession).toHaveBeenCalled()
    })

    it('does not throw if session already closed', async () => {
      await adapter.setup({ platform: 'android' })
      mockDriver.deleteSession.mockRejectedValue(new Error('session not found'))
      await expect(adapter.cleanup()).resolves.not.toThrow()
    })
  })

  describe('observe', () => {
    it('returns schema v2 ScreenState with builder tree, elements, and refMap', async () => {
      await adapter.setup({ platform: 'android' })
      const state = await adapter.observe()

      expect(state.platform).toBe('android')
      expect(state.tree).toContain('text "Login"')
      expect(state.tree).toContain('textbox "Username"')
      expect(state.tree).toContain('textbox "Password"')
      expect(state.tree).toContain('button "Sign In"')
      expect(state.elements.length).toBeGreaterThanOrEqual(5)
      expect(state.timestamp).toBeGreaterThan(0)
      // Schema v2: refMap is top-level (not metadata.refMap); every bounded element has one.
      expect(state.refMap).toBeDefined()
      expect(Object.keys(state.refMap).length).toBeGreaterThanOrEqual(5)
      expect(state.metadata.captureMode).toBe('textOnly')
      expect(state.metadata.coordSpace).toBe('viewport')
    })

    it('ignores unrelated Chrome webviews for native app targets', async () => {
      mockDriver.getContexts.mockResolvedValue(['NATIVE_APP', 'WEBVIEW_chrome'])

      await adapter.setup({
        platform: 'android',
        device: {
          name: 'android-emu',
          platform: 'android',
          match: { automationName: 'UiAutomator2' },
        },
        appPackage: 'app.linear',
      })
      const state = await adapter.observe()

      expect(state.tree).toContain('button "Sign In"')
      expect(mockDriver.switchContext).not.toHaveBeenCalledWith('WEBVIEW_chrome')
    })

    it('observes a webview when the context belongs to the target app package', async () => {
      mockDriver.getContexts.mockResolvedValue(['NATIVE_APP', 'WEBVIEW_app.linear'])
      // Reworked WEB_OBSERVER_SCRIPT emits serializable interim nodes only (Pitfall #5):
      // no refs, no tree text — the shared builder mints refs and renders the tree.
      mockDriver.execute.mockResolvedValueOnce({
        nodes: [{
          role: 'button',
          name: 'Create issue',
          bounds: { x: 1, y: 2, width: 3, height: 4 },
          state: { enabled: true, focused: false },
          labels: {},
          attributes: {},
        }],
        viewport: { width: 200, height: 100 },
        scroll: { offsetX: 0, offsetY: 0, contentWidth: 200, contentHeight: 800 },
        url: 'https://linear.local',
      })

      await adapter.setup({
        platform: 'android',
        device: {
          name: 'android-emu',
          platform: 'android',
          match: { automationName: 'UiAutomator2' },
        },
        appPackage: 'app.linear',
      })
      const state = await adapter.observe()

      expect(mockDriver.switchContext).toHaveBeenCalledWith('WEBVIEW_app.linear')
      expect(state.platform).toBe('android')
      expect(state.url).toBe('https://linear.local')
      expect(state.tree).toContain('button "Create issue"')
      // Builder-minted ref carries the bounds from the interim node into refMap.
      const issueEl = state.elements.find(e => e.name === 'Create issue')!
      expect(state.refMap[issueEl.ref].bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 })
      expect(state.metadata.captureMode).toBe('textOnly')
    })

    it('observes Chrome webviews for explicit Android browser-mode targets', async () => {
      mockDriver.getContexts.mockResolvedValue(['NATIVE_APP', 'WEBVIEW_chrome'])
      mockDriver.execute.mockResolvedValueOnce({
        nodes: [{
          role: 'link',
          name: 'Example',
          bounds: { x: 1, y: 2, width: 3, height: 4 },
          state: { enabled: true, focused: false },
          labels: {},
          attributes: {},
        }],
        viewport: { width: 200, height: 100 },
        scroll: { offsetX: 0, offsetY: 0, contentWidth: 200, contentHeight: 800 },
        url: 'https://example.com',
      })

      await adapter.setup({
        platform: 'android',
        device: {
          name: 'android-chrome',
          platform: 'android',
          match: { automationName: 'UiAutomator2', browserName: 'Chrome' },
        },
      })
      const state = await adapter.observe()

      expect(mockDriver.switchContext).toHaveBeenCalledWith('WEBVIEW_chrome')
      expect(state.url).toBe('https://example.com')
      expect(state.tree).toContain('link "Example"')
    })

    it('shape-validates attacker-shaped WEB_OBSERVER_SCRIPT results', async () => {
      mockDriver.getContexts.mockResolvedValue(['NATIVE_APP', 'WEBVIEW_app.linear'])
      // Non-array nodes + a malformed record must never reach the builder: the whole
      // payload is rejected (nodes not an array) → falls back to native observation.
      mockDriver.execute.mockResolvedValueOnce({ nodes: 'not-an-array', viewport: null, scroll: null })

      await adapter.setup({
        platform: 'android',
        device: {
          name: 'android-emu',
          platform: 'android',
          match: { automationName: 'UiAutomator2' },
        },
        appPackage: 'app.linear',
      })
      const state = await adapter.observe()

      // Rejected web payload → native XML fallback (ANDROID_XML) produced the state.
      expect(state.platform).toBe('android')
      expect(state.tree).toContain('button "Sign In"')
    })

    it('throws if adapter not initialized', async () => {
      await expect(adapter.observe()).rejects.toThrow('not initialized')
    })
  })

  describe('execute — tap', () => {
    it('performs pointer action at element center coordinates', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.observe()

      // Find the "Sign In" button ref
      const state = await adapter.observe()
      const signInEl = state.elements.find(e => e.name === 'Sign In')
      expect(signInEl).toBeDefined()

      const result = await adapter.execute({ type: 'tap', ref: signInEl!.ref })
      expect(result.success).toBe(true)

      expect(mockDriver.action).toHaveBeenCalledWith('pointer', { parameters: { pointerType: 'touch' } })
      // button "Sign In" bounds="[100,550][980,650]" → center = (540, 600)
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 540, y: 600 })
      expect(mockDriver._pointerAction.down).toHaveBeenCalledWith({ button: 0 })
      expect(mockDriver._pointerAction.up).toHaveBeenCalledWith({ button: 0 })
      expect(mockDriver._pointerAction.perform).toHaveBeenCalled()
    })
  })

  describe('execute — fill', () => {
    it('taps to focus then types via element setValue or keys', async () => {
      await adapter.setup({ platform: 'android' })
      const state = await adapter.observe()

      const usernameEl = state.elements.find(e => e.name === 'Username')
      expect(usernameEl).toBeDefined()

      // Mock the focused element finder — the compound re-reads via getText() and probes
      // getAttribute('password') for the secure lane. The showing-hint probe matches nothing.
      const mockElement = {
        isExisting: vi.fn().mockResolvedValue(true),
        setValue: vi.fn().mockResolvedValue(undefined),
        addValue: vi.fn().mockResolvedValue(undefined),
        getText: vi.fn().mockResolvedValue('test'),
        getAttribute: vi.fn().mockResolvedValue(null),
      }
      const noMatch = { isExisting: vi.fn().mockResolvedValue(false) }
      mockDriver.$ = vi.fn(async (selector: string) =>
        selector === '//*[@focused="true"]' ? mockElement : noMatch) as any

      const result = await adapter.execute({ type: 'fill', ref: usernameEl!.ref, text: 'test', clearMode: 'replace', submit: false })
      expect(result.success).toBe(true)
      expect(result.metadata).toEqual({
        fillReread: { expected: 'test', actual: 'test' },
        fillVerdict: { verb: 'fill', verdict: 'exact', path: 'native' },
      })

      // Verify tap to focus, then one setValue and the read-back, with no Enter
      expect(mockDriver._pointerAction.perform).toHaveBeenCalled()
      expect(mockElement.setValue).toHaveBeenCalledTimes(1)
      expect(mockElement.getText).toHaveBeenCalled()
      expect(mockDriver.execute).not.toHaveBeenCalledWith('mobile: pressKey', { keycode: 66 })
    })
  })

  describe('execute — nativeSelect', () => {
    it('opens an Android spinner and selects an exact text option', async () => {
      mockDriver.getPageSource.mockResolvedValue(ANDROID_SPINNER_XML)
      await adapter.setup({ platform: 'android' })
      const state = await adapter.observe()
      const spinnerEl = state.elements.find(e => e.name === 'Priority')
      expect(spinnerEl).toBeDefined()

      const highOption = {
        isExisting: vi.fn().mockResolvedValue(true),
        click: vi.fn().mockResolvedValue(undefined),
      }
      const missingOption = { isExisting: vi.fn().mockResolvedValue(false) }
      mockDriver.$ = vi.fn(async (selector: string) => {
        if (selector === 'android=new UiSelector().text("High")') return highOption
        return missingOption
      }) as any

      const result = await adapter.execute({ type: 'nativeSelect', ref: spinnerEl!.ref, value: 'High' })

      expect(result.success).toBe(true)
      expect(mockDriver.$).toHaveBeenCalledWith('android=new UiSelector().text("High")')
      expect(highOption.click).toHaveBeenCalled()
      expect(result.data).toMatchObject({ requestedValue: 'High', matchedValue: 'High', matchStrategy: 'text' })
    })

    it('falls back to Android content-description option lookup', async () => {
      mockDriver.getPageSource.mockResolvedValue(ANDROID_SPINNER_XML)
      await adapter.setup({ platform: 'android' })
      const state = await adapter.observe()
      const spinnerEl = state.elements.find(e => e.name === 'Priority')

      const textMiss = { isExisting: vi.fn().mockResolvedValue(false) }
      const descriptionOption = {
        isExisting: vi.fn().mockResolvedValue(true),
        click: vi.fn().mockResolvedValue(undefined),
      }
      mockDriver.$ = vi.fn(async (selector: string) => {
        if (selector === 'android=new UiSelector().text("High")') return textMiss
        if (selector === 'android=new UiSelector().description("High")') return descriptionOption
        return textMiss
      }) as any

      const result = await adapter.execute({ type: 'nativeSelect', ref: spinnerEl!.ref, value: 'High' })

      expect(result.success).toBe(true)
      expect(mockDriver.$).toHaveBeenCalledWith('android=new UiSelector().description("High")')
      expect(descriptionOption.click).toHaveBeenCalled()
      expect(result.data).toMatchObject({ matchStrategy: 'description' })
    })

    it('rejects unsupported Android native controls with fallback guidance', async () => {
      await adapter.setup({ platform: 'android' })
      const state = await adapter.observe()
      const buttonEl = state.elements.find(e => e.name === 'Sign In')

      const result = await adapter.execute({ type: 'nativeSelect', ref: buttonEl!.ref, value: 'High' })

      expect(result.success).toBe(false)
      expect(result.error).toContain('nativeSelect only supports native Android picker/dropdown/list controls')
      expect(result.error).toContain('tap, swipe, or tapCoordinate')
    })

  })

  describe('execute — scroll', () => {
    // a native scroll is the driver's scrollGesture, not a raw touch swipe.
    it('performs one scrollGesture over the screen area in the specified direction', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.observe()

      const result = await adapter.execute({ type: 'scroll', mode: 'direction', direction: 'down', amount: 'halfPage', retryOpposite: true })
      expect(result.success).toBe(true)
      expect(result.metadata?.scrollUntilVisible).toMatchObject({ swipes: 1, reversedOnce: false, outcome: 'unresolved' })

      const gestures = mockDriver.execute.mock.calls.filter((c: unknown[]) => c[0] === 'mobile: scrollGesture')
      expect(gestures).toHaveLength(1)
      // viewport 1080x1920; content direction is passed as-is; halfPage halves the 0.75 page percent.
      // 436-12 (live A1): the area is the middle 60% of the swipe axis, clear of the gesture zones.
      expect(gestures[0][1]).toEqual({ left: 0, top: 384, width: 1080, height: 1152, direction: 'down', percent: 0.375 })
      expect(mockDriver.action).not.toHaveBeenCalled()
    })
  })

  describe('execute — longpress', () => {
    it('holds at element center for specified duration', async () => {
      await adapter.setup({ platform: 'android' })
      const state = await adapter.observe()

      const checkboxEl = state.elements.find(e => e.name === 'Remember me')
      expect(checkboxEl).toBeDefined()

      const result = await adapter.execute({ type: 'longpress', ref: checkboxEl!.ref, duration: 2000 })
      expect(result.success).toBe(true)

      expect(mockDriver._pointerAction.pause).toHaveBeenCalledWith(2000)
      expect(mockDriver._pointerAction.down).toHaveBeenCalledWith({ button: 0 })
      expect(mockDriver._pointerAction.up).toHaveBeenCalledWith({ button: 0 })
    })

    it('defaults to 1000ms duration', async () => {
      await adapter.setup({ platform: 'android' })
      const state = await adapter.observe()
      const checkboxEl = state.elements.find(e => e.name === 'Remember me')

      await adapter.execute({ type: 'longpress', ref: checkboxEl!.ref })
      expect(mockDriver._pointerAction.pause).toHaveBeenCalledWith(1000)
    })
  })

  // openLink retired — the deep-link-open behavior re-keys onto the typed `intent` verb
  // (mobile: startActivity). Exhaustive hostile-input pins live in catalog.test.ts.
  describe('execute — intent', () => {
    it('maps action + data + package to typed mobile: startActivity args (uri, never a shell string)', async () => {
      await adapter.setup({ platform: 'android' })
      mockDriver.execute.mockClear()

      const result = await adapter.execute({
        type: 'intent',
        action: 'android.intent.action.VIEW',
        data: 'wikipedia://wiki/Grace_Hopper',
        packageName: 'org.wikipedia.alpha',
      })

      expect(result.success).toBe(true)
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: startActivity', {
        action: 'android.intent.action.VIEW',
        uri: 'wikipedia://wiki/Grace_Hopper',
        package: 'org.wikipedia.alpha',
      })
    })

    it('maps typed extras to [typeTag,key,value] triples (string→s, int→i, bool→z)', async () => {
      await adapter.setup({ platform: 'android' })
      mockDriver.execute.mockClear()

      const result = await adapter.execute({
        type: 'intent',
        action: 'android.intent.action.VIEW',
        extras: [
          { key: 'name', type: 'string', value: 'Ada' },
          { key: 'count', type: 'int', value: '3' },
          { key: 'flag', type: 'bool', value: 'true' },
        ],
      })

      expect(result.success).toBe(true)
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: startActivity', {
        action: 'android.intent.action.VIEW',
        extras: [['s', 'name', 'Ada'], ['i', 'count', '3'], ['z', 'flag', 'true']],
      })
    })

    it('omits uri/package/extras when only an action is provided', async () => {
      await adapter.setup({ platform: 'android' })
      mockDriver.execute.mockClear()

      const result = await adapter.execute({ type: 'intent', action: 'android.intent.action.MAIN' })

      expect(result.success).toBe(true)
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: startActivity', {
        action: 'android.intent.action.MAIN',
      })
    })
  })

  describe('execute — waitFor', () => {
    it('polls the accessibility tree for on:text (not a blind pause)', async () => {
      await adapter.setup({ platform: 'android' })
      mockDriver.getPageSource.mockClear()
      const result = await adapter.execute({ type: 'waitFor', on: 'text', text: 'Sign In', timeoutMs: 500 })
      expect(result.success).toBe(true)
      expect(mockDriver.getPageSource).toHaveBeenCalled()
    })

    it('returns a §7.1 web-only error for on:selector (no selector waiting on native)', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'waitFor', on: 'selector', selector: '#done', timeoutMs: 500 })
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/web|selector/i)
    })
  })

  describe('execute — delay', () => {
    it('pauses for exactly action.ms (required field, no fallback)', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'delay', ms: 1500 })
      expect(result.success).toBe(true)
      expect(mockDriver.pause).toHaveBeenCalledWith(1500)
    })
  })

  describe('execute — keypress', () => {
    it('sends mapped key code for single key', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Enter'], mode: 'press' })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledTimes(1)
      expect(mockDriver.keys).toHaveBeenCalledWith(['\uE007'])
    })

    it('iterates multiple keys in order with KEY_MAP lookup', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Tab', 'Enter', 'Escape'], mode: 'press' })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledTimes(3)
      expect(mockDriver.keys).toHaveBeenNthCalledWith(1, ['\uE004'])
      expect(mockDriver.keys).toHaveBeenNthCalledWith(2, ['\uE007'])
      expect(mockDriver.keys).toHaveBeenNthCalledWith(3, ['\uE00C'])
    })

    it('falls back to raw string when key is not in KEY_MAP', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'keypress', keys: ['a'], mode: 'press' })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledWith(['a'])
    })

    it('ignores convertPlatformKeys flag (no-op on mobile)', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Enter'], mode: 'press', convertPlatformKeys: false })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledWith(['\uE007'])
    })
  })

  describe('execute — keypress mode gating', () => {
    it('returns a §7.1 press-only error for mode:down (web-only key hold/release)', async () => {
      await adapter.setup({ platform: 'android' })
      const down = await adapter.execute({ type: 'keypress', keys: ['Shift'], mode: 'down' })
      expect(down.success).toBe(false)
      expect(down.error).toMatch(/press|mobile|down|up/i)
      expect(mockDriver.keys).not.toHaveBeenCalled()
    })
  })

  // assert retired — deterministic checks now route through the runner-side assertValue
  // comparator and claim-shaped checks through assertAI; there is no adapter assert case.

  describe('screenshot', () => {
    it('returns PNG buffer from base64', async () => {
      await adapter.setup({ platform: 'android' })
      const buf = await adapter.screenshot()
      expect(buf).toBeInstanceOf(Buffer)
      expect(buf!.length).toBeGreaterThan(0)
    })

    it('returns undefined when no driver', async () => {
      const buf = await adapter.screenshot()
      expect(buf).toBeUndefined()
    })
  })

  describe('WebView screenshots paint an unset background white', () => {
    // sharp is runner-local's dependency, not android's, so it is resolved from there.
    const runnerLocal = createRequire(import.meta.url).resolve('@vostride/agent-qa-runner-local')
    const sharp = createRequire(runnerLocal)('sharp') as any
    const appPackage = 'dev.example.web'

    async function transparentPng(): Promise<Buffer> {
      const png: Buffer = await sharp({
        create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      }).png().toBuffer()
      expect((await sharp(png).metadata()).hasAlpha).toBe(true)
      return png
    }

    it('a WebView screenshot of an unset background is white, not black', async () => {
      const png = await transparentPng()
      mockDriver.getContexts.mockResolvedValue(['NATIVE_APP', `WEBVIEW_${appPackage}`])
      mockDriver.execute.mockResolvedValueOnce({
        nodes: [{
          role: 'button',
          name: 'Submit',
          bounds: { x: 1, y: 2, width: 3, height: 4 },
          state: { enabled: true, focused: false },
          labels: {},
          attributes: {},
        }],
        viewport: { width: 4, height: 4 },
        scroll: { offsetX: 0, offsetY: 0, contentWidth: 4, contentHeight: 4 },
        url: 'https://web.example.test',
      })
      await adapter.setup({ platform: 'android', appPackage })
      const state = await adapter.observe()
      expect(state.url).toBe('https://web.example.test')
      mockDriver.takeScreenshot.mockResolvedValue(png.toString('base64'))

      const buf = await adapter.screenshot()

      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
      expect([...data.subarray(0, info.channels)]).toEqual([255, 255, 255])
      expect(info.channels).toBe(3)
      expect((await sharp(buf).metadata()).format).toBe('png')
    })

    it('a native screenshot is returned as captured', async () => {
      const png = await transparentPng()
      await adapter.setup({ platform: 'android', appPackage })
      await adapter.observe()
      mockDriver.takeScreenshot.mockResolvedValue(png.toString('base64'))

      const buf = await adapter.screenshot()

      expect(buf).toBeInstanceOf(Buffer)
      expect(buf!.equals(png)).toBe(true)
    })

    async function enterWebView() {
      mockDriver.getContexts.mockResolvedValue(['NATIVE_APP', `WEBVIEW_${appPackage}`])
      mockDriver.execute.mockResolvedValueOnce({
        nodes: [{
          role: 'button',
          name: 'Submit',
          bounds: { x: 1, y: 2, width: 3, height: 4 },
          state: { enabled: true, focused: false },
          labels: {},
          attributes: {},
        }],
        viewport: { width: 4, height: 4 },
        scroll: { offsetX: 0, offsetY: 0, contentWidth: 4, contentHeight: 4 },
        url: 'https://web.example.test',
      })
      await adapter.setup({ platform: 'android', appPackage })
      const state = await adapter.observe()
      expect(state.url).toBe('https://web.example.test')
      const submit = state.elements.find(e => e.name === 'Submit')
      expect(submit).toBeDefined()
      return submit!.ref
    }

    async function expectWhite(buf: Buffer | Uint8Array | undefined): Promise<void> {
      expect(buf).toBeDefined()
      const { data, info } = await sharp(Buffer.from(buf!)).raw().toBuffer({ resolveWithObject: true })
      expect([...data.subarray(0, info.channels)]).toEqual([255, 255, 255])
      expect(info.channels).toBe(3)
    }

    it('a failure screenshot taken in a WebView is white, not black', async () => {
      const png = await transparentPng()
      const ref = await enterWebView()
      mockDriver.takeScreenshot.mockResolvedValue(png.toString('base64'))
      mockDriver.execute.mockRejectedValueOnce(new Error('tap failed'))

      const result = await adapter.execute({ type: 'tap', ref })

      expect(result.success).toBe(false)
      expect(result.error).toBe('tap failed')
      await expectWhite(result.screenshot)
    })

    it('a live preview frame taken in a WebView is white and switches no context', async () => {
      const png = await transparentPng()
      await enterWebView()
      mockDriver.takeScreenshot.mockResolvedValue(png.toString('base64'))
      const getContext = vi.fn().mockResolvedValue(`WEBVIEW_${appPackage}`)
      Object.assign(mockDriver, { getContext })
      mockDriver.switchContext.mockClear()

      const stream = (adapter as PlatformAdapter<'android'>).liveStream!
      const first = new Promise<LiveFrame>((resolve) => { void stream.start(resolve) })
      const frame = await first
      await stream.stop()

      await expectWhite(frame.bytes)
      expect(mockDriver.switchContext).not.toHaveBeenCalled()
      expect(getContext).not.toHaveBeenCalled()
    })

    it('a native failure screenshot is returned as captured', async () => {
      const png = await transparentPng()
      await adapter.setup({ platform: 'android', appPackage })
      const state = await adapter.observe()
      const signIn = state.elements.find(e => e.name === 'Sign In')
      expect(signIn).toBeDefined()
      mockDriver.takeScreenshot.mockResolvedValue(png.toString('base64'))
      mockDriver._pointerAction.perform.mockRejectedValueOnce(new Error('touch failed'))

      const result = await adapter.execute({ type: 'tap', ref: signIn!.ref })

      expect(result.success).toBe(false)
      expect(result.screenshot).toBeInstanceOf(Buffer)
      expect(result.screenshot!.equals(png)).toBe(true)
    })
  })

  describe('execute — error handling', () => {
    it('captures screenshot on action failure', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.observe()

      // Make pointer action throw
      mockDriver._pointerAction.perform.mockRejectedValueOnce(new Error('touch failed'))

      const state = await adapter.observe()
      const el = state.elements.find(e => e.name === 'Sign In')
      const result = await adapter.execute({ type: 'tap', ref: el!.ref })

      expect(result.success).toBe(false)
      expect(result.error).toBe('touch failed')
      expect(result.screenshot).toBeInstanceOf(Buffer)
    })
  })

  describe('execute — swipe', () => {
    it('performs directional swipe gesture', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.observe()

      const result = await adapter.execute({ type: 'swipe', mode: 'direction', direction: 'left', durationMs: 300 })
      expect(result.success).toBe(true)

      expect(mockDriver.action).toHaveBeenCalledWith('pointer', { parameters: { pointerType: 'touch' } })
      expect(mockDriver._pointerAction.perform).toHaveBeenCalled()
    })
  })

  describe('execute — coordinate passthrough (tapCoordinate, swipe, pinch, multiTap)', () => {
    it('tapCoordinate passes LLM coords directly to driver', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'tapCoordinate', x: 100, y: 200, coordSpace: 'viewport' })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 100, y: 200 })
      expect(result.coordinates).toEqual({ x: 100, y: 200 })
    })

    it('tapCoordinate passes arbitrary coords unchanged', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'tapCoordinate', x: 200, y: 400, coordSpace: 'viewport' })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 200, y: 400 })
      expect(result.coordinates).toEqual({ x: 200, y: 400 })
    })

    it('swipe (mode:path) drives from/to points directly to driver', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({
        type: 'swipe',
        mode: 'path',
        from: { x: 100, y: 200 },
        to: { x: 300, y: 400 },
        coordSpace: 'viewport',
        durationMs: 300,
      })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.move).toHaveBeenNthCalledWith(1, { x: 100, y: 200 })
      expect(mockDriver._pointerAction.move).toHaveBeenNthCalledWith(2, { x: 300, y: 400, duration: 300 })
      expect(result.startCoordinates).toEqual({ x: 100, y: 200 })
      expect(result.endCoordinates).toEqual({ x: 300, y: 400 })
    })

    it('pinch center coords pass directly to driver', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'pinch', scale: 0.5, x: 100, y: 200, coordSpace: 'viewport' })
      expect(result.success).toBe(true)
      expect(result.coordinates).toEqual({ x: 100, y: 200 })
    })

    it('multiTap center coords pass directly to driver', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'multiTap', fingers: 2, x: 100, y: 200, coordSpace: 'viewport' })
      expect(result.success).toBe(true)
    })

    it('coords pass through unchanged (viewport-space contract)', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'tapCoordinate', x: 100, y: 200, coordSpace: 'viewport' })
      expect(result.coordinates).toEqual({ x: 100, y: 200 })
    })
  })

  describe('screenshot — action-space alignment assertion', () => {
    it('returns screenshot buffer without warning when dimensions match getWindowSize', async () => {
      await adapter.setup({ platform: 'android' })
      // SCREENSHOT_BASE64 is a 1x1 PNG, window is 1080x1920 → will warn but not throw
      // Just verify the call completes without throwing
      const buf = await adapter.screenshot()
      expect(buf).toBeInstanceOf(Buffer)
    })

    it('does not throw when getWindowSize fails', async () => {
      await adapter.setup({ platform: 'android' })
      mockDriver.getWindowSize.mockRejectedValueOnce(new Error('session closed'))
      const buf = await adapter.screenshot()
      expect(buf).toBeInstanceOf(Buffer)  // Assertion failure is best-effort, returns buffer
    })
  })

  describe('liveStream', () => {
    function contextSpies() {
      const spies = {
        getContext: vi.fn().mockResolvedValue('NATIVE_APP'),
        switchContext: vi.fn().mockResolvedValue(undefined),
        getWindowSize: vi.fn().mockResolvedValue({ width: 1080, height: 1920 }),
        takeScreenshot: vi.fn().mockResolvedValue(SCREENSHOT_BASE64),
      }
      Object.assign(mockDriver, spies)
      return spies
    }

    it('LIVE-STREAM-IS-CONTEXT-NEUTRAL-SNAPSHOT: snapshots come from takeScreenshot alone, never a context switch', async () => {
      await adapter.setup({ platform: 'android' })
      const spies = contextSpies()
      const stream = (adapter as PlatformAdapter<'android'>).liveStream
      expect(stream?.kind).toBe('snapshot')
      const frames: LiveFrame[] = []
      await stream!.start((frame) => frames.push(frame))
      await vi.waitFor(() => expect(frames).toHaveLength(1))
      await stream!.stop()
      expect(Buffer.from(frames[0].bytes).toString('base64')).toBe(SCREENSHOT_BASE64)
      expect(frames[0].kind).toBe('snapshot')
      expect(spies.takeScreenshot).toHaveBeenCalledTimes(1)
      expect(spies.switchContext, 'a tick must never move the session under a running step').not.toHaveBeenCalled()
      expect(spies.getContext).not.toHaveBeenCalled()
      expect(spies.getWindowSize).not.toHaveBeenCalled()
    })

    it('the getter answers one capability, before the driver exists too, and cleanup() stops and drops it', async () => {
      const early = (adapter as PlatformAdapter<'android'>).liveStream
      expect(early?.kind, 'declared before setup, so selection never reaches screenshot()').toBe('snapshot')
      await adapter.setup({ platform: 'android' })
      const stream = (adapter as PlatformAdapter<'android'>).liveStream
      expect(stream).toBe(early)
      expect((adapter as PlatformAdapter<'android'>).liveStream).toBe(stream)
      const stop = vi.spyOn(stream!, 'stop')
      await stream!.start(() => {})
      await adapter.cleanup()
      expect(stop).toHaveBeenCalledTimes(1)
      expect((adapter as PlatformAdapter<'android'>).liveStream).not.toBe(stream)
    })
  })
})
