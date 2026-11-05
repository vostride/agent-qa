import { describe, expect, it } from 'vitest'

import {
  describeAndroidHere,
  describeIOSHere,
  findDeviceHere,
  normalizeDeviceText,
  osMatches,
  type AndroidHere,
  type IOSHere,
  type SimulatorHere,
} from '../find-device-here.js'

function simulator(name: string, os: string, extra: Partial<SimulatorHere> = {}): SimulatorHere {
  return {
    name,
    os,
    udid: `${name.replace(/\s+/g, '-')}-${os}`,
    state: 'Shutdown',
    available: true,
    ...extra,
  }
}

const mac: IOSHere = {
  simulators: [simulator('iPhone 16 Pro', '18.4'), simulator('iPhone 15', '17.5')],
}

const noAndroid: AndroidHere = { attached: [], avds: [] }

describe('normalizeDeviceText and osMatches', () => {
  it('ignores case and treats spaces, _ and - as the same', () => {
    expect(normalizeDeviceText('SM_S921B')).toBe(normalizeDeviceText('sm-s921b'))
    expect(normalizeDeviceText(' Pixel__10 - Pro ')).toBe('pixel 10 pro')
  })

  it('matches an os by its leading components', () => {
    expect(osMatches('18', '18.2')).toBe(true)
    expect(osMatches('18.4', '18.4.1')).toBe(true)
    expect(osMatches('18.4', '18.40')).toBe(false)
    expect(osMatches('8.1', '8.1.0')).toBe(true)
    expect(osMatches('18.0', '18')).toBe(true)
    expect(osMatches('17', '18.0')).toBe(false)
    expect(osMatches('17', undefined)).toBe(false)
  })
})

describe('findDeviceHere on iOS', () => {
  it('refuses a model this Mac lacks with what it has', () => {
    expect(
      findDeviceHere({
        device: 'iphone',
        platform: 'ios',
        model: 'iPhone 16',
        os: '18.4',
        ios: mac,
      }),
    ).toEqual({
      refusal:
        'Device iphone wants an iPhone 16 simulator on iOS 18.4; this Mac has: iPhone 16 Pro (18.4), iPhone 15 (17.5). Set model or os in registry.devices.iphone.',
    })
  })

  it('finds a simulator by name, on the newest iOS when os is unset', () => {
    const ios: IOSHere = {
      simulators: [simulator('iPhone 16', '17.5'), simulator('iPhone 16', '18.4')],
    }
    expect(findDeviceHere({ device: 'iphone', platform: 'ios', model: 'iphone_16', ios })).toEqual({
      found: {
        udid: 'iPhone-16-18.4',
        name: 'iPhone 16',
        os: '18.4',
        running: false,
        description: 'iPhone 16 (18.4), shut down',
      },
    })
  })

  it('keeps to the os it is given, matched by components', () => {
    const ios: IOSHere = {
      simulators: [simulator('iPhone 16', '17.5'), simulator('iPhone 16', '18.2')],
    }
    const result = findDeviceHere({
      device: 'iphone',
      platform: 'ios',
      model: 'iPhone 16',
      os: '17',
      ios,
    })
    expect(result).toMatchObject({ found: { udid: 'iPhone-16-17.5', os: '17.5' } })
  })

  it('prefers a booted simulator when two are on the same iOS', () => {
    const ios: IOSHere = {
      simulators: [
        simulator('iPhone 16', '18.4', { udid: 'A' }),
        simulator('iPhone 16', '18.4', { udid: 'B', state: 'Booted' }),
      ],
    }
    expect(findDeviceHere({ device: 'iphone', platform: 'ios', model: 'iPhone 16', ios })).toEqual({
      found: {
        udid: 'B',
        name: 'iPhone 16',
        os: '18.4',
        running: true,
        description: 'iPhone 16 (18.4), booted',
      },
    })
  })

  it('never matches an unavailable simulator', () => {
    const ios: IOSHere = { simulators: [simulator('iPhone 16', '18.4', { available: false })] }
    expect(findDeviceHere({ device: 'iphone', platform: 'ios', model: 'iPhone 16', ios })).toEqual({
      refusal:
        'Device iphone wants an iPhone 16 simulator; this Mac has no simulators. Set model or os in registry.devices.iphone.',
    })
  })

  it('keeps only the simulator whose udid is id', () => {
    const ios: IOSHere = {
      simulators: [
        simulator('iPhone 16', '18.4', { udid: 'A', state: 'Booted' }),
        simulator('iPhone 16', '18.4', { udid: 'B' }),
      ],
    }
    const result = findDeviceHere({
      device: 'iphone',
      platform: 'ios',
      model: 'iPhone 16',
      id: 'B',
      ios,
    })
    expect(result).toMatchObject({ found: { udid: 'B', running: false } })
  })

  it('refuses two identical booted simulators and says to set id', () => {
    const ios: IOSHere = {
      simulators: [
        simulator('iPhone 16', '18.4', { udid: 'A', state: 'Booted' }),
        simulator('iPhone 16', '18.4', { udid: 'B', state: 'Booted' }),
      ],
    }
    expect(findDeviceHere({ device: 'iphone', platform: 'ios', model: 'iPhone 16', ios })).toEqual({
      refusal:
        'Device iphone matches two simulators, A and B (iPhone 16, iOS 18.4). Set id in registry.devices.iphone to pick one.',
    })
  })

  it('uses the one booted simulator when no model is set', () => {
    const ios: IOSHere = {
      simulators: [
        simulator('iPhone 15', '17.5'),
        simulator('iPhone 16', '18.4', { state: 'Booted' }),
      ],
    }
    expect(findDeviceHere({ device: 'iphone', platform: 'ios', ios })).toMatchObject({
      found: { name: 'iPhone 16', running: true },
    })
  })

  it('refuses no model when nothing is booted, naming what this Mac has', () => {
    expect(findDeviceHere({ device: 'iphone', platform: 'ios', ios: mac })).toEqual({
      refusal:
        'Device iphone names no model, and this Mac runs no iOS simulator. Start one, or set model in registry.devices.iphone. This Mac has: iPhone 16 Pro (18.4), iPhone 15 (17.5).',
    })
  })

  it('puts a listing problem in place of the list', () => {
    const ios: IOSHere = { simulators: [], problem: 'simulators need macOS' }
    expect(
      findDeviceHere({ device: 'iphone', platform: 'ios', model: 'iPhone 16', os: '18.4', ios }),
    ).toEqual({
      refusal:
        "Device iphone wants an iPhone 16 simulator on iOS 18.4; this Mac's simulators cannot be listed: simulators need macOS. Set model or os in registry.devices.iphone.",
    })
  })
})

