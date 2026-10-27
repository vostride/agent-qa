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

const IOS_SHEET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Bluesky" label="Bluesky" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0">
    <XCUIElementTypeWindow type="XCUIElementTypeWindow" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0">
      <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" accessible="false" x="0" y="474" width="402" height="400" index="0">
        <XCUIElementTypeOther type="XCUIElementTypeOther" name="profileHeaderDropdownMuteBtn" label="Mute account" enabled="true" visible="true" accessible="true" x="31" y="715" width="340" height="43" index="4" traits=""/>
        <XCUIElementTypeOther type="XCUIElementTypeOther" name="profileHeaderDropdownBlockBtn" label="Block account" enabled="true" visible="true" accessible="true" x="31" y="758" width="340" height="43" index="5" traits=""/>
        <XCUIElementTypeOther type="XCUIElementTypeOther" name="profileHeaderDropdownReportBtn" label="Report account" enabled="true" visible="true" accessible="true" x="31" y="801" width="340" height="43" index="6" traits=""/>
      </XCUIElementTypeOther>
    </XCUIElementTypeWindow>
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

const WDIO_DEEP_LINK_REJECTION =
  'The provided link is not a valid deep link URL. If your url is a `universal deep link` then use the `url` command instead.'

function createMockDriver() {
  const pointerAction = createMockPointerAction()

  const driver = {
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
    // WebdriverIO 9.24's built-in deepLink: rejects http(s) and scheme-less links on the client.
    deepLink: vi.fn(async (link: string, appIdentifier?: string): Promise<unknown> => {
      if (!/^(?!https?:\/\/)[a-zA-Z][\w+\-.]*:\/\//.test(link)) throw new Error(WDIO_DEEP_LINK_REJECTION)
      if (!appIdentifier) {
        throw new Error('When using a deep link URL for iOS, you need to provide the `bundleId` of the app that the deep link should open.')
      }
      return driver.execute('mobile:deepLink', { url: link, bundleId: appIdentifier })
    }),
    url: vi.fn().mockRejectedValue(new Error('not supported')),
    $: vi.fn().mockResolvedValue({ clearValue: vi.fn(), setValue: vi.fn() }),
    $$: vi.fn().mockResolvedValue([]),
    _pointerAction: pointerAction,
  }
  return driver
}

vi.mock('webdriverio', () => ({
  remote: vi.fn(),
}))

import { IOSPlatformAdapter } from '../adapter.js'
import type { PlatformAdapter, PlatformConfig } from '@vostride/agent-qa-runner'
import type { LiveFrame } from '@vostride/agent-qa-schema'
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
        device: { name: 'iphone-15', platform: 'ios', match: { automationName: 'XCUITest', platformVersion: '17.0', deviceName: 'iPhone 15', app: '/path/to/app.app' } },
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

      expect(state.platform).toBe('ios')
      expect(state.tree).toContain('text "Welcome"')
      expect(state.tree).toContain('textbox "Email"')
      expect(state.tree).toContain('textbox "Password"')
      expect(state.tree).toContain('button "Log In"')
      expect(state.elements.length).toBeGreaterThanOrEqual(5)
      expect(state.timestamp).toBeGreaterThan(0)
      expect(state.refMap).toBeDefined()
      expect(state.metadata.captureMode).toBe('textOnly')
    })

    it('throws if adapter not initialized', async () => {
      await expect(adapter.observe()).rejects.toThrow('not initialized')
    })
  })

  describe('C437-TREE-TOGGLE — adapter-level iOS tree', () => {
    it('a switch with value "1" renders [checked] and one with value "0" does not', async () => {
      mockDriver.getPageSource.mockResolvedValue(
        IOS_XML.replace('label="Stay signed in" value="0"', 'label="Stay signed in" value="1"'),
      )
      await adapter.setup({ platform: 'ios' })
      const on = await adapter.observe()
      expect(on.tree).toContain('- switch "Stay signed in" [ref=e5] @(50,400 290x40) [checked]')

      mockDriver.getPageSource.mockResolvedValue(IOS_XML)
      const off = await adapter.observe()
      expect(off.tree).toContain('- switch "Stay signed in" [ref=e5] @(50,400 290x40)\n')
      expect(off.tree).not.toContain('[checked]')
    })
  })

  describe('observe — accessible labelled Others (P4)', () => {
    it('observes the Bluesky sheet row as a button and taps its centre', async () => {
      mockDriver.getPageSource.mockResolvedValue(IOS_SHEET_XML)
      mockDriver.getWindowSize.mockResolvedValue({ width: 402, height: 874 })
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()

      expect(state.tree).toContain('button "Mute account" [ref=')
      expect(state.tree).toContain('button "Block account" [ref=')
      expect(state.tree).toContain('button "Report account" [ref=')

      const mute = state.elements.find(e => e.name === 'Mute account')!
      const result = await adapter.execute({ type: 'tap', ref: mute.ref })
      expect(result.success).toBe(true)
      // 31 + 340/2 = 201, 715 + 43/2 = 736.5 → 737
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 201, y: 737 })
    })

    it('leaves the login fixture (unflagged full-screen Other) unchanged', async () => {
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      expect(state.elements.map(e => e.name)).toEqual([
        'Welcome',
        'Email',
        'Password',
        'Log In',
        'Stay signed in',
        'Logo',
      ])
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

  // C437-IOS-TAP-HOLD (437-09): a zero-duration touch flipped an iOS 27 Settings switch knob 2 of
  // 11 times live; the same touch held 100 ms between down and up flipped it every time.
  describe('C437-IOS-TAP-HOLD — single taps hold the touch between down and up', () => {
    function chainSteps(): string[] {
      const chain = mockDriver._pointerAction
      const steps: Array<[number, string]> = []
      for (const name of ['move', 'down', 'pause', 'up'] as const) {
        const fn = chain[name] as ReturnType<typeof vi.fn>
        fn.mock.calls.forEach((args: unknown[], i: number) => {
          steps.push([fn.mock.invocationCallOrder[i], name === 'pause' ? `pause:${String(args[0])}` : name])
        })
      }
      return steps.sort((a, b) => a[0] - b[0]).map(([, step]) => step)
    }

    it('a ref tap is move, down, pause 100, up', async () => {
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      const logIn = state.elements.find(e => e.name === 'Log In')
      const result = await adapter.execute({ type: 'tap', ref: logIn!.ref })
      expect(result.success).toBe(true)
      expect(chainSteps()).toEqual(['move', 'down', 'pause:100', 'up'])
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 195, y: 345 })
    })

    it('a coordinate tap is move, down, pause 100, up', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'tapCoordinate', x: 100, y: 200, coordSpace: 'viewport' })
      expect(result.success).toBe(true)
      expect(chainSteps()).toEqual(['move', 'down', 'pause:100', 'up'])
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 100, y: 200 })
    })

    it('a double tap keeps its own unheld chain', async () => {
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      const logIn = state.elements.find(e => e.name === 'Log In')
      const result = await adapter.execute({ type: 'doubleTap', ref: logIn!.ref })
      expect(result.success).toBe(true)
      expect(chainSteps()).toEqual(['move', 'down', 'up', 'pause:50', 'down', 'up'])
    })
  })

  describe('execute — fill', () => {
    it('taps to focus then types the schema Fill compound via element setValue', async () => {
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()

      const emailEl = state.elements.find(e => e.name === 'Email')
      expect(emailEl).toBeDefined()

      // Mock the own-element lookup ($$ by type + rect) and the keyboard-focus read the fill
      // compound uses after tap-to-focus. The element has no getAttribute, so the re-read
      // degrades to undefined ⇒ success with no fillReread, recorded unverified.
      const mockElement = { elementId: 'email', isExisting: vi.fn().mockResolvedValue(true), clearValue: vi.fn(), setValue: vi.fn() }
      mockDriver.$$ = vi.fn().mockImplementation((selector: string) =>
        Promise.resolve(selector === '-ios class chain:**/XCUIElementTypeTextField' ? [mockElement] : []))
      Object.assign(mockDriver, {
        getElementRect: vi.fn().mockResolvedValue({ x: 50, y: 180, width: 290, height: 44 }),
        getActiveElement: vi.fn().mockResolvedValue({ 'element-6066-11e4-a52e-4f735a1b0f2d': 'email' }),
      })

      const result = await adapter.execute({ type: 'fill', ref: emailEl!.ref, text: 'user@test.com', clearMode: 'replace', submit: false })
      expect(result.success).toBe(true)
      expect(mockElement.setValue).toHaveBeenCalledWith('user@test.com')
      expect(result.metadata).toEqual({ fillVerdict: { verb: 'fill', verdict: 'unverified' } })

      // Tap to focus fires a pointer action
      expect(mockDriver._pointerAction.perform).toHaveBeenCalled()
    })
  })

  describe('execute — nativeSelect', () => {
    it('sets a direct iOS picker-wheel value', async () => {
      mockDriver.getPageSource.mockResolvedValue(IOS_PICKER_WHEEL_XML)
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      const pickerWheelEl = state.elements.find(e => e.role === 'pickerwheel')
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
      const wheelRefs = state.elements.filter(e => e.role === 'pickerwheel')
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
      const pickerEl = state.elements.find(e => e.role === 'combobox')
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
      const pickerEl = state.elements.find(e => e.role === 'combobox')

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

  })

  describe('execute — scroll', () => {
    it('performs a schema-Scroll direction gesture and carries scrollUntilVisible metadata', async () => {
      await adapter.setup({ platform: 'ios' })
      await adapter.observe()

      const result = await adapter.execute({ type: 'scroll', mode: 'direction', direction: 'down', amount: 'page', retryOpposite: false })
      expect(result.success).toBe(true)

      // ONE ActionResult carries the compound outcome on metadata. iOS swipes prove nothing about
      // movement, so a direction gesture is one swipe that stays unresolved.
      expect(result.metadata?.scrollUntilVisible).toEqual({ swipes: 1, reversedOnce: false, outcome: 'unresolved', endedBy: 'max-swipes' })
      expect(mockDriver._pointerAction.perform).toHaveBeenCalledTimes(1)
      // A page-sized inverted-finger swipe fired via the pointer action.
      expect(mockDriver.action).toHaveBeenCalledWith('pointer', { parameters: { pointerType: 'touch' } })
      expect(mockDriver._pointerAction.perform).toHaveBeenCalled()
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

  describe('execute — openUniversalLink (re-key of openLink, D-19)', () => {
    const LINK = 'https://bsky.app/hashtag/caturday'
    const APP = 'xyz.blueskyweb.app'
    const OTHER = 'com.example.other'
    const SAFARI = 'com.apple.mobilesafari'
    const SPRINGBOARD = 'com.apple.springboard'

    // Scripts the foreground: the first entry answers the read before the open, the rest answer
    // the hand-off reads in order, and the last entry repeats. An Error entry makes that read throw.
    function scriptForeground(
      reads: Array<string | Error | Record<string, unknown>>,
      opts: { deepLinkError?: Error } = {},
    ) {
      const queue = [...reads]
      mockDriver.execute.mockImplementation(async (cmd: string) => {
        if (cmd === 'mobile: deepLink' && opts.deepLinkError) throw opts.deepLinkError
        if (cmd !== 'mobile: activeAppInfo') return undefined
        const next = queue.length > 1 ? queue.shift()! : queue[0]
        if (next instanceof Error) throw next
        if (typeof next === 'string') {
          return { bundleId: next, name: 'App', pid: 1, processArguments: { args: ['--token=PROCESS_SECRET'] } }
        }
        return next
      })
    }

    const foregroundReads = () =>
      mockDriver.execute.mock.calls.filter(c => c[0] === 'mobile: activeAppInfo').length
    const deepLinkExecutes = () =>
      mockDriver.execute.mock.calls.filter(c => c[0] === 'mobile: deepLink')

    beforeEach(() => {
      mockDriver.url.mockResolvedValue(undefined)
    })

    afterEach(() => {
      expect(mockDriver.deepLink).not.toHaveBeenCalled()
    })

    describe('explicit bundle id', () => {
      it('opens an https link in the named app through mobile: deepLink, with no hand-off check', async () => {
        await adapter.setup({ platform: 'ios' })

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK, bundleId: APP })

        expect(result).toEqual({ success: true })
        expect(mockDriver.execute).toHaveBeenCalledWith('mobile: deepLink', { url: LINK, bundleId: APP })
        expect(foregroundReads()).toBe(0)
        expect(mockDriver.url).not.toHaveBeenCalled()
        expect(mockDriver.pause).not.toHaveBeenCalled()
      })

      it.each([
        ['wdio://forms', 'org.reactjs.native.example.wdiodemoapp'],
        ['wdio://swipe', 'org.wdiodemoapp'],
      ])('opens the custom-scheme link %s in %s through mobile: deepLink', async (url, bundleId) => {
        await adapter.setup({ platform: 'ios' })

        const result = await adapter.execute({ type: 'openUniversalLink', url, bundleId })

        expect(result.success).toBe(true)
        expect(mockDriver.execute).toHaveBeenCalledWith('mobile: deepLink', { url, bundleId })
        expect(foregroundReads()).toBe(0)
        expect(mockDriver.url).not.toHaveBeenCalled()
      })

      it('opens the link in Safari when com.apple.mobilesafari is named, with no hand-off check', async () => {
        await adapter.setup({ platform: 'ios' })

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK, bundleId: SAFARI })

        expect(result.success).toBe(true)
        expect(mockDriver.execute).toHaveBeenCalledWith('mobile: deepLink', { url: LINK, bundleId: SAFARI })
        expect(foregroundReads()).toBe(0)
        expect(mockDriver.url).not.toHaveBeenCalled()
        expect(mockDriver.pause).not.toHaveBeenCalled()
      })

      it('reports the named app and the cause when the open fails, without falling back', async () => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([APP], { deepLinkError: new Error('app is not installed') })

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK, bundleId: APP })

        expect(result).toEqual({
          success: false,
          error: `Failed to open universal link ${LINK} in iOS app ${APP}: app is not installed`,
        })
        expect(mockDriver.url).not.toHaveBeenCalled()
      })
    })

    describe('configured bundle id', () => {
      it('opens an https link in the configured app through mobile: deepLink', async () => {
        await adapter.setup({ platform: 'ios', bundleId: APP })
        mockDriver.activateApp.mockClear()

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(true)
        expect(mockDriver.execute).toHaveBeenCalledWith('mobile: deepLink', { url: LINK, bundleId: APP })
        expect(mockDriver.url).not.toHaveBeenCalled()
        expect(foregroundReads()).toBe(0)
      })

      it('falls back to system routing when the configured open fails, and checks the hand-off', async () => {
        await adapter.setup({ platform: 'ios', bundleId: APP })
        mockDriver.activateApp.mockClear()
        scriptForeground([APP, APP], { deepLinkError: new Error('scoped open refused\nstack line') })

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(true)
        expect(deepLinkExecutes()).toEqual([['mobile: deepLink', { url: LINK, bundleId: APP }]])
        expect(mockDriver.url).toHaveBeenCalledWith(LINK)
        expect(foregroundReads()).toBeGreaterThanOrEqual(2)
        expect(mockDriver.activateApp).not.toHaveBeenCalled()
      })

      it('names the configured app and its error when the system open fails too', async () => {
        await adapter.setup({ platform: 'ios', bundleId: APP })
        scriptForeground([APP], { deepLinkError: new Error('scoped open refused\nstack line') })
        mockDriver.url.mockRejectedValue(new Error('openurl failed\nmore'))

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(false)
        expect(result.error).toContain(LINK)
        expect(result.error).toContain('openurl failed')
        expect(result.error).toContain(APP)
        expect(result.error).toContain('scoped open refused')
        expect(result.error).not.toContain('stack line')
        expect(result.error).not.toContain('more')
      })

      it('opens a custom-scheme link in the configured app through mobile: deepLink', async () => {
        await adapter.setup({ platform: 'ios', bundleId: 'org.reactjs.native.example.wdiodemoapp' })

        const result = await adapter.execute({ type: 'openUniversalLink', url: 'wdio://drag' })

        expect(result.success).toBe(true)
        expect(mockDriver.execute).toHaveBeenCalledWith('mobile: deepLink', {
          url: 'wdio://drag',
          bundleId: 'org.reactjs.native.example.wdiodemoapp',
        })
        expect(mockDriver.url).not.toHaveBeenCalled()
      })
    })

    it('fails native-scheme links when no iOS bundle id is available', async () => {
      await adapter.setup({ platform: 'ios' })

      const result = await adapter.execute({ type: 'openUniversalLink', url: 'wdio://forms' })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Missing iOS bundle id for native deep link: wdio://forms')
      expect(mockDriver.execute).not.toHaveBeenCalled()
      expect(mockDriver.url).not.toHaveBeenCalled()
    })

    describe('system routing (no bundle id given or configured)', () => {
      it.each([
        ['no bundleId', {}],
        ['an empty bundleId', { bundleId: '' }],
      ])('lets the app that claims the link open it, with %s', async (_label, extra) => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([APP, APP])

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK, ...extra })

        expect(result).toEqual({ success: true })
        expect(mockDriver.url).toHaveBeenCalledTimes(1)
        expect(mockDriver.url).toHaveBeenCalledWith(LINK)
        expect(mockDriver.pause.mock.calls.length).toBeLessThanOrEqual(12)
        expect(deepLinkExecutes()).toEqual([])
        expect(mockDriver.activateApp).not.toHaveBeenCalled()
      })

      it('succeeds after one pause when iOS hands the link to another app', async () => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([APP, OTHER])

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(true)
        expect(mockDriver.pause).toHaveBeenCalledTimes(1)
        expect(mockDriver.pause).toHaveBeenCalledWith(500)
        expect(foregroundReads()).toBe(2)
        expect(mockDriver.activateApp).not.toHaveBeenCalled()
      })

      it('fails and returns to the previous app when iOS opens the link in Safari', async () => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([APP, APP, SAFARI])

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(false)
        expect(result.error).toContain(LINK)
        expect(result.error).toContain('Safari')
        expect(result.error).toContain(APP)
        expect(result.error).toContain('bundleId')
        expect(result.error).not.toContain('PROCESS_SECRET')
        expect(result.error!.endsWith(`Returned to ${APP}.`)).toBe(true)
        expect(mockDriver.pause).toHaveBeenCalledTimes(2)
        expect(mockDriver.activateApp).toHaveBeenCalledWith(APP)
        expect(deepLinkExecutes()).toEqual([])
      })

      it('says so when the previous app cannot be re-activated', async () => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([APP, SAFARI])
        mockDriver.activateApp.mockRejectedValue(new Error('activation refused\ndetail'))

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(false)
        expect(result.error!.endsWith(`Could not return to ${APP}: activation refused.`)).toBe(true)
      })

      it('decides on the first decisive read: Safari then an app fails after one pause', async () => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([APP, SAFARI, OTHER])

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(false)
        expect(result.error).toContain('Safari')
        expect(mockDriver.pause).toHaveBeenCalledTimes(1)
        expect(foregroundReads()).toBe(2)
        expect(mockDriver.activateApp).toHaveBeenCalledWith(APP)
      })

      it('never decides on a SpringBoard read: SpringBoard then Safari fails after two pauses', async () => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([APP, SPRINGBOARD, SAFARI])

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(false)
        expect(result.error).toContain('Safari')
        expect(mockDriver.pause).toHaveBeenCalledTimes(2)
        expect(foregroundReads()).toBe(3)
        expect(mockDriver.activateApp).toHaveBeenCalledWith(APP)
      })

      it('polls to the bound when no read is decisive, and the last read decides', async () => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([APP])

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(true)
        expect(mockDriver.pause).toHaveBeenCalledTimes(12)
        expect(foregroundReads()).toBe(13)
      })

      it('catches a cold Safari launch that comes to the front after about 3.5 s', async () => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([APP, APP, APP, APP, APP, APP, APP, SAFARI])

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(false)
        expect(result.error).toContain(`iOS opened ${LINK} in Safari`)
        expect(mockDriver.pause).toHaveBeenCalledTimes(7)
        expect(foregroundReads()).toBe(8)
        expect(mockDriver.activateApp).toHaveBeenCalledWith(APP)
      })

      it('never scopes to SpringBoard: from the home screen to Safari fails without re-activating', async () => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([SPRINGBOARD, SAFARI])

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(false)
        expect(result.error).toContain('Safari')
        expect(result.error).toContain(SPRINGBOARD)
        expect(result.error).not.toContain('Returned to')
        expect(result.error).not.toContain('Could not return')
        expect(mockDriver.activateApp).not.toHaveBeenCalled()
        expect(mockDriver.url).toHaveBeenCalledWith(LINK)
        expect(deepLinkExecutes()).toEqual([])
      })

      it('succeeds with no polls when Safari is already in front', async () => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([SAFARI])

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(true)
        expect(mockDriver.url).toHaveBeenCalledWith(LINK)
        expect(foregroundReads()).toBe(1)
        expect(mockDriver.pause).not.toHaveBeenCalled()
        expect(deepLinkExecutes()).toEqual([])
      })

      it.each([
        ['activeAppInfo rejects', new Error('unknown command')],
        ['activeAppInfo has no bundle id', {}],
      ])('opens through the system handler with no polls when %s', async (_label, info) => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([info])

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(true)
        expect(mockDriver.url).toHaveBeenCalledWith(LINK)
        expect(foregroundReads()).toBe(1)
        expect(mockDriver.pause).not.toHaveBeenCalled()
      })

      it('fails naming the URL and the cause when the system open rejects', async () => {
        await adapter.setup({ platform: 'ios' })
        scriptForeground([APP])
        mockDriver.url.mockRejectedValue(new Error('simctl openurl failed\nstderr tail'))

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(result.success).toBe(false)
        expect(result.error).toContain(LINK)
        expect(result.error).toContain('simctl openurl failed')
        expect(result.error).not.toContain('stderr tail')
        expect(mockDriver.pause).not.toHaveBeenCalled()
      })

      it('takes system routing after a WEBVIEW read, because every action runs from NATIVE_APP', async () => {
        Object.assign(mockDriver, {
          getContexts: vi.fn().mockResolvedValue(['NATIVE_APP', 'WEBVIEW_1']),
          switchContext: vi.fn().mockResolvedValue(undefined),
        })
        await adapter.setup({ platform: 'ios' })
        scriptForeground([APP, APP])
        await adapter.execute({ type: 'assertValue', expr: '1', op: 'isDefined' })
        const switchContext = (mockDriver as unknown as { switchContext: ReturnType<typeof vi.fn> }).switchContext
        expect(switchContext).toHaveBeenLastCalledWith('WEBVIEW_1')

        const result = await adapter.execute({ type: 'openUniversalLink', url: LINK })

        expect(switchContext).toHaveBeenLastCalledWith('NATIVE_APP')
        expect(result.success).toBe(true)
        expect(mockDriver.url).toHaveBeenCalledWith(LINK)
        expect(deepLinkExecutes()).toEqual([])
      })
    })
  })

  describe('execute — waitFor (schema on-modes replace legacy condition/timeout)', () => {
    it('on:"selector" returns a §7.1 web-only error on native iOS', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'waitFor', on: 'selector', selector: '#done', timeoutMs: 500 })
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/web|selector/i)
    })

    it('on:"text" succeeds immediately when the text is already in the page source', async () => {
      await adapter.setup({ platform: 'ios' })
      mockDriver.getPageSource.mockResolvedValue('<XCUIElementTypeStaticText value="Ready" />')
      const result = await adapter.execute({ type: 'waitFor', on: 'text', text: 'Ready', timeoutMs: 2000 })
      expect(result.success).toBe(true)
    })

    it('on:"text" times out with a §7.1 error when the text never appears', async () => {
      await adapter.setup({ platform: 'ios' })
      mockDriver.getPageSource.mockResolvedValue('<XCUIElementTypeOther />')
      const result = await adapter.execute({ type: 'waitFor', on: 'text', text: 'Never', timeoutMs: 20 })
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/did not appear/i)
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

  describe('execute — keypress (schema mode gate: press-only on mobile)', () => {
    it('sends mapped key code for single key', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Backspace'], mode: 'press' })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledTimes(1)
      expect(mockDriver.keys).toHaveBeenCalledWith(['\uE003'])
    })

    it('iterates multiple keys in order with KEY_MAP lookup', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Backspace', 'Space', 'ArrowLeft'], mode: 'press' })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledTimes(3)
      expect(mockDriver.keys).toHaveBeenNthCalledWith(1, ['\uE003'])
      expect(mockDriver.keys).toHaveBeenNthCalledWith(2, ['\uE00D'])
      expect(mockDriver.keys).toHaveBeenNthCalledWith(3, ['\uE012'])
    })

    it('falls back to raw string when key is not in KEY_MAP', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'keypress', keys: ['x'], mode: 'press' })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledWith(['x'])
    })

    it('ignores convertPlatformKeys flag (no-op on mobile)', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'keypress', keys: ['Backspace'], mode: 'press', convertPlatformKeys: false })
      expect(result.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalledWith(['\uE003'])
    })
  })

  describe('execute — keypress hold/release gate', () => {
    it('mode:"down"/"up" (key hold/release) returns a §7.1 press-only error', async () => {
      await adapter.setup({ platform: 'ios' })
      const up = await adapter.execute({ type: 'keypress', keys: ['Shift'], mode: 'up' })
      expect(up.success).toBe(false)
      expect(up.error).toMatch(/press|web-only|hold/i)
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

      const result = await adapter.execute({ type: 'swipe', mode: 'direction', direction: 'right', durationMs: 300 })
      expect(result.success).toBe(true)

      expect(mockDriver.action).toHaveBeenCalledWith('pointer', { parameters: { pointerType: 'touch' } })
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
      const result = await adapter.execute({ type: 'tapCoordinate', x: 100, y: 200, coordSpace: 'viewport' })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 100, y: 200 })
      expect(result.coordinates).toEqual({ x: 100, y: 200 })
    })

    it('tapCoordinate passes arbitrary coords unchanged', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'tapCoordinate', x: 200, y: 400, coordSpace: 'viewport' })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.move).toHaveBeenCalledWith({ x: 200, y: 400 })
      expect(result.coordinates).toEqual({ x: 200, y: 400 })
    })

    it('swipe passes 4 coords directly to driver', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({
        type: 'swipe',
        mode: 'path',
        from: { x: 100, y: 200 }, to: { x: 300, y: 400 },
        coordSpace: 'viewport', durationMs: 300,
      })
      expect(result.success).toBe(true)
      expect(mockDriver._pointerAction.move).toHaveBeenNthCalledWith(1, { x: 100, y: 200 })
      expect(mockDriver._pointerAction.move).toHaveBeenNthCalledWith(2, { x: 300, y: 400, duration: 300 })
      expect(result.startCoordinates).toEqual({ x: 100, y: 200 })
      expect(result.endCoordinates).toEqual({ x: 300, y: 400 })
    })

    it('pinch center coords pass directly to driver', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'pinch', scale: 0.5, x: 100, y: 200, coordSpace: 'viewport' })
      expect(result.success).toBe(true)
      expect(result.coordinates).toEqual({ x: 100, y: 200 })
    })

    it('multiTap center coords pass directly to driver', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'multiTap', fingers: 2, x: 100, y: 200, coordSpace: 'viewport' })
      expect(result.success).toBe(true)
    })

    it('large coords pass through unchanged (viewport-space contract)', async () => {
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'tapCoordinate', x: 800, y: 400, coordSpace: 'viewport' })
      expect(result.coordinates).toEqual({ x: 800, y: 400 })
    })
  })

  describe('liveStream (428 D-11)', () => {
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
      await adapter.setup({ platform: 'ios' })
      const spies = contextSpies()
      const stream = (adapter as PlatformAdapter<'ios'>).liveStream
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
      const early = (adapter as PlatformAdapter<'ios'>).liveStream
      expect(early?.kind, 'declared before setup, so selection never reaches screenshot()').toBe('snapshot')
      await adapter.setup({ platform: 'ios' })
      const stream = (adapter as PlatformAdapter<'ios'>).liveStream
      expect(stream).toBe(early)
      expect((adapter as PlatformAdapter<'ios'>).liveStream).toBe(stream)
      const stop = vi.spyOn(stream!, 'stop')
      await stream!.start(() => {})
      await adapter.cleanup()
      expect(stop).toHaveBeenCalledTimes(1)
      expect((adapter as PlatformAdapter<'ios'>).liveStream).not.toBe(stream)
    })
  })
})
