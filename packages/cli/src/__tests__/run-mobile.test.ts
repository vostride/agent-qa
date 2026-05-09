import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAndroidAdapter = {
  platform: 'android' as const,
  setup: vi.fn(),
  cleanup: vi.fn(),
  observe: vi.fn(),
  execute: vi.fn(),
}

const mockIOSAdapter = {
  platform: 'ios' as const,
  setup: vi.fn(),
  cleanup: vi.fn(),
  observe: vi.fn(),
  execute: vi.fn(),
}

const mockWebAdapter = {
  platform: 'web' as const,
  setup: vi.fn(),
  cleanup: vi.fn(),
  observe: vi.fn(),
  execute: vi.fn(),
}

const coreMocks = vi.hoisted(() => {
  const resolveMobileCapabilities = vi.fn(async (config: any) => ({
    hostname: 'hub.browserstack.com',
    port: 443,
    path: '/wd/hub',
    capabilities: config.app ? { 'appium:app': config.app } : {},
  }))
  return {
    resolveMobileCapabilities,
    registerAllProviders: vi.fn(),
    getProvider: vi.fn(() => ({ resolveMobileCapabilities })),
  }
})

vi.mock('@vostride/agent-qa-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-core')>()
  return {
    ...actual,
    registerAllProviders: coreMocks.registerAllProviders,
    getProvider: coreMocks.getProvider,
  }
})

vi.mock('@vostride/agent-qa-android', () => ({
  AndroidPlatformAdapter: vi.fn(function () { return mockAndroidAdapter }),
}))

vi.mock('@vostride/agent-qa-ios', () => ({
  IOSPlatformAdapter: vi.fn(function () { return mockIOSAdapter }),
}))

vi.mock('@vostride/agent-qa-web', () => ({
  WebPlatformAdapter: vi.fn(function () { return mockWebAdapter }),
}))

import { createPlatformAdapter, buildPlatformConfig, resolveDeviceAndFarmSession } from '../commands/run.js'
import { resolveTarget } from '../targets.js'
import type { AgentQaConfig } from '@vostride/agent-qa-core'

describe('createPlatformAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns AndroidPlatformAdapter for android platform', async () => {
    const adapter = await createPlatformAdapter('android')
    expect(adapter).toBe(mockAndroidAdapter)
  })

  it('returns IOSPlatformAdapter for ios platform', async () => {
    const adapter = await createPlatformAdapter('ios')
    expect(adapter).toBe(mockIOSAdapter)
  })

  it('returns WebPlatformAdapter for web platform', async () => {
    const adapter = await createPlatformAdapter('web')
    expect(adapter).toBe(mockWebAdapter)
  })

  it('throws helpful error when @vostride/agent-qa-android import fails', async () => {
    const { AndroidPlatformAdapter } = await import('@vostride/agent-qa-android')
    vi.mocked(AndroidPlatformAdapter).mockImplementationOnce(() => {
      throw new Error('Cannot find module')
    })

    await expect(createPlatformAdapter('android')).rejects.toThrow(
      'Android adapter not available. Install @vostride/agent-qa-android: pnpm add @vostride/agent-qa-android',
    )
  })

  it('throws helpful error when @vostride/agent-qa-ios import fails', async () => {
    const { IOSPlatformAdapter } = await import('@vostride/agent-qa-ios')
    vi.mocked(IOSPlatformAdapter).mockImplementationOnce(() => {
      throw new Error('Cannot find module')
    })

    await expect(createPlatformAdapter('ios')).rejects.toThrow(
      'iOS adapter not available. Install @vostride/agent-qa-ios: pnpm add @vostride/agent-qa-ios',
    )
  })
})

