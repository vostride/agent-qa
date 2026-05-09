import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const IOS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="TestApp" label="TestApp" x="0" y="0" width="390" height="844">
    <XCUIElementTypeOther x="0" y="0" width="390" height="844">
      <XCUIElementTypeStaticText label="Welcome" x="50" y="100" width="290" height="40" enabled="true" />
      <XCUIElementTypeTextField label="Email" value="" x="50" y="180" width="290" height="44" enabled="true" />
      <XCUIElementTypeSecureTextField label="Password" value="" x="50" y="240" width="290" height="44" enabled="true" />
      <XCUIElementTypeButton label="Log In" x="50" y="320" width="290" height="50" enabled="true" />
      <XCUIElementTypeSwitch label="Stay signed in" value="0" x="50" y="400" width="290" height="40" enabled="true" />
      <XCUIElementTypeImage label="Logo" x="150" y="30" width="90" height="60" enabled="true" />
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication>
</AppiumAUT>`

const IOS_PICKER_WHEEL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="TestApp" label="TestApp" x="0" y="0" width="390" height="844">
    <XCUIElementTypePickerWheel value="February" x="20" y="500" width="350" height="80" enabled="true" />
  </XCUIElementTypeApplication>
</AppiumAUT>`

const IOS_PICKER_CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="TestApp" label="TestApp" x="0" y="0" width="390" height="844">
    <XCUIElementTypePicker label="Month" x="20" y="450" width="350" height="180" enabled="true">
      <XCUIElementTypePickerWheel value="February" x="20" y="500" width="350" height="80" enabled="true" />
    </XCUIElementTypePicker>
  </XCUIElementTypeApplication>
</AppiumAUT>`

const IOS_TWO_PICKER_WHEELS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="TestApp" label="TestApp" x="0" y="0" width="390" height="844">
    <XCUIElementTypePickerWheel value="February" x="20" y="500" width="170" height="80" enabled="true" />
    <XCUIElementTypePickerWheel value="2026" x="200" y="500" width="170" height="80" enabled="true" />
  </XCUIElementTypeApplication>
</AppiumAUT>`

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
    getPageSource: vi.fn().mockResolvedValue(IOS_XML),
    getWindowSize: vi.fn().mockResolvedValue({ width: 390, height: 844 }),
    takeScreenshot: vi.fn().mockResolvedValue(SCREENSHOT_BASE64),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    action: vi.fn().mockReturnValue(pointerAction),
    actions: vi.fn().mockResolvedValue(undefined),
    keys: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    activateApp: vi.fn().mockResolvedValue(undefined),
    terminateApp: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(undefined),
    deepLink: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockRejectedValue(new Error('not supported')),
    $: vi.fn().mockResolvedValue({ clearValue: vi.fn(), setValue: vi.fn() }),
    $$: vi.fn().mockResolvedValue([]),
    _pointerAction: pointerAction,
  }
}

vi.mock('webdriverio', () => ({
  remote: vi.fn(),
}))

import { IOSPlatformAdapter } from '../adapter.js'
import type { PlatformConfig } from '@vostride/agent-qa-core'
import zlib from 'node:zlib'

