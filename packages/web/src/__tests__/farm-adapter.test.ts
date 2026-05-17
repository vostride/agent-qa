import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FarmWebAdapter } from '../farm-adapter.js'

const {
  mockBrowser,
  mockContext,
  mockConnect,
  mockCdpSession,
} = vi.hoisted(() => {
  const cdpSession = {
    send: vi.fn().mockResolvedValue({}),
    detach: vi.fn().mockResolvedValue(undefined),
  }
  const page = {
    on: vi.fn(),
    context: vi.fn(() => ({
      newCDPSession: vi.fn().mockResolvedValue(cdpSession),
    })),
  }
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    grantPermissions: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn().mockReturnValue([page]),
  }
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  }

  return {
    mockBrowser: browser,
    mockContext: context,
    mockConnect: vi.fn().mockResolvedValue(browser),
    mockCdpSession: cdpSession,
  }
})

vi.mock('playwright-core', () => ({
  chromium: { connect: mockConnect },
}))

describe('FarmWebAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: vi.fn() }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads selected auth storage state before creating the first farm page', async () => {
    const adapter = new FarmWebAdapter()

    await adapter.setup({
      platform: 'web',
      browser: {
        name: 'chromium',
        headless: true,
        viewport: { width: 1366, height: 768 },
      },
      farmSession: {
        hostname: 'hub.browserstack.com',
        port: 443,
        path: '/wd/hub',
        capabilities: {
          username: 'browserstack-user',
          accessKey: 'browserstack-key',
          testName: 'Farm Auth State',
        },
      },
      authState: {
        version: 1,
        kind: 'web',
        targetName: 'staging-web',
        stateName: 'admin',
        capturedAt: '2026-05-17T00:00:00.000Z',
        storageStatePath: '/tmp/internal/admin.json',
      },
    })

    expect(mockBrowser.newContext).toHaveBeenCalledWith(expect.objectContaining({
      viewport: { width: 1366, height: 768 },
      storageState: '/tmp/internal/admin.json',
    }))
    expect(mockBrowser.newContext.mock.invocationCallOrder[0]).toBeLessThan(
      mockContext.newPage.mock.invocationCallOrder[0],
    )
    expect(mockCdpSession.detach).toHaveBeenCalled()

    await adapter.cleanup()
  })
})
