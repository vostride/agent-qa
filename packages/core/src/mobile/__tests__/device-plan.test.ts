import { describe, expect, it } from 'vitest'

import {
  W3C_STANDARD_CAPABILITIES,
  capabilityValue,
  mergeCapabilities,
  remoteAppCapability,
  remoteDerivedIdentity,
  runStartCapabilityContradictions,
  staticCapabilityContradictions,
  type RemoteAppInput,
  type RunStartCapabilityInput,
  type StaticCapabilityInput,
} from '../device-plan.js'

function contradictions(input: Partial<StaticCapabilityInput>) {
  return staticCapabilityContradictions({ device: 'galaxy-farm', platform: 'android', ...input })
}

function runStart(input: Partial<RunStartCapabilityInput>) {
  return runStartCapabilityContradictions({
    device: 'galaxy-farm',
    target: { name: 'shop-android', appPackage: 'com.example.shop', appActivity: '.MainActivity' },
    appState: 'preserve',
    browserMode: false,
    ...input,
  })
}

function remoteApp(input: Partial<RemoteAppInput>) {
  return remoteAppCapability({
    device: 'galaxy-farm',
    remote: 'farm',
    target: 'shop-android',
    capabilities: {},
    ...input,
  })
}

describe('mergeCapabilities', () => {
  it('applies derived, then the remote, then the device, later layers winning', () => {
    const merged = mergeCapabilities(
      {
        platformName: 'Android',
        'appium:newCommandTimeout': 90,
        'appium:automationName': 'UiAutomator2',
      },
      { 'appium:newCommandTimeout': 120, 'farm:build': 'nightly' },
      { 'appium:newCommandTimeout': 180, 'appium:automationName': 'Espresso' },
    )
    expect(merged).toEqual({
      platformName: 'Android',
      'appium:newCommandTimeout': 180,
      'appium:automationName': 'Espresso',
      'farm:build': 'nightly',
    })
  })

  it('merges plain objects key by key', () => {
    const merged = mergeCapabilities(
      { 'farm:options': { project: 'shop', region: 'eu', video: { enabled: true, fps: 10 } } },
      { 'farm:options': { region: 'us', video: { fps: 30 } } },
    )
    expect(merged).toEqual({
      'farm:options': { project: 'shop', region: 'us', video: { enabled: true, fps: 30 } },
    })
  })

  it('replaces arrays and scalars instead of merging them', () => {
    const merged = mergeCapabilities(
      { 'appium:otherApps': ['a.apk', 'b.apk'], 'farm:options': { tags: ['smoke'] } },
      { 'appium:otherApps': ['c.apk'], 'farm:options': 'plain' },
    )
    expect(merged).toEqual({ 'appium:otherApps': ['c.apk'], 'farm:options': 'plain' })
  })

  it('removes a key set to null, at the top level and inside an object', () => {
    const merged = mergeCapabilities(
      {
        'appium:newCommandTimeout': 90,
        'farm:options': { project: 'shop', region: 'eu' },
      },
      { 'appium:newCommandTimeout': null, 'farm:options': { region: null } },
      { 'farm:extra': { keep: 1, drop: null } },
    )
    expect(merged).toEqual({ 'farm:options': { project: 'shop' }, 'farm:extra': { keep: 1 } })
  })

  it('leaves its inputs unchanged', () => {
    const derived = { 'farm:options': { region: 'eu' }, 'appium:otherApps': ['a.apk'] }
    const device = { 'farm:options': { region: null, project: 'shop' } }
    const derivedCopy = structuredClone(derived)
    const deviceCopy = structuredClone(device)
    const merged = mergeCapabilities(derived, undefined, device)
    ;(merged['appium:otherApps'] as string[]).push('b.apk')
    expect(derived).toEqual(derivedCopy)
    expect(device).toEqual(deviceCopy)
    expect(merged).toEqual({
      'farm:options': { project: 'shop' },
      'appium:otherApps': ['a.apk', 'b.apk'],
    })
  })

  it('keeps a __proto__ key as data', () => {
    const layer = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>
    const merged = mergeCapabilities(layer)
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(merged)).toEqual(['__proto__'])
  })
})

describe('capabilityValue', () => {
  it('reads an appium: key, an appium:options child over it, and a W3C name', () => {
    expect(capabilityValue({ 'appium:deviceName': 'Pixel 9' }, 'deviceName')).toBe('Pixel 9')
    expect(
      capabilityValue(
        { 'appium:deviceName': 'Pixel 9', 'appium:options': { deviceName: 'Pixel 8' } },
        'deviceName',
      ),
    ).toBe('Pixel 8')
    expect(capabilityValue({ platformName: 'Android' }, 'platformName')).toBe('Android')
    expect(capabilityValue({}, 'deviceName')).toBeUndefined()
  })
})