// --- PNG helpers (avoids adding sharp as ios dep per Pitfall 5) ---
function pngCrc32(buf: Buffer): number {
  const table: number[] = []
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(pngCrc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function createPng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8); ihdr.writeUInt8(2, 9) // 8-bit RGB
  ihdr.writeUInt8(0, 10); ihdr.writeUInt8(0, 11); ihdr.writeUInt8(0, 12)
  const rowLen = 1 + width * 3
  const raw = Buffer.alloc(rowLen * height)
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

function create1179x2556PngBase64(): string {
  return createPng(1179, 2556).toString('base64')
}

/** Parse PNG width/height from IHDR chunk. Returns null for non-PNG buffers. */
function readPngDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe('IOSPlatformAdapter', () => {
  let adapter: IOSPlatformAdapter
  let mockDriver: ReturnType<typeof createMockDriver>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockDriver = createMockDriver()
    const { remote } = await import('webdriverio')
    vi.mocked(remote).mockResolvedValue(mockDriver as any)

    adapter = new IOSPlatformAdapter()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
  })

  describe('setup', () => {
    it('creates XCUITest session with correct capabilities', async () => {
      const config: PlatformConfig = {
        platform: 'ios',
        appState: 'preserve',
        device: { name: 'iphone-15', platform: 'ios', transport: 'local', match: { automationName: 'XCUITest', platformVersion: '17.0', deviceName: 'iPhone 15', app: '/path/to/app.app' } },
      }

      await adapter.setup(config)

      const { remote } = await import('webdriverio')
      expect(remote).toHaveBeenCalledWith(expect.objectContaining({
        hostname: 'localhost',
        port: 4723,
        capabilities: expect.objectContaining({
          platformName: 'iOS',
          'appium:automationName': 'XCUITest',
          'appium:deviceName': 'iphone-15',
          'appium:platformVersion': '17.0',
          'appium:noReset': true,
          'appium:newCommandTimeout': 300,
        }),
      }))
    })

    it('strips undefined capability values', async () => {
      await adapter.setup({ platform: 'ios' })

      const { remote } = await import('webdriverio')
      const call = vi.mocked(remote).mock.calls[0][0] as any
      const caps = call.capabilities
      expect(caps).not.toHaveProperty('appium:platformVersion')
      expect(caps).not.toHaveProperty('appium:app')
      expect(caps).not.toHaveProperty('appium:bundleId')
      expect(caps).not.toHaveProperty('appium:udid')
    })

    it('sets appium app capability from configured app path and preserves bundle id', async () => {
      await adapter.setup({
        platform: 'ios',
        device: {
          name: 'ios-sim',
          platform: 'ios',
          transport: 'local',
          match: { automationName: 'XCUITest' },
        },
        bundleId: 'org.reactjs.native.example.wdiodemoapp',
        appPath: '/tmp/wdio.app',
      })

      const { remote } = await import('webdriverio')
      const call = vi.mocked(remote).mock.calls[0][0] as any
      expect(call.capabilities['appium:app']).toBe('/tmp/wdio.app')
      expect(call.capabilities['appium:bundleId']).toBe('org.reactjs.native.example.wdiodemoapp')
    })

    it('maps preserve app state to appium noReset true', async () => {
      await adapter.setup({
        platform: 'ios',
        appState: 'preserve',
        device: {
          name: 'ios-sim',
          platform: 'ios',
          transport: 'local',
          match: { automationName: 'XCUITest' },
        },
      })

      const { remote } = await import('webdriverio')
      const call = vi.mocked(remote).mock.calls[0][0] as any
      expect(call.capabilities['appium:noReset']).toBe(true)
    })

    it('maps reset app state to appium noReset false', async () => {
      await adapter.setup({
        platform: 'ios',
        appState: 'reset',
        device: {
          name: 'ios-sim',
          platform: 'ios',
          transport: 'local',
          match: { automationName: 'XCUITest' },
        },
      })

      const { remote } = await import('webdriverio')
      const call = vi.mocked(remote).mock.calls[0][0] as any
      expect(call.capabilities['appium:noReset']).toBe(false)
    })

    it('uses appState instead of stale match.noReset', async () => {
      await adapter.setup({
        platform: 'ios',
        appState: 'reset',
        device: {
          name: 'ios-sim',
          platform: 'ios',
          transport: 'local',
          match: { automationName: 'XCUITest', noReset: true },
        },
      })

      const { remote } = await import('webdriverio')
      const call = vi.mocked(remote).mock.calls[0][0] as any
      expect(call.capabilities['appium:noReset']).toBe(false)
    })

    it('launches resolved target bundle id after session creation', async () => {
      await adapter.setup({
        platform: 'ios',
        device: {
          name: 'ios-sim',
          platform: 'ios',
          transport: 'local',
          match: { automationName: 'XCUITest' },
        },
        bundleId: 'org.reactjs.native.example.wdiodemoapp',
      })

      expect(mockDriver.activateApp).toHaveBeenCalledWith('org.reactjs.native.example.wdiodemoapp')
    })

    it('wraps resolved app launch failure as app-launch setup error', async () => {
      mockDriver.activateApp.mockRejectedValueOnce(new Error('not installed'))

      await expect(adapter.setup({
        platform: 'ios',
        bundleId: 'org.reactjs.native.example.wdiodemoapp',
      })).rejects.toMatchObject({ category: 'app-launch' })
    })

    it('keeps simulator deviceName separate from bundleId capability', async () => {
      await adapter.setup({
        platform: 'ios',
        device: {
          name: 'ios-sim',
          platform: 'ios',
          transport: 'local',
          match: { automationName: 'XCUITest' },
        },
        bundleId: 'org.reactjs.native.example.wdiodemoapp',
      })

      const { remote } = await import('webdriverio')
      const call = vi.mocked(remote).mock.calls[0][0] as any
      expect(call.capabilities['appium:deviceName']).toBe('ios-sim')
      expect(call.capabilities['appium:bundleId']).toBe('org.reactjs.native.example.wdiodemoapp')
    })
  })

  describe('cleanup', () => {
    it('calls deleteSession and clears state', async () => {
      await adapter.setup({ platform: 'ios' })
      await adapter.cleanup()
      expect(mockDriver.deleteSession).toHaveBeenCalled()
    })

    it('does not throw if session already closed', async () => {
      await adapter.setup({ platform: 'ios' })
      mockDriver.deleteSession.mockRejectedValue(new Error('session not found'))
      await expect(adapter.cleanup()).resolves.not.toThrow()
    })
  })

  describe('observe', () => {
    it('returns ScreenState with parsed iOS tree and elements', async () => {
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()

      expect(state.tree).toContain('text "Welcome"')
      expect(state.tree).toContain('textbox "Email"')
      expect(state.tree).toContain('textbox "Password"')
      expect(state.tree).toContain('button "Log In"')
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
      await adapter.setup({ platform: 'ios' })
      await adapter.observe()

      const state = await adapter.observe()
      const logInEl = state.elements.find(e => e.name === 'Log In')
      expect(logInEl).toBeDefined()

      const result = await adapter.execute({ type: 'tap', ref: logInEl!.ref })
      expect(result.success).toBe(true)

      expect(mockDriver.action).toHaveBeenCalledWith('pointer', { parameters: { pointerType: 'touch' } })
      // button "Log In" x=50 y=320 w=290 h=50 → center = (195, 345)
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 195, y: 345 })
      expect(mockDriver._pointerAction.down).toHaveBeenCalledWith({ button: 0 })
      expect(mockDriver._pointerAction.up).toHaveBeenCalledWith({ button: 0 })
      expect(mockDriver._pointerAction.perform).toHaveBeenCalled()
    })
  })

  describe('execute — fill', () => {
    it('taps to focus then types via element setValue', async () => {
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()

      const emailEl = state.elements.find(e => e.name === 'Email')
      expect(emailEl).toBeDefined()

      // Mock the $() element finder that fill uses after tap-to-focus
      const mockElement = { clearValue: vi.fn(), setValue: vi.fn() }
      mockDriver.$ = vi.fn().mockResolvedValue(mockElement)

      const result = await adapter.execute({ type: 'fill', ref: emailEl!.ref, value: 'user@test.com' })
      expect(result.success).toBe(true)

      // Tap to focus fires a pointer action
      expect(mockDriver._pointerAction.perform).toHaveBeenCalled()
    })
  })

  describe('execute — nativeSelect', () => {
    it('sets a direct iOS picker-wheel value', async () => {
      mockDriver.getPageSource.mockResolvedValue(IOS_PICKER_WHEEL_XML)
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      const pickerWheelEl = state.elements.find(e => e.attributes.nativeType === 'XCUIElementTypePickerWheel')
      expect(pickerWheelEl).toBeDefined()

      const pickerWheel = {
        isExisting: vi.fn().mockResolvedValue(true),
        setValue: vi.fn().mockResolvedValue(undefined),
        getValue: vi.fn().mockResolvedValue('March'),
      }
      mockDriver.$ = vi.fn().mockResolvedValue(pickerWheel)

      const result = await adapter.execute({ type: 'nativeSelect', ref: pickerWheelEl!.ref, value: 'March' })

      expect(result.success).toBe(true)
      expect(pickerWheel.setValue).toHaveBeenCalledWith('March')
      expect(result.data).toMatchObject({ requestedValue: 'March', matchedValue: 'March', matchStrategy: 'exact' })
    })

    it('targets the observed picker-wheel ref when multiple wheels exist', async () => {
      mockDriver.getPageSource.mockResolvedValue(IOS_TWO_PICKER_WHEELS_XML)
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      const wheelRefs = state.elements.filter(e => e.attributes.nativeType === 'XCUIElementTypePickerWheel')
      expect(wheelRefs).toHaveLength(2)

      const firstWheel = {
        setValue: vi.fn().mockResolvedValue(undefined),
        getValue: vi.fn().mockResolvedValue('February'),
      }
      const secondWheel = {
        setValue: vi.fn().mockResolvedValue(undefined),
        getValue: vi.fn().mockResolvedValue('2027'),
      }
      mockDriver.$$ = vi.fn().mockResolvedValue([firstWheel, secondWheel])

      const result = await adapter.execute({ type: 'nativeSelect', ref: wheelRefs[1].ref, value: '2027' })

      expect(result.success).toBe(true)
      expect(firstWheel.setValue).not.toHaveBeenCalled()
      expect(secondWheel.setValue).toHaveBeenCalledWith('2027')
    })

    it('selects from a picker container when one picker wheel is exposed', async () => {
      mockDriver.getPageSource.mockResolvedValue(IOS_PICKER_CONTAINER_XML)
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      const pickerEl = state.elements.find(e => e.attributes.nativeType === 'XCUIElementTypePicker')
      expect(pickerEl).toBeDefined()

      const pickerWheel = {
        setValue: vi.fn().mockResolvedValue(undefined),
        getAttribute: vi.fn().mockResolvedValue('March'),
      }
      mockDriver.$$ = vi.fn().mockResolvedValue([pickerWheel])

      const result = await adapter.execute({ type: 'nativeSelect', ref: pickerEl!.ref, value: 'March' })

      expect(result.success).toBe(true)
      expect(mockDriver.$$).toHaveBeenCalledWith('-ios class chain:**/XCUIElementTypePickerWheel')
      expect(pickerWheel.setValue).toHaveBeenCalledWith('March')
    })

    it('rejects ambiguous picker containers with multiple iOS picker wheels', async () => {
      mockDriver.getPageSource.mockResolvedValue(IOS_PICKER_CONTAINER_XML)
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      const pickerEl = state.elements.find(e => e.attributes.nativeType === 'XCUIElementTypePicker')

      mockDriver.$$ = vi.fn().mockResolvedValue([
        { setValue: vi.fn() },
        { setValue: vi.fn() },
      ])

      const result = await adapter.execute({ type: 'nativeSelect', ref: pickerEl!.ref, value: 'March' })

      expect(result.success).toBe(false)
      expect(result.error).toContain('multiple iOS picker wheels')
      expect(result.error).toContain('Do not guess')
    })

    it('rejects unsupported iOS native controls with fallback guidance', async () => {
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      const buttonEl = state.elements.find(e => e.name === 'Log In')

      const result = await adapter.execute({ type: 'nativeSelect', ref: buttonEl!.ref, value: 'March' })

      expect(result.success).toBe(false)
      expect(result.error).toContain('nativeSelect only supports native iOS picker wheels')
      expect(result.error).toContain('tap, swipe, or tapCoordinate')
    })

    it('keeps native select from reporting tap-only success', async () => {
      mockDriver.getPageSource.mockResolvedValue(IOS_PICKER_WHEEL_XML)
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      const pickerWheelEl = state.elements.find(e => e.attributes.nativeType === 'XCUIElementTypePickerWheel')

      const result = await adapter.execute({ type: 'select', ref: pickerWheelEl!.ref, value: 'March' })

      expect(result.success).toBe(false)
      expect(result.error).toContain('select is for HTML dropdowns')
      expect(result.error).toContain('nativeSelect')
    })
  })

  describe('execute — scroll', () => {
    it('performs swipe gesture in the specified direction', async () => {
      await adapter.setup({ platform: 'ios' })
      await adapter.observe()

      const result = await adapter.execute({ type: 'scroll', scrollType: 'vertical', value: -500 })
      expect(result.success).toBe(true)

      expect(mockDriver.action).toHaveBeenCalledWith('pointer', { parameters: { pointerType: 'touch' } })
      // viewport: 390x844, center: 195,422
      // scroll up (value=-500): startY=center=422, endY=center-(-500)=922
      // finger swipes down (422→922) which scrolls content up
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 195, y: 422 })
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 195, y: 922, duration: 300 })
    })
  })

  describe('execute — longpress', () => {
    it('holds at element center for specified duration', async () => {
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()

      const switchEl = state.elements.find(e => e.name === 'Stay signed in')
      expect(switchEl).toBeDefined()

      const result = await adapter.execute({ type: 'longpress', ref: switchEl!.ref, duration: 2000 })
      expect(result.success).toBe(true)

      expect(mockDriver._pointerAction.pause).toHaveBeenCalledWith(2000)
      expect(mockDriver._pointerAction.down).toHaveBeenCalledWith({ button: 0 })
      expect(mockDriver._pointerAction.up).toHaveBeenCalledWith({ button: 0 })
    })

    it('defaults to 1000ms duration', async () => {
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      const switchEl = state.elements.find(e => e.name === 'Stay signed in')

      await adapter.execute({ type: 'longpress', ref: switchEl!.ref })
      expect(mockDriver._pointerAction.pause).toHaveBeenCalledWith(1000)
    })
  })

  describe('execute — unsupported actions', () => {
    it('navigate returns error', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'navigate', url: 'https://example.com' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('not supported')
    })

    it('hover returns error', async () => {
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      const el = state.elements[0]
      const result = await adapter.execute({ type: 'hover', ref: el.ref })
      expect(result.success).toBe(false)
      expect(result.error).toContain('web-only')
    })
  })

  describe('execute — openLink', () => {
    it('passes explicit iOS bundle id to the deep-link helper', async () => {
      await adapter.setup({ platform: 'ios' })

      const result = await adapter.execute({
        type: 'openLink',
        url: 'wdio://forms',
        bundleId: 'org.reactjs.native.example.wdiodemoapp',
      })

      expect(result.success).toBe(true)
      expect(mockDriver.deepLink).toHaveBeenCalledWith(
        'wdio://forms',
        'org.reactjs.native.example.wdiodemoapp',
        true,
      )
    })

    it('ignores empty appId and uses explicit iOS bundle id for deep links', async () => {
      await adapter.setup({ platform: 'ios' })

      const result = await adapter.execute({
        type: 'openLink',
        url: 'wdio://swipe',
        appId: '',
        bundleId: 'org.wdiodemoapp',
      })

      expect(result.success).toBe(true)
      expect(mockDriver.deepLink).toHaveBeenCalledWith(
        'wdio://swipe',
        'org.wdiodemoapp',
        true,
      )
    })

    it('falls back to setup bundle id for deep links', async () => {
      await adapter.setup({ platform: 'ios', bundleId: 'org.reactjs.native.example.wdiodemoapp' })
      mockDriver.deepLink.mockClear()

      const result = await adapter.execute({ type: 'openLink', url: 'wdio://drag' })

      expect(result.success).toBe(true)
      expect(mockDriver.deepLink).toHaveBeenCalledWith(
        'wdio://drag',
        'org.reactjs.native.example.wdiodemoapp',
        true,
      )
    })

    it('fails native-scheme links when no iOS bundle id is available', async () => {
      await adapter.setup({ platform: 'ios' })

      const result = await adapter.execute({ type: 'openLink', url: 'wdio://forms' })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing iOS bundle id')
    })
  })

  describe('execute — waitFor', () => {
    it('pauses for specified timeout', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'waitFor', condition: 'loading', timeout: 2000 })
      expect(result.success).toBe(true)
      expect(mockDriver.pause).toHaveBeenCalledWith(2000)
    })
  })

  describe('execute — delay', () => {
    it('pauses for exactly action.ms (required field, no fallback)', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'delay', ms: 2500 })
      expect(result.success).toBe(true)
      expect(mockDriver.pause).toHaveBeenCalledWith(2500)
    })
  })

  describe('execute — keypress', () => {
    it('sends mapped key code for single key', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Backspace'] })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledTimes(1)
      expect(mockDriver.keys).toHaveBeenCalledWith(['\uE003'])
    })

    it('iterates multiple keys in order with KEY_MAP lookup', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Backspace', 'Space', 'ArrowLeft'] })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledTimes(3)
      expect(mockDriver.keys).toHaveBeenNthCalledWith(1, ['\uE003'])
      expect(mockDriver.keys).toHaveBeenNthCalledWith(2, ['\uE00D'])
      expect(mockDriver.keys).toHaveBeenNthCalledWith(3, ['\uE012'])
    })

    it('falls back to raw string when key is not in KEY_MAP', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'keypress', keys: ['x'] })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledWith(['x'])
    })

    it('ignores convertPlatformKeys flag (no-op on mobile)', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Backspace'], convertPlatformKeys: false })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledWith(['\uE003'])
    })
  })

  describe('execute — assert', () => {
    it('returns success (handled by agent core)', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'assert', condition: 'element visible' })
      expect(result.success).toBe(true)
    })
  })

  describe('screenshot', () => {
    it('returns PNG buffer from base64', async () => {
      await adapter.setup({ platform: 'ios' })
      mockDriver.getWindowSize.mockResolvedValue({ width: 393, height: 852 })
      mockDriver.takeScreenshot.mockResolvedValue(create1179x2556PngBase64())
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
      await adapter.setup({ platform: 'ios' })
      await adapter.observe()

      mockDriver._pointerAction.perform.mockRejectedValueOnce(new Error('touch failed'))

      const state = await adapter.observe()
      const el = state.elements.find(e => e.name === 'Log In')
      const result = await adapter.execute({ type: 'tap', ref: el!.ref })

      expect(result.success).toBe(false)
      expect(result.error).toBe('touch failed')
      expect(result.screenshot).toBeInstanceOf(Buffer)
    })
  })

  describe('execute — swipe', () => {
    it('performs directional swipe gesture', async () => {
      await adapter.setup({ platform: 'ios' })
      await adapter.observe()

      const result = await adapter.execute({ type: 'swipe', direction: 'right' })
      expect(result.success).toBe(true)

      expect(mockDriver.action).toHaveBeenCalledWith('pointer', { parameters: { pointerType: 'touch' } })
      expect(mockDriver._pointerAction.perform).toHaveBeenCalled()
    })
  })

  describe('execute — click (alias for tap)', () => {
    it('performs tap for click action', async () => {
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      const el = state.elements.find(e => e.name === 'Log In')

      const result = await adapter.execute({ type: 'click', ref: el!.ref })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.perform).toHaveBeenCalled()
    })
  })

  describe('screenshot — stage-2 physical→logical alignment (D-05)', () => {
    it('resizes 1179x2556 physical buffer to 393x852 logical buffer matching getWindowSize', async () => {
      await adapter.setup({ platform: 'ios' })
      mockDriver.getWindowSize.mockResolvedValue({ width: 393, height: 852 })
      mockDriver.takeScreenshot.mockResolvedValue(create1179x2556PngBase64())

      const buf = await adapter.screenshot()
      expect(buf).toBeInstanceOf(Buffer)

      const dims = readPngDims(buf!)
      expect(dims).not.toBeNull()
      expect(dims!.width).toBe(393)
      expect(dims!.height).toBe(852)
    })

    it('re-reads getWindowSize on every screenshot call (no caching — D-05, Pitfall 8)', async () => {
      await adapter.setup({ platform: 'ios' })
      mockDriver.getWindowSize.mockResolvedValue({ width: 393, height: 852 })
      mockDriver.takeScreenshot.mockResolvedValue(create1179x2556PngBase64())

      mockDriver.getWindowSize.mockClear()
      await adapter.screenshot()
      await adapter.screenshot()
      await adapter.screenshot()
      expect(mockDriver.getWindowSize).toHaveBeenCalledTimes(3)
    })

    it('returns undefined when takeScreenshot fails (no alignment attempted)', async () => {
      await adapter.setup({ platform: 'ios' })
      mockDriver.takeScreenshot.mockRejectedValueOnce(new Error('session closed'))
      const buf = await adapter.screenshot()
      expect(buf).toBeUndefined()
    })

    it('returns raw buffer when alignment fails (best-effort fallback)', async () => {
      await adapter.setup({ platform: 'ios' })
      mockDriver.getWindowSize.mockRejectedValueOnce(new Error('getWindowSize failed'))
      mockDriver.takeScreenshot.mockResolvedValue(create1179x2556PngBase64())
      const buf = await adapter.screenshot()
      // Should return SOMETHING (raw), not undefined
      expect(buf).toBeInstanceOf(Buffer)
    })
  })

  describe('execute — coordinate passthrough (tapCoordinate, swipe, pinch, multiTap)', () => {
    it('tapCoordinate passes LLM coords directly to driver', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'tapCoordinate', x: 100, y: 200 })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 100, y: 200 })
      expect(result.coordinates).toEqual({ x: 100, y: 200 })
    })

    it('tapCoordinate passes arbitrary coords unchanged', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'tapCoordinate', x: 200, y: 400 })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 200, y: 400 })
      expect(result.coordinates).toEqual({ x: 200, y: 400 })
    })

    it('swipe passes 4 coords directly to driver', async () => {
      await adapter.setup({ platform: 'ios' })
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
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'pinch', scale: 0.5, x: 100, y: 200 })
      expect(result.success).toBe(true)
      expect(result.coordinates).toEqual({ x: 100, y: 200 })
    })

    it('multiTap center coords pass directly to driver', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'multiTap', fingers: 2, x: 100, y: 200 })
      expect(result.success).toBe(true)
    })

    it('large coords pass through unchanged (viewport-space contract)', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'tapCoordinate', x: 800, y: 400 })
      expect(result.coordinates).toEqual({ x: 800, y: 400 })
    })
  })
})
