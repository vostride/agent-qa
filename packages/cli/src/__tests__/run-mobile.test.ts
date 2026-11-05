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

vi.mock('@vostride/agent-qa-android', () => ({
  AndroidPlatformAdapter: vi.fn(function () { return mockAndroidAdapter }),
}))

vi.mock('@vostride/agent-qa-ios', () => ({
  IOSPlatformAdapter: vi.fn(function () { return mockIOSAdapter }),
}))

vi.mock('@vostride/agent-qa-web', () => ({
  WebPlatformAdapter: vi.fn(function () { return mockWebAdapter }),
}))

import {
  createRemoteRefusalMemory,
  createRemoteSessionRegistry,
  SecretStore,
} from '@vostride/agent-qa-runner'

import { createPlatformAdapter, buildPlatformConfig, processRemoteSessions } from '../commands/run.js'
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

  it("hands both mobile adapters the run's connection secrets, secrets file, refusal memory, sessions and mask", async () => {
    const { AndroidPlatformAdapter } = await import('@vostride/agent-qa-android')
    const { IOSPlatformAdapter } = await import('@vostride/agent-qa-ios')
    const options = {
      connectionSecrets: new SecretStore({ FARM_TOKEN: 'farm-token-value' }),
      secretsFile: '.env.secrets.local',
      refusalMemory: createRemoteRefusalMemory(),
      sessions: createRemoteSessionRegistry(),
      mask: (text: string) => text.replaceAll('farm-token-value', '***'),
    }

    await createPlatformAdapter('android', options)
    await createPlatformAdapter('ios', options)

    expect(AndroidPlatformAdapter).toHaveBeenCalledWith(options)
    expect(IOSPlatformAdapter).toHaveBeenCalledWith(options)
  })

  it('gives a mobile adapter built with no registry the one a signal releases', async () => {
    const { IOSPlatformAdapter } = await import('@vostride/agent-qa-ios')

    await createPlatformAdapter('ios')

    expect(IOSPlatformAdapter).toHaveBeenCalledWith({ sessions: processRemoteSessions })
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
      model: 'Pixel 7',
      os: '14',
      id: 'emulator-5554',
      capabilities: { 'appium:automationName': 'UiAutomator2' },
      remote: {
        name: 'farm',
        protocol: 'appium' as const,
        url: 'https://farm.example/wd/hub',
        connectTimeoutMs: 300_000,
      },
    }
    const config = buildPlatformConfig('android', resolvedDevice, { step: 15000 })

    expect(config.platform).toBe('android')
    expect(config.device).toEqual(resolvedDevice)
    expect(config.browser).toBeUndefined()
    expect(config.timeouts).toEqual({ step: 15000 })
  })

  it('passes Android target app identity separately from generic device identity', () => {
    const resolvedDevice = {
      name: 'android-emu',
      platform: 'android' as const,
      capabilities: { 'appium:automationName': 'UiAutomator2' },
    }
    const config = buildPlatformConfig('android', resolvedDevice, undefined, undefined, undefined, {
      platform: 'android',
      targetName: 'release-android-wikipedia',
      deviceName: 'android-emu',
      device: resolvedDevice,
      plan: { kind: 'here', search: {} },
      app: {
        appPackage: 'org.wikipedia.alpha',
        appActivity: '.main.MainActivity',
        deepLinkAppId: 'org.wikipedia.alpha',
        sourceTrace: {},
      },
      appState: 'reset',
      sourceTrace: [],
    })

    expect(config.device?.name).toBe('android-emu')
    expect(config.appPackage).toBe('org.wikipedia.alpha')
    expect(config.appActivity).toBe('.main.MainActivity')
    expect(config.appState).toBe('reset')
  })

  it('hands the session the device found here and the Appium chosen for it', () => {
    const resolvedDevice = { name: 'pixel', platform: 'android' as const, model: 'Pixel 8' }
    const config = buildPlatformConfig(
      'android',
      resolvedDevice,
      undefined,
      undefined,
      undefined,
      {
        platform: 'android',
        targetName: 'shop-android',
        deviceName: 'pixel',
        device: resolvedDevice,
        plan: { kind: 'here', search: { model: 'Pixel 8' } },
        app: { appPackage: 'com.example.shop', sourceTrace: {} },
        appState: 'preserve',
        sourceTrace: [],
      },
      undefined,
      { here: { avd: 'Pixel_8_API_35' }, appiumUrl: 'http://127.0.0.1:4723', managed: true },
    )

    expect(config.device?.here).toEqual({ avd: 'Pixel_8_API_35' })
    expect(config.appiumUrl).toBe('http://127.0.0.1:4723')
  })

  it('passes the resolved app path into mobile platform config', () => {
    const resolvedDevice = {
      name: 'android-emu',
      platform: 'android' as const,
      capabilities: { 'appium:automationName': 'UiAutomator2' },
    }
    const config = buildPlatformConfig('android', resolvedDevice, undefined, undefined, undefined, {
      platform: 'android',
      targetName: 'release-android-wikipedia',
      deviceName: 'android-emu',
      device: resolvedDevice,
      plan: { kind: 'here', search: {} },
      app: {
        appPackage: 'org.wikipedia.alpha',
        deepLinkAppId: 'org.wikipedia.alpha',
        install: {
          path: '/tmp/wikipedia.apk',
          sourceTrace: {
            'app.path': 'agent-qa.config.yaml registry.targets.release-android-wikipedia.app.path',
          },
        },
        sourceTrace: {},
      },
      appState: 'preserve',
      sourceTrace: [],
    })

    expect(config.appPath).toBe('/tmp/wikipedia.apk')
    expect(config.appPackage).toBe('org.wikipedia.alpha')
  })

  it('preserves installed-app behavior when no app path resolves', () => {
    const resolvedDevice = {
      name: 'android-emu',
      platform: 'android' as const,
      capabilities: { 'appium:automationName': 'UiAutomator2' },
    }
    const config = buildPlatformConfig('android', resolvedDevice, undefined, undefined, undefined, {
      platform: 'android',
      targetName: 'release-android-wikipedia',
      deviceName: 'android-emu',
      device: resolvedDevice,
      plan: { kind: 'here', search: {} },
      app: {
        appPackage: 'org.wikipedia.alpha',
        deepLinkAppId: 'org.wikipedia.alpha',
        sourceTrace: {},
      },
      appState: 'preserve',
      sourceTrace: [],
    })

    expect(config.appPath).toBeUndefined()
    expect(config.appPackage).toBe('org.wikipedia.alpha')
  })

  it('builds ios config with device from resolvedDevice', () => {
    const resolvedDevice = {
      name: 'iphone-15',
      platform: 'ios' as const,
      id: '00008120-001E44F11ABC001E',
    }
    const config = buildPlatformConfig('ios', resolvedDevice, undefined)

    expect(config.platform).toBe('ios')
    expect(config.device?.name).toBe('iphone-15')
    expect(config.device?.id).toBe('00008120-001E44F11ABC001E')
    expect(config.browser).toBeUndefined()
  })

  it('passes iOS target bundle id separately from simulator device name', () => {
    const resolvedDevice = {
      name: 'ios-sim',
      platform: 'ios' as const,
      capabilities: { 'appium:automationName': 'XCUITest' },
    }
    const config = buildPlatformConfig('ios', resolvedDevice, undefined, undefined, undefined, {
      platform: 'ios',
      targetName: 'release-ios-wdio',
      deviceName: 'ios-sim',
      device: resolvedDevice,
      plan: { kind: 'here', search: {} },
      app: {
        bundleId: 'org.reactjs.native.example.wdiodemoapp',
        deepLinkAppId: 'org.reactjs.native.example.wdiodemoapp',
        sourceTrace: {},
      },
      appState: 'preserve',
      sourceTrace: [],
    })

    expect(config.device?.name).toBe('ios-sim')
    expect(config.bundleId).toBe('org.reactjs.native.example.wdiodemoapp')
  })

  it("carries the target's name, its app.ref and the device's remote with its capabilities", () => {
    const remote = {
      name: 'farm',
      protocol: 'appium' as const,
      url: 'https://farm.example/wd/hub',
      connectTimeoutMs: 300_000,
      capabilities: { 'farm:project': 'shop' },
    }
    const resolvedDevice = {
      name: 'iphone-farm',
      platform: 'ios' as const,
      model: 'iPhone 16',
      capabilities: { 'appium:orientation': 'PORTRAIT' },
      remote,
    }
    const config = buildPlatformConfig('ios', resolvedDevice, undefined, undefined, undefined, {
      platform: 'ios',
      targetName: 'shop-ios',
      deviceName: 'iphone-farm',
      device: resolvedDevice,
      plan: { kind: 'remote', remote },
      app: { ref: 'storage:shop-latest', bundleId: 'com.example.shop', sourceTrace: {} },
      appState: 'reset',
      sourceTrace: [],
    })

    expect(config.targetName).toBe('shop-ios')
    expect(config.appRef).toBe('storage:shop-latest')
    expect(config.device?.remote).toEqual(remote)
    expect(config.device?.capabilities).toEqual({ 'appium:orientation': 'PORTRAIT' })
  })

  it('carries no app.ref for a target that names none', () => {
    const resolvedDevice = { name: 'pixel', platform: 'android' as const, model: 'Pixel 8' }
    const config = buildPlatformConfig('android', resolvedDevice, undefined, undefined, undefined, {
      platform: 'android',
      targetName: 'shop-android',
      deviceName: 'pixel',
      device: resolvedDevice,
      plan: { kind: 'here', search: { model: 'Pixel 8' } },
      app: { appPackage: 'com.example.shop', sourceTrace: {} },
      appState: 'preserve',
      sourceTrace: [],
    })

    expect(config.targetName).toBe('shop-android')
    expect(config).not.toHaveProperty('appRef')
  })

  it('returns undefined device for mobile when no resolvedDevice', () => {
    const config = buildPlatformConfig('android', undefined, undefined)
    expect(config.device).toBeUndefined()
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
