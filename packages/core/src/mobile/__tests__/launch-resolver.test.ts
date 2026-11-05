import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MobileSetupError, resolveMobileRunConfig as resolveMobileRunConfigBase } from '../launch-resolver.js'

function makeConfig(overrides?: {
  targets?: Record<string, unknown>
  devices?: Record<string, unknown>
  use?: Record<string, unknown>
}) {
  return {
    registry: {
      targets: {
        'release-android-wikipedia': {
          platform: 'android',
          appPackage: 'org.wikipedia.alpha',
        },
        'release-ios-wdio': {
          platform: 'ios',
          bundleId: 'org.reactjs.native.example.wdiodemoapp',
        },
        web: {
          platform: 'web',
          url: 'https://example.com',
        },
        ...(overrides?.targets ?? {}),
      },
      devices: {
        'android-emu': {
          platform: 'android',
          capabilities: { 'appium:automationName': 'UiAutomator2' },
        },
        'ios-sim': {
          platform: 'ios',
          capabilities: { 'appium:automationName': 'XCUITest' },
        },
        'explicit-ios': {
          platform: 'ios',
          capabilities: { 'appium:automationName': 'XCUITest' },
        },
        'use-ios': {
          platform: 'ios',
          capabilities: { 'appium:automationName': 'XCUITest' },
        },
        'target-ios': {
          platform: 'ios',
          capabilities: { 'appium:automationName': 'XCUITest' },
        },
        'config-ios': {
          platform: 'ios',
          capabilities: { 'appium:automationName': 'XCUITest' },
        },
        ...(overrides?.devices ?? {}),
      },
    },
    use: overrides?.use ?? {},
  }
}

