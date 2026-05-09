import { describe, it, expect, vi, beforeEach } from 'vitest'
import { waitForPageReady } from '../smart-wait.js'

function createMockPage(overrides: Record<string, any> = {}) {
  return {
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(false),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any
}

describe('waitForPageReady', () => {
  it('resolves when page is already ready', async () => {
    const page = createMockPage()

    await waitForPageReady(page)

    expect(page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', { timeout: 5000 })
    expect(page.waitForLoadState).toHaveBeenCalledWith('networkidle', { timeout: 5000 })
    // evaluate called for loading indicators check (returns false = no indicators)
    expect(page.evaluate).toHaveBeenCalled()
  })

  it('handles network idle timeout gracefully', async () => {
    const page = createMockPage({
      waitForLoadState: vi.fn().mockImplementation((state: string) => {
        if (state === 'networkidle') {
          return Promise.reject(new Error('Timeout'))
        }
        return Promise.resolve()
      }),
    })

    // Should not throw — network idle failure is tolerated
    await expect(waitForPageReady(page)).resolves.toBeUndefined()
  })

  it('detects loading indicators and waits for removal', async () => {
    let evalCallCount = 0
    const page = createMockPage({
      evaluate: vi.fn().mockImplementation(() => {
        evalCallCount++
        // First call: check loading indicators → found
        if (evalCallCount === 1) return Promise.resolve(true)
        // Second call: check animations → none running
        return Promise.resolve(false)
      }),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
    })

    await waitForPageReady(page)

    // waitForFunction called to wait for indicators to clear
    expect(page.waitForFunction).toHaveBeenCalled()
  })

  it('respects overall timeout', async () => {
    const page = createMockPage({
      waitForLoadState: vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 30000)),
      ),
    })

    const start = Date.now()
    await waitForPageReady(page, { timeout: 200 })
    const elapsed = Date.now() - start

    // Should resolve within the timeout (plus some margin)
    expect(elapsed).toBeLessThan(1000)
  })

  it('handles page.evaluate errors gracefully', async () => {
    const page = createMockPage({
      evaluate: vi.fn().mockRejectedValue(new Error('Execution context destroyed')),
    })

    // Should not throw
    await expect(waitForPageReady(page)).resolves.toBeUndefined()
  })

  it('handles domcontentloaded already loaded', async () => {
    const page = createMockPage({
      waitForLoadState: vi.fn().mockRejectedValue(new Error('Already loaded')),
      evaluate: vi.fn().mockResolvedValue(false),
    })

    await expect(waitForPageReady(page)).resolves.toBeUndefined()
  })

  it('proceeds when loading indicators do not clear', async () => {
    let evalCallCount = 0
    const page = createMockPage({
      evaluate: vi.fn().mockImplementation(() => {
        evalCallCount++
        if (evalCallCount === 1) return Promise.resolve(true) // indicators found
        return Promise.resolve(false) // no animations
      }),
      waitForFunction: vi.fn().mockRejectedValue(new Error('Timeout 3s')),
    })

    // Should not throw — proceeds even if indicators stay
    await expect(waitForPageReady(page)).resolves.toBeUndefined()
  })
})
