import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 437 D-18 (SC4): `keyevent` and `openQuickSettings` keep their `mobile: shell` route. Secure Appium
// refuses that route with a fixed message; the refusal is recorded as unavailable and any other
// driver error as failed. Neither is ever a pass, and neither escapes `execute()` as a throw.

const ANDROID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,1920]">
    <android.widget.Button text="Sign In" bounds="[100,550][980,650]" enabled="true" />
  </android.widget.FrameLayout>
</hierarchy>`

const SCREENSHOT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// The exact text secure Appium returns (@appium/base-driver's insecure-feature template).
const SECURE_APPIUM_REFUSAL =
  "Potentially insecure feature 'adb_shell' has not been enabled. If you want to enable this "
  + 'feature and accept the security ramifications, please do so by following the documented '
  + 'instructions at http://appium.io/docs/en/latest/guides/security/ when running "execute/sync" '
  + 'with method "POST"'

let shellError: Error | null = null

function createMockDriver() {
  const chain: Record<string, any> = {}
  chain.move = vi.fn().mockReturnValue(chain)
  chain.down = vi.fn().mockReturnValue(chain)
  chain.up = vi.fn().mockReturnValue(chain)
  chain.perform = vi.fn().mockResolvedValue(undefined)
  return {
    getPageSource: vi.fn().mockResolvedValue(ANDROID_XML),
    getWindowSize: vi.fn().mockResolvedValue({ width: 1080, height: 1920 }),
    takeScreenshot: vi.fn().mockResolvedValue(SCREENSHOT_BASE64),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    activateApp: vi.fn().mockResolvedValue(undefined),
    action: vi.fn().mockReturnValue(chain),
    keys: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockImplementation((command: string) => {
      if (command === 'mobile: shell' && shellError) return Promise.reject(shellError)
      return Promise.resolve(undefined)
    }),
    getContexts: vi.fn().mockResolvedValue(['NATIVE_APP']),
    switchContext: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockRejectedValue(new Error('not supported')),
    $: vi.fn().mockResolvedValue({ isExisting: vi.fn().mockResolvedValue(false) }),
  }
}

vi.mock('webdriverio', () => ({ remote: vi.fn() }))

import { AndroidPlatformAdapter } from '../adapter.js'

type ExecAction = Parameters<AndroidPlatformAdapter['execute']>[0]

let adapter: AndroidPlatformAdapter
let driver: ReturnType<typeof createMockDriver>

beforeEach(async () => {
  vi.clearAllMocks()
  shellError = null
  driver = createMockDriver()
  const { remote } = await import('webdriverio')
  vi.mocked(remote).mockResolvedValue(driver as any)
  adapter = new AndroidPlatformAdapter()
  await adapter.setup({ platform: 'android' })
  driver.execute.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function keyevent(keycode: string) {
  return adapter.execute({ type: 'keyevent', keycode } as unknown as ExecAction)
}

describe('a refused mobile: shell records the action unavailable and any other driver error failed', () => {
  it('a refused keyevent is unavailable', async () => {
    shellError = new Error(SECURE_APPIUM_REFUSAL)

    const pending = keyevent('KEYCODE_ENTER')

    await expect(pending).resolves.toBeDefined()
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^keyevent unavailable:/)
    expect(result.error).toContain('adb_shell')
    expect(result.error).not.toContain('appium.io')
    expect(result.metadata?.shellAction).toEqual({
      verb: 'keyevent',
      outcome: 'unavailable',
      reason: 'adb-shell-disabled',
    })
    expect(driver.execute).toHaveBeenCalledTimes(1)
  })

  it('another driver error is failed', async () => {
    shellError = new Error('socket hang up\n    at Request.emit (node:events)')

    const result = await keyevent('KEYCODE_ENTER')

    expect(result.success).toBe(false)
    expect(result.error).toBe('keyevent failed: socket hang up')
    expect(result.metadata?.shellAction).toEqual({
      verb: 'keyevent',
      outcome: 'failed',
      detail: 'socket hang up',
    })
  })

  it('an allowed keyevent still uses mobile: shell input keyevent', async () => {
    const result = await keyevent('KEYCODE_ENTER')

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.metadata).toBeUndefined()
    expect(driver.execute.mock.calls).toEqual([
      ['mobile: shell', { command: 'input', args: ['keyevent', 'KEYCODE_ENTER'] }],
    ])
  })

  it('the allow-list still rejects a hostile code before any driver call', async () => {
    shellError = new Error(SECURE_APPIUM_REFUSAL)

    const result = await keyevent('KEYCODE_ENTER; rm -rf /')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/is not a valid Android key code/)
    expect(result.metadata).toBeUndefined()
    expect(driver.execute).not.toHaveBeenCalled()
  })

  it('a refused openQuickSettings is unavailable', async () => {
    shellError = new Error(SECURE_APPIUM_REFUSAL)

    const result = await adapter.execute({ type: 'openQuickSettings' } as unknown as ExecAction)

    expect(driver.execute.mock.calls).toEqual([
      ['mobile: shell', { command: 'cmd', args: ['statusbar', 'expand-settings'] }],
    ])
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^openQuickSettings unavailable:/)
    expect(result.metadata?.shellAction).toEqual({
      verb: 'openQuickSettings',
      outcome: 'unavailable',
      reason: 'adb-shell-disabled',
    })
  })
})
