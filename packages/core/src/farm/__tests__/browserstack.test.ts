import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserstackProvider } from '../browserstack.js'

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    match: { deviceName: 'Google Pixel 8', platformVersion: '14.0' },
    platform: 'android' as const,
    credentials: { username: 'testuser', accessKey: 'testkey' },
    testName: 'mobile smoke',
    testTimeout: 120000,
    ...overrides,
  }
}

async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-browserstack-app-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('browserstack mobile app capability', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('passes browserstack app references through as app capability', async () => {
    const session = await browserstackProvider.resolveMobileCapabilities(baseConfig({
      app: 'WikipediaApp',
      appBaseDir: '/tmp',
    }))

    expect(session.capabilities['appium:app']).toBe('WikipediaApp')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uploads relative browserstack app paths and uses returned app_url', async () => withTempDir(async (dir) => {
    const appDir = join(dir, 'build')
    mkdirSync(appDir)
    writeFileSync(join(appDir, 'wikipedia.apk'), 'apk')
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ app_url: 'bs://uploaded-app' }),
    } as any)

    const session = await browserstackProvider.resolveMobileCapabilities(baseConfig({
      app: 'build/wikipedia.apk',
      appBaseDir: dir,
    }))

    expect(fetch).toHaveBeenCalledWith(
      'https://api-cloud.browserstack.com/app-automate/upload',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: expect.stringContaining('Basic ') }),
      }),
    )
    expect(session.capabilities['appium:app']).toBe('bs://uploaded-app')
  }))

  it('throws app-install when explicit browserstack upload path is missing', async () => withTempDir(async (dir) => {
    await expect(browserstackProvider.resolveMobileCapabilities(baseConfig({
      app: './missing.apk',
      appBaseDir: dir,
    }))).rejects.toMatchObject({ category: 'app-install' })
  }))

  it('does not upload app.path fallback when browserstack app is absent', async () => {
    const session = await browserstackProvider.resolveMobileCapabilities(baseConfig())

    expect(session.capabilities).not.toHaveProperty('appium:app')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps preserve app state to appium noReset true for native app sessions', async () => {
    const session = await browserstackProvider.resolveMobileCapabilities(baseConfig({
      appState: 'preserve',
    }))

    expect(session.capabilities['appium:noReset']).toBe(true)
  })

  it('maps reset app state to appium noReset false for native app sessions', async () => {
    const session = await browserstackProvider.resolveMobileCapabilities(baseConfig({
      appState: 'reset',
    }))

    expect(session.capabilities['appium:noReset']).toBe(false)
  })

  it('omits appium noReset for mobile browser sessions', async () => {
    const session = await browserstackProvider.resolveMobileCapabilities(baseConfig({
      match: { deviceName: 'Google Pixel 8', platformVersion: '14.0', browserName: 'Chrome' },
      appState: 'reset',
    }))

    expect(session.capabilities).not.toHaveProperty('appium:noReset')
  })

  it('uses appState instead of stale match.noReset', async () => {
    const session = await browserstackProvider.resolveMobileCapabilities(baseConfig({
      match: { deviceName: 'Google Pixel 8', platformVersion: '14.0', noReset: true },
      appState: 'reset',
    }))

    expect(session.capabilities['appium:noReset']).toBe(false)
  })
})