describe('staticCapabilityContradictions', () => {
  it('names the device and its model when appium:deviceName differs', () => {
    expect(
      contradictions({
        model: 'Samsung Galaxy S24',
        capabilities: { 'appium:deviceName': 'Pixel 9' },
      }),
    ).toEqual([
      'Device galaxy-farm sets appium:deviceName "Pixel 9" in its capabilities; its model is Samsung Galaxy S24.',
    ])
  })

  it('counts an appium:options child as an appium: key', () => {
    expect(
      contradictions({
        model: 'Samsung Galaxy S24',
        capabilities: { 'appium:options': { deviceName: 'Pixel 9' } },
      }),
    ).toEqual([
      'Device galaxy-farm sets appium:options.deviceName "Pixel 9" in its capabilities; its model is Samsung Galaxy S24.',
    ])
  })

  it('names the remote when its capabilities contradict the device', () => {
    expect(
      contradictions({
        model: 'Samsung Galaxy S24',
        remote: {
          name: 'farm',
          capabilities: { platformName: 'iOS', 'appium:deviceName': 'Pixel 9' },
        },
      }),
    ).toEqual([
      'Remote farm sets platformName "iOS" in its capabilities; device galaxy-farm is android.',
      'Remote farm sets appium:deviceName "Pixel 9" in its capabilities; device galaxy-farm\'s model is Samsung Galaxy S24.',
    ])
  })

  it('refuses a platformName for the other platform on the device', () => {
    expect(contradictions({ capabilities: { platformName: 'iOS' } })).toEqual([
      'Device galaxy-farm sets platformName "iOS" in its capabilities; the device is android.',
    ])
  })

  it('compares platformName without case', () => {
    expect(contradictions({ capabilities: { platformName: ' ANDROID ' } })).toEqual([])
  })

  it('refuses a driver that serves the other platform', () => {
    expect(contradictions({ capabilities: { 'appium:automationName': 'XCUITest' } })).toEqual([
      'Device galaxy-farm sets appium:automationName "XCUITest" in its capabilities; that driver serves ios, and the device is android.',
    ])
    expect(
      contradictions({
        device: 'iphone-farm',
        platform: 'ios',
        capabilities: { 'appium:automationName': 'espresso' },
      }),
    ).toEqual([
      'Device iphone-farm sets appium:automationName "espresso" in its capabilities; that driver serves android, and the device is ios.',
    ])
  })

  it('lets a same-platform driver and a driver serving both platforms through', () => {
    expect(contradictions({ capabilities: { 'appium:automationName': 'Espresso' } })).toEqual([])
    expect(contradictions({ capabilities: { 'appium:automationName': 'Flutter' } })).toEqual([])
    expect(
      contradictions({ platform: 'ios', capabilities: { 'appium:automationName': 'Flutter' } }),
    ).toEqual([])
  })

  it('refuses appium:platformVersion against os and appium:udid against id', () => {
    expect(
      contradictions({
        os: '14',
        id: 'R5CT1234',
        capabilities: { 'appium:platformVersion': '15', 'appium:udid': 'emulator-5554' },
      }),
    ).toEqual([
      'Device galaxy-farm sets appium:platformVersion "15" in its capabilities; its os is 14.',
      'Device galaxy-farm sets appium:udid "emulator-5554" in its capabilities; its id is R5CT1234.',
    ])
  })

  it('compares trimmed values, a number as its text', () => {
    expect(
      contradictions({
        model: 'Samsung Galaxy S24',
        os: '14',
        capabilities: {
          'appium:deviceName': ' Samsung Galaxy S24 ',
          'appium:platformVersion': 14,
        },
      }),
    ).toEqual([])
  })

  it('compares only keys stated on both sides', () => {
    expect(
      contradictions({ capabilities: { 'appium:deviceName': 'Pixel 9', 'appium:udid': 'abc' } }),
    ).toEqual([])
    expect(contradictions({ model: 'Pixel 9', os: '15', id: 'abc' })).toEqual([])
  })

  it('refuses an unprefixed key that is not a W3C capability', () => {
    expect(
      contradictions({
        remote: { name: 'farm', capabilities: { realDevice: true } },
        capabilities: { deviceName: 'Pixel 9' },
      }),
    ).toEqual([
      'Remote farm capabilities "realDevice" needs a vendor prefix, such as appium:realDevice.',
      'Device galaxy-farm capabilities "deviceName" needs a vendor prefix, such as appium:deviceName.',
    ])
  })

  it('accepts every W3C standard capability unprefixed', () => {
    const capabilities = Object.fromEntries(
      W3C_STANDARD_CAPABILITIES.filter((key) => key !== 'platformName').map((key) => [key, 'x']),
    )
    expect(contradictions({ capabilities: { ...capabilities, platformName: 'Android' } })).toEqual(
      [],
    )
  })
})