function expectMobileSetupError(fn: () => unknown) {
  try {
    fn()
    expect.unreachable()
  } catch (err) {
    expect(err).toBeInstanceOf(MobileSetupError)
    return err as MobileSetupError
  }
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-app-install-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function resolveMobileRunConfig(input: Parameters<typeof resolveMobileRunConfigBase>[0]) {
  return resolveMobileRunConfigBase({ appState: 'preserve', ...input })
}

describe('resolveMobileRunConfig', () => {
  it('resolves Android target app identity separately from device identity', () => {
    const resolved = resolveMobileRunConfig({
      config: makeConfig(),
      targetName: 'release-android-wikipedia',
      useDeviceName: 'android-emu',
    })

    expect(resolved.app.appPackage).toBe('org.wikipedia.alpha')
    expect(resolved.app.deepLinkAppId).toBe('org.wikipedia.alpha')
    expect(resolved.device.name).toBe('android-emu')
    expect(resolved.device.capabilities).toEqual({ 'appium:automationName': 'UiAutomator2' })
    expect(resolved.appState).toBe('preserve')
    expect(resolved.sourceTrace).toContain('appState=use.mobile.appState:preserve')
  })

  it('returns reset app state when requested', () => {
    const resolved = resolveMobileRunConfigBase({
      appState: 'reset',
      config: makeConfig(),
      targetName: 'release-android-wikipedia',
      useDeviceName: 'android-emu',
    })

    expect(resolved.appState).toBe('reset')
    expect(resolved.sourceTrace).toContain('appState=use.mobile.appState:reset')
  })

  it('resolves iOS target app identity separately from device identity', () => {
    const resolved = resolveMobileRunConfig({
      config: makeConfig(),
      targetName: 'release-ios-wdio',
      useDeviceName: 'ios-sim',
    })

    expect(resolved.app.bundleId).toBe('org.reactjs.native.example.wdiodemoapp')
    expect(resolved.app.deepLinkAppId).toBe('org.reactjs.native.example.wdiodemoapp')
    expect(resolved.device.name).toBe('ios-sim')
    expect(resolved.device.capabilities).toEqual({ 'appium:automationName': 'XCUITest' })
  })

  it('prefers explicit device override over use.device', () => {
    const resolved = resolveMobileRunConfig({
      config: makeConfig(),
      targetName: 'release-ios-wdio',
      explicitDeviceName: 'explicit-ios',
      useDeviceName: 'use-ios',
    })

    expect(resolved.deviceName).toBe('explicit-ios')
  })

  it('uses use.device when no explicit device override exists', () => {
    const resolved = resolveMobileRunConfig({
      config: makeConfig(),
      targetName: 'release-ios-wdio',
      useDeviceName: 'use-ios',
    })

    expect(resolved.deviceName).toBe('use-ios')
  })

  it('does not fall back to target or global config default device', () => {
    const err = expectMobileSetupError(() => resolveMobileRunConfigBase({
      appState: 'preserve',
      config: makeConfig(),
      targetName: 'release-ios-wdio',
    }))

    expect(err.category).toBe('device-resolution')
    expect(err.message).toContain('No device specified for mobile target')
  })

  it('carries the device model, os, id and capabilities, and takes app ids from the target', () => {
    const resolved = resolveMobileRunConfig({
      config: makeConfig({
        devices: {
          pixel: {
            platform: 'android',
            model: 'Pixel 8',
            os: '14',
            id: 'emulator-5554',
            capabilities: { 'appium:automationName': 'Espresso' },
          },
        },
      }),
      targetName: 'release-android-wikipedia',
      useDeviceName: 'pixel',
    })

    expect(resolved.device).toEqual({
      name: 'pixel',
      platform: 'android',
      model: 'Pixel 8',
      os: '14',
      id: 'emulator-5554',
      capabilities: { 'appium:automationName': 'Espresso' },
    })
    expect(resolved.app.appPackage).toBe('org.wikipedia.alpha')
    expect(resolved.app.sourceTrace.appPackage).toBe(
      'registry.targets.release-android-wikipedia.appPackage',
    )
  })

  it('resolves a device on an appium remote to that remote, with no local Appium url', () => {
    const config = {
      ...makeConfig({
        devices: {
          'galaxy-farm': {
            platform: 'android',
            model: 'Samsung Galaxy S24',
            os: '14',
            remote: 'farm',
          },
        },
      }),
    }
    const withRemotes = {
      ...config,
      registry: {
        ...config.registry,
        remotes: [{ name: 'farm', protocol: 'appium', url: 'https://farm.example.com/wd/hub' }],
      },
    }

    const resolved = resolveMobileRunConfig({
      config: withRemotes,
      targetName: 'release-android-wikipedia',
      useDeviceName: 'galaxy-farm',
      appiumUrl: 'http://127.0.0.1:4723',
    })

    expect(resolved.device).toMatchObject({
      name: 'galaxy-farm',
      model: 'Samsung Galaxy S24',
      os: '14',
      remote: { name: 'farm', protocol: 'appium', url: 'https://farm.example.com/wd/hub' },
    })
    expect(resolved.appium).toEqual({ managed: false })
  })

  it('throws device-resolution for a device whose remote is not listed', () => {
    const err = expectMobileSetupError(() =>
      resolveMobileRunConfig({
        config: makeConfig({ devices: { 'galaxy-farm': { platform: 'android', remote: 'farm' } } }),
        targetName: 'release-android-wikipedia',
        useDeviceName: 'galaxy-farm',
      }),
    )
    expect(err.category).toBe('device-resolution')
    expect(err.message).toBe(
      'Device galaxy-farm names remote "farm", which registry.remotes does not list. registry.remotes lists no remotes.',
    )
  })

  it('throws for missing mobile device', () => {
    const err = expectMobileSetupError(() => resolveMobileRunConfig({
      config: makeConfig(),
      targetName: 'release-ios-wdio',
    }))

    expect(err.category).toBe('device-resolution')
    expect(err.message).toContain('No device specified for mobile target')
  })

  it('throws for missing mobile app state', () => {
    const err = expectMobileSetupError(() => resolveMobileRunConfigBase({
      config: makeConfig(),
      targetName: 'release-ios-wdio',
      useDeviceName: 'ios-sim',
    }))

    expect(err.category).toBe('device-resolution')
    expect(err.message).toContain('use.mobile.appState is required')
  })

  it('throws for missing device profile', () => {
    const err = expectMobileSetupError(() => resolveMobileRunConfig({
      config: makeConfig(),
      targetName: 'release-ios-wdio',
      useDeviceName: 'missing-ios',
    }))

    expect(err.category).toBe('device-resolution')
    expect(err.message).toContain('Available devices:')
  })

  it('throws for non-mobile targets', () => {
    const err = expectMobileSetupError(() => resolveMobileRunConfig({
      config: makeConfig(),
      targetName: 'web',
      useDeviceName: 'ios-sim',
    }))

    expect(err.category).toBe('device-resolution')
    expect(err.message).toContain('is not a mobile target')
  })

  it('resolves the target app path relative to the config file', () => withTempDir((dir) => {
    const targetApp = join(dir, 'target.apk')
    writeFileSync(targetApp, 'target')

    const resolved = resolveMobileRunConfig({
      config: makeConfig({
        targets: {
          'release-android-wikipedia': {
            platform: 'android',
            appPackage: 'org.wikipedia.alpha',
            app: { path: 'target.apk' },
          },
        },
      }),
      targetName: 'release-android-wikipedia',
      useDeviceName: 'android-emu',
      configFilePath: join(dir, 'agent-qa.config.yaml'),
    })

    expect(resolved.app.install?.path).toBe(targetApp)
  }))

  it('preserves installed-app behavior when no app install data exists', () => {
    const resolved = resolveMobileRunConfig({
      config: makeConfig(),
      targetName: 'release-android-wikipedia',
      useDeviceName: 'android-emu',
    })

    expect(resolved.app.install).toBeUndefined()
    expect(resolved.app.appPackage).toBe('org.wikipedia.alpha')
  })

  it('throws app-install for a missing target app path', () => withTempDir((dir) => {
    const err = expectMobileSetupError(() => resolveMobileRunConfig({
      config: makeConfig({
        targets: {
          'release-android-wikipedia': {
            platform: 'android',
            appPackage: 'org.wikipedia.alpha',
            app: { path: 'missing.apk' },
          },
        },
      }),
      targetName: 'release-android-wikipedia',
      useDeviceName: 'android-emu',
      configFilePath: join(dir, 'agent-qa.config.yaml'),
    }))

    expect(err.category).toBe('app-install')
    expect(err.message).toContain('Configured app path not found')
  }))

  it('throws app-install for absolute app path', () => {
    const err = expectMobileSetupError(() => resolveMobileRunConfig({
      config: makeConfig({
        targets: {
          'release-android-wikipedia': {
            platform: 'android',
            appPackage: 'org.wikipedia.alpha',
            app: { path: '/tmp/app.apk' },
          },
        },
      }),
      targetName: 'release-android-wikipedia',
      useDeviceName: 'android-emu',
    }))

    expect(err.category).toBe('app-install')
  })

  it('keeps app identity separate from app install path', () => withTempDir((dir) => {
    const appFile = join(dir, 'release.apk')
    writeFileSync(appFile, 'target')

    const resolved = resolveMobileRunConfig({
      config: makeConfig({
        targets: {
          'release-android-wikipedia': {
            platform: 'android',
            appPackage: 'org.wikipedia.alpha',
            appActivity: '.MainActivity',
            app: { path: 'release.apk' },
          },
        },
      }),
      targetName: 'release-android-wikipedia',
      useDeviceName: 'android-emu',
      configFilePath: join(dir, 'agent-qa.config.yaml'),
    })

    expect(resolved.app.install?.path).toBe(appFile)
    expect(resolved.app.appPackage).toBe('org.wikipedia.alpha')
    expect(resolved.app.appActivity).toBe('.MainActivity')
  }))

  it('records app install source trace', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'release.apk'), 'target')

    const resolved = resolveMobileRunConfig({
      config: makeConfig({
        targets: {
          'release-android-wikipedia': {
            platform: 'android',
            appPackage: 'org.wikipedia.alpha',
            app: { path: 'release.apk' },
          },
        },
      }),
      targetName: 'release-android-wikipedia',
      useDeviceName: 'android-emu',
      configFilePath: join(dir, 'agent-qa.config.yaml'),
    })

    expect(resolved.app.install?.sourceTrace['app.path']).toBe(
      'agent-qa.config.yaml registry.targets.release-android-wikipedia.app.path',
    )
    expect(resolved.sourceTrace).toContain(
      'app.path=agent-qa.config.yaml registry.targets.release-android-wikipedia.app.path',
    )
  }))
})
