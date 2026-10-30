import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Driver-call contract for each Android verb against a call-logging mocked driver; no live Appium.

const ANDROID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,1920]">
    <android.widget.LinearLayout bounds="[0,0][1080,1920]">
      <android.widget.EditText text="" content-desc="Username" bounds="[100,250][980,350]" enabled="true" />
      <android.widget.Button text="Sign In" bounds="[100,550][980,650]" enabled="true" />
    </android.widget.LinearLayout>
  </android.widget.FrameLayout>
</hierarchy>`

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
    getText: vi.fn().mockResolvedValue(''),
    getAttribute: vi.fn().mockResolvedValue(null),
    clearValue: vi.fn().mockResolvedValue(undefined),
  }
}
let mockElement: ReturnType<typeof createMockElement>

function createMockDriver() {
  const pointerAction = createMockPointerAction()
  return {
    getPageSource: vi.fn().mockImplementation(() => { calls.push('getPageSource'); return Promise.resolve(ANDROID_XML) }),
    getWindowSize: vi.fn().mockResolvedValue({ width: 1080, height: 1920 }),
    takeScreenshot: vi.fn().mockResolvedValue(SCREENSHOT_BASE64),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    action: vi.fn().mockReturnValue(pointerAction),
    actions: vi.fn().mockImplementation(() => { calls.push('actions'); return Promise.resolve(undefined) }),
    keys: vi.fn().mockImplementation((k: unknown) => { calls.push(`keys:${JSON.stringify(k)}`); return Promise.resolve() }),
    pause: vi.fn().mockImplementation((ms: number) => { calls.push(`pause:${ms}`); return Promise.resolve() }),
    hideKeyboard: vi.fn().mockResolvedValue(undefined),
    activateApp: vi.fn().mockResolvedValue(undefined),
    terminateApp: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockImplementation((command: string, args?: unknown) => {
      calls.push(`execute:${command}:${JSON.stringify(args ?? null)}`)
      return Promise.resolve(undefined)
    }),
    getContexts: vi.fn().mockResolvedValue(['NATIVE_APP']),
    getContext: vi.fn().mockResolvedValue('NATIVE_APP'),
    switchContext: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue([]),
    url: vi.fn().mockRejectedValue(new Error('not supported')),
    $: vi.fn().mockImplementation(() => Promise.resolve(mockElement)),
    _pointerAction: pointerAction,
  }
}

vi.mock('webdriverio', () => ({ remote: vi.fn() }))

import { AndroidPlatformAdapter } from '../adapter.js'

type ExecAction = Parameters<AndroidPlatformAdapter['execute']>[0]

describe('AndroidPlatformAdapter catalog', () => {
  let adapter: AndroidPlatformAdapter
  let mockDriver: ReturnType<typeof createMockDriver>

  beforeEach(async () => {
    vi.clearAllMocks()
    calls = []
    mockElement = createMockElement()
    mockDriver = createMockDriver()
    const { remote } = await import('webdriverio')
    vi.mocked(remote).mockResolvedValue(mockDriver as any)
    adapter = new AndroidPlatformAdapter()
    await adapter.setup({ platform: 'android' })
  })

  afterEach(() => { vi.restoreAllMocks() })

  function reset() { calls = []; mockDriver.execute.mockClear() }

  describe('hardware keys → mobile: pressKey with numeric keycodes (never symbolic on this path)', () => {
    it('pressBack → keycode 4, pressHome → keycode 3, pressRecent → keycode 187', async () => {
      reset()
      await adapter.execute({ type: 'pressBack' } as unknown as ExecAction)
      await adapter.execute({ type: 'pressHome' } as unknown as ExecAction)
      await adapter.execute({ type: 'pressRecent' } as unknown as ExecAction)
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: pressKey', { keycode: 4 })
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: pressKey', { keycode: 3 })
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: pressKey', { keycode: 187 })
    })
  })

  describe('notification shade / quick settings', () => {
    it('openNotifications → mobile: openNotifications', async () => {
      reset()
      const r = await adapter.execute({ type: 'openNotifications' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: openNotifications')
    })
    it('openQuickSettings → an args-array mobile: shell invocation (no interpolation)', async () => {
      reset()
      const r = await adapter.execute({ type: 'openQuickSettings' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: shell', { command: 'cmd', args: ['statusbar', 'expand-settings'] })
    })
  })

  describe('intent → mobile: startActivity typed args, with no shell interpolation', () => {
    it('typed action/extras reach mobile: startActivity, never an am-start shell string', async () => {
      reset()
      await adapter.execute({
        type: 'intent',
        action: 'android.intent.action.VIEW',
        data: 'https://example.test/x',
        extras: [{ key: 'flag', type: 'bool', value: 'true' }],
      } as unknown as ExecAction)
      const startCall = mockDriver.execute.mock.calls.find(c => c[0] === 'mobile: startActivity')
      expect(startCall).toBeDefined()
      const usedShellAmStart = mockDriver.execute.mock.calls.some(
        c => c[0] === 'mobile: shell' && JSON.stringify(c[1]).includes('start'),
      )
      expect(usedShellAmStart).toBe(false)
    })

    it('a hostile extras value (quotes/semicolons/$()) arrives byte-identical inside the typed args, never interpolated', async () => {
      reset()
      const hostile = 'v"; $(rm -rf /); echo "pwned'
      await adapter.execute({
        type: 'intent',
        action: 'android.intent.action.VIEW',
        extras: [{ key: 'k', type: 'string', value: hostile }],
      } as unknown as ExecAction)
      const startCall = mockDriver.execute.mock.calls.find(c => c[0] === 'mobile: startActivity')
      expect(startCall).toBeDefined()
      // Byte-identical, carried as a typed extras-triple value (never concatenated into any command
      // string). Exact triple equality is the true byte-identity check: a JSON-substring match is
      // unsatisfiable here because JSON.stringify escapes the quotes inside the hostile value.
      const startArgs = startCall?.[1] as { extras?: Array<[string, string, string]> }
      const carriedByteIdentical = (startArgs?.extras ?? []).some(triple => triple[2] === hostile)
      expect(carriedByteIdentical).toBe(true)
      const anyShellCarriedHostile = mockDriver.execute.mock.calls.some(
        c => c[0] === 'mobile: shell' && JSON.stringify(c[1]).includes(hostile),
      )
      expect(anyShellCarriedHostile).toBe(false)
    })
  })

  describe('keyevent → KEYCODE allow-list, args-array lane', () => {
    it('a KEYCODE_* string matching ^KEYCODE_[A-Z0-9_]+$ executes via a driver call carrying the code', async () => {
      reset()
      await adapter.execute({ type: 'keyevent', keycode: 'KEYCODE_ENTER' } as unknown as ExecAction)
      expect(mockDriver.execute).toHaveBeenCalled()
      expect(JSON.stringify(mockDriver.execute.mock.calls)).toContain('KEYCODE_ENTER')
    })
    it('a hostile non-matching keycode (spaces / shell metacharacters) is REJECTED before any driver.execute call', async () => {
      reset()
      const r = await adapter.execute({ type: 'keyevent', keycode: 'KEYCODE_ENTER; rm -rf /' } as unknown as ExecAction)
      expect(r.success).toBe(false)
      expect(mockDriver.execute).not.toHaveBeenCalled()
    })
  })

  describe('fold re-keys (schema execution shapes replace legacy field reads)', () => {
    it('waitFor {on:"text"} polls the accessibility tree for the text (not a blind pause)', async () => {
      reset()
      mockDriver.getPageSource.mockClear()
      const r = await adapter.execute({ type: 'waitFor', on: 'text', text: 'Sign In', timeoutMs: 500 } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockDriver.getPageSource).toHaveBeenCalled()
    })
    it('waitFor {on:"selector"} returns a structured web-only error (no selector waiting on native)', async () => {
      reset()
      const r = await adapter.execute({ type: 'waitFor', on: 'selector', selector: '#done', timeoutMs: 500 } as unknown as ExecAction)
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/web|selector/i)
    })
    it('keypress mode:"press" works, mode:"down"/"up" return a structured press-only error', async () => {
      reset()
      const press = await adapter.execute({ type: 'keypress', keys: ['Enter'], mode: 'press' } as unknown as ExecAction)
      expect(press.success).toBe(true)
      expect(mockDriver.keys).toHaveBeenCalled()
      const down = await adapter.execute({ type: 'keypress', keys: ['Shift'], mode: 'down' } as unknown as ExecAction)
      expect(down.success).toBe(false)
      expect(down.error).toMatch(/press|mobile|down|up/i)
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
    it('multiTap {fingers:3, x, y, coordSpace} runs a multi-pointer action', async () => {
      reset()
      const r = await adapter.execute({ type: 'multiTap', fingers: 3, x: 200, y: 400, coordSpace: 'viewport' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockDriver.actions).toHaveBeenCalled()
    })
    it('tapCoordinate {x, y, coordSpace} taps the coordinate', async () => {
      reset()
      const r = await adapter.execute({ type: 'tapCoordinate', x: 200, y: 400, coordSpace: 'viewport' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockDriver.action).toHaveBeenCalled()
    })
  })

  describe('the retired assert, openLink and launchApp actions no longer succeed', () => {
    it('assert / openLink / launchApp are no longer handled as distinct successful cases', async () => {
      reset()
      const rAssert = await adapter.execute({ type: 'assert', condition: 'x' } as unknown as ExecAction)
      const rOpenLink = await adapter.execute({ type: 'openLink', url: 'https://example.test/x' } as unknown as ExecAction)
      const rLaunchApp = await adapter.execute({ type: 'launchApp', bundleId: 'com.example.app' } as unknown as ExecAction)
      expect(rAssert.success).toBe(false)
      expect(rOpenLink.success).toBe(false)
      expect(rLaunchApp.success).toBe(false)
    })
  })
})
