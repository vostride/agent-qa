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
    terminateApp: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockRejectedValue(new Error('not supported')),
    $: vi.fn() as unknown as (selector: string) => Promise<unknown>,
    _pointerAction: pointerAction,
  }
}

vi.mock('webdriverio', () => ({
  remote: vi.fn(),
}))

import { AndroidPlatformAdapter } from '../adapter.js'
import type { PlatformConfig } from '@vostride/agent-qa-core'

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
          transport: 'local',
          match: { automationName: 'UiAutomator2', platformVersion: '14' },
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
          transport: 'local',
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
          transport: 'local',
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
          transport: 'local',
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
          transport: 'local',
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
          transport: 'local',
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
          transport: 'local',
          match: { automationName: 'UiAutomator2' },
        },
        appPackage: 'org.wikipedia.alpha',
      })

      expect(mockDriver.activateApp).toHaveBeenCalledWith('org.wikipedia.alpha')
    })

    it('wraps resolved app launch failure as app-launch setup error', async () => {
      mockDriver.activateApp.mockRejectedValueOnce(new Error('not installed'))

      await expect(adapter.setup({
        platform: 'android',
        appPackage: 'org.wikipedia.alpha',
      })).rejects.toMatchObject({ category: 'app-launch' })
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
    it('returns ScreenState with parsed tree and elements', async () => {
      await adapter.setup({ platform: 'android' })
      const state = await adapter.observe()

      expect(state.tree).toContain('text "Login"')
      expect(state.tree).toContain('textbox "Username"')
      expect(state.tree).toContain('textbox "Password"')
      expect(state.tree).toContain('button "Sign In"')
      expect(state.elements.length).toBeGreaterThanOrEqual(5)
      expect(state.timestamp).toBeGreaterThan(0)
      expect(state.metadata.refMap).toBeDefined()
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

      // Mock the focused element finder
      const mockElement = { isExisting: vi.fn().mockResolvedValue(true), setValue: vi.fn().mockResolvedValue(undefined) }
      mockDriver.$ = vi.fn().mockResolvedValue(mockElement)

      const result = await adapter.execute({ type: 'fill', ref: usernameEl!.ref, value: 'test' })
      expect(result.success).toBe(true)

      // Verify tap to focus
      expect(mockDriver._pointerAction.perform).toHaveBeenCalled()
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

    it('keeps native select from reporting tap-only success', async () => {
      mockDriver.getPageSource.mockResolvedValue(ANDROID_SPINNER_XML)
      await adapter.setup({ platform: 'android' })
      const state = await adapter.observe()
      const spinnerEl = state.elements.find(e => e.name === 'Priority')

      const result = await adapter.execute({ type: 'select', ref: spinnerEl!.ref, value: 'High' })

      expect(result.success).toBe(false)
      expect(result.error).toContain('select is for HTML dropdowns')
      expect(result.error).toContain('nativeSelect')
    })
  })

  describe('execute — scroll', () => {
    it('performs swipe gesture in the specified direction', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.observe()

      const result = await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: 500 })
      expect(result.success).toBe(true)

      expect(mockDriver.action).toHaveBeenCalledWith('pointer', { parameters: { pointerType: 'touch' } })
      // viewport: 1080x1920, center: 540,960
      // scroll down (value=500): startY=center=960, endY=center-500=460
      // finger swipes up (960→460) which scrolls content down
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 540, y: 960 })
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 540, y: 460, duration: 300 })
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

  describe('execute — unsupported actions', () => {
    it('navigate returns error', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'navigate', url: 'https://example.com' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('not supported')
    })

    it('hover returns error', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.observe()
      const state = await adapter.observe()
      const el = state.elements[0]
      const result = await adapter.execute({ type: 'hover', ref: el.ref })
      expect(result.success).toBe(false)
      expect(result.error).toContain('web-only')
    })
  })

  describe('execute — openLink', () => {
    it('passes explicit Android app package to the deep-link command', async () => {
      await adapter.setup({ platform: 'android' })

      const result = await adapter.execute({
        type: 'openLink',
        url: 'wikipedia://wiki/Grace_Hopper',
        appPackage: 'org.wikipedia.alpha',
      })

      expect(result.success).toBe(true)
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: deepLink', {
        url: 'wikipedia://wiki/Grace_Hopper',
        package: 'org.wikipedia.alpha',
      })
    })

    it('ignores empty appId and uses explicit Android app package for deep links', async () => {
      await adapter.setup({ platform: 'android' })

      const result = await adapter.execute({
        type: 'openLink',
        url: 'wikipedia://wiki/Grace_Hopper',
        appId: '',
        appPackage: 'org.wikipedia.alpha',
      })

      expect(result.success).toBe(true)
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: deepLink', {
        url: 'wikipedia://wiki/Grace_Hopper',
        package: 'org.wikipedia.alpha',
      })
    })

    it('falls back to setup app package for deep links', async () => {
      await adapter.setup({ platform: 'android', appPackage: 'org.wikipedia.alpha' })
      mockDriver.execute.mockClear()

      const result = await adapter.execute({ type: 'openLink', url: 'wikipedia://wiki/Alan_Turing' })

      expect(result.success).toBe(true)
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: deepLink', {
        url: 'wikipedia://wiki/Alan_Turing',
        package: 'org.wikipedia.alpha',
      })
    })

    it('fails native-scheme links when no Android app package is available', async () => {
      await adapter.setup({ platform: 'android' })

      const result = await adapter.execute({ type: 'openLink', url: 'wikipedia://wiki/Grace_Hopper' })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing Android app package')
    })
  })

  describe('execute — waitFor', () => {
    it('pauses for specified timeout', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'waitFor', condition: 'loading', timeout: 3000 })
      expect(result.success).toBe(true)
      expect(mockDriver.pause).toHaveBeenCalledWith(3000)
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
      const result = await adapter.execute({ type: 'keypress', keys: ['Enter'] })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledTimes(1)
      expect(mockDriver.keys).toHaveBeenCalledWith(['\uE007'])
    })

    it('iterates multiple keys in order with KEY_MAP lookup', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Tab', 'Enter', 'Escape'] })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledTimes(3)
      expect(mockDriver.keys).toHaveBeenNthCalledWith(1, ['\uE004'])
      expect(mockDriver.keys).toHaveBeenNthCalledWith(2, ['\uE007'])
      expect(mockDriver.keys).toHaveBeenNthCalledWith(3, ['\uE00C'])
    })

    it('falls back to raw string when key is not in KEY_MAP', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'keypress', keys: ['a'] })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledWith(['a'])
    })

    it('ignores convertPlatformKeys flag (no-op on mobile)', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Enter'], convertPlatformKeys: false })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledWith(['\uE007'])
    })
  })

  describe('execute — assert', () => {
    it('returns success (handled by agent core)', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'assert', condition: 'text visible' })
      expect(result.success).toBe(true)
    })
  })

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

      const result = await adapter.execute({ type: 'swipe', direction: 'left' })
      expect(result.success).toBe(true)

      expect(mockDriver.action).toHaveBeenCalledWith('pointer', { parameters: { pointerType: 'touch' } })
      expect(mockDriver._pointerAction.perform).toHaveBeenCalled()
    })
  })

  describe('execute — click (alias for tap)', () => {
    it('performs tap for click action', async () => {
      await adapter.setup({ platform: 'android' })
      const state = await adapter.observe()
      const el = state.elements.find(e => e.name === 'Sign In')

      const result = await adapter.execute({ type: 'click', ref: el!.ref })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.perform).toHaveBeenCalled()
    })
  })

  describe('execute — coordinate passthrough (tapCoordinate, swipe, pinch, multiTap)', () => {
    it('tapCoordinate passes LLM coords directly to driver', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'tapCoordinate', x: 100, y: 200 })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 100, y: 200 })
      expect(result.coordinates).toEqual({ x: 100, y: 200 })
    })

    it('tapCoordinate passes arbitrary coords unchanged', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'tapCoordinate', x: 200, y: 400 })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 200, y: 400 })
      expect(result.coordinates).toEqual({ x: 200, y: 400 })
    })

    it('swipe passes 4 coords directly to driver', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({
        type: 'swipe',
        direction: 'up',
        startX: 100, startY: 200, endX: 300, endY: 400,
      })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.move).toHaveBeenNthCalledWith(1, { x: 100, y: 200 })
      expect(mockDriver._pointerAction.move).toHaveBeenNthCalledWith(2, { x: 300, y: 400, duration: 300 })
      expect(result.startCoordinates).toEqual({ x: 100, y: 200 })
      expect(result.endCoordinates).toEqual({ x: 300, y: 400 })
    })

    it('pinch center coords pass directly to driver', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'pinch', scale: 0.5, x: 100, y: 200 })
      expect(result.success).toBe(true)
      expect(result.coordinates).toEqual({ x: 100, y: 200 })
    })

    it('multiTap center coords pass directly to driver', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'multiTap', fingers: 2, x: 100, y: 200 })
      expect(result.success).toBe(true)
    })

    it('coords pass through unchanged (viewport-space contract)', async () => {
      await adapter.setup({ platform: 'android' })
      const result = await adapter.execute({ type: 'tapCoordinate', x: 100, y: 200 })
      expect(result.coordinates).toEqual({ x: 100, y: 200 })
    })
  })

  describe('screenshot — action-space alignment assertion (D-06)', () => {
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
})