const s24 = (serial: string) => ({ serial, state: 'device', model: 'SM_S921B', os: '14' })

const pixelAvd = {
  name: 'Pixel_10_Pro',
  profile: 'pixel_10_pro',
  displayName: 'Pixel 10 Pro',
  os: '17',
}

describe('findDeviceHere on Android', () => {
  it('matches a phone by its reported model, folding case and separators', () => {
    const android: AndroidHere = { attached: [s24('R58M41ABCDE')], avds: [] }
    expect(
      findDeviceHere({ device: 'rack', platform: 'android', model: 'sm-s921b', android }),
    ).toEqual({
      found: {
        udid: 'R58M41ABCDE',
        os: '14',
        running: true,
        description: 'SM_S921B phone R58M41ABCDE',
      },
    })
  })

  it('hands over an AVD that is not running by its name', () => {
    const android: AndroidHere = { attached: [], avds: [pixelAvd] }
    for (const model of ['Pixel 10 Pro', 'pixel_10_pro', 'Pixel_10_Pro']) {
      expect(findDeviceHere({ device: 'pixel', platform: 'android', model, android })).toEqual({
        found: {
          avd: 'Pixel_10_Pro',
          os: '17',
          running: false,
          description: 'Pixel_10_Pro (Pixel 10 Pro, Android 17), not running',
        },
      })
    }
  })

  it('hands over a running emulator by its serial, matched through its AVD profile', () => {
    const android: AndroidHere = {
      attached: [
        {
          serial: 'emulator-5554',
          state: 'device',
          model: 'sdk_gphone64_arm64',
          avd: 'Pixel_10_Pro',
        },
      ],
      avds: [pixelAvd],
    }
    expect(
      findDeviceHere({ device: 'pixel', platform: 'android', model: 'Pixel 10 Pro', android }),
    ).toEqual({
      found: {
        udid: 'emulator-5554',
        os: '17',
        running: true,
        description: 'Pixel_10_Pro emulator emulator-5554',
      },
    })
  })

  it('matches os as the Android version by components', () => {
    const android: AndroidHere = {
      attached: [{ serial: 'OLD1', state: 'device', model: 'Nexus 5X', os: '8.1.0' }],
      avds: [],
    }
    expect(
      findDeviceHere({
        device: 'nexus',
        platform: 'android',
        model: 'Nexus 5X',
        os: '8.1',
        android,
      }),
    ).toMatchObject({ found: { udid: 'OLD1' } })
    expect(
      findDeviceHere({
        device: 'nexus',
        platform: 'android',
        model: 'Nexus 5X',
        os: '8.10',
        android,
      }),
    ).toHaveProperty('refusal')
  })

  it('picks the newest Android, then a running device', () => {
    const android: AndroidHere = {
      attached: [{ serial: 'P8', state: 'device', model: 'Pixel 8', os: '15' }],
      avds: [
        { name: 'Pixel_8_API_36', profile: 'pixel_8', displayName: 'Pixel 8', os: '16' },
        { name: 'Pixel_8_API_35', profile: 'pixel_8', displayName: 'Pixel 8', os: '15' },
      ],
    }
    expect(
      findDeviceHere({ device: 'pixel', platform: 'android', model: 'Pixel 8', android }),
    ).toMatchObject({ found: { avd: 'Pixel_8_API_36', running: false } })
    expect(
      findDeviceHere({ device: 'pixel', platform: 'android', model: 'Pixel 8', os: '15', android }),
    ).toMatchObject({ found: { udid: 'P8', running: true } })
  })

  it('refuses two identical attached phones without id, naming both', () => {
    const android: AndroidHere = { attached: [s24('R58M41ABCDE'), s24('R58M41ABCDF')], avds: [] }
    expect(
      findDeviceHere({ device: 'rack-s24', platform: 'android', model: 'SM-S921B', android }),
    ).toEqual({
      refusal:
        'Device rack-s24 matches two attached phones, R58M41ABCDE and R58M41ABCDF (SM_S921B, Android 14). Set id in registry.devices.rack-s24 to pick one.',
    })
  })

  it('keeps only the unit whose serial is id, and still checks its model', () => {
    const android: AndroidHere = { attached: [s24('R58M41ABCDE'), s24('R58M41ABCDF')], avds: [] }
    expect(
      findDeviceHere({
        device: 'rack-s24-b',
        platform: 'android',
        model: 'SM-S921B',
        id: 'R58M41ABCDF',
        android,
      }),
    ).toMatchObject({ found: { udid: 'R58M41ABCDF' } })
    expect(
      findDeviceHere({
        device: 'rack-s24-b',
        platform: 'android',
        model: 'Pixel 8',
        id: 'R58M41ABCDF',
        android,
      }),
    ).toEqual({
      refusal:
        'Device rack-s24-b wants a Pixel 8 with serial R58M41ABCDF; this machine has: SM_S921B phone R58M41ABCDE (Android 14), SM_S921B phone R58M41ABCDF (Android 14). Set model or os in registry.devices.rack-s24-b.',
    })
  })

  it('never matches a phone that is not ready, but lists it', () => {
    const android: AndroidHere = {
      attached: [{ serial: 'R58M41ABCDE', state: 'unauthorized' }],
      avds: [{ name: 'Pixel_8_API_35', profile: 'pixel_8', displayName: 'Pixel 8', os: '15' }],
    }
    expect(
      findDeviceHere({ device: 'rack', platform: 'android', model: 'SM-S921B', os: '14', android }),
    ).toEqual({
      refusal:
        'Device rack wants a SM-S921B on Android 14; this machine has: phone R58M41ABCDE (unauthorized), Pixel_8_API_35 (Pixel 8, Android 15). Set model or os in registry.devices.rack.',
    })
  })

  it('never matches a simulator by model on Android', () => {
    expect(
      findDeviceHere({
        device: 'pixel',
        platform: 'android',
        model: 'iPhone 16 Pro',
        android: noAndroid,
        ios: mac,
      }),
    ).toEqual({
      refusal:
        'Device pixel wants an iPhone 16 Pro; this machine has no Android devices or AVDs. Set model or os in registry.devices.pixel.',
    })
  })

  it('puts a listing problem in place of the list', () => {
    const android: AndroidHere = {
      attached: [],
      avds: [],
      problem: 'adb not found (set ANDROID_HOME)',
    }
    expect(
      findDeviceHere({ device: 'pixel', platform: 'android', model: 'Pixel 8', os: '15', android }),
    ).toEqual({
      refusal:
        "Device pixel wants a Pixel 8 on Android 15; this machine's Android devices cannot be listed: adb not found (set ANDROID_HOME). Set model or os in registry.devices.pixel.",
    })
  })

  it('uses the one running device when no model is set', () => {
    const android: AndroidHere = {
      attached: [{ serial: '37121FDJH000', state: 'device', model: 'Pixel 8', os: '15' }],
      avds: [pixelAvd],
    }
    expect(findDeviceHere({ device: 'pixel', platform: 'android', android })).toEqual({
      found: {
        udid: '37121FDJH000',
        os: '15',
        running: true,
        description: 'Pixel 8 phone 37121FDJH000',
      },
    })
  })

  it('refuses no model when nothing runs, naming what this machine has', () => {
    const android: AndroidHere = {
      attached: [],
      avds: [{ name: 'Pixel_8_API_35', profile: 'pixel_8', displayName: 'Pixel 8', os: '15' }],
    }
    expect(findDeviceHere({ device: 'pixel', platform: 'android', android })).toEqual({
      refusal:
        'Device pixel names no model, and this machine runs no Android device. Start one, or set model in registry.devices.pixel. This machine has: Pixel_8_API_35 (Pixel 8, Android 15).',
    })
  })

  it('refuses no model when several run, naming them', () => {
    const android: AndroidHere = {
      attached: [
        { serial: '37121FDJH000', state: 'device', model: 'Pixel 8', os: '15' },
        s24('R58M41ABCDE'),
      ],
      avds: [],
    }
    expect(findDeviceHere({ device: 'pixel', platform: 'android', android })).toEqual({
      refusal:
        'Device pixel names no model, and this machine runs two Android devices: Pixel 8 phone 37121FDJH000 (Android 15), SM_S921B phone R58M41ABCDE (Android 14). Set model in registry.devices.pixel.',
    })
  })
})

