import { describe, it, expect, vi } from 'vitest'
import { captureFailureScreenshot } from '../screenshot.js'
import type { PlatformAdapter } from '../../types/platform.js'

function makeAdapter(overrides?: Partial<PlatformAdapter>): PlatformAdapter {
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      return { tree: '', elements: [], timestamp: Date.now(), metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 } }
    },
    async execute() {
      return { success: true }
    },
    ...overrides,
  }
}

describe('captureFailureScreenshot', () => {
  it('returns buffer from adapter.screenshot()', async () => {
    const buf = Buffer.from('fake-png')
    const adapter = {
      ...makeAdapter(),
      screenshot: vi.fn().mockResolvedValue(buf),
    }

    const result = await captureFailureScreenshot(adapter)
    expect(result).toBe(buf)
    expect(adapter.screenshot).toHaveBeenCalled()
  })

  it('returns undefined when adapter has no screenshot method', async () => {
    const adapter = makeAdapter()

    const result = await captureFailureScreenshot(adapter)
    expect(result).toBeUndefined()
  })

  it('returns undefined on error', async () => {
    const adapter = {
      ...makeAdapter(),
      screenshot: vi.fn().mockRejectedValue(new Error('browser crashed')),
    }

    const result = await captureFailureScreenshot(adapter)
    expect(result).toBeUndefined()
  })
})