describe('runStartCapabilityContradictions', () => {
  it('refuses an app id the target states differently', () => {
    expect(
      runStart({
        capabilities: {
          'appium:appPackage': 'com.example.other',
          'appium:appActivity': '.LoginActivity',
        },
      }),
    ).toEqual([
      'Device galaxy-farm sets appium:appPackage "com.example.other" in its capabilities; target shop-android has appPackage com.example.shop.',
      'Device galaxy-farm sets appium:appActivity ".LoginActivity" in its capabilities; target shop-android has appActivity .MainActivity.',
    ])
    expect(
      runStart({
        device: 'iphone-farm',
        target: { name: 'shop-ios', bundleId: 'com.example.shop' },
        remote: {
          name: 'farm',
          capabilities: { 'appium:options': { bundleId: 'com.example.beta' } },
        },
      }),
    ).toEqual([
      'Remote farm sets appium:options.bundleId "com.example.beta" in its capabilities; target shop-ios has bundleId com.example.shop.',
    ])
  })

  it('lets matching app ids and ids the target does not state through', () => {
    expect(
      runStart({
        capabilities: { 'appium:appPackage': ' com.example.shop ', 'appium:bundleId': 'any' },
      }),
    ).toEqual([])
  })

  it('refuses appium:noReset that differs from use.mobile.appState', () => {
    expect(runStart({ appState: 'reset', capabilities: { 'appium:noReset': true } })).toEqual([
      'Device galaxy-farm sets appium:noReset true in its capabilities; use.mobile.appState is reset.',
    ])
    expect(
      runStart({ remote: { name: 'farm', capabilities: { 'appium:noReset': false } } }),
    ).toEqual([
      'Remote farm sets appium:noReset false in its capabilities; use.mobile.appState is preserve.',
    ])
    expect(runStart({ capabilities: { 'appium:noReset': true } })).toEqual([])
    expect(runStart({ appState: 'reset', capabilities: { 'appium:noReset': false } })).toEqual([])
  })

  it('refuses appium:fullReset true when use.mobile.appState is preserve', () => {
    expect(runStart({ capabilities: { 'appium:fullReset': true } })).toEqual([
      'Device galaxy-farm sets appium:fullReset true in its capabilities; use.mobile.appState is preserve.',
    ])
    expect(runStart({ appState: 'reset', capabilities: { 'appium:fullReset': true } })).toEqual([])
    expect(runStart({ capabilities: { 'appium:fullReset': false } })).toEqual([])
  })

  it('skips the app state checks in browser mode', () => {
    expect(
      runStart({
        browserMode: true,
        appState: 'reset',
        capabilities: { 'appium:noReset': true, browserName: 'Chrome' },
      }),
    ).toEqual([])
  })
})

describe('remoteAppCapability', () => {
  it('installs the target app.ref as appium:app', () => {
    expect(remoteApp({ appRef: 'storage:filename=shop.apk', appPath: 'build/shop.apk' })).toEqual({
      app: 'storage:filename=shop.apk',
    })
  })

  it('lets an appium:app in the capabilities win over app.ref', () => {
    expect(
      remoteApp({
        appRef: 'storage:filename=shop.apk',
        capabilities: { 'appium:app': 'bs://abc' },
      }),
    ).toEqual({})
    expect(
      remoteApp({
        appPath: 'build/shop.apk',
        capabilities: { 'appium:options': { app: 'bs://abc' } },
      }),
    ).toEqual({})
  })

  it('refuses a target with only app.path', () => {
    expect(remoteApp({ appPath: 'build/shop.apk' })).toEqual({
      refusal:
        'Device galaxy-farm runs on remote farm, and target shop-android has only app.path. Set app.ref to the app the server installs.',
    })
  })

  it('installs nothing when the target names no app', () => {
    expect(remoteApp({})).toEqual({})
  })
})

describe('remoteDerivedIdentity', () => {
  it('sends model, os and id as deviceName, platformVersion and udid, each only when set', () => {
    const identity = remoteDerivedIdentity({
      model: 'Samsung Galaxy S.*',
      os: '14',
      id: 'R5CT1234',
    })
    expect(identity).toEqual({
      'appium:deviceName': 'Samsung Galaxy S.*',
      'appium:platformVersion': '14',
      'appium:udid': 'R5CT1234',
    })
    expect(remoteDerivedIdentity({ os: '17' })).toEqual({ 'appium:platformVersion': '17' })
    expect(remoteDerivedIdentity({})).toEqual({})
  })
})