describe('buildPlatformConfig', () => {
  it('builds web config with browser settings from globalBrowser', () => {
    const config = buildPlatformConfig('web', undefined, { step: 30000 }, { name: 'firefox', headless: false, viewport: { width: 1280, height: 720 } })

    expect(config.platform).toBe('web')
    expect(config.browser).toEqual({
      name: 'firefox',
      headless: false,
      viewport: { width: 1280, height: 720 },
    })
    expect(config.timeouts).toEqual({ step: 30000 })
    expect(config.device).toBeUndefined()
  })

  it('builds web config with defaults when no resolvedDevice', () => {
    const config = buildPlatformConfig('web', undefined, undefined)

    expect(config.platform).toBe('web')
    expect(config.browser?.name).toBe('chromium')
    expect(config.browser?.headless).toBe(true)
  })

  it('builds android config with device from resolvedDevice', () => {
    const resolvedDevice = {
      name: 'pixel-7',
      platform: 'android' as const,
      transport: 'local' as const,
      match: { avd: 'Pixel_7_API_34', appPackage: 'com.example.app' },
    }
    const config = buildPlatformConfig('android', resolvedDevice, { step: 15000 })

    expect(config.platform).toBe('android')
    expect(config.device?.name).toBe('pixel-7')
    expect(config.device?.transport).toBe('local')
    expect(config.device?.match.avd).toBe('Pixel_7_API_34')
    expect(config.browser).toBeUndefined()
    expect(config.timeouts).toEqual({ step: 15000 })
  })

  it('passes Android target app identity separately from generic device identity', () => {
    const resolvedDevice = {
      name: 'android-emu',
      platform: 'android' as const,
      transport: 'local' as const,
      match: { automationName: 'UiAutomator2' },
    }
    const config = buildPlatformConfig('android', resolvedDevice, undefined, undefined, undefined, undefined, {
      platform: 'android',
      targetName: 'release-android-wikipedia',
      deviceName: 'android-emu',
      transport: 'local',
      device: resolvedDevice,
      app: {
        appPackage: 'org.wikipedia.alpha',
        appActivity: '.main.MainActivity',
        deepLinkAppId: 'org.wikipedia.alpha',
        sourceTrace: {},
      },
      appState: 'reset',
      appium: { url: 'http://localhost:4723', managed: true },
      sourceTrace: [],
    })

    expect(config.device?.name).toBe('android-emu')
    expect(config.appPackage).toBe('org.wikipedia.alpha')
    expect(config.appActivity).toBe('.main.MainActivity')
    expect(config.appState).toBe('reset')
    expect(config.appiumUrl).toBe('http://localhost:4723')
  })

  it('passes resolved local app path into mobile platform config', () => {
    const resolvedDevice = {
      name: 'android-emu',
      platform: 'android' as const,
      transport: 'local' as const,
      match: { automationName: 'UiAutomator2' },
    }
    const config = buildPlatformConfig('android', resolvedDevice, undefined, undefined, undefined, undefined, {
      platform: 'android',
      targetName: 'release-android-wikipedia',
      deviceName: 'android-emu',
      transport: 'local',
      device: resolvedDevice,
      app: {
        appPackage: 'org.wikipedia.alpha',
        deepLinkAppId: 'org.wikipedia.alpha',
        install: {
          path: '/tmp/wikipedia.apk',
          sourceTrace: { 'app.path': 'agent-qa.local.yaml apps.release-android-wikipedia.path' },
        },
        sourceTrace: {},
      },
      appState: 'preserve',
      appium: { url: 'http://localhost:4723', managed: true },
      sourceTrace: [],
    })

    expect(config.appPath).toBe('/tmp/wikipedia.apk')
    expect(config.appPackage).toBe('org.wikipedia.alpha')
  })

  it('passes resolved browserstack app reference into mobile platform config', () => {
    const resolvedDevice = {
      name: 'bs-pixel',
      platform: 'android' as const,
      transport: 'browserstack' as const,
      match: { deviceName: 'Google Pixel 8' },
    }
    const config = buildPlatformConfig('android', resolvedDevice, undefined, undefined, undefined, undefined, {
      platform: 'android',
      targetName: 'release-android-wikipedia',
      deviceName: 'bs-pixel',
      transport: 'browserstack',
      device: resolvedDevice,
      app: {
        appPackage: 'org.wikipedia.alpha',
        deepLinkAppId: 'org.wikipedia.alpha',
        install: {
          browserstack: 'WikipediaApp',
          browserstackBaseDir: '/tmp',
          sourceTrace: { 'app.browserstack': 'agent-qa.config.yaml registry.targets.release-android-wikipedia.app.browserstack' },
        },
        sourceTrace: {},
      },
      appState: 'preserve',
      appium: { managed: false },
      sourceTrace: [],
    })

    expect(config.browserstackApp).toBe('WikipediaApp')
    expect(config.appPackage).toBe('org.wikipedia.alpha')
  })

  it('preserves installed-app behavior when no app path resolves', () => {
    const resolvedDevice = {
      name: 'android-emu',
      platform: 'android' as const,
      transport: 'local' as const,
      match: { automationName: 'UiAutomator2' },
    }
    const config = buildPlatformConfig('android', resolvedDevice, undefined, undefined, undefined, undefined, {
      platform: 'android',
      targetName: 'release-android-wikipedia',
      deviceName: 'android-emu',
      transport: 'local',
      device: resolvedDevice,
      app: {
        appPackage: 'org.wikipedia.alpha',
        deepLinkAppId: 'org.wikipedia.alpha',
        sourceTrace: {},
      },
      appState: 'preserve',
      appium: { url: 'http://localhost:4723', managed: true },
      sourceTrace: [],
    })

    expect(config.appPath).toBeUndefined()
    expect(config.browserstackApp).toBeUndefined()
    expect(config.appPackage).toBe('org.wikipedia.alpha')
  })

  it('builds ios config with device from resolvedDevice', () => {
    const resolvedDevice = {
      name: 'iphone-15',
      platform: 'ios' as const,
      transport: 'local' as const,
      match: { udid: '00008120-001E44F11ABC001E', bundleId: 'com.example.ios' },
    }
    const config = buildPlatformConfig('ios', resolvedDevice, undefined)

    expect(config.platform).toBe('ios')
    expect(config.device?.name).toBe('iphone-15')
    expect(config.device?.transport).toBe('local')
    expect(config.device?.match.bundleId).toBe('com.example.ios')
    expect(config.browser).toBeUndefined()
  })

  it('passes iOS target bundle id separately from simulator device name', () => {
    const resolvedDevice = {
      name: 'ios-sim',
      platform: 'ios' as const,
      transport: 'local' as const,
      match: { automationName: 'XCUITest' },
    }
    const config = buildPlatformConfig('ios', resolvedDevice, undefined, undefined, undefined, undefined, {
      platform: 'ios',
      targetName: 'release-ios-wdio',
      deviceName: 'ios-sim',
      transport: 'local',
      device: resolvedDevice,
      app: {
        bundleId: 'org.reactjs.native.example.wdiodemoapp',
        deepLinkAppId: 'org.reactjs.native.example.wdiodemoapp',
        sourceTrace: {},
      },
      appState: 'preserve',
      appium: { url: 'http://localhost:4723', managed: true },
      sourceTrace: [],
    })

    expect(config.device?.name).toBe('ios-sim')
    expect(config.bundleId).toBe('org.reactjs.native.example.wdiodemoapp')
  })

  it('returns undefined device for mobile when no resolvedDevice', () => {
    const config = buildPlatformConfig('android', undefined, undefined)
    expect(config.device).toBeUndefined()
  })

  it('attaches farmSession when provided', () => {
    const resolvedDevice = {
      name: 'bstack-pixel',
      platform: 'android' as const,
      transport: 'browserstack' as const,
      match: { deviceName: 'Google Pixel 7', platformVersion: '13.0' },
    }
    const farmSession = {
      hostname: 'hub.browserstack.com',
      port: 443,
      path: '/wd/hub',
      capabilities: { platformName: 'Android' },
    }
    const config = buildPlatformConfig('android', resolvedDevice, undefined, undefined, undefined, farmSession)

    expect(config.farmSession).toEqual(farmSession)
    expect(config.device?.transport).toBe('browserstack')
  })
})

describe('resolveDeviceAndFarmSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeFarmConfig(): AgentQaConfig {
    return {
      registry: {
        llms: [],
        devices: {
          'bs-pixel': {
            platform: 'android',
            transport: 'browserstack',
            match: { deviceName: 'Google Pixel 8', platformVersion: '14.0' },
          },
        },
      },
    } as unknown as AgentQaConfig
  }

  const localBindings = {
    providers: {
      browserstack: { username: 'testuser', accessKey: 'testkey' },
    },
  }

  it('passes BrowserStack app references into farm capabilities', async () => {
    const resolved = await resolveDeviceAndFarmSession(
      makeFarmConfig(),
      'bs-pixel',
      'android',
      'Wikipedia mobile smoke',
      120000,
      undefined,
      localBindings,
      {
        platform: 'android',
        targetName: 'release-android-wikipedia',
        deviceName: 'bs-pixel',
        transport: 'browserstack',
        device: {
          name: 'bs-pixel',
          platform: 'android',
          transport: 'browserstack',
          match: { deviceName: 'Google Pixel 8', platformVersion: '14.0' },
        },
        app: {
          appPackage: 'org.wikipedia.alpha',
          deepLinkAppId: 'org.wikipedia.alpha',
          install: {
            browserstack: 'WikipediaApp',
            browserstackBaseDir: '/tmp',
            sourceTrace: { 'app.browserstack': 'agent-qa.config.yaml registry.targets.release-android-wikipedia.app.browserstack' },
          },
          sourceTrace: {},
        },
        appState: 'reset',
        appium: { managed: false },
        sourceTrace: [],
      },
    )

    expect(resolved.farmSession?.capabilities['appium:app']).toBe('WikipediaApp')
    expect(coreMocks.resolveMobileCapabilities).toHaveBeenCalledWith(expect.objectContaining({
      app: 'WikipediaApp',
      appState: 'reset',
      appBaseDir: '/tmp',
    }))
  })

  it('rejects BrowserStack native app sessions without app.browserstack instead of falling back to app.path', async () => {
    await expect(
      resolveDeviceAndFarmSession(
        makeFarmConfig(),
        'bs-pixel',
        'android',
        'Wikipedia mobile smoke',
        120000,
        undefined,
        localBindings,
        {
          platform: 'android',
          targetName: 'release-android-wikipedia',
          deviceName: 'bs-pixel',
          transport: 'browserstack',
          device: {
            name: 'bs-pixel',
            platform: 'android',
            transport: 'browserstack',
            match: { deviceName: 'Google Pixel 8', platformVersion: '14.0' },
          },
          app: {
            appPackage: 'org.wikipedia.alpha',
            deepLinkAppId: 'org.wikipedia.alpha',
            install: {
              path: '/tmp/wikipedia.apk',
              sourceTrace: { 'app.path': 'agent-qa.local.yaml apps.release-android-wikipedia.path' },
            },
            sourceTrace: {},
          },
          appState: 'reset',
          appium: { managed: false },
          sourceTrace: [],
        },
      ),
    ).rejects.toMatchObject({
      category: 'app-install',
      message: expect.stringContaining('requires app.browserstack'),
    })

    expect(coreMocks.resolveMobileCapabilities).not.toHaveBeenCalled()
  })
})

describe('resolveTarget — flat target shape', () => {
  function makeConfig(targets?: Record<string, unknown>): AgentQaConfig {
    return {
      registry: {
        llms: [],
        ...(targets ? { targets } : {}),
      },
    } as unknown as AgentQaConfig
  }

  it('resolves mobile target with bundleId (no device field)', () => {
    const config = makeConfig({
      'my-android': {
        platform: 'android',
        bundleId: 'com.example.app',
      },
    })

    const resolved = resolveTarget(config, 'my-android')
    expect(resolved.bundleId).toBe('com.example.app')
    expect(resolved.platform).toBe('android')
    expect((resolved as any).device).toBeUndefined()
  })

  it('resolves web target with url', () => {
    const config = makeConfig({
      webapp: {
        platform: 'web',
        url: 'https://staging.example.com',
      },
    })

    const resolved = resolveTarget(config, 'webapp')
    expect(resolved.url).toBe('https://staging.example.com')
    expect((resolved as any).device).toBeUndefined()
  })
})
