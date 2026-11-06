import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteRefusalError } from '@vostride/agent-qa-runner'
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

function iosTargetWithDevice() {
  return makeConfig({
    targets: {
      'release-ios-wdio': { platform: 'ios', bundleId: 'com.example', device: 'target-ios' },
    },
  })
}

function farmConfig(input: {
  app?: Record<string, unknown>
  capabilities?: Record<string, unknown>
  remoteCapabilities?: Record<string, unknown>
  plugin?: string
}) {
  const config = makeConfig({
    targets: {
      'shop-android': {
        platform: 'android',
        appPackage: 'com.example.shop',
        ...(input.app ? { app: input.app } : {}),
      },
    },
    devices: {
      'galaxy-farm': {
        platform: 'android',
        model: 'Samsung Galaxy S24',
        remote: 'farm',
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      },
    },
  })
  return {
    ...config,
    registry: {
      ...config.registry,
      remotes: [
        {
          name: 'farm',
          ...(input.plugin === undefined
            ? { protocol: 'appium', url: 'https://farm.example.com/wd/hub' }
            : { plugin: input.plugin }),
          ...(input.remoteCapabilities ? { capabilities: input.remoteCapabilities } : {}),
        },
      ],
    },
  }
}

function expectRemoteRefusal(fn: () => unknown) {
  try {
    fn()
    expect.unreachable()
  } catch (err) {
    expect(err).toBeInstanceOf(RemoteRefusalError)
    return err as RemoteRefusalError
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

  it("uses the target's device when neither --device nor use.device names one", () => {
    const resolved = resolveMobileRunConfig({
      config: iosTargetWithDevice(),
      targetName: 'release-ios-wdio',
    })

    expect(resolved.deviceName).toBe('target-ios')
    expect(resolved.sourceTrace).toContain(
      'device=registry.targets.release-ios-wdio.device:target-ios',
    )
  })

  it("prefers use.device over the target's device", () => {
    const resolved = resolveMobileRunConfig({
      config: iosTargetWithDevice(),
      targetName: 'release-ios-wdio',
      useDeviceName: 'use-ios',
    })

    expect(resolved.deviceName).toBe('use-ios')
  })

  it("prefers the --device flag over use.device and the target's device", () => {
    const resolved = resolveMobileRunConfig({
      config: iosTargetWithDevice(),
      targetName: 'release-ios-wdio',
      explicitDeviceName: 'explicit-ios',
      useDeviceName: 'use-ios',
    })

    expect(resolved.deviceName).toBe('explicit-ios')
  })

  it('refuses a mobile test with no device anywhere, naming the three places to set one', () => {
    const err = expectMobileSetupError(() => resolveMobileRunConfigBase({
      appState: 'preserve',
      config: makeConfig(),
      targetName: 'release-ios-wdio',
    }))

    expect(err.category).toBe('device-resolution')
    expect(err.message).toBe(
      'No device specified for mobile target "release-ios-wdio". Set device on ' +
        'registry.targets.release-ios-wdio, use.device in the test or its suite, or pass --device.',
    )
  })

  it('plans a search here for a device with no remote, by its model, os and id', () => {
    const resolved = resolveMobileRunConfig({
      config: makeConfig({
        devices: {
          pixel: { platform: 'android', model: 'Pixel 8', os: '14', id: 'emulator-5554' },
        },
      }),
      targetName: 'release-android-wikipedia',
      useDeviceName: 'pixel',
    })

    expect(resolved.plan).toEqual({
      kind: 'here',
      search: { model: 'Pixel 8', os: '14', id: 'emulator-5554' },
    })
  })

  it('plans a search here with only the fields the device states', () => {
    const resolved = resolveMobileRunConfig({
      config: makeConfig(),
      targetName: 'release-android-wikipedia',
      useDeviceName: 'android-emu',
    })

    expect(resolved.plan).toEqual({ kind: 'here', search: {} })
  })

  it("plans a device on an appium remote to that remote, with the remote's capabilities", () => {
    const config = makeConfig({
      devices: {
        'galaxy-farm': { platform: 'android', model: 'Samsung Galaxy S24', remote: 'farm' },
      },
    })
    const resolved = resolveMobileRunConfig({
      config: {
        ...config,
        registry: {
          ...config.registry,
          remotes: [
            {
              name: 'farm',
              protocol: 'appium',
              url: 'https://farm.example.com/wd/hub',
              connectTimeout: 60_000,
              capabilities: { 'farm:options': { build: 'nightly' } },
            },
          ],
        },
      },
      targetName: 'release-android-wikipedia',
      useDeviceName: 'galaxy-farm',
    })

    const remote = {
      name: 'farm',
      protocol: 'appium',
      url: 'https://farm.example.com/wd/hub',
      connectTimeoutMs: 60_000,
      capabilities: { 'farm:options': { build: 'nightly' } },
    }
    expect(resolved.plan).toEqual({ kind: 'remote', remote })
    expect(resolved.device.remote).toEqual(remote)
  })

  it("carries the target's app.ref", () => {
    const resolved = resolveMobileRunConfig({
      config: makeConfig({
        targets: {
          'release-android-wikipedia': {
            platform: 'android',
            appPackage: 'org.wikipedia.alpha',
            app: { ref: 'https://builds.example.com/wikipedia.apk' },
          },
        },
      }),
      targetName: 'release-android-wikipedia',
      useDeviceName: 'android-emu',
    })

    expect(resolved.app.ref).toBe('https://builds.example.com/wikipedia.apk')
    expect(resolved.app.sourceTrace['app.ref']).toBe(
      'registry.targets.release-android-wikipedia.app.ref',
    )
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

  it("keeps a remote device's model and os beside its remote", () => {
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
    })

    expect(resolved.device).toMatchObject({
      name: 'galaxy-farm',
      model: 'Samsung Galaxy S24',
      os: '14',
      remote: { name: 'farm', protocol: 'appium', url: 'https://farm.example.com/wd/hub' },
    })
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

  describe('the app a remote device installs', () => {
    it('refuses a remote device whose target has only app.path, with no app file needed', () =>
      withTempDir((dir) => {
        const err = expectRemoteRefusal(() =>
          resolveMobileRunConfig({
            config: farmConfig({ app: { path: 'builds/shop.apk' } }),
            targetName: 'shop-android',
            useDeviceName: 'galaxy-farm',
            configFilePath: join(dir, 'agent-qa.config.yaml'),
          }),
        )

        expect(err.message).toBe(
          'Device galaxy-farm runs on remote farm, and target shop-android has only app.path. ' +
            'Set app.ref to the app the server installs.',
        )
        expect(err.remote).toBe('farm')
      }))

    it('keeps the app.path of a target whose device is on a plugin remote, for its plugin to upload', () =>
      withTempDir((dir) => {
        const resolved = resolveMobileRunConfig({
          config: farmConfig({ app: { path: 'builds/shop.apk' }, plugin: 'stack' }),
          targetName: 'shop-android',
          useDeviceName: 'galaxy-farm',
          configFilePath: join(dir, 'agent-qa.config.yaml'),
        })

        expect(resolved.plan.kind).toBe('remote')
        expect(resolved.app.ref).toBeUndefined()
        expect(resolved.app.install?.path).toBe(join(dir, 'builds/shop.apk'))
      }))

    it('accepts app.ref with no app file on this machine', () =>
      withTempDir((dir) => {
        const resolved = resolveMobileRunConfig({
          config: farmConfig({
            app: { path: 'builds/shop.apk', ref: 'https://builds.example.com/shop.apk' },
          }),
          targetName: 'shop-android',
          useDeviceName: 'galaxy-farm',
          configFilePath: join(dir, 'agent-qa.config.yaml'),
        })

        expect(resolved.plan.kind).toBe('remote')
        expect(resolved.app.ref).toBe('https://builds.example.com/shop.apk')
      }))

    it("accepts a device's own appium:app over a target with only app.path", () =>
      withTempDir((dir) => {
        const resolved = resolveMobileRunConfig({
          config: farmConfig({
            app: { path: 'builds/shop.apk' },
            capabilities: { 'appium:app': 'farm://shop-build' },
          }),
          targetName: 'shop-android',
          useDeviceName: 'galaxy-farm',
          configFilePath: join(dir, 'agent-qa.config.yaml'),
        })

        expect(resolved.plan.kind).toBe('remote')
        expect(resolved.app.ref).toBeUndefined()
      }))

    it("accepts a remote's appium:app over a target with only app.path", () => {
      const resolved = resolveMobileRunConfig({
        config: farmConfig({
          app: { path: 'builds/shop.apk' },
          remoteCapabilities: { 'appium:options': { app: 'farm://shop-build' } },
        }),
        targetName: 'shop-android',
        useDeviceName: 'galaxy-farm',
      })

      expect(resolved.plan.kind).toBe('remote')
    })

    it('still refuses a missing app.path file for a device here', () =>
      withTempDir((dir) => {
        const err = expectMobileSetupError(() =>
          resolveMobileRunConfig({
            config: makeConfig({
              targets: {
                'shop-android': {
                  platform: 'android',
                  appPackage: 'com.example.shop',
                  app: { path: 'builds/shop.apk', ref: 'https://builds.example.com/shop.apk' },
                },
              },
            }),
            targetName: 'shop-android',
            useDeviceName: 'android-emu',
            configFilePath: join(dir, 'agent-qa.config.yaml'),
          }),
        )

        expect(err.category).toBe('app-install')
        expect(err.message).toBe(`Configured app path not found: ${join(dir, 'builds/shop.apk')}`)
      }))
  })

  describe('capabilities that contradict the config at run start', () => {
    it("refuses a remote device's appium:appPackage that differs from the target's", () => {
      const err = expectRemoteRefusal(() =>
        resolveMobileRunConfig({
          config: farmConfig({
            app: { ref: 'https://builds.example.com/shop.apk' },
            capabilities: { 'appium:appPackage': 'com.example.other' },
          }),
          targetName: 'shop-android',
          useDeviceName: 'galaxy-farm',
        }),
      )

      expect(err.message).toBe(
        'Device galaxy-farm sets appium:appPackage "com.example.other" in its capabilities; ' +
          'target shop-android has appPackage com.example.shop.',
      )
      expect(err.remote).toBe('farm')
    })

    it('refuses appium:noReset on a device here when use.mobile.appState is reset', () => {
      const err = expectRemoteRefusal(() =>
        resolveMobileRunConfigBase({
          appState: 'reset',
          config: makeConfig({
            devices: {
              pixel: {
                platform: 'android',
                model: 'Pixel 8',
                capabilities: { 'appium:noReset': true },
              },
            },
          }),
          targetName: 'release-android-wikipedia',
          useDeviceName: 'pixel',
        }),
      )

      expect(err.message).toBe(
        'Device pixel sets appium:noReset true in its capabilities; use.mobile.appState is reset.',
      )
      expect(err.remote).toBeUndefined()
    })

    it("names the remote and the device when a remote's capabilities contradict", () => {
      const err = expectRemoteRefusal(() =>
        resolveMobileRunConfigBase({
          appState: 'preserve',
          config: farmConfig({
            app: { ref: 'https://builds.example.com/shop.apk' },
            remoteCapabilities: { 'appium:fullReset': true },
          }),
          targetName: 'shop-android',
          useDeviceName: 'galaxy-farm',
        }),
      )

      expect(err.message).toBe(
        'Remote farm sets appium:fullReset true in its capabilities; ' +
          'use.mobile.appState is preserve.',
      )
    })

    it('puts each contradiction on its own line', () => {
      const err = expectRemoteRefusal(() =>
        resolveMobileRunConfigBase({
          appState: 'reset',
          config: makeConfig({
            devices: {
              pixel: {
                platform: 'android',
                capabilities: {
                  'appium:appPackage': 'com.example.other',
                  'appium:noReset': true,
                },
              },
            },
          }),
          targetName: 'release-android-wikipedia',
          useDeviceName: 'pixel',
        }),
      )

      expect(err.message.split('\n')).toEqual([
        'Device pixel sets appium:appPackage "com.example.other" in its capabilities; ' +
          'target release-android-wikipedia has appPackage org.wikipedia.alpha.',
        'Device pixel sets appium:noReset true in its capabilities; use.mobile.appState is reset.',
      ])
    })

    it('leaves the app state to a mobile browser, whose device sets no app', () => {
      const resolved = resolveMobileRunConfigBase({
        appState: 'reset',
        config: farmConfig({
          app: { path: 'builds/shop.apk' },
          capabilities: { browserName: 'Chrome', 'appium:noReset': true },
        }),
        targetName: 'shop-android',
        useDeviceName: 'galaxy-farm',
      })

      expect(resolved.plan.kind).toBe('remote')
    })
  })
})
