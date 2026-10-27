import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// P3: iOS sessions request a WDA snapshotMaxDepth of their own (AGENT_QA_IOS_SNAPSHOT_MAX_DEPTH,
// then 62). A kAXErrorIllegalArgument read lowers it to 50 for
// the rest of the session, and the session's own depth is retried every 20 lowered reads.

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="App" label="App" x="0" y="0" width="390" height="844">
    <XCUIElementTypeStaticText label="Deep row" x="20" y="100" width="350" height="30" enabled="true" />
    <XCUIElementTypeButton label="Done" x="20" y="200" width="350" height="44" enabled="true" />
  </XCUIElementTypeApplication>
</AppiumAUT>`

const ENV = 'AGENT_QA_IOS_SNAPSHOT_MAX_DEPTH'
const DEPTH_CAP = 'appium:settings[snapshotMaxDepth]'

function snapshotError(message = 'Original error: kAXErrorIllegalArgument getting snapshot for element', name = 'stale element reference'): Error {
  const err = new Error(message)
  err.name = name
  return err
}

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
    getPageSource: vi.fn().mockResolvedValue(XML),
    getWindowSize: vi.fn().mockResolvedValue({ width: 390, height: 844 }),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    getContexts: vi.fn().mockResolvedValue(['NATIVE_APP']),
    switchContext: vi.fn().mockResolvedValue(undefined),
    takeScreenshot: vi.fn().mockResolvedValue(''),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    action: vi.fn().mockReturnValue(pointerAction),
    pause: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(undefined),
    _pointerAction: pointerAction,
  }
}

vi.mock('webdriverio', () => ({
  remote: vi.fn(),
}))

import { IOSPlatformAdapter } from '../adapter.js'
import { resolveIOSSnapshotDepth } from '../session.js'

describe('iOS snapshot depth (P3)', () => {
  let adapter: IOSPlatformAdapter
  let driver: ReturnType<typeof createMockDriver>
  let warn: ReturnType<typeof vi.spyOn>
  let savedEnv: string | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    savedEnv = process.env[ENV]
    delete process.env[ENV]
    driver = createMockDriver()
    const { remote } = await import('webdriverio')
    vi.mocked(remote).mockResolvedValue(driver as any)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    adapter = new IOSPlatformAdapter()
  })

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV]
    else process.env[ENV] = savedEnv
    warn.mockRestore()
    vi.restoreAllMocks()
  })

  async function requestedDepth(call = 0): Promise<unknown> {
    const { remote } = await import('webdriverio')
    return (vi.mocked(remote).mock.calls[call][0] as any).capabilities[DEPTH_CAP]
  }

  async function observeTimes(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await adapter.observe()
  }

  describe('capability', () => {
    it('requests snapshotMaxDepth 62 on a local session', async () => {
      await adapter.setup({ platform: 'ios' })
      expect(await requestedDepth()).toBe(62)
      expect(driver.updateSettings).not.toHaveBeenCalled()
    })

    it('takes the depth from AGENT_QA_IOS_SNAPSHOT_MAX_DEPTH', async () => {
      process.env[ENV] = '70'
      await adapter.setup({ platform: 'ios' })
      expect(await requestedDepth()).toBe(70)
      expect(resolveIOSSnapshotDepth()).toBe(70)
    })

    it.each(['abc', '0', '-5', '12.5', ''])('ignores AGENT_QA_IOS_SNAPSHOT_MAX_DEPTH=%j and keeps 62', async (value) => {
      process.env[ENV] = value
      await adapter.setup({ platform: 'ios' })
      expect(await requestedDepth()).toBe(62)
      expect(resolveIOSSnapshotDepth()).toBe(62)
    })

  })

  describe('sticky fallback', () => {
    it('lowers to 50 once on kAXErrorIllegalArgument, keeps it, and warns once without page source', async () => {
      driver.getPageSource.mockRejectedValueOnce(snapshotError()).mockResolvedValue(XML)
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()

      expect(state.tree).toContain('text "Deep row"')
      expect(state.tree).toContain('button "Done"')
      expect(driver.getPageSource).toHaveBeenCalledTimes(2)
      expect(driver.updateSettings.mock.calls).toEqual([[{ snapshotMaxDepth: 50 }]])
      const [lower] = driver.updateSettings.mock.invocationCallOrder
      const [firstRead, secondRead] = driver.getPageSource.mock.invocationCallOrder
      expect(firstRead).toBeLessThan(lower)
      expect(lower).toBeLessThan(secondRead)

      await observeTimes(3)
      expect(driver.getPageSource).toHaveBeenCalledTimes(5)
      expect(driver.updateSettings.mock.calls).toEqual([[{ snapshotMaxDepth: 50 }]])

      expect(warn).toHaveBeenCalledTimes(1)
      const message = String(warn.mock.calls[0][0])
      expect(message.startsWith('[ios-adapter]')).toBe(true)
      expect(message).toContain('62')
      expect(message).toContain('50')
      expect(message).not.toContain('<AppiumAUT>')
    })

    it('retries the session depth after 20 lowered reads, before reading', async () => {
      driver.getPageSource.mockRejectedValueOnce(snapshotError()).mockResolvedValue(XML)
      await adapter.setup({ platform: 'ios' })
      await observeTimes(20)
      expect(driver.updateSettings.mock.calls).toEqual([[{ snapshotMaxDepth: 50 }]])

      await adapter.observe()
      expect(driver.updateSettings.mock.calls).toEqual([[{ snapshotMaxDepth: 50 }], [{ snapshotMaxDepth: 62 }]])
      const probe = driver.updateSettings.mock.invocationCallOrder[1]
      const lastRead = driver.getPageSource.mock.invocationCallOrder.at(-1)!
      expect(probe).toBeLessThan(lastRead)

      await observeTimes(25)
      expect(driver.updateSettings).toHaveBeenCalledTimes(2)
    })

    it('goes back to 50 in the same read when the probe read fails, with no second warning', async () => {
      driver.getPageSource.mockRejectedValueOnce(snapshotError()).mockResolvedValue(XML)
      await adapter.setup({ platform: 'ios' })
      await observeTimes(20)
      driver.getPageSource.mockRejectedValueOnce(snapshotError())

      const state = await adapter.observe()

      expect(state.tree).toContain('button "Done"')
      expect(driver.updateSettings.mock.calls).toEqual([
        [{ snapshotMaxDepth: 50 }],
        [{ snapshotMaxDepth: 62 }],
        [{ snapshotMaxDepth: 50 }],
      ])
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('reads at 50 when the probe cannot raise the depth', async () => {
      driver.getPageSource.mockRejectedValueOnce(snapshotError()).mockResolvedValue(XML)
      await adapter.setup({ platform: 'ios' })
      await observeTimes(20)
      driver.updateSettings.mockRejectedValueOnce(new Error('settings gone'))
      const readsBefore = driver.getPageSource.mock.calls.length

      const state = await adapter.observe()

      expect(state.tree).toContain('button "Done"')
      expect(driver.getPageSource.mock.calls.length).toBe(readsBefore + 1)
      expect(driver.updateSettings.mock.calls).toEqual([[{ snapshotMaxDepth: 50 }], [{ snapshotMaxDepth: 62 }]])

      await observeTimes(19)
      expect(driver.updateSettings).toHaveBeenCalledTimes(2)
      await adapter.observe()
      expect(driver.updateSettings.mock.calls.at(-1)).toEqual([{ snapshotMaxDepth: 62 }])
      expect(driver.updateSettings).toHaveBeenCalledTimes(3)
    })
  })

  describe("the session's own depth", () => {
    it('probes back to a session depth of 70, never 62', async () => {
      driver.getPageSource.mockRejectedValueOnce(snapshotError()).mockResolvedValue(XML)
      process.env[ENV] = '70'
      await adapter.setup({ platform: 'ios' })
      await observeTimes(21)

      expect(driver.updateSettings.mock.calls).toEqual([[{ snapshotMaxDepth: 50 }], [{ snapshotMaxDepth: 70 }]])
      expect(String(warn.mock.calls[0][0])).toContain('70')
    })

    it('does not lower a session depth of 40: the read is retried once at the same depth', async () => {
      const second = snapshotError('Original error: kAXErrorIllegalArgument (second read)')
      driver.getPageSource.mockRejectedValueOnce(snapshotError()).mockRejectedValueOnce(second)
      process.env[ENV] = '40'
      await adapter.setup({ platform: 'ios' })

      await expect(adapter.observe()).rejects.toBe(second)
      expect(driver.getPageSource).toHaveBeenCalledTimes(2)
      expect(driver.updateSettings).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    })
  })

  describe('detection', () => {
    it('lowers on a kAXErrorIllegalArgument message alone', async () => {
      driver.getPageSource.mockRejectedValueOnce(snapshotError('Original error: kAXErrorIllegalArgument', 'Error')).mockResolvedValue(XML)
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      expect(state.tree).toContain('button "Done"')
      expect(driver.getPageSource).toHaveBeenCalledTimes(2)
      expect(driver.updateSettings.mock.calls).toEqual([[{ snapshotMaxDepth: 50 }]])
    })

    it.each([
      ['getting snapshot without kAX', snapshotError('Error getting snapshot for the application', 'Error')],
      ['a stale element reference name without kAX', snapshotError('An unknown server-side error occurred', 'stale element reference')],
    ])('retries %s once at the same depth', async (_label, err) => {
      driver.getPageSource.mockRejectedValueOnce(err).mockResolvedValue(XML)
      await adapter.setup({ platform: 'ios' })
      const state = await adapter.observe()
      expect(state.tree).toContain('button "Done"')
      expect(driver.getPageSource).toHaveBeenCalledTimes(2)
      expect(driver.updateSettings).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    })

    it('propagates any other error with no retry', async () => {
      const err = new Error('invalid session id')
      driver.getPageSource.mockRejectedValue(err)
      await adapter.setup({ platform: 'ios' })
      await expect(adapter.observe()).rejects.toBe(err)
      expect(driver.getPageSource).toHaveBeenCalledTimes(1)
      expect(driver.updateSettings).not.toHaveBeenCalled()
    })
  })

  describe('failures', () => {
    it('surfaces the second error when the read at 50 also fails, and stays at 50', async () => {
      const second = new Error('Original error: kAXErrorIllegalArgument at depth 50')
      driver.getPageSource.mockRejectedValueOnce(snapshotError()).mockRejectedValueOnce(second).mockResolvedValue(XML)
      await adapter.setup({ platform: 'ios' })

      await expect(adapter.observe()).rejects.toBe(second)
      expect(driver.getPageSource).toHaveBeenCalledTimes(2)
      expect(driver.updateSettings.mock.calls).toEqual([[{ snapshotMaxDepth: 50 }]])

      await adapter.observe()
      expect(driver.getPageSource).toHaveBeenCalledTimes(3)
      expect(driver.updateSettings.mock.calls).toEqual([[{ snapshotMaxDepth: 50 }]])
    })

    it('rethrows the original read error when the depth cannot be lowered', async () => {
      const err = snapshotError()
      driver.getPageSource.mockRejectedValue(err)
      driver.updateSettings.mockRejectedValue(new Error('settings not supported'))
      await adapter.setup({ platform: 'ios' })
      await expect(adapter.observe()).rejects.toBe(err)
      expect(driver.getPageSource).toHaveBeenCalledTimes(1)
    })
  })

  describe('shared reader', () => {
    it('waitFor text finds the needle in the fallback read', async () => {
      driver.getPageSource.mockRejectedValueOnce(snapshotError()).mockResolvedValueOnce(XML)
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({ type: 'waitFor', on: 'text', text: 'Deep row', timeoutMs: 20 })
      expect(result.success).toBe(true)
      expect(driver.getPageSource).toHaveBeenCalledTimes(2)
      // Found in the same poll, not after the poll loop treated the failed read as empty.
      expect(driver.updateSettings).toHaveBeenCalledWith({ snapshotMaxDepth: 50 })
      expect(driver.pause).not.toHaveBeenCalled()
    })

    // 2026-10-07 (436-02): toEnd no longer reads the interim tree; untilVisible's visibility probe does.
    it('an untilVisible scroll finds the target when one interim-tree read hits the snapshot error', async () => {
      driver.getPageSource.mockRejectedValueOnce(snapshotError())
      await adapter.setup({ platform: 'ios' })
      const result = await adapter.execute({
        type: 'scroll',
        mode: 'untilVisible',
        text: 'Deep row',
        direction: 'down',
        maxSwipes: 2,
        retryOpposite: false,
      })
      expect(result.success).toBe(true)
      expect(result.metadata?.scrollUntilVisible).toEqual({ swipes: 0, reversedOnce: false, outcome: 'found', endedBy: 'target-visible' })
      expect(driver.updateSettings).toHaveBeenCalledWith({ snapshotMaxDepth: 50 })
    })
  })
})
