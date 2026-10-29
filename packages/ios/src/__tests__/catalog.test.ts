import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Driver-call contract for each iOS verb against a call-logging mocked driver; no live Appium.

const IOS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="TestApp" label="TestApp" x="0" y="0" width="390" height="844">
    <XCUIElementTypeOther x="0" y="0" width="390" height="844">
      <XCUIElementTypeTextField label="Email" value="" x="50" y="180" width="290" height="44" enabled="true" />
      <XCUIElementTypePickerWheel label="Month" value="January" x="50" y="300" width="290" height="120" enabled="true" />
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication>
</AppiumAUT>`

const SCREENSHOT_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let calls: string[] = []

function createMockPointerAction() {
  const chain: Record<string, any> = {}
  chain.move = vi.fn().mockImplementation((p: unknown) => { calls.push(`move:${JSON.stringify(p)}`); return chain })
  chain.down = vi.fn().mockReturnValue(chain)
  chain.up = vi.fn().mockReturnValue(chain)
  chain.pause = vi.fn().mockReturnValue(chain)
  chain.perform = vi.fn().mockResolvedValue(undefined)
  return chain
}

function createMockElement() {
  return {
    isExisting: vi.fn().mockResolvedValue(true),
    setValue: vi.fn().mockResolvedValue(undefined),
    addValue: vi.fn().mockResolvedValue(undefined),
    clearValue: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn().mockResolvedValue(null),
    getValue: vi.fn().mockResolvedValue(''),
    elementId: 'elem-123',
  }
}
let mockElement: ReturnType<typeof createMockElement>

// `listApps` throwing is the simulator signal.
let listAppsThrows: boolean

function createMockDriver() {
  const pointerAction = createMockPointerAction()
  return {
    getPageSource: vi.fn().mockImplementation(() => { calls.push('getPageSource'); return Promise.resolve(IOS_XML) }),
    getWindowSize: vi.fn().mockResolvedValue({ width: 390, height: 844 }),
    takeScreenshot: vi.fn().mockResolvedValue(SCREENSHOT_BASE64),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    action: vi.fn().mockReturnValue(pointerAction),
    actions: vi.fn().mockImplementation(() => { calls.push('actions'); return Promise.resolve(undefined) }),
    keys: vi.fn().mockImplementation((k: unknown) => { calls.push(`keys:${JSON.stringify(k)}`); return Promise.resolve() }),
    pause: vi.fn().mockImplementation((ms: number) => { calls.push(`pause:${ms}`); return Promise.resolve() }),
    hideKeyboard: vi.fn().mockResolvedValue(undefined),
    activateApp: vi.fn().mockImplementation((id: string) => { calls.push(`activateApp:${id}`); return Promise.resolve() }),
    terminateApp: vi.fn().mockResolvedValue(undefined),
    isAppInstalled: vi.fn().mockResolvedValue(true),
    setOrientation: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockImplementation((command: string, args?: unknown) => {
      calls.push(`execute:${command}:${JSON.stringify(args ?? null)}`)
      if (command === 'mobile: listApps') {
        if (listAppsThrows) return Promise.reject(new Error('listApps is only supported on real devices'))
        return Promise.resolve({})
      }
      return Promise.resolve(undefined)
    }),
    deepLink: vi.fn().mockImplementation(() => { calls.push('deepLink'); return Promise.resolve() }),
    url: vi.fn().mockRejectedValue(new Error('not supported')),
    getContexts: vi.fn().mockResolvedValue(['NATIVE_APP']),
    getContext: vi.fn().mockResolvedValue('NATIVE_APP'),
    switchContext: vi.fn().mockResolvedValue(undefined),
    $: vi.fn().mockImplementation(() => Promise.resolve(mockElement)),
    $$: vi.fn().mockResolvedValue([]),
    _pointerAction: pointerAction,
  }
}

vi.mock('webdriverio', () => ({ remote: vi.fn() }))

import { IOSPlatformAdapter } from '../adapter.js'

type ExecAction = Parameters<IOSPlatformAdapter['execute']>[0]

describe('IOSPlatformAdapter catalog (RED — Wave-0)', () => {
  let adapter: IOSPlatformAdapter
  let mockDriver: ReturnType<typeof createMockDriver>

  beforeEach(async () => {
    vi.clearAllMocks()
    calls = []
    listAppsThrows = false
    mockElement = createMockElement()
    mockDriver = createMockDriver()
    const { remote } = await import('webdriverio')
    vi.mocked(remote).mockResolvedValue(mockDriver as any)
    adapter = new IOSPlatformAdapter()
    await adapter.setup({ platform: 'ios' })
  })

  afterEach(() => { vi.restoreAllMocks() })

  function reset() { calls = []; mockDriver.execute.mockClear() }
  async function refFor(name: string): Promise<string> {
    const state = await adapter.observe()
    const el = state.elements.find(e => e.name === name)
    if (!el) throw new Error(`test fixture: element "${name}" not observed`)
    return el.ref
  }

  describe('pressButton (new case, real-device / simulator lane)', () => {
    it('{button:"home"} → mobile: pressButton {name:"home"}', async () => {
      reset()
      const r = await adapter.execute({ type: 'pressButton', button: 'home' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: pressButton', { name: 'home' })
    })
    it('a volume button on a simulator-flagged session → §7.1 degradation error, success false, no throw', async () => {
      // Plan 07 owns the simulator check; the listApps-throws signal flags a simulator session here.
      listAppsThrows = true
      reset()
      const r = await adapter.execute({ type: 'pressButton', button: 'volumeUp' } as unknown as ExecAction)
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/simulator|real device/i)
    })
  })

  describe('pickerSelect (new case)', () => {
    it('value lane → mobile: selectPickerWheelValue with the target value', async () => {
      const ref = await refFor('Month')
      reset()
      const r = await adapter.execute({ type: 'pickerSelect', ref, value: 'March' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      const call = mockDriver.execute.mock.calls.find(c => c[0] === 'mobile: selectPickerWheelValue')
      expect(call).toBeDefined()
      expect(JSON.stringify(call?.[1])).toContain('March')
    })
    it('index lane with an out-of-range order → a §7.1 range error, never a silent wrong selection', async () => {
      const ref = await refFor('Month')
      reset()
      const r = await adapter.execute({ type: 'pickerSelect', ref, order: 99 } as unknown as ExecAction)
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/range|index|order|out of/i)
    })
  })

  describe('swipeFromEdge (new case)', () => {
    it('{edge:"left"} runs a W3C pointer action starting at the edge', async () => {
      reset()
      const r = await adapter.execute({ type: 'swipeFromEdge', edge: 'left' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockDriver.action).toHaveBeenCalled()
    })
  })

  describe('openUniversalLink (re-key of the openLink body)', () => {
    it('→ mobile: deepLink with url + bundleId (driver.url fallback)', async () => {
      reset()
      const r = await adapter.execute({ type: 'openUniversalLink', url: 'https://example.test/deep', bundleId: 'com.example.app' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      const usedDeepLink = mockDriver.deepLink.mock.calls.length > 0
        || mockDriver.execute.mock.calls.some(c => c[0] === 'mobile: deepLink')
      expect(usedDeepLink).toBe(true)
    })
  })

  describe('fold re-keys (schema execution shapes replace legacy field reads)', () => {
    it('waitFor {on:"selector"} returns a §7.1 web-only error (no selector waiting on native)', async () => {
      reset()
      const r = await adapter.execute({ type: 'waitFor', on: 'selector', selector: '#done', timeoutMs: 500 } as unknown as ExecAction)
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/web|selector/i)
    })
    it('keypress mode:"press" works, mode:"down"/"up" return a §7.1 press-only error', async () => {
      reset()
      const press = await adapter.execute({ type: 'keypress', keys: ['Return'], mode: 'press' } as unknown as ExecAction)
      expect(press.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalled()
      const up = await adapter.execute({ type: 'keypress', keys: ['Shift'], mode: 'up' } as unknown as ExecAction)
      expect(up.success).toBe(false)
      expect(up.error).toMatch(/press|mobile|down|up/i)
    })
    it('swipe {mode:"path"} drives the W3C action builder to the schema "to" point (legacy startX..endY replaced)', async () => {
      reset()
      await adapter.execute({
        type: 'swipe', mode: 'path', from: { x: 50, y: 600 }, to: { x: 50, y: 120 }, coordSpace: 'viewport', durationMs: 300,
      } as unknown as ExecAction)
      const movedToTarget = mockDriver._pointerAction.move.mock.calls.some(
        (c: unknown[]) => (c[0] as { x?: number; y?: number })?.x === 50 && (c[0] as { y?: number })?.y === 120,
      )
      expect(movedToTarget).toBe(true)
    })
  })

  describe('gesture preservation (schema shapes must keep driving the W3C builder post-flip)', () => {
    it('swipe {mode:"direction"} still runs a pointer action', async () => {
      reset()
      const r = await adapter.execute({ type: 'swipe', mode: 'direction', direction: 'up', durationMs: 300 } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockDriver.action).toHaveBeenCalled()
    })
    it('tapCoordinate {x, y, coordSpace} taps the coordinate', async () => {
      reset()
      const r = await adapter.execute({ type: 'tapCoordinate', x: 100, y: 200, coordSpace: 'viewport' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockDriver.action).toHaveBeenCalled()
    })
  })

  describe('the retired assert, openLink and launchApp actions no longer succeed', () => {
    it('assert / openLink / launchApp are no longer handled as distinct successful cases', async () => {
      reset()
      const rAssert = await adapter.execute({ type: 'assert', condition: 'x' } as unknown as ExecAction)
      const rOpenLink = await adapter.execute({ type: 'openLink', url: 'https://example.test/x', bundleId: 'com.example.app' } as unknown as ExecAction)
      const rLaunchApp = await adapter.execute({ type: 'launchApp', bundleId: 'com.example.app' } as unknown as ExecAction)
      expect(rAssert.success).toBe(false)
      expect(rOpenLink.success).toBe(false)
      expect(rLaunchApp.success).toBe(false)
    })
  })
})