describe('describeAndroidHere and describeIOSHere', () => {
  it('prints attached phones, emulators and simulators in the device view', () => {
    const android: AndroidHere = {
      attached: [
        { serial: 'R58M41ABCDE', state: 'device', model: 'SM-S921B', os: '14' },
        { serial: '37121FDJH000', state: 'device', model: 'Pixel 8', os: '15' },
      ],
      avds: [{ name: 'Pixel_8_API_35', profile: 'pixel_8', displayName: 'Pixel 8', os: '15' }],
    }
    const ios: IOSHere = {
      simulators: [simulator('iPhone 16', '18.4'), simulator('iPhone 15', '17.5')],
    }
    expect([...describeAndroidHere(android), ...describeIOSHere(ios)]).toEqual([
      'Attached:   SM-S921B  Android 14  R58M41ABCDE',
      '            Pixel 8   Android 15  37121FDJH000',
      'Emulators:  Pixel_8_API_35 (Pixel 8, Android 15)',
      'Simulators: iPhone 16 (18.4), iPhone 15 (17.5)',
    ])
  })

  it('shows a running emulator, an empty listing and a listing problem', () => {
    const android: AndroidHere = {
      attached: [
        {
          serial: 'emulator-5554',
          state: 'device',
          model: 'sdk_gphone64_arm64',
          avd: 'Pixel_10_Pro',
        },
      ],
      avds: [pixelAvd],
    }
    expect(describeAndroidHere(android)).toEqual([
      'Attached:   none',
      'Emulators:  Pixel_10_Pro (Pixel 10 Pro, Android 17, running emulator-5554)',
    ])
    expect(
      describeAndroidHere({ attached: [], avds: [], problem: 'adb not found (set ANDROID_HOME)' }),
    ).toEqual(['Attached:   adb not found (set ANDROID_HOME)', 'Emulators:  none'])
    expect(describeIOSHere({ simulators: [], problem: 'none (simulators need macOS)' })).toEqual([
      'Simulators: none (simulators need macOS)',
    ])
  })
})
